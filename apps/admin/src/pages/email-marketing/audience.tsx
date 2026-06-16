import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Users, Search, Upload, Plus, Mail, Phone, Building2, Trash2, Tag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';
import { ImportDialog } from '@/components/email-marketing/import-dialog';

interface MktContact {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  audience_type: 'warm' | 'cold';
  email_consent: string;
  wa_consent: string;
  tags: string[];
  created_at: string;
}

interface AudiencePayload {
  contacts: MktContact[];
  total: number;
  stats: { total: number; warm: number; cold: number; confirmed: number; unsubscribed: number; wa_opted_in: number };
}

const CONSENT_BADGE: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  confirmed: { label: 'Confermato', variant: 'default' },
  unconfirmed: { label: 'Da confermare', variant: 'secondary' },
  unsubscribed: { label: 'Disiscritto', variant: 'outline' },
  bounced: { label: 'Bounce', variant: 'destructive' },
  complained: { label: 'Spam', variant: 'destructive' },
};

export default function AudiencePage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [audienceFilter, setAudienceFilter] = useState('all');
  const [consentFilter, setConsentFilter] = useState('all');
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteFor, setDeleteFor] = useState<MktContact | null>(null);

  const params = new URLSearchParams({ limit: '500' });
  if (q.trim()) params.set('q', q.trim());
  if (audienceFilter !== 'all') params.set('audience_type', audienceFilter);
  if (consentFilter !== 'all') params.set('email_consent', consentFilter);

  const { data, isLoading } = useQuery<AudiencePayload>({
    queryKey: ['mkt-contacts', q, audienceFilter, consentFilter],
    queryFn: () => apiFetch(`/api/email-marketing/contacts?${params.toString()}`),
  });
  const contacts = data?.contacts ?? [];
  const stats = data?.stats;

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/email-marketing/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mkt-contacts'] });
      toast.success('Contatto eliminato');
      setDeleteFor(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Eliminazione fallita'),
  });

  const topbarActions = useMemo(() => (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" onClick={() => setImportOpen(true)} className="gap-1.5">
        <Upload className="h-4 w-4" /> Importa CSV
      </Button>
      <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
        <Plus className="h-4 w-4" /> Nuovo contatto
      </Button>
    </div>
  ), []);

  useTopbar({
    title: 'Contatti',
    subtitle: stats
      ? `${stats.total} totali · ${stats.warm} caldi · ${stats.cold} freddi · ${stats.confirmed} confermati · ${stats.wa_opted_in} opt-in WhatsApp`
      : 'Audience marketing',
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca email, nome, azienda…" className="pl-8" />
        </div>
        <Select value={audienceFilter} onValueChange={setAudienceFilter}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti i tipi</SelectItem>
            <SelectItem value="warm">Caldi</SelectItem>
            <SelectItem value="cold">Freddi</SelectItem>
          </SelectContent>
        </Select>
        <Select value={consentFilter} onValueChange={setConsentFilter}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti i consensi</SelectItem>
            <SelectItem value="confirmed">Confermati</SelectItem>
            <SelectItem value="unconfirmed">Da confermare</SelectItem>
            <SelectItem value="unsubscribed">Disiscritti</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : contacts.length === 0 ? (
        <EmptyState
          title="Nessun contatto"
          description="Importa una lista CSV (es. da Apify) o aggiungi un contatto manualmente."
          icon={Users}
        />
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {contacts.map((ct) => {
            const cfg = CONSENT_BADGE[ct.email_consent] ?? { label: ct.email_consent, variant: 'outline' as const };
            const name = [ct.first_name, ct.last_name].filter(Boolean).join(' ');
            return (
              <div key={ct.id} className="p-3 flex items-center justify-between gap-4 hover:bg-muted/40">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {ct.email ? <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                    <span className="text-sm font-medium truncate">{ct.email ?? ct.phone}</span>
                    {name && <span className="text-sm text-muted-foreground truncate">— {name}</span>}
                    <Badge variant={ct.audience_type === 'cold' ? 'outline' : 'secondary'} className="text-[10px]">
                      {ct.audience_type === 'cold' ? 'Freddo' : 'Caldo'}
                    </Badge>
                    <Badge variant={cfg.variant} className="text-[10px]">{cfg.label}</Badge>
                    {ct.wa_consent === 'opted_in' && <Badge variant="default" className="text-[10px] bg-emerald-600">WA</Badge>}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                    {ct.company && <span className="flex items-center gap-1"><Building2 className="h-3 w-3" />{ct.company}</span>}
                    {ct.tags?.length > 0 && (
                      <span className="flex items-center gap-1"><Tag className="h-3 w-3" />{ct.tags.slice(0, 4).join(', ')}</span>
                    )}
                  </div>
                </div>
                <Button size="icon" variant="ghost" onClick={() => setDeleteFor(ct)} aria-label="Elimina" className="h-8 w-8">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <CreateContactDialog open={createOpen} onOpenChange={setCreateOpen} />

      {deleteFor && (
        <AlertDialog open onOpenChange={(o) => !o && setDeleteFor(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Eliminare {deleteFor.email ?? deleteFor.phone}?</AlertDialogTitle>
              <AlertDialogDescription>
                Il contatto verrà rimosso dall'audience marketing. La soppressione GDPR (disiscrizione)
                resta registrata anche dopo l'eliminazione.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annulla</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); deleteMutation.mutate(deleteFor.id); }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Elimina
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function CreateContactDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: '', phone: '', first_name: '', last_name: '', company: '' });

  const mutation = useMutation({
    mutationFn: () => apiFetch('/api/email-marketing/contacts', {
      method: 'POST',
      body: JSON.stringify({
        email: form.email || undefined,
        phone: form.phone || undefined,
        first_name: form.first_name || undefined,
        last_name: form.last_name || undefined,
        company: form.company || undefined,
        audience_type: 'warm',
        email_legal_basis: 'consent',
        consent_source: 'manual',
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mkt-contacts'] });
      toast.success('Contatto creato');
      setForm({ email: '', phone: '', first_name: '', last_name: '', company: '' });
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Creazione fallita'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Nuovo contatto</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Email</Label>
              <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="mario@azienda.it" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Telefono</Label>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+39…" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Nome</Label>
              <Input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Cognome</Label>
              <Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label className="text-xs">Azienda</Label>
              <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || (!form.email && !form.phone)}>
            Crea
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
