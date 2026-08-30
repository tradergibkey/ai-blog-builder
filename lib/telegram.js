// =============================================================================
//  AI BLOG BUILDER  —  lib/telegram.js
// -----------------------------------------------------------------------------
//  Tiny helper for sending Telegram alerts. Used by cron.js to notify the
//  operator (Gabriel) when a publish permanently fails or the cron itself
//  throws, so multi-day silent outages like the 2026-08-29→30 generate.js
//  patch-doc-into-file breakage don't happen again.
//
//  ENV VARS (both required — absence is a silent no-op, never an error):
//    TELEGRAM_BOT_TOKEN   Token from @BotFather
//    TELEGRAM_CHAT_ID     Your personal chat id (from getUpdates)
//
//  DESIGN:
//    • Silent-fail on missing env vars — the absence of Telegram config
//      MUST NOT break publishing under any circumstance.
//    • 5-second AbortController timeout — Telegram outages don't hang cron.
//    • try/catch swallows every error, logs only. `notify()` never throws.
//    • Plain text (no parse_mode) so topic titles and error strings don't
//      need escaping and can't produce a 400 from a rogue underscore.
//    • Message truncated to 4000 chars (Telegram's cap is 4096).
// =============================================================================

export async function notify(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // Not configured → silent no-op. This is intentional: if the env vars are
  // ever unset (rotation in progress, forgot to add to a new environment),
  // publishing continues, we just lose the alert.
  if (!token || !chatId) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text == null ? "" : text).slice(0, 4000),
        disable_web_page_preview: true,
        // no parse_mode → plain text, nothing to escape
      }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("[telegram] non-2xx:", r.status, body.slice(0, 200));
    }
  } catch (err) {
    // Timeouts and network errors land here. Log and move on — cron must
    // never fail because Telegram was slow or unreachable.
    console.error("[telegram] send error:", (err && err.message) || err);
  } finally {
    clearTimeout(timer);
  }
}
