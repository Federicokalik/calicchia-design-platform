import { SITE } from '@/data/site';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';

/**
 * Dynamic Open Graph image helper.
 *
 * Every indexable page points its `openGraph.images` / `twitter.images` at the
 * shared renderer in `app/og/route.tsx`, passing its own title + locale. This
 * makes the image explicit on every page (Next merges `openGraph` shallowly, so
 * a page that omits `images` drops the root fallback — see app/layout.tsx) and
 * gives one consistent branded card site-wide.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;

export interface OgImageDescriptor {
  url: string;
  width: number;
  height: number;
  alt: string;
}

/** Absolute URL of the generated card for a given title + locale. */
export function buildOgImageUrl(title: string, locale: Locale = DEFAULT_LOCALE): string {
  const params = new URLSearchParams({ l: locale, t: title });
  return `${SITE.url}/og?${params.toString()}`;
}

/**
 * Returns a single-element image descriptor array ready to spread into
 * `openGraph.images`. For `twitter.images` pass `.map((i) => i.url)`.
 */
export function buildOgImage(title: string, locale: Locale = DEFAULT_LOCALE): OgImageDescriptor[] {
  return [
    {
      url: buildOgImageUrl(title, locale),
      width: OG_SIZE.width,
      height: OG_SIZE.height,
      alt: title,
    },
  ];
}
