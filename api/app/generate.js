# Patch for `api/app/generate.js` — inject `serviceLinks` into the LLM prompt

## What this does

Adds support for the new `serviceLinks` profile field so the LLM knows which
service pages exist, when each is topically appropriate, and that exactly one
should be linked from each article. Existing `LINKED_PATHS` (prior posts)
logic is left completely alone — service links live in their own approved
block, separate from post-to-post interlinking.

## Three edits — apply in order

Open `api/app/generate.js` on GitHub, click the pencil icon to edit. Do
these three find-and-replaces in order.

---

### EDIT 1 — extract the new field

**Find** (in the profile-loading block near the top of the handler):

```js
const cats      = (profile.categories || []).join(", ") || "general";
```

**Replace with**:

```js
const cats      = (profile.categories || []).join(", ") || "general";
const serviceLinks = Array.isArray(profile.serviceLinks) ? profile.serviceLinks : [];
```

---

### EDIT 2 — build the APPROVED SERVICE LINKS prompt block

**Find** (the line that builds the LINKED_PATHS block string — search for
`LINKED_PATHS` and locate the line where the block header is composed):

```js
const linkedBlock = linkedPaths.length
```

**Replace with** (adds a parallel `serviceBlock` builder just above, then
keeps `linkedBlock` exactly as it was):

```js
const serviceBlock = serviceLinks.length
  ? `\n\nAPPROVED SERVICE LINKS (link to exactly ONE, in the body where it's topically natural):\n${
      serviceLinks.map(s => `- ${s.path} — "${s.title}" — use when: ${s.when}`).join("\n")
    }\n\nSERVICE LINK RULES:\n- Include exactly ONE link from the list above per article, and only if a topical fit exists.\n- Choose the entry whose "use when" best matches the article's actual subject — do not force a link into an off-topic article.\n- Place it inline in the body where it flows naturally (usually in the section discussing that specialism), not in the intro or the closing block.\n- Use natural, descriptive anchor text ("specialist expat mortgage broker", "buy-to-let finance") — never paste the URL as anchor text, never use "click here" or "learn more".\n- This link is IN ADDITION TO any LINKED_PATHS post links below — do not confuse the two.`
  : "";
const linkedBlock = linkedPaths.length
```

---

### EDIT 3 — inject `serviceBlock` into the system prompt

**Find** (the line in the system prompt template where `linkedBlock` is
inserted — search for `${linkedBlock}`):

```js
${linkedBlock}
```

**Replace with**:

```js
${serviceBlock}
${linkedBlock}
```

Only the first occurrence — there's only one in the file.

---

## Verify after commit

1. Vercel redeploys automatically (~30s). Wait for it to finish.
2. Trigger a test publish for Agnes (dashboard force-publish, or wait for
   next cron). Read the resulting post.
3. Check three things:
   - Does the article naturally reference £500 fee / whole-of-market /
     multilingual / WhatsApp *only when the topic warrants it*?
     (Not every post — a post on 'How the Bank of England base rate
     affects fixed mortgages' probably shouldn't mention Agnes's fee;
     a post on 'Should you use a broker or apply direct?' definitely
     should.)
   - Is there exactly one contextual link to a service page in the body,
     with descriptive anchor text?
   - Does the article end with a natural 'Working with Agnes Mortgage'
     (or topical equivalent) closing paragraph linking to `/#contact`?
4. If any of these misfire, iterate the `voice` field in the profile —
   no more code changes needed. The voice rules are prose the LLM
   follows; tighten or loosen wording there.

## What this doesn't do

- Does not touch `LINKED_PATHS` (post-to-post interlinking) — that keeps
  working exactly as before.
- Does not add a new UI toggle in the dashboard — `serviceLinks` is
  edited through the profile update path (DevTools snippet or Upstash
  Data Browser), same as any other profile field.
- Does not affect other tenants — emlektabla, campoverde etc. have no
  `serviceLinks` on their profiles, so the block simply doesn't render
  for them and their prompts are unchanged.

## Rollback

If output looks worse instead of better, revert both files (profile JSON
and generate.js) in one step. Zero downstream dependencies — nothing
else in ABB reads `serviceLinks`.
