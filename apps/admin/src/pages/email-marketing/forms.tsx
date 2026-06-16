import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileCode, Plus, Trash2, Copy, Code2, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';

interface MktForm {
  id: string; name: string; slug: string; status: string;
  double_optin: boolean; submission_count: number; target_list_id: string | null;
}

export default function FormsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [snippetFor, setSnippetFor] = useState<MktForm | null>(null);

  const { data, isLoading } = useQuery<{ forms: MktForm[] }>({
    queryKey: ['mkt-forms'], queryFn: () => apiFetch('/api/email-marketing/forms'),
  });
  const forms = data?.forms ?? [];

  const { data: lists } = useQuery<{ lists: { id: string; name: string }[] }>({
    queryKey: ['mkt-lists'], queryFn: () => apiFetch('/api/email-marketing/lists'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/email-marketing/forms/${id}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['mkt-forms'] }); toast.success('Form eliminato'); },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Eliminazione fallita'),
  });

  const actions = useMemo(() => (
    <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
      <Plus className="h-4 w-4" /> Nuovo form
    </Button>
  ), []);

  useTopbar({ title: 'Form di iscrizione', subtitle: `${forms.length} form`, actions });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      {forms.length === 0 ? (
        <EmptyState title="Nessun form" description="Crea un form di iscrizione embeddabile su qualsiasi landing page." icon={FileCode} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {forms.map((f) => (
            <div key={f.id} className="rounded-lg border bg-card p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-medium truncate">{f.name}</h3>
                  <p className="text-xs text-muted-foreground font-mono truncate">/{f.slug}</p>
                </div>
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => deleteMutation.mutate(f.id)} aria-label="Elimina">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="secondary" className="text-[10px] gap-1"><Inbox className="h-3 w-3" />{f.submission_count} iscrizioni</Badge>
                {f.double_optin && <Badge variant="outline" className="text-[10px]">double opt-in</Badge>}
                {f.status === 'disabled' && <Badge variant="outline" className="text-[10px]">disattivo</Badge>}
              </div>
              <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => setSnippetFor(f)}>
                <Code2 className="h-3.5 w-3.5" /> Codice embed
              </Button>
            </div>
          ))}
        </div>
      )}

      <CreateFormDialog open={createOpen} onOpenChange={setCreateOpen} lists={lists?.lists ?? []} />
      {snippetFor && <SnippetDialog form={snippetFor} onClose={() => setSnippetFor(null)} />}
    </div>
  );
}

function CreateFormDialog({ open, onOpenChange, lists }: {
  open: boolean; onOpenChange: (o: boolean) => void; lists: { id: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [targetListId, setTargetListId] = useState('');
  const [doubleOptin, setDoubleOptin] = useState(true);
  const [audienceType, setAudienceType] = useState('warm');
  const [allowedOrigins, setAllowedOrigins] = useState('');
  const [successMessage, setSuccessMessage] = useState('Iscrizione ricevuta. Controlla la tua email.');

  const mutation = useMutation({
    mutationFn: () => apiFetch('/api/email-marketing/forms', {
      method: 'POST',
      body: JSON.stringify({
        name,
        target_list_id: targetListId || null,
        double_optin: doubleOptin,
        audience_type: audienceType,
        default_legal_basis: 'consent',
        allowed_origins: allowedOrigins.split(',').map((o) => o.trim()).filter(Boolean),
        success_message: successMessage,
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mkt-forms'] });
      toast.success('Form creato');
      setName(''); setAllowedOrigins('');
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Creazione fallita'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuovo form di iscrizione</DialogTitle>
          <DialogDescription>Campi predefiniti: Email + Nome. Embeddabile su qualsiasi sito.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="es. Iscrizione landing estate" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Lista di destinazione</Label>
              <Select value={targetListId} onValueChange={setTargetListId}>
                <SelectTrigger><SelectValue placeholder="Nessuna" /></SelectTrigger>
                <SelectContent>{lists.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Audience</Label>
              <Select value={audienceType} onValueChange={setAudienceType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="warm">Caldo</SelectItem>
                  <SelectItem value="cold">Freddo</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Origini autorizzate (domini, separati da virgola — vuoto = tutte)</Label>
            <Input value={allowedOrigins} onChange={(e) => setAllowedOrigins(e.target.value)} placeholder="https://landing.esempio.it" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Messaggio di successo</Label>
            <Textarea value={successMessage} onChange={(e) => setSuccessMessage(e.target.value)} className="min-h-[60px]" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={doubleOptin} onChange={(e) => setDoubleOptin(e.target.checked)} />
            Double opt-in (email di conferma — consigliato)
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name.trim()}>Crea</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SnippetDialog({ form, onClose }: { form: MktForm; onClose: () => void }) {
  const base = window.location.origin;
  const snippet = `<script src="${base}/api/mkt-forms/${form.slug}/embed.js" async></script>`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Codice embed — {form.name}</DialogTitle>
          <DialogDescription>Incolla questo snippet nella landing page. Il form si renderizza al suo posto.</DialogDescription>
        </DialogHeader>
        <pre className="rounded-lg border bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap break-all">{snippet}</pre>
        <DialogFooter>
          <Button onClick={() => { navigator.clipboard.writeText(snippet); toast.success('Copiato'); }} className="gap-1.5">
            <Copy className="h-4 w-4" /> Copia snippet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
