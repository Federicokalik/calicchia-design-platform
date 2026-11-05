import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FileText, Loader2, MoreHorizontal, Plus, Send, Mail, CheckCircle2, Ban, FileDown, Stamp, Trash2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { useConfirm } from '@/hooks/use-confirm';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

type ProformaStatus = 'draft' | 'issued' | 'sent' | 'converted' | 'cancelled';

interface ProformaRow {
  id: string;
  number: string | null;
  status: ProformaStatus;
  customer_id: string;
  customer_name: string | null;
  domain_name: string | null;
  issue_date: string | null;
  due_date: string | null;
  total_cents: number;
  stamp_duty_cents: number;
  sent_at: string | null;
  sent_to: string[];
  paid_at: string | null;
  converted_invoice_id: string | null;
  pdf_url: string | null;
}

const STATUS_LABEL: Record<ProformaStatus, string> = {
  draft: 'Bozza',
  issued: 'Emessa',
  sent: 'Inviata',
  converted: 'Pagata',
  cancelled: 'Annullata',
};

const STATUS_COLOR: Record<ProformaStatus, string> = {
  draft: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  issued: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  converted: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  cancelled: 'bg-zinc-100 text-zinc-500 line-through',
};

function euro(cents: number): string {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
}

interface LineDraft { description: string; quantity: string; unit_price: string }

/** Proforma: emissione, PDF, invio (bozza in Posta o invio diretto), pagamento → fattura in bozza. */
export default function ProformaTab() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [status, setStatus] = useState<'all' | ProformaStatus>('all');
  const [paying, setPaying] = useState<ProformaRow | null>(null);
  const [payForm, setPayForm] = useState({ paid_at: todayIso(), payment_method: 'bonifico', invoicePaid: false, invoice_number: '' });
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState<{ customer_id: string; due_days: string; lines: LineDraft[] }>({
    customer_id: '', due_days: '15', lines: [{ description: '', quantity: '1', unit_price: '' }],
  });

  const { data, isLoading } = useQuery({
    queryKey: ['proformas', status],
    queryFn: () => apiFetch(`/api/proformas${status === 'all' ? '' : `?status=${status}`}`),
  });
  const rows: ProformaRow[] = useMemo(() => data?.proformas ?? [], [data]);

  const { data: customersData } = useQuery({
    queryKey: ['customers-select'],
    queryFn: () => apiFetch('/api/customers?limit=100'),
    enabled: creating,
  });
  const customers: Array<{ id: string; contact_name: string; company_name: string | null }> = customersData?.customers ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['proformas'] });
    queryClient.invalidateQueries({ queryKey: ['domains'] });
  };

  const action = useMutation({
    mutationFn: async ({ id, path, body }: { id: string; path: string; body?: unknown }) =>
      apiFetch(`/api/proformas/${id}/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    onSuccess: (res, vars) => {
      invalidate();
      const number = res?.proforma?.number;
      if (vars.path === 'issue') {
        toast.success(`Proforma ${number} emessa`);
        if (res?.pdf_error) toast.warning(`PDF non generato: ${res.pdf_error}. Riprova da "Rigenera PDF".`);
      } else if (vars.path === 'draft-email') {
        toast.success('Bozza email creata con il PDF allegato');
        if (res?.open_url) navigate(res.open_url);
      } else if (vars.path === 'send') {
        toast.success(`Proforma ${number} inviata a ${(res?.to ?? []).join(', ')}`);
        if (res?.sent_copy?.status === 'failed') toast.warning(`Copia in Inviati non salvata: ${res.sent_copy.error}`);
      } else if (vars.path === 'mark-paid') {
        const inv = res?.invoice;
        toast.success(`Pagamento registrato: fattura ${inv?.status === 'paid' ? 'pagata' : 'in bozza'} creata`);
        for (const r of res?.renewals ?? []) toast.success(`${r.full_domain}: nuova scadenza ${formatDate(r.expiration_after)}`);
        for (const w of res?.warnings ?? []) toast.warning(w);
        setPaying(null);
      } else if (vars.path === 'cancel') {
        toast.success(`Proforma ${number ?? ''} annullata`);
      } else if (vars.path === 'pdf') {
        toast.success('PDF rigenerato');
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeDraft = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/proformas/${id}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate(); toast.success('Bozza eliminata'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const create = useMutation({
    mutationFn: async () => apiFetch('/api/proformas', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: newForm.customer_id,
        due_days: Number(newForm.due_days) || 15,
        lines: newForm.lines
          .filter((l) => l.description.trim())
          .map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity.replace(',', '.')) || 1, unit_price: l.unit_price.trim() })),
      }),
    }),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setNewForm({ customer_id: '', due_days: '15', lines: [{ description: '', quantity: '1', unit_price: '' }] });
      toast.success('Bozza di proforma creata: emettila per assegnare il numero');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const totals = useMemo(() => ({
    open: rows.filter((r) => r.status === 'issued' || r.status === 'sent').reduce((n, r) => n + r.total_cents, 0),
    count: rows.length,
  }), [rows]);

  const newTotalCents = newForm.lines.reduce((n, l) => {
    const q = Number(l.quantity.replace(',', '.')) || 0;
    const p = Number(l.unit_price.replace(',', '.')) || 0;
    return n + Math.round(q * p * 100);
  }, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger className="w-[180px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutte</SelectItem>
              {(Object.keys(STATUS_LABEL) as ProformaStatus[]).map((s) => (
                <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {totals.count} proforma · da incassare {euro(totals.open)}
          </span>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4 mr-1.5" /> Nuova proforma
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nessuna proforma"
          description="Crea una proforma di rinnovo da Domini (menu del dominio → Genera proforma rinnovo) oppure una proforma libera."
          icon={FileText}
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          {rows.map((row) => {
            const open = row.status === 'issued' || row.status === 'sent';
            return (
              <div key={row.id} className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {row.number ?? 'Bozza'}
                    {row.domain_name ? <span className="text-muted-foreground font-normal"> · {row.domain_name}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {row.customer_name ?? '—'}
                    {row.issue_date ? ` · emessa ${formatDate(row.issue_date)}` : ''}
                    {open && row.due_date ? ` · scade ${formatDate(row.due_date)}` : ''}
                    {row.sent_at ? ` · inviata a ${row.sent_to.join(', ')}` : ''}
                    {row.paid_at ? ` · pagata ${formatDate(row.paid_at)}` : ''}
                  </p>
                </div>
                {row.stamp_duty_cents > 0 && (
                  <span title="Include la rivalsa del bollo" className="text-muted-foreground"><Stamp className="h-3.5 w-3.5" /></span>
                )}
                <Badge variant="outline" className={cn('text-[10px] shrink-0', STATUS_COLOR[row.status])}>{STATUS_LABEL[row.status]}</Badge>
                <span className="text-sm font-semibold tabular-nums shrink-0 min-w-[80px] text-right">{euro(row.total_cents)}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Azioni per ${row.number ?? 'bozza'}`}>
                      {action.isPending && action.variables?.id === row.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {row.status === 'draft' && (
                      <>
                        <DropdownMenuItem onClick={() => action.mutate({ id: row.id, path: 'issue' })}>
                          <CheckCircle2 className="h-3.5 w-3.5 mr-2" /> Emetti (assegna il numero)
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive" onClick={async () => {
                          if (await confirm({ title: 'Eliminare la bozza?', variant: 'destructive' })) removeDraft.mutate(row.id);
                        }}>
                          <Trash2 className="h-3.5 w-3.5 mr-2" /> Elimina bozza
                        </DropdownMenuItem>
                      </>
                    )}
                    {row.status !== 'draft' && row.pdf_url && (
                      <DropdownMenuItem onClick={() => window.open(row.pdf_url!, '_blank', 'noopener')}>
                        <FileDown className="h-3.5 w-3.5 mr-2" /> Apri PDF
                      </DropdownMenuItem>
                    )}
                    {row.status !== 'draft' && row.status !== 'cancelled' && (
                      <DropdownMenuItem onClick={() => action.mutate({ id: row.id, path: 'pdf' })}>
                        <FileText className="h-3.5 w-3.5 mr-2" /> Rigenera PDF
                      </DropdownMenuItem>
                    )}
                    {open && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => action.mutate({ id: row.id, path: 'draft-email' })}>
                          <Mail className="h-3.5 w-3.5 mr-2" /> Bozza email con PDF
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={async () => {
                          if (await confirm({
                            title: `Inviare ${row.number}?`,
                            description: 'Il PDF parte ai destinatari amministrativi del cliente (billing_emails, altrimenti email).',
                            confirmText: 'Invia',
                          })) action.mutate({ id: row.id, path: 'send' });
                        }}>
                          <Send className="h-3.5 w-3.5 mr-2" /> {row.status === 'sent' ? 'Invia di nuovo' : 'Invia al cliente'}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => {
                          setPayForm({ paid_at: todayIso(), payment_method: 'bonifico', invoicePaid: false, invoice_number: '' });
                          setPaying(row);
                        }}>
                          <CheckCircle2 className="h-3.5 w-3.5 mr-2" /> Segna pagata
                        </DropdownMenuItem>
                      </>
                    )}
                    {(row.status === 'issued' || row.status === 'sent') && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onClick={async () => {
                          if (await confirm({ title: `Annullare ${row.number}?`, description: 'Il numero resta usato e non viene riassegnato.', variant: 'destructive' })) {
                            action.mutate({ id: row.id, path: 'cancel' });
                          }
                        }}>
                          <Ban className="h-3.5 w-3.5 mr-2" /> Annulla
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagamento → fattura */}
      <Dialog open={!!paying} onOpenChange={(v) => { if (!v) setPaying(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pagamento {paying?.number}</DialogTitle>
            <DialogDescription>
              Crea la fattura{paying?.domain_name ? ` e aggiorna la scadenza di ${paying.domain_name}` : ''}. La fattura nasce in bozza, da rivedere prima dell&apos;invio SDI.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="pf-paid-at">Data pagamento</Label>
                <Input id="pf-paid-at" type="date" value={payForm.paid_at} onChange={(e) => setPayForm({ ...payForm, paid_at: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="pf-method">Metodo</Label>
                <Input id="pf-method" value={payForm.payment_method} onChange={(e) => setPayForm({ ...payForm, payment_method: e.target.value })} />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Switch id="pf-invoice-paid" checked={payForm.invoicePaid} onCheckedChange={(v) => setPayForm({ ...payForm, invoicePaid: v })} />
              <Label htmlFor="pf-invoice-paid" className="text-xs">Fattura già emessa: registrala come pagata</Label>
            </div>
            {payForm.invoicePaid && (
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="pf-invoice-number">Numero fattura</Label>
                <Input id="pf-invoice-number" value={payForm.invoice_number} onChange={(e) => setPayForm({ ...payForm, invoice_number: e.target.value })} placeholder="es. FT 12/2026" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaying(null)}>Annulla</Button>
            <Button
              disabled={action.isPending || !payForm.paid_at}
              onClick={() => paying && action.mutate({
                id: paying.id,
                path: 'mark-paid',
                body: {
                  paid_at: payForm.paid_at,
                  payment_method: payForm.payment_method.trim() || undefined,
                  ...(payForm.invoicePaid ? { invoice_status: 'paid', invoice_number: payForm.invoice_number.trim() || undefined } : {}),
                },
              })}
            >
              {action.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Registra pagamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nuova proforma libera */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nuova proforma</DialogTitle>
            <DialogDescription>Regime forfettario, nessuna IVA. Sopra 77,47 € viene aggiunta la rivalsa del bollo (2 €).</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Cliente *</Label>
                <Select value={newForm.customer_id} onValueChange={(v) => setNewForm({ ...newForm, customer_id: v })}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Seleziona..." /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.company_name || c.contact_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="pf-due">Giorni pagamento</Label>
                <Input id="pf-due" inputMode="numeric" value={newForm.due_days} onChange={(e) => setNewForm({ ...newForm, due_days: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Righe</Label>
              {newForm.lines.map((line, i) => (
                <div key={i} className="grid grid-cols-[1fr_70px_100px_32px] gap-2">
                  <Input aria-label="Descrizione" placeholder="Descrizione" value={line.description}
                    onChange={(e) => setNewForm({ ...newForm, lines: newForm.lines.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)) })} />
                  <Input aria-label="Quantità" inputMode="decimal" value={line.quantity}
                    onChange={(e) => setNewForm({ ...newForm, lines: newForm.lines.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)) })} />
                  <Input aria-label="Prezzo unitario in euro" inputMode="decimal" placeholder="€" value={line.unit_price}
                    onChange={(e) => setNewForm({ ...newForm, lines: newForm.lines.map((l, j) => (j === i ? { ...l, unit_price: e.target.value } : l)) })} />
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-8" aria-label="Rimuovi riga" disabled={newForm.lines.length === 1}
                    onClick={() => setNewForm({ ...newForm, lines: newForm.lines.filter((_, j) => j !== i) })}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setNewForm({ ...newForm, lines: [...newForm.lines, { description: '', quantity: '1', unit_price: '' }] })}>
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Aggiungi riga
              </Button>
            </div>
            <p className="text-sm text-right">
              Imponibile <strong>{euro(newTotalCents)}</strong>
              {newTotalCents > 7747 ? <span className="text-muted-foreground"> + bollo 2,00 € = {euro(newTotalCents + 200)}</span> : null}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Annulla</Button>
            <Button
              disabled={create.isPending || !newForm.customer_id || !newForm.lines.some((l) => l.description.trim() && l.unit_price.trim())}
              onClick={() => create.mutate()}
            >
              Crea bozza
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
