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

// Canonical short weekday codes used by publishDays profile field.
export const ALL_DAYS = ["mon","tue","wed","thu","fri","sat","sun"];

const dayKey = (tenant, ymd) => `abb:${tenant}:published:${ymd}`;

/** UTC-safe YYYY-MM-DD for a Date (default now). */
export function ymd(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Return the short weekday code ("mon".."sun") for a given date in a tenant's
 * timezone. DST-safe via Intl. Falls back to UTC-based derivation if the tz is
 * invalid.
 */
export function weekdayInTz(date = new Date(), timezone = "Europe/Madrid") {
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(date);
    return wd.toLowerCase(); // "Mon" -> "mon"
  } catch {
    // Fallback: JS getUTCDay() -> 0=Sun..6=Sat
    const map = ["sun","mon","tue","wed","thu","fri","sat"];
    return map[date.getUTCDay()];
  }
}

/**
 * Return the short weekday code for a "YYYY-MM-DD" string, interpreted at
 * noon UTC (avoids DST edge weirdness — a date string is a calendar day, not
 * an instant). tz is honoured so a weekday in Europe/London vs Asia/Tokyo
 * resolves correctly for the same YMD.
 */
export function weekdayForYmd(ymdStr, timezone = "Europe/Madrid") {
  const [y, m, d] = String(ymdStr).split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return weekdayInTz(date, timezone);
}

/**
 * Given a starting YYYY-MM-DD (inclusive), return the first date that is a
 * valid publish day for the tenant. Missing/empty publishDays = all 7 (safety
 * net, matches isPublishDay). Bounded search: never loops more than 14 days
 * (a bug that halts autopilot beats an infinite loop).
 */
export function nextPublishDay(fromYmd, publishDays, timezone = "Europe/Madrid") {
  const list = Array.isArray(publishDays) && publishDays.length ? publishDays : ALL_DAYS;
  let cursor = fromYmd;
  for (let i = 0; i < 14; i++) {
    const wd = weekdayForYmd(cursor, timezone);
    if (wd && list.indexOf(wd) !== -1) return cursor;
    cursor = addDaysYmd(cursor, 1);
  }
  return cursor; // give up after 14 attempts — caller sees a date that will never publish
}

/** "YYYY-MM-DD" + n days → "YYYY-MM-DD" (UTC-safe arithmetic). */
export function addDaysYmd(ymdStr, n) {
  const [y, m, d] = String(ymdStr).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Is the tenant allowed to publish today (in their timezone)?
 * Missing or empty publishDays is treated as ALL days — a safety net so an
 * accidental "unselect everything" in the wizard can never halt autopilot.
 */
export function isPublishDay({ publishDays, timezone, now = new Date() } = {}) {
  const list = Array.isArray(publishDays) && publishDays.length ? publishDays : ALL_DAYS;
  const today = weekdayInTz(now, timezone);
  return list.indexOf(today) !== -1;
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
 * Two gates, checked in order:
 *   1. Day-of-week (isPublishDay) — skip whole day if today isn't allowed
 *   2. Daily cap (velocity ramp + tenant target)
 *
 * @param {object} args
 * @param {string} args.tenant
 * @param {string} args.createdAtISO
 * @param {number} [args.queueTarget]
 * @param {string[]} [args.publishDays]   allowed weekday codes; empty/missing = all days
 * @param {string} [args.timezone]        tenant timezone for weekday check
 * @param {(k:string)=>Promise<string|null>} args.kvGet
 * @param {Date}   [args.now]
 * @returns {Promise<{allowed:boolean, cap:number, publishedToday:number, remaining:number, reason:string}>}
 */
export async function canPublishNow({ tenant, createdAtISO, queueTarget = 2, publishDays, timezone, kvGet, now = new Date() }) {
  // Gate 1: day-of-week
  if (!isPublishDay({ publishDays, timezone, now })) {
    const today = weekdayInTz(now, timezone);
    return {
      allowed: false,
      cap: 0,
      publishedToday: 0,
      remaining: 0,
      reason: `not-publish-day(${today})`,
    };
  }

  // Gate 2: daily cap
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
