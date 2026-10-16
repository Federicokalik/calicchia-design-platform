import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/**
 * Bottone verso /contatti con la querystring della palette.
 *
 * Con una stringa ('/contatti?lead=…') next-intl non riconosce il path e in
 * EN produce /en/contatti; con l'href a oggetto traduce il segmento
 * (/en/contact) e codifica la query. Stessa resa del Button `solid` del sito.
 */
export function ContactButton({
  query,
  children,
  size = 'lg',
  onClick,
}: {
  query: Record<string, string>;
  children: ReactNode;
  size?: 'md' | 'lg';
  onClick?: () => void;
}) {
  // Il wrapper di @/i18n/navigation tipizza href come stringa: l'oggetto è supportato da next-intl.
  const href = { pathname: '/contatti', query } as unknown as string;
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'group inline-flex items-center gap-3 text-sm font-medium uppercase tracking-[0.15em] transition-hover-transform active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-3',
        size === 'lg' ? 'min-h-[56px] px-9 py-5' : 'px-7 py-4',
      )}
      style={{ background: 'var(--color-cta-bg)', color: 'var(--color-cta-fg)' }}
    >
      <span>{children}</span>
      <span aria-hidden className="inline-flex items-center transition-transform group-hover:translate-x-0.5">
        →
      </span>
    </Link>
  );
}

/** Query del contatto: lead, settore (solo se pronto) e palette codificata. */
export function contactQuery(sector: string | null | undefined, shareQuery: string | null): Record<string, string> {
  return {
    lead: 'palette-di-settore',
    ...(sector ? { profession: sector } : {}),
    ...(shareQuery ? { palette: shareQuery } : {}),
  };
}
