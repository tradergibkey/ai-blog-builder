// =============================================================================
//  AI BLOG BUILDER  —  api/app/generate.js   (PHASE 2 — piece 2)
// -----------------------------------------------------------------------------
//  Tenant-aware content generator. Reads the tenant profile (voice, language,
//  categories, audience, niche) and generates an article via Claude.
//
//  Returns structured JSON — does NOT publish. publish.js handles that.
//
//  POST /api/app/generate  { id: "elsyfx.net", topic: "...", category: "..." }
//
//  Returns: { ok, article: { title, body, excerpt, metaDescription, imageQuery, language } }
//
//  AUTH: x-app-secret (operator only)
//  ENV:  ABB_APP_SECRET, ANTHROPIC_API_KEY
// =============================================================================

import { getProfile } from "./_profile.js";

export const config = { maxDuration: 120 };

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!process.env.ABB_APP_SECRET || req.headers["x-app-secret"] !== process.env.ABB_APP_SECRET) {
    return res.status(401).json({ error: "Unauthorised." });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const id       = (body.id || "").trim();
  const topic    = (body.topic || "").trim();
  const category = (body.category || "").trim();

  if (!id)    return res.status(400).json({ error: "Missing tenant 'id'." });
  if (!topic) return res.status(400).json({ error: "Missing 'topic'." });

  try {
    // ---- 1) Load the tenant profile ----
    const profile = await getProfile(id);
    if (!profile) return res.status(404).json({ error: `Tenant "${id}" not found.` });

    const lang      = profile.primaryLanguage || "en";
    const langName  = LANG_NAMES[lang] || "English";
    const voice     = profile.voice || "Professional and helpful.";
    const audience  = profile.audience || "general readers";
    const niche     = profile.niche || "";
    const siteName  = profile.siteName || "the blog";
    const cats      = (profile.categories || []).join(", ") || "general";

    // ---- 2) Build the Claude prompt ----
    const system = `You are an expert blog content writer for "${siteName}".

AUDIENCE: ${audience}
NICHE: ${niche}
LANGUAGE: Write the ENTIRE article in ${langName}.

WRITING VOICE & TONE:
${voice}

CONTENT RULES:
- Write a complete, publish-ready blog article on the given topic.
- The article should be 800-1200 words, well-structured with H2 and H3 subheadings.
- Use HTML formatting for the body (h2, h3, p, ul, li, strong, em — NO h1, that's the title).
- Include practical, actionable advice. No fluff or filler.
- Write from the perspective of ${siteName}, as if the business is the author.
- Do NOT include any header/footer, navigation, CSS, or page wrapper — just the article body HTML.
- Do NOT start with "In this article" or "In today's post" — start with a compelling opening.

AI CITATION OPTIMIZATION:
- Start the article with a clear, factual definition or summary paragraph (1-3 sentences) that directly answers the topic as a question. This is what AI search engines (ChatGPT, Perplexity, Google AI) quote in their answers.
- Throughout the article, use concrete, quotable statements rather than vague generalities. Specific numbers, comparisons, and direct answers perform best.
- End with a concise "Összefoglalás" (Summary) or "Legfontosabb tudnivalók" (Key takeaways) section — 3-5 bullet points summarizing the article's main advice in clear, self-contained sentences.

SEO RULES:
- The title should be SEO-friendly (the kind of thing someone would type into Google).
- Include a meta description (150-160 chars, compelling, includes the main keyword).
- The excerpt should be 1-2 sentences summarizing the article.

FAQ:
- Generate 3-5 frequently asked questions (and their answers) related to the article topic.
- Questions should be what real people would type into Google or ask a voice assistant — natural, specific, practical.
- Answers should be 2-3 sentences each: direct, factual, self-contained (each answer should make sense on its own without reading the article).
- Write both questions and answers in ${langName}.

IMAGE:
- Suggest THREE Pexels search queries (2-4 words each) for relevant, professional photos:
  1. heroImageQuery: for the hero/banner image at the top — should represent the article's main topic visually.
  2. inlineImageQuery1: for an image placed after the first major section — should match THAT section's specific subject.
  3. inlineImageQuery2: for an image placed after the second major section — should match THAT section's specific subject.
- IMPORTANT: Each query should be specific and visual (e.g. "polished black granite surface", "white marble veins closeup", "stone engraving workshop"). Avoid generic queries like "memorial" or "plaque" — search for the MATERIAL, TEXTURE, PROCESS, or SETTING described in that section.
- All three queries must be meaningfully different from each other.
- Place the literal marker {{INLINE_IMG_1}} in the body HTML after the first major H2 section ends (before the next H2).
- Place the literal marker {{INLINE_IMG_2}} in the body HTML after the second major H2 section ends (before the next H2).
- Do NOT wrap these markers in any HTML tag — just place them on their own line between sections.

Call the write_article tool with your complete article.`;

    const tool = {
      name: "write_article",
      description: "Submit the complete generated article.",
      input_schema: {
        type: "object",
        properties: {
          title:           { type: "string", description: "SEO-friendly article title" },
          body:            { type: "string", description: "Full article body in HTML (h2, h3, p, ul, li — no h1). Must include {{INLINE_IMG_1}} after the first H2 section and {{INLINE_IMG_2}} after the second H2 section." },
          excerpt:         { type: "string", description: "1-2 sentence summary" },
          metaDescription: { type: "string", description: "SEO meta description, 150-160 chars" },
          heroImageQuery:      { type: "string", description: "Pexels search query for the hero banner image, 2-4 words, specific to the article topic" },
          inlineImageQuery1:   { type: "string", description: "Pexels search query for inline image after section 1, 2-4 words, specific to that section" },
          inlineImageQuery2:   { type: "string", description: "Pexels search query for inline image after section 2, 2-4 words, specific to that section" },
          faq: {
            type: "array",
            description: "3-5 FAQ items related to the article topic",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "A natural question someone would ask" },
                answer:   { type: "string", description: "Direct 2-3 sentence answer" },
              },
              required: ["question", "answer"],
            },
          },
        },
        required: ["title", "body", "excerpt", "metaDescription", "heroImageQuery", "inlineImageQuery1", "inlineImageQuery2", "faq"],
      },
    };

    const userMsg = `Write a blog article on this topic:

TOPIC: ${topic}
${category ? `CATEGORY: ${category}` : ""}

Write the complete article in ${langName}. Make it practical, engaging, and SEO-optimized.`;

    // ---- 3) Call Claude ----
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
        tools: [tool],
        tool_choice: { type: "tool", name: "write_article" },
      }),
    });

    if (!claudeRes.ok) {
      throw new Error(`Claude API ${claudeRes.status}: ${(await claudeRes.text()).slice(0, 300)}`);
    }

    const claudeData = await claudeRes.json();
    const block = (claudeData.content || []).find(b => b.type === "tool_use");
    if (!block || !block.input) throw new Error("Claude returned no article.");

    const article = block.input;
    article.language = lang;
    article.category = category;
    article.topic = topic;

    // Backward compat: old WP publish path reads article.imageQuery
    // New schema uses heroImageQuery / inlineImageQuery1 / inlineImageQuery2
    if (article.heroImageQuery && !article.imageQuery) {
      article.imageQuery = article.heroImageQuery;
    }
    // If Claude used the old field name (shouldn't, but defensive)
    if (article.imageQuery && !article.heroImageQuery) {
      article.heroImageQuery = article.imageQuery;
    }

    return res.status(200).json({ ok: true, id, article });

  } catch (err) {
    console.error("generate error:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}

const LANG_NAMES = {
  en: "English", es: "Spanish", de: "German", fr: "French", it: "Italian",
  pt: "Portuguese", nl: "Dutch", hu: "Hungarian", pl: "Polish", sv: "Swedish",
  da: "Danish", no: "Norwegian", fi: "Finnish", ja: "Japanese", ko: "Korean",
  zh: "Chinese", ar: "Arabic", hi: "Hindi",
};
