import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import {
  Globe, Search, Plus, Pencil, Trash2, MoreHorizontal, FileText, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { useConfirm } from '@/hooks/use-confirm';
import { cn } from '@/lib/utils';
import { LoadingState } from '@/components/shared/loading-state';

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function urgencyBadge(days: number) {
  if (days < 0) return { label: 'Scaduto', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' };
  if (days <= 7) return { label: `${days}gg`, color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' };
  if (days <= 30) return { label: `${days}gg`, color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
  return { label: `${days}gg`, color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' };
}

const EMPTY_FORM = {
  domain_name: '', tld: 'it', registrar: 'aruba', registration_date: '',
  // false: i domini rinnovati su proforma non si rinnovano da soli (l'API richiede il campo).
  expiration_date: '', auto_renew: false, customer_id: '', hosting_server: '',
  ssl_status: 'none', notes: '', renewal_cost: '',
};

const PROFORMA_STATUS_LABEL: Record<string, string> = { draft: 'bozza', issued: 'emessa', sent: 'inviata' };

export default function DominiPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [proformaFor, setProformaFor] = useState<any | null>(null);
  const [proformaForm, setProformaForm] = useState({ years: '1', unit_price: '', number: '', draftEmail: true });
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data, isLoading } = useQuery({
    queryKey: ['domains', search],
    queryFn: () => apiFetch(`/api/domains${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  });

  const { data: customersData } = useQuery({
    queryKey: ['customers-select'],
    queryFn: () => apiFetch('/api/customers?limit=100'),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Campi opzionali vuoti → null (una stringa vuota su una colonna date dà 500).
      const body = {
        ...form,
        hosting_server: form.hosting_server || null,
        notes: form.notes || null,
        renewal_cost: form.renewal_cost.trim() ? form.renewal_cost.trim().replace(',', '.') : null,
      };
      if (editId) {
        return apiFetch(`/api/domains/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
      }
      return apiFetch('/api/domains', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      setShowForm(false);
      setEditId(null);
      setForm(EMPTY_FORM);
      toast.success(editId ? 'Dominio aggiornato' : 'Dominio aggiunto');
    },
    onError: (err: Error) => toast.error(err.message || 'Errore salvataggio'),
  });

  const proformaMutation = useMutation({
    mutationFn: async () => {
      if (!proformaFor) return null;
      const price = proformaForm.unit_price.trim().replace(',', '.');
      return apiFetch(`/api/domains/${proformaFor.id}/proforma`, {
        method: 'POST',
        body: JSON.stringify({
          years: Number(proformaForm.years) || 1,
          ...(price ? { unit_price: Number(price) } : {}),
          ...(proformaForm.number.trim() ? { number: proformaForm.number.trim() } : {}),
          delivery: proformaForm.draftEmail ? 'draft' : 'none',
        }),
      });
    },
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      queryClient.invalidateQueries({ queryKey: ['proformas'] });
      setProformaFor(null);
      toast.success(`Proforma ${res?.proforma?.number ?? ''} emessa · ${res?.proforma?.total_label ?? ''}`);
      if (res?.pdf_error) toast.warning(`PDF non generato: ${res.pdf_error}`);
      if (res?.open_url) navigate(res.open_url);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const openProforma = (d: any) => {
    setProformaForm({ years: '1', unit_price: d.renewal_cost != null ? String(d.renewal_cost).replace('.', ',') : '', number: '', draftEmail: true });
    setProformaFor(d);
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/domains/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Dominio eliminato');
    },
  });

  const domains = data?.domains || [];
  const customers = customersData?.customers || [];

  const openEdit = (d: any) => {
    setEditId(d.id);
    setForm({
      domain_name: d.domain_name || '',
      tld: d.tld || 'it',
      registrar: d.registrar || 'altro',
      registration_date: d.registration_date?.split('T')[0] || '',
      expiration_date: d.expiration_date?.split('T')[0] || d.expiry_date?.split('T')[0] || '',
      auto_renew: d.auto_renew ?? false,
      customer_id: d.customer_id || '',
      hosting_server: d.hosting_server || '',
      ssl_status: d.ssl_status || 'none',
      notes: d.notes || '',
      renewal_cost: d.renewal_cost != null ? String(d.renewal_cost) : '',
    });
    setShowForm(true);
  };

  const openNew = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const topbarActions = useMemo(() => (
    <Button size="sm" onClick={openNew}>
      <Plus className="h-4 w-4 mr-1.5" /> Nuovo Dominio
    </Button>
  ), []);

  useTopbar({
    title: 'Domini',
    subtitle: `${domains.length} domini gestiti`,
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Cerca dominio..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>

      {isLoading ? (
        <LoadingState />
      ) : domains.length === 0 ? (
        <EmptyState title="Nessun dominio" description="Aggiungi il primo dominio" icon={Globe}>
          <Button size="sm" onClick={openNew}>Aggiungi dominio</Button>
        </EmptyState>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="hidden sm:grid grid-cols-[1fr_1fr_120px_100px_80px_40px] gap-4 px-4 py-2.5 border-b bg-muted/50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <span>Dominio</span>
            <span>Cliente</span>
            <span>Scadenza</span>
            <span>Rinnovo</span>
            <span>Urgenza</span>
            <span></span>
          </div>
          {domains.map((d: any) => {
            const expDate = d.expiration_date || d.expiry_date;
            const days = expDate ? daysUntil(expDate) : 999;
            const urg = urgencyBadge(days);
            return (
              <div key={d.id} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_120px_100px_80px_40px] gap-2 sm:gap-4 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors items-center">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium">{d.full_domain || `${d.domain_name}.${d.tld}`}</span>
                </div>
                <span className="text-sm text-muted-foreground truncate">{d.customers?.company_name || d.customers?.contact_name || '—'}</span>
                <span className="text-sm text-muted-foreground">
                  {expDate ? new Date(expDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'}
                </span>
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline" className="text-[10px] w-fit">
                    {d.auto_renew ? 'Auto' : 'Manuale'}
                  </Badge>
                  {d.open_proforma && (
                    <Badge variant="outline" className="text-[10px] w-fit bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" title="Proforma di rinnovo aperta">
                      {d.open_proforma.number ?? 'PF'} · {PROFORMA_STATUS_LABEL[d.open_proforma.status] ?? d.open_proforma.status}
                    </Badge>
                  )}
                </div>
                <Badge variant="outline" className={cn('text-[10px] w-fit', urg.color)}>
                  {urg.label}
                </Badge>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openEdit(d)}>
                      <Pencil className="h-3.5 w-3.5 mr-2" /> Modifica
                    </DropdownMenuItem>
                    {d.open_proforma ? (
                      <DropdownMenuItem onClick={() => navigate('/fatturazione?tab=proforma')}>
                        <FileText className="h-3.5 w-3.5 mr-2" /> Vai alla proforma {d.open_proforma.number ?? ''}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => openProforma(d)}>
                        <FileText className="h-3.5 w-3.5 mr-2" /> Genera proforma rinnovo
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onClick={async () => { if (await confirm({ title: 'Eliminare dominio?', variant: 'destructive' })) deleteMutation.mutate(d.id); }}>
                      <Trash2 className="h-3.5 w-3.5 mr-2" /> Elimina
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit dialog */}
      <Dialog open={showForm} onOpenChange={(v) => { if (!v) { setShowForm(false); setEditId(null); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId ? 'Modifica Dominio' : 'Nuovo Dominio'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); saveMutation.mutate(); }} className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Nome dominio *</Label>
                <Input value={form.domain_name} onChange={(e) => setForm({ ...form, domain_name: e.target.value })} placeholder="example" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">TLD</Label>
                <Select value={form.tld} onValueChange={(v) => setForm({ ...form, tld: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['it', 'com', 'net', 'org', 'eu', 'info', 'design', 'dev', 'io', 'co'].map((t) => (
                      <SelectItem key={t} value={t}>.{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Data registrazione *</Label>
                <Input type="date" value={form.registration_date} onChange={(e) => setForm({ ...form, registration_date: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Data scadenza *</Label>
                <Input type="date" value={form.expiration_date} onChange={(e) => setForm({ ...form, expiration_date: e.target.value })} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Registrar</Label>
                <Select value={form.registrar} onValueChange={(v) => setForm({ ...form, registrar: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['aruba', 'register', 'ovh', 'cloudflare', 'namecheap', 'godaddy', 'google', 'altro'].map((r) => (
                      <SelectItem key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Cliente *</Label>
                <Select value={form.customer_id} onValueChange={(v) => setForm({ ...form, customer_id: v })}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Seleziona..." /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c: any) => (
                      <SelectItem key={c.id} value={c.id}>{c.contact_name}{c.company_name ? ` (${c.company_name})` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Hosting / Server</Label>
                <Input value={form.hosting_server} onChange={(e) => setForm({ ...form, hosting_server: e.target.value })} placeholder="Es. Aruba, Netlify..." />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">SSL</Label>
                <Select value={form.ssl_status} onValueChange={(v) => setForm({ ...form, ssl_status: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {/* Valori ammessi dal CHECK domains_ssl_status_check */}
                    <SelectItem value="none">Nessuno</SelectItem>
                    <SelectItem value="lets_encrypt">Let's Encrypt</SelectItem>
                    <SelectItem value="cloudflare">Cloudflare</SelectItem>
                    <SelectItem value="custom">Personalizzato</SelectItem>
                    <SelectItem value="expired">Scaduto</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 items-end">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="domain-renewal-cost">Prezzo rinnovo annuo (€)</Label>
                <Input id="domain-renewal-cost" inputMode="decimal" value={form.renewal_cost} onChange={(e) => setForm({ ...form, renewal_cost: e.target.value })} placeholder="es. 15,00" />
              </div>
              <div className="flex items-center gap-3 pb-2">
                <Switch checked={form.auto_renew} onCheckedChange={(v) => setForm({ ...form, auto_renew: v })} />
                <Label className="text-xs">Rinnovo automatico</Label>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowForm(false); setEditId(null); }}>Annulla</Button>
              {/* customer_id e registration_date sono NOT NULL in domains */}
              <Button type="submit" disabled={!form.domain_name || !form.expiration_date || !form.registration_date || !form.customer_id || saveMutation.isPending}>
                {editId ? 'Salva' : 'Aggiungi'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Proforma di rinnovo */}
      <Dialog open={!!proformaFor} onOpenChange={(v) => { if (!v) setProformaFor(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Proforma rinnovo {proformaFor?.full_domain}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="pf-years">Anni</Label>
                <Input id="pf-years" inputMode="numeric" value={proformaForm.years} onChange={(e) => setProformaForm({ ...proformaForm, years: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="pf-price">Prezzo per anno (€)</Label>
                <Input id="pf-price" inputMode="decimal" value={proformaForm.unit_price} onChange={(e) => setProformaForm({ ...proformaForm, unit_price: e.target.value })} placeholder="dal dominio" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="pf-number">Numero (facoltativo)</Label>
              <Input id="pf-number" value={proformaForm.number} onChange={(e) => setProformaForm({ ...proformaForm, number: e.target.value })} placeholder="vuoto = prossimo progressivo, es. 3/2026" />
            </div>
            <div className="flex items-center gap-3">
              <Switch id="pf-draft-email" checked={proformaForm.draftEmail} onCheckedChange={(v) => setProformaForm({ ...proformaForm, draftEmail: v })} />
              <Label htmlFor="pf-draft-email" className="text-xs">Prepara la bozza email con il PDF (destinatari amministrativi del cliente)</Label>
            </div>
            <p className="text-xs text-muted-foreground">Regime forfettario, nessuna IVA; sopra 77,47 € si aggiunge la rivalsa del bollo (2 €). La scadenza si aggiorna quando la proforma viene segnata pagata.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProformaFor(null)}>Annulla</Button>
            <Button disabled={proformaMutation.isPending} onClick={() => proformaMutation.mutate()}>
              {proformaMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Emetti proforma
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
