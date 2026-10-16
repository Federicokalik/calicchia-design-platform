import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';
import { contrast, decodeSharedPalette } from '@calicchia/shared/palette';
import { LOGO_DATA_URI, LOGO_HEIGHT, LOGO_WIDTH } from '@/components/og/OGTemplate';
import { getSectorProfession, isKnownSector } from '@/data/risorse/palette';
import { PAGE_COPY } from '@/data/risorse/palette/page-copy';
import { isLocale } from '@/lib/i18n';
import { OG_SIZE } from '@/lib/og-image';
import { getFunnelDisplay } from '@/lib/og-fonts';

/**
 * Card OG della "Palette di settore": fasce dei colori + nome del settore.
 *
 * GET /og/palette?l=it|en&v=1&k=<slug>&c=<hex,…>&s=<stile>&p=<indice>
 * (stessa querystring del link condiviso). La querystring passa da
 * `decodeSharedPalette`: colori e stile validati, settore mostrato solo se è
 * uno di quelli pronti. Font: solo il TTF Funnel Display già usato da
 * `app/og/route.tsx` (i woff2 mandano in crash @vercel/og).
 */

export const runtime = 'nodejs';

const COLORS = { bg: '#FAFAF7', fg: '#111111', line: '#111111', accent: '#F57F44' } as const;
/** Fasce neutre se il link non è valido: i colori del sito. */
const FALLBACK = ['#111111', '#5C5C58', '#C9C5B7', '#E6E4DC', '#F57F44'];

function inkOn(hex: string): string {
  return contrast(hex, COLORS.fg) >= contrast(hex, '#FFFFFF') ? COLORS.fg : '#FFFFFF';
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const rawLocale = searchParams.get('l') ?? undefined;
  const locale = isLocale(rawLocale) ? rawLocale : 'it';
  const c = PAGE_COPY[locale];

  const shared = decodeSharedPalette(searchParams, isKnownSector);
  const sectorLabel = shared?.sector ? getSectorProfession(shared.sector)?.label[locale] : undefined;
  const title = sectorLabel ?? c.appName;
  const colors = shared?.colors ?? FALLBACK;
  const primary = shared?.primary ?? -1;

  const fontDisplay = await getFunnelDisplay();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: COLORS.bg,
          color: COLORS.fg,
          fontFamily: 'Funnel Display',
          padding: '56px 80px 64px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_DATA_URI} width={LOGO_WIDTH} height={LOGO_HEIGHT} alt="Calicchia Design" />
          <div
            style={{
              display: 'flex',
              border: `1px solid ${COLORS.line}`,
              padding: '8px 16px',
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
            }}
          >
            {c.appName}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ width: 48, height: 6, background: COLORS.accent, marginBottom: 24 }} />
          <div
            style={{
              display: 'flex',
              fontSize: title.length > 28 ? 60 : 76,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.05,
              marginBottom: 36,
              maxWidth: '92%',
            }}
          >
            {title}
          </div>
          <div style={{ display: 'flex', height: 210, border: `1px solid ${COLORS.line}` }}>
            {colors.map((hex, i) => (
              <div
                key={`${hex}-${i}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  flex: 1,
                  background: hex,
                  color: inkOn(hex),
                  padding: '16px 18px',
                  fontSize: 24,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}
              >
                {i === primary ? (
                  <div style={{ display: 'flex', width: 14, height: 14, background: inkOn(hex), marginBottom: 10 }} />
                ) : null}
                {hex}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      ...(fontDisplay
        ? { fonts: [{ name: 'Funnel Display', data: fontDisplay, weight: 700 as const, style: 'normal' as const }] }
        : {}),
      headers: {
        'Cache-Control': 'public, immutable, no-transform, max-age=86400, s-maxage=604800',
      },
    },
  );
}
