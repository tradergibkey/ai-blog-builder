// =============================================================================
//  AI BLOG BUILDER  —  api/app/publish.js   (PHASE 2 — piece 3)
// -----------------------------------------------------------------------------
//  WordPress publisher. Takes a tenant ID and either:
//    a) a pre-generated article (from generate.js), or
//    b) a topic (generates + publishes in one call)
//
//  Flow:
//    1. Read tenant profile (for draft/publish setting)
//    2. Decrypt WP credentials
//    3. Optionally fetch hero image from Pexels and upload to WP media library
//    4. Create the post via WP REST API
//    5. Log to tenant history
//
//  POST /api/app/publish  { id, topic, category }          → generate + publish
//  POST /api/app/publish  { id, article: { title, body, excerpt, ... } } → publish only
//
//  AUTH: x-app-secret (operator only)
//  ENV:  ABB_APP_SECRET, ANTHROPIC_API_KEY, PEXELS_API_KEY (optional)
// =============================================================================

import { getProfile } from "./_profile.js";
import { getSecret } from "./_secrets.js";
import { addHistory, getHistory } from "./_store.js";

export const config = { maxDuration: 180 };

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
        console.warn(`[${body.id}] WP image shortage: ${wpImgCount}/3 images.`, wpImgWarnings.join("; "));
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

    // ---- 5) Log to tenant history ----
    await addHistory(id, {
      wpPostId:     post.id,
      title:        article.title,
      url:          post.link || `${base}/?p=${post.id}`,
      status:       publishAs,
      category:     article.category || null,
      language:     article.language || profile.primaryLanguage || "en",
      topic:        article.topic || "",
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
      },
    });

  } catch (err) {
    console.error("publish error:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}

// =============================================================================
//  GITHUB-STATIC PUBLISHER
// -----------------------------------------------------------------------------
//  For tenants whose site is a static repo (HTML/CSS/JS on GitHub → Vercel).
//  Publishing = committing files:
//    1. Generate the article (reuse generate.js) if not supplied
//    2. Pick a Pexels hero image URL (hotlinked — no media library)
//    3. Read blog/post-template.html from the repo, fill placeholders
//    4. Commit the filled post to blog/posts/<slug>.html
//    5. Read blog/index.html, inject a card between the BLOG-LIST markers,
//       drop the empty-state placeholder, commit it back
//    6. Log to tenant history
//
//  Credentials (from _secrets): github_repo ("owner/name"), github_branch,
//  github_token (PAT with Contents: read+write on that repo).
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

  // ---- 3) Build slug + dates ----
  const slug = slugify(article.title);
  const now  = new Date();
  const dateIso     = now.toISOString();
  const dateDisplay = formatDateHu(now, profile.primaryLanguage || "hu");

  // ---- 4) Read the post template from the repo ----
  const templatePath = "blog/post-template.html";
  const templateFile = await ghGetFile(gh, templatePath, branch);
  if (!templateFile) {
    return res.status(400).json({ error: `Could not read ${templatePath} from ${repo}. Check the repo has the ABB blog structure.` });
  }
  const template = b64decode(templateFile.content);

  // Strip the leading HTML comment block (the <!-- BLOG POST TEMPLATE ... --> note)
  const cleanTemplate = template.replace(/<!--[\s\S]*?-->\s*/, "");

  const postHtml = cleanTemplate
    .replace(/\{\{TITLE\}\}/g,        esc(article.title))
    .replace(/\{\{DESCRIPTION\}\}/g,  esc(article.metaDescription || article.excerpt || ""))
    .replace(/\{\{SLUG\}\}/g,         slug)
    .replace(/\{\{DATE_ISO\}\}/g,     dateIso)
    .replace(/\{\{DATE_DISPLAY\}\}/g, esc(dateDisplay))
    .replace(/\{\{HERO_IMG\}\}/g,     esc(heroImg))
    .replace(/\{\{CONTENT\}\}/g,      articleBody); // body with inline images injected

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
      });
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

  // ---- 7) Log to tenant history ----
  const postUrl = `${(profile.siteUrl || "").replace(/\/+$/, "")}/blog/posts/${slug}`;
  await addHistory(id, {
    title:        article.title,
    url:          postUrl,
    status:       "publish",       // a commit is live — no draft concept
    category:     article.category || null,
    language:     article.language || profile.primaryLanguage || "hu",
    topic:        article.topic || "",
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

// Inject a post card between <!-- BLOG-LIST-START --> and <!-- BLOG-LIST-END -->,
// removing the empty-state block if present. Newest card goes first.
// Card HTML matches the site's existing .post-card / .post-body CSS classes.
function injectCard(indexHtml, p) {
  const startMark = "<!-- BLOG-LIST-START -->";
  const endMark   = "<!-- BLOG-LIST-END -->";
  const si = indexHtml.indexOf(startMark);
  const ei = indexHtml.indexOf(endMark);
  if (si === -1 || ei === -1 || ei < si) return indexHtml; // markers missing → leave untouched

  const before = indexHtml.slice(0, si + startMark.length);
  let   middle = indexHtml.slice(si + startMark.length, ei);
  const after  = indexHtml.slice(ei);

  // Drop the placeholder grid/empty-state on first real post
  middle = middle.replace(/<div class="post-grid"[^>]*id="post-grid"[^>]*>[\s\S]*?<\/div>\s*(?=<!-- BLOG-LIST-END)/, "");
  // If an empty-state remains for any reason, strip it
  middle = middle.replace(/<div class="empty-state"[\s\S]*?<\/div>\s*/g, "");

  const card = `
    <article class="post-card">
      <a href="/blog/posts/${p.slug}">
        <img src="${esc(p.heroImg)}" alt="${esc(p.title)}" class="post-card-img" loading="lazy">
      </a>
      <div class="post-body">
        <time datetime="${p.dateIso}">${esc(p.dateDisplay)}</time>
        <h3><a href="/blog/posts/${p.slug}">${esc(p.title)}</a></h3>
        <p>${esc(p.excerpt)}</p>
        <a href="/blog/posts/${p.slug}" class="card-link">Tovább olvasom →</a>
      </div>
    </article>`;

  // Ensure there's a grid wrapper to hold cards; if none, create one.
  if (/id="post-grid"/.test(middle)) {
    middle = middle.replace(/(<div class="post-grid"[^>]*id="post-grid"[^>]*>)/, `$1${card}`);
  } else if (/<div class="post-grid"/.test(middle)) {
    middle = middle.replace(/(<div class="post-grid"[^>]*>)/, `$1${card}`);
  } else {
    middle = `\n    <div class="post-grid" id="post-grid">${card}\n    </div>\n    `;
  }

  return before + middle + after;
}

// =============================================================================
//  INTERNAL LINKING (Phase 5a)
// -----------------------------------------------------------------------------
//  Given a new article body + the tenant's publish history, ask Claude to pick
//  2-3 genuinely relevant prior posts and the exact phrases in THIS article to
//  hyperlink to them. Insert those links. Never blocks publish on failure.
//  Gated by profile.authority.enabled and history.length >= 3 (checked by caller
//  for enabled; this function checks the count).
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
    const res = linkPhrase(body, s.anchorPhrase, href);
    if (res.linked) { body = res.body; linked++; }
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
// Strategy: if Claude placed {{INLINE_IMG_1/2}} markers, replace them.
// Fallback: if markers are missing, inject after the 1st and 2nd </h2> closings.
// If no image URL is available for a slot, the marker is simply removed (no broken img).
function injectInlineImages(body, img1, img2, alt1, alt2) {
  const hasMarker1 = body.includes("{{INLINE_IMG_1}}");
  const hasMarker2 = body.includes("{{INLINE_IMG_2}}");

  const tag1 = img1 ? `<img src="${esc(img1)}" alt="${esc(alt1 || "")}" loading="lazy">` : "";
  const tag2 = img2 ? `<img src="${esc(img2)}" alt="${esc(alt2 || "")}" loading="lazy">` : "";

  if (hasMarker1 || hasMarker2) {
    // Claude placed markers — use them
    body = body.replace("{{INLINE_IMG_1}}", tag1);
    body = body.replace("{{INLINE_IMG_2}}", tag2);
  } else {
    // Fallback: inject after 1st and 2nd </h2>
    let h2count = 0;
    body = body.replace(/<\/h2>/gi, (match) => {
      h2count++;
      if (h2count === 1 && tag1) return match + "\n" + tag1;
      if (h2count === 2 && tag2) return match + "\n" + tag2;
      return match;
    });
    // If only 1 H2 existed and we have tag2, try after 1st </h3>
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
  // 1) Search Pexels
  const pexRes = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`,
    { headers: { Authorization: process.env.PEXELS_API_KEY } }
  );
  if (!pexRes.ok) throw new Error(`Pexels ${pexRes.status}`);
  const pexData = await pexRes.json();

  const photos = pexData.photos || [];
  if (!photos.length) throw new Error("No Pexels images found for: " + query);

  // Pick a random image from top 5 for variety
  const photo = photos[Math.floor(Math.random() * photos.length)];
  const imgUrl = photo.src?.large2x || photo.src?.large || photo.src?.original;
  if (!imgUrl) throw new Error("No usable image URL");

  // 2) Download the image
  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

  // 3) Upload to WordPress media library
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

  // 4) Set alt text
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
  // Search existing
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

  // Create new
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
