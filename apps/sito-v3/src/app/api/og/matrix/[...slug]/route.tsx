import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OGTemplate } from '@/components/og/OGTemplate';
import { isLocale, type Locale } from '@/lib/i18n';

/**
 * OG image route handler per /[...matrix]/* — workaround perché Next.js NON
 * permette `opengraph-image.tsx` dentro un catch-all route segment.
 *
 * Pattern: la page `/[locale]/(site)/[...matrix]/page.tsx` linka questo
 * endpoint via `generateMetadata` openGraph.images URL.
 *
 * URL format: /api/og/matrix/<segment>?locale=it
 * Es: /api/og/matrix/web-design-per-dentista-a-roma?locale=it
 *
 * Il middleware esclude `/api/*` dal matcher quindi non interferisce con
 * locale routing o portal auth.
 */

export const runtime = 'nodejs';

const SIZE = { width: 1200, height: 630 } as const;

/** Trasforma "web-design-per-dentista-a-roma" in "Web design per dentista a Roma". */
function humanizeMatrixSlug(slug: string): string {
  return slug
    .split('-')
    .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ')
    .replace(/\bA\b/g, 'a')
    .replace(/^\s*\w/, (c) => c.toUpperCase());
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  const url = new URL(request.url);
  const rawLocale = url.searchParams.get('locale') ?? 'it';
  const locale: Locale = isLocale(rawLocale) ? rawLocale : 'it';

  const fontDisplay = await readFile(
    join(process.cwd(), 'public/fonts/funnel-display-latin.woff2'),
  );

  const segment = slug?.[0] ?? '';
  const title = segment ? humanizeMatrixSlug(segment) : 'Servizio × settore';
  const subtitle =
    locale === 'en'
      ? 'Vertical SEO landing — service paired with the right industry.'
      : 'Landing SEO verticale — servizio + settore giusto.';

  return new ImageResponse(
    (
      <OGTemplate
        variant="matrix"
        title={title}
        subtitle={subtitle}
        locale={locale}
      />
    ),
    {
      ...SIZE,
      fonts: [{ name: 'Funnel Display', data: fontDisplay, weight: 700, style: 'normal' }],
      headers: {
        'Cache-Control': 'public, immutable, no-transform, max-age=3600, s-maxage=86400',
      },
    },
  );
}
