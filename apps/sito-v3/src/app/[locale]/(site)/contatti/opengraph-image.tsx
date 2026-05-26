import { ImageResponse } from 'next/og';
import { OGTemplate } from '@/components/og/OGTemplate';
import { isLocale, type Locale } from '@/lib/i18n';
import { getFunnelDisplay } from '@/lib/og-fonts';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Contatti — Federico Calicchia';

export default async function ContattiOpenGraphImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : 'it';

  const fontDisplay = await getFunnelDisplay();

  const title =
    locale === 'en' ? 'Get in touch.' : 'Sentiamoci. Niente PowerPoint.';
  const subtitle =
    locale === 'en'
      ? 'Drop a line or book a free 30-min call. Reply within 24h.'
      : 'Una chiamata di 30 minuti per capire se ha senso lavorare insieme. Risposta entro 24h.';

  return new ImageResponse(
    (
      <OGTemplate
        variant="contact"
        title={title}
        subtitle={subtitle}
        locale={locale}
      />
    ),
    {
      ...size,
      ...(fontDisplay
        ? { fonts: [{ name: 'Funnel Display', data: fontDisplay, weight: 700, style: 'normal' }] }
        : {}),
    },
  );
}
