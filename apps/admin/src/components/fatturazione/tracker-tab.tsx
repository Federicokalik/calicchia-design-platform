import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Receipt, Plus, CreditCard, TrendingUp, AlertCircle, Zap, Hand,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATUS_COLORS: Record<string, string> = {
  emessa: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  pagata: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  scaduta: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  parziale: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  annullata: 'bg-zinc-100 text-zinc-500',
};

export default function TrackerTab() {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ description: '', amount: '', status: 'emessa', due_date: '' });

  const { data } = useQuery({
    queryKey: ['payment-tracker'],
    queryFn: () => apiFetch('/api/payment-tracker'),
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => apiFetch('/api/payment-tracker', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-tracker'] });
      setShowNew(false);
      setNewForm({ description: '', amount: '', status: 'emessa', due_date: '' });
      toast.success('Pagamento tracciato');
    },
  });

  const payments = data?.payments || [];
  const totaleMese = payments.reduce((s: number, p: any) => s + parseFloat(p.amount || 0), 0);
  const totaleIncassato = payments
    .filter((p: any) => p.status === 'pagata' || p.status === 'parziale')
    .reduce((s: number, p: any) => s + parseFloat(p.paid_amount || p.amount || 0), 0);
  const daIncassare = payments.filter((p: any) => p.status === 'emessa').reduce((s: number, p: any) => s + parseFloat(p.amount || 0), 0);
  const scaduto = payments.filter((p: any) => p.status === 'scaduta').reduce((s: number, p: any) => s + parseFloat(p.amount || 0), 0);

  const PROVIDER_LABEL: Record<string, string> = {
    stripe: 'Stripe',
    paypal: 'PayPal',
    revolut: 'Revolut',
    bank_transfer: 'Bonifico',
  };

  return (
    <div className="space-y-4">
      {/* KPI */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <TrendingUp className="h-4 w-4" />
            <span className="text-xs">Totale</span>
          </div>
          <p className="text-xl font-bold">€{totaleMese.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <CreditCard className="h-4 w-4" />
            <span className="text-xs">Incassato</span>
          </div>
          <p className="text-xl font-bold text-emerald-600">€{totaleIncassato.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <CreditCard className="h-4 w-4" />
            <span className="text-xs">Da incassare</span>
          </div>
          <p className="text-xl font-bold text-amber-600">€{daIncassare.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <AlertCircle className="h-4 w-4" />
            <span className="text-xs">Scaduto</span>
          </div>
          <p className="text-xl font-bold text-red-600">€{scaduto.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4 mr-1.5" /> Nuovo pagamento
        </Button>
      </div>

      {payments.length === 0 ? (
        <EmptyState title="Nessun pagamento tracciato" icon={Receipt} />
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          {payments.map((p: any) => (
            <div key={`${p.source ?? 'manual'}-${p.id}`} className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors">
              <div className="shrink-0" title={p.source === 'auto' ? 'Automatico (provider)' : 'Manuale (tracker)'}>
                {p.source === 'auto'
                  ? <Zap className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                  : <Hand className="h-4 w-4 text-zinc-500" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{p.description}</p>
                <p className="text-xs text-muted-foreground">
                  {p.customer_name || p.company_name || '—'}
                  {p.project_name ? ` · ${p.project_name}` : ''}
                  {p.paid_date ? ` · Pagato: ${new Date(p.paid_date).toLocaleDateString('it-IT')}` : p.due_date ? ` · Scadenza: ${new Date(p.due_date).toLocaleDateString('it-IT')}` : ''}
                </p>
              </div>
              {p.provider && (
                <Badge variant="secondary" className="text-[10px] hidden sm:inline-flex">
                  {PROVIDER_LABEL[p.provider] ?? p.provider}
                </Badge>
              )}
              <span className="text-sm font-semibold tabular-nums">
                €{parseFloat(p.amount).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <Badge variant="outline" className={cn('text-[10px]', STATUS_COLORS[p.status] || '')}>
                {p.status}
              </Badge>
              {p.external_ref && p.source === 'auto' && (
                <span className="text-[10px] text-muted-foreground font-mono hidden md:inline" title={p.external_ref}>
                  {String(p.external_ref).slice(0, 12)}…
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* New payment dialog */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Nuovo Pagamento</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); createMutation.mutate({ description: newForm.description, amount: parseFloat(newForm.amount), status: newForm.status, due_date: newForm.due_date || null }); }} className="space-y-3">
            <div className="space-y-1.5"><Label>Descrizione *</Label><Input value={newForm.description} onChange={(e) => setNewForm({ ...newForm, description: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Importo €</Label><Input type="number" value={newForm.amount} onChange={(e) => setNewForm({ ...newForm, amount: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Stato</Label>
                <Select value={newForm.status} onValueChange={(v) => setNewForm({ ...newForm, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="emessa">Emessa</SelectItem>
                    <SelectItem value="pagata">Pagata</SelectItem>
                    <SelectItem value="scaduta">Scaduta</SelectItem>
                    <SelectItem value="parziale">Parziale</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5"><Label>Scadenza</Label><Input type="date" value={newForm.due_date} onChange={(e) => setNewForm({ ...newForm, due_date: e.target.value })} /></div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNew(false)}>Annulla</Button>
              <Button type="submit" disabled={!newForm.description || !newForm.amount}>Crea</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
