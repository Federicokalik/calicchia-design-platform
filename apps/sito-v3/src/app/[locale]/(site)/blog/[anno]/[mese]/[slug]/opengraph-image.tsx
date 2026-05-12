import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OGTemplate } from '@/components/og/OGTemplate';
import { fetchBlogArticle } from '@/lib/blog-api';
import { isLocale, type Locale } from '@/lib/i18n';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Blog article — Federico Calicchia';

interface Params {
  locale: string;
  anno: string;
  mese: string;
  slug: string;
}

export default async function BlogOpenGraphImage({ params }: { params: Promise<Params> }) {
  const { locale: rawLocale, slug } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : 'it';

  const fontDisplay = await readFile(
    join(process.cwd(), 'public/fonts/funnel-display-latin.woff2'),
  );

  const data = await fetchBlogArticle(slug);
  const post = data?.post;

  const title = post?.title ?? 'Articolo';
  const subtitle = post?.excerpt ?? undefined;

  return new ImageResponse(
    (
      <OGTemplate
        variant="blog"
        title={title}
        subtitle={subtitle}
        locale={locale}
      />
    ),
    {
      ...size,
      fonts: [{ name: 'Funnel Display', data: fontDisplay, weight: 700, style: 'normal' }],
    },
  );
}
