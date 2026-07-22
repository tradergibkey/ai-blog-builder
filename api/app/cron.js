// =============================================================================
//  AI BLOG BUILDER  —  api/app/cron.js   (PHASE 3 — piece 3: the autopilot)
// -----------------------------------------------------------------------------
//  The multi-tenant autopilot. Designed to be pinged every 15 minutes by
//  cron-job.org (same pattern as the Campoverde engine):
//
//      https://<domain>/api/app/cron?key=<ABB_CRON_SECRET or ABB_APP_SECRET>
//
//  Per active tenant (WordPress or github-static), each ping:
//    0. Refills the content queue to queueTarget (via /api/app/topics)
//    1. If no plan for today and we're inside the tenant's publish window
//       (in THEIR timezone): pick the next due topic, roll a random HH:MM
//       between now and window end, store as today's plan. Publish nothing.
//    2. If today's plan is pending and the rolled time has passed: publish
//       via /api/app/publish, remove the topic from the queue, mark done.
//    3. Otherwise: idle.
//
//  SAFETY:
//    • Max ONE publish per cron run (generation takes ~60-90s; more would
//      risk the 300s function limit). With 15-min pings, several tenants a
//      day publish fine.
//    • Claim-based guard: plan flips to "publishing" BEFORE the slow call, so
//      a timeout can't cause a re-publish loop.
//    • History-based guard: if the same topic was already published today,
//      the plan is marked done instead of publishing twice.
//    • Tenants with an unsupported integration type, or missing credentials
//      for their type, are skipped.
//    • VELOCITY GATE (Phase 7): daily cap enforced via publish-policy.js —
//      new domains ramp up slowly, established tenants capped per config.
//
//  RETURN-EARLY:
//    The handler sends 200 immediately so external pingers (cron-job.org)
//    don't time out after ~30s. The Vercel function continues running in
//    the background up to maxDuration (300s). Results are logged to the
//    Vercel function log instead of the HTTP response body.
//
//  AUTH:  ?key=SECRET  or  x-app-secret header  or  Authorization: Bearer
//         Accepts ABB_CRON_SECRET (recommended, optional) or ABB_APP_SECRET.
// =============================================================================

import { listTenants, getQueue, saveQueue, getPlan, savePlan, getHistory, getStr, setStr } from "./_store.js";
import { getProfile } from "./_profile.js";
import { hasSecret } from "./_secrets.js";
import { canPublishNow, recordPublish } from "../../lib/publish-policy.js";

export const config = { maxDuration: 300 };

// KV wrappers for publish-policy (strip "abb:" prefix — _store adds its own)
const kvGet = (k) => getStr(k.startsWith("abb:") ? k.slice(4) : k);
const kvSet = (k, v, opts) => setStr(k.startsWith("abb:") ? k.slice(4) : k, v, opts);

export default async function handler(req, res) {
  // ---- Auth ----
  const cronSecret = process.env.ABB_CRON_SECRET || "";
  const appSecret  = process.env.ABB_APP_SECRET || "";
  const provided   = req.query.key
    || req.headers["x-app-secret"]
    || (req.headers.authorization || "").replace("Bearer ", "");
  const valid = provided && ((cronSecret && provided === cronSecret) || (appSecret && provided === appSecret));
  if (!valid) return res.status(401).json({ error: "Unauthorised." });

  // ---- Return early: pinger gets 200 immediately ----
  res.status(200).json({ ok: true, status: "accepted" });

  // ---- Background processing (Vercel keeps running up to 300s) ----
  const BASE = process.env.SITE_BASE_URL || `https://${req.headers.host}`;
  const results = [];
  let publishedThisRun = false;

  try {
    const tenants = await listTenants();

    for (const t of tenants) {
      const r = { id: t.id };
      try {
        if (t.status !== "active") { r.action = "skipped"; r.reason = "not active"; results.push(r); continue; }

        const profile = await getProfile(t.id);
        if (!profile) { r.action = "skipped"; r.reason = "no profile"; results.push(r); continue; }

        // Route by integration type. Both WordPress and github-static publish
        // through /api/app/publish (which branches internally). Each needs its
        // own "is it connected?" credential check before we bother planning.
        const intType = profile.integration?.type || "wordpress";
        if (intType === "wordpress") {
          if (!(await hasSecret(t.id, "wp_app_password"))) {
            r.action = "skipped"; r.reason = "WordPress not connected"; results.push(r); continue;
          }
        } else if (intType === "github-static") {
          if (!(await hasSecret(t.id, "github_token"))) {
            r.action = "skipped"; r.reason = "GitHub not connected"; results.push(r); continue;
          }
        } else {
          r.action = "skipped"; r.reason = `unsupported integration: ${intType}`; results.push(r); continue;
        }

        const now = tzNow(profile.timezone);
        const winStart = (profile.publishWindow?.startHour ?? 6) * 60;
        const winEnd   = (profile.publishWindow?.endHour ?? 18) * 60;

        // ---- 0) Refill queue (any hour — harmless outside the window) ----
        const target = profile.queueTarget || 30;
        let queue = await getQueue(t.id);
        if (queue.length < target) {
          try {
            await fetch(`${BASE}/api/app/topics`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-app-secret": appSecret },
              body: JSON.stringify({ id: t.id }),
            });
            queue = await getQueue(t.id);
          } catch (e) { console.error(`refill failed for ${t.id} (continuing):`, e.message); }
        }

        let plan = await getPlan(t.id);

        // ---- 1) Plan today's publish ----
        if (!plan || plan.date !== now.date || plan.status === "empty") {
          if (now.min < winStart) { r.action = "waiting"; r.reason = "before window"; results.push(r); continue; }
          if (now.min > winEnd) {
            await savePlan(t.id, { date: now.date, status: "skipped", reason: "after window" });
            r.action = "skipped"; r.reason = "after window — tomorrow"; results.push(r); continue;
          }

          // ── VELOCITY GATE: check daily cap before even planning ──
          const velCheck = await canPublishNow({
            tenant: t.id,
            createdAtISO: t.createdAt || "2020-01-01",
            queueTarget: profile.queueTarget || 2,
            kvGet,
          });
          if (!velCheck.allowed) {
            await savePlan(t.id, { date: now.date, status: "skipped", reason: velCheck.reason });
            r.action = "skipped"; r.reason = velCheck.reason; results.push(r); continue;
          }

          const pick = nextDue(queue, now.date);
          if (!pick) {
            await savePlan(t.id, { date: now.date, status: "empty" });
            r.action = "no-topic"; results.push(r); continue;
          }
          const rolled = rollTarget(now.min, winStart, winEnd);
          plan = { date: now.date, target: rolled, queueId: pick.id, topic: pick.topic, category: pick.category || "", status: "pending" };
          await savePlan(t.id, plan);
          r.action = "planned"; r.target = rolled; r.topic = pick.topic; results.push(r); continue;
        }

        // ---- 2) Publish when the rolled time arrives ----
        if ((plan.status === "pending" || plan.status === "publishing") && now.hhmm >= plan.target) {
          if (publishedThisRun) { r.action = "deferred"; r.reason = "another tenant published this run"; results.push(r); continue; }

          // History guard — same topic already published today?
          const hist = await getHistory(t.id);
          const dup = hist.find(h => h.topic === plan.topic && (h.published_at || "").slice(0, 10) === now.date);
          if (dup) {
            plan.status = "done"; plan.note = "duplicate-guard"; await savePlan(t.id, plan);
            queue = (await getQueue(t.id)).filter(e => e.id !== plan.queueId);
            await saveQueue(t.id, queue);
            r.action = "already-published"; results.push(r); continue;
          }

          // ── VELOCITY GATE: re-check at publish time (cap may have been
          //    reached by a manual publish since planning) ──
          const velCheck = await canPublishNow({
            tenant: t.id,
            createdAtISO: t.createdAt || "2020-01-01",
            queueTarget: profile.queueTarget || 2,
            kvGet,
          });
          if (!velCheck.allowed) {
            plan.status = "skipped"; plan.note = velCheck.reason; await savePlan(t.id, plan);
            r.action = "skipped"; r.reason = velCheck.reason; results.push(r); continue;
          }

          // Claim BEFORE the slow call
          if (plan.status === "pending") {
            plan.status = "publishing"; plan.claimed_at = new Date().toISOString();
            await savePlan(t.id, plan);
          }
          publishedThisRun = true;

          const pubRes = await fetch(`${BASE}/api/app/publish`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-app-secret": appSecret },
            body: JSON.stringify({ id: t.id, topic: plan.topic, category: plan.category }),
          });
          const pub = await pubRes.json().catch(() => ({}));

          if (pubRes.ok && pub.ok) {
            plan.status = "done"; plan.postUrl = pub.post?.url; await savePlan(t.id, plan);
            queue = (await getQueue(t.id)).filter(e => e.id !== plan.queueId);
            await saveQueue(t.id, queue);

            // ── VELOCITY: record successful publish in daily counter ──
            await recordPublish({ tenant: t.id, kvGet, kvSet }).catch(
              e => console.error(`[${t.id}] velocity record failed (non-critical):`, e.message)
            );

            r.action = "published"; r.url = pub.post?.url; r.status = pub.post?.status; results.push(r); continue;
          } else {
            plan.attempts = (plan.attempts || 0) + 1;
            plan.status = plan.attempts >= 4 ? "failed" : "pending";
            if (plan.attempts >= 4) plan.error = pub.error || `publish ${pubRes.status}`;
            await savePlan(t.id, plan);
            r.action = "retry"; r.attempt = plan.attempts; r.error = pub.error || pubRes.status; results.push(r); continue;
          }
        }

        // ---- 3) Idle ----
        r.action = "idle"; r.plan_status = plan.status; r.target = plan.target || null; r.now = now.hhmm;
        results.push(r);

      } catch (err) {
        r.action = "error"; r.error = String(err && err.message || err);
        results.push(r);
      }
    }

    console.log("[abb-cron] run complete:", JSON.stringify({ ran: results.length, results }));

  } catch (err) {
    console.error("abb-cron error:", err);
  }
}

// ---------------------------------------------------------------------------
// next due topic: first dated item due today-or-earlier, else first undated
function nextDue(queue, today) {
  if (!queue || !queue.length) return null;
  return queue.find(e => e.date && e.date <= today) || queue.find(e => !e.date) || null;
}

// random HH:MM between now and window end (never before window start)
function rollTarget(nowMin, winStart, winEnd) {
  const start = Math.max(winStart, nowMin);
  const t = start + Math.floor(Math.random() * (Math.max(winEnd - start, 0) + 1));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// current wall-clock in the tenant's timezone (DST-aware via Intl)
function tzNow(tz) {
  let zone = tz || "Europe/Madrid";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
  } catch {
    zone = "Europe/Madrid";
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
  }
  const o = {}; parts.forEach(p => { o[p.type] = p.value; });
  const hh = o.hour === "24" ? "00" : o.hour;
  return {
    date: `${o.year}-${o.month}-${o.day}`,
    hhmm: `${hh}:${o.minute}`,
    min: parseInt(hh, 10) * 60 + parseInt(o.minute, 10),
  };
}
