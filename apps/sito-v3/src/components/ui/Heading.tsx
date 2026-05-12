import { createElement, forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

/**
 * Heading primitive — renders display-grade typography.
 *
 * `as` accepts `'p'` for editorial pull-paragraphs that visually behave as a
 * display heading but are not part of the document outline (a11y intent: a
 * non-heading semantic element with display-sized type, e.g. closing CTA
 * statements). Use h1-h6 for the actual outline.
 */
type Tag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p';
type Size = 'display-xl' | 'display-lg' | 'display-md' | 'display-sm' | 'card';

export interface HeadingProps extends HTMLAttributes<HTMLElement> {
  as?: Tag;
  size?: Size;
  children: ReactNode;
}

const SIZE_FONT: Record<Size, string> = {
  'display-xl': 'var(--text-display-xl)',
  'display-lg': 'var(--text-display-lg)',
  'display-md': 'var(--text-display-md)',
  'display-sm': 'var(--text-display-sm)',
  card: 'var(--text-card-title)',
};

const SIZE_LETTER_SPACING: Record<Size, string> = {
  'display-xl': '-0.035em',
  'display-lg': '-0.03em',
  'display-md': '-0.025em',
  'display-sm': '-0.018em',
  card: '-0.02em',
};

const SIZE_LINE_HEIGHT: Record<Size, number> = {
  'display-xl': 1.0,
  'display-lg': 1.05,
  'display-md': 1.05,
  'display-sm': 1.15,
  card: 1.1,
};

export const Heading = forwardRef<HTMLElement, HeadingProps>(function Heading(
  { as = 'h2', size = 'display-md', className = '', style, children, ...rest },
  ref
) {
  const baseStyle: CSSProperties = {
    fontFamily: 'var(--font-display)',
    fontWeight: 500,
    letterSpacing: SIZE_LETTER_SPACING[size],
    lineHeight: SIZE_LINE_HEIGHT[size],
    fontSize: SIZE_FONT[size],
    ...style,
  };

  return createElement(
    as,
    { ref, className: `whitespace-pre-line ${className}`.trim(), style: baseStyle, ...rest },
    children
  );
});
