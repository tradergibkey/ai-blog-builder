// =============================================================================
//  AI BLOG BUILDER  —  api/app/analyze.js  v2  (PHASE 1)
// -----------------------------------------------------------------------------
//  "Let AI fill this form" — the magic button.
//
//  v2: bigger text budget (8000), strips nav/footer/sidebar, extracts CSS
//  colors for brand detection, sanitizes all output.
//
//  AUTH:  x-app-secret (skipped when ABB_OPEN_MODE=true)
//  ENV:   ABB_APP_SECRET, ANTHROPIC_API_KEY
// =============================================================================

export const config = { maxDuration: 60 };

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  if (process.env.ABB_OPEN_MODE !== "true") {
    if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
      return res.status(401).json({ error: "Unauthorised." });
    }
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  let url = (body.url || "").trim();
  if (!url) return res.status(400).json({ error: "Missing 'url'." });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  try {
    const siteRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AIBlogBuilder/2.0; +https://aiblogbuilder.com)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!siteRes.ok) throw new Error(`Could not reach ${url} — HTTP ${siteRes.status}`);
    const html = await siteRes.text();

    const text   = extractMainContent(html, 8000);
    const meta   = extractMeta(html);
    const colors = extractColors(html);

    const system = `You are a website analyst for AI Blog Builder. Given website content and metadata, extract structured business information.

RULES:
- Be specific and grounded — only state what you can see or reasonably infer.
- For every field, provide your best answer. Never leave fields empty — make a reasonable inference if needed.
- brandColor: use the CSS colors provided, theme-color, or dominant design color. Return valid #rrggbb.
- voice: describe the actual writing tone on the site in 1-2 sentences.
- categories: suggest 4-5 content categories this business should blog about.
- blogUrlPattern: look for /blog, /news, /articles. Return pattern with {slug} or empty if not found.
- audience: be specific (location, demographics, interests).

Call the analyze_site tool.`;

    const tool = {
      name: "analyze_site",
      description: "Return structured website analysis.",
      input_schema: {
        type: "object",
        properties: {
          siteName:          { type: "string", description: "Business or site name" },
          description:       { type: "string", description: "What the business does, 1-2 sentences" },
          audience:          { type: "string", description: "Specific target audience" },
          niche:             { type: "string", description: "Industry/niche for content strategy" },
          brandColor:        { type: "string", description: "Hex color #rrggbb" },
          voice:             { type: "string", description: "Writing tone, 1-2 sentences" },
          categories:        { type: "array", items: { type: "string" }, description: "4-5 blog categories" },
          blogUrlPattern:    { type: "string", description: "Blog URL pattern with {slug} or empty" },
          primaryLanguage:   { type: "string", description: "Primary language code" },
          detectedBilingual: { type: "boolean", description: "Whether the site is multilingual" },
          secondaryLanguage: { type: "string", description: "Secondary language code if bilingual, else empty" },
        },
        required: ["siteName", "description", "audience", "niche", "brandColor", "voice", "categories"],
      },
    };

    const userMsg = `Analyze this website: ${url}

META:
Title: ${meta.title || "(none)"}
Description: ${meta.description || "(none)"}
Theme color: ${meta.themeColor || "(none)"}
Language: ${meta.lang || "(none)"}
OG Site Name: ${meta.ogSiteName || "(none)"}

CSS COLORS FOUND: ${colors.length ? colors.join(", ") : "(none)"}

MAIN CONTENT (${text.length} chars):
${text}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2000, system,
        messages: [{ role: "user", content: userMsg }],
        tools: [tool],
        tool_choice: { type: "tool", name: "analyze_site" },
      }),
    });

    if (!claudeRes.ok) {
      throw new Error(`Claude API ${claudeRes.status}: ${(await claudeRes.text()).slice(0, 300)}`);
    }

    const claudeData = await claudeRes.json();
    const block = (claudeData.content || []).find(b => b.type === "tool_use");
    if (!block || !block.input) throw new Error("Claude returned no analysis.");

    const a = block.input;
    if (!/^#[0-9a-fA-F]{6}$/.test(a.brandColor || "")) a.brandColor = "#2563eb";
    if (!Array.isArray(a.categories)) a.categories = [];
    a.categories = a.categories.filter(c => typeof c === "string" && c.trim()).map(c => c.trim());

    return res.status(200).json({ ok: true, analysis: a, url });

  } catch (err) {
    console.error("analyze error:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}

function extractMainContent(html, maxChars) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");

  const mainMatch = h.match(/<main[\s\S]*?<\/main>/i) || h.match(/<article[\s\S]*?<\/article>/i);
  const focused = mainMatch ? mainMatch[0] : h;

  let text = focused.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();

  if (text.length < 200) {
    text = h.replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, " ").trim();
  }
  return text.slice(0, maxChars);
}

function extractMeta(html) {
  const get = (p) => { const m = html.match(p); return m ? m[1].trim() : ""; };
  return {
    title:       get(/<title[^>]*>([\s\S]*?)<\/title>/i),
    description: get(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i),
    themeColor:  get(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']*)["']/i),
    lang:        get(/<html[^>]*lang=["']([^"']*)["']/i),
    ogSiteName:  get(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i),
  };
}

function extractColors(html) {
  const s = new Set();
  const m = html.match(/#[0-9a-fA-F]{3,8}(?=[;\s"',)}])/g) || [];
  for (const c of m) {
    const n = c.length === 4 ? "#"+c[1]+c[1]+c[2]+c[2]+c[3]+c[3] : c.slice(0,7);
    if (/^#[0-9a-fA-F]{6}$/.test(n)) {
      const r=parseInt(n.slice(1,3),16), g=parseInt(n.slice(3,5),16), b=parseInt(n.slice(5,7),16);
      if (!(Math.abs(r-g)<20 && Math.abs(g-b)<20) && !(r>230&&g>230&&b>230) && !(r<25&&g<25&&b<25))
        s.add(n.toLowerCase());
    }
  }
  const tc = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']*)["']/i);
  if (tc && /^#[0-9a-fA-F]{6}$/.test(tc[1])) s.add(tc[1].toLowerCase());
  return [...s].slice(0, 15);
}
