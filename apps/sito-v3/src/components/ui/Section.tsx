import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

type Spacing = 'none' | 'tight' | 'compact' | 'default' | 'cinematic' | 'epic';
type Bordered = boolean | 'top' | 'bottom' | 'both';

export interface SectionProps extends HTMLAttributes<HTMLElement> {
  /** Symmetric vertical padding. Use spacingTop/spacingBottom for asymmetric. */
  spacing?: Spacing;
  /** Override `spacing` for top side only. */
  spacingTop?: Spacing;
  /** Override `spacing` for bottom side only. */
  spacingBottom?: Spacing;
  /** `true` is shorthand for `'top'` (back-compat). */
  bordered?: Bordered;
  /** Drop the max-width constraint (keep padding). For colored fullbleed slabs that wrap their own constrained content. */
  bleed?: boolean;
  /** Drop both padding AND constraint. Caller takes full ownership. */
  fullBleed?: boolean;
  children: ReactNode;
}

const PT: Record<Spacing, string> = {
  none: 'pt-0',
  tight: 'pt-16 md:pt-24',
  compact: 'pt-24 md:pt-32',
  default: 'pt-32 md:pt-44',
  cinematic: 'pt-32 md:pt-48',
  epic: 'pt-32 md:pt-56',
};

const PB: Record<Spacing, string> = {
  none: 'pb-0',
  tight: 'pb-16 md:pb-24',
  compact: 'pb-24 md:pb-32',
  default: 'pb-32 md:pb-44',
  cinematic: 'pb-32 md:pb-48',
  epic: 'pb-32 md:pb-56',
};

function borderStyle(b: Bordered): React.CSSProperties {
  if (!b) return {};
  const line = '1px solid var(--color-border)';
  if (b === 'bottom') return { borderBottom: line };
  if (b === 'both') return { borderTop: line, borderBottom: line };
  return { borderTop: line };
}

export const Section = forwardRef<HTMLElement, SectionProps>(function Section(
  {
    spacing = 'default',
    spacingTop,
    spacingBottom,
    bordered = false,
    bleed = false,
    fullBleed = false,
    className = '',
    style,
    children,
    ...rest
  },
  ref
) {
  const top = spacingTop ?? spacing;
  const bottom = spacingBottom ?? spacing;
  const padding = fullBleed ? '' : 'px-6 md:px-10 lg:px-14';
  const constraint = fullBleed || bleed ? '' : 'max-w-[1600px] mx-auto';
  const cls = [
    'relative',
    padding,
    PT[top],
    PB[bottom],
    constraint,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const finalStyle = { ...borderStyle(bordered), ...style };

  return (
    <section ref={ref} className={cls} style={finalStyle} {...rest}>
      {children}
    </section>
  );
});
