import { createElement, forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

type Tag = 'p' | 'div' | 'span';
type Size = 'lg' | 'md' | 'sm';
type Tone = 'primary' | 'secondary' | 'tertiary';

export interface BodyProps extends HTMLAttributes<HTMLElement> {
  as?: Tag;
  size?: Size;
  tone?: Tone;
  children: ReactNode;
}

const SIZE_FONT: Record<Size, string> = {
  lg: 'var(--text-body-lg)',
  md: 'var(--text-body)',
  sm: 'var(--text-small)',
};

const SIZE_LINE_HEIGHT: Record<Size, number> = {
  lg: 1.55,
  md: 1.55,
  sm: 1.5,
};

const SIZE_LETTER_SPACING: Record<Size, string> = {
  lg: '-0.005em',
  md: '0',
  sm: '0',
};

const TONE_COLOR: Record<Tone, string> = {
  primary: 'var(--color-text-primary)',
  secondary: 'var(--color-text-secondary)',
  tertiary: 'var(--color-text-tertiary)',
};

export const Body = forwardRef<HTMLElement, BodyProps>(function Body(
  { as = 'p', size = 'md', tone = 'primary', className = '', style, children, ...rest },
  ref
) {
  const baseStyle: CSSProperties = {
    fontFamily: 'var(--font-sans)',
    fontSize: SIZE_FONT[size],
    lineHeight: SIZE_LINE_HEIGHT[size],
    letterSpacing: SIZE_LETTER_SPACING[size],
    color: TONE_COLOR[tone],
    ...style,
  };

  return createElement(as, { ref, className: `whitespace-pre-line ${className}`.trim(), style: baseStyle, ...rest }, children);
});
