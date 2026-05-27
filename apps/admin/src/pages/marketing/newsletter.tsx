import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MailPlus, Mail, Calendar, Filter, Download, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';

interface NewsletterSubscriber {
  id: string;
  email: string;
  name: string | null;
  status: 'pending' | 'confirmed' | 'unsubscribed';
  confirmed_at: string | null;
  consent_ip: string | null;
  consent_user_agent: string | null;
  created_at: string;
}

interface NewsletterPayload {
  subscribers: NewsletterSubscriber[];
  stats: { total: number; confirmed: number; pending: number; unsubscribed: number };
}

const STATUS_CONFIG: Record<NewsletterSubscriber['status'], { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  pending: { label: 'In conferma', variant: 'secondary' },
  confirmed: { label: 'Confermato', variant: 'default' },
  unsubscribed: { label: 'Disiscritto', variant: 'outline' },
};

export default function NewsletterPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [deleteFor, setDeleteFor] = useState<NewsletterSubscriber | null>(null);

  const { data, isLoading } = useQuery<NewsletterPayload>({
    queryKey: ['newsletter-subscribers', statusFilter],
    queryFn: () => apiFetch(`/api/newsletter?status=${statusFilter}&limit=500`),
  });
  const subscribers = data?.subscribers ?? [];
  const stats = data?.stats ?? { total: 0, confirmed: 0, pending: 0, unsubscribed: 0 };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/newsletter/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['newsletter-subscribers'] });
      toast.success('Iscritto eliminato');
      setDeleteFor(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Eliminazione fallita'),
  });

  function handleCsvExport() {
    const rows = subscribers.map((s) => ({
      email: s.email,
      name: s.name ?? '',
      status: s.status,
      confirmed_at: s.confirmed_at ?? '',
      created_at: s.created_at,
      consent_ip: s.consent_ip ?? '',
      consent_user_agent: s.consent_user_agent ?? '',
    }));
    const headers = Object.keys(rows[0] ?? {});
    const csv = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => {
        const v = String((r as Record<string, string>)[h] ?? '').replace(/"/g, '""');
        return `"${v}"`;
      }).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `newsletter-${statusFilter}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success('CSV scaricato');
  }

  const topbarActions = useMemo(() => (
    <Button size="sm" variant="outline" onClick={handleCsvExport} disabled={subscribers.length === 0} className="gap-1.5">
      <Download className="h-4 w-4" /> Esporta CSV
    </Button>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [subscribers.length, statusFilter]);

  useTopbar({
    title: 'Newsletter',
    subtitle: `${stats.total} iscritti · ${stats.confirmed} confermati · ${stats.pending} in conferma · ${stats.unsubscribed} disiscritti`,
    actions: topbarActions,
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
            <SelectItem value="all">Tutti</SelectItem>
            <SelectItem value="pending">In conferma</SelectItem>
            <SelectItem value="confirmed">Confermati</SelectItem>
            <SelectItem value="unsubscribed">Disiscritti</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {subscribers.length === 0 ? (
        <EmptyState
          title="Nessun iscritto"
          description="Gli iscritti dalla newsletter del sito pubblico appariranno qui."
          icon={MailPlus}
        />
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {subscribers.map((s) => {
            const cfg = STATUS_CONFIG[s.status];
            return (
              <div key={s.id} className="p-3 flex items-center justify-between gap-4 hover:bg-muted/40">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate">{s.email}</span>
                    {s.name && <span className="text-sm text-muted-foreground">— {s.name}</span>}
                    <Badge variant={cfg.variant} className="text-xs">{cfg.label}</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Calendar className="h-3 w-3" />
                      Iscritto {new Date(s.created_at).toLocaleDateString('it-IT')}
                    </span>
                    {s.confirmed_at && (
                      <span>Confermato {new Date(s.confirmed_at).toLocaleDateString('it-IT')}</span>
                    )}
                    {s.consent_ip && <span className="font-mono">{s.consent_ip}</span>}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setDeleteFor(s)}
                  aria-label="Elimina iscritto"
                  className="h-8 w-8"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {deleteFor && (
        <AlertDialog open onOpenChange={(open) => !open && setDeleteFor(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Eliminare {deleteFor.email}?</AlertDialogTitle>
              <AlertDialogDescription>
                L'iscritto verrà rimosso dal database. Per cancellazione completa GDPR (con WhatsApp/contatti),
                usa la pagina Richieste GDPR.
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
