import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OGTemplate } from '@/components/og/OGTemplate';
import { isLocale, type Locale } from '@/lib/i18n';

// Runtime nodejs (NON edge): font custom Funnel Display caricato via fs.readFile,
// edge runtime non supporta fs in Next 16.
export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Federico Calicchia — Web Designer & Developer Freelance';

export default async function HomeOpenGraphImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : 'it';

  const fontDisplayPath = join(process.cwd(), 'public/fonts/funnel-display-latin.woff2');
  const fontDisplay = await readFile(fontDisplayPath);

  const title =
    locale === 'en'
      ? 'Freelance Web Designer & Developer based in Italy'
      : 'Realizzazione siti web, e-commerce, sviluppo, SEO';

  const subtitle =
    locale === 'en'
      ? 'One person, full stack. Working with Italian and European businesses, in English.'
      : 'Un solo contatto. Niente agenzia a sei mani. Italia + estero.';

  return new ImageResponse(
    (
      <OGTemplate
        variant="home"
        title={title}
        subtitle={subtitle}
        locale={locale}
      />
    ),
    {
      ...size,
      fonts: [
        {
          name: 'Funnel Display',
          data: fontDisplay,
          weight: 700,
          style: 'normal',
        },
      ],
    },
  );
}
