import mjml2html from 'mjml';

/**
 * MJML → HTML+text compiler con cache LRU per-source.
 *
 * Per il nostro volume (~20 email/ora) la cache hit-rate è bassa (ogni render
 * ha contenuto dinamico diverso), ma rende il template-author rapido. Niente
 * dipendenze extra: html-to-text fatto inline.
 */

interface CompileResult {
  html: string;
  text: string;
}

const cache = new Map<string, CompileResult>();
const MAX_CACHE = 50;

function htmlToPlainText(html: string): string {
  return html
    // <br> and block tags become newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|section|article|header|footer)>/gi, '\n')
    // links: keep visible label + URL in parens (only if href is real)
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href, label) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      if (!cleanLabel || cleanLabel === href) return href;
      return `${cleanLabel} (${href})`;
    })
    // strip remaining tags
    .replace(/<[^>]+>/g, '')
    // decode common entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    // collapse whitespace
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n')
    .trim();
}

export async function compileMjml(mjmlSource: string): Promise<CompileResult> {
  const cached = cache.get(mjmlSource);
  if (cached) return cached;

  const { html, errors } = await mjml2html(mjmlSource, {
    validationLevel: 'soft',
    minify: true,
  });

  if (errors && errors.length > 0) {
    // Log but don't throw — degrade gracefully
    console.warn(
      '[mjml] compile warnings:',
      errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('; ')
    );
  }

  const result: CompileResult = {
    html,
    text: htmlToPlainText(html),
  };

  // Naive LRU: trim to MAX_CACHE
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(mjmlSource, result);
  return result;
}

/** HTML-escape user-provided strings before embedding in MJML. */
export function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
