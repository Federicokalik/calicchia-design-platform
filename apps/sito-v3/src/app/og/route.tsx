import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';
import { OGTemplate } from '@/components/og/OGTemplate';
import { SITE } from '@/data/site';
import { isLocale } from '@/lib/i18n';
import { OG_SIZE } from '@/lib/og-image';
import { getFunnelDisplay } from '@/lib/og-fonts';

/**
 * Shared dynamic Open Graph card renderer.
 *
 * GET /og?l=it|en&t=<title> → 1200×630 PNG with the brand wordmark (top-left),
 * the locale badge (top-right) and the page title (bottom). Every indexable
 * page references this via `buildOgImage()` (see src/lib/og-image.ts).
 *
 * runtime=nodejs is required: `getFunnelDisplay()` reads the TTF from disk
 * (the woff2 fonts crash @vercel/og — see src/lib/og-fonts.ts). Top-level
 * route (no `[locale]` segment) so next-intl never rewrites the path; this
 * project has no middleware.ts so `/og` resolves directly.
 */

export const runtime = 'nodejs';

const BRAND_FALLBACK = `${SITE.brand} — ${SITE.tagline}`;
const MAX_TITLE_LEN = 120;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const rawLocale = searchParams.get('l') ?? undefined;
  const locale = isLocale(rawLocale) ? rawLocale : 'it';

  const rawTitle = (searchParams.get('t') ?? '').trim();
  const title = rawTitle ? rawTitle.slice(0, MAX_TITLE_LEN) : BRAND_FALLBACK;

  const fontDisplay = await getFunnelDisplay();

  return new ImageResponse(<OGTemplate title={title} locale={locale} />, {
    ...OG_SIZE,
    ...(fontDisplay
      ? {
          fonts: [
            { name: 'Funnel Display', data: fontDisplay, weight: 700 as const, style: 'normal' as const },
          ],
        }
      : {}),
    headers: {
      // Crawlers re-fetch OG images often; cache aggressively at the edge/CDN.
      'Cache-Control': 'public, immutable, no-transform, max-age=86400, s-maxage=604800',
    },
  });
}
