import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OGTemplate } from '@/components/og/OGTemplate';
import { getServiceDetail } from '@/data/services-detail';
import { isLocale, type Locale } from '@/lib/i18n';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Servizio — Federico Calicchia';

interface Params {
  locale: string;
  slug: string;
}

export default async function ServiceOpenGraphImage({ params }: { params: Promise<Params> }) {
  const { locale: rawLocale, slug } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : 'it';
  const svc = getServiceDetail(slug, locale);

  const fontDisplay = await readFile(
    join(process.cwd(), 'public/fonts/funnel-display-latin.woff2'),
  );

  return new ImageResponse(
    (
      <OGTemplate
        variant="service"
        title={svc?.title ?? 'Servizio'}
        subtitle={svc?.description}
        locale={locale}
      />
    ),
    {
      ...size,
      fonts: [{ name: 'Funnel Display', data: fontDisplay, weight: 700, style: 'normal' }],
    },
  );
}
