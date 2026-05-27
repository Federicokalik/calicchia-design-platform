import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ShieldAlert, Mail, Calendar, Filter, Download, Trash2,
  CheckCircle2, Clock, XCircle, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';

interface GdprRequest {
  id: string;
  email: string;
  name: string | null;
  request_type: 'access' | 'rectification' | 'erasure' | 'restriction' | 'portability' | 'objection';
  message: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'rejected';
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const TYPE_LABELS: Record<GdprRequest['request_type'], string> = {
  access: 'Accesso',
  rectification: 'Rettifica',
  erasure: 'Cancellazione',
  restriction: 'Limitazione',
  portability: 'Portabilità',
  objection: 'Opposizione',
};

const STATUS_CONFIG: Record<GdprRequest['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: typeof Clock }> = {
  pending: { label: 'In attesa', variant: 'secondary', icon: Clock },
  in_progress: { label: 'In lavorazione', variant: 'default', icon: Loader2 },
  completed: { label: 'Completata', variant: 'outline', icon: CheckCircle2 },
  rejected: { label: 'Rifiutata', variant: 'destructive', icon: XCircle },
};

export default function GdprRequestsPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selected, setSelected] = useState<GdprRequest | null>(null);
  const [eraseConfirmFor, setEraseConfirmFor] = useState<GdprRequest | null>(null);
  const [eraseConfirmText, setEraseConfirmText] = useState('');

  const { data, isLoading } = useQuery<{ requests: GdprRequest[]; stats: Array<{ status: string; count: number }> }>({
    queryKey: ['gdpr-requests', statusFilter],
    queryFn: () => apiFetch(`/api/gdpr-requests?status=${statusFilter}`),
  });
  const requests = data?.requests ?? [];

  const stats = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of data?.stats ?? []) map.set(s.status, s.count);
    return {
      pending: map.get('pending') ?? 0,
      in_progress: map.get('in_progress') ?? 0,
      completed: map.get('completed') ?? 0,
      total: Array.from(map.values()).reduce((a, b) => a + b, 0),
    };
  }, [data?.stats]);

  const updateMutation = useMutation({
    mutationFn: (args: { id: string; patch: Partial<GdprRequest> }) =>
      apiFetch(`/api/gdpr-requests/${args.id}`, {
        method: 'PUT',
        body: JSON.stringify(args.patch),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gdpr-requests'] });
      toast.success('Richiesta aggiornata');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore aggiornamento'),
  });

  function handleExport(email: string) {
    const url = `/api/gdpr-requests/export/${encodeURIComponent(email)}`;
    // Browser fetches with cookies → server returns JSON; we trigger a download.
    apiFetch(url)
      .then((json: unknown) => {
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `gdpr-export-${email.replace(/[^a-z0-9]/gi, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
        toast.success('Export scaricato');
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Export fallito'));
  }

  const eraseMutation = useMutation({
    mutationFn: (email: string) =>
      apiFetch(`/api/gdpr-requests/erase/${encodeURIComponent(email)}`, { method: 'DELETE' }),
    onSuccess: (data: any) => {
      const msg = `Cancellati: ${Object.values(data?.deleted ?? {}).reduce((a: number, b) => a + Number(b), 0)} record · Anonimizzati: ${Object.values(data?.anonymized ?? {}).reduce((a: number, b) => a + Number(b), 0)}`;
      toast.success(msg, { duration: 6000 });
      queryClient.invalidateQueries({ queryKey: ['gdpr-requests'] });
      setEraseConfirmFor(null);
      setEraseConfirmText('');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Cancellazione fallita'),
  });

  useTopbar({
    title: 'Richieste GDPR',
    subtitle: `${stats.total} richieste · ${stats.pending} in attesa · ${stats.in_progress} in lavorazione`,
  });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti gli stati</SelectItem>
            <SelectItem value="pending">In attesa</SelectItem>
            <SelectItem value="in_progress">In lavorazione</SelectItem>
            <SelectItem value="completed">Completate</SelectItem>
            <SelectItem value="rejected">Rifiutate</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {requests.length === 0 ? (
        <EmptyState
          title="Nessuna richiesta GDPR"
          description="Le richieste inviate dal form pubblico appariranno qui."
          icon={ShieldAlert}
        />
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {requests.map((r) => {
            const cfg = STATUS_CONFIG[r.status];
            const Icon = cfg.icon;
            return (
              <div key={r.id} className="p-4 hover:bg-muted/40 cursor-pointer" onClick={() => setSelected(r)}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-xs">{TYPE_LABELS[r.request_type]}</Badge>
                      <Badge variant={cfg.variant} className="gap-1 text-xs">
                        <Icon className="h-3 w-3" /> {cfg.label}
                      </Badge>
                      {r.name && <span className="text-sm font-medium">{r.name}</span>}
                    </div>
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> {r.email}</span>
                      <span className="flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" /> {new Date(r.created_at).toLocaleString('it-IT')}</span>
                    </div>
                    {r.message && <p className="text-sm text-foreground/80 line-clamp-2 mt-1">{r.message}</p>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail / actions dialog */}
      {selected && (
        <AlertDialog open onOpenChange={(open) => !open && setSelected(null)}>
          <AlertDialogContent className="max-w-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5" />
                Richiesta {TYPE_LABELS[selected.request_type]}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 pt-2 text-sm">
                  <div><span className="text-muted-foreground">Email:</span> <span className="font-medium text-foreground">{selected.email}</span></div>
                  {selected.name && <div><span className="text-muted-foreground">Nome:</span> {selected.name}</div>}
                  <div><span className="text-muted-foreground">Inviata:</span> {new Date(selected.created_at).toLocaleString('it-IT')}</div>
                  {selected.message && (
                    <div className="rounded-md border bg-muted/30 p-3 mt-3 whitespace-pre-wrap text-foreground/80">{selected.message}</div>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Stato:</span>
                <Select
                  value={selected.status}
                  onValueChange={(v) => updateMutation.mutate({ id: selected.id, patch: { status: v as GdprRequest['status'] } })}
                >
                  <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">In attesa</SelectItem>
                    <SelectItem value="in_progress">In lavorazione</SelectItem>
                    <SelectItem value="completed">Completata</SelectItem>
                    <SelectItem value="rejected">Rifiutata</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Textarea
                placeholder="Note interne…"
                value={selected.admin_notes ?? ''}
                onChange={(e) => setSelected({ ...selected, admin_notes: e.target.value })}
                onBlur={() => updateMutation.mutate({ id: selected.id, patch: { admin_notes: selected.admin_notes } })}
                rows={3}
              />

              <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
                <Button size="sm" variant="outline" onClick={() => handleExport(selected.email)} className="gap-1.5">
                  <Download className="h-3.5 w-3.5" /> Esporta dati ({selected.email})
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => { setEraseConfirmFor(selected); setEraseConfirmText(''); }}
                  className="gap-1.5"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Cancella dati
                </Button>
              </div>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel>Chiudi</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Erase double-confirm */}
      {eraseConfirmFor && (
        <AlertDialog open onOpenChange={(open) => !open && setEraseConfirmFor(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-destructive flex items-center gap-2">
                <Trash2 className="h-5 w-5" /> Cancellazione irreversibile
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 pt-2 text-sm">
                  <p>
                    Stai per cancellare tutti i dati personali associati a <strong>{eraseConfirmFor.email}</strong>.
                    Contatti, newsletter, conversazioni WhatsApp, sessioni portale e preferenze comunicazione verranno
                    eliminati. Cliente/lead collegati a fatture verranno anonimizzati (i record fiscali sopravvivono per
                    obbligo di legge 10 anni).
                  </p>
                  <p className="font-medium text-foreground">
                    Digita <code className="bg-muted px-1.5 py-0.5 rounded">CANCELLA</code> per confermare:
                  </p>
                  <Textarea
                    value={eraseConfirmText}
                    onChange={(e) => setEraseConfirmText(e.target.value)}
                    rows={1}
                    placeholder="CANCELLA"
                    autoFocus
                  />
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annulla</AlertDialogCancel>
              <AlertDialogAction
                disabled={eraseConfirmText !== 'CANCELLA' || eraseMutation.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  eraseMutation.mutate(eraseConfirmFor.email);
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {eraseMutation.isPending ? 'Cancellazione…' : 'Conferma cancellazione'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
