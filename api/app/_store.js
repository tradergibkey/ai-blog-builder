// =============================================================================
//  AI BLOG BUILDER  —  api/app/_store.js   (PHASE 0 — foundation)
// -----------------------------------------------------------------------------
//  Tenant-namespaced KV layer (Upstash REST, plain fetch, no SDK).
//
//  ISOLATION — this is what protects the live Campoverde blog:
//    • Every key written by this module is prefixed with "abb:".
//    • There is deliberately NO flush / scan / delete-by-pattern function here.
//    • Therefore this layer *physically cannot address* Campoverde's bare keys
//      ("queue", "history", "plan") — even if you point ABB at the SAME Upstash
//      store. Nothing this file does can reach or corrupt the live site's data.
//
//  It reads its OWN env vars (never Campoverde's kv_KV_* vars):
//    • ABB_KV_REST_API_URL
//    • ABB_KV_REST_API_TOKEN
//
//  Underscore prefix = Vercel ignores it as a route. Imported by the /api/app/*
//  endpoints only.
// =============================================================================

const PREFIX = "abb:";

const url   = () => process.env.ABB_KV_REST_API_URL;
const token = () => process.env.ABB_KV_REST_API_TOKEN;

async function cmd(...args) {
  if (!url() || !token()) {
    throw new Error("ABB KV env not set — add ABB_KV_REST_API_URL and ABB_KV_REST_API_TOKEN in Vercel.");
  }
  const r = await fetch(url(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`ABB KV ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.result;
}

// ---------------------------------------------------------------------------
//  Generic JSON get / set / del  — ALWAYS namespaced under "abb:"
// ---------------------------------------------------------------------------
export async function getRaw(key) {
  const raw = await cmd("GET", PREFIX + key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

export async function setRaw(key, value) {
  await cmd("SET", PREFIX + key, JSON.stringify(value));
}

export async function delRaw(key) {
  // Deletes ONE explicit namespaced key. No pattern/scan deletes exist by design.
  await cmd("DEL", PREFIX + key);
}

// ---------------------------------------------------------------------------
//  Raw string get / set  — for lib modules that handle their own serialization
//  (similarity-guard, publish-policy). Avoids double-JSON wrapping.
//  Keys still get the "abb:" prefix for isolation.
// ---------------------------------------------------------------------------
export async function getStr(key) {
  return await cmd("GET", PREFIX + key);
}

export async function setStr(key, value, opts) {
  if (opts && opts.ex) {
    await cmd("SET", PREFIX + key, value, "EX", opts.ex);
  } else {
    await cmd("SET", PREFIX + key, value);
  }
}

// ---------------------------------------------------------------------------
//  Tenant registry  — the list the cron will loop over (key: abb:tenants)
// ---------------------------------------------------------------------------
export async function listTenants() {
  return (await getRaw("tenants")) || [];
}

export async function addTenant(t) {
  const list = await listTenants();
  const row = {
    id:        t.id,
    siteName:  t.siteName || "",
    siteUrl:   t.siteUrl  || "",
    status:    t.status   || "active",
    createdAt: t.createdAt || new Date().toISOString(),
  };
  const i = list.findIndex(x => x.id === t.id);
  if (i >= 0) list[i] = { ...list[i], ...row };
  else list.push(row);
  await setRaw("tenants", list);
  return row;
}

export async function removeTenant(id) {
  const list = (await listTenants()).filter(x => x.id !== id);
  await setRaw("tenants", list);
}

// ---------------------------------------------------------------------------
//  Per-tenant profile  (key: abb:t:<id>:profile)
// ---------------------------------------------------------------------------
export async function getProfileRaw(id)          { return await getRaw(`t:${id}:profile`); }
export async function setProfileRaw(id, profile) { await setRaw(`t:${id}:profile`, profile); }

// ---------------------------------------------------------------------------
//  Per-tenant queue / history / plan
//  (namespaced twins of Campoverde's old _kv.js — one set PER tenant)
// ---------------------------------------------------------------------------
export async function getQueue(id)      { return (await getRaw(`t:${id}:queue`)) || []; }
export async function saveQueue(id, q)  { await setRaw(`t:${id}:queue`, q); }

export async function getHistory(id)    { return (await getRaw(`t:${id}:history`)) || []; }
export async function saveHistory(id, h){ await setRaw(`t:${id}:history`, Array.isArray(h) ? h : []); }
export async function addHistory(id, entry) {
  const h = await getHistory(id);
  h.unshift(entry);                 // newest first
  if (h.length > 300) h.length = 300;
  await setRaw(`t:${id}:history`, h);
}

export async function getPlan(id)       { return await getRaw(`t:${id}:plan`); }
export async function savePlan(id, p)   { await setRaw(`t:${id}:plan`, p); }
