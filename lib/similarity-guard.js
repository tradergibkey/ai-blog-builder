// similarity-guard.js
// -----------------------------------------------------------------------------
// Catches near-duplicate drafts BEFORE they publish. If a new article is too
// similar in wording to something the same tenant already posted, we flag it so
// the generator can regenerate (or a human can review) instead of adding one
// more near-duplicate page to the site.
//
// Pure JS. No embeddings API, no key, no network. Uses word-level k-shingles +
// Jaccard similarity, which reliably catches "same article, few words swapped"
// and "same skeleton, same phrasing" — the exact near-duplicate pattern.
//
// Storage is injected: you pass in kvGet/kvSet bound to your Upstash helper, so
// this drops into whatever client you already use. Per-post shingle sets are
// cached in KV so we never re-tokenise the whole corpus.
//
// ESM. For CommonJS, swap the `export` keywords for module.exports at the bottom.
// -----------------------------------------------------------------------------

const DEFAULT_K = 5;                 // shingle size (words). Tuned: near-dup articles score ~0.27-0.32, distinct ~0.
const DEFAULT_THRESHOLD = 0.25;      // Jaccard >= this ⇒ treat as near-duplicate. Margin on both sides.
const DEFAULT_COMPARE_LAST = 40;     // only compare against this many most-recent posts (perf).

/** Normalise + tokenise: lowercase, strip markup/punctuation, collapse spaces. */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')        // strip HTML tags
    .replace(/[#*_>`~\[\]()]/g, ' ') // strip common markdown
    .replace(/[^a-z0-9\u00C0-\u024F\s]/g, ' ') // keep letters (incl. accented ES/HU), digits
    .split(/\s+/)
    .filter(Boolean);
}

/** Build the set of word k-grams (shingles) for a text. Returned as a string[]. */
export function shingles(text, k = DEFAULT_K) {
  const words = tokenize(text);
  if (words.length < k) return words.length ? [words.join(' ')] : [];
  const out = new Set();
  for (let i = 0; i <= words.length - k; i++) {
    out.add(words.slice(i, i + k).join(' '));
  }
  return [...out];
}

/** Jaccard similarity between two shingle arrays (0..1). */
export function jaccard(aArr, bArr) {
  if (!aArr.length || !bArr.length) return 0;
  const a = new Set(aArr);
  const b = new Set(bArr);
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Compare a draft against an array of prior posts' shingle sets.
 * @param {string[]} draftShingles
 * @param {Array<{id:string, shingles:string[]}>} priors
 * @param {number} threshold
 * @returns {{ isDuplicate:boolean, maxScore:number, against:(string|null) }}
 */
export function scoreAgainstPriors(draftShingles, priors, threshold = DEFAULT_THRESHOLD) {
  let maxScore = 0;
  let against = null;
  for (const p of priors) {
    const s = jaccard(draftShingles, p.shingles || []);
    if (s > maxScore) { maxScore = s; against = p.id; }
    if (s >= threshold) return { isDuplicate: true, maxScore: s, against: p.id };
  }
  return { isDuplicate: false, maxScore, against };
}

// ---- KV-backed workflow ------------------------------------------------------
// Keys (adjust prefix to match your convention):
//   abb:{tenant}:shingles:index   -> JSON string[] of post ids, newest first
//   abb:{tenant}:shingles:{postId} -> JSON string[] of that post's shingles

const idxKey = (tenant) => `abb:${tenant}:shingles:index`;
const setKey = (tenant, id) => `abb:${tenant}:shingles:${id}`;

/**
 * Check a draft for near-duplication against the tenant's recent corpus.
 * @param {object} args
 * @param {string} args.tenant
 * @param {string} args.draftText          full article text (HTML or markdown ok)
 * @param {(key:string)=>Promise<string|null>} args.kvGet
 * @param {number} [args.threshold]
 * @param {number} [args.k]
 * @param {number} [args.compareLast]
 * @returns {Promise<{isDuplicate:boolean, maxScore:number, against:(string|null), draftShingles:string[]}>}
 */
export async function checkDuplicate({
  tenant, draftText, kvGet,
  threshold = DEFAULT_THRESHOLD, k = DEFAULT_K, compareLast = DEFAULT_COMPARE_LAST,
}) {
  const draftShingles = shingles(draftText, k);
  const idxRaw = await kvGet(idxKey(tenant));
  const ids = safeArr(idxRaw).slice(0, compareLast);

  const priors = [];
  for (const id of ids) {
    const raw = await kvGet(setKey(tenant, id));
    const sh = safeArr(raw);
    if (sh.length) priors.push({ id, shingles: sh });
  }

  const res = scoreAgainstPriors(draftShingles, priors, threshold);
  return { ...res, draftShingles };
}

/**
 * Record a published post's shingles so future drafts are compared against it.
 * Call this AFTER a post successfully publishes. Trims the index to `keep`.
 */
export async function recordPost({
  tenant, postId, draftShingles, kvGet, kvSet, keep = 200,
}) {
  await kvSet(setKey(tenant, postId), JSON.stringify(draftShingles));
  const idxRaw = await kvGet(idxKey(tenant));
  const ids = [postId, ...safeArr(idxRaw).filter((x) => x !== postId)].slice(0, keep);
  await kvSet(idxKey(tenant), JSON.stringify(ids));
  return ids.length;
}

function safeArr(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;            // some KV clients auto-parse
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

export const config = { DEFAULT_K, DEFAULT_THRESHOLD, DEFAULT_COMPARE_LAST };
