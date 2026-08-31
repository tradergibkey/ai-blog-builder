// =============================================================================
//  AI BLOG BUILDER  —  api/app/publish.js   (PHASE 2 — piece 3)
// -----------------------------------------------------------------------------
//  WordPress + GitHub-static publisher. Takes a tenant ID and either:
//    a) a pre-generated article (from generate.js), or
//    b) a topic (generates + publishes in one call)
//
//  ADAPTIVE CONTRACT (2026-08-12 rewrite): ABB adapts to whatever token names
//  and card structure a tenant site uses — sites stay unchanged, ABB does the
//  heavy lifting. Three-layer cascade for cards (profile → sniff → default),
//  dual-emit for template tokens (writes both {{HERO_IMG}}/{{COVER_IMAGE}} and
//  {{CONTENT}}/{{BODY_HTML}} variants), and a final strip sweep so any future
//  unrecognized {{TOKEN}} never leaks as literal text into a live post.
//
//  ------ TENANT SITE CONTRACT (loose — ABB adapts) ------
//  Templates may use any of these token names — ABB fills all recognized
//  variants and strips anything else:
//     {{TITLE}} {{DESCRIPTION}} {{SLUG}} {{DATE_ISO}} {{DATE_DISPLAY}}
//     {{HERO_IMG}} | {{COVER_IMAGE}}          (aliases — same value)
//     {{CONTENT}}  | {{BODY_HTML}}            (aliases — same value)
//     {{TAG}}                                  (filled from article.category)
//
//  blog/index.html must contain these markers exactly once:
//     <!-- BLOG-LIST-START --> ... <!-- BLOG-LIST-END -->
//  Card structure between them can be anything — ABB decides how to inject:
//    Plan A: profile.blog.cardTemplate string (with {{URL}} {{HERO}} {{TITLE}}
//            {{DATE_ISO}} {{DATE_DISPLAY}} {{EXCERPT}} {{READ_MORE}} tokens)
//    Plan B: sniff the first existing <article> between markers, clone it
//    Plan C: fall back to a .card / .blog-grid default (matches website-builder)
//  -------------------------------------------------------
//
//  SIMILARITY GUARD (Phase 7): after an article is ready but BEFORE committing,
//  checks it against the tenant's recent corpus using shingled Jaccard
//  similarity. If the draft is too close to a prior post, the publish is
//  rejected so the cron can retry with a fresh generation.
//
//  TRACKING INJECTION: for github-static tenants with a tracking.gtagId in
//  their profile, the publisher injects gtag + Consent Mode v2 + a cookie
//  consent banner into the generated HTML before committing. Language-aware
//  banner text pulled from the tenant's primaryLanguage.
//
//  DELETE POST (2026-08-30): operator-triggered removal of an already
//  published github-static post. Removes the post file from the repo, removes
//  its card from blog/index.html, drops the entry from tenant history, and
//  writes an audit record. See deletePost() at the bottom of this file.
//
//  TRANSLATIONS (Phase 2, 2026-08-31): tenants can opt in via profile
//  { translations: { enabled: true, langs: ["de","es","hu"] } }. After the EN
//  post is generated, publish.js translates it into each target language via
//  Haiku (parallel), commits a per-language post file to blog/posts/{lang}/,
//  injects a card into blog/{lang}/index.html, and writes hreflang alternates
//  across every version so Google clusters them correctly. Partial failure is
//  tolerated (EN + successful langs publish; failed langs are logged and a
//  Telegram alert fires with a retry command).
//
//  RETRANSLATE (Phase 2): operator action { action: "retranslate", slug } —
//  re-runs translations for a previously published post using the snapshot
//  stored in KV at publish time. Also refreshes the EN post's hreflang set so
//  the alternate cluster stays consistent after languages are added.
//
//  Flow:
//    1. Read tenant profile (for draft/publish setting)
//    2. Decrypt credentials
//    3. Optionally fetch hero image from Pexels
//    4. SIMILARITY CHECK — reject near-duplicates
//    5. Create the post via WP REST API or GitHub commit
//    6. Record the post's shingle fingerprint for future checks
//    7. Log to tenant history
//
//  POST /api/app/publish  { id, topic, category }          → generate + publish
//  POST /api/app/publish  { id, article: { title, body, excerpt, ... } } → publish only
//  POST /api/app/publish  { id, action:"delete-post", url } → delete a published post
//  POST /api/app/publish  { id, action:"retranslate", slug, langs? } → re-translate an existing post
//
//  AUTH: x-app-secret (operator only)
//  ENV:  ABB_APP_SECRET, ANTHROPIC_API_KEY, PEXELS_API_KEY (optional),
//        TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (optional — for translation alerts)
// =============================================================================

import { getProfile } from "./_profile.js";
import { getSecret } from "./_secrets.js";
import { addHistory, getHistory, saveHistory, getStr, setStr, setRaw, getRaw } from "./_store.js";
import { checkDuplicate, recordPost } from "../../lib/similarity-guard.js";

// maxDuration bumped 180 → 300 (2026-08-28): needs to be ≥ generate.js's 300s
// budget since publish invokes generate internally as a nested function call.
// If publish times out before generate finishes, the cron sees a 500 and marks
// the plan failed — exactly the pattern that caused emlektabla's 10-day outage.
export const config = { maxDuration: 300 };

// KV wrappers for similarity-guard (strip "abb:" prefix — _store adds its own)
const kvGet = (k) => getStr(k.startsWith("abb:") ? k.slice(4) : k);
const kvSet = (k, v) => setStr(k.startsWith("abb:") ? k.slice(4) : k, v);

// ---------------------------------------------------------------------------
//  Translation configuration (Phase 2)
// ---------------------------------------------------------------------------
// Haiku is used for translations — it's ~5× cheaper than Sonnet, more than
// good enough for prose translation, and its lower latency lets us run 3 langs
// in parallel comfortably within the 300s function budget.
const TRANSLATION_MODEL = process.env.CLAUDE_TRANSLATION_MODEL || "claude-haiku-4-5-20251001";
const TRANSLATION_TIMEOUT_MS = 180_000; // 3 min per language

// Full language names for the translation prompt. Locale hints included so the
// translator uses UK-appropriate vocabulary from a native ES/DE/HU reader's
// perspective (Agnes's whole clientele model).
const LANG_FULL_NAMES = {
  en: "English (British)",
  de: "German",
  es: "Spanish (Spain)",
  hu: "Hungarian",
};

// og:locale uses BCP-47 with an underscore (Facebook convention).
const OG_LOCALES = {
  en: "en_GB", de: "de_DE", es: "es_ES", hu: "hu_HU",
};

// schema.org inLanguage uses BCP-47 with a hyphen (W3C convention).
const BCP47_LOCALES = {
  en: "en-GB", de: "de-DE", es: "es-ES", hu: "hu-HU",
};

// Telegram notify (defensive — dynamic import so publish.js survives even if
// lib/telegram.js is missing in an older repo state).
async function telegramNotify(msg) {
  try {
    const tg = await import("../../lib/telegram.js");
    if (tg && typeof tg.notify === "function") await tg.notify(msg);
  } catch (_) { /* silent */ }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
    return res.status(401).json({ error: "Unauthorised." });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const id = (body.id || "").trim();
  if (!id) return res.status(400).json({ error: "Missing tenant 'id'." });

  try {
    // ---- 1) Load profile + credentials ----
    const profile = await getProfile(id);
    if (!profile) return res.status(404).json({ error: `Tenant "${id}" not found.` });

    // ---- DELETE POST (operator action from the dashboard) ----
    //  Routed before the publish paths so it never touches the generation
    //  pipeline. github-static only — see deletePost() for the reasoning.
    if (body.action === "delete-post") {
      return await deletePost(res, id, profile, body);
    }

    // ---- RETRANSLATE (operator action — retry translations for an existing post) ----
    if (body.action === "retranslate") {
      return await retranslatePost(res, id, profile, body);
    }

    // ---- Route by integration type. github-static publishes by committing an
    //      HTML file to the tenant's repo; WordPress (default) continues below. ----
    if (profile.integration?.type === "github-static") {
      return await publishToGitHub(req, res, id, profile, body);
    }

    const wpUrl     = await getSecret(id, "wp_url");
    const wpUser    = await getSecret(id, "wp_username");
    const wpAppPass = await getSecret(id, "wp_app_password");
    if (!wpUrl || !wpUser || !wpAppPass) {
      return res.status(400).json({ error: "WordPress not connected. Add credentials in the wizard." });
    }

    const base = wpUrl.replace(/\/+$/, "");
    const auth = Buffer.from(`${wpUser}:${wpAppPass}`).toString("base64");
    const headers = { "Authorization": `Basic ${auth}`, "User-Agent": "AIBlogBuilder/2.0" };

    // ---- 2) Get the article (pre-generated or generate now) ----
    let article = body.article || null;
    if (!article) {
      const topic    = (body.topic || "").trim();
      const category = (body.category || "").trim();
      if (!topic) return res.status(400).json({ error: "Provide either 'article' or 'topic'." });

      // Call our own generate endpoint internally
      const siteBase = process.env.SITE_BASE_URL || `https://${req.headers.host}`;
      const genRes = await fetch(`${siteBase}/api/app/generate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-secret": process.env.ABB_APP_SECRET },
        body: JSON.stringify({ id, topic, category }),
      });
      const genData = await genRes.json().catch(() => ({}));
      if (!genRes.ok || !genData.ok) {
        throw new Error("Content generation failed: " + (genData.error || genRes.status));
      }
      article = genData.article;
    }

    if (!article || !article.title || !article.body) {
      return res.status(400).json({ error: "Article missing title or body." });
    }

    // ── SIMILARITY GUARD: reject near-duplicate content before publishing ──
    const dupCheck = await checkDuplicate({ tenant: id, draftText: article.body, kvGet }).catch(e => {
      console.error(`[${id}] Similarity check failed (allowing publish):`, e.message);
      return { isDuplicate: false, maxScore: 0, against: null, draftShingles: [] };
    });

    if (dupCheck.isDuplicate) {
      return res.status(409).json({
        error: "Near-duplicate content detected",
        detail: `Draft is ${(dupCheck.maxScore * 100).toFixed(0)}% similar to a prior post (${dupCheck.against}). Retry to generate a fresh version.`,
        similarTo: dupCheck.against,
        score: dupCheck.maxScore,
      });
    }

    // ---- 3) Upload hero image (optional — needs PEXELS_API_KEY) ----
    let featuredMediaId = null;
    if (article.imageQuery && process.env.PEXELS_API_KEY) {
      try {
        featuredMediaId = await uploadHeroImage(base, headers, article.imageQuery, article.title);
      } catch (e) {
        console.error("Hero image upload failed (continuing without):", e.message);
      }
    }

    // ---- 3b) Inline images (hotlinked Pexels URLs inserted into body HTML) ----
    let wpBody = article.body || "";
    const wpImgWarnings = [];
    if (process.env.PEXELS_API_KEY) {
      let wpInline1 = "", wpInline2 = "";
      const wInlQ1 = article.inlineImageQuery1 || "";
      const wInlQ2 = article.inlineImageQuery2 || "";
      if (wInlQ1) {
        try { wpInline1 = await pexelsImageUrl(wInlQ1); }
        catch (e) { wpImgWarnings.push("inline1: " + e.message); }
      }
      if (wInlQ2) {
        try { wpInline2 = await pexelsImageUrl(wInlQ2); }
        catch (e) { wpImgWarnings.push("inline2: " + e.message); }
      }
      // De-dupe (can't compare with WP hero URL since that was uploaded, but de-dupe inlines)
      if (wpInline2 && wpInline2 === wpInline1) { wpInline2 = ""; wpImgWarnings.push("inline2 de-duped"); }
      const wpImgCount = 1 + (wpInline1 ? 1 : 0) + (wpInline2 ? 1 : 0);
      if (wpImgCount < 3) {
        console.warn(`[${id}] WP image shortage: ${wpImgCount}/3 images.`, wpImgWarnings.join("; "));
      }
      wpBody = injectInlineImages(wpBody, wpInline1, wpInline2, wInlQ1, wInlQ2);
    }

    // Internal links (Phase 5a) — opt-in via profile.authority.enabled, needs history
    if (profile.authority?.enabled) {
      try {
        const history = await getHistory(id);
        wpBody = await addInternalLinks(wpBody, history, article.title);
      } catch (e) {
        console.error(`[${id}] Internal linking failed (continuing):`, e.message);
      }
    }

    // FAQ section (Phase 5b) — visible HTML + FAQPage JSON-LD
    if (article.faq && article.faq.length) {
      const wpLang = article.language || profile.primaryLanguage || "en";
      wpBody = appendFaq(wpBody, article.faq, wpLang);
    }

    // ---- 4) Create the post ----
    const publishAs = profile.integration?.defaults?.publishAs || "draft";
    const postPayload = {
      title:   article.title,
      content: wpBody,
      excerpt: article.excerpt || "",
      status:  publishAs,   // "draft" or "publish"
    };

    if (featuredMediaId) {
      postPayload.featured_media = featuredMediaId;
    }

    // Try to find or create the WP category
    if (article.category) {
      try {
        const catId = await findOrCreateCategory(base, headers, article.category);
        if (catId) postPayload.categories = [catId];
      } catch (e) {
        console.error("Category mapping failed (continuing):", e.message);
      }
    }

    const postRes = await fetch(`${base}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(postPayload),
    });

    if (!postRes.ok) {
      const errText = (await postRes.text()).slice(0, 500);
      throw new Error(`WordPress create post failed (${postRes.status}): ${errText}`);
    }

    const post = await postRes.json();

    // ── SIMILARITY GUARD: record this post's fingerprint for future checks ──
    if (dupCheck.draftShingles && dupCheck.draftShingles.length) {
      await recordPost({
        tenant: id, postId: `wp-${post.id}`, draftShingles: dupCheck.draftShingles, kvGet, kvSet,
      }).catch(e => console.error(`[${id}] Shingle record failed (non-critical):`, e.message));
    }

    // ---- 5) Log to tenant history ----
    await addHistory(id, {
      wpPostId:     post.id,
      title:        article.title,
      url:          post.link || `${base}/?p=${post.id}`,
      status:       publishAs,
      category:     article.category || null,
      language:     article.language || profile.primaryLanguage || "en",
      topic:        article.topic || "",
      archetype:    article.archetype || null,
      published_at: new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true, id,
      post: {
        id:     post.id,
        title:  article.title,
        url:    post.link || `${base}/?p=${post.id}`,
        status: publishAs,
        featuredImage: !!featuredMediaId,
        archetype: article.archetype || null,
      },
    });

  } catch (err) {
    console.error("publish error:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}

// =============================================================================
//  GITHUB-STATIC PUBLISHER  (extended for Phase 2 translations)
// -----------------------------------------------------------------------------
//  Publish flow for a tenant with translations disabled is unchanged from the
//  pre-Phase-2 behaviour: generate → images → enrich → template → commit → card.
//
//  When profile.translations.enabled === true and profile.translations.langs
//  is a non-empty array, the flow becomes:
//    a) EN body enriched with images + internal links (once)
//    b) Article translated to each target language via Haiku, in parallel
//    c) Actual hreflang cluster computed from EN + successful translations
//    d) EN post committed with the shared cluster
//    e) Each successful translation committed to blog/posts/{lang}/{slug}.html
//    f) Each language's blog/{lang}/index.html gets a card injection
//    g) Failed languages get a Telegram alert with a retry command
//
//  History gets ONE entry per publish (the EN version), with a translations
//  array listing published localised URLs — dashboard/similarity-guard code
//  doesn't need to change.
// =============================================================================

async function publishToGitHub(req, res, id, profile, body) {
  const repo   = await getSecret(id, "github_repo");
  const branch = (await getSecret(id, "github_branch")) || "main";
  const token  = await getSecret(id, "github_token");

  if (!repo || !token) {
    return res.status(400).json({ error: "GitHub not connected. Add repo + token in the wizard." });
  }

  const gh = {
    token,
    api: `https://api.github.com/repos/${repo}/contents`,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "AIBlogBuilder/2.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };

  // ---- 1) Get the article (pre-generated or generate now) ----
  let article = body.article || null;
  if (!article) {
    const topic    = (body.topic || "").trim();
    const category = (body.category || "").trim();
    if (!topic) return res.status(400).json({ error: "Provide either 'article' or 'topic'." });

    const siteBase = process.env.SITE_BASE_URL || `https://${req.headers.host}`;
    const genRes = await fetch(`${siteBase}/api/app/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-secret": process.env.ABB_APP_SECRET },
      body: JSON.stringify({ id, topic, category }),
    });
    const genData = await genRes.json().catch(() => ({}));
    if (!genRes.ok || !genData.ok) {
      throw new Error("Content generation failed: " + (genData.error || genRes.status));
    }
    article = genData.article;
  }

  if (!article || !article.title || !article.body) {
    return res.status(400).json({ error: "Article missing title or body." });
  }

  // ── SIMILARITY GUARD: reject near-duplicate content before committing ──
  const dupCheck = await checkDuplicate({ tenant: id, draftText: article.body, kvGet }).catch(e => {
    console.error(`[${id}] Similarity check failed (allowing publish):`, e.message);
    return { isDuplicate: false, maxScore: 0, against: null, draftShingles: [] };
  });

  if (dupCheck.isDuplicate) {
    return res.status(409).json({
      error: "Near-duplicate content detected",
      detail: `Draft is ${(dupCheck.maxScore * 100).toFixed(0)}% similar to a prior post (${dupCheck.against}). Retry to generate a fresh version.`,
      similarTo: dupCheck.against,
      score: dupCheck.maxScore,
    });
  }

  // ---- 2) Images: hero + 2 inline (all hotlinked Pexels URLs) ----
  //         Same image set is reused across all language versions — a Pexels
  //         photo of a UK terrace looks the same in German.
  let heroImg = "";
  let inlineImg1 = "";
  let inlineImg2 = "";
  const imgWarnings = [];

  const heroQuery   = article.heroImageQuery || article.imageQuery || "";
  const inlQ1       = article.inlineImageQuery1 || "";
  const inlQ2       = article.inlineImageQuery2 || "";

  if (process.env.PEXELS_API_KEY) {
    if (heroQuery)  { try { heroImg    = await pexelsImageUrl(heroQuery); } catch (e) { imgWarnings.push("hero: " + e.message); } }
    if (inlQ1)      { try { inlineImg1 = await pexelsImageUrl(inlQ1); }     catch (e) { imgWarnings.push("inline1: " + e.message); } }
    if (inlQ2)      { try { inlineImg2 = await pexelsImageUrl(inlQ2); }     catch (e) { imgWarnings.push("inline2: " + e.message); } }
    if (inlineImg1 && inlineImg1 === heroImg)    { inlineImg1 = ""; imgWarnings.push("inline1 de-duped (same as hero)"); }
    if (inlineImg2 && inlineImg2 === heroImg)    { inlineImg2 = ""; imgWarnings.push("inline2 de-duped (same as hero)"); }
    if (inlineImg2 && inlineImg2 === inlineImg1) { inlineImg2 = ""; imgWarnings.push("inline2 de-duped (same as inline1)"); }
  }

  if (!heroImg) heroImg = `${(profile.siteUrl || "").replace(/\/+$/, "")}/img/og-cover.jpg`;

  const imgCount = 1 + (inlineImg1 ? 1 : 0) + (inlineImg2 ? 1 : 0);
  if (imgCount < 3) console.warn(`[${id}] Image shortage: ${imgCount}/3 images found.`, imgWarnings.join("; "));

  // ---- 3) Enrich EN body ONCE with images + internal links ----
  //         Translation happens AFTER this so translators see the real <img>
  //         tags and existing hrefs, and preserve them verbatim.
  let enBody = article.body || "";
  enBody = injectInlineImages(enBody, inlineImg1, inlineImg2, inlQ1, inlQ2);

  if (profile.authority?.enabled) {
    try {
      const history = await getHistory(id);
      enBody = await addInternalLinks(enBody, history, article.title);
    } catch (e) {
      console.error(`[${id}] Internal linking failed (continuing):`, e.message);
    }
  }
  // Replace the article body with the enriched version — this is what the
  // translator will receive and produce translated copies from.
  article.body = enBody;

  // ---- 4) Slug + dates ----
  const slug = slugify(article.title);
  const now  = new Date();
  const dateIso = now.toISOString();
  const enLang  = article.language || profile.primaryLanguage || "en";

  // ---- 5) Determine target languages and translate in parallel ----
  const trConfig = profile.translations || {};
  const targetLangs = (trConfig.enabled && Array.isArray(trConfig.langs))
    ? trConfig.langs.filter(l => l !== enLang && LANG_FULL_NAMES[l])
    : [];

  const translations = [];
  const translationErrors = [];
  if (targetLangs.length) {
    console.log(`[${id}] Translating "${slug}" to: ${targetLangs.join(", ")}`);
    const results = await Promise.allSettled(targetLangs.map(l => translateArticle(article, l)));
    for (let i = 0; i < results.length; i++) {
      const l = targetLangs[i];
      const r = results[i];
      if (r.status === "fulfilled") {
        translations.push(r.value);
      } else {
        translationErrors.push({ lang: l, error: r.reason?.message || String(r.reason) });
        console.error(`[${id}] Translation to ${l} FAILED:`, r.reason?.message || r.reason);
      }
    }
  }

  // ---- 6) Build the hreflang cluster (EN + successful translations) ----
  const cluster = [enLang, ...translations.map(t => t.language)];

  // ---- 7) Read the post template ----
  const templatePath = "blog/post-template.html";
  const templateFile = await ghGetFile(gh, templatePath, branch);
  if (!templateFile) {
    return res.status(400).json({ error: `Could not read ${templatePath} from ${repo}. Check the repo has the ABB blog structure.` });
  }
  const template = b64decode(templateFile.content);
  const cleanTemplate = template.replace(/<!--[\s\S]*?-->\s*/, "");

  const gtagId = profile.tracking?.gtagId || "";
  const siteUrl = profile.siteUrl || "";

  // ---- 8) Build + commit each version ----
  const versions = [article, ...translations];
  const publishResults = [];

  for (const v of versions) {
    const vLang = v.language;
    const vDateDisplay = formatDateHu(now, vLang);

    // Enrich body per language (translated FAQ heading + reviewer label +
    // localised date-formatted byline).
    let vBody = v.body || "";
    if (profile.author?.reviewerName) vBody = appendReviewerLine(vBody, profile.author, vLang);
    if (v.faq && v.faq.length)        vBody = appendFaq(vBody, v.faq, vLang);
    if (profile.author?.name)         vBody = prependByline(vBody, profile.author, vDateDisplay);

    // Build the post HTML with correct per-language canonical + shared cluster
    let postHtml = buildPostHtml(cleanTemplate, {
      article:     v,
      slug,
      dateIso,
      dateDisplay: vDateDisplay,
      heroImg,
      siteUrl,
      lang:        vLang,
      cluster,
      finalBody:   vBody,
    });

    if (gtagId) postHtml = injectTracking(postHtml, gtagId, vLang);

    // Commit post file — EN at blog/posts/{slug}.html, others at blog/posts/{lang}/{slug}.html
    const postPath = vLang === enLang
      ? `blog/posts/${slug}.html`
      : `blog/posts/${vLang}/${slug}.html`;
    const existingPost = await ghGetFile(gh, postPath, branch);
    await ghPutFile(gh, postPath, branch,
      vLang === enLang
        ? `Add blog post: ${v.title}`
        : `Add ${vLang.toUpperCase()} translation: ${v.title}`,
      b64encode(postHtml),
      existingPost?.sha
    );

    // Inject card into the correct language index
    const indexPath = vLang === enLang ? "blog/index.html" : `blog/${vLang}/index.html`;
    let cardInjected = false;
    try {
      const indexFile = await ghGetFile(gh, indexPath, branch);
      if (indexFile) {
        const indexHtml = b64decode(indexFile.content);
        const cardUrl = vLang === enLang ? `/blog/posts/${slug}` : `/blog/posts/${vLang}/${slug}`;
        const updated = injectCard(indexHtml, {
          slug,
          title:       v.title,
          excerpt:     v.excerpt || v.metaDescription || "",
          heroImg,
          dateIso,
          dateDisplay: vDateDisplay,
          url:         cardUrl,
        }, profile, vLang);
        if (updated && updated !== indexHtml) {
          await ghPutFile(gh, indexPath, branch,
            `Add "${v.title}" to ${vLang} blog index`,
            b64encode(updated),
            indexFile.sha
          );
          cardInjected = true;
        }
      } else if (vLang !== enLang) {
        console.warn(`[${id}] ${indexPath} not found — skipping card for ${vLang}. Create the language index first.`);
      }
    } catch (e) {
      console.error(`[${id}] Index card injection failed for ${vLang} (post still committed):`, e.message);
    }

    const versionUrl = vLang === enLang
      ? `${siteUrl.replace(/\/+$/, "")}/blog/posts/${slug}`
      : `${siteUrl.replace(/\/+$/, "")}/blog/posts/${vLang}/${slug}`;
    publishResults.push({ lang: vLang, url: versionUrl, cardInjected });
  }

  // ---- 9) Snapshot for retranslate — stores the enriched EN article (images
  //         already injected, links added) so a later retranslate uses the
  //         exact same body the original translations saw.
  await setRaw(`t:${id}:articles:${slug}`, {
    original:       { ...article },
    publishedLangs: publishResults.map(r => r.lang),
    heroImg,
    savedAt:        dateIso,
  }).catch(e => console.error(`[${id}] Article snapshot save failed (non-critical):`, e.message));

  // ── SIMILARITY GUARD: record this post's fingerprint for future checks ──
  if (dupCheck.draftShingles && dupCheck.draftShingles.length) {
    await recordPost({
      tenant: id, postId: slug, draftShingles: dupCheck.draftShingles, kvGet, kvSet,
    }).catch(e => console.error(`[${id}] Shingle record failed (non-critical):`, e.message));
  }

  // ---- 10) Log to tenant history — one entry per publish, with translations array ----
  const enUrl = `${siteUrl.replace(/\/+$/, "")}/blog/posts/${slug}`;
  await addHistory(id, {
    title:        article.title,
    url:          enUrl,
    status:       "publish",
    category:     article.category || null,
    language:     enLang,
    topic:        article.topic || "",
    archetype:    article.archetype || null,
    translations: translations.map(t => ({
      lang: t.language,
      url:  `${siteUrl.replace(/\/+$/, "")}/blog/posts/${t.language}/${slug}`,
    })),
    published_at: dateIso,
  });

  // ---- 11) Telegram alert on translation failures (silent on full success) ----
  if (translationErrors.length && targetLangs.length) {
    const msg = [
      `🌐 Translation partial · ${id}`,
      `Post: ${article.title.slice(0, 90)}`,
      `Slug: ${slug}`,
      `✅ Success: ${translations.map(t => t.language).join(", ") || "(none)"}`,
      `❌ Failed:  ${translationErrors.map(e => e.lang).join(", ")}`,
      "",
      ...translationErrors.map(e => `Error (${e.lang}): ${(e.error || "").slice(0, 220)}`),
      "",
      `Retry:`,
      `POST /api/app/publish`,
      `{"id":"${id}","action":"retranslate","slug":"${slug}"}`,
    ].join("\n");
    telegramNotify(msg).catch(() => {});
  }

  return res.status(200).json({
    ok: true, id,
    post: {
      title:         article.title,
      url:           enUrl,
      status:        "publish",
      slug,
      featuredImage: !!heroImg,
      indexUpdated:  publishResults[0]?.cardInjected || false,
      archetype:     article.archetype || null,
      versions:      publishResults,
      translationErrors,
    },
  });
}

// =============================================================================
//  TRANSLATE ARTICLE  (Phase 2 — Haiku call)
// -----------------------------------------------------------------------------
//  Takes an EN article (post-image-injection, post-internal-links) and returns
//  the same shape with title, metaDescription, excerpt, body, category and FAQ
//  translated to targetLang. Preserves all HTML markup, all href URLs, all img
//  src URLs and inline styles — the translator only touches visible text and
//  alt attributes.
//
//  Fails fast: raises on API errors, timeout, max_tokens truncation, or missing
//  required fields. Called via Promise.allSettled from publishToGitHub so one
//  language failure never blocks the others.
// =============================================================================

async function translateArticle(article, targetLang) {
  const targetName = LANG_FULL_NAMES[targetLang];
  if (!targetName) throw new Error(`Unknown target language: ${targetLang}`);

  const tool = {
    name: "translated_article",
    description: `Return the article fully translated into ${targetName}.`,
    input_schema: {
      type: "object",
      properties: {
        title:           { type: "string", description: `The article title, translated to ${targetName}. Keep it natural and SEO-friendly.` },
        metaDescription: { type: "string", description: `The meta description, translated to ${targetName}. Aim for 150-160 characters.` },
        excerpt:         { type: "string", description: `The 1-2 sentence excerpt, translated to ${targetName}.` },
        body:            { type: "string", description: `The full article body HTML, translated to ${targetName}. Preserve every HTML tag exactly (h2, h3, p, ul, li, strong, em, img, a, div, section, span, br). Preserve every href="..." URL exactly — only translate anchor text. Preserve every img src="..." exactly — translate the alt="..." text. Preserve all inline style attributes. Preserve the structure and order of every section.` },
        category:        { type: "string", description: `Category label translated to ${targetName}. Keep short (1-3 words). Industry terms like "Buy-to-Let" or "HMO" may stay in English if that's the conventional usage in ${targetName}.` },
        faq: {
          type: "array",
          description: `FAQ items translated to ${targetName}.`,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "Question translated naturally." },
              answer:   { type: "string", description: "Answer translated naturally, keeping 2-3 sentences." },
            },
            required: ["question", "answer"],
          },
        },
      },
      required: ["title", "metaDescription", "excerpt", "body", "faq"],
    },
  };

  const system = `You are a professional financial translator working for a UK mortgage broker's blog. Translate content into ${targetName} while preserving all HTML markup exactly.

CRITICAL RULES:
- Preserve every HTML tag, attribute, and inline style exactly as-is
- Preserve every href="..." URL exactly — only translate the anchor text between <a>...</a>
- Preserve every img src="..." exactly — translate the alt="..." text
- Do not add commentary, notes, or explanations — only the translation
- Financial and legal terms should use correct UK-context terminology described naturally for a ${targetName}-speaking reader
- Keep the same tone, register, and paragraph structure as the source
- Never modify URLs, paths, or file extensions
- The closing "Working with [brand]" paragraph stays as a paragraph — translate its prose but keep any link paths (like /#contact) unchanged`;

  const userMsg = `Translate this article to ${targetName}. Call the translated_article tool with the complete translation.

TITLE: ${article.title}

META DESCRIPTION: ${article.metaDescription || ""}

EXCERPT: ${article.excerpt || ""}

CATEGORY: ${article.category || ""}

BODY HTML:
${article.body}

FAQ (${(article.faq || []).length} items):
${JSON.stringify(article.faq || [], null, 2)}`;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), TRANSLATION_TIMEOUT_MS);
  const t0 = Date.now();

  let apiRes;
  try {
    apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: TRANSLATION_MODEL,
        max_tokens: 8000,
        system,
        messages: [{ role: "user", content: userMsg }],
        tools: [tool],
        tool_choice: { type: "tool", name: "translated_article" },
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Translation to ${targetLang} timed out after ${TRANSLATION_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Translation to ${targetLang} fetch failed: ${e.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
  const dtMs = Date.now() - t0;

  if (!apiRes.ok) {
    throw new Error(`Translation to ${targetLang} API ${apiRes.status} after ${dtMs}ms: ${(await apiRes.text()).slice(0, 220)}`);
  }

  const data = await apiRes.json();
  if (data.stop_reason === "max_tokens") {
    throw new Error(`Translation to ${targetLang} truncated at max_tokens after ${dtMs}ms — article too long.`);
  }

  const block = (data.content || []).find(b => b.type === "tool_use");
  if (!block || !block.input) {
    throw new Error(`Translation to ${targetLang} returned no tool_use after ${dtMs}ms. stop_reason=${data.stop_reason}`);
  }

  const translated = block.input;
  if (!translated.title || !translated.body) {
    throw new Error(`Translation to ${targetLang} incomplete (title=${!!translated.title}, body=${!!translated.body}) after ${dtMs}ms.`);
  }

  console.log(`[translate] ${targetLang}: ok in ${dtMs}ms, ${translated.body.length} body chars.`);

  // Preserve every non-translated field from the source; overlay the translated ones.
  return {
    ...article,
    title:           translated.title,
    metaDescription: translated.metaDescription || article.metaDescription,
    excerpt:         translated.excerpt || article.excerpt,
    body:            translated.body,
    category:        translated.category || article.category,
    faq:             translated.faq && translated.faq.length ? translated.faq : article.faq,
    language:        targetLang,
  };
}

// =============================================================================
//  BUILD POST HTML  (Phase 2 — extends the old inline token fill)
// -----------------------------------------------------------------------------
//  Fills every recognized token, then strips anything unrecognized so no
//  literal {{FOO}} ever leaks into a published post. Backward-compatible with
//  the pre-Phase-2 token set — new tokens (LANG, CANONICAL_URL, HREFLANG_TAGS,
//  OG_LOCALE, OG_LOCALE_ALTERNATES, LANG_BCP47, TAG_CRUMB, META_TAG_SEP) are
//  simply ignored by an older template that doesn't reference them.
// =============================================================================

function buildPostHtml(cleanTemplate, ctx) {
  const { article, slug, dateIso, dateDisplay, heroImg, siteUrl, lang, cluster, finalBody } = ctx;

  const canonicalUrl = buildPostUrl(siteUrl, slug, lang);
  const hreflangTags = buildHreflangTags(siteUrl, slug, cluster);
  const ogLocale     = OG_LOCALES[lang] || OG_LOCALES.en;
  const ogAlternates = buildOgLocaleAlternates(lang, cluster);
  const bcp47        = BCP47_LOCALES[lang] || BCP47_LOCALES.en;

  const tag        = (article.category || "").trim();
  const tagCrumb   = tag ? `<span>›</span><span>${esc(tag)}</span>` : "";
  const metaTagSep = tag ? ` · ${esc(tag)}` : "";

  let html = cleanTemplate
    .replace(/\{\{TITLE\}\}/g,                esc(article.title))
    .replace(/\{\{DESCRIPTION\}\}/g,          esc(article.metaDescription || article.excerpt || ""))
    .replace(/\{\{SLUG\}\}/g,                 slug)
    .replace(/\{\{DATE_ISO\}\}/g,             dateIso)
    .replace(/\{\{DATE_DISPLAY\}\}/g,         esc(dateDisplay))
    .replace(/\{\{HERO_IMG\}\}/g,             esc(heroImg))
    .replace(/\{\{COVER_IMAGE\}\}/g,          esc(heroImg))
    .replace(/\{\{CONTENT\}\}/g,              finalBody)
    .replace(/\{\{BODY_HTML\}\}/g,            finalBody)
    .replace(/\{\{TAG\}\}/g,                  esc(tag))
    .replace(/\{\{TAG_CRUMB\}\}/g,            tagCrumb)
    .replace(/\{\{META_TAG_SEP\}\}/g,         metaTagSep)
    .replace(/\{\{LANG\}\}/g,                 lang)
    .replace(/\{\{CANONICAL_URL\}\}/g,        canonicalUrl)
    .replace(/\{\{HREFLANG_TAGS\}\}/g,        hreflangTags)
    .replace(/\{\{OG_LOCALE\}\}/g,            ogLocale)
    .replace(/\{\{OG_LOCALE_ALTERNATES\}\}/g, ogAlternates)
    .replace(/\{\{LANG_BCP47\}\}/g,           bcp47);

  // Safety sweep — anything left is stripped so no {{FOO}} literal leaks.
  html = html.replace(/\{\{[A-Z_][A-Z0-9_]*\}\}/g, "");

  return html;
}

// -----------------------------------------------------------------------------
//  URL builders + hreflang helpers
// -----------------------------------------------------------------------------

function buildPostUrl(siteUrl, slug, lang) {
  const base = (siteUrl || "").replace(/\/+$/, "");
  return lang === "en"
    ? `${base}/blog/posts/${slug}`
    : `${base}/blog/posts/${lang}/${slug}`;
}

// Google's strict rule: every URL in an alternates cluster must declare the
// FULL set (including itself) plus x-default → the default language (EN here).
function buildHreflangTags(siteUrl, slug, cluster) {
  const lines = [];
  for (const l of cluster) {
    lines.push(`<link rel="alternate" hreflang="${l}" href="${buildPostUrl(siteUrl, slug, l)}">`);
  }
  lines.push(`<link rel="alternate" hreflang="x-default" href="${buildPostUrl(siteUrl, slug, "en")}">`);
  return lines.join("\n");
}

// og:locale:alternate for every OTHER language in the cluster (Facebook / OG).
function buildOgLocaleAlternates(currentLang, cluster) {
  return cluster
    .filter(l => l !== currentLang && OG_LOCALES[l])
    .map(l => `<meta property="og:locale:alternate" content="${OG_LOCALES[l]}">`)
    .join("\n");
}

// =============================================================================
//  RETRANSLATE POST  (Phase 2 operator action)
// -----------------------------------------------------------------------------
//  POST /api/app/publish { id, action:"retranslate", slug, langs? }
//
//  Re-runs translations for an already-published EN post. Reads the article
//  snapshot stored at publish time from KV, translates to the requested langs
//  (or all configured langs if omitted), commits each new/updated translation,
//  injects cards into each language index, and re-emits the EN post with an
//  updated hreflang cluster so Google sees the added languages.
//
//  Common uses:
//    - A language failed at publish time and needs retry
//    - New target language added to profile.translations.langs after publish
//    - Manual translation refresh (e.g. after a translator prompt change)
// =============================================================================

async function retranslatePost(res, id, profile, body) {
  if (profile.integration?.type !== "github-static") {
    return res.status(400).json({ error: "Retranslate is only supported for github-static tenants." });
  }

  const slug = (body.slug || "").trim();
  if (!slug) return res.status(400).json({ error: "Missing 'slug' of the post to retranslate." });

  const trConfig = profile.translations || {};
  const configLangs = (trConfig.enabled && Array.isArray(trConfig.langs)) ? trConfig.langs : [];
  if (!configLangs.length) {
    return res.status(400).json({ error: "No translation languages configured for this tenant (profile.translations.langs empty)." });
  }

  // Optional per-request lang filter — otherwise re-translate all configured langs.
  const requestLangs = Array.isArray(body.langs) && body.langs.length
    ? body.langs.filter(l => configLangs.includes(l))
    : configLangs;
  if (!requestLangs.length) {
    return res.status(400).json({ error: "Requested languages don't intersect with tenant config." });
  }

  const snapshot = await getRaw(`t:${id}:articles:${slug}`);
  if (!snapshot || !snapshot.original) {
    return res.status(404).json({ error: `No article snapshot found for slug "${slug}". Cannot retranslate — was this post published before Phase 2?` });
  }
  const article = snapshot.original;
  const enLang = article.language || profile.primaryLanguage || "en";

  const repo   = await getSecret(id, "github_repo");
  const branch = (await getSecret(id, "github_branch")) || "main";
  const token  = await getSecret(id, "github_token");
  if (!repo || !token) return res.status(400).json({ error: "GitHub not connected." });

  const gh = {
    token,
    api: `https://api.github.com/repos/${repo}/contents`,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "AIBlogBuilder/2.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };

  // Translate to each requested target lang (skip EN itself).
  const targetLangs = requestLangs.filter(l => l !== enLang);
  const translations = [];
  const translationErrors = [];
  if (targetLangs.length) {
    console.log(`[${id}] Retranslating "${slug}" to: ${targetLangs.join(", ")}`);
    const results = await Promise.allSettled(targetLangs.map(l => translateArticle(article, l)));
    for (let i = 0; i < results.length; i++) {
      const l = targetLangs[i];
      const r = results[i];
      if (r.status === "fulfilled") translations.push(r.value);
      else translationErrors.push({ lang: l, error: r.reason?.message || String(r.reason) });
    }
  }

  // Read template
  const templateFile = await ghGetFile(gh, "blog/post-template.html", branch);
  if (!templateFile) return res.status(400).json({ error: "Could not read blog/post-template.html" });
  const cleanTemplate = b64decode(templateFile.content).replace(/<!--[\s\S]*?-->\s*/, "");

  const heroImg = snapshot.heroImg || `${(profile.siteUrl || "").replace(/\/+$/, "")}/img/og-cover.jpg`;
  const gtagId  = profile.tracking?.gtagId || "";
  const siteUrl = profile.siteUrl || "";

  // Cluster = EN + everything previously published + everything newly translated (dedup).
  const priorLangs = Array.isArray(snapshot.publishedLangs) ? snapshot.publishedLangs : [enLang];
  const cluster = Array.from(new Set([enLang, ...priorLangs, ...translations.map(t => t.language)]));

  // Reuse the original publish timestamp so lastmod/git-history don't lie.
  const savedIso = snapshot.savedAt || new Date().toISOString();
  const savedDate = new Date(savedIso);

  const publishResults = [];

  // ---- Refresh EN post (hreflang cluster may have grown) ----
  try {
    const enDateDisplay = formatDateHu(savedDate, enLang);
    let enBody = article.body || "";
    if (profile.author?.reviewerName) enBody = appendReviewerLine(enBody, profile.author, enLang);
    if (article.faq && article.faq.length) enBody = appendFaq(enBody, article.faq, enLang);
    if (profile.author?.name) enBody = prependByline(enBody, profile.author, enDateDisplay);

    let enHtml = buildPostHtml(cleanTemplate, {
      article, slug, dateIso: savedIso, dateDisplay: enDateDisplay,
      heroImg, siteUrl, lang: enLang, cluster, finalBody: enBody,
    });
    if (gtagId) enHtml = injectTracking(enHtml, gtagId, enLang);

    const enPath = `blog/posts/${slug}.html`;
    const enExisting = await ghGetFile(gh, enPath, branch);
    await ghPutFile(gh, enPath, branch,
      `Refresh EN hreflang: ${article.title}`,
      b64encode(enHtml),
      enExisting?.sha
    );
    publishResults.push({ lang: enLang, refreshed: true });
  } catch (e) {
    console.error(`[${id}] EN refresh failed during retranslate:`, e.message);
    publishResults.push({ lang: enLang, refreshed: false, error: e.message });
  }

  // ---- Commit each translated version + card ----
  for (const v of translations) {
    const vLang = v.language;
    const vDateDisplay = formatDateHu(savedDate, vLang);

    let vBody = v.body || "";
    if (profile.author?.reviewerName) vBody = appendReviewerLine(vBody, profile.author, vLang);
    if (v.faq && v.faq.length)        vBody = appendFaq(vBody, v.faq, vLang);
    if (profile.author?.name)         vBody = prependByline(vBody, profile.author, vDateDisplay);

    let postHtml = buildPostHtml(cleanTemplate, {
      article: v, slug, dateIso: savedIso, dateDisplay: vDateDisplay,
      heroImg, siteUrl, lang: vLang, cluster, finalBody: vBody,
    });
    if (gtagId) postHtml = injectTracking(postHtml, gtagId, vLang);

    const postPath = `blog/posts/${vLang}/${slug}.html`;
    const existing = await ghGetFile(gh, postPath, branch);
    await ghPutFile(gh, postPath, branch,
      `Retranslate ${vLang.toUpperCase()}: ${v.title}`,
      b64encode(postHtml),
      existing?.sha
    );

    let cardInjected = false;
    try {
      const indexPath = `blog/${vLang}/index.html`;
      const indexFile = await ghGetFile(gh, indexPath, branch);
      if (indexFile) {
        const indexHtml = b64decode(indexFile.content);
        const cardUrl = `/blog/posts/${vLang}/${slug}`;
        const updated = injectCard(indexHtml, {
          slug, title: v.title,
          excerpt: v.excerpt || v.metaDescription || "",
          heroImg, dateIso: savedIso, dateDisplay: vDateDisplay,
          url: cardUrl,
        }, profile, vLang);
        if (updated && updated !== indexHtml) {
          await ghPutFile(gh, indexPath, branch,
            `Add "${v.title}" to ${vLang} blog index`,
            b64encode(updated),
            indexFile.sha
          );
          cardInjected = true;
        }
      } else {
        console.warn(`[${id}] ${indexPath} not found — skipping card for ${vLang}.`);
      }
    } catch (e) {
      console.error(`[${id}] Card injection failed for ${vLang} during retranslate:`, e.message);
    }

    publishResults.push({ lang: vLang, cardInjected });
  }

  // Update snapshot's publishedLangs so future retranslates know the full cluster.
  await setRaw(`t:${id}:articles:${slug}`, {
    ...snapshot,
    publishedLangs:    cluster,
    lastRetranslateAt: new Date().toISOString(),
  }).catch(e => console.error(`[${id}] Snapshot update failed:`, e.message));

  // Telegram alert on any failures.
  if (translationErrors.length) {
    const msg = [
      `🔁 Retranslate partial · ${id}`,
      `Post: ${article.title.slice(0, 90)}`,
      `Slug: ${slug}`,
      `✅ Success: ${translations.map(t => t.language).join(", ") || "(none)"}`,
      `❌ Failed:  ${translationErrors.map(e => e.lang).join(", ")}`,
      "",
      ...translationErrors.map(e => `Error (${e.lang}): ${(e.error || "").slice(0, 220)}`),
    ].join("\n");
    telegramNotify(msg).catch(() => {});
  }

  return res.status(200).json({
    ok: true, id, slug,
    translated:  translations.map(t => t.language),
    errors:      translationErrors,
    cluster,
    versions:    publishResults,
  });
}

// =============================================================================
//  DELETE POST  (operator action — dashboard 🗑 button)
// -----------------------------------------------------------------------------
//  POST /api/app/publish { id, action:"delete-post", url }
//
//  Removes a published post everywhere ABB knows about it:
//    1. blog/posts/{slug}.html  → deleted from the tenant repo (GitHub commit)
//    2. blog/index.html         → its <article> card removed (GitHub commit)
//    3. tenant history in KV    → the entry (or entries) with that url dropped
//    4. audit record written to abb:t:{id}:deleted:{slug}
//
//  DESIGN NOTES
//  • github-static only. There is no live WordPress tenant, and WP deletion is
//    a different API surface (DELETE /wp/v2/posts/{id}); adding it untested
//    would be worse than a clear error.
//  • Partial failure is tolerated and reported rather than aborted. A post
//    whose file is already gone but whose history entry lingers is exactly the
//    case an operator needs to clean up, so a 404 on the file is a warning,
//    not a hard stop.
//  • The similarity-guard fingerprint is deliberately NOT removed. Deleting a
//    post does not mean the operator wants ABB to regenerate the same article;
//    resetting the guard is a separate, explicit action.
//  • Marker-agnostic: card removal understands both the hyphen convention
//    (BLOG-LIST-START/END, used by Agnes and emlektabla) and the underscore
//    convention (BLOG_CARDS_START/END, used by Campoverde's build-sitemap.js).
// =============================================================================

async function deletePost(res, id, profile, body) {
  if (profile.integration?.type !== "github-static") {
    return res.status(400).json({
      error: "Deleting posts is only supported for github-static tenants.",
    });
  }

  const rawUrl = (body.url || "").trim();
  if (!rawUrl) return res.status(400).json({ error: "Missing 'url' of the post to delete." });

  const slug = slugFromUrl(rawUrl);
  if (!slug) return res.status(400).json({ error: `Could not derive a post slug from "${rawUrl}".` });

  const repo   = await getSecret(id, "github_repo");
  const branch = (await getSecret(id, "github_branch")) || "main";
  const token  = await getSecret(id, "github_token");

  if (!repo || !token) {
    return res.status(400).json({ error: "GitHub not connected. Add repo + token in the wizard." });
  }

  const gh = {
    token,
    api: `https://api.github.com/repos/${repo}/contents`,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "AIBlogBuilder/2.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };

  const warnings = [];

  // ---- 1) Find the history entry (for the audit record + a nicer commit message) ----
  let historyEntry = null;
  let history = [];
  try {
    history = await getHistory(id);
    historyEntry = history.find(h => h && h.url && slugFromUrl(h.url) === slug) || null;
  } catch (e) {
    warnings.push("Could not read history: " + e.message);
  }

  const postTitle = (historyEntry && (historyEntry.title || historyEntry.topic)) || slug;

  // ---- 2) Delete the post file from the repo ----
  let fileDeleted = false;
  const postPath = `blog/posts/${slug}.html`;
  try {
    const existing = await ghGetFile(gh, postPath, branch);
    if (!existing) {
      warnings.push(`${postPath} was not in the repo (already deleted?).`);
    } else {
      await ghDeleteFile(gh, postPath, branch, `Delete blog post: ${postTitle}`, existing.sha);
      fileDeleted = true;
    }
  } catch (e) {
    warnings.push("Post file delete failed: " + e.message);
  }

  // ---- 3) Remove the card from blog/index.html ----
  let cardRemoved = false;
  try {
    const indexPath = "blog/index.html";
    const indexFile = await ghGetFile(gh, indexPath, branch);
    if (!indexFile) {
      warnings.push("blog/index.html not found — no card to remove.");
    } else {
      const indexHtml = b64decode(indexFile.content);
      const result = removeCardBySlug(indexHtml, slug);
      if (result.removed) {
        await ghPutFile(gh, indexPath, branch,
          `Remove "${postTitle}" from blog index`,
          b64encode(result.html),
          indexFile.sha
        );
        cardRemoved = true;
      } else {
        warnings.push("No matching card found in blog/index.html (nothing to remove).");
      }
    }
  } catch (e) {
    warnings.push("Card removal failed: " + e.message);
  }

  // ---- 4) Drop the entry (or entries) from tenant history ----
  let historyRemoved = 0;
  try {
    const before = history.length;
    const kept = history.filter(h => !(h && h.url && slugFromUrl(h.url) === slug));
    historyRemoved = before - kept.length;
    if (historyRemoved > 0) await saveHistory(id, kept);
  } catch (e) {
    warnings.push("History update failed: " + e.message);
  }

  // ---- 5) Audit record (non-critical) ----
  try {
    await setRaw(`t:${id}:deleted:${slug}`, {
      slug,
      title: postTitle,
      url: rawUrl,
      deletedAt: new Date().toISOString(),
      fileDeleted,
      cardRemoved,
      entry: historyEntry || null,
    });
  } catch (e) {
    warnings.push("Audit record failed: " + e.message);
  }

  return res.status(200).json({
    ok: true,
    id,
    slug,
    title: postTitle,
    fileDeleted,
    cardRemoved,
    historyRemoved,
    warnings,
  });
}

// Derive a post slug from a full URL, a path, or a bare slug.
// "https://site.com/blog/posts/my-post"      → "my-post"
// "https://site.com/blog/posts/my-post.html" → "my-post"
// "my-post"                                  → "my-post"
function slugFromUrl(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  // A bare slug has no path separator — "https://my-post" would parse as a
  // hostname and yield an empty pathname, so only URL-parse when there's a "/".
  if (s.includes("/")) {
    try {
      const withProto = s.startsWith("http") ? s : "https://" + s;
      s = new URL(withProto).pathname;
    } catch {
      // not a URL — fall through and treat it as a path
    }
  }
  s = s.split("?")[0].split("#")[0];
  const last = s.split("/").filter(Boolean).pop() || "";
  return last.replace(/\.html?$/i, "");
}

// Remove the <article> card whose markup references `slug` from blog/index.html.
//
// Scoped to the blog-list region when markers are present (both conventions
// supported); falls back to scanning the whole document if neither pair is
// found. The slug match is boundary-guarded so deleting "test-post" can never
// take out "test-post-2".
function removeCardBySlug(html, slug) {
  const MARKER_PAIRS = [
    ["<!-- BLOG-LIST-START -->",  "<!-- BLOG-LIST-END -->"],
    ["<!-- BLOG_CARDS_START -->", "<!-- BLOG_CARDS_END -->"],
  ];

  let start = 0, end = html.length;
  for (const [s, e] of MARKER_PAIRS) {
    const si = html.indexOf(s);
    const ei = html.indexOf(e);
    if (si !== -1 && ei !== -1 && ei > si) { start = si + s.length; end = ei; break; }
  }

  const region = html.slice(start, end);
  const slugRe = new RegExp(escapeRegex(slug) + "(?![A-Za-z0-9_-])");

  const blocks = findArticleBlocks(region);
  const hit = blocks.find(b => slugRe.test(region.slice(b.from, b.to)));
  if (!hit) return { html, removed: false };

  // Swallow trailing whitespace so the index doesn't accumulate blank lines
  let to = hit.to;
  while (to < region.length && /\s/.test(region[to])) to++;

  const newRegion = region.slice(0, hit.from) + region.slice(to);
  return { html: html.slice(0, start) + newRegion + html.slice(end), removed: true };
}

// Find every top-level <article>…</article> span in a fragment, nesting-aware.
// Returns [{ from, to }] with `to` exclusive, in document order.
function findArticleBlocks(s) {
  const out = [];
  const openRe = /<article\b/gi;
  let m;
  while ((m = openRe.exec(s)) !== null) {
    const from = m.index;
    const tagRe = /<(\/?)article\b[^>]*>/gi;
    tagRe.lastIndex = from;
    let depth = 0, to = -1, t;
    while ((t = tagRe.exec(s)) !== null) {
      if (t[1] === "/") {
        depth--;
        if (depth <= 0) { to = t.index + t[0].length; break; }
      } else {
        depth++;
      }
    }
    if (to === -1) break;          // unbalanced markup — stop rather than guess
    out.push({ from, to });
    openRe.lastIndex = to;
  }
  return out;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- GitHub Contents API helpers ----

async function ghGetFile(gh, path, branch) {
  const r = await fetch(`${gh.api}/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`, {
    headers: gh.headers,
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function ghPutFile(gh, path, branch, message, contentB64, sha) {
  const payload = { message, content: contentB64, branch };
  if (sha) payload.sha = sha; // required to update an existing file
  const r = await fetch(`${gh.api}/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT",
    headers: { ...gh.headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${path} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

// DELETE requires the blob sha of the file being removed — same contract as PUT.
async function ghDeleteFile(gh, path, branch, message, sha) {
  if (!sha) throw new Error(`GitHub DELETE ${path}: missing sha.`);
  const r = await fetch(`${gh.api}/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "DELETE",
    headers: { ...gh.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch }),
  });
  if (!r.ok) throw new Error(`GitHub DELETE ${path} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

// =============================================================================
//  CARD INJECTION — ADAPTIVE (Plan A → B → C cascade)
// =============================================================================
// New cards go INSIDE the site's existing grid structure. This function never
// bulk-deletes content between the markers — the previous implementation used
// a greedy regex that swallowed real seed cards on every publish (Bug 2 fix).
//
// Strategy:
//   1. Extract the region between <!-- BLOG-LIST-START --> and <!-- BLOG-LIST-END -->
//   2. Build the new card via buildCardHtml() — cascades Plan A → B → C
//   3. If a real <article> already exists between markers, prepend the new card
//      just before it (newest first, inside whatever wrapper the site uses)
//   4. If no article exists, strip empty-state markup and insert the card at
//      the end of the region
// -----------------------------------------------------------------------------

function injectCard(indexHtml, p, profile, lang) {
  const startMark = "<!-- BLOG-LIST-START -->";
  const endMark   = "<!-- BLOG-LIST-END -->";
  const si = indexHtml.indexOf(startMark);
  const ei = indexHtml.indexOf(endMark);
  if (si === -1 || ei === -1 || ei < si) return indexHtml; // markers missing → leave untouched

  const before = indexHtml.slice(0, si + startMark.length);
  let   middle = indexHtml.slice(si + startMark.length, ei);
  const after  = indexHtml.slice(ei);

  const readMore = READ_MORE_LABELS[lang] || READ_MORE_LABELS.en;
  const cardHtml = buildCardHtml(p, profile, middle, readMore);

  // Does the region already contain a real card?
  const articleMatch = middle.match(/<article\b/i);

  if (articleMatch) {
    // Insert the new card just before the first existing article — this places
    // it inside whatever wrapper (<div class="post-grid">, etc.) contains the
    // existing cards, so it inherits the site's grid structure naturally.
    // Existing cards are preserved untouched — no bulk deletion.
    const insertPos = articleMatch.index;
    middle = middle.slice(0, insertPos) + cardHtml + "\n" + middle.slice(insertPos);
  } else {
    // No real cards yet — strip empty-state markup (an "empty-state" div, or a
    // <p>/<div> saying "no posts yet") and insert the card at the end.
    middle = middle.replace(/<div class="empty-state"[\s\S]*?<\/div>\s*/gi, "");
    middle = middle.replace(/<div[^>]*id=["']empty-state["'][^>]*>[\s\S]*?<\/div>\s*/gi, "");

    // Insert card. If there's a grid wrapper div waiting empty, insert inside
    // it; otherwise just append to the region.
    const wrapperMatch = middle.match(/(<div\b[^>]*class="[^"]*(?:post-grid|blog-grid|card-grid|grid)[^"]*"[^>]*>)([\s\S]*?)(<\/div>)\s*$/i);
    if (wrapperMatch) {
      middle = middle.replace(wrapperMatch[0], wrapperMatch[1] + wrapperMatch[2] + cardHtml + "\n" + wrapperMatch[3]);
    } else {
      middle = middle + "\n" + cardHtml + "\n";
    }
  }

  return before + middle + after;
}

// Build the card HTML — Plan A (profile config) → Plan B (sniff) → Plan C (default).
//
// Phase 2 change: URL is taken from p.url if provided (so translated cards can
// point at /blog/posts/{lang}/{slug}). Falls back to /blog/posts/{slug} for
// callers that don't set it — backward compatible with pre-Phase-2 code paths.
function buildCardHtml(p, profile, existingMiddle, readMore) {
  const vars = {
    URL:          p.url || `/blog/posts/${p.slug}`,
    HERO:         p.heroImg,
    TITLE:        p.title,
    DATE_ISO:     p.dateIso,
    DATE_DISPLAY: p.dateDisplay,
    EXCERPT:      p.excerpt,
    READ_MORE:    readMore,
  };

  // Plan A: tenant-configured template string
  const tpl = profile?.blog?.cardTemplate;
  if (tpl && typeof tpl === "string" && tpl.trim()) {
    return fillCardTemplate(tpl, vars);
  }

  // Plan B: sniff the first existing <article> in the region and clone its
  // structure, so ABB inherits whatever classes the site's CSS actually styles
  const sniffed = sniffCardTemplate(existingMiddle);
  if (sniffed) {
    return fillCardTemplate(sniffed, vars);
  }

  // Plan C: default matching the website-builder scaffold (.card / .blog-grid).
  // Uses generic .card / .card-img / .card-body / .card-link classes that
  // agnes-mortgage-style CSS knows about out of the box.
  return `
    <article class="card">
      <a href="${esc(vars.URL)}" class="card-img">
        <img src="${esc(vars.HERO)}" alt="${esc(vars.TITLE)}" loading="lazy">
      </a>
      <div class="card-body">
        <time datetime="${vars.DATE_ISO}">${esc(vars.DATE_DISPLAY)}</time>
        <h3><a href="${esc(vars.URL)}">${esc(vars.TITLE)}</a></h3>
        <p>${esc(vars.EXCERPT)}</p>
        <a href="${esc(vars.URL)}" class="card-link">${esc(vars.READ_MORE)}</a>
      </div>
    </article>`;
}

function fillCardTemplate(tpl, vars) {
  return tpl
    .replace(/\{\{URL\}\}/g,          esc(vars.URL))
    .replace(/\{\{HERO\}\}/g,         esc(vars.HERO))
    .replace(/\{\{TITLE\}\}/g,        esc(vars.TITLE))
    .replace(/\{\{DATE_ISO\}\}/g,     vars.DATE_ISO)
    .replace(/\{\{DATE_DISPLAY\}\}/g, esc(vars.DATE_DISPLAY))
    .replace(/\{\{EXCERPT\}\}/g,      esc(vars.EXCERPT))
    .replace(/\{\{READ_MORE\}\}/g,    esc(vars.READ_MORE));
}

// Sniff the first existing <article>...</article> block from the current
// blog index region and turn it into a template with {{URL}}, {{HERO}},
// {{TITLE}}, {{DATE_ISO}}, {{DATE_DISPLAY}}, {{EXCERPT}}, {{READ_MORE}}
// placeholders. Returns null if no article found (falls through to Plan C).
//
// This is intentionally regex-based rather than DOM-parsed — the input is a
// small, controlled HTML fragment written by ABB or a hand-authored seed, and
// keeping the sniff logic dependency-free means the function stays cheap
// enough to run on every publish without a real parser.
function sniffCardTemplate(middle) {
  const m = middle.match(/<article\b[\s\S]*?<\/article>/i);
  if (!m) return null;
  let html = m[0];

  // Replace all href="..." with {{URL}} (there are typically 2-3 links per card,
  // all pointing to the same post — anchor image, title link, read-more link)
  html = html.replace(/\bhref="[^"]*"/g, `href="{{URL}}"`);

  // Replace <img> src and alt
  html = html.replace(/<img\b[^>]*>/i, (imgTag) => {
    let out = imgTag;
    if (/\bsrc="/.test(out)) {
      out = out.replace(/\bsrc="[^"]*"/, `src="{{HERO}}"`);
    } else {
      out = out.replace(/<img\b/, `<img src="{{HERO}}"`);
    }
    if (/\balt="/.test(out)) {
      out = out.replace(/\balt="[^"]*"/, `alt="{{TITLE}}"`);
    } else {
      out = out.replace(/<img\b/, `<img alt="{{TITLE}}"`);
    }
    return out;
  });

  // Replace <time datetime="...">...</time>
  html = html.replace(
    /<time\b[^>]*>[\s\S]*?<\/time>/i,
    `<time datetime="{{DATE_ISO}}">{{DATE_DISPLAY}}</time>`
  );

  // Replace the title heading (first <h1>-<h4>) — if it wraps an <a>, keep
  // the anchor and just replace its text; otherwise replace the heading's text.
  html = html.replace(/<(h[1-4])\b([^>]*)>([\s\S]*?)<\/\1>/i, (full, tag, attrs, inner) => {
    if (/<a\b/i.test(inner)) {
      const newInner = inner.replace(/(<a\b[^>]*>)[\s\S]*?(<\/a>)/i, `$1{{TITLE}}$2`);
      return `<${tag}${attrs}>${newInner}</${tag}>`;
    }
    return `<${tag}${attrs}>{{TITLE}}</${tag}>`;
  });

  // Replace the FIRST <p> content with {{EXCERPT}} (the excerpt/summary)
  html = html.replace(/<p\b([^>]*)>[\s\S]*?<\/p>/i, `<p$1>{{EXCERPT}}</p>`);

  // Replace read-more link text. Try patterns in order of specificity:
  //   (a) an <a> with a class containing "link" or "read" or "more" (matches
  //       .card-link, .read-more, .post-link, etc.)
  //   (b) fallback: leave read-more text alone (Plan B keeps whatever text the
  //       existing card had — better than mangling an unusual pattern)
  const readMoreReplaced = html.replace(
    /(<a\b[^>]*class="[^"]*(?:card-link|read-more|read_more|readmore|post-link|more-link|blog-link)[^"]*"[^>]*>)[\s\S]*?(<\/a>)/gi,
    `$1{{READ_MORE}}$2`
  );
  if (readMoreReplaced !== html) {
    html = readMoreReplaced;
  }

  return html;
}

// =============================================================================
//  FAQ SECTION (Phase 5b)
// =============================================================================

function appendFaq(body, faqItems, lang) {
  if (!faqItems || !faqItems.length) return body;

  const heading = FAQ_HEADINGS[lang] || FAQ_HEADINGS.en;

  // Visible HTML
  let html = `\n<section class="faq-section">\n<h2>${esc(heading)}</h2>\n`;
  for (const item of faqItems) {
    html += `<div class="faq-item">\n<h3>${esc(item.question)}</h3>\n<p>${esc(item.answer)}</p>\n</div>\n`;
  }
  html += `</section>\n`;

  // FAQPage JSON-LD (Google/AI structured data)
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqItems.map(item => ({
      "@type": "Question",
      "name": item.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": item.answer,
      },
    })),
  };
  html += `<script type="application/ld+json">${JSON.stringify(faqLd)}</script>\n`;

  return body + html;
}

// =============================================================================
//  INTERNAL LINKING (Phase 5a)
// =============================================================================

async function addInternalLinks(body, history, currentTitle) {
  const pool = (history || []).filter(h => h.url && h.title && h.title !== currentTitle);
  if (pool.length < 3) return body; // not enough to link to yet
  if (!process.env.ANTHROPIC_API_KEY) return body;

  // Build the candidate list (cap at 40 most recent to keep prompt lean)
  const candidates = pool.slice(0, 40).map((h, i) => ({
    n: i + 1, title: h.title, url: h.url,
  }));

  const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

  const tool = {
    name: "suggest_links",
    description: "Suggest 2-3 internal links from the new article to prior posts.",
    input_schema: {
      type: "object",
      properties: {
        links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              anchorPhrase: { type: "string", description: "An EXACT phrase copied verbatim from the new article body that should become the link. Must appear word-for-word in the article." },
              linkToN:      { type: "integer", description: "The number (n) of the prior post to link to." },
            },
            required: ["anchorPhrase", "linkToN"],
          },
        },
      },
      required: ["links"],
    },
  };

  // Strip HTML tags to give Claude clean text (it still returns phrases that exist in body)
  const plainText = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
  const list = candidates.map(c => `${c.n}. ${c.title}`).join("\n");

  const system = `You add internal links between blog posts on the same website. You will receive a NEW article and a list of PRIOR posts. Choose 2-3 prior posts that are genuinely topically related to the new article. For each, pick a short exact phrase (2-5 words) from the new article that would make a natural, relevant anchor for a link to that prior post.

RULES:
- The anchorPhrase MUST appear word-for-word in the new article text.
- Choose phrases that are topically relevant to the post being linked (not random words).
- Do NOT link the title. Pick phrases from the body.
- Only suggest a link if it's genuinely helpful to the reader. 2-3 links max. Fewer is fine.
- Each phrase must be different and link to a different prior post.`;

  const userMsg = `NEW ARTICLE (plain text):
${plainText}

PRIOR POSTS (pick 2-3 relevant ones to link to):
${list}

Call suggest_links.`;

  let suggestions = [];
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1000, system,
        messages: [{ role: "user", content: userMsg }],
        tools: [tool], tool_choice: { type: "tool", name: "suggest_links" },
      }),
    });
    if (!r.ok) throw new Error(`Claude ${r.status}`);
    const d = await r.json();
    const block = (d.content || []).find(b => b.type === "tool_use");
    suggestions = (block && block.input && block.input.links) || [];
  } catch (e) {
    console.error("Internal link generation failed:", e.message);
    return body; // fail safe
  }

  // Apply the links
  let linked = 0;
  for (const s of suggestions) {
    if (linked >= 3) break;
    const cand = candidates.find(c => c.n === s.linkToN);
    if (!cand || !s.anchorPhrase) continue;
    const href = urlToPath(cand.url);
    const linkResult = linkPhrase(body, s.anchorPhrase, href);
    if (linkResult.linked) { body = linkResult.body; linked++; }
  }

  return body;
}

// Insert a link around the FIRST visible-text occurrence of `phrase`.
// Skips occurrences inside a tag or already inside an <a>.
function linkPhrase(body, phrase, href) {
  if (!phrase || !href) return { body, linked: false };
  const idx = body.indexOf(phrase);
  if (idx === -1) return { body, linked: false };

  const before = body.slice(0, idx);
  if (before.lastIndexOf("<") > before.lastIndexOf(">")) return { body, linked: false }; // inside a tag
  if (before.lastIndexOf("<a ") > before.lastIndexOf("</a>")) return { body, linked: false }; // inside a link

  const link = `<a href="${esc(href)}">${phrase}</a>`;
  return { body: body.slice(0, idx) + link + body.slice(idx + phrase.length), linked: true };
}

// Full URL (or domain/path) → path only. "emlektabla.net/blog/posts/x" → "/blog/posts/x"
function urlToPath(url) {
  try {
    const withProto = String(url).startsWith("http") ? String(url) : "https://" + url;
    return new URL(withProto).pathname;
  } catch { return url; }
}

// Inject inline images into the article body HTML.
function injectInlineImages(body, img1, img2, alt1, alt2) {
  const hasMarker1 = body.includes("{{INLINE_IMG_1}}");
  const hasMarker2 = body.includes("{{INLINE_IMG_2}}");

  const tag1 = img1 ? `<img src="${esc(img1)}" alt="${esc(alt1 || "")}" loading="lazy">` : "";
  const tag2 = img2 ? `<img src="${esc(img2)}" alt="${esc(alt2 || "")}" loading="lazy">` : "";

  if (hasMarker1 || hasMarker2) {
    body = body.replace("{{INLINE_IMG_1}}", tag1);
    body = body.replace("{{INLINE_IMG_2}}", tag2);
  } else {
    let h2count = 0;
    body = body.replace(/<\/h2>/gi, (match) => {
      h2count++;
      if (h2count === 1 && tag1) return match + "\n" + tag1;
      if (h2count === 2 && tag2) return match + "\n" + tag2;
      return match;
    });
    if (h2count < 2 && tag2) {
      let h3done = false;
      body = body.replace(/<\/h3>/i, (match) => {
        if (!h3done) { h3done = true; return match + "\n" + tag2; }
        return match;
      });
    }
  }
  return body;
}

// =============================================================================
//  TRACKING INJECTION (gtag + Consent Mode v2 + cookie banner)
// =============================================================================
// Injects Google tag + consent defaults into <head> and a language-aware cookie
// consent banner before </body>. Only used for github-static posts — WordPress
// themes handle their own <head>. The gtagId is per-tenant (variable), pulled
// from profile.tracking.gtagId. If the HTML already contains googletagmanager,
// injection is skipped (idempotent — won't conflict with site-level build
// scripts like build-sitemap.js that also inject gtag).
// -----------------------------------------------------------------------------

const COOKIE_BANNER_TEXT = {
  hu: { text: "Ez a weboldal sütiket használ a forgalom mérésére és a hirdetések optimalizálására.", accept: "Elfogadom", decline: "Elutasítom" },
  en: { text: "This website uses cookies to measure traffic and optimize ads.", accept: "Accept", decline: "Decline" },
  es: { text: "Este sitio web utiliza cookies para medir el tráfico y optimizar los anuncios.", accept: "Aceptar", decline: "Rechazar" },
  de: { text: "Diese Website verwendet Cookies zur Messung des Datenverkehrs und zur Optimierung von Anzeigen.", accept: "Akzeptieren", decline: "Ablehnen" },
  fr: { text: "Ce site utilise des cookies pour mesurer le trafic et optimiser les publicités.", accept: "Accepter", decline: "Refuser" },
  it: { text: "Questo sito utilizza cookie per misurare il traffico e ottimizzare gli annunci.", accept: "Accetta", decline: "Rifiuta" },
  pt: { text: "Este site utiliza cookies para medir o tráfego e otimizar anúncios.", accept: "Aceitar", decline: "Recusar" },
  nl: { text: "Deze website gebruikt cookies om verkeer te meten en advertenties te optimaliseren.", accept: "Accepteren", decline: "Weigeren" },
  pl: { text: "Ta strona używa plików cookie do mierzenia ruchu i optymalizacji reklam.", accept: "Akceptuję", decline: "Odrzucam" },
};

// =============================================================================
//  LANGUAGE MAPS — visible strings ABB writes into published HTML
// =============================================================================
// Bug 3 fix: read-more link text on blog index cards was hardcoded Hungarian
// ("Tovább olvasom"), and the FAQ section heading was hardcoded Hungarian
// ("Gyakran ismételt kérdések"). Now driven by profile.primaryLanguage
// with an English fallback (same pattern as REVIEWER_LABELS and COOKIE_BANNER_TEXT).

const READ_MORE_LABELS = {
  en: "Read more →",
  hu: "Tovább olvasom →",
  es: "Leer más →",
  de: "Weiterlesen →",
  fr: "Lire la suite →",
  it: "Continua a leggere →",
  pt: "Leia mais →",
  nl: "Lees meer →",
  pl: "Czytaj więcej →",
  sv: "Läs mer →",
  da: "Læs mere →",
  no: "Les mer →",
  fi: "Lue lisää →",
  ja: "続きを読む →",
  ko: "더 읽기 →",
  zh: "阅读更多 →",
  ar: "اقرأ المزيد ←",
  hi: "और पढ़ें →",
};

const FAQ_HEADINGS = {
  en: "Frequently asked questions",
  hu: "Gyakran ismételt kérdések",
  es: "Preguntas frecuentes",
  de: "Häufig gestellte Fragen",
  fr: "Questions fréquentes",
  it: "Domande frequenti",
  pt: "Perguntas frequentes",
  nl: "Veelgestelde vragen",
  pl: "Często zadawane pytania",
  sv: "Vanliga frågor",
  da: "Ofte stillede spørgsmål",
  no: "Ofte stilte spørsmål",
  fi: "Usein kysytyt kysymykset",
  ja: "よくある質問",
  ko: "자주 묻는 질문",
  zh: "常见问题",
  ar: "الأسئلة الشائعة",
  hi: "अक्सर पूछे जाने वाले प्रश्न",
};

function injectTracking(html, gtagId, lang) {
  // Sanitize — only allow alphanumeric, hyphen, underscore
  const safeId = String(gtagId).replace(/[^A-Za-z0-9\-_]/g, "");
  if (!safeId) return html;

  // Idempotent: skip if gtag is already present (e.g. from build-sitemap.js)
  if (html.includes("googletagmanager.com/gtag/js")) return html;

  const b = COOKIE_BANNER_TEXT[lang] || COOKIE_BANNER_TEXT.en;

  const headSnippet = [
    "<!-- Google tag (gtag.js) — injected by ABB -->",
    "<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}",
    "gtag('consent','default',{'ad_storage':'denied','ad_user_data':'denied','ad_personalization':'denied','analytics_storage':'denied'});</script>",
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${safeId}"></script>`,
    `<script>gtag('js',new Date());gtag('config','${safeId}');</script>`,
  ].join("\n");

  const bannerSnippet = [
    "<!-- Cookie consent banner — injected by ABB -->",
    '<div id="abb-cookie-banner" style="position:fixed;bottom:0;left:0;right:0;background:#1e293b;color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:14px;z-index:9999;font-family:system-ui,-apple-system,sans-serif">',
    `<p style="margin:0;flex:1">${b.text}</p>`,
    '<div style="display:flex;gap:8px;flex-shrink:0">',
    `<button onclick="abbGrant()" style="padding:8px 16px;border:0;border-radius:6px;background:#10b981;color:#fff;font-weight:600;cursor:pointer">${b.accept}</button>`,
    `<button onclick="abbDeny()" style="padding:8px 16px;border:0;border-radius:6px;background:#64748b;color:#fff;font-weight:600;cursor:pointer">${b.decline}</button>`,
    "</div></div>",
    "<script>",
    "function abbGrant(){gtag('consent','update',{'ad_storage':'granted','ad_user_data':'granted','ad_personalization':'granted','analytics_storage':'granted'});localStorage.setItem('cookie_consent','granted');document.getElementById('abb-cookie-banner').style.display='none'}",
    "function abbDeny(){localStorage.setItem('cookie_consent','denied');document.getElementById('abb-cookie-banner').style.display='none'}",
    "(function(){var c=localStorage.getItem('cookie_consent');if(c==='granted')abbGrant();else if(c==='denied')document.getElementById('abb-cookie-banner').style.display='none'})()",
    "</script>",
  ].join("\n");

  // Inject before </head> and before </body>
  if (html.includes("</head>")) {
    html = html.replace("</head>", headSnippet + "\n</head>");
  }
  if (html.includes("</body>")) {
    html = html.replace("</body>", bannerSnippet + "\n</body>");
  }
  return html;
}

// =============================================================================
//  E-E-A-T SCAFFOLDING (byline, reviewer, Article schema)
// =============================================================================
// Adds author credibility signals to github-static posts. Per-tenant author
// profile (name, title, bio, photo, optional reviewer) stored in
// profile.author. Byline goes at top of article content, reviewer line at
// bottom (before FAQ), Article + Person JSON-LD in <head>.
// -----------------------------------------------------------------------------

const REVIEWER_LABELS = {
  hu: "Szakértői ellenőrzés",
  en: "Reviewed by",
  es: "Revisado por",
  de: "Geprüft von",
  fr: "Révisé par",
  it: "Revisionato da",
  pt: "Revisado por",
  nl: "Beoordeeld door",
  pl: "Zweryfikowane przez",
};

function prependByline(body, author, dateDisplay) {
  if (!author || !author.name) return body;

  const photoHtml = author.photoUrl
    ? `<img src="${esc(author.photoUrl)}" alt="${esc(author.name)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0">`
    : "";

  const titleHtml = author.title
    ? `<span style="display:block;font-size:13px;color:#64748b">${esc(author.title)}</span>`
    : "";

  const byline = [
    '<div class="author-byline" style="display:flex;align-items:center;gap:14px;padding:16px 0;margin-bottom:20px;border-bottom:1px solid #e2e8f0;font-family:system-ui,-apple-system,sans-serif">',
    photoHtml,
    '<div>',
    `<strong style="font-size:15px">${esc(author.name)}</strong>`,
    titleHtml,
    `<span style="display:block;font-size:12px;color:#94a3b8">${esc(dateDisplay)}</span>`,
    '</div>',
    '</div>',
  ].join("\n");

  return byline + "\n" + body;
}

function appendReviewerLine(body, author, lang) {
  if (!author || !author.reviewerName) return body;
  const label = REVIEWER_LABELS[lang] || REVIEWER_LABELS.en;
  const titlePart = author.reviewerTitle ? `, ${esc(author.reviewerTitle)}` : "";
  const html = `\n<p class="reviewer-line" style="font-size:13px;color:#64748b;margin-top:28px;padding-top:14px;border-top:1px solid #e2e8f0;font-style:italic;font-family:system-ui,-apple-system,sans-serif">${esc(label)}: <strong>${esc(author.reviewerName)}</strong>${titlePart}</p>\n`;
  return body + html;
}

function injectAuthorSchema(html, author, articleTitle, dateIso, heroImg) {
  if (!author || !author.name) return html;

  const authorObj = {
    "@type": "Person",
    "name": author.name,
  };
  if (author.title) authorObj.jobTitle = author.title;
  if (author.bio) authorObj.description = author.bio;
  if (author.photoUrl) authorObj.image = author.photoUrl;

  const schema = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": articleTitle,
    "datePublished": dateIso,
    "author": authorObj,
  };
  if (heroImg) schema.image = heroImg;

  if (author.reviewerName) {
    const reviewerObj = { "@type": "Person", "name": author.reviewerName };
    if (author.reviewerTitle) reviewerObj.jobTitle = author.reviewerTitle;
    schema.reviewedBy = reviewerObj;
  }

  const snippet = `\n<!-- Article + Author schema — injected by ABB -->\n<script type="application/ld+json">${JSON.stringify(schema)}</script>\n`;
  if (html.includes("</head>")) {
    html = html.replace("</head>", snippet + "</head>");
  }
  return html;
}

// ---- Text/encoding utilities ----

function slugify(title) {
  const map = { á:"a",é:"e",í:"i",ó:"o",ö:"o",ő:"o",ú:"u",ü:"u",ű:"u",
                Á:"a",É:"e",Í:"i",Ó:"o",Ö:"o",Ő:"o",Ú:"u",Ü:"u",Ű:"u",
                ñ:"n",ç:"c",à:"a",è:"e",ì:"i",ò:"o",ù:"u" };
  return String(title)
    .toLowerCase()
    .replace(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰñçàèìòù]/g, ch => map[ch] || ch)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip any remaining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `post-${Date.now().toString(36)}`;
}

function formatDateHu(d, lang) {
  try {
    const locale = lang === "hu" ? "hu-HU" : (lang || "en");
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}

function b64encode(str) { return Buffer.from(str, "utf-8").toString("base64"); }
function b64decode(b64) { return Buffer.from(b64, "base64").toString("utf-8"); }

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function pexelsImageUrl(query) {
  const r = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`,
    { headers: { Authorization: process.env.PEXELS_API_KEY } }
  );
  if (!r.ok) throw new Error(`Pexels ${r.status}`);
  const data = await r.json();
  const photos = data.photos || [];
  if (!photos.length) throw new Error("No Pexels images for: " + query);
  const photo = photos[Math.floor(Math.random() * photos.length)];
  return photo.src?.large2x || photo.src?.large || photo.src?.original || "";
}

// ---------------------------------------------------------------------------
//  Pexels → download → upload to WP Media Library
// ---------------------------------------------------------------------------
async function uploadHeroImage(wpBase, wpHeaders, query, altText) {
  const pexRes = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`,
    { headers: { Authorization: process.env.PEXELS_API_KEY } }
  );
  if (!pexRes.ok) throw new Error(`Pexels ${pexRes.status}`);
  const pexData = await pexRes.json();
  const photos = pexData.photos || [];
  if (!photos.length) throw new Error("No Pexels images found for: " + query);

  const photo = photos[Math.floor(Math.random() * photos.length)];
  const imgUrl = photo.src?.large2x || photo.src?.large || photo.src?.original;
  if (!imgUrl) throw new Error("No usable image URL");

  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

  const filename = `abb-hero-${Date.now()}.jpg`;
  const uploadRes = await fetch(`${wpBase}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      ...wpHeaders,
      "Content-Type": "image/jpeg",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
    body: imgBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`WP media upload failed: ${uploadRes.status} ${(await uploadRes.text()).slice(0, 200)}`);
  }

  const media = await uploadRes.json();

  if (media.id && altText) {
    await fetch(`${wpBase}/wp-json/wp/v2/media/${media.id}`, {
      method: "POST",
      headers: { ...wpHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: altText.slice(0, 125) }),
    }).catch(() => {}); // non-critical
  }

  return media.id;
}

// ---------------------------------------------------------------------------
//  Find existing WP category by name, or create it
// ---------------------------------------------------------------------------
async function findOrCreateCategory(wpBase, wpHeaders, categoryName) {
  const searchRes = await fetch(
    `${wpBase}/wp-json/wp/v2/categories?search=${encodeURIComponent(categoryName)}&per_page=5`,
    { headers: wpHeaders }
  );
  if (searchRes.ok) {
    const cats = await searchRes.json();
    const match = cats.find(c =>
      c.name.toLowerCase() === categoryName.toLowerCase() ||
      c.slug === categoryName.toLowerCase().replace(/\s+/g, "-")
    );
    if (match) return match.id;
  }

  const createRes = await fetch(`${wpBase}/wp-json/wp/v2/categories`, {
    method: "POST",
    headers: { ...wpHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ name: categoryName }),
  });
  if (createRes.ok) {
    const created = await createRes.json();
    return created.id;
  }
  return null;
}
