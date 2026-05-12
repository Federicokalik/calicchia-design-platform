import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Portal typography wrappers — single source of truth for font sizes inside
 * `app/[locale]/(portal)/**`. Substituting one of these in code propagates
 * across all portal pages.
 *
 * Display/H1/H2/H3 inherit Funnel Display via the global `h1, h2, h3, h4`
 * rule in `globals.css:66-72`. Body/Caption/Label use Funnel Sans via body
 * inheritance.
 *
 * Sizes resolve to CSS vars `--text-portal-*` defined in `portal-theme.css`.
 */

type AsProp<T extends React.ElementType> = { as?: T };

type PolymorphicProps<T extends React.ElementType, P = object> = AsProp<T> &
  P &
  Omit<React.ComponentPropsWithoutRef<T>, keyof AsProp<T> | keyof P>;

interface TypoProps {
  className?: string;
  children?: React.ReactNode;
}

/** Page-level title. Funnel Display, fluid clamp from 2rem to 2.5rem. */
export function PortalDisplay<T extends React.ElementType = 'h1'>({
  as,
  className,
  ...rest
}: PolymorphicProps<T, TypoProps>) {
  const Comp = (as ?? 'h1') as React.ElementType;
  return (
    <Comp
      className={cn('text-portal-display tracking-tight font-medium', className)}
      {...rest}
    />
  );
}

/** Section title. Funnel Display, 26px. */
export function PortalH1<T extends React.ElementType = 'h2'>({
  as,
  className,
  ...rest
}: PolymorphicProps<T, TypoProps>) {
  const Comp = (as ?? 'h2') as React.ElementType;
  return (
    <Comp
      className={cn('text-portal-h1 tracking-tight font-medium', className)}
      {...rest}
    />
  );
}

/** Card / subsection title. Funnel Display, 20px. */
export function PortalH2<T extends React.ElementType = 'h3'>({
  as,
  className,
  ...rest
}: PolymorphicProps<T, TypoProps>) {
  const Comp = (as ?? 'h3') as React.ElementType;
  return (
    <Comp
      className={cn('text-portal-h2 tracking-tight font-medium', className)}
      {...rest}
    />
  );
}

/** Inline title / form group label. Funnel Sans, 16px. */
export function PortalH3<T extends React.ElementType = 'h4'>({
  as,
  className,
  ...rest
}: PolymorphicProps<T, TypoProps>) {
  const Comp = (as ?? 'h4') as React.ElementType;
  return (
    <Comp className={cn('text-portal-h3 font-medium', className)} {...rest} />
  );
}

/** Body text. Funnel Sans, 14px (admin baseline). */
export function PortalBody<T extends React.ElementType = 'p'>({
  as,
  className,
  ...rest
}: PolymorphicProps<T, TypoProps>) {
  const Comp = (as ?? 'p') as React.ElementType;
  return (
    <Comp
      className={cn('text-portal-body text-foreground', className)}
      {...rest}
    />
  );
}

interface CaptionProps extends TypoProps {
  /** `error` flips color to destructive; `muted` (default) uses muted-foreground. */
  tone?: 'muted' | 'error' | 'foreground';
}

/** Note, hint, error message, footnote. Funnel Sans, 12px. */
export function PortalCaption<T extends React.ElementType = 'p'>({
  as,
  className,
  tone = 'muted',
  ...rest
}: PolymorphicProps<T, CaptionProps>) {
  const Comp = (as ?? 'p') as React.ElementType;
  const toneClass =
    tone === 'error'
      ? 'text-destructive'
      : tone === 'foreground'
      ? 'text-foreground'
      : 'text-muted-foreground';
  return (
    <Comp
      className={cn('text-portal-caption', toneClass, className)}
      {...rest}
    />
  );
}

/** Eyebrow / breadcrumb segment / sidebar section header. 11px uppercase tracking-[0.18em]. */
export function PortalLabel<T extends React.ElementType = 'span'>({
  as,
  className,
  ...rest
}: PolymorphicProps<T, TypoProps>) {
  const Comp = (as ?? 'span') as React.ElementType;
  return (
    <Comp
      className={cn(
        'text-portal-label uppercase tracking-[0.18em] text-muted-foreground',
        className
      )}
      {...rest}
    />
  );
}
