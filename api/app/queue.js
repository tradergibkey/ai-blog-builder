// =============================================================================
//  AI BLOG BUILDER  —  api/app/queue.js   (PHASE 3 — piece 2)
// -----------------------------------------------------------------------------
//  Tenant-scoped queue management. The tenant-aware twin of the old Campoverde
//  queue endpoint — every action takes a tenant 'id'.
//
//  GET  /api/app/queue?id=elsyfx.net                → queue + history + plan
//  POST { id, action:"add", topic, category, date, scheduledTime } → add a topic
//  POST { id, action:"remove", itemId }             → remove a topic
//  POST { id, action:"update", itemId, topic, category, date, scheduledTime }
//  POST { id, action:"redate" }                     → re-walk all dated items
//                                                     against current publishDays
//  POST { id, action:"clear-plan" }                 → mark today's plan done
//  POST { id, action:"clear-all" }                  → empty the queue
//
//  AUTH: x-app-secret (operator only)
// =============================================================================

import { getQueue, saveQueue, getHistory, getPlan, savePlan } from "./_store.js";
import { getProfile } from "./_profile.js";
import { nextPublishDay, addDaysYmd } from "../../lib/publish-policy.js";

export default async function handler(req, res) {
  if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
    return res.status(401).json({ error: "Unauthorised." });
  }

  const body = req.method === "POST"
    ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}))
    : {};
  const id     = (req.query.id || body.id || "").trim();
  const action = req.query.action || body.action || "list";

  if (!id) return res.status(400).json({ error: "Missing tenant 'id'." });

  try {
    // ---- LIST ----
    if (action === "list" || req.method === "GET") {
      const [queue, history, plan] = await Promise.all([getQueue(id), getHistory(id), getPlan(id)]);
      return res.status(200).json({ ok: true, id, queue, history: history.slice(0, 30), plan });
    }

    // ---- ADD ----
    if (action === "add") {
      const topic = (body.topic || "").trim();
      if (!topic) return res.status(400).json({ error: "Missing 'topic'." });
      const q = await getQueue(id);
      const entry = {
        id: uid(),
        topic,
        category: (body.category || "").trim() || null,
        date: (body.date || "").trim() || null,
        scheduledTime: normalizeTime(body.scheduledTime),
        status: "queued",
        created: new Date().toISOString(),
      };
      q.push(entry);
      sortQueue(q);
      await saveQueue(id, q);
      return res.status(200).json({ ok: true, added: entry, queue: q });
    }

    // ---- REMOVE ----
    if (action === "remove") {
      if (!body.itemId) return res.status(400).json({ error: "Missing 'itemId'." });
      let q = await getQueue(id);
      const before = q.length;
      q = q.filter(e => e.id !== body.itemId);
      await saveQueue(id, q);
      return res.status(200).json({ ok: true, removed: before !== q.length, queue: q });
    }

    // ---- UPDATE ----
    if (action === "update") {
      if (!body.itemId) return res.status(400).json({ error: "Missing 'itemId'." });
      const q = await getQueue(id);
      const item = q.find(e => e.id === body.itemId);
      if (!item) return res.status(404).json({ error: "Topic not found." });
      if (body.topic)    item.topic = body.topic.trim();
      if (body.category) item.category = body.category.trim();
      if (body.date !== undefined) item.date = (body.date || "").trim() || null;
      if (body.scheduledTime !== undefined) {
        const t = normalizeTime(body.scheduledTime);
        if (t !== null) item.scheduledTime = t;
      }
      sortQueue(q);
      await saveQueue(id, q);
      return res.status(200).json({ ok: true, updated: item, queue: q });
    }

    // ---- REDATE ---- re-walk all dated queue items against current publishDays
    //  Called after the operator toggles publish-day pills. Preserves relative
    //  order and each item's rolled scheduledTime. Undated items are left alone.
    //  Skips items whose date is TODAY-or-earlier (in-flight; touching them
    //  would fight the cron plan).
    if (action === "redate") {
      const profile = await getProfile(id);
      if (!profile) return res.status(404).json({ error: `Tenant "${id}" not found.` });

      const tz = profile.timezone || "Europe/Madrid";
      const publishDays = profile.publishDays;
      const today = tzToday(tz);

      const q = await getQueue(id);

      // Split: undated items and today-or-earlier items are NOT re-dated
      const untouched = q.filter(e => !e.date || e.date <= today);
      const future    = q.filter(e => e.date && e.date > today)
                         .sort((a, b) => a.date.localeCompare(b.date));

      // Dates already claimed by the untouched set (so we don't collide with them)
      const taken = new Set(untouched.filter(e => e.date).map(e => e.date));

      // Walk forward from tomorrow, one publish day at a time
      let cursor = nextPublishDay(addDaysYmd(today, 1), publishDays, tz);
      const nextFreeDay = () => {
        while (taken.has(cursor)) {
          cursor = nextPublishDay(addDaysYmd(cursor, 1), publishDays, tz);
        }
        const d = cursor;
        taken.add(d);
        cursor = nextPublishDay(addDaysYmd(cursor, 1), publishDays, tz);
        return d;
      };

      const redated = future.map(item => ({ ...item, date: nextFreeDay() }));
      const updated = [...untouched, ...redated];
      sortQueue(updated);
      await saveQueue(id, updated);
      return res.status(200).json({ ok: true, redated: redated.length, untouched: untouched.length, queue: updated });
    }

    // ---- CLEAR TODAY'S PLAN (after manual publish) ----
    if (action === "clear-plan") {
      const plan = await getPlan(id);
      if (plan) { plan.status = "done"; plan.manual = true; await savePlan(id, plan); }
      return res.status(200).json({ ok: true, plan: plan || "no plan" });
    }

    // ---- CLEAR ALL ----
    if (action === "clear-all") {
      await saveQueue(id, []);
      return res.status(200).json({ ok: true, cleared: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error("queue error:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}

function sortQueue(q) {
  q.sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return 0;
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Accept "HH:MM" or "H:MM"; return "HH:MM" or null.
function normalizeTime(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

// Today's date "YYYY-MM-DD" in the tenant's timezone
function tzToday(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const o = {}; parts.forEach(p => { o[p.type] = p.value; });
    return `${o.year}-${o.month}-${o.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
