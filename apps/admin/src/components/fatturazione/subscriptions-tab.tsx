import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Plus, Repeat, XCircle, Loader2, ExternalLink, Settings, Bell, Pause,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CreateSubscriptionDialog } from './create-subscription-dialog';

interface SubscriptionRow {
  id: string;
  provider: 'stripe' | 'paypal';
  stripe_subscription_id: string | null;
  paypal_subscription_id: string | null;
  name: string;
  amount: number;
  currency: string;
  billing_interval: string;
  status: string;
  start_date: string | null;
  current_period_end: string | null;
  next_billing_date: string | null;
  canceled_at: string | null;
  auto_renew: boolean;
  dunning_grace_days?: number;
  dunning_reminder_days?: number[];
  dunning_suspend_days?: number;
  dunning_state?: 'none' | 'grace' | 'reminded' | 'suspended';
  last_dunning_at?: string | null;
  customers: {
    id: string;
    company_name: string | null;
    contact_name: string | null;
    email: string;
  } | null;
}

const DUNNING_STATE_LABEL: Record<string, string> = {
  none: '',
  grace: 'In grace',
  reminded: 'Reminder inviato',
  suspended: 'Sospeso',
};

const DUNNING_STATE_BADGE: Record<string, string> = {
  grace: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  reminded: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  suspended: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  trialing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  past_due: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  unpaid: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  canceled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400',
  incomplete: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  incomplete_expired: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400',
  APPROVAL_PENDING: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  ACTIVE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  SUSPENDED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  CANCELLED: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400',
};

const STATUS_LABEL: Record<string, string> = {
  active: 'Attivo',
  trialing: 'In prova',
  past_due: 'In ritardo',
  unpaid: 'Non pagato',
  canceled: 'Cancellato',
  incomplete: 'Incompleto',
  incomplete_expired: 'Scaduto',
  APPROVAL_PENDING: 'Attesa approvazione',
  ACTIVE: 'Attivo',
  SUSPENDED: 'Sospeso',
  CANCELLED: 'Cancellato',
};

const PROVIDER_BADGE: Record<string, string> = {
  stripe: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  paypal: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
};

function fmtEur(amount: number, currency = 'EUR') {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency }).format(amount);
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface DunningForm {
  next_billing_date: string;
  auto_renew: boolean;
  dunning_grace_days: string;
  dunning_reminder_days: string; // CSV: "3, 7, 14"
  dunning_suspend_days: string;
}

function parseReminderDaysCsv(csv: string): number[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 90);
}

export default function SubscriptionsTab() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SubscriptionRow | null>(null);
  const [form, setForm] = useState<DunningForm>({
    next_billing_date: '',
    auto_renew: true,
    dunning_grace_days: '7',
    dunning_reminder_days: '3, 7, 14',
    dunning_suspend_days: '30',
  });

  const { data, isLoading } = useQuery<{ subscriptions: SubscriptionRow[] }>({
    queryKey: ['subscriptions'],
    queryFn: () => apiFetch('/api/subscriptions'),
  });
  const subs = data?.subscriptions ?? [];

  const cancelMutation = useMutation({
    mutationFn: ({ id, atPeriodEnd }: { id: string; atPeriodEnd: boolean }) =>
      apiFetch(`/api/subscriptions/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ at_period_end: atPeriodEnd }),
      }),
    onSuccess: () => {
      toast.success('Abbonamento cancellato');
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore cancellazione'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiFetch(`/api/subscriptions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      toast.success('Regole aggiornate');
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      setEditing(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore aggiornamento'),
  });

  const openEdit = (sub: SubscriptionRow) => {
    setEditing(sub);
    setForm({
      next_billing_date: sub.next_billing_date?.slice(0, 10) ?? '',
      auto_renew: sub.auto_renew,
      dunning_grace_days: String(sub.dunning_grace_days ?? 7),
      dunning_reminder_days: (sub.dunning_reminder_days ?? [3, 7, 14]).join(', '),
      dunning_suspend_days: String(sub.dunning_suspend_days ?? 30),
    });
  };

  const handleSave = () => {
    if (!editing) return;
    const patch: Record<string, unknown> = {
      auto_renew: form.auto_renew,
      dunning_grace_days: parseInt(form.dunning_grace_days, 10) || 7,
      dunning_reminder_days: parseReminderDaysCsv(form.dunning_reminder_days),
      dunning_suspend_days: parseInt(form.dunning_suspend_days, 10) || 30,
    };
    if (form.next_billing_date) patch.next_billing_date = form.next_billing_date;
    else patch.next_billing_date = null;
    updateMutation.mutate({ id: editing.id, patch });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {subs.length} {subs.length === 1 ? 'abbonamento' : 'abbonamenti'}
        </p>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Nuovo abbonamento
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : subs.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="Nessun abbonamento"
          description="Crea il primo abbonamento ricorrente. Il cliente riceverà un link di autorizzazione PayPal o Stripe."
        >
          <Button onClick={() => setCreating(true)} size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Crea abbonamento
          </Button>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                <th className="px-4 py-3 font-medium">Cliente</th>
                <th className="px-4 py-3 font-medium">Servizio</th>
                <th className="px-4 py-3 font-medium">Provider</th>
                <th className="px-4 py-3 font-medium text-right">Importo</th>
                <th className="px-4 py-3 font-medium">Stato</th>
                <th className="px-4 py-3 font-medium">Prossima fatturazione</th>
                <th className="px-4 py-3 font-medium text-right">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {subs.map((sub) => {
                const customerLabel = sub.customers?.company_name
                  || sub.customers?.contact_name
                  || sub.customers?.email
                  || '—';
                const isActive = ['active', 'trialing', 'ACTIVE'].includes(sub.status);
                const externalId = sub.stripe_subscription_id ?? sub.paypal_subscription_id;
                return (
                  <tr key={sub.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">{customerLabel}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{sub.name}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {sub.billing_interval === 'month' ? 'Mensile' : sub.billing_interval === 'year' ? 'Annuale' : sub.billing_interval}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className={cn('text-xs', PROVIDER_BADGE[sub.provider])}>
                        {sub.provider === 'stripe' ? 'Stripe' : 'PayPal'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmtEur(sub.amount, sub.currency)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="secondary" className={cn('text-xs', STATUS_BADGE[sub.status])}>
                          {STATUS_LABEL[sub.status] ?? sub.status}
                        </Badge>
                        {!sub.auto_renew && isActive && (
                          <Badge variant="outline" className="text-[10px]">No rinnovo</Badge>
                        )}
                        {sub.dunning_state && sub.dunning_state !== 'none' && (
                          <Badge variant="secondary" className={cn('text-[10px] gap-1', DUNNING_STATE_BADGE[sub.dunning_state])}>
                            {sub.dunning_state === 'suspended' ? <Pause className="h-3 w-3" /> : <Bell className="h-3 w-3" />}
                            {DUNNING_STATE_LABEL[sub.dunning_state]}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{fmtDate(sub.next_billing_date)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => openEdit(sub)}
                          title="Modifica regole rinnovo & dunning"
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                        {externalId && (
                          <a
                            href={
                              sub.provider === 'stripe'
                                ? `https://dashboard.stripe.com/subscriptions/${externalId}`
                                : `https://www.paypal.com/billing/subscriptions/${externalId}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Apri su dashboard provider"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                        {isActive && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              if (confirm(`Cancellare l'abbonamento "${sub.name}" alla fine del periodo corrente?`)) {
                                cancelMutation.mutate({ id: sub.id, atPeriodEnd: true });
                              }
                            }}
                            disabled={cancelMutation.isPending}
                            title="Cancella a fine periodo"
                          >
                            <XCircle className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CreateSubscriptionDialog open={creating} onOpenChange={setCreating} />

      {/* Edit dunning rules */}
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Regole rinnovo & dunning</DialogTitle>
            <DialogDescription>
              {editing?.name}
              {editing?.customers?.contact_name && ` · ${editing.customers.contact_name}`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Prossima fatturazione</Label>
              <Input
                type="date"
                value={form.next_billing_date}
                onChange={(e) => setForm({ ...form, next_billing_date: e.target.value })}
                className="h-9 text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Determina quando inizia il conteggio del ritardo per il dunning.
              </p>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label className="text-xs font-medium">Rinnovo automatico</Label>
                <p className="text-[10px] text-muted-foreground">
                  Se disattivato, il dunning non agisce su questa subscription.
                </p>
              </div>
              <Switch
                checked={form.auto_renew}
                onCheckedChange={(v) => setForm({ ...form, auto_renew: v })}
              />
            </div>

            <div className="rounded-md border p-3 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recupero crediti (dunning)
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Giorni di grace</Label>
                  <Input
                    type="number"
                    min="0"
                    max="90"
                    value={form.dunning_grace_days}
                    onChange={(e) => setForm({ ...form, dunning_grace_days: e.target.value })}
                    className="h-9 text-sm tabular-nums"
                  />
                  <p className="text-[10px] text-muted-foreground">prima di iniziare</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Sospensione (giorni)</Label>
                  <Input
                    type="number"
                    min="0"
                    max="365"
                    value={form.dunning_suspend_days}
                    onChange={(e) => setForm({ ...form, dunning_suspend_days: e.target.value })}
                    className="h-9 text-sm tabular-nums"
                  />
                  <p className="text-[10px] text-muted-foreground">past_due + no auto-renew</p>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">Giorni reminder</Label>
                <Input
                  value={form.dunning_reminder_days}
                  onChange={(e) => setForm({ ...form, dunning_reminder_days: e.target.value })}
                  placeholder="3, 7, 14"
                  className="h-9 text-sm tabular-nums"
                />
                <p className="text-[10px] text-muted-foreground">
                  CSV — email reminder a questi giorni di ritardo.
                  Verranno usati: {parseReminderDaysCsv(form.dunning_reminder_days).join(', ') || '—'}
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Annulla</Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Salvataggio...' : 'Salva regole'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
