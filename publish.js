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
import { addHistory } from "./_store.js";

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

    // ---- 4) Create the post ----
    const publishAs = profile.integration?.defaults?.publishAs || "draft";

    const postPayload = {
      title:   article.title,
      content: article.body,
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
