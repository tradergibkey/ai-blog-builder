// =============================================================================
//  AI BLOG BUILDER  —  api/app/topics.js   (PHASE 3 — piece 1)
// -----------------------------------------------------------------------------
//  Tenant-aware topic generation. Reads the tenant profile (niche, audience,
//  categories, competitors, language) and fills their content queue with
//  dated topics — one per day, in the tenant's own timezone.
//
//  POST /api/app/topics  { id }                    → fill queue to queueTarget
//  POST /api/app/topics  { id, count: 5 }          → generate exactly 5
//  POST /api/app/topics  { id, preview: true }     → return without saving
//
//  AUTH: x-app-secret (operator only)
//  ENV:  ABB_APP_SECRET, ANTHROPIC_API_KEY
// =============================================================================

import { getProfile } from "./_profile.js";
import { getQueue, saveQueue, getHistory } from "./_store.js";

export const config = { maxDuration: 120 };

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
    return res.status(401).json({ error: "Unauthorised." });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const id      = (body.id || "").trim();
  const preview = body.preview === true;

  if (!id) return res.status(400).json({ error: "Missing tenant 'id'." });

  try {
    const profile = await getProfile(id);
    if (!profile) return res.status(404).json({ error: `Tenant "${id}" not found.` });

    const [queue, hist] = await Promise.all([getQueue(id), getHistory(id)]);

    const target = Math.min(Math.max(profile.queueTarget || 30, 1), 60);
    const count  = Math.min(body.count || Math.max(target - queue.length, 0), 30);

    if (count <= 0) {
      return res.status(200).json({ ok: true, added: false, count: 0, reason: "Queue already full." });
    }

    const langName = LANG_NAMES[profile.primaryLanguage || "en"] || "English";
    const cats     = (profile.categories || []).filter(Boolean);

    // Everything already used — never repeat
    const existing = [
      ...queue.map(q => q.topic),
      ...hist.map(h => h.topic || h.title || ""),
    ].filter(Boolean);

    // ---- Claude prompt ----
    const system = `You are the content strategist for "${profile.siteName || id}".

BUSINESS: ${profile.description || profile.niche || "(see niche)"}
NICHE: ${profile.niche || "general"}
AUDIENCE: ${profile.audience || "general readers"}
${profile.competitors && profile.competitors.length ? `COMPETITORS (they rank for similar topics — find angles they miss):\n${profile.competitors.map(c => "- " + c).join("\n")}` : ""}

Suggest blog post topics that will attract this audience from Google search. Each topic must be:
- Practical and specific (solves a real problem people actually search for)
- SEO-friendly (a title someone would type into Google)
- Written ENTIRELY in ${langName}
- Fresh — never repeat anything in the AVOID list

${cats.length ? `CATEGORIES (spread topics across these): ${cats.join(", ")}` : ""}

AVOID (already queued or published — do NOT repeat or closely rephrase):
${existing.length ? existing.map(t => "- " + t).join("\n") : "(nothing yet)"}

Call the suggest_topics tool with your ideas.`;

    const toolSchema = {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              topic:    { type: "string", description: `Blog post title in ${langName}` },
              category: cats.length
                ? { type: "string", enum: cats }
                : { type: "string", description: "Content category" },
            },
            required: ["topic"],
          },
        },
      },
      required: ["topics"],
    };

    async function askClaude(howMany, avoid) {
      const sys = system.replace(
        /AVOID \(already queued or published[\s\S]*?(?=\n\nCall the suggest_topics)/,
        `AVOID (already queued or published — do NOT repeat or closely rephrase):\n${avoid.length ? avoid.map(t => "- " + t).join("\n") : "(nothing yet)"}`
      );
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL, max_tokens: 3000, system: sys,
          messages: [{ role: "user", content: `Suggest ${howMany} fresh, specific blog topics in ${langName}. Return all ${howMany}.` }],
          tools: [{ name: "suggest_topics", description: "Submit the suggested topics.", input_schema: toolSchema }],
          tool_choice: { type: "tool", name: "suggest_topics" },
        }),
      });
      if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const d = await r.json();
      const block = (d.content || []).find(b => b.type === "tool_use");
      return (block && block.input && block.input.topics) || [];
    }

    // Loop until we have `count` unique topics (max 3 attempts)
    const topics = [];
    const seen = new Set(existing.map(t => t.toLowerCase().trim()));
    let attempts = 0;
    while (topics.length < count && attempts < 3) {
      attempts++;
      const batch = await askClaude(count - topics.length, [...seen]);
      for (const t of batch) {
        const key = (t.topic || "").toLowerCase().trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        topics.push({ topic: t.topic.trim(), category: (t.category || "").trim() });
        if (topics.length >= count) break;
      }
      if (!batch.length) break;
    }

    if (!topics.length) throw new Error("No topics generated.");

    if (preview) {
      return res.status(200).json({ ok: true, added: false, count: topics.length, topics });
    }

    // ---- Assign dates (one per day, tenant timezone, next free days) ----
    // Re-read the queue NOW to guard against overlapping refill runs
    const freshQueue = await getQueue(id);
    const room = Math.max(0, target - freshQueue.length);
    const toAdd = topics.slice(0, room);

    if (!toAdd.length) {
      return res.status(200).json({ ok: true, added: false, count: 0, reason: "Queue filled by another run." });
    }

    const taken = new Set([
      ...freshQueue.filter(q => q.date).map(q => q.date),
      ...hist.filter(h => h.published_at).map(h => h.published_at.slice(0, 10)),
    ]);

    let cursor = addDays(tzToday(profile.timezone), 1); // start tomorrow
    const nextFreeDay = () => {
      while (taken.has(cursor)) cursor = addDays(cursor, 1);
      const d = cursor;
      taken.add(d);
      cursor = addDays(cursor, 1);
      return d;
    };

    const updated = [...freshQueue];
    for (const t of toAdd) {
      updated.push({
        id: uid(),
        topic: t.topic,
        category: t.category || "",
        date: nextFreeDay(),
        status: "queued",
        created: new Date().toISOString(),
      });
    }

    updated.sort((a, b) => {
      if (a.date && b.date) return a.date.localeCompare(b.date);
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return 0;
    });

    await saveQueue(id, updated);
    return res.status(200).json({ ok: true, added: true, count: toAdd.length, topics: toAdd, queueSize: updated.length });

  } catch (err) {
    console.error("topics error:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------------------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

// "YYYY-MM-DD" + n days → "YYYY-MM-DD" (UTC-safe arithmetic)
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const LANG_NAMES = {
  en: "English", es: "Spanish", de: "German", fr: "French", it: "Italian",
  pt: "Portuguese", nl: "Dutch", hu: "Hungarian", pl: "Polish", sv: "Swedish",
  da: "Danish", no: "Norwegian", fi: "Finnish", ja: "Japanese", ko: "Korean",
  zh: "Chinese", ar: "Arabic", hi: "Hindi",
};
