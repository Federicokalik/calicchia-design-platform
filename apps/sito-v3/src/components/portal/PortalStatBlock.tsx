import type { ReactNode } from 'react';
import { PortalLabel, PortalCaption } from './ui/typography';

interface Stat {
  label: ReactNode;
  value: ReactNode;
  /** Optional secondary line under the value (e.g. "+12% vs ultimo mese"). */
  trend?: ReactNode;
}

export interface PortalStatBlockProps {
  stats: Stat[];
  /** Optional eyebrow above the stats. */
  eyebrow?: ReactNode;
}

/**
 * Hairline-divided stats grid — squared island, portal type scale. Big
 * numerical value uses Funnel Display via global h*-rule fallback (rendered
 * as `<span>` so we apply the family explicitly via `font-display`).
 */
export function PortalStatBlock({ stats, eyebrow }: PortalStatBlockProps) {
  return (
    <section className="flex flex-col gap-4">
      {eyebrow && <PortalLabel>{eyebrow}</PortalLabel>}
      <div className="grid grid-cols-2 lg:grid-cols-4 border border-border bg-card rounded-sm overflow-hidden">
        {stats.map((s, idx) => (
          <div
            key={idx}
            className={`p-5 md:p-6 flex flex-col gap-1.5 ${
              idx > 0 ? 'border-l border-border' : ''
            } ${idx >= 2 ? 'lg:border-l border-t lg:border-t-0 border-border' : ''}`}
          >
            <span
              className="font-[family-name:var(--font-display)] text-3xl tabular-nums tracking-tight font-medium leading-none"
            >
              {s.value}
            </span>
            <PortalLabel>{s.label}</PortalLabel>
            {s.trend && (
              <PortalCaption className="text-muted-foreground/80">{s.trend}</PortalCaption>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
