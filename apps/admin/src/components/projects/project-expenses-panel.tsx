import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil } from 'lucide-react';
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

const EXPENSE_CATEGORIES = [
  'software', 'hardware', 'office', 'travel', 'meals', 'training',
  'marketing', 'professional_services', 'utilities', 'other',
] as const;
type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  software: 'Software',
  hardware: 'Hardware',
  office: 'Ufficio',
  travel: 'Trasferte',
  meals: 'Pasti',
  training: 'Formazione',
  marketing: 'Marketing',
  professional_services: 'Servizi professionali',
  utilities: 'Utenze',
  other: 'Altro',
};

type ExpenseRow = {
  id: string;
  occurred_on: string;
  vendor: string | null;
  amount: number | string;
  vat_amount: number | string;
  category: ExpenseCategory;
  description: string | null;
  notes: string | null;
  payment_method: PaymentMethod | null;
  deductible_percent: number | string;
};

type FormState = {
  occurred_on: string;
  vendor: string;
  amount: string;
  vat_amount: string;
  category: ExpenseCategory;
  payment_method: PaymentMethod | '';
  description: string;
  notes: string;
  deductible_percent: string;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

const EMPTY_FORM: FormState = {
  occurred_on: todayISO(),
  vendor: '',
  amount: '',
  vat_amount: '0',
  category: 'other',
  payment_method: '',
  description: '',
  notes: '',
  deductible_percent: '100',
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

export function ProjectExpensesPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const queryKey = ['project-expenses', projectId];

  const { data, isLoading } = useQuery<{ expenses: ExpenseRow[] }>({
    queryKey,
    queryFn: () => apiFetch(`/api/expenses?project_id=${encodeURIComponent(projectId)}&limit=200`),
  });
  const rows: ExpenseRow[] = data?.expenses ?? [];

  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
    queryClient.invalidateQueries({ queryKey: ['expenses'] });
  };

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({ ...payload, project_id: projectId }),
      }),
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setForm(EMPTY_FORM);
      toast.success('Spesa registrata');
    },
    onError: (err: Error) => toast.error(err.message || 'Errore durante la registrazione'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      apiFetch(`/api/expenses/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      toast.success('Spesa aggiornata');
    },
    onError: (err: Error) => toast.error(err.message || 'Aggiornamento fallito'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/expenses/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      toast.success('Spesa eliminata');
    },
    onError: (err: Error) => toast.error(err.message || 'Eliminazione fallita'),
  });

  const totals = useMemo(() => {
    const byMethod = new Map<PaymentMethod | 'unknown', number>();
    const byCategory = new Map<ExpenseCategory, number>();
    let grandTotal = 0;
    for (const r of rows) {
      const value = num(r.amount);
      const method = (r.payment_method ?? 'unknown') as PaymentMethod | 'unknown';
      byMethod.set(method, (byMethod.get(method) || 0) + value);
      byCategory.set(r.category, (byCategory.get(r.category) || 0) + value);
      grandTotal += value;
    }
    return { grandTotal, byMethod, byCategory };
  }, [rows]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  }

  function openEdit(row: ExpenseRow) {
    setEditing(row);
    setForm({
      occurred_on: row.occurred_on?.slice(0, 10) ?? todayISO(),
      vendor: row.vendor ?? '',
      amount: String(num(row.amount)),
      vat_amount: String(num(row.vat_amount)),
      category: row.category,
      payment_method: row.payment_method ?? '',
      description: row.description ?? '',
      notes: row.notes ?? '',
      deductible_percent: String(num(row.deductible_percent) || 100),
    });
    setOpen(true);
  }

  function handleSubmit() {
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Importo non valido');
      return;
    }
    const payload: Record<string, unknown> = {
      occurred_on: form.occurred_on,
      vendor: form.vendor.trim() || null,
      amount,
      vat_amount: Number(form.vat_amount) || 0,
      category: form.category,
      payment_method: form.payment_method || null,
      description: form.description.trim() || null,
      notes: form.notes.trim() || null,
      deductible_percent: Number(form.deductible_percent) || 100,
    };
    if (editing) updateMutation.mutate({ id: editing.id, payload });
    else createMutation.mutate(payload);
  }

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Totale speso</p>
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
            <Plus className="h-4 w-4 mr-1.5" /> Registra spesa
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nessuna spesa registrata"
          description="Registra spese in contanti, PayPal, bonifico o altro relative a questo progetto."
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Data</th>
                <th className="px-3 py-2 text-left font-medium">Fornitore</th>
                <th className="px-3 py-2 text-left font-medium">Categoria</th>
                <th className="px-3 py-2 text-left font-medium">Metodo</th>
                <th className="px-3 py-2 text-right font-medium">Importo</th>
                <th className="px-3 py-2 text-right font-medium">IVA</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t hover:bg-muted/20">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDate(r.occurred_on)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span>{r.vendor || '—'}</span>
                      {r.description && (
                        <span className="text-xs text-muted-foreground truncate max-w-[180px]" title={r.description}>
                          · {r.description}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className="text-[10px]">
                      {CATEGORY_LABELS[r.category]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {r.payment_method ? (
                      <Badge variant="outline" className={cn('border-0', PAYMENT_METHOD_COLORS[r.payment_method])}>
                        {PAYMENT_METHOD_LABELS[r.payment_method]}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-medium">{formatEUR(num(r.amount))}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{formatEUR(num(r.vat_amount))}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-600 hover:text-red-700"
                        onClick={async () => {
                          if (await confirm({ title: 'Eliminare questa spesa?', variant: 'destructive' })) deleteMutation.mutate(r.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Modifica spesa' : 'Registra spesa'}</DialogTitle>
            <DialogDescription>
              Spese collegate al progetto: contanti, PayPal, bonifico o altro.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Data *</Label>
                <Input
                  type="date"
                  value={form.occurred_on}
                  onChange={(e) => setForm({ ...form, occurred_on: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Categoria *</Label>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm({ ...form, category: v as ExpenseCategory })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EXPENSE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Fornitore</Label>
              <Input
                value={form.vendor}
                onChange={(e) => setForm({ ...form, vendor: e.target.value })}
                placeholder="Es. Tipografia"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
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
                <Label className="text-xs">IVA (€)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.vat_amount}
                  onChange={(e) => setForm({ ...form, vat_amount: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Deducibile %</Label>
                <Input
                  type="number"
                  step="1"
                  min="0"
                  max="100"
                  value={form.deductible_percent}
                  onChange={(e) => setForm({ ...form, deductible_percent: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Metodo pagamento</Label>
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
            <div className="space-y-1.5">
              <Label className="text-xs">Descrizione</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
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
