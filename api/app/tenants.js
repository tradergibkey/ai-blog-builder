// =============================================================================
//  AI BLOG BUILDER  —  api/app/tenants.js   (PHASE 0 — the only route)
// -----------------------------------------------------------------------------
//  Operator-gated tenant management. This is the endpoint you HIT to verify the
//  foundation works. Lives at:  https://<domain>/api/app/tenants
//
//  AUTH:  header  x-app-secret: <ABB_APP_SECRET>
//
//  ACTIONS (?action=... or JSON body):
//    GET  /api/app/tenants                         → list all tenants (verify)
//    GET  /api/app/tenants?id=campoverde           → one tenant's profile
//    POST /api/app/tenants { action:"seed-campoverde" }        → seed tenant #1
//    POST /api/app/tenants { action:"create", profile:{...}, credentials?:{...} }
//    POST /api/app/tenants { action:"update", id, profile:{}, credentials?:{...} }
//
//  credentials (optional) e.g. { wordpress: { url, username, appPassword } }
//  → stored ENCRYPTED via _secrets.js, kept apart from the profile, and
//    NEVER echoed back in any response.
//    POST /api/app/tenants { action:"delete", id }             → unlist tenant
//
//  Nothing here can reach Campoverde's live data — it only ever touches keys
//  under the "abb:" namespace (see _store.js).
// =============================================================================

import { listTenants, removeTenant } from "./_store.js";
import {
  getProfile, saveProfile, publicProfile,
  blankProfile, normalizeProfile, campoverdeSeedProfile,
} from "./_profile.js";
import { setSecret } from "./_secrets.js";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Store integration credentials ENCRYPTED via _secrets.js (never echoed back).
// SEQUENTIAL on purpose — setSecret does a read-modify-write on one shared bag;
// parallel writes raced and the last write erased the others (v2 bug).
async function storeCredentials(tenantId, creds) {
  if (!creds || typeof creds !== "object") return;

  // WordPress credentials
  const wp = creds.wordpress || {};
  if (wp.url)         await setSecret(tenantId, "wp_url",          String(wp.url).trim());
  if (wp.username)    await setSecret(tenantId, "wp_username",     String(wp.username).trim());
  if (wp.appPassword) await setSecret(tenantId, "wp_app_password", String(wp.appPassword).trim());

  // GitHub (static-site) credentials — SEQUENTIAL for the same read-modify-write
  // reason as WP above: parallel writes to the shared secrets bag race.
  const gh = creds.github || {};
  if (gh.repo)   await setSecret(tenantId, "github_repo",   String(gh.repo).trim());
  if (gh.branch) await setSecret(tenantId, "github_branch", String(gh.branch).trim());
  if (gh.token)  await setSecret(tenantId, "github_token",  String(gh.token).trim());
}

export default async function handler(req, res) {
  // ---- Auth (operator only) ----
  if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
    return res.status(401).json({ error: "Unauthorised." });
  }

  const body = req.method === "POST"
    ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}))
    : {};
  const action = req.query.action || body.action || (req.method === "GET" ? "list" : "");

  try {
    // ---- GET one tenant's profile ----
    if (req.method === "GET" && req.query.id) {
      const p = await getProfile(req.query.id);
      if (!p) return res.status(404).json({ error: "Tenant not found." });
      return res.status(200).json({ ok: true, id: req.query.id, profile: publicProfile(p) });
    }

    // ---- GET list of tenants (verify the foundation) ----
    if (action === "list") {
      return res.status(200).json({ ok: true, tenants: await listTenants() });
    }

    // ---- Seed Campoverde as tenant #1 (idempotent — fixed id "campoverde") ----
    if (action === "seed-campoverde") {
      const saved = await saveProfile("campoverde", campoverdeSeedProfile());
      return res.status(200).json({ ok: true, id: "campoverde", seeded: true, profile: publicProfile(saved) });
    }

    // ---- Create a new tenant ----
    if (action === "create") {
      const id = (body.id || uid()).toString();
      const saved = await saveProfile(id, normalizeProfile(body.profile || blankProfile()));
      if (body.credentials) await storeCredentials(id, body.credentials);
      return res.status(200).json({ ok: true, id, profile: publicProfile(saved) });
    }

    // ---- Update a tenant profile (partial merge) ----
    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "Missing 'id'." });
      const saved = await saveProfile(body.id, body.profile || {});
      if (body.credentials) await storeCredentials(body.id, body.credentials);
      return res.status(200).json({ ok: true, id: body.id, profile: publicProfile(saved) });
    }

    // ---- Delete a tenant (unlist; keyed data left for a later maintenance pass) ----
    if (action === "delete") {
      if (!body.id) return res.status(400).json({ error: "Missing 'id'." });
      await removeTenant(body.id);
      return res.status(200).json({ ok: true, removed: body.id });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error("tenants error:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}
