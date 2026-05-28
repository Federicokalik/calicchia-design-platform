/**
 * buildPageMetadata — helper unificato per `generateMetadata` di pagina.
 *
 * Pattern: chiamato da ogni `page.tsx` per produrre un oggetto `Metadata`
 * coerente con il branding del sito (Federico Calicchia — Web Designer &
 * Developer Freelance), gli alternates hreflang, openGraph e Twitter card,
 * canonical assoluto.
 *
 * Convenzioni:
 *   - `title` viene wrappato automaticamente dal template del root layout
 *     (`%s — Web Designer & Developer Freelance`). NON includere il suffisso.
 *   - Per titoli che richiedono override completo (es. pagine legali con
 *     branding ridotto), usa `titleAbsolute` invece di `title`.
 *   - `description` max ~155 char. Se più lunga viene troncata da Google.
 *   - `path` è il path IT-canonical (es. `/perche-scegliere-me`); l'helper
 *     calcola da solo gli alternates EN/IT via `buildI18nAlternates`.
 *   - `localesAvailable` permette di limitare gli alternates (default tutti i
 *     locali). Per pagine IT-only o EN-only passa solo il locale supportato.
 *   - `ogImage` override; default OG_DEFAULT (ritratto Federico Calicchia).
 */
import type { Metadata } from 'next';
import { SITE } from '@/data/site';
import { LOCALES, type Locale, DEFAULT_LOCALE } from '@/lib/i18n';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';

const OG_DEFAULT = `${SITE.url}/img/federico-calicchia-ritratto-web-designer.webp`;

export interface PageMetadataArgs {
  /** Locale of the current render. */
  locale: Locale;
  /** IT-canonical path (e.g. `/perche-scegliere-me`). Used to compute hreflang. */
  path: string;
  /** Page-specific title. The root layout adds the ` — Web Designer & Developer Freelance` suffix. */
  title?: string;
  /** Use this when you need to OVERRIDE the title template completely (e.g. legal pages). */
  titleAbsolute?: string;
  /** ≤ 155 char meta description. */
  description: string;
  /** Override OG image (absolute URL or site-relative path). Defaults to the Federico portrait. */
  ogImage?: string;
  /** OG image alt; defaults to the page title. */
  ogImageAlt?: string;
  /** Optional OG type override (default `website`; for blog posts use `article`). */
  ogType?: 'website' | 'article' | 'profile';
  /** Set true to emit `robots: { index: false, follow: true }` (legal/utility pages). */
  noIndex?: boolean;
  /** Restrict the set of locales emitted as hreflang alternates. Default: all locales. */
  localesAvailable?: ReadonlyArray<Locale>;
  /** Extra openGraph fields merged in (e.g. publishedTime, modifiedTime for Article). */
  openGraphExtra?: Record<string, unknown>;
}

export function buildPageMetadata(args: PageMetadataArgs): Metadata {
  const {
    locale,
    path,
    title,
    titleAbsolute,
    description,
    ogImage,
    ogImageAlt,
    ogType = 'website',
    noIndex,
    localesAvailable,
    openGraphExtra,
  } = args;

  const image = ogImage
    ? ogImage.startsWith('http')
      ? ogImage
      : `${SITE.url}${ogImage}`
    : OG_DEFAULT;

  const availableLocales = (localesAvailable && localesAvailable.length > 0
    ? localesAvailable
    : LOCALES) as ReadonlyArray<Locale>;

  // Multi-locale: alternates auto-generati. Single-locale: solo canonical.
  let alternates: Metadata['alternates'];
  if (availableLocales.length === 1) {
    alternates = { canonical: buildCanonical(path, availableLocales[0]) };
  } else {
    const all = buildI18nAlternates(path, locale);
    const languages: Record<string, string> = {};
    for (const l of availableLocales) {
      languages[l] = all.languages[l];
    }
    languages['x-default'] = all.languages['x-default'];
    alternates = { canonical: all.canonical, languages };
  }

  const og = buildOgLocale(locale);
  const titleField: Metadata['title'] = titleAbsolute
    ? { absolute: titleAbsolute }
    : title ?? null;

  const ogTitle = titleAbsolute ?? (title ? `${title} — ${SITE.tagline}` : `${SITE.brand} — ${SITE.tagline}`);

  return {
    title: titleField,
    description,
    alternates,
    openGraph: {
      type: ogType,
      url: buildCanonical(path, locale),
      siteName: SITE.brand,
      title: ogTitle,
      description,
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          alt: ogImageAlt ?? ogTitle,
        },
      ],
      locale: og.locale,
      alternateLocale: og.alternateLocale,
      ...openGraphExtra,
    },
    twitter: {
      card: 'summary_large_image',
      creator: '@calicchiadesign',
      title: ogTitle,
      description,
      images: [image],
    },
    robots: noIndex ? { index: false, follow: true } : { index: true, follow: true },
  };
}

/** Shorthand for pages that exist in a single locale only (e.g. /zone/* IT-only, EN-only pillar). */
export function buildSingleLocaleMetadata(
  args: Omit<PageMetadataArgs, 'localesAvailable'> & { onlyLocale: Locale },
): Metadata {
  const { onlyLocale, ...rest } = args;
  return buildPageMetadata({ ...rest, locale: onlyLocale, localesAvailable: [onlyLocale] });
}

/** Re-export the default OG fallback so callers can compose their own. */
export { OG_DEFAULT };

/** Re-export DEFAULT_LOCALE so callers don't need two imports. */
export { DEFAULT_LOCALE };
