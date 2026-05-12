/**
 * OG/Twitter image template — Swiss/Pentagram style.
 *
 * Usage: importato da `app/**\/opengraph-image.tsx` + `twitter-image.tsx`.
 * Runtime: nodejs (font caricato via fs.readFile, edge non supportato per fs).
 *
 * Style locked: bg #FAFAF7, foreground #111, accent #F57F44, hairline 1px,
 * Funnel Display 700 per H1, mono uppercase per eyebrow.
 *
 * NOTA: niente JSX features non supportate da Satori (no svg complessi,
 * no animations, solo layout flex base). Vedi https://og-playground.vercel.app
 */

export type OGVariant = 'home' | 'case' | 'blog' | 'service' | 'matrix' | 'pillar' | 'contact';

export interface OGTemplateProps {
  /** Big display title — max 8-10 parole per leggibilità a 1200x630. */
  title: string;
  /** Short eyebrow above title (mono uppercase). */
  eyebrow?: string;
  /** Optional subtitle below title (max 2 lines). */
  subtitle?: string;
  /** Variant per micro-styling differenze (accent visibility, layout). */
  variant?: OGVariant;
  /** Brand wordmark mostrato in basso. */
  brand?: string;
  /** Locale per micro-tweaks copy (it/en). */
  locale?: 'it' | 'en';
}

const COLORS = {
  bg: '#FAFAF7',
  fg: '#111',
  muted: '#666',
  accent: '#F57F44',
  line: '#111',
} as const;

const VARIANT_EYEBROW: Record<OGVariant, { it: string; en: string }> = {
  home: { it: '01 — Web Designer & Developer Freelance', en: '01 — Freelance Web Designer & Developer' },
  case: { it: 'Case Study', en: 'Case Study' },
  blog: { it: 'Blog', en: 'Blog' },
  service: { it: 'Servizio', en: 'Service' },
  matrix: { it: 'Servizio × Settore', en: 'Service × Industry' },
  pillar: { it: 'Approfondimento', en: 'Long-form' },
  contact: { it: 'Contatti', en: 'Contact' },
};

export function OGTemplate({
  title,
  eyebrow,
  subtitle,
  variant = 'home',
  brand = 'Federico Calicchia',
  locale = 'it',
}: OGTemplateProps) {
  const finalEyebrow = eyebrow ?? VARIANT_EYEBROW[variant][locale];

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: COLORS.bg,
        color: COLORS.fg,
        fontFamily: 'Funnel Display',
        padding: '64px 80px',
        position: 'relative',
      }}
    >
      {/* Hairline rule top — Pentagram signature */}
      <div
        style={{
          position: 'absolute',
          top: 64,
          left: 80,
          right: 80,
          height: 1,
          background: COLORS.line,
        }}
      />

      {/* Eyebrow row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginTop: 32,
          fontSize: 22,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: COLORS.muted,
        }}
      >
        {/* Square accent dot (Swiss, NOT rounded) */}
        <div style={{ width: 12, height: 12, background: COLORS.accent }} />
        <span>{finalEyebrow}</span>
      </div>

      {/* Big title — max 4 lines */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          marginTop: 24,
          marginBottom: 24,
        }}
      >
        <div
          style={{
            fontSize: 88,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.0,
            color: COLORS.fg,
            display: 'flex',
            // Force wrap inside container
            maxWidth: '100%',
          }}
        >
          {title}
        </div>

        {subtitle ? (
          <div
            style={{
              marginTop: 24,
              fontSize: 32,
              letterSpacing: '-0.01em',
              lineHeight: 1.3,
              color: COLORS.muted,
              maxWidth: '85%',
              display: 'flex',
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>

      {/* Bottom row: brand wordmark + locale */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          paddingTop: 24,
          borderTop: `1px solid ${COLORS.line}`,
          fontSize: 22,
          letterSpacing: '0.05em',
          color: COLORS.fg,
        }}
      >
        <span style={{ fontWeight: 700 }}>{brand}</span>
        <span
          style={{
            fontSize: 18,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: COLORS.muted,
          }}
        >
          {locale === 'en' ? 'Italy / Worldwide' : 'Frosinone · Italia + estero'}
        </span>
      </div>
    </div>
  );
}
