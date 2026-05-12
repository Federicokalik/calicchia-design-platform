import { SITE } from '@/data/site';
import { LOCALES, localizedPath, type Locale, DEFAULT_LOCALE } from '@/lib/i18n';

const BASE = SITE.url.replace(/\/$/, '');

/**
 * Build an absolute canonical URL.
 * - DEFAULT locale ('it') is rendered without prefix.
 * - Trailing slash policy: matches SITE.url policy (no trailing slash unless root).
 *
 * Examples:
 *   buildCanonical('/zone/ceccano')       -> "https://calicchia.design/zone/ceccano"
 *   buildCanonical('/zone/ceccano', 'en') -> "https://calicchia.design/en/zone/ceccano"
 *   buildCanonical('/')                   -> "https://calicchia.design/"
 */
export function buildCanonical(path: string, locale: Locale = DEFAULT_LOCALE): string {
  const localized = localizedPath(path, locale);
  if (localized === '/' || localized === `/${locale}`) {
    return `${BASE}${localized}`.replace(/\/+$/, '/') || `${BASE}/`;
  }
  return `${BASE}${localized}`;
}

/**
 * Builds `Metadata.alternates` for a multi-locale page.
 *
 * - `canonical` is the absolute URL of the CURRENT locale render.
 * - `languages` emits one `<link rel="alternate" hreflang>` per locale + an
 *   `x-default` pointing at the IT canonical (Google's recommendation when no
 *   region-neutral fallback is available).
 *
 * Use ONLY for pages that have parity in both IT and EN. For IT-only or
 * EN-only pages, set `alternates.canonical` directly with the absolute URL
 * and omit `languages` (signals to Google that no other locale variant
 * exists, prevents duplicate-content flagging).
 *
 * @param canonicalIt The IT canonical path (e.g. `/perche-scegliere-me`,
 *   `/lavori/foo`). The function translates segments for EN automatically
 *   via `localizedPath`.
 *
 * Example:
 *   buildI18nAlternates('/perche-scegliere-me', 'en') ->
 *   {
 *     canonical: 'https://calicchia.design/en/why-choose-me',
 *     languages: {
 *       it: 'https://calicchia.design/perche-scegliere-me',
 *       en: 'https://calicchia.design/en/why-choose-me',
 *       'x-default': 'https://calicchia.design/perche-scegliere-me',
 *     }
 *   }
 */
export function buildI18nAlternates(
  canonicalIt: string,
  locale: Locale = DEFAULT_LOCALE,
): { canonical: string; languages: Record<string, string> } {
  const languages: Record<string, string> = {};
  for (const l of LOCALES) {
    languages[l] = buildCanonical(canonicalIt, l as Locale);
  }
  languages['x-default'] = buildCanonical(canonicalIt, DEFAULT_LOCALE);
  return {
    canonical: buildCanonical(canonicalIt, locale),
    languages,
  };
}
