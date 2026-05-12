import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PortalLabel, PortalH3, PortalBody } from './ui/typography';

export interface TimelineItem {
  /** Mono date/eyebrow on the left rail. */
  date: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Optional CTA shown right of the title (e.g. "Rinnova"). */
  action?: ReactNode;
  /** Visual emphasis for status: 'urgent' tints accent, 'done' mutes. */
  status?: 'default' | 'urgent' | 'done';
}

interface PortalTimelineProps {
  items: TimelineItem[];
}

const DOT: Record<NonNullable<TimelineItem['status']>, string> = {
  default: 'bg-border-strong',
  urgent: 'bg-primary',
  done: 'bg-muted-foreground/40',
};

/**
 * Vertical timeline — left rail with date + dot, right column with title +
 * description + optional action. Hairline rows, no shadow, portal type scale.
 * Used for milestones, renewal deadlines, activity logs.
 */
export function PortalTimeline({ items }: PortalTimelineProps) {
  return (
    <ol className="flex flex-col border border-border bg-card rounded-sm overflow-hidden">
      {items.map((it, idx) => {
        const status = it.status ?? 'default';
        return (
          <li
            key={idx}
            className={cn(
              'grid grid-cols-[88px_1fr] md:grid-cols-[120px_1fr] gap-4 md:gap-6 p-4 md:p-5',
              idx > 0 && 'border-t border-border',
              status === 'done' && 'opacity-60'
            )}
          >
            <div className="flex items-start gap-2.5 pt-0.5">
              <span aria-hidden className={cn('block size-1.5 mt-1.5 rounded-sm shrink-0', DOT[status])} />
              <PortalLabel className="font-mono">{it.date}</PortalLabel>
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <PortalH3 className="font-[family-name:var(--font-display)] tracking-tight">
                  {it.title}
                </PortalH3>
                {it.action && <span className="shrink-0">{it.action}</span>}
              </div>
              {it.description && (
                <PortalBody className="text-muted-foreground max-w-[60ch]">
                  {it.description}
                </PortalBody>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
