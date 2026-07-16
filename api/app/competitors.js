// =============================================================================
//  AI BLOG BUILDER  —  api/app/competitors.js  (PHASE 1)
// -----------------------------------------------------------------------------
//  "Find my competitors" — uses Claude + web search to discover ~10 real
//  competitor websites based on the tenant's niche, audience, and location.
//
//  POST /api/app/competitors  { niche, audience, siteUrl, primaryLanguage }
//  Returns: { ok, competitors: [ { url, name, reason } ] }
//
//  AUTH:  x-app-secret (skipped when ABB_OPEN_MODE=true)
//  ENV:   ABB_APP_SECRET, ANTHROPIC_API_KEY
// =============================================================================

export const config = { maxDuration: 120 };

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  if (process.env.ABB_OPEN_MODE !== "true") {
    if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
      return res.status(401).json({ error: "Unauthorised." });
    }
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const niche    = (body.niche    || "").trim();
  const audience = (body.audience || "").trim();
  const siteUrl  = (body.siteUrl  || "").trim();
  const lang     = (body.primaryLanguage || "en").trim();

  if (!niche && !audience) {
    return res.status(400).json({ error: "Provide at least niche or audience." });
  }

  try {
    const system = `You are a competitive analyst for AI Blog Builder. Your job is to find real competitor websites for a business.

The user will tell you their niche, audience, and website. Use web search to find 10 real competitors — actual businesses or content sites that compete for the same audience and keywords.

RULES:
- Search the web to find REAL, currently-active websites. Do not make up URLs.
- Focus on direct competitors (same service/product in the same market) and content competitors (blogs/sites ranking for the same topics).
- Include a mix: some direct business competitors, some content/blog competitors.
- Exclude the user's own site.
- For each competitor, provide the homepage URL, business name, and a one-line reason why they're a competitor.

Call the report_competitors tool with your findings.`;

    const tool = {
      name: "report_competitors",
      description: "Report the list of discovered competitors.",
      input_schema: {
        type: "object",
        properties: {
          competitors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url:    { type: "string", description: "Homepage URL" },
                name:   { type: "string", description: "Business/site name" },
                reason: { type: "string", description: "Why they're a competitor (1 line)" },
              },
              required: ["url", "name", "reason"],
            },
          },
        },
        required: ["competitors"],
      },
    };

    const userMsg = `Find 10 competitors for this business:

Website: ${siteUrl || "(not provided)"}
Niche: ${niche}
Target audience: ${audience}
Primary language: ${lang}

Search the web and find 10 real competitor websites. Include both direct competitors and content competitors who rank for similar topics.`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: userMsg }],
        tools: [
          tool,
          { type: "web_search_20250305", name: "web_search" },
        ],
      }),
    });

    if (!claudeRes.ok) {
      throw new Error(`Claude API ${claudeRes.status}: ${(await claudeRes.text()).slice(0, 300)}`);
    }

    const claudeData = await claudeRes.json();

    // Find the tool_use block for report_competitors
    const block = (claudeData.content || []).find(
      b => b.type === "tool_use" && b.name === "report_competitors"
    );

    if (!block || !block.input || !Array.isArray(block.input.competitors)) {
      // Fallback: Claude may not have called the tool (e.g. web search took
      // all the turns). Return whatever text it produced as context.
      const textParts = (claudeData.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
      throw new Error("Could not extract structured competitors. Claude said: " + textParts.slice(0, 500));
    }

    // Sanitize — strip the user's own site, ensure URLs look real
    const own = extractDomain(siteUrl);
    const competitors = block.input.competitors
      .filter(c => c.url && c.name && extractDomain(c.url) !== own)
      .map(c => ({
        url:    c.url.trim(),
        name:   c.name.trim(),
        reason: (c.reason || "").trim(),
      }))
      .slice(0, 12);

    return res.status(200).json({ ok: true, competitors });

  } catch (err) {
    console.error("competitors error:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}

function extractDomain(url) {
  try {
    return new URL(url.startsWith("http") ? url : "https://" + url).hostname.replace(/^www\./, "");
  } catch { return ""; }
}
