// =============================================================================
//  AI BLOG BUILDER  —  api/app/help.js   (PHASE 1 — onboarding)
// -----------------------------------------------------------------------------
//  Stores "I don't know / I need help" submissions from the onboarding wizard.
//  Simple list in KV under abb:help-requests. Gabriel reviews them manually.
//
//  POST /api/app/help  { name, email, message }  → store a help request
//  GET  /api/app/help                             → list all requests (operator)
//
//  AUTH: GET is operator-only (x-app-secret). POST also requires the secret
//  while the product runs in secret mode; when ABB_OPEN_MODE=true, POST opens
//  up so public visitors can submit (stored requests capped at 200).
// =============================================================================

import { getRaw, setRaw } from "./_store.js";

const HELP_KEY = "help-requests";

export default async function handler(req, res) {
  // ---- GET: list requests (operator only) ----
  if (req.method === "GET") {
    if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
      return res.status(401).json({ error: "Unauthorised." });
    }
    const requests = (await getRaw(HELP_KEY)) || [];
    return res.status(200).json({ ok: true, requests });
  }

  // ---- POST: submit a help request ----
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST or GET." });

  // Auth — require secret unless open mode
  if (process.env.ABB_OPEN_MODE !== "true") {
    if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
      return res.status(401).json({ error: "Unauthorised." });
    }
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const name    = (body.name || "").trim();
  const email   = (body.email || "").trim();
  const message = (body.message || "").trim();
  const siteUrl = (body.siteUrl || "").trim();

  if (!name || !email) return res.status(400).json({ error: "Name and email are required." });

  try {
    const requests = (await getRaw(HELP_KEY)) || [];
    requests.unshift({
      name, email, message, siteUrl,
      createdAt: new Date().toISOString(),
    });
    if (requests.length > 200) requests.length = 200;
    await setRaw(HELP_KEY, requests);
    return res.status(200).json({ ok: true, submitted: true });
  } catch (err) {
    console.error("help error:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}
