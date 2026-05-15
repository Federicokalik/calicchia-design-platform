/**
 * i18n core — IT default (root URLs), EN su `/en/...`.
 *
 * Pathname segment translation:
 * - `/lavori` ↔ `/en/works`
 * - `/servizi` ↔ `/en/services`
 * - `/contatti` ↔ `/en/contact`
 * - `/perche-scegliere-me` ↔ `/en/why-choose-me`
 *
 * Filesystem rimane IT-canonical (app/[locale]/(site)/lavori/page.tsx); il
 * routing next-intl con `pathnames` config rewrita internamente le URL EN.
 */

export const LOCALES = ['it', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'it';

/**
 * Map first-segment IT canonical → EN slug. Solo prefissi che hanno una
 * traduzione naturale e search-friendly EN. Slug servizi/blog/progetti restano
 * uguali (web-design, e-commerce, seo, ecc. sono già EN-friendly).
 */
export const PATH_SEGMENTS_IT_TO_EN = {
  lavori: 'works',
  servizi: 'services',
  contatti: 'contact',
  'perche-scegliere-me': 'why-choose-me',
  // Hub bilingual (PATHNAMES entry added 2026-05-15). Mantieni in sync con
  // PATHNAMES in i18n/routing.ts — quella mappa è usata da next-intl per il
  // routing, questa da buildCanonical/buildI18nAlternates per gli URL nel
  // metadata (canonical, hreflang).
  'servizi-per-professioni': 'services-by-profession',
} as const satisfies Record<string, string>;

/** Reverse map per normalizzare URL EN → IT canonical (middleware, routing). */
export const PATH_SEGMENTS_EN_TO_IT: Record<string, string> = Object.fromEntries(
  Object.entries(PATH_SEGMENTS_IT_TO_EN).map(([it, en]) => [en, it]),
);

export function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/** Traduce solo il primo segmento di un path canonical IT in slug EN. */
function translateSegments(path: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return path;
  if (!path || path === '/') return path;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return path;
  const first = parts[0];
  if (first in PATH_SEGMENTS_IT_TO_EN) {
    parts[0] = PATH_SEGMENTS_IT_TO_EN[first as keyof typeof PATH_SEGMENTS_IT_TO_EN];
  }
  return '/' + parts.join('/');
}

/**
 * Returns the URL with locale prefix (only when non-default) e segmenti
 * tradotti. Esempio: localizedPath('/lavori/foo', 'en') → '/en/works/foo'.
 */
export function localizedPath(path: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return path;
  const translated = translateSegments(path, locale);
  if (translated === '/' || translated === '') return `/${locale}`;
  return `/${locale}${translated}`;
}

/** Strip leading `/{locale}` from pathname; useful when toggling languages. */
export function stripLocale(pathname: string): string {
  const seg = pathname.split('/')[1];
  if (seg && (LOCALES as readonly string[]).includes(seg)) {
    const rest = pathname.slice(seg.length + 1);
    return rest || '/';
  }
  return pathname;
}

/**
 * Reverse: da una URL pubblica (IT o EN) ricava il canonical IT path
 * (filesystem). Esempio: '/en/works/foo' → '/lavori/foo'.
 */
export function canonicalItPath(pathname: string): string {
  const stripped = stripLocale(pathname);
  if (!stripped || stripped === '/') return '/';
  const parts = stripped.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  const first = parts[0];
  if (first in PATH_SEGMENTS_EN_TO_IT) {
    parts[0] = PATH_SEGMENTS_EN_TO_IT[first];
  }
  return '/' + parts.join('/');
}

/**
 * Stub translator legacy. Mantenuto per backward compat con call-site che non
 * usano ancora useTranslations. Da rimuovere quando refactor t() è completo.
 */
export function t(_locale: Locale, key: string): string {
  return key;
}
