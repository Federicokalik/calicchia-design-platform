import type { ReactNode } from 'react';
import { PortalLabel, PortalH2, PortalBody } from './ui/typography';

interface PortalEmptyStateProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Optional CTA shown below the description. */
  action?: ReactNode;
}

/**
 * Empty state — squared dashed border (signals "placeholder, will fill"),
 * portal type scale, breathing room. Used for "nessun progetto attivo",
 * "nessuna fattura aperta", ecc.
 */
export function PortalEmptyState({
  eyebrow,
  title,
  description,
  action,
}: PortalEmptyStateProps) {
  return (
    <div className="flex flex-col items-start gap-4 p-8 md:p-10 border border-dashed border-border-strong rounded-sm bg-card/40">
      {eyebrow && <PortalLabel>{eyebrow}</PortalLabel>}
      <PortalH2 className="max-w-[24ch]">{title}</PortalH2>
      {description && (
        <PortalBody className="text-muted-foreground max-w-[55ch]">
          {description}
        </PortalBody>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
