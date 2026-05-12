import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OGTemplate } from '@/components/og/OGTemplate';
import { fetchProjectBySlug } from '@/lib/projects-api';
import { isLocale, type Locale } from '@/lib/i18n';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Case study — Federico Calicchia';

interface Params {
  locale: string;
  slug: string;
}

export default async function CaseOpenGraphImage({ params }: { params: Promise<Params> }) {
  const { locale: rawLocale, slug } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : 'it';

  const fontDisplay = await readFile(
    join(process.cwd(), 'public/fonts/funnel-display-latin.woff2'),
  );

  const detail = await fetchProjectBySlug(slug);
  const project = detail?.project;

  const title = project?.seo_title ?? project?.title ?? 'Case study';
  const subtitle =
    project?.seo_description ??
    project?.description ??
    (locale === 'en' ? 'Case study, end-to-end design + development.' : 'Case study, design + sviluppo end-to-end.');

  return new ImageResponse(
    (
      <OGTemplate
        variant="case"
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
