import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Plus, Search, MoreHorizontal, CheckCircle2, Link2, Trash2,
  Euro, Clock, AlertTriangle, Calendar,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CreateScheduleDialog } from './create-schedule-dialog';
import CreateLinkDialog from './create-link-dialog';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  pending: {
    label: 'In attesa',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  },
  due: {
    label: 'In scadenza',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  },
  paid: {
    label: 'Pagato',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  },
  overdue: {
    label: 'Scaduto',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  },
  partial: {
    label: 'Parziale',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  },
  cancelled: {
    label: 'Annullato',
    className: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400',
  },
};

const TYPE_LABELS: Record<string, string> = {
  deposit: 'Acconto',
  milestone: 'Milestone',
  balance: 'Saldo',
  installment: 'Rata',
};

function formatEUR(amount: number | string): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(amount) || 0);
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(dateStr));
}

function isOverdue(dateStr: string, status: string): boolean {
  if (status === 'paid' || status === 'cancelled') return false;
  return new Date(dateStr) < new Date();
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SchedulesTab() {
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState<string | null>(null);

  /* ---------- queries ---------- */

  const { data, isLoading } = useQuery({
    queryKey: ['payment-schedules', statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== 'all') {
        if (statusFilter === 'overdue') {
          params.set('overdue', 'true');
        } else {
          params.set('status', statusFilter);
        }
      }
      const qs = params.toString();
      return apiFetch(`/api/payments/schedules${qs ? `?${qs}` : ''}`);
    },
  });

  const schedules: any[] = data?.schedules ?? [];
  const stats = data?.stats ?? {
    total: 0,
    pending: 0,
    overdue: 0,
    paid: 0,
    total_amount: 0,
    paid_amount: 0,
    pending_amount: 0,
  };

  /* ---------- mutations ---------- */

  const markPaidMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/payments/schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'paid' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-schedules'] });
      toast.success('Pagamento segnato come incassato');
    },
    onError: () => toast.error('Errore durante l\'aggiornamento'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/payments/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-schedules'] });
      toast.success('Scadenza eliminata');
    },
    onError: () => toast.error('Impossibile eliminare la scadenza'),
  });

  /* ---------- derived ---------- */

  const filtered = schedules.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    const title = (s.title || '').toLowerCase();
    const customer =
      (s.customer?.company_name || s.customer?.contact_name || '').toLowerCase();
    return title.includes(q) || customer.includes(q);
  });

  /* ---------- render ---------- */

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          label="Totale"
          value={formatEUR(stats.total_amount)}
          icon={Euro}
          className="text-foreground"
        />
        <KpiCard
          label="Da incassare"
          value={formatEUR(stats.pending_amount)}
          icon={Clock}
          className="text-amber-600 dark:text-amber-400"
        />
        <KpiCard
          label="Scaduto"
          value={String(stats.overdue ?? 0)}
          icon={AlertTriangle}
          className="text-red-600 dark:text-red-400"
        />
      </div>

      {/* Filter bar + actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Stato" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti</SelectItem>
            <SelectItem value="pending">In attesa</SelectItem>
            <SelectItem value="overdue">Scaduto</SelectItem>
            <SelectItem value="paid">Pagato</SelectItem>
            <SelectItem value="partial">Parziale</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Cerca per titolo o cliente..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="ml-auto">
          <Button size="sm" onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Nuovo pagamento
          </Button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 rounded-lg bg-muted/40 animate-pulse"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Nessuna scadenza"
          description="Crea un nuovo pagamento programmato per iniziare a tracciare gli incassi."
          icon={Calendar}
        />
      ) : (
        <div className="rounded-lg border bg-card divide-y divide-border">
          {filtered.map((schedule) => {
            const overdue = isOverdue(schedule.due_date, schedule.status);
            const statusInfo = STATUS_MAP[schedule.status] ?? STATUS_MAP.pending;
            const customerName =
              schedule.customer?.company_name ||
              schedule.customer?.contact_name ||
              '';

            return (
              <div
                key={schedule.id}
                className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors"
              >
                {/* Title + customer */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {schedule.title}
                    {schedule.schedule_type && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {TYPE_LABELS[schedule.schedule_type] ?? schedule.schedule_type}
                      </span>
                    )}
                  </p>
                  {customerName && (
                    <p className="text-xs text-muted-foreground truncate">
                      {customerName}
                    </p>
                  )}
                </div>

                {/* Amount */}
                <div className="text-sm font-semibold tabular-nums whitespace-nowrap">
                  {formatEUR(schedule.amount)}
                </div>

                {/* Due date */}
                <div
                  className={cn(
                    'text-xs whitespace-nowrap',
                    overdue
                      ? 'text-red-600 dark:text-red-400 font-medium'
                      : 'text-muted-foreground',
                  )}
                >
                  {formatDate(schedule.due_date)}
                </div>

                {/* Status badge */}
                <Badge
                  variant="secondary"
                  className={cn('text-[11px] capitalize', statusInfo.className)}
                >
                  {statusInfo.label}
                </Badge>

                {/* Actions */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => markPaidMutation.mutate(schedule.id)}
                      disabled={schedule.status === 'paid'}
                    >
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Segna pagato
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setShowLinkDialog(schedule.id)}
                    >
                      <Link2 className="h-4 w-4 mr-2" />
                      Crea link pagamento
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-red-600 dark:text-red-400"
                      onClick={() => {
                        if (
                          window.confirm(
                            'Eliminare questa scadenza? L\'azione non e reversibile.',
                          )
                        ) {
                          deleteMutation.mutate(schedule.id);
                        }
                      }}
                      disabled={schedule.status !== 'pending'}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Elimina
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      )}

      {/* Dialogs */}
      {showCreateDialog && (
        <CreateScheduleDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={() =>
            queryClient.invalidateQueries({ queryKey: ['payment-schedules'] })
          }
        />
      )}

      {showLinkDialog && (
        <CreateLinkDialog
          open={!!showLinkDialog}
          scheduleId={showLinkDialog}
          onOpenChange={(open: boolean) => {
            if (!open) setShowLinkDialog(null);
          }}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ['payment-schedules'] })}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  KPI Card                                                           */
/* ------------------------------------------------------------------ */

function KpiCard({
  label,
  value,
  icon: Icon,
  className,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  className?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={cn('h-4 w-4', className)} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={cn('text-xl font-semibold tabular-nums', className)}>
        {value}
      </p>
    </div>
  );
}
