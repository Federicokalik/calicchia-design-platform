/**
 * OG/Twitter image template — Swiss/Pentagram style.
 *
 * Usage: rendered by the dynamic image route `app/og/route.tsx` via `next/og`
 * ImageResponse. Runtime: nodejs (font loaded via fs, edge not supported).
 *
 * Layout (locked by product spec 2026-06-16):
 *   ┌────────────────────────────────────────────┐
 *   │  [Calicchia Design wordmark]          IT/EN │   ← top row
 *   │                                              │
 *   │                                              │
 *   │  Page title (bottom-anchored, length-aware)  │   ← bottom
 *   └────────────────────────────────────────────┘
 *
 * Style locked: bg #FAFAF7, foreground #111, accent #F57F44, hairline 1px,
 * Funnel Display 700 for the title.
 *
 * NOTE: only Satori-supported features — flex layout + inline <svg> with <path>.
 * The wordmark reuses the path data from `Logo.paths.ts` (no animation, fixed
 * colors) so no webp/PNG conversion of the logo is needed.
 */

import {
  CALICCHIA_PATHS,
  DESIGN_PATHS,
  TILDE_PATH,
  VIEWBOX_FULL,
} from '@/components/Logo/Logo.paths';

export interface OGTemplateProps {
  /** Page title — anchored to the bottom, sized down for long strings. */
  title: string;
  /** Locale for the IT/EN badge top-right. */
  locale?: 'it' | 'en';
}

const COLORS = {
  bg: '#FAFAF7',
  fg: '#111',
  muted: '#666',
  accent: '#F57F44',
  line: '#111',
} as const;

/** Wordmark intrinsic ratio (w/h) from the original viewBox. */
const LOGO_RATIO = VIEWBOX_FULL[2] / VIEWBOX_FULL[3]; // ≈ 2.43
const LOGO_HEIGHT = 56;
const LOGO_WIDTH = Math.round(LOGO_HEIGHT * LOGO_RATIO);

/**
 * The wordmark as an `<img>` SVG data-URI. Satori renders inline `<svg><path>`
 * unreliably (throws "Cannot read properties of undefined" on complex paths),
 * but handles `<img>` with an SVG data-URI cleanly. Reuses the path data from
 * Logo.paths.ts: letters in ink, the anchor tilde in the brand accent.
 */
const LOGO_DATA_URI = (() => {
  const letters = [...CALICCHIA_PATHS, ...DESIGN_PATHS]
    .map((d) => `<path d="${d}" fill="${COLORS.fg}"/>`)
    .join('');
  const tilde = `<path d="${TILDE_PATH}" fill="${COLORS.accent}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_FULL[2]} ${VIEWBOX_FULL[3]}">${letters}${tilde}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
})();

/**
 * Pick a display size so the title fills the card without overflowing.
 * Short headlines read big; long ones scale down but stay legible.
 */
function titleFontSize(title: string): number {
  const len = title.length;
  if (len <= 24) return 76;
  if (len <= 40) return 66;
  if (len <= 60) return 56;
  if (len <= 85) return 48;
  return 42;
}

export function OGTemplate({ title, locale = 'it' }: OGTemplateProps) {
  return (
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
        padding: '72px 80px',
        position: 'relative',
      }}
    >
      {/* Hairline rule top — Pentagram signature */}
      <div
        style={{
          position: 'absolute',
          top: 36,
          left: 80,
          right: 80,
          height: 1,
          background: COLORS.line,
        }}
      />

      {/* Top row: wordmark (left) + locale badge (right) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={LOGO_DATA_URI} width={LOGO_WIDTH} height={LOGO_HEIGHT} alt="Calicchia Design" />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            border: `1px solid ${COLORS.line}`,
            padding: '8px 16px',
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: COLORS.fg,
          }}
        >
          {locale === 'en' ? 'EN' : 'IT'}
        </div>
      </div>

      {/* Bottom: title anchored to the lower edge */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Accent tick above the title (Swiss square, NOT rounded) */}
        <div style={{ width: 48, height: 6, background: COLORS.accent, marginBottom: 28 }} />
        <div
          style={{
            display: 'flex',
            fontSize: titleFontSize(title),
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            color: COLORS.fg,
            maxWidth: '92%',
          }}
        >
          {title}
        </div>
      </div>
    </div>
  );
}
