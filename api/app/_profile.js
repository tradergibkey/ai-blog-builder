// =============================================================================
//  AI BLOG BUILDER  —  api/app/_profile.js   (PHASE 0 — foundation)
// -----------------------------------------------------------------------------
//  THE PROFILE. This is the single object every other part of the engine reads
//  from — it replaces the hardcoded `SITE` constant in the old generate.js.
//
//  The shape is grouped to match the onboarding wizard, so the questionnaire
//  maps 1:1 onto stored data:
//    ①  Site & audience      ①a Language      ①b Competitors
//    ①c Brand & blog         Integration      ② Keywords
//    ③  Calendar             ⑤ Social         ④ Authority        ⑥ Meta
//
//  Credentials NEVER live here — they go through _secrets.js (encrypted).
// =============================================================================

import { getProfileRaw, setProfileRaw, addTenant } from "./_store.js";

// ---------------------------------------------------------------------------
//  Blank profile — the canonical shape + sensible product defaults
// ---------------------------------------------------------------------------
export function blankProfile() {
  const now = new Date().toISOString();
  return {
    // ① Site & audience --------------------------------------------------
    siteName:    "",
    siteUrl:     "",
    description: "",            // what the business does (AI can fill from the site)
    audience:    "",            // primary audience
    niche:       "",            // derived; biases topic + keyword generation

    // ①a Language --------------------------------------------------------
    primaryLanguage:   "en",
    bilingual:         false,
    secondaryLanguage: null,    // e.g. "es", or null for monolingual

    // ①b Competitors -----------------------------------------------------
    competitors: [],            // array of URLs — steers topic/keyword ideas

    // ①c Brand & blog ----------------------------------------------------
    brandColor:     "#2563eb",  // hex (AI suggests one from the site)
    voice:          "",         // writing/caption tone (AI proposes from the site)
    categories:     [],         // content buckets (AI-suggested)
    blogUrlPattern: "",         // e.g. https://site.com/blog/{slug} — for internal links + related posts

    // Integration (the publishing spine) ---------------------------------
    integration: {
      type:   "wordpress",      // new tenants default to WordPress; Campoverde = "github-static"
      status: "needs-auth",     // connected | needs-auth | error
      defaults: {
        publishAs:   "draft",   // draft | publish
        author:      null,
        categoryMap: {},         // our category -> the CMS's category id/name
      },
      // credentials are NOT stored here — see _secrets.js
    },

    // ② Keywords ---------------------------------------------------------
    // metrics start null; a paid keyword API fills volume/difficulty later
    // with ZERO schema change. Each: { term, source, volume, difficulty }
    keywords: [],

    // ③ Calendar ---------------------------------------------------------
    queueTarget:   30,          // product default = 30-day queue
    timezone:      "Europe/Madrid",
    publishWindow: { startHour: 6, endHour: 18 },
    cadence:       1,           // posts per day

    // ⑤ Social (Phase 4, optional) --------------------------------------
    social: { enabled: false, channels: [] }, // generalizes today's 2 Make webhooks

    // ④ Authority (Phase 5, optional) -----------------------------------
    authority: { enabled: false, features: [] }, // compliant version (internal links, etc.)

    // ⑥ Meta -------------------------------------------------------------
    referralSource: "",         // how did you hear about us
    status:         "active",   // active | paused
    createdAt:      now,
    updatedAt:      now,
  };
}

// ---------------------------------------------------------------------------
//  Normalize — merge a partial onto the blank shape so saves are always safe
//  (one level deep for the nested objects; arrays replaced wholesale)
// ---------------------------------------------------------------------------
export function normalizeProfile(partial = {}) {
  const base = blankProfile();
  const p = { ...base, ...partial };

  p.integration          = { ...base.integration, ...(partial.integration || {}) };
  p.integration.defaults = { ...base.integration.defaults, ...((partial.integration || {}).defaults || {}) };
  p.publishWindow        = { ...base.publishWindow, ...(partial.publishWindow || {}) };
  p.social               = { ...base.social, ...(partial.social || {}) };
  p.authority            = { ...base.authority, ...(partial.authority || {}) };

  p.competitors = Array.isArray(partial.competitors) ? partial.competitors : base.competitors;
  p.categories  = Array.isArray(partial.categories)  ? partial.categories  : base.categories;
  p.keywords    = Array.isArray(partial.keywords)    ? partial.keywords    : base.keywords;

  p.createdAt = partial.createdAt || base.createdAt;
  p.updatedAt = new Date().toISOString();
  return p;
}

// ---------------------------------------------------------------------------
//  Read / write
// ---------------------------------------------------------------------------
export async function getProfile(id) {
  return await getProfileRaw(id);
}

// Merge a partial into whatever exists, normalize, save, keep registry in sync.
export async function saveProfile(id, partial = {}) {
  const existing = await getProfileRaw(id);
  const merged = normalizeProfile({
    ...(existing || {}),
    ...partial,
    createdAt: (existing && existing.createdAt) || undefined,
  });
  await setProfileRaw(id, merged);
  await addTenant({
    id,
    siteName:  merged.siteName,
    siteUrl:   merged.siteUrl,
    status:    merged.status,
    createdAt: merged.createdAt,
  });
  return merged;
}

// Strip anything sensitive before sending to a browser (future-proofing —
// nothing sensitive lives in the profile today).
export function publicProfile(p) {
  if (!p) return null;
  const clone = JSON.parse(JSON.stringify(p));
  if (clone.integration) delete clone.integration.credentials;
  return clone;
}

// ---------------------------------------------------------------------------
//  Campoverde seed — tenant #1 (fixed id "campoverde", so re-seeding is safe)
//  Records Campoverde's REAL current setup: it publishes via the existing
//  GitHub-static commit flow ("github-static"), not WordPress. This proves the
//  adapter pattern supports multiple publish targets from day one.
//  Returns a plain overrides object; saveProfile() normalizes it.
// ---------------------------------------------------------------------------
export function campoverdeSeedProfile() {
  return {
    siteName:    "Campoverde Repair",
    siteUrl:     "https://campoverderepair.eu",
    description: "Bilingual computer, laptop and Apple repair plus website design in Pinar de Campoverde on the Costa Blanca, Spain. 30+ years experience, on-site within 30 km and remote worldwide.",
    audience:    "English-speaking expats and Spanish locals on the Costa Blanca",
    niche:       "Computer repair, tech support, web design and cybersecurity for homes and businesses",

    primaryLanguage:   "en",
    bilingual:         true,
    secondaryLanguage: "es",

    competitors: [],

    brandColor:     "#2563eb",
    voice:          "Blunt neighbourhood tech with 30 years of fixing other people's disasters. No corporate speak; names enemies (overcharging chain stores, planned obsolescence, the 'friend who's good with computers'); uses real fear hooks. Punchy, scroll-stopping, max a few sentences.",
    categories:     ["PC Repair", "Apple", "Web Design", "Security"],
    blogUrlPattern: "https://campoverderepair.eu/blog/posts/{slug}.html",

    integration: {
      type:   "github-static",   // Campoverde's CURRENT method (the existing commit flow)
      status: "connected",
      defaults: { repoOwner: null, repoName: "campoverde-repair", branch: "main", blogDir: "blog/posts" },
    },

    keywords: [],

    queueTarget:   14,           // Campoverde runs 14; product default for new tenants is 30
    timezone:      "Europe/Madrid",
    publishWindow: { startHour: 6, endHour: 18 },
    cadence:       1,

    referralSource: "founder",
    status:         "active",
  };
}
