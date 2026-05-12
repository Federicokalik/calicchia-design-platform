import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Link2, Copy, RefreshCw, Ban, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { RefundButton } from './refund-button';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const PROVIDERS = [
  { value: '', label: 'Tutti' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'revolut', label: 'Revolut' },
  { value: 'bank_transfer', label: 'Bonifico' },
] as const;

const STATUSES = [
  { value: 'all', label: 'Tutti' },
  { value: 'pending', label: 'In attesa' },
  { value: 'active', label: 'Attivo' },
  { value: 'paid', label: 'Pagato' },
  { value: 'partially_refunded', label: 'Rimborso parziale' },
  { value: 'refunded', label: 'Rimborsato' },
  { value: 'expired', label: 'Scaduto' },
  { value: 'cancelled', label: 'Annullato' },
] as const;

const PROVIDER_BADGE: Record<string, string> = {
  stripe: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  paypal: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  revolut: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  bank_transfer: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400',
};

const PROVIDER_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  revolut: 'Revolut',
  bank_transfer: 'Bonifico',
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  active: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  paid: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  partially_refunded: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  refunded: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  expired: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'In attesa',
  active: 'Attivo',
  paid: 'Pagato',
  partially_refunded: 'Rimborso parziale',
  refunded: 'Rimborsato',
  expired: 'Scaduto',
  cancelled: 'Annullato',
};

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface PaymentLink {
  id: string;
  provider: 'stripe' | 'paypal' | 'revolut' | 'bank_transfer';
  checkout_url: string | null;
  amount: number;
  currency: string;
  status: string;
  refunded_amount?: number;
  refund_history?: unknown;
  paid_at?: string | null;
  payer_email?: string | null;
  provider_order_id: string | null;
  payment_schedule_id: string | null;
  created_at: string;
  payload_json: any;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function fmtEur(amount: number, currency = 'EUR') {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency }).format(amount);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function LinksTab() {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('all');

  /* ---- Query ---- */
  const { data, isLoading } = useQuery({
    queryKey: ['payment-links', provider, status],
    queryFn: () => {
      const params = new URLSearchParams();
      if (provider) params.set('provider', provider);
      if (status) params.set('status', status);
      const qs = params.toString();
      return apiFetch(`/api/payments/links${qs ? `?${qs}` : ''}`);
    },
  });

  const links: PaymentLink[] = data?.links ?? [];

  /* ---- Mutations ---- */
  const refreshMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/payments/links/${id}/refresh`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-links'] });
      toast.success('Stato aggiornato');
    },
    onError: () => toast.error('Impossibile aggiornare lo stato'),
  });

  const voidMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/payments/links/${id}/void`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-links'] });
      toast.success('Link annullato');
    },
    onError: () => toast.error('Impossibile annullare il link'),
  });

  /* ---- Handlers ---- */
  function copyUrl(url: string) {
    navigator.clipboard.writeText(url).then(
      () => toast.success('URL copiato negli appunti'),
      () => toast.error('Impossibile copiare'),
    );
  }

  /* ---- Render ---- */
  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {PROVIDERS.map((p) => (
          <Button
            key={p.value}
            size="sm"
            variant={provider === p.value ? 'default' : 'outline'}
            onClick={() => setProvider(p.value)}
          >
            {p.label}
          </Button>
        ))}

        <div className="mx-2 h-6 w-px bg-border" />

        {STATUSES.map((s) => (
          <Button
            key={s.value}
            size="sm"
            variant={status === s.value ? 'default' : 'outline'}
            onClick={() => setStatus(s.value)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : links.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="Nessun link di pagamento"
          description="Non ci sono link che corrispondono ai filtri selezionati."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                <th className="px-4 py-3 font-medium">Provider</th>
                <th className="px-4 py-3 font-medium">Importo</th>
                <th className="px-4 py-3 font-medium">Stato</th>
                <th className="px-4 py-3 font-medium">Data</th>
                <th className="px-4 py-3 font-medium text-right">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr
                  key={link.id}
                  className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                >
                  {/* Provider */}
                  <td className="px-4 py-3">
                    <Badge
                      variant="secondary"
                      className={cn('text-xs', PROVIDER_BADGE[link.provider])}
                    >
                      {PROVIDER_LABEL[link.provider] ?? link.provider}
                    </Badge>
                  </td>

                  {/* Amount */}
                  <td className="px-4 py-3 font-medium tabular-nums">
                    {fmtEur(link.amount, link.currency)}
                  </td>

                  {/* Status */}
                  <td className="px-4 py-3">
                    <Badge
                      variant="secondary"
                      className={cn('text-xs', STATUS_BADGE[link.status])}
                    >
                      {STATUS_LABEL[link.status] ?? link.status}
                    </Badge>
                  </td>

                  {/* Date */}
                  <td className="px-4 py-3 text-muted-foreground">
                    {fmtDate(link.created_at)}
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {/* Copy URL */}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        disabled={link.provider === 'bank_transfer' || !link.checkout_url}
                        onClick={() => link.checkout_url && copyUrl(link.checkout_url)}
                        title="Copia URL"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>

                      {/* Refresh */}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        disabled={refreshMutation.isPending}
                        onClick={() => refreshMutation.mutate(link.id)}
                        title="Aggiorna stato"
                      >
                        <RefreshCw
                          className={cn(
                            'h-4 w-4',
                            refreshMutation.isPending && 'animate-spin',
                          )}
                        />
                      </Button>

                      {/* Refund (Stripe & PayPal only) */}
                      {(link.status === 'paid' || link.status === 'partially_refunded') && (
                        <RefundButton
                          linkId={link.id}
                          provider={link.provider}
                          linkAmount={Number(link.amount)}
                          refundedAmount={Number(link.refunded_amount ?? 0)}
                          currency={link.currency}
                        />
                      )}

                      {/* Void */}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        disabled={
                          link.status === 'paid' ||
                          link.status === 'refunded' ||
                          link.status === 'partially_refunded' ||
                          voidMutation.isPending
                        }
                        onClick={() => voidMutation.mutate(link.id)}
                        title="Annulla link"
                      >
                        <Ban className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
