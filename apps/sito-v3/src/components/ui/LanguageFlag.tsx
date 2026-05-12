'use client';

import type { Locale } from '@/lib/i18n';

interface LanguageFlagProps {
  locale: Locale;
  /** Whether the surrounding header is in dark/inverted mode (menu open) */
  inverted?: boolean;
  className?: string;
}

/**
 * Typographic locale token — Swiss/Pentagram-restraint mark instead of a
 * literal flag SVG. Renders as `IT` / `EN` in font-mono uppercase with a tiny
 * accent dot indicator, sitting in a 1px-bordered square chip that matches the
 * Menu button's border vocabulary.
 */
export function LanguageFlag({ locale, inverted = false, className }: LanguageFlagProps) {
  const fg = inverted ? '#FAFAF7' : 'var(--color-ink)';
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        border: `1px solid ${fg}`,
        borderRadius: 2,
        fontFamily: 'var(--font-mono, ui-monospace)',
        fontSize: '0.7rem',
        fontWeight: 500,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: fg,
        lineHeight: 1,
        transition: 'color 0.4s ease, border-color 0.4s ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 4,
          height: 4,
          background: 'var(--color-accent)',
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
      <span>{locale}</span>
    </span>
  );
}
