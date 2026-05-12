import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Globe, Search, Plus, Pencil, Trash2, MoreHorizontal,
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
  expiration_date: '', auto_renew: true, customer_id: '', hosting_server: '',
  ssl_status: 'none', notes: '',
};

export default function DominiPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data, isLoading } = useQuery({
    queryKey: ['domains', search],
    queryFn: () => apiFetch(`/api/domains${search ? `?search=${search}` : ''}`),
  });

  const { data: customersData } = useQuery({
    queryKey: ['customers-select'],
    queryFn: () => apiFetch('/api/customers?limit=100'),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = { ...form };
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
    onError: () => toast.error('Errore salvataggio'),
  });

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
      auto_renew: d.auto_renew ?? true,
      customer_id: d.customer_id || '',
      hosting_server: d.hosting_server || '',
      ssl_status: d.ssl_status || 'none',
      notes: d.notes || '',
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
                <span className="text-sm text-muted-foreground truncate">{d.customer_name || '—'}</span>
                <span className="text-sm text-muted-foreground">
                  {expDate ? new Date(expDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'}
                </span>
                <Badge variant="outline" className="text-[10px] w-fit">
                  {d.auto_renew ? 'Auto' : 'Manuale'}
                </Badge>
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
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onClick={() => { if (confirm('Eliminare?')) deleteMutation.mutate(d.id); }}>
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
                <Label className="text-xs">Nome dominio</Label>
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
                <Label className="text-xs">Data registrazione</Label>
                <Input type="date" value={form.registration_date} onChange={(e) => setForm({ ...form, registration_date: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Data scadenza</Label>
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
                <Label className="text-xs">Cliente</Label>
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
                    <SelectItem value="none">Nessuno</SelectItem>
                    <SelectItem value="active">Attivo</SelectItem>
                    <SelectItem value="expired">Scaduto</SelectItem>
                    <SelectItem value="pending">In attesa</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Switch checked={form.auto_renew} onCheckedChange={(v) => setForm({ ...form, auto_renew: v })} />
              <Label className="text-xs">Rinnovo automatico</Label>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowForm(false); setEditId(null); }}>Annulla</Button>
              <Button type="submit" disabled={!form.domain_name || !form.expiration_date || saveMutation.isPending}>
                {editId ? 'Salva' : 'Aggiungi'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
