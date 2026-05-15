'use client';

import { useState, useTransition } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  approveDeliverableAction,
  requestRevisionsAction,
} from '@/lib/portal-actions';
import type { PortalDeliverable } from '@/lib/portal-api';

interface DeliverableReviewProps {
  projectId: string;
  deliverables: PortalDeliverable[];
}

export function DeliverableReview({ projectId, deliverables }: DeliverableReviewProps) {
  // TODO P0-06 polish: inline version preview, feedback history and disabled states per status.
  const router = useRouter();
  const [openRevisionId, setOpenRevisionId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!deliverables.length) {
    return (
      <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        Nessun deliverable da revisionare.
      </p>
    );
  }

  return (
    <div className="flex flex-col" style={{ borderTop: '1px solid var(--color-border)' }}>
      {deliverables.map((deliverable) => {
        const inReview = deliverable.status === 'client_review';
        const latest = deliverable.versions.find((version) => version.is_current) ?? deliverable.versions[0];

        return (
          <article
            key={deliverable.id}
            className="grid grid-cols-1 gap-5 py-6"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <div className="flex flex-col gap-2">
              <MonoLabel tone={inReview ? 'accent' : 'muted'}>
                {deliverable.status.toUpperCase()}
              </MonoLabel>
              <h3
                className="font-[family-name:var(--font-display)] text-xl"
                style={{ fontWeight: 500, letterSpacing: '-0.015em' }}
              >
                {deliverable.title}
              </h3>
              {deliverable.description && (
                <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                  {deliverable.description}
                </p>
              )}
              {latest?.file_url && (
                <a
                  href={latest.file_url}
                  className="text-xs uppercase tracking-[0.18em] hover:opacity-60 transition-hover-opacity"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Apri versione corrente
                </a>
              )}
            </div>

            {inReview && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    disabled={isPending && pendingId === deliverable.id}
                    onClick={() => {
                      setPendingId(deliverable.id);
                      startTransition(async () => {
                        await approveDeliverableAction(deliverable.id, projectId);
                        router.refresh();
                      });
                    }}
                  >
                    Approva
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setOpenRevisionId((current) => (current === deliverable.id ? null : deliverable.id))}
                  >
                    Richiedi modifiche
                  </Button>
                </div>

                {openRevisionId === deliverable.id && (
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const formData = new FormData(event.currentTarget);
                      setPendingId(deliverable.id);
                      startTransition(async () => {
                        await requestRevisionsAction(deliverable.id, projectId, formData);
                        setOpenRevisionId(null);
                        router.refresh();
                      });
                    }}
                  >
                    <label className="flex flex-col gap-3">
                      <MonoLabel>NOTE REVISIONE</MonoLabel>
                      <textarea
                        name="notes"
                        required
                        rows={4}
                        className="w-full resize-y px-4 py-4 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{
                          background: 'var(--color-surface)',
                          border: '1px solid var(--color-border-strong)',
                          color: 'var(--color-text-primary)',
                        }}
                      />
                    </label>
                    <Button type="submit" disabled={isPending && pendingId === deliverable.id}>
                      Invia richiesta
                    </Button>
                  </form>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
