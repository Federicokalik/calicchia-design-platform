import { ImageResponse } from 'next/og';
import { OGTemplate } from '@/components/og/OGTemplate';
import { isLocale, type Locale } from '@/lib/i18n';
import { getFunnelDisplay } from '@/lib/og-fonts';

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

  const fontDisplay = await getFunnelDisplay();

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
      ...(fontDisplay
        ? {
            fonts: [
              {
                name: 'Funnel Display',
                data: fontDisplay,
                weight: 700,
                style: 'normal',
              },
            ],
          }
        : {}),
    },
  );
}
