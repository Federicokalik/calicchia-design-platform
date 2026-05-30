import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';
import { useConfirm } from '@/hooks/use-confirm';
import { cn } from '@/lib/utils';
import {
  PAYMENT_METHODS, PAYMENT_METHOD_LABELS, PAYMENT_METHOD_COLORS,
  type PaymentMethod,
} from '@/types/projects';

type IncomeRow = {
  id: string;
  description: string;
  amount: number | string;
  status: string;
  due_date: string | null;
  paid_date: string | null;
  paid_amount: number | string | null;
  notes: string | null;
  external_ref: string | null;
  payment_method: PaymentMethod | null;
  customer_id: string | null;
  project_id: string | null;
  source: 'manual' | 'auto';
  provider: string | null;
  customer_name?: string | null;
};

type FormState = {
  description: string;
  amount: string;
  status: string;
  paid_date: string;
  paid_amount: string;
  payment_method: PaymentMethod | '';
  external_ref: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  description: '',
  amount: '',
  status: 'pagata',
  paid_date: new Date().toISOString().slice(0, 10),
  paid_amount: '',
  payment_method: '',
  external_ref: '',
  notes: '',
};

const STATUS_LABELS: Record<string, string> = {
  emessa: 'Emessa',
  pagata: 'Pagata',
  parziale: 'Parziale',
  scaduta: 'Scaduta',
  annullata: 'Annullata',
};

const STATUS_COLORS: Record<string, string> = {
  emessa: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  pagata: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  parziale: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  scaduta: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  annullata: 'bg-gray-100 text-gray-500 dark:bg-gray-900/30 dark:text-gray-400 line-through',
};

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatEUR(value: number) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function ProjectIncomePanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const queryKey = ['project-income', projectId];

  const { data, isLoading } = useQuery<{ payments: IncomeRow[] }>({
    queryKey,
    queryFn: () => apiFetch(`/api/payment-tracker?project_id=${encodeURIComponent(projectId)}`),
  });
  const rows: IncomeRow[] = data?.payments ?? [];

  const [editing, setEditing] = useState<IncomeRow | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
    queryClient.invalidateQueries({ queryKey: ['payment-tracker'] });
  };

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch('/api/payment-tracker', {
        method: 'POST',
        body: JSON.stringify({ ...payload, project_id: projectId }),
      }),
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setForm(EMPTY_FORM);
      toast.success('Incasso registrato');
    },
    onError: (err: Error) => toast.error(err.message || 'Errore durante la registrazione'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      apiFetch(`/api/payment-tracker/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      toast.success('Incasso aggiornato');
    },
    onError: (err: Error) => toast.error(err.message || 'Aggiornamento fallito'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/payment-tracker/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      toast.success('Incasso eliminato');
    },
    onError: (err: Error) => toast.error(err.message || 'Eliminazione fallita'),
  });

  const totals = useMemo(() => {
    const byMethod = new Map<PaymentMethod | 'unknown', number>();
    let grandTotal = 0;
    for (const r of rows) {
      const isCollected = r.status === 'pagata' || r.status === 'parziale';
      if (!isCollected) continue;
      const value = num(r.paid_amount) || num(r.amount);
      const method = (r.payment_method ?? 'unknown') as PaymentMethod | 'unknown';
      byMethod.set(method, (byMethod.get(method) || 0) + value);
      grandTotal += value;
    }
    return { grandTotal, byMethod };
  }, [rows]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  }

  function openEdit(row: IncomeRow) {
    if (row.source !== 'manual') {
      toast.info('I pagamenti automatici (Stripe/PayPal/Revolut) non sono modificabili da qui');
      return;
    }
    setEditing(row);
    setForm({
      description: row.description ?? '',
      amount: String(num(row.amount)),
      status: row.status ?? 'pagata',
      paid_date: row.paid_date ?? '',
      paid_amount: row.paid_amount != null ? String(num(row.paid_amount)) : '',
      payment_method: row.payment_method ?? '',
      external_ref: row.external_ref ?? '',
      notes: row.notes ?? '',
    });
    setOpen(true);
  }

  function handleSubmit() {
    const amount = Number(form.amount);
    if (!form.description.trim()) {
      toast.error('Descrizione richiesta');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Importo non valido');
      return;
    }
    const payload: Record<string, unknown> = {
      description: form.description.trim(),
      amount,
      status: form.status,
      payment_method: form.payment_method || null,
      paid_date: form.paid_date || null,
      paid_amount: form.paid_amount ? Number(form.paid_amount) : amount,
      external_ref: form.external_ref.trim() || null,
      notes: form.notes.trim() || null,
    };
    if (editing) updateMutation.mutate({ id: editing.id, payload });
    else createMutation.mutate(payload);
  }

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Totale incassato</p>
          <p className="text-2xl font-semibold">{formatEUR(totals.grandTotal)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {Array.from(totals.byMethod.entries()).map(([method, value]) => (
            <Badge
              key={method}
              variant="outline"
              className={cn(
                'gap-1.5 border-0 px-2.5 py-1 text-xs',
                method !== 'unknown' && PAYMENT_METHOD_COLORS[method as PaymentMethod],
              )}
            >
              <span>{method === 'unknown' ? 'Non specificato' : PAYMENT_METHOD_LABELS[method as PaymentMethod]}</span>
              <span className="font-semibold">{formatEUR(value)}</span>
            </Badge>
          ))}
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> Registra incasso
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nessun incasso registrato"
          description="Registra incassi PayPal, contanti, bonifico o altro per questo progetto."
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Data</th>
                <th className="px-3 py-2 text-left font-medium">Descrizione</th>
                <th className="px-3 py-2 text-left font-medium">Metodo</th>
                <th className="px-3 py-2 text-left font-medium">Stato</th>
                <th className="px-3 py-2 text-right font-medium">Importo</th>
                <th className="px-3 py-2 text-right font-medium">Incassato</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isAuto = r.source === 'auto';
                const method = r.payment_method;
                return (
                  <tr key={r.id} className="border-t hover:bg-muted/20">
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {formatDate(r.paid_date || r.due_date)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span>{r.description}</span>
                        {isAuto && (
                          <Badge variant="outline" className="text-[10px]">
                            Auto
                          </Badge>
                        )}
                        {r.external_ref && (
                          <span className="text-xs text-muted-foreground" title={r.external_ref}>
                            <ExternalLink className="h-3 w-3 inline" />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {method ? (
                        <Badge variant="outline" className={cn('border-0', PAYMENT_METHOD_COLORS[method])}>
                          {PAYMENT_METHOD_LABELS[method]}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={cn('border-0', STATUS_COLORS[r.status] || '')}>
                        {STATUS_LABELS[r.status] || r.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{formatEUR(num(r.amount))}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {r.paid_amount != null ? formatEUR(num(r.paid_amount)) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!isAuto && (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => openEdit(r)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-red-600 hover:text-red-700"
                            onClick={async () => {
                              if (await confirm({ title: 'Eliminare questo incasso?', variant: 'destructive' })) deleteMutation.mutate(r.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Modifica incasso' : 'Registra incasso'}</DialogTitle>
            <DialogDescription>
              Incassi non tracciati: PayPal, contanti, bonifico fuori-flusso, ecc.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Descrizione *</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Es. Acconto lavoro esterno"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Importo (€) *</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Metodo</Label>
                <Select
                  value={form.payment_method || 'none'}
                  onValueChange={(v) => setForm({ ...form, payment_method: v === 'none' ? '' : (v as PaymentMethod) })}
                >
                  <SelectTrigger><SelectValue placeholder="Metodo" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Non specificato</SelectItem>
                    {PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Stato</Label>
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(STATUS_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Data incasso</Label>
                <Input
                  type="date"
                  value={form.paid_date}
                  onChange={(e) => setForm({ ...form, paid_date: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Riferimento esterno</Label>
              <Input
                value={form.external_ref}
                onChange={(e) => setForm({ ...form, external_ref: e.target.value })}
                placeholder="Es. PayPal txn ID, n. bonifico"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Note</Label>
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Annulla</Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {editing ? 'Salva' : 'Registra'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
