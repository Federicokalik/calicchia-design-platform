import { createElement, forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

type Tag = 'span' | 'p' | 'div' | 'dt' | 'dd';
type Tone = 'muted' | 'primary' | 'accent';

export interface MonoLabelProps extends HTMLAttributes<HTMLElement> {
  as?: Tag;
  tone?: Tone;
  children: ReactNode;
}

const TONE_COLOR: Record<Tone, string> = {
  muted: 'var(--color-text-secondary)',
  primary: 'var(--color-text-primary)',
  accent: 'var(--color-link-hover)',
};

export const MonoLabel = forwardRef<HTMLElement, MonoLabelProps>(function MonoLabel(
  { as = 'span', tone = 'muted', className = '', style, children, ...rest },
  ref
) {
  const baseStyle: CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-mono-xs)',
    letterSpacing: '0.05em',
    color: TONE_COLOR[tone],
    lineHeight: 1.0,
    ...style,
  };

  return createElement(as, { ref, className, style: baseStyle, ...rest }, children);
});
