import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Receipt, Plus, Upload, Sparkles, Trash2, X, Calendar,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { useTopbar } from '@/hooks/use-topbar';
import { useI18n } from '@/hooks/use-i18n';
import { apiFetch, API_BASE } from '@/lib/api';
import { cn } from '@/lib/utils';

type Category =
  | 'software' | 'hardware' | 'office' | 'travel' | 'meals'
  | 'training' | 'marketing' | 'professional_services' | 'utilities' | 'other';

const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: 'software', label: 'Software & SaaS' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'office', label: 'Ufficio' },
  { value: 'travel', label: 'Viaggi' },
  { value: 'meals', label: 'Pasti' },
  { value: 'training', label: 'Formazione' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'professional_services', label: 'Servizi professionali' },
  { value: 'utilities', label: 'Utenze' },
  { value: 'other', label: 'Altro' },
];

const CATEGORY_LABEL: Record<Category, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
) as Record<Category, string>;

interface Expense {
  id: string;
  occurred_on: string;
  vendor: string | null;
  amount: number | string;
  vat_amount: number | string | null;
  category: Category;
  description: string | null;
  receipt_path: string | null;
  linked_invoice_id: string | null;
  project_id: string | null;
  customer_id: string | null;
  customer_name?: string | null;
  project_name?: string | null;
  deductible_percent: number;
  currency: string;
  notes: string | null;
}

interface ExpensesStats {
  total_count: number;
  total_amount: number;
  total_deductible: number;
  by_category: Array<{ category: Category; total_amount: number; total_deductible: number; deductible_count: number }>;
}

interface ExpenseForm {
  occurred_on: string;
  vendor: string;
  amount: string;
  vat_amount: string;
  category: Category;
  description: string;
  deductible_percent: string;
  notes: string;
}

const EMPTY_FORM: ExpenseForm = {
  occurred_on: new Date().toISOString().slice(0, 10),
  vendor: '',
  amount: '',
  vat_amount: '',
  category: 'other',
  description: '',
  deductible_percent: '100',
  notes: '',
};

export default function SpesePage() {
  const { formatCurrency } = useI18n();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<ExpenseForm>(EMPTY_FORM);
  const [dragOver, setDragOver] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useTopbar({
    title: 'Spese',
    subtitle: 'Spese deducibili — entrate vs uscite per il calcolo fiscale',
  });

  const { data, isLoading } = useQuery<{
    expenses: Expense[];
    count: number;
    stats: ExpensesStats;
  }>({
    queryKey: ['expenses', categoryFilter, dateFrom, dateTo, search],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (search) params.set('search', search);
      return apiFetch(`/api/expenses?${params.toString()}`);
    },
  });

  const expenses = data?.expenses ?? [];
  const stats = data?.stats;

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          occurred_on: form.occurred_on,
          vendor: form.vendor.trim() || null,
          amount: parseFloat(form.amount) || 0,
          vat_amount: parseFloat(form.vat_amount) || 0,
          category: form.category,
          description: form.description.trim() || null,
          deductible_percent: parseInt(form.deductible_percent, 10) || 100,
          notes: form.notes.trim() || null,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['tax-forecast'] });
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success('Spesa registrata');
    },
    onError: (err: any) => toast.error(err?.message || 'Errore creazione spesa'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/expenses/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      toast.success('Spesa eliminata');
    },
  });

  const filteredExpenses = useMemo(() => {
    if (!search) return expenses;
    const q = search.toLowerCase();
    return expenses.filter((e) =>
      (e.vendor ?? '').toLowerCase().includes(q)
      || (e.description ?? '').toLowerCase().includes(q)
      || (e.notes ?? '').toLowerCase().includes(q),
    );
  }, [expenses, search]);

  const handleFile = async (file: File) => {
    if (!file) return;
    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(file.type)) {
      toast.error('Formato non supportato. Usa PDF, PNG, JPEG o WebP.');
      return;
    }

    setOcrRunning(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE}/api/ai/extract-expense`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Errore OCR');
      }
      const data = await res.json();
      const e = data.extracted ?? {};
      setForm({
        occurred_on: e.occurred_on || new Date().toISOString().slice(0, 10),
        vendor: e.vendor || '',
        amount: e.amount != null ? String(e.amount) : '',
        vat_amount: e.vat_amount != null ? String(e.vat_amount) : '',
        category: (CATEGORIES.some((c) => c.value === e.category) ? e.category : 'other') as Category,
        description: e.description || '',
        deductible_percent: '100',
        notes: e.raw_text ? `OCR: ${String(e.raw_text).slice(0, 200)}` : '',
      });
      toast.success('Dati estratti dalla ricevuta');
    } catch (err: any) {
      toast.error(err?.message || 'Errore OCR');
    } finally {
      setOcrRunning(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div className="space-y-6">
      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Spese {new Date().getFullYear()}
          </p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">
            {formatCurrency(Number(stats?.total_amount ?? 0))}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">{stats?.total_count ?? 0} voci</p>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Totale deducibile
          </p>
          <p className="text-2xl font-semibold mt-1 tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatCurrency(Number(stats?.total_deductible ?? 0))}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            applicando il deductible_percent
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Categoria principale
          </p>
          {(() => {
            const top = (stats?.by_category ?? [])
              .slice()
              .sort((a, b) => Number(b.total_amount) - Number(a.total_amount))[0];
            return top ? (
              <>
                <p className="text-2xl font-semibold mt-1">{CATEGORY_LABEL[top.category]}</p>
                <p className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                  {formatCurrency(Number(top.total_amount))}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground mt-1">—</p>
            );
          })()}
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs font-medium">Ricerca</Label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Fornitore, descrizione, note..."
              className="h-9 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Categoria</Label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tutte</SelectItem>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Dal</Label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Al</Label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
        </div>
      </div>

      {/* New expense button */}
      <div className="flex justify-end">
        <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) setForm(EMPTY_FORM); }}>
          <Button onClick={() => setDialogOpen(true)} size="sm">
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Nuova spesa
          </Button>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Nuova spesa</DialogTitle>
              <DialogDescription>
                Carica uno scontrino o una fattura ricevuta — l'OCR estrae i dati. Oppure compila manualmente.
              </DialogDescription>
            </DialogHeader>

            {/* OCR upload zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'rounded-lg border-2 border-dashed p-4 text-center cursor-pointer transition-colors',
                dragOver ? 'border-primary bg-primary/5' : 'border-muted hover:bg-muted/30',
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              {ocrRunning ? (
                <p className="text-sm flex items-center justify-center gap-2">
                  <Sparkles className="h-4 w-4 animate-pulse" /> Estrazione dati...
                </p>
              ) : (
                <p className="text-sm text-muted-foreground flex items-center justify-center gap-2">
                  <Upload className="h-4 w-4" />
                  Trascina ricevuta o click per selezionare (PDF/PNG/JPG, max 20MB)
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs font-medium">Data *</Label>
                <Input
                  type="date"
                  value={form.occurred_on}
                  onChange={(e) => setForm({ ...form, occurred_on: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">Categoria *</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v as Category })}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs font-medium">Fornitore</Label>
                <Input
                  value={form.vendor}
                  onChange={(e) => setForm({ ...form, vendor: e.target.value })}
                  placeholder="Es. Apple, Amazon, Vodafone..."
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">Importo (€) *</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  placeholder="0,00"
                  className="h-9 text-sm tabular-nums"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">IVA (€)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.vat_amount}
                  onChange={(e) => setForm({ ...form, vat_amount: e.target.value })}
                  className="h-9 text-sm tabular-nums"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">% deducibile</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={form.deductible_percent}
                  onChange={(e) => setForm({ ...form, deductible_percent: e.target.value })}
                  className="h-9 text-sm tabular-nums"
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs font-medium">Descrizione</Label>
                <Input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs font-medium">Note</Label>
                <Textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="text-sm"
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Annulla</Button>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={
                  createMutation.isPending
                  || !form.amount
                  || parseFloat(form.amount) <= 0
                  || !form.occurred_on
                }
              >
                {createMutation.isPending ? 'Salvataggio...' : 'Salva spesa'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* List */}
      {isLoading ? (
        <LoadingState />
      ) : filteredExpenses.length === 0 ? (
        <EmptyState
          title="Nessuna spesa"
          description="Crea la prima spesa per iniziare a tracciare le voci deducibili."
          icon={Receipt}
        />
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {filteredExpenses.map((e) => (
            <div key={e.id} className="px-4 py-3 flex items-center gap-3">
              <div className="size-9 shrink-0 rounded-md bg-muted flex items-center justify-center">
                <Receipt className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <p className="text-sm font-medium truncate">
                    {e.vendor || 'Spesa senza fornitore'}
                  </p>
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {CATEGORY_LABEL[e.category] || e.category}
                  </Badge>
                </div>
                {e.description && (
                  <p className="text-xs text-muted-foreground truncate">{e.description}</p>
                )}
              </div>
              <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
                <span className="text-sm font-semibold tabular-nums">
                  {formatCurrency(Number(e.amount))}
                </span>
                <span className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                  <Calendar className="h-3 w-3" />
                  {new Date(e.occurred_on).toLocaleDateString('it-IT', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </span>
              </div>
              {e.deductible_percent < 100 && (
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {e.deductible_percent}% ded.
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (window.confirm('Eliminare questa spesa?')) {
                    deleteMutation.mutate(e.id);
                  }
                }}
                className="h-7 w-7"
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
