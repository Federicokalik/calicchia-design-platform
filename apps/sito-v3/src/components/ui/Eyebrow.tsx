import { createElement, forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

type Tag = 'p' | 'span' | 'div';
type Tone = 'muted' | 'accent' | 'primary';

export interface EyebrowProps extends HTMLAttributes<HTMLElement> {
  as?: Tag;
  tone?: Tone;
  mono?: boolean;
  children: ReactNode;
}

const TONE_COLOR: Record<Tone, string> = {
  muted: 'var(--color-text-secondary)',
  accent: 'var(--color-link-hover)',
  primary: 'var(--color-text-primary)',
};

export const Eyebrow = forwardRef<HTMLElement, EyebrowProps>(function Eyebrow(
  { as = 'p', tone = 'muted', mono = false, className = '', style, children, ...rest },
  ref
) {
  const baseStyle: CSSProperties = {
    fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
    fontSize: 'var(--text-eyebrow)',
    letterSpacing: '0.2em',
    textTransform: 'uppercase',
    color: TONE_COLOR[tone],
    lineHeight: 1.0,
    ...style,
  };

  return createElement(as, { ref, className, style: baseStyle, ...rest }, children);
});
