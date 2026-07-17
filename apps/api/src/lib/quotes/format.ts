/**
 * Shared quote formatting/URL helpers — used by the send pipeline
 * (lib/quotes/send.ts), the public sign flow (routes/quote-public.ts) and the
 * client portal (routes/portal/quotes.ts). Single source of truth so the
 * customer sees the same title and the same sign link on every channel.
 */

/**
 * Public quote-sign page URL. The page is the admin SPA's unauthenticated
 * /firma/:token route — NOT /preventivo/:token, which falls into the SPA
 * catch-all redirect and lands the customer on the login page.
 * QUOTE_PUBLIC_URL overrides the full prefix (everything before the token)
 * if the page ever moves.
 */
export function quoteSignUrl(signatureToken: string): string {
  const base =
    process.env.QUOTE_PUBLIC_URL?.replace(/\/$/, '') ||
    `${(process.env.ADMIN_URL || 'http://localhost:5173').replace(/\/$/, '')}/firma`;
  return `${base}/${signatureToken}`;
}

/**
 * Quote titles can arrive HTML-escaped from Markdown/LLM imports ("A &amp; B").
 * Decode once for plain-text channels; HTML contexts re-escape explicitly.
 * `&amp;` is decoded LAST so double-escaped input can't smuggle markup in.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Customer-facing title. Titles follow the "Preventivo <cliente> — <numero>"
 * convention; messages that already say "il preventivo …" use this to avoid
 * "il preventivo Preventivo Taxi…".
 */
export function quoteDisplayTitle(title: unknown): string {
  return decodeEntities(String(title || '')).replace(/^preventivo\s+/i, '');
}
