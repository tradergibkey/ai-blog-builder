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
//
//  AUTH: x-app-secret (operator only)
//  ENV:  ABB_APP_SECRET, ANTHROPIC_API_KEY, PEXELS_API_KEY (optional)
// =============================================================================
import { getProfile } from "./_profile.js";
import { getSecret } from "./_secrets.js";
import { addHistory, getHistory, getStr, setStr } from "./_store.js";
import { checkDuplicate, recordPost } from "../../lib/similarity-guard.js";
export const config = { maxDuration: 180 };
// KV wrappers for similarity-guard (strip "abb:" prefix — _store adds its own)
const kvGet = (k) => getStr(k.startsWith("abb:") ? k.slice(4) : k);
const kvSet = (k, v) => setStr(k.startsWith("abb:") ? k.slice(4) : k, v);
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
//  GITHUB-STATIC PUBLISHER
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
  let heroImg = "";
  let inlineImg1 = "";
  let inlineImg2 = "";
  const imgWarnings = [];
  const heroQuery   = article.heroImageQuery || article.imageQuery || "";
  const inlQ1       = article.inlineImageQuery1 || "";
  const inlQ2       = article.inlineImageQuery2 || "";
  if (process.env.PEXELS_API_KEY) {
    // Hero
    if (heroQuery) {
      try { heroImg = await pexelsImageUrl(heroQuery); }
      catch (e) { imgWarnings.push("hero: " + e.message); }
    }
    // Inline 1
    if (inlQ1) {
      try { inlineImg1 = await pexelsImageUrl(inlQ1); }
      catch (e) { imgWarnings.push("inline1: " + e.message); }
    }
    // Inline 2
    if (inlQ2) {
      try { inlineImg2 = await pexelsImageUrl(inlQ2); }
      catch (e) { imgWarnings.push("inline2: " + e.message); }
    }
    // De-dupe: skip inline if same URL as hero
    if (inlineImg1 && inlineImg1 === heroImg) { inlineImg1 = ""; imgWarnings.push("inline1 de-duped (same as hero)"); }
    if (inlineImg2 && inlineImg2 === heroImg) { inlineImg2 = ""; imgWarnings.push("inline2 de-duped (same as hero)"); }
    if (inlineImg2 && inlineImg2 === inlineImg1) { inlineImg2 = ""; imgWarnings.push("inline2 de-duped (same as inline1)"); }
  }
  // Fallback hero
  if (!heroImg) heroImg = `${(profile.siteUrl || "").replace(/\/+$/, "")}/img/og-cover.jpg`;
  // Log shortages
  const imgCount = 1 + (inlineImg1 ? 1 : 0) + (inlineImg2 ? 1 : 0);
  if (imgCount < 3) {
    console.warn(`[${id}] Image shortage: ${imgCount}/3 images found.`, imgWarnings.join("; "));
  }
  // Inject inline images into article body
  let articleBody = article.body || "";
  articleBody = injectInlineImages(articleBody, inlineImg1, inlineImg2, inlQ1, inlQ2);
  // Internal links (Phase 5a) — opt-in via profile.authority.enabled, needs history
  if (profile.authority?.enabled) {
    try {
      const history = await getHistory(id);
      articleBody = await addInternalLinks(articleBody, history, article.title);
    } catch (e) {
      console.error(`[${id}] Internal linking failed (continuing):`, e.message);
    }
  }
  // Resolve language once — used by byline, reviewer, FAQ, and index card
  const lang = article.language || profile.primaryLanguage || "en";
  // E-E-A-T: reviewer line (before FAQ, at end of article body)
  if (profile.author?.reviewerName) {
    articleBody = appendReviewerLine(articleBody, profile.author, lang);
  }
  // FAQ section (Phase 5b) — visible HTML + FAQPage JSON-LD for AI citations
  if (article.faq && article.faq.length) {
    articleBody = appendFaq(articleBody, article.faq, lang);
  }
  // ---- 3) Build slug + dates (must come before byline injection — byline uses dateDisplay) ----
  const slug = slugify(article.title);
  const now  = new Date();
  const dateIso     = now.toISOString();
  const dateDisplay = formatDateHu(now, lang);
  // E-E-A-T: byline block (prepended to top of article content)
  if (profile.author?.name) {
    articleBody = prependByline(articleBody, profile.author, dateDisplay);
  }
  // ---- 4) Read the post template from the repo ----
  const templatePath = "blog/post-template.html";
  const templateFile = await ghGetFile(gh, templatePath, branch);
  if (!templateFile) {
    return res.status(400).json({ error: `Could not read ${templatePath} from ${repo}. Check the repo has the ABB blog structure.` });
  }
  const template = b64decode(templateFile.content);
  // Strip the leading HTML comment block (the <!-- BLOG POST TEMPLATE ... --> note)
  const cleanTemplate = template.replace(/<!--[\s\S]*?-->\s*/, "");
  // ---- TOKEN FILL — dual-emit for hero/body aliases, plus {{TAG}} support.
  //      Templates from different site scaffolds use different token names;
  //      ABB fills every recognized variant with the same value so any naming
  //      convention works. Anything left unrecognized is stripped by the final
  //      sweep so no {{...}} literal ever leaks into a live post. ----
  let postHtml = cleanTemplate
    .replace(/\{\{TITLE\}\}/g,        esc(article.title))
    .replace(/\{\{DESCRIPTION\}\}/g,  esc(article.metaDescription || article.excerpt || ""))
    .replace(/\{\{SLUG\}\}/g,         slug)
    .replace(/\{\{DATE_ISO\}\}/g,     dateIso)
    .replace(/\{\{DATE_DISPLAY\}\}/g, esc(dateDisplay))
    .replace(/\{\{HERO_IMG\}\}/g,     esc(heroImg))
    .replace(/\{\{COVER_IMAGE\}\}/g,  esc(heroImg))                         // alias for HERO_IMG
    .replace(/\{\{CONTENT\}\}/g,      articleBody)
    .replace(/\{\{BODY_HTML\}\}/g,    articleBody)                          // alias for CONTENT
    .replace(/\{\{TAG\}\}/g,          esc(article.category || ""));
  // Safety sweep: strip any unrecognized {{TOKEN}} so it doesn't render as
  // literal text (this was Bug 1 — {{TAG}}/{{COVER_IMAGE}}/{{BODY_HTML}}
  // leaking through into a live post on the Agnes Mortgage first publish).
  postHtml = postHtml.replace(/\{\{[A-Z_][A-Z0-9_]*\}\}/g, "");
  // ---- 4b) Tracking injection (gtag + consent + cookie banner) ----
  const gtagId = profile.tracking?.gtagId || "";
  if (gtagId) {
    postHtml = injectTracking(postHtml, gtagId, lang);
  }
  // ---- 4c) E-E-A-T Article+Author schema injection has been REMOVED.
  //          Emlektabla's template already emits its own BlogPosting JSON-LD
  //          for the article, and Google prefers one schema block per page.
  //          The visible byline (see prependByline above) still carries the
  //          author signal; FAQPage JSON-LD is still added by appendFaq.
  //          If a future tenant has NO built-in Article schema in its template,
  //          re-enable by uncommenting:
  //   if (profile.author?.name) {
  //     postHtml = injectAuthorSchema(postHtml, profile.author, article.title, dateIso, heroImg);
  //   }
  // ---- 5) Commit the post file ----
  const postPath = `blog/posts/${slug}.html`;
  const existingPost = await ghGetFile(gh, postPath, branch); // may already exist → update
  await ghPutFile(gh, postPath, branch,
    `Add blog post: ${article.title}`,
    b64encode(postHtml),
    existingPost?.sha
  );
  // ---- 6) Inject a card into blog/index.html ----
  let cardInjected = false;
  try {
    const indexPath = "blog/index.html";
    const indexFile = await ghGetFile(gh, indexPath, branch);
    if (indexFile) {
      const indexHtml = b64decode(indexFile.content);
      const updated = injectCard(indexHtml, {
        slug, title: article.title,
        excerpt: article.excerpt || article.metaDescription || "",
        heroImg, dateIso, dateDisplay,
      }, profile, lang);
      if (updated && updated !== indexHtml) {
        await ghPutFile(gh, indexPath, branch,
          `Add "${article.title}" to blog index`,
          b64encode(updated),
          indexFile.sha
        );
        cardInjected = true;
      }
    }
  } catch (e) {
    console.error("Index card injection failed (post still committed):", e.message);
  }
  // ── SIMILARITY GUARD: record this post's fingerprint for future checks ──
  if (dupCheck.draftShingles && dupCheck.draftShingles.length) {
    await recordPost({
      tenant: id, postId: slug, draftShingles: dupCheck.draftShingles, kvGet, kvSet,
    }).catch(e => console.error(`[${id}] Shingle record failed (non-critical):`, e.message));
  }
  // ---- 7) Log to tenant history ----
  const postUrl = `${(profile.siteUrl || "").replace(/\/+$/, "")}/blog/posts/${slug}`;
  await addHistory(id, {
    title:        article.title,
    url:          postUrl,
    status:       "publish",       // a commit is live — no draft concept
    category:     article.category || null,
    language:     lang,
    topic:        article.topic || "",
    archetype:    article.archetype || null,
    published_at: dateIso,
  });
  return res.status(200).json({
    ok: true, id,
    post: {
      title:  article.title,
      url:    postUrl,
      status: "publish",
      slug,
      featuredImage: !!heroImg,
      indexUpdated: cardInjected,
      archetype: article.archetype || null,
    },
  });
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
function buildCardHtml(p, profile, existingMiddle, readMore) {
  const vars = {
    URL:          `/blog/posts/${p.slug}`,
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
