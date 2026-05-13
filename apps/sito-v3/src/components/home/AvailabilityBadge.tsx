import { getTranslations } from 'next-intl/server';

export type AvailabilityStatus = 'available' | 'last_slot' | 'full';

export interface AvailabilitySnapshot {
  used: number;
  max: number;
  status: AvailabilityStatus;
  nextAvailableMonth: string;
}

interface AvailabilityBadgeProps {
  snapshot: AvailabilitySnapshot | null;
  className?: string;
}

const dotColorByStatus: Record<AvailabilityStatus, string> = {
  available: 'var(--color-accent)',
  last_slot: 'var(--color-accent-deep)',
  full: 'var(--color-ink-muted)',
};

/**
 * AvailabilityBadge — render dello stato disponibilità "nuovi progetti".
 *
 * Riceve uno snapshot già risolto lato server (vedi `Hero.tsx` per la fetch a
 * /api/public/capacity con revalidate 300). Se `snapshot` è null (errore
 * fetch o API non raggiungibile) cade sul testo statico legacy
 * `home.hero.available` per non rompere il layout above-the-fold.
 */
export async function AvailabilityBadge({ snapshot, className }: AvailabilityBadgeProps) {
  const t = await getTranslations('home.hero');

  const dotColor = snapshot ? dotColorByStatus[snapshot.status] : 'var(--color-accent)';

  let label: string;
  if (!snapshot) {
    label = t('available');
  } else if (snapshot.status === 'full') {
    label = t('fullUntil', { month: snapshot.nextAvailableMonth });
  } else if (snapshot.status === 'last_slot') {
    label = t('lastSlot');
  } else {
    label = t('availableCount', { used: snapshot.used, max: snapshot.max });
  }

  return (
    <span
      className={`inline-flex items-center gap-3 text-xs uppercase tracking-[0.2em] ${className ?? ''}`}
      style={{ color: 'var(--color-ink-muted)' }}
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="inline-block size-1.5"
        style={{ background: dotColor }}
      />
      {label}
    </span>
  );
}
