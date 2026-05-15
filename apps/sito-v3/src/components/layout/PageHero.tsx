import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import type { BreadcrumbItem } from '@/data/structured-data';
import { cn } from '@/lib/utils';

interface PageHeroAction {
  label: string;
  href: string;
  variant?: 'primary' | 'secondary' | 'underline';
}

interface PageHeroProps {
  breadcrumbs?: BreadcrumbItem[];
  eyebrow?: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  tagline?: ReactNode;
  actions?: PageHeroAction[];
  backLink?: {
    href: string;
    label: string;
  };
  compact?: boolean;
  className?: string;
  titleClassName?: string;
  titleStyle?: CSSProperties;
  children?: ReactNode;
}

function actionClass(variant: NonNullable<PageHeroAction['variant']>) {
  if (variant === 'primary') {
    return 'border border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-bg)] hover:bg-[var(--color-accent-deep)] hover:border-[var(--color-accent-deep)]';
  }
  if (variant === 'secondary') {
    return 'border border-[var(--color-border-strong)] text-[var(--color-ink)] hover:bg-[var(--color-surface-elev)]';
  }
  return 'border-b border-current px-0 hover:opacity-60';
}

export function PageHero({
  breadcrumbs,
  eyebrow,
  title,
  intro,
  tagline,
  actions = [],
  backLink,
  compact = false,
  className,
  titleClassName,
  titleStyle,
  children,
}: PageHeroProps) {
  return (
    <section
      className={cn(
        'relative px-6 md:px-10 lg:px-14 pt-32 md:pt-40 max-w-[1600px] mx-auto',
        compact ? 'pb-20 md:pb-24' : 'pb-24 md:pb-32',
        className
      )}
    >
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} className="mb-8" />}

      <div className="grid grid-cols-1 md:grid-cols-12 gap-x-10 gap-y-10">
        <div className="md:col-span-12">
          <div className="min-h-[1.25rem] mb-7 flex flex-col gap-4">
            {backLink && (
                <Link
                  href={backLink.href}
                  className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] hover:opacity-60 transition-opacity"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  <span aria-hidden>←</span>
                  {backLink.label}
                </Link>
            )}
            {eyebrow && (
                <p
                  className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.24em]"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {eyebrow}
                </p>
            )}
          </div>

          <h1
            className={cn('font-[family-name:var(--font-display)] max-w-[18ch]', titleClassName)}
            style={{
              fontSize: 'var(--text-display-lg)',
              fontWeight: 500,
              letterSpacing: '-0.032em',
              lineHeight: 0.96,
              ...titleStyle,
            }}
          >
            {title}
          </h1>

          {intro && (
            <div
              className="mt-8 max-w-[80ch] flex flex-col gap-5"
              style={{
                color: 'var(--color-text-secondary)',
              }}
            >
              {(typeof intro === 'string' ? intro.split(/\n{2,}/) : [intro]).map(
                (paragraph, idx) => (
                  <p
                    key={idx}
                    className="body-longform text-xl md:text-2xl leading-snug whitespace-pre-line text-justify"
                    style={{
                      fontWeight: 400,
                      letterSpacing: '-0.005em',
                    }}
                  >
                    {paragraph}
                  </p>
                ),
              )}
            </div>
          )}

          {tagline && (
            <p
              className="mt-7 font-mono text-sm uppercase tracking-[0.18em] max-w-[58ch]"
              style={{ color: 'var(--color-accent-deep)' }}
            >
              {tagline}
            </p>
          )}

          {actions.length > 0 && (
            <div className="mt-9 flex flex-wrap items-center gap-3">
              {actions.map((action) => {
                const variant = action.variant ?? 'primary';
                return (
                  <Link
                    key={`${action.href}-${action.label}`}
                    href={action.href}
                    className={cn(
                      'inline-flex min-h-[44px] items-center gap-3 px-5 py-3 text-xs uppercase tracking-[0.18em] font-medium transition-colors',
                      actionClass(variant)
                    )}
                  >
                    {action.label}
                    <ArrowRight size={16} weight="regular" aria-hidden />
                  </Link>
                );
              })}
            </div>
          )}
        </div>

      </div>

      {children && <div className="mt-14 md:mt-18">{children}</div>}
    </section>
  );
}
