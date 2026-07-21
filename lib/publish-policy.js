// publish-policy.js
// -----------------------------------------------------------------------------
// Controls HOW FAST each tenant publishes. Dumping 50-500 posts quickly on a
// young domain is the classic "scaled content" velocity signal. This paces
// publishing: new domains ramp up slowly and earn a higher cap as they age;
// established tenants publish at their configured target.
//
// Pure JS library. Reads/writes a daily counter via injected kvGet/kvSet.
//
// ESM. For CommonJS, swap `export` for module.exports at the bottom.
// -----------------------------------------------------------------------------

/**
 * Ramp schedule by domain age. Each tier caps posts-per-day until the domain
 * is old enough for the next tier. Past the last tier, the tenant's own
 * queueTarget/day (capped by HARD_CEILING) applies.
 */
export const RAMP = [
  { untilDays: 14,  perDay: 1 },   // first 2 weeks: 1/day max
  { untilDays: 30,  perDay: 2 },   // weeks 3-4: 2/day
  { untilDays: 90,  perDay: 3 },   // months 2-3: 3/day
  // after 90 days: use tenant target, capped by HARD_CEILING
];

export const HARD_CEILING = 6;      // never more than this per day per tenant, ever.

const dayKey = (tenant, ymd) => `abb:${tenant}:published:${ymd}`;

/** UTC-safe YYYY-MM-DD for a Date (default now). */
export function ymd(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Whole days between two dates (floor, non-negative). */
export function ageInDays(createdAtISO, now = new Date()) {
  const created = new Date(createdAtISO);
  if (isNaN(created)) return Infinity; // unknown age ⇒ treat as established
  return Math.max(0, Math.floor((now - created) / 86_400_000));
}

/**
 * The per-day cap for a tenant given its domain age and configured target.
 * @param {object} args
 * @param {string} args.createdAtISO  when the tenant/domain started publishing
 * @param {number} [args.queueTarget] tenant's desired posts/day once established
 * @param {Date}   [args.now]
 * @returns {number}
 */
export function dailyCap({ createdAtISO, queueTarget = 2, now = new Date() }) {
  const age = ageInDays(createdAtISO, now);
  for (const tier of RAMP) {
    if (age < tier.untilDays) return tier.perDay;
  }
  return Math.min(queueTarget, HARD_CEILING);
}

/**
 * Decide whether the tenant may publish one more post right now.
 * Reads today's published count from KV. Does NOT mutate — call
 * recordPublish() only after a post actually publishes.
 *
 * @param {object} args
 * @param {string} args.tenant
 * @param {string} args.createdAtISO
 * @param {number} [args.queueTarget]
 * @param {(k:string)=>Promise<string|null>} args.kvGet
 * @param {Date}   [args.now]
 * @returns {Promise<{allowed:boolean, cap:number, publishedToday:number, remaining:number, reason:string}>}
 */
export async function canPublishNow({ tenant, createdAtISO, queueTarget = 2, kvGet, now = new Date() }) {
  const cap = dailyCap({ createdAtISO, queueTarget, now });
  const publishedToday = toInt(await kvGet(dayKey(tenant, ymd(now))));
  const remaining = Math.max(0, cap - publishedToday);
  const allowed = remaining > 0;
  return {
    allowed,
    cap,
    publishedToday,
    remaining,
    reason: allowed ? 'within-cap' : `daily-cap-reached(${publishedToday}/${cap})`,
  };
}

/**
 * Increment today's counter. Call AFTER a successful publish.
 * Sets a 48h TTL if your kvSet supports options; falls back to plain set.
 * @returns {Promise<number>} the new count for today
 */
export async function recordPublish({ tenant, kvGet, kvSet, now = new Date() }) {
  const key = dayKey(tenant, ymd(now));
  const next = toInt(await kvGet(key)) + 1;
  try {
    await kvSet(key, String(next), { ex: 172_800 }); // 48h TTL (Upstash-style)
  } catch {
    await kvSet(key, String(next));
  }
  return next;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
