// =============================================================================
//  AI BLOG BUILDER  —  api/app/_secrets.js   (PHASE 0 — foundation)
// -----------------------------------------------------------------------------
//  Where OTHER PEOPLE'S credentials live. Because this product will hold each
//  tenant's WordPress Application Password (and later other integrations), those
//  secrets are:
//    • encrypted at rest (AES-256-GCM),
//    • stored in a SEPARATE key (abb:t:<id>:secrets) — never inside the profile,
//    • never returned to any browser (the dashboard only ever sees "connected"
//      / "needs-auth", never the value).
//
//  This module is built now, on purpose, so the mechanism exists before the
//  WordPress adapter (Phase 2) needs it — rather than bolting security on later.
//  Nothing is stored here yet in Phase 0; the functions are ready for Phase 2.
//
//  ENV:  ABB_SECRET_KEY  — any long random string. A stable 32-byte key is
//        derived from it via SHA-256, so the string itself can be anything
//        strong (see the setup note in the handoff message).
// =============================================================================

import crypto from "node:crypto";
import { getRaw, setRaw } from "./_store.js";

function key() {
  const raw = process.env.ABB_SECRET_KEY || "";
  if (!raw) throw new Error("ABB_SECRET_KEY not set — required to encrypt tenant credentials.");
  return crypto.createHash("sha256").update(raw).digest(); // 32 bytes for AES-256
}

// -- Encrypt / decrypt a single string -------------------------------------
export function encrypt(plain) {
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  // layout: [12-byte IV][16-byte auth tag][ciphertext] -> base64
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(blob) {
  const buf = Buffer.from(String(blob), "base64");
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d   = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// -- Per-tenant secrets bag (encrypted values), stored apart from the profile --
export async function setSecret(tenantId, name, value) {
  const bag = (await getRaw(`t:${tenantId}:secrets`)) || {};
  bag[name] = encrypt(value);
  await setRaw(`t:${tenantId}:secrets`, bag);
}

export async function getSecret(tenantId, name) {
  const bag = (await getRaw(`t:${tenantId}:secrets`)) || {};
  return bag[name] != null ? decrypt(bag[name]) : null;
}

export async function hasSecret(tenantId, name) {
  const bag = (await getRaw(`t:${tenantId}:secrets`)) || {};
  return bag[name] != null;
}

// Never returns values — only which secret names exist (for the dashboard).
export async function listSecretNames(tenantId) {
  const bag = (await getRaw(`t:${tenantId}:secrets`)) || {};
  return Object.keys(bag);
}
