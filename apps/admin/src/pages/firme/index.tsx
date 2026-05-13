import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FileSignature, Plus, Send, Copy, Check, Trash2, Mail, MessageSquare,
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
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch, API_BASE } from '@/lib/api';
import { cn } from '@/lib/utils';

type SignableType = 'nda' | 'contract' | 'sow' | 'other';
type SignableStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'expired' | 'cancelled';
type SignatureMethod = 'email_otp' | 'sms_otp';

interface Signable {
  id: string;
  type: SignableType;
  title: string;
  signer_name: string | null;
  signer_email: string | null;
  signer_phone: string | null;
  signature_method: SignatureMethod;
  status: SignableStatus;
  sign_token: string;
  sent_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  expires_at: string | null;
  created_at: string;
}

const TYPE_LABEL: Record<SignableType, string> = {
  nda: 'NDA',
  contract: 'Contratto',
  sow: 'SOW',
  other: 'Altro',
};

const STATUS_LABEL: Record<SignableStatus, string> = {
  draft: 'Bozza',
  sent: 'Inviato',
  viewed: 'Visualizzato',
  signed: 'Firmato',
  expired: 'Scaduto',
  cancelled: 'Annullato',
};

const STATUS_BADGE: Record<SignableStatus, string> = {
  draft: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400',
  sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  viewed: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  signed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  expired: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const TEMPLATES: Record<SignableType, string> = {
  nda: `# Accordo di Riservatezza (NDA)

Tra **Calicchia Design di Federico Calicchia** (di seguito "il Fornitore") e **[Nome Cliente]** (di seguito "il Cliente").

## Art. 1 — Oggetto
Le Parti si impegnano a mantenere riservate tutte le informazioni di natura tecnica, commerciale, finanziaria o personale scambiate nell'ambito della trattativa o esecuzione di lavori, salvo quanto già di dominio pubblico.

## Art. 2 — Durata
Gli obblighi di riservatezza permangono per **3 anni** dalla data di firma del presente accordo, anche dopo la cessazione dei rapporti.

## Art. 3 — Eccezioni
Sono escluse dalle informazioni riservate quelle: (a) di dominio pubblico al momento della divulgazione; (b) note al ricevente prima della comunicazione; (c) ottenute lecitamente da terzi.

## Art. 4 — Foro competente
Per ogni controversia sarà competente in via esclusiva il Tribunale di Frosinone.

---

Firmato per accettazione.`,
  contract: `# Contratto di Consulenza

Tra **Calicchia Design di Federico Calicchia** (di seguito "il Fornitore") e **[Nome Cliente]** (di seguito "il Cliente").

## Art. 1 — Oggetto
Il Fornitore si impegna a realizzare per il Cliente i servizi descritti nell'allegato preventivo / SOW.

## Art. 2 — Compenso
Il compenso è quello indicato nel preventivo accettato. I pagamenti seguono lo schedule concordato.

## Art. 3 — Durata
12 mesi dalla data di firma, salvo diversa pattuizione.

## Art. 4 — Proprietà intellettuale
I diritti restano del Fornitore fino al saldo completo; al pagamento finale vengono ceduti al Cliente.

## Art. 5 — Riservatezza
Le Parti si impegnano a mantenere riservate le informazioni scambiate.

## Art. 6 — Recesso
Ciascuna parte può recedere con preavviso scritto di 30 giorni.

## Art. 7 — Foro competente
Tribunale di Frosinone.

---

Firmato per accettazione.`,
  sow: `# Statement of Work — [Nome progetto]

Tra **Calicchia Design di Federico Calicchia** (Fornitore) e **[Nome Cliente]** (Cliente).

## 1. Scope
Descrizione del progetto e degli obiettivi:
- [...]

## 2. Deliverables
- [...]

## 3. Timeline
- Inizio: [data]
- Consegna: [data]
- Milestone:
  - [milestone 1] — [data]
  - [milestone 2] — [data]

## 4. Compenso
Importo totale: € [...]. Schedule di pagamento concordato a parte (vedi preventivo).

## 5. Esclusioni
Quanto NON incluso in questo SOW:
- [...]

## 6. Modifiche
Variazioni al perimetro richiedono Change Order scritto firmato da entrambe le parti.

---

Firmato per accettazione.`,
  other: `# [Titolo documento]

[Inserisci qui il contenuto del documento]

---

Firmato per accettazione.`,
};

interface FormState {
  type: SignableType;
  title: string;
  content_md: string;
  customer_id: string;
  signer_name: string;
  signer_email: string;
  signer_phone: string;
  signature_method: SignatureMethod;
  expires_in_days: string;
}

const EMPTY_FORM: FormState = {
  type: 'nda',
  title: '',
  content_md: TEMPLATES.nda,
  customer_id: '',
  signer_name: '',
  signer_email: '',
  signer_phone: '',
  signature_method: 'email_otp',
  expires_in_days: '14',
};

export default function FirmePage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  useTopbar({
    title: 'Firme',
    subtitle: 'NDA, contratti e SOW con firma elettronica avanzata (OTP)',
  });

  const { data, isLoading } = useQuery<{ signables: Signable[] }>({
    queryKey: ['signables', statusFilter, typeFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (typeFilter !== 'all') params.set('type', typeFilter);
      return apiFetch(`/api/signables?${params.toString()}`);
    },
  });

  const { data: customersData } = useQuery<{ customers: Array<{ id: string; contact_name: string | null; company_name: string | null; email: string }> }>({
    queryKey: ['customers', 'for-signables'],
    queryFn: () => apiFetch('/api/customers?limit=200'),
    enabled: dialogOpen,
  });

  const docs = data?.signables ?? [];
  const customers = customersData?.customers ?? [];

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/signables', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          title: form.title.trim(),
          content_md: form.content_md,
          customer_id: form.customer_id || null,
          signer_name: form.signer_name.trim() || null,
          signer_email: form.signer_email.trim() || null,
          signer_phone: form.signer_phone.trim() || null,
          signature_method: form.signature_method,
          expires_in_days: parseInt(form.expires_in_days, 10) || 14,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signables'] });
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success('Documento creato come bozza');
    },
    onError: (err: any) => toast.error(err?.message || 'Errore creazione'),
  });

  const sendMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/signables/${id}/send`, { method: 'POST' }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['signables'] });
      if (res?.sign_url) {
        navigator.clipboard?.writeText(res.sign_url).catch(() => {});
        toast.success('Link firma copiato negli appunti');
      } else {
        toast.success('Documento inviato');
      }
    },
    onError: (err: any) => toast.error(err?.message || 'Errore invio'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/signables/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signables'] });
      toast.success('Documento annullato');
    },
  });

  const handleTypeChange = (next: SignableType) => {
    setForm((prev) => ({
      ...prev,
      type: next,
      // Aggiorna template solo se contenuto attuale era ancora quello del template precedente
      content_md: prev.content_md === TEMPLATES[prev.type] ? TEMPLATES[next] : prev.content_md,
    }));
  };

  const handleCustomerChange = (id: string) => {
    const c = customers.find((x) => x.id === id);
    setForm((prev) => ({
      ...prev,
      customer_id: id,
      signer_name: c?.contact_name || c?.company_name || prev.signer_name,
      signer_email: c?.email || prev.signer_email,
    }));
  };

  const copyLink = (token: string) => {
    const url = `${API_BASE.replace('/api', '')}/firma/${token}`;
    navigator.clipboard?.writeText(url);
    setCopiedToken(token);
    toast.success('Link copiato');
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const filteredDocs = useMemo(() => docs, [docs]);

  return (
    <div className="space-y-6">
      {/* Filters + new */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="space-y-1 flex-1">
          <Label className="text-xs font-medium">Tipo</Label>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 text-sm sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutti i tipi</SelectItem>
              <SelectItem value="nda">NDA</SelectItem>
              <SelectItem value="contract">Contratto</SelectItem>
              <SelectItem value="sow">SOW</SelectItem>
              <SelectItem value="other">Altro</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 flex-1">
          <Label className="text-xs font-medium">Stato</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 text-sm sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutti gli stati</SelectItem>
              {(Object.keys(STATUS_LABEL) as SignableStatus[]).map((s) => (
                <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => { setForm(EMPTY_FORM); setDialogOpen(true); }} size="sm">
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Nuovo documento
        </Button>
      </div>

      {/* List */}
      {isLoading ? (
        <LoadingState />
      ) : filteredDocs.length === 0 ? (
        <EmptyState
          title="Nessun documento"
          description="Crea il primo NDA, contratto o SOW da firmare."
          icon={FileSignature}
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                <th className="px-4 py-3 font-medium">Documento</th>
                <th className="px-4 py-3 font-medium">Firmatario</th>
                <th className="px-4 py-3 font-medium">Canale</th>
                <th className="px-4 py-3 font-medium">Stato</th>
                <th className="px-4 py-3 font-medium">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {filteredDocs.map((d) => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{d.title}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {TYPE_LABEL[d.type]}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div>{d.signer_name || '—'}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {d.signature_method === 'sms_otp' ? d.signer_phone : d.signer_email}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {d.signature_method === 'sms_otp' ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <MessageSquare className="h-3.5 w-3.5" /> SMS
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Mail className="h-3.5 w-3.5" /> Email
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className={cn('text-xs', STATUS_BADGE[d.status])}>
                      {STATUS_LABEL[d.status]}
                    </Badge>
                    {d.signed_at && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {new Date(d.signed_at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {d.status === 'draft' && (
                        <Button
                          size="sm"
                          variant="default"
                          onClick={() => sendMutation.mutate(d.id)}
                          disabled={sendMutation.isPending}
                        >
                          <Send className="h-3 w-3 mr-1" /> Invia
                        </Button>
                      )}
                      {['sent', 'viewed'].includes(d.status) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => copyLink(d.sign_token)}
                        >
                          {copiedToken === d.sign_token ? (
                            <Check className="h-3 w-3 mr-1" />
                          ) : (
                            <Copy className="h-3 w-3 mr-1" />
                          )}
                          Link
                        </Button>
                      )}
                      {['draft', 'sent', 'viewed'].includes(d.status) && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => {
                            if (window.confirm('Annullare questo documento?')) {
                              deleteMutation.mutate(d.id);
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nuovo documento da firmare</DialogTitle>
            <DialogDescription>
              Compila il template — il firmatario riceverà un OTP via {form.signature_method === 'sms_otp' ? 'SMS' : 'email'} per firmare.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs font-medium">Tipo *</Label>
                <Select value={form.type} onValueChange={(v) => handleTypeChange(v as SignableType)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nda">NDA — Accordo di riservatezza</SelectItem>
                    <SelectItem value="contract">Contratto consulenza</SelectItem>
                    <SelectItem value="sow">SOW — Statement of Work</SelectItem>
                    <SelectItem value="other">Altro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">Validità (giorni)</Label>
                <Input
                  type="number"
                  min="1"
                  max="365"
                  value={form.expires_in_days}
                  onChange={(e) => setForm({ ...form, expires_in_days: e.target.value })}
                  className="h-9 text-sm tabular-nums"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Titolo *</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder={`Es. NDA progetto X · Cliente Y`}
                className="h-9 text-sm"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Cliente (opzionale)</Label>
              <Select value={form.customer_id || 'none'} onValueChange={(v) => handleCustomerChange(v === 'none' ? '' : v)}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Cliente esistente" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Nessun cliente —</SelectItem>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.contact_name || c.company_name || c.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs font-medium">Nome firmatario</Label>
                <Input
                  value={form.signer_name}
                  onChange={(e) => setForm({ ...form, signer_name: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">Canale OTP *</Label>
                <Select value={form.signature_method} onValueChange={(v) => setForm({ ...form, signature_method: v as SignatureMethod })}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email_otp">Email OTP</SelectItem>
                    <SelectItem value="sms_otp">SMS OTP (richiede Twilio)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">
                  Email {form.signature_method === 'email_otp' && '*'}
                </Label>
                <Input
                  type="email"
                  value={form.signer_email}
                  onChange={(e) => setForm({ ...form, signer_email: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">
                  Telefono {form.signature_method === 'sms_otp' && '*'}
                </Label>
                <Input
                  type="tel"
                  value={form.signer_phone}
                  onChange={(e) => setForm({ ...form, signer_phone: e.target.value })}
                  placeholder="+39 ..."
                  className="h-9 text-sm tabular-nums"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Contenuto (Markdown)</Label>
              <Textarea
                value={form.content_md}
                onChange={(e) => setForm({ ...form, content_md: e.target.value })}
                rows={15}
                className="text-xs font-mono"
              />
              <p className="text-[10px] text-muted-foreground">
                Personalizza il template — sostituisci [Nome Cliente], [Titolo progetto], date, ecc.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Annulla</Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={
                createMutation.isPending
                || !form.title.trim()
                || !form.content_md.trim()
                || (form.signature_method === 'email_otp' && !form.signer_email.trim())
                || (form.signature_method === 'sms_otp' && !form.signer_phone.trim())
              }
            >
              {createMutation.isPending ? 'Creazione...' : 'Crea bozza'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
