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

/** Max length of the customer-facing amount summary (keeps messages tidy). */
const AMOUNT_SUMMARY_MAX = 120;

/**
 * Custom customer-facing amount, `project_template.riepilogo_importo` (e.g.
 * "€540 al mese per 12 mesi"), or null when not set. It exists because the raw
 * total can include parts billed by a partner or be a 12-month sum, and
 * "un totale di €6.478" then misrepresents what the customer pays.
 */
export function quoteCustomAmountSummary(projectTemplate: unknown): string | null {
  let pt: unknown = projectTemplate;
  if (typeof pt === 'string') {
    try { pt = JSON.parse(pt); } catch { pt = null; }
  }
  const custom = pt && typeof pt === 'object' ? (pt as Record<string, unknown>).riepilogo_importo : undefined;
  if (typeof custom !== 'string') return null;
  const clean = decodeEntities(custom).replace(/\s+/g, ' ').trim().slice(0, AMOUNT_SUMMARY_MAX);
  return clean || null;
}

/** Amount for send messages: the custom summary, else the formatted total. */
export function quoteAmountSummary(quote: { total?: unknown; project_template?: unknown }): string {
  const custom = quoteCustomAmountSummary(quote.project_template);
  if (custom) return custom;
  return `€${formatEuroAmount(parseFloat(String(quote.total ?? '0')) || 0)}`;
}

/**
 * "6478" → "6.478", "149.5" → "149,5", "1234.56" → "1.234,56". Hand-rolled:
 * Intl it-IT skips the thousands separator below 10.000 (CLDR min grouping
 * digits = 2), so "€6478" would read differently from "€12.500".
 */
export function formatEuroAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const [int, dec] = Math.abs(rounded).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimals = dec === '00' ? '' : `,${dec.replace(/0$/, '')}`;
  return `${rounded < 0 ? '-' : ''}${grouped}${decimals}`;
}
