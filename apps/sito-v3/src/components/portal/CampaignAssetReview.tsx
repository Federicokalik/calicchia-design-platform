'use client';

import { useState, useTransition } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  approveCampaignAssetAction,
  requestCampaignAssetRevisionAction,
} from '@/lib/portal-actions';
import type { PortalCampaignAsset } from '@/lib/portal-api';

interface CampaignAssetReviewProps {
  campaignId: string;
  assets: PortalCampaignAsset[];
}

const APPROVAL_LABEL: Record<string, string> = {
  pending: 'DA APPROVARE',
  approved: 'APPROVATO',
  rejected: 'RIFIUTATO',
  revision_requested: 'MODIFICHE RICHIESTE',
};

export function CampaignAssetReview({ campaignId, assets }: CampaignAssetReviewProps) {
  const router = useRouter();
  const [openRevisionId, setOpenRevisionId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!assets.length) {
    return (
      <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        Nessun asset da revisionare.
      </p>
    );
  }

  return (
    <div className="flex flex-col" style={{ borderTop: '1px solid var(--color-border)' }}>
      {assets.map((asset) => {
        const inReview = asset.approval_status === 'pending';
        const isImage = asset.asset_type === 'image' || asset.asset_type === 'graphic';

        return (
          <article
            key={asset.id}
            className="grid grid-cols-1 gap-5 py-6"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <div className="flex flex-col gap-2">
              <MonoLabel tone={inReview ? 'accent' : 'muted'}>
                {APPROVAL_LABEL[asset.approval_status] ?? asset.approval_status.toUpperCase()}
              </MonoLabel>
              <h3
                className="font-[family-name:var(--font-display)] text-xl"
                style={{ fontWeight: 500, letterSpacing: '-0.015em' }}
              >
                {asset.asset_name} <span style={{ color: 'var(--color-text-secondary)' }}>· v{asset.version}</span>
              </h3>

              {isImage && asset.file_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={asset.file_url}
                  alt={asset.asset_name}
                  className="max-w-md w-full rounded-sm border"
                  style={{ borderColor: 'var(--color-border)' }}
                />
              )}
              {asset.asset_type === 'copy' && asset.notes && (
                <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--color-text-secondary)' }}>
                  {asset.notes}
                </p>
              )}
              {!isImage && asset.file_url && (
                <a
                  href={asset.file_url}
                  className="text-xs uppercase tracking-[0.18em] hover:opacity-60 transition-hover-opacity"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Apri file
                </a>
              )}

              {asset.feedback && asset.feedback.length > 0 && (
                <div className="flex flex-col gap-1 pt-2">
                  {asset.feedback.map((f) => (
                    <p key={f.id} className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                      <strong>{f.author_name || (f.author_type === 'client' ? 'Tu' : 'Studio')}:</strong>{' '}
                      {f.feedback_text}
                    </p>
                  ))}
                </div>
              )}
            </div>

            {inReview && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    disabled={isPending && pendingId === asset.id}
                    onClick={() => {
                      setPendingId(asset.id);
                      startTransition(async () => {
                        await approveCampaignAssetAction(asset.id, campaignId);
                        router.refresh();
                      });
                    }}
                  >
                    Approva
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setOpenRevisionId((current) => (current === asset.id ? null : asset.id))}
                  >
                    Richiedi modifiche
                  </Button>
                </div>

                {openRevisionId === asset.id && (
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const formData = new FormData(event.currentTarget);
                      setPendingId(asset.id);
                      startTransition(async () => {
                        await requestCampaignAssetRevisionAction(asset.id, campaignId, formData);
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
                    <Button type="submit" disabled={isPending && pendingId === asset.id}>
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
