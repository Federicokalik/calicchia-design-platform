import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OGTemplate } from '@/components/og/OGTemplate';
import { isLocale, type Locale } from '@/lib/i18n';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Perché scegliere me — Federico Calicchia';

export default async function PercheOpenGraphImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : 'it';

  const fontDisplay = await readFile(
    join(process.cwd(), 'public/fonts/funnel-display-latin.woff2'),
  );

  const title =
    locale === 'en'
      ? 'Why pick a freelance, not an agency'
      : 'Perché un freelance, non un\'agenzia a sei mani';
  const subtitle =
    locale === 'en'
      ? 'One contact, full stack, end-to-end accountability.'
      : 'Un solo contatto, niente passaggi di mano, niente scaricabarile.';

  return new ImageResponse(
    (
      <OGTemplate
        variant="pillar"
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
