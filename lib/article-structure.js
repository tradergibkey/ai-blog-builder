// article-structure.js
// -----------------------------------------------------------------------------
// Structural variety for ABB. Instead of writing every article off one skeleton
// (the near-duplicate-templating signal Google flags at the site level), each
// post is generated against a different structural ARCHETYPE, and the picker
// avoids repeating the archetypes used most recently for the same tenant.
//
// This module is a plain library (no Vercel function, no network). Your existing
// generator imports it, calls pickArchetype() to choose a skeleton, then feeds
// buildOutlineDirective() into the writing prompt.
//
// ESM. If your repo is CommonJS, change the two `export` keywords to
// `module.exports = { ... }` at the bottom.
// -----------------------------------------------------------------------------

/**
 * Each archetype defines a genuinely different article shape:
 *  - sections:  ordered blueprint the writer must follow (varied count + kind)
 *  - words:     [min, max] target length band (varied per archetype)
 *  - intro:     rotating opening style so first paragraphs don't rhyme
 *  - outro:     rotating closing style
 *  - headingStyle: guidance so H2 phrasing differs between archetypes
 */
export const ARCHETYPES = {
  deep_dive: {
    label: 'Deep dive',
    words: [1400, 2200],
    sections: [
      'plain-language definition (1 short para, quotable)',
      'why it matters right now',
      'how it actually works — 3 to 5 H2 subsections',
      'common mistakes / misconceptions',
      'a worked example or mini case',
      'key takeaways (3-5 bullets)',
    ],
    intro: 'Open with the single most important fact, then a one-line promise of what the reader will know by the end.',
    outro: 'Close with a short "what to do next" paragraph — no summary restatement.',
    headingStyle: 'Descriptive noun-phrase headings ("How liquidity sweeps form").',
  },

  listicle: {
    label: 'Ranked / grouped list',
    words: [1100, 1700],
    sections: [
      'short framing intro (why this list, who it is for)',
      '5 to 9 numbered items — each with a 2-3 sentence explanation and a concrete detail',
      'a "how we chose / how to pick" note',
      'one-line closing recommendation',
    ],
    intro: 'Open with the reader\'s problem in one sentence, then state how many options solve it.',
    outro: 'End by naming the best pick for the most common situation.',
    headingStyle: 'Numbered item headings ("3. <thing> — <benefit>").',
  },

  comparison: {
    label: 'Head-to-head comparison',
    words: [1200, 1800],
    sections: [
      'the two (or three) things being compared, in one line each',
      'a criteria list the comparison will use',
      'side-by-side on each criterion — one H2 per criterion',
      'who should choose which',
      'verdict',
    ],
    intro: 'Open by naming the decision the reader is stuck on.',
    outro: 'Give a clear "pick X if…, pick Y if…" verdict, not a fence-sit.',
    headingStyle: 'Criterion headings ("Price", "Ease of use", "Support").',
  },

  how_to: {
    label: 'Step-by-step how-to',
    words: [900, 1500],
    sections: [
      'what the reader will achieve + what they need first',
      'numbered steps — one H2 per step, imperative voice',
      'a troubleshooting / "if it goes wrong" section',
      'a short verification step ("you\'ll know it worked when…")',
    ],
    intro: 'Open with the end result, then the time/skill required.',
    outro: 'Close on the verification cue, not a recap.',
    headingStyle: 'Imperative step headings ("Step 2: Connect the drive").',
  },

  qa: {
    label: 'Question cluster',
    words: [1000, 1600],
    sections: [
      'a 1-para orientation to the topic',
      '6 to 10 real questions as H2s, each answered in 2-4 sentences',
      'a "still unsure?" pointer to the most useful next question',
    ],
    intro: 'Open by acknowledging the confusion the topic creates.',
    outro: 'Point to the one question most people get wrong.',
    headingStyle: 'Literal question headings ("Does X void the warranty?").',
  },

  case_study: {
    label: 'Case / story',
    words: [1000, 1600],
    sections: [
      'the situation (real specifics — job, client type, symptom)',
      'what was tried and why',
      'what happened — with a concrete result or number',
      'the general lesson the reader can apply',
    ],
    intro: 'Open in the middle of the specific situation, not with generalities.',
    outro: 'Generalise the lesson in the last paragraph only.',
    headingStyle: 'Narrative-phase headings ("The diagnosis", "The fix").',
  },

  opinion: {
    label: 'Take / argument',
    words: [800, 1300],
    sections: [
      'a clear stated position in the first two sentences',
      'the reasoning — 2 to 4 supporting points as H2s',
      'the strongest counter-argument, answered honestly',
      'a restated position that accounts for the nuance',
    ],
    intro: 'State the opinion outright — no throat-clearing.',
    outro: 'Restate the position, now qualified by the counter-argument.',
    headingStyle: 'Assertive headings ("Cheap PSUs cost more").',
  },
};

export const ARCHETYPE_KEYS = Object.keys(ARCHETYPES);

/**
 * Pick an archetype for the next post, avoiding the recently-used ones for this
 * tenant so consecutive posts don't share a skeleton.
 *
 * @param {object}   opts
 * @param {string[]} opts.recentKeys   archetype keys used for this tenant's last N posts (newest first)
 * @param {number}   [opts.avoidWindow=3]  how many recent archetypes to avoid repeating
 * @param {string[]} [opts.allow]       restrict to a subset (e.g. tenant config); defaults to all
 * @param {() => number} [opts.rng=Math.random]  injectable RNG for testing
 * @returns {{ key: string, archetype: object }}
 */
export function pickArchetype({ recentKeys = [], avoidWindow = 3, allow = ARCHETYPE_KEYS, rng = Math.random } = {}) {
  const pool = allow.filter((k) => ARCHETYPES[k]);
  if (pool.length === 0) throw new Error('article-structure: no valid archetypes in allow-list');

  const avoid = new Set(recentKeys.slice(0, avoidWindow));
  let candidates = pool.filter((k) => !avoid.has(k));

  // If we've avoided everything (small pool / long history), fall back to the
  // least-recently-used instead of blocking.
  if (candidates.length === 0) {
    const lru = [...pool].sort(
      (a, b) => indexOrInfinity(recentKeys, a) - indexOrInfinity(recentKeys, b),
    );
    candidates = [lru[lru.length - 1]];
  }

  const key = candidates[Math.floor(rng() * candidates.length)];
  return { key, archetype: ARCHETYPES[key] };
}

function indexOrInfinity(arr, v) {
  const i = arr.indexOf(v);
  return i === -1 ? Infinity : i;
}

/**
 * Turn a chosen archetype into an instruction block for the writing prompt.
 * Keep this OUT of the system prompt and inside the user turn so it varies per post.
 *
 * @param {object} archetype  from pickArchetype()
 * @param {string} topic
 * @returns {string}
 */
export function buildOutlineDirective(archetype, topic) {
  const [minW, maxW] = archetype.words;
  return [
    `Write this article in the "${archetype.label}" structure.`,
    `Target length: ${minW}–${maxW} words.`,
    `Intro: ${archetype.intro}`,
    `Heading style: ${archetype.headingStyle}`,
    `Follow this section blueprint in order:`,
    ...archetype.sections.map((s, i) => `  ${i + 1}. ${s}`),
    `Outro: ${archetype.outro}`,
    `Do not reuse sentence templates from other posts. Vary opening words.`,
    topic ? `Topic: ${topic}` : '',
  ].filter(Boolean).join('\n');
}

/** Short signature for logging which skeleton a post used. */
export function structuralSignature(key) {
  const a = ARCHETYPES[key];
  return a ? `${key}(${a.sections.length}s,${a.words[0]}-${a.words[1]}w)` : `unknown(${key})`;
}
