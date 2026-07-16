// =============================================================================
//  AI BLOG BUILDER  —  api/app/wp-test.js   (PHASE 2 — piece 1)
// -----------------------------------------------------------------------------
//  Connection test. Takes a tenant ID, decrypts their stored WordPress
//  credentials, hits /wp-json/wp/v2/users/me, confirms login works.
//
//  GET  /api/app/wp-test?id=elsyfx.net
//  POST /api/app/wp-test  { id: "elsyfx.net" }
//
//  AUTH: x-app-secret (operator only)
// =============================================================================

import { getSecret } from "./_secrets.js";

export default async function handler(req, res) {
  if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
    return res.status(401).json({ error: "Unauthorised." });
  }

  const body = req.method === "POST"
    ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}))
    : {};
  const id = req.query.id || body.id || "";

  if (!id) return res.status(400).json({ error: "Missing tenant 'id'." });

  try {
    // ---- 1) Decrypt stored credentials ----
    const wpUrl      = await getSecret(id, "wp_url");
    const wpUser     = await getSecret(id, "wp_username");
    const wpAppPass  = await getSecret(id, "wp_app_password");

    if (!wpUrl || !wpUser || !wpAppPass) {
      return res.status(200).json({
        ok: false, id,
        error: "Missing WordPress credentials. Connect WordPress in the wizard first.",
        missing: { url: !wpUrl, username: !wpUser, appPassword: !wpAppPass },
      });
    }

    // ---- 2) Hit the WP REST API ----
    const base = wpUrl.replace(/\/+$/, "");
    const auth = Buffer.from(`${wpUser}:${wpAppPass}`).toString("base64");

    const wpRes = await fetch(`${base}/wp-json/wp/v2/users/me?context=edit`, {
      headers: {
        "Authorization": `Basic ${auth}`,
        "User-Agent": "AIBlogBuilder/2.0",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!wpRes.ok) {
      const errText = (await wpRes.text()).slice(0, 300);
      return res.status(200).json({
        ok: false, id, httpStatus: wpRes.status,
        error: wpRes.status === 401
          ? "Authentication failed — check username and Application Password."
          : wpRes.status === 403
          ? "Forbidden — the user may not have permission, or a security plugin is blocking the REST API."
          : `WordPress returned HTTP ${wpRes.status}: ${errText}`,
      });
    }

    const user = await wpRes.json();

    // ---- 3) Check capabilities ----
    const caps = user.capabilities || {};
    const canPublish = caps.publish_posts || caps.edit_posts || false;

    return res.status(200).json({
      ok: true, id,
      connected: true,
      user: {
        id: user.id,
        username: user.username || user.slug,
        displayName: user.name,
        email: user.email,
        roles: user.roles || [],
        canPublish,
      },
      wpUrl: base,
    });

  } catch (err) {
    console.error("wp-test error:", err);
    return res.status(500).json({
      ok: false, id,
      error: String(err && err.message || err),
    });
  }
}
