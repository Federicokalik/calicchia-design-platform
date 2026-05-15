import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

type Arrow = 'right' | 'left' | 'down' | 'up' | 'none';
type Tone = 'default' | 'muted' | 'inverse';

const ARROW_GLYPH: Record<Exclude<Arrow, 'none'>, string> = {
  right: '→',
  left: '←',
  down: '↓',
  up: '↑',
};

const HOVER_TRANSLATE: Record<Exclude<Arrow, 'none'>, string> = {
  right: 'group-hover:translate-x-1',
  left: 'group-hover:-translate-x-1',
  down: 'group-hover:translate-y-1',
  up: 'group-hover:-translate-y-1',
};

const TONE_STYLES: Record<Tone, React.CSSProperties> = {
  default: { color: 'var(--color-ink)' },
  muted: { color: 'var(--color-ink-muted)' },
  inverse: { color: 'var(--color-surface)' },
};

interface EditorialLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  href: string;
  children: ReactNode;
  arrow?: Arrow;
  tone?: Tone;
  className?: string;
}

/**
 * Primitive unica per link editoriali con freccia ASCII typographic.
 * Sostituisce le frecce inline duplicate (servizi, blog, portfolio, case study,
 * glossari, CTA) per la compliance Swiss design audit 2026-05-09.
 *
 * Per CTA full-button (con padding/bordo) usa <Button> con prop iconAfter.
 * EditorialLink e' per il pattern small uppercase tracked text + arrow,
 * nessun padding, nessun bordo, hover translate sull'arrow.
 */
export function EditorialLink({
  href,
  children,
  arrow = 'right',
  tone = 'default',
  className,
  ...rest
}: EditorialLinkProps) {
  const cls = cn(
    'group inline-flex items-baseline gap-2 text-xs uppercase tracking-[0.18em] font-medium',
    'transition-opacity hover:opacity-70',
    className
  );

  return (
    <Link href={href} className={cls} style={TONE_STYLES[tone]} {...rest}>
      <span>{children}</span>
      {arrow !== 'none' ? (
        <span
          aria-hidden
          className={cn('inline-block transition-transform', HOVER_TRANSLATE[arrow])}
        >
          {ARROW_GLYPH[arrow]}
        </span>
      ) : null}
    </Link>
  );
}
