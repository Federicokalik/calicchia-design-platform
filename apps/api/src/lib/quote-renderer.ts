/**
 * Quote HTML Renderer — server-side wrapper.
 *
 * The actual template lives in @calicchia/shared (quote-template.ts) and is
 * shared 1:1 with the admin live preview. This wrapper only adds the
 * Node-specific parts: Funnel fonts inlined as data-URI @font-face (so the
 * Puppeteer page needs no network access) and the document reference number
 * derived from the row id.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  renderQuoteHtml as renderSharedQuoteHtml,
  type QuoteTemplateInput,
  type QuoteTemplateSettings,
} from '@calicchia/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = resolve(__dirname, '../../assets/fonts');

const LATIN_RANGE = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT_RANGE = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';

const FONT_FILES: Array<{ file: string; family: string; style: string; range: string }> = [
  { file: 'funnel-display-latin.woff2', family: 'Funnel Display', style: 'normal', range: LATIN_RANGE },
  { file: 'funnel-display-latin-ext.woff2', family: 'Funnel Display', style: 'normal', range: LATIN_EXT_RANGE },
  { file: 'funnel-sans-normal-latin.woff2', family: 'Funnel Sans', style: 'normal', range: LATIN_RANGE },
  { file: 'funnel-sans-normal-latin-ext.woff2', family: 'Funnel Sans', style: 'normal', range: LATIN_EXT_RANGE },
  { file: 'funnel-sans-italic-latin.woff2', family: 'Funnel Sans', style: 'italic', range: LATIN_RANGE },
  { file: 'funnel-sans-italic-latin-ext.woff2', family: 'Funnel Sans', style: 'italic', range: LATIN_EXT_RANGE },
];

let cachedFontFaceCss: string | null = null;

/** Inline the Funnel variable fonts as data URIs (cached per process). */
function getFontFaceCss(): string {
  if (cachedFontFaceCss !== null) return cachedFontFaceCss;
  const blocks: string[] = [];
  for (const f of FONT_FILES) {
    try {
      const b64 = readFileSync(resolve(FONTS_DIR, f.file)).toString('base64');
      blocks.push(`@font-face { font-family: '${f.family}'; font-style: ${f.style}; font-weight: 300 800; font-display: swap; src: url("data:font/woff2;base64,${b64}") format('woff2'); unicode-range: ${f.range}; }`);
    } catch {
      // Missing font file → fall back to the system stack declared in the template.
    }
  }
  cachedFontFaceCss = blocks.join('\n');
  return cachedFontFaceCss;
}

export interface QuoteData extends QuoteTemplateInput {
  id?: string;
}

export type QuoteSettings = QuoteTemplateSettings;

/** Document reference, e.g. "2026-A1B2C3" — stable per quote. */
function deriveNumero(quote: QuoteData): string {
  const year = quote.created_at ? new Date(quote.created_at).getFullYear() : new Date().getFullYear();
  const short = (quote.id || '').replace(/-/g, '').slice(0, 6).toUpperCase();
  return short ? `${year}-${short}` : '';
}

export function renderQuoteHtml(quote: QuoteData, settings: QuoteSettings = {}): string {
  return renderSharedQuoteHtml(quote, settings, {
    fontFaceCss: getFontFaceCss(),
    numero: deriveNumero(quote),
  });
}

const MESI_IT = ['', 'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function formatDateIt(d?: string | null): string {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getDate()} ${MESI_IT[dt.getMonth() + 1]} ${dt.getFullYear()}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Inject the FEA signature into a hand-crafted quote document via its
 * placeholder elements:
 *   <div data-sign="cliente"></div>     → signature image + name + date
 *   <div data-sign="vessatorie"></div>  → specific-approval line
 * Placeholders are optional — without them the document prints unchanged and
 * the signature lives in the audit trail / sign page only.
 */
export function injectSignatureIntoCustomHtml(
  html: string,
  quote: {
    signer_name?: string | null;
    signed_at?: string | null;
    signature_image?: string | null;
    vessatorie_approved_at?: string | null;
  },
): string {
  if (!quote.signed_at) return html;

  const img = typeof quote.signature_image === 'string'
    && /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(quote.signature_image)
    ? `<img src="${quote.signature_image}" alt="Firma" style="height:18mm;display:block;margin-bottom:2mm;">`
    : '';
  const sigBlock = `${img}<div style="font-size:9pt;">${escHtml(quote.signer_name || '')}</div><div style="font-size:8pt;letter-spacing:0.1em;text-transform:uppercase;color:#F57F44;">✓ Firmato digitalmente (FEA) il ${formatDateIt(quote.signed_at)}</div>`;

  let out = html.replace(/(<[^>]+data-sign="cliente"[^>]*>)/i, `$1${sigBlock}`);

  if (quote.vessatorie_approved_at) {
    const vexLine = `<div style="font-size:8pt;letter-spacing:0.12em;text-transform:uppercase;color:#F57F44;">✓ Approvate specificamente con firma digitale il ${formatDateIt(quote.vessatorie_approved_at)}</div>`;
    out = out.replace(/(<[^>]+data-sign="vessatorie"[^>]*>)/i, `$1${vexLine}`);
  }
  return out;
}
