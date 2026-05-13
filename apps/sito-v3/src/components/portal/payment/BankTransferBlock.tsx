'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/portal/ui/button';
import { PortalLabel } from '@/components/portal/ui/typography';

export interface BankDetails {
  iban: string;
  bic: string;
  holder_name: string;
  causal: string;
  amount: number;
  currency: string;
}

interface BankTransferBlockProps {
  details: BankDetails;
}

interface CopyRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function CopyRow({ label, value, mono }: CopyRowProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[BankTransferBlock] clipboard error:', err);
    }
  }

  return (
    <div className="flex items-start justify-between gap-3 border-b border-border py-2.5 last:border-0">
      <div className="flex flex-col gap-0.5 min-w-0">
        <PortalLabel className="text-muted-foreground">{label}</PortalLabel>
        <span
          className={
            mono
              ? 'text-portal-body font-mono text-foreground break-all'
              : 'text-portal-body text-foreground break-words'
          }
        >
          {value || '—'}
        </span>
      </div>
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          aria-label={`Copia ${label}`}
          className="shrink-0 h-8 px-2"
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      )}
    </div>
  );
}

export function BankTransferBlock({ details }: BankTransferBlockProps) {
  const t = useTranslations('portal.payment.bankTransfer');
  const amountLabel = new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: details.currency,
  }).format(details.amount);

  return (
    <div className="flex flex-col gap-4 rounded-sm border border-border bg-background p-5">
      <div className="flex flex-col gap-1">
        <PortalLabel>{t('eyebrow')}</PortalLabel>
        <p className="text-portal-body text-muted-foreground max-w-[55ch]">
          {t('intro')}
        </p>
      </div>

      <div className="flex flex-col">
        <CopyRow label={t('fields.iban')} value={details.iban} mono />
        <CopyRow label={t('fields.bic')} value={details.bic} mono />
        <CopyRow label={t('fields.holder')} value={details.holder_name} />
        <CopyRow label={t('fields.causal')} value={details.causal} />
        <CopyRow label={t('fields.amount')} value={amountLabel} />
      </div>

      <p className="text-portal-label uppercase tracking-wider text-muted-foreground">
        {t('confirmation')}
      </p>
    </div>
  );
}
