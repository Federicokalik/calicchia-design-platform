import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Plus, Package, Pencil, Trash2, RefreshCw, CheckCircle2, AlertCircle,
  Repeat, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ServiceFormDialog } from '@/components/servizi/service-form-dialog';

export interface Service {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  billing_interval: 'month' | 'year' | 'one_time';
  category: 'hosting' | 'domain' | 'maintenance' | 'development' | 'other';
  is_active: boolean;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  paypal_product_id: string | null;
  paypal_plan_id: string | null;
  created_at: string;
  updated_at: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  hosting: 'Hosting',
  domain: 'Dominio',
  maintenance: 'Manutenzione',
  development: 'Sviluppo',
  other: 'Altro',
};

const INTERVAL_LABEL: Record<string, string> = {
  one_time: 'Una tantum',
  month: 'Mensile',
  year: 'Annuale',
};

function formatEUR(amount: number | string, currency = 'EUR'): string {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency }).format(
    Number(amount) || 0,
  );
}

export default function ServiziPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Service | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useTopbar({ title: 'Servizi & Prodotti', subtitle: 'Catalogo riusabile per fatture e abbonamenti' });

  const { data, isLoading } = useQuery<{ services: Service[] }>({
    queryKey: ['services'],
    queryFn: () => apiFetch('/api/services'),
  });
  const list = data?.services ?? [];

  const allSelected = list.length > 0 && selected.size === list.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleAll() {
    if (selected.size === list.length) setSelected(new Set());
    else setSelected(new Set(list.map((s) => s.id)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/services/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Servizio eliminato');
      queryClient.invalidateQueries({ queryKey: ['services'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore eliminazione'),
  });

  const syncStripeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/services/${id}/sync-stripe`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Sync Stripe completato');
      queryClient.invalidateQueries({ queryKey: ['services'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore sync Stripe'),
  });

  const syncPaypalMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/services/${id}/sync-paypal`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Sync PayPal completato');
      queryClient.invalidateQueries({ queryKey: ['services'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore sync PayPal'),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch('/api/services/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
    onSuccess: (data: { deleted: number; blocked: Array<{ name: string }> }) => {
      if (data.deleted > 0) toast.success(`${data.deleted} servizi eliminati`);
      if (data.blocked.length > 0) {
        toast.warning(`${data.blocked.length} non eliminabili (in uso): ${data.blocked.slice(0, 3).map((b) => b.name).join(', ')}${data.blocked.length > 3 ? '…' : ''}`);
      }
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['services'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore eliminazione'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {list.length} {list.length === 1 ? 'servizio' : 'servizi'} totali
          {selected.size > 0 && ` · ${selected.size} selezionati`}
        </p>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirm(`Eliminare ${selected.size} servizi selezionati?\nI servizi linkati ad abbonamenti attivi saranno saltati.`)) {
                  bulkDeleteMutation.mutate([...selected]);
                }
              }}
              disabled={bulkDeleteMutation.isPending}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Elimina {selected.size}
            </Button>
          )}
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Nuovo servizio
          </Button>
        </div>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : list.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Nessun servizio nel catalogo"
          description="Crea servizi riusabili (logo design, hosting, retainer) per pre-popolare fatture e abbonamenti."
        >
          <Button onClick={() => setCreating(true)} size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Crea il primo servizio
          </Button>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={toggleAll}
                    aria-label="Seleziona tutti"
                  />
                </TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Intervallo</TableHead>
                <TableHead className="text-right">Prezzo</TableHead>
                <TableHead>Sync</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((svc) => (
                <TableRow key={svc.id} data-state={selected.has(svc.id) ? 'selected' : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(svc.id)}
                      onCheckedChange={() => toggleOne(svc.id)}
                      aria-label={`Seleziona ${svc.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{svc.name}</div>
                    {svc.description && (
                      <div className="text-xs text-muted-foreground line-clamp-1">{svc.description}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {CATEGORY_LABEL[svc.category] ?? svc.category}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      {svc.billing_interval === 'one_time' ? (
                        <Zap className="h-3 w-3" />
                      ) : (
                        <Repeat className="h-3 w-3" />
                      )}
                      {INTERVAL_LABEL[svc.billing_interval]}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatEUR(svc.price, svc.currency)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <SyncBadge
                        label="Stripe"
                        synced={!!svc.stripe_price_id}
                        applicable
                      />
                      <SyncBadge
                        label="PayPal"
                        synced={!!svc.paypal_plan_id}
                        applicable={svc.billing_interval !== 'one_time'}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn(
                        'text-xs',
                        svc.is_active
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                          : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400',
                      )}
                    >
                      {svc.is_active ? 'Attivo' : 'Disattivo'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-8 w-8">
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(svc)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Modifica
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => syncStripeMutation.mutate(svc.id)}
                          disabled={syncStripeMutation.isPending}
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          {svc.stripe_price_id ? 'Aggiorna Stripe' : 'Sync con Stripe'}
                        </DropdownMenuItem>
                        {svc.billing_interval !== 'one_time' && (
                          <DropdownMenuItem
                            onClick={() => syncPaypalMutation.mutate(svc.id)}
                            disabled={syncPaypalMutation.isPending}
                          >
                            <RefreshCw className="mr-2 h-4 w-4" />
                            {svc.paypal_plan_id ? 'Aggiorna PayPal' : 'Sync con PayPal'}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => {
                            if (confirm(`Eliminare il servizio "${svc.name}"?`)) {
                              deleteMutation.mutate(svc.id);
                            }
                          }}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Elimina
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ServiceFormDialog
        open={creating}
        onOpenChange={setCreating}
        mode="create"
      />
      <ServiceFormDialog
        open={!!editing}
        onOpenChange={(v) => { if (!v) setEditing(null); }}
        mode="edit"
        service={editing ?? undefined}
      />
    </div>
  );
}

function SyncBadge({
  label,
  synced,
  applicable,
}: {
  label: string;
  synced: boolean;
  applicable: boolean;
}) {
  if (!applicable) {
    return (
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
        {label}: n/a
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider',
        synced ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400',
      )}
    >
      {synced ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}
