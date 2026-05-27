import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Package, Plus, Calendar, MessageSquare, CheckCircle2, AlertCircle,
  Clock, FileBox, Upload, Trash2, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

interface DeliverableVersion {
  id: string;
  version_number: number;
  title: string | null;
  notes: string | null;
  file_url: string | null;
  file_name: string | null;
  preview_url: string | null;
  is_current: boolean;
  uploaded_at: string | null;
}

interface DeliverableFeedback {
  id: string;
  version_id: string | null;
  author_type: string;
  author_name: string | null;
  feedback_text: string;
  feedback_type: 'revision' | 'approval' | 'comment';
  is_resolved: boolean;
  created_at: string;
}

interface Deliverable {
  id: string;
  title: string;
  description: string | null;
  deliverable_type: string;
  status: 'pending' | 'in_progress' | 'client_review' | 'revision_requested' | 'approved' | 'delivered';
  revision_limit: number;
  revision_count: number;
  due_date: string | null;
  versions: DeliverableVersion[] | null;
  feedback: DeliverableFeedback[] | null;
  open_feedback_count?: number;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_CONFIG: Record<Deliverable['status'], { label: string; icon: typeof Clock; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  pending: { label: 'In attesa', icon: Clock, variant: 'secondary' },
  in_progress: { label: 'In lavorazione', icon: Clock, variant: 'default' },
  client_review: { label: 'Review cliente', icon: MessageSquare, variant: 'default' },
  revision_requested: { label: 'Revisione richiesta', icon: AlertCircle, variant: 'destructive' },
  approved: { label: 'Approvato', icon: CheckCircle2, variant: 'outline' },
  delivered: { label: 'Consegnato', icon: CheckCircle2, variant: 'outline' },
};

export function DeliverablesPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState('design');
  const [versionFor, setVersionFor] = useState<Deliverable | null>(null);
  const [versionUrl, setVersionUrl] = useState('');
  const [versionName, setVersionName] = useState('');
  const [versionNotes, setVersionNotes] = useState('');

  const { data, isLoading } = useQuery<{ deliverables: Deliverable[] }>({
    queryKey: ['project-deliverables', projectId],
    queryFn: () => apiFetch(`/api/deliverables?project_id=${projectId}`),
  });
  const deliverables = data?.deliverables ?? [];

  const createMutation = useMutation({
    mutationFn: (body: { project_id: string; title: string; deliverable_type: string }) =>
      apiFetch('/api/deliverables', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-deliverables', projectId] });
      setShowNew(false);
      setNewTitle('');
      setNewType('design');
      toast.success('Consegna creata');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Creazione fallita'),
  });

  const versionMutation = useMutation({
    mutationFn: (args: { id: string; file_url: string; file_name?: string; notes?: string }) =>
      apiFetch(`/api/deliverables/${args.id}/versions`, {
        method: 'POST',
        body: JSON.stringify({
          file_url: args.file_url,
          file_name: args.file_name,
          notes: args.notes,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-deliverables', projectId] });
      setVersionFor(null);
      setVersionUrl('');
      setVersionName('');
      setVersionNotes('');
      toast.success('Nuova versione caricata · stato → review cliente');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Upload versione fallito'),
  });

  const statusMutation = useMutation({
    mutationFn: (args: { id: string; status: Deliverable['status'] }) =>
      apiFetch(`/api/deliverables/${args.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: args.status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-deliverables', projectId] });
      toast.success('Stato aggiornato');
    },
  });

  const resolveFeedback = useMutation({
    mutationFn: (feedbackId: string) =>
      apiFetch(`/api/deliverables/feedback/${feedbackId}/resolve`, { method: 'PATCH' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-deliverables', projectId] });
      toast.success('Feedback risolto');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/deliverables/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-deliverables', projectId] });
      toast.success('Consegna eliminata');
    },
  });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Consegne del progetto</h3>
          <p className="text-xs text-muted-foreground">
            Versioning, feedback del cliente e flusso di approvazione.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowNew(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Nuova consegna
        </Button>
      </div>

      {deliverables.length === 0 ? (
        <EmptyState
          title="Nessuna consegna"
          description="Crea la prima consegna per condividere file e raccogliere approvazioni dal cliente."
          icon={Package}
        />
      ) : (
        <div className="space-y-3">
          {deliverables.map((d) => {
            const cfg = STATUS_CONFIG[d.status];
            const Icon = cfg.icon;
            const currentVersion = d.versions?.find((v) => v.is_current) ?? null;
            const openFeedback = (d.feedback ?? []).filter((f) => !f.is_resolved);
            return (
              <div key={d.id} className="rounded-lg border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <FileBox className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{d.title}</span>
                      <Badge variant="outline" className="text-xs">{d.deliverable_type}</Badge>
                      <Badge variant={cfg.variant} className="text-xs gap-1">
                        <Icon className="h-3 w-3" /> {cfg.label}
                      </Badge>
                      {(d.open_feedback_count ?? openFeedback.length) > 0 && (
                        <Badge variant="destructive" className="text-xs">
                          {d.open_feedback_count ?? openFeedback.length} feedback aperti
                        </Badge>
                      )}
                    </div>
                    {d.description && <p className="text-sm text-muted-foreground">{d.description}</p>}
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      {d.due_date && (
                        <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> Scadenza {new Date(d.due_date).toLocaleDateString('it-IT')}</span>
                      )}
                      <span>Revisioni: {d.revision_count}/{d.revision_limit}</span>
                      {currentVersion && (
                        <span>v{currentVersion.version_number}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Select
                      value={d.status}
                      onValueChange={(v) => statusMutation.mutate({ id: d.id, status: v as Deliverable['status'] })}
                    >
                      <SelectTrigger className="w-[160px] h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">In attesa</SelectItem>
                        <SelectItem value="in_progress">In lavorazione</SelectItem>
                        <SelectItem value="client_review">Review cliente</SelectItem>
                        <SelectItem value="revision_requested">Revisione richiesta</SelectItem>
                        <SelectItem value="approved">Approvato</SelectItem>
                        <SelectItem value="delivered">Consegnato</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" onClick={() => setVersionFor(d)} className="gap-1.5">
                      <Upload className="h-3.5 w-3.5" /> Versione
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => deleteMutation.mutate(d.id)} className="h-8 w-8" aria-label="Elimina">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {currentVersion && (
                  <div className="rounded-md bg-muted/30 p-3 text-sm flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileBox className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">v{currentVersion.version_number}</span>
                      {currentVersion.file_name && <span className="text-muted-foreground">— {currentVersion.file_name}</span>}
                    </div>
                    {currentVersion.file_url && (
                      <a href={currentVersion.file_url} target="_blank" rel="noopener" className="text-xs text-primary inline-flex items-center gap-1">
                        Apri <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                )}

                {openFeedback.length > 0 && (
                  <div className="border-t pt-3 space-y-2">
                    <span className="text-xs font-medium text-muted-foreground">Feedback aperti</span>
                    {openFeedback.map((f) => (
                      <div
                        key={f.id}
                        className={cn(
                          'rounded-md border p-3 text-sm flex items-start justify-between gap-3',
                          f.feedback_type === 'revision' && 'border-destructive/40 bg-destructive/5',
                          f.feedback_type === 'approval' && 'border-primary/40 bg-primary/5',
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                            <span>{f.author_name || f.author_type}</span>
                            <Badge variant="outline" className="text-[10px]">{f.feedback_type}</Badge>
                            <span>· {new Date(f.created_at).toLocaleString('it-IT')}</span>
                          </div>
                          <p className="whitespace-pre-wrap">{f.feedback_text}</p>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => resolveFeedback.mutate(f.id)}>
                          Risolvi
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuova consegna</DialogTitle>
            <DialogDescription>
              Crea una consegna per questo progetto. Potrai caricare versioni successive in seguito.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="title">Titolo</Label>
              <Input id="title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Es. Mockup home" />
            </div>
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select value={newType} onValueChange={setNewType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="design">Design</SelectItem>
                  <SelectItem value="document">Documento</SelectItem>
                  <SelectItem value="code">Codice</SelectItem>
                  <SelectItem value="other">Altro</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNew(false)}>Annulla</Button>
            <Button
              disabled={!newTitle.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate({ project_id: projectId, title: newTitle.trim(), deliverable_type: newType })}
            >
              {createMutation.isPending ? 'Creo…' : 'Crea consegna'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!versionFor} onOpenChange={(open) => { if (!open) setVersionFor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuova versione di "{versionFor?.title}"</DialogTitle>
            <DialogDescription>
              Inserisci l'URL del file (es. link MEGA S4, Google Drive o /media/&hellip;). Una volta caricata,
              la consegna passa in <strong>review cliente</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="file_url">URL file</Label>
              <Input id="file_url" value={versionUrl} onChange={(e) => setVersionUrl(e.target.value)} placeholder="https://…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="file_name">Nome file (opzionale)</Label>
              <Input id="file_name" value={versionName} onChange={(e) => setVersionName(e.target.value)} placeholder="mockup-home-v3.fig" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="version_notes">Note versione (opzionale)</Label>
              <Textarea id="version_notes" rows={3} value={versionNotes} onChange={(e) => setVersionNotes(e.target.value)} placeholder="Cosa è cambiato rispetto alla versione precedente" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVersionFor(null)}>Annulla</Button>
            <Button
              disabled={!versionUrl.trim() || !versionFor || versionMutation.isPending}
              onClick={() => versionFor && versionMutation.mutate({
                id: versionFor.id,
                file_url: versionUrl.trim(),
                file_name: versionName.trim() || undefined,
                notes: versionNotes.trim() || undefined,
              })}
            >
              {versionMutation.isPending ? 'Caricamento…' : 'Carica versione'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
