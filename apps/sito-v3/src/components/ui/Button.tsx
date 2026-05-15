import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

type Variant = 'solid' | 'ghost' | 'underline';
type Size = 'sm' | 'md' | 'lg';

interface CommonProps {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  className?: string;
  /** Icon/glyph rendered after the label (e.g. ASCII arrow "→" or Phosphor icon). */
  iconAfter?: ReactNode;
  /** Icon/glyph rendered before the label. */
  iconBefore?: ReactNode;
}

type ButtonAsButton = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };

type ButtonAsLink = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

const baseStyles =
  'group inline-flex items-center gap-3 text-sm uppercase tracking-[0.15em] font-medium transition-hover-transform active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-3 disabled:opacity-50 disabled:cursor-not-allowed';

const sizeStyles: Record<Size, string> = {
  sm: 'px-5 py-3',
  md: 'px-7 py-4',
  lg: 'px-9 py-5 min-h-[56px]',
};

const variantStyles: Record<Variant, string> = {
  solid: 'text-white',
  ghost:
    'border border-current transition-hover-color hover:bg-[var(--color-text-primary)] hover:text-[var(--color-surface)]',
  underline:
    'px-0 py-2 border-b border-current hover:opacity-60 transition-hover-opacity',
};

const variantInline: Record<Variant, React.CSSProperties> = {
  solid: { background: 'var(--color-cta-bg)', color: 'var(--color-cta-fg)' },
  ghost: {},
  underline: {},
};

export function Button(props: ButtonAsButton | ButtonAsLink) {
  const {
    children,
    variant = 'solid',
    size = 'md',
    className,
    iconAfter,
    iconBefore,
    ...rest
  } = props;
  const style = variantInline[variant];
  // Underline variant overrides padding via its own classes — skip size padding.
  const cls = cn(
    baseStyles,
    variant === 'underline' ? '' : sizeStyles[size],
    variantStyles[variant],
    className
  );

  const inner = (
    <>
      {iconBefore ? (
        <span aria-hidden className="inline-flex items-center transition-transform group-hover:-translate-x-0.5">
          {iconBefore}
        </span>
      ) : null}
      <span>{children}</span>
      {iconAfter ? (
        <span aria-hidden className="inline-flex items-center transition-transform group-hover:translate-x-0.5">
          {iconAfter}
        </span>
      ) : null}
    </>
  );

  if ('href' in rest && rest.href !== undefined) {
    const { href, ...linkRest } = rest;
    const isExternal = /^(https?:|mailto:|tel:|#)/.test(href);
    if (isExternal) {
      return (
        <a href={href} className={cls} style={style} {...linkRest}>
          {inner}
        </a>
      );
    }
    return (
      <Link href={href} className={cls} style={style} {...linkRest}>
        {inner}
      </Link>
    );
  }
  return (
    <button className={cls} style={style} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {inner}
    </button>
  );
}
