import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Inbox, Mail, Phone, Calendar, Filter,
  Trash2, Archive, ArchiveRestore, Eye, UserPlus, Tag,
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
import { useLocalizedPath } from '@/hooks/use-localized-navigation';

interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  message: string | null;
  services: string[] | null;
  sectors: string[] | null;
  wants_call: boolean;
  wants_meet: boolean;
  gdpr_consent: boolean;
  source_page: string | null;
  source_service: string | null;
  source_profession: string | null;
  lead_source: string | null;
  is_read: boolean;
  is_archived: boolean;
  consent_ip: string | null;
  consent_user_agent: string | null;
  created_at: string;
}

export default function ContattiPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const localizedPath = useLocalizedPath();
  const [filter, setFilter] = useState<string>('all');
  const [deleteFor, setDeleteFor] = useState<Contact | null>(null);
  const [opened, setOpened] = useState<Contact | null>(null);

  const { data, isLoading } = useQuery<{ contacts: Contact[] }>({
    queryKey: ['contacts', filter],
    queryFn: () => apiFetch(`/api/contacts?filter=${filter}`),
  });
  const contacts = data?.contacts ?? [];

  const stats = useMemo(() => {
    const total = contacts.length;
    const unread = contacts.filter((c) => !c.is_read).length;
    return { total, unread };
  }, [contacts]);

  const markRead = useMutation({
    mutationFn: (args: { id: string; is_read: boolean }) =>
      apiFetch(`/api/contacts/${args.id}/read`, {
        method: 'PUT',
        body: JSON.stringify({ is_read: args.is_read }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contacts'] }),
  });

  const toggleArchive = useMutation({
    mutationFn: (args: { id: string; is_archived: boolean }) =>
      apiFetch(`/api/contacts/${args.id}/archive`, {
        method: 'PUT',
        body: JSON.stringify({ is_archived: args.is_archived }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast.success('Aggiornato');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setDeleteFor(null);
      toast.success('Contatto eliminato');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Eliminazione fallita'),
  });

  const promoteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/contacts/${id}/promote-to-lead`, { method: 'POST' }),
    onSuccess: (data: { lead: { id: string }; alreadyExisted: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast.success(data.alreadyExisted ? 'Lead già esistente — apro la pipeline' : 'Lead creato — apro la pipeline');
      setOpened(null);
      // No /leads/:id route — leads live in the pipeline kanban. Open it so the
      // newly created card is visible.
      navigate(localizedPath('/pipeline'));
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Promozione fallita'),
  });

  useTopbar({
    title: 'Contatti dal sito',
    subtitle: `${stats.total} totali · ${stats.unread} da leggere`,
  });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti</SelectItem>
            <SelectItem value="unread">Non letti</SelectItem>
            <SelectItem value="read">Letti</SelectItem>
            <SelectItem value="archived">Archiviati</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {contacts.length === 0 ? (
        <EmptyState
          title="Inbox vuota"
          description="I messaggi inviati dal form contatti del sito appariranno qui."
          icon={Inbox}
        />
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {contacts.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setOpened(c);
                if (!c.is_read) markRead.mutate({ id: c.id, is_read: true });
              }}
              className={`w-full text-left p-4 hover:bg-muted/40 transition-colors ${!c.is_read ? 'bg-primary/[0.03]' : ''}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {!c.is_read && <span className="h-2 w-2 rounded-full bg-primary" aria-label="Non letto" />}
                    <span className="text-sm font-medium">{c.name}</span>
                    {c.company && <span className="text-sm text-muted-foreground">· {c.company}</span>}
                    {c.is_archived && <Badge variant="outline" className="text-xs">Archiviato</Badge>}
                    {c.wants_meet && <Badge variant="secondary" className="text-xs">Vuole call</Badge>}
                    {c.lead_source && <Badge variant="default" className="text-xs">{c.lead_source}</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {c.email}</span>
                    {c.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {c.phone}</span>}
                    <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> {new Date(c.created_at).toLocaleString('it-IT')}</span>
                  </div>
                  {c.message && <p className="text-sm text-foreground/80 line-clamp-2">{c.message}</p>}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {opened && (
        <AlertDialog open onOpenChange={(open) => !open && setOpened(null)}>
          <AlertDialogContent className="max-w-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Contatto da {opened.name}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 pt-2 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className="text-muted-foreground">Email:</span> <span className="font-medium text-foreground">{opened.email}</span></div>
                    {opened.phone && <div><span className="text-muted-foreground">Tel:</span> {opened.phone}</div>}
                    {opened.company && <div><span className="text-muted-foreground">Azienda:</span> {opened.company}</div>}
                    <div><span className="text-muted-foreground">Inviato:</span> {new Date(opened.created_at).toLocaleString('it-IT')}</div>
                    {opened.source_page && <div><span className="text-muted-foreground">Pagina:</span> {opened.source_page}</div>}
                    {opened.source_service && <div><span className="text-muted-foreground">Servizio:</span> {opened.source_service}</div>}
                    {opened.consent_ip && <div><span className="text-muted-foreground">IP consenso:</span> <span className="font-mono text-xs">{opened.consent_ip}</span></div>}
                  </div>

                  {(opened.services?.length || opened.sectors?.length) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                      {opened.services?.map((s) => <Badge key={`s-${s}`} variant="outline" className="text-xs">{s}</Badge>)}
                      {opened.sectors?.map((s) => <Badge key={`sec-${s}`} variant="secondary" className="text-xs">{s}</Badge>)}
                    </div>
                  )}

                  {opened.message && (
                    <div className="rounded-md border bg-muted/30 p-3 whitespace-pre-wrap text-foreground/80">{opened.message}</div>
                  )}

                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant={opened.gdpr_consent ? 'default' : 'destructive'}>
                      GDPR consenso: {opened.gdpr_consent ? 'sì' : 'no'}
                    </Badge>
                    {opened.wants_call && <Badge variant="outline">Vuole chiamata</Badge>}
                    {opened.wants_meet && <Badge variant="outline">Vuole call</Badge>}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-3 border-t">
                    <Button size="sm" onClick={() => promoteMutation.mutate(opened.id)} disabled={promoteMutation.isPending} className="gap-1.5">
                      <UserPlus className="h-3.5 w-3.5" /> {promoteMutation.isPending ? 'Promuovo…' : 'Promuovi a Lead'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => markRead.mutate({ id: opened.id, is_read: !opened.is_read })} className="gap-1.5">
                      <Eye className="h-3.5 w-3.5" /> Segna come {opened.is_read ? 'non letto' : 'letto'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => toggleArchive.mutate({ id: opened.id, is_archived: !opened.is_archived })} className="gap-1.5">
                      {opened.is_archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                      {opened.is_archived ? 'Rimuovi archivio' : 'Archivia'}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => { setOpened(null); setDeleteFor(opened); }} className="gap-1.5">
                      <Trash2 className="h-3.5 w-3.5" /> Elimina
                    </Button>
                  </div>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Chiudi</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {deleteFor && (
        <AlertDialog open onOpenChange={(open) => !open && setDeleteFor(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Eliminare il contatto?</AlertDialogTitle>
              <AlertDialogDescription>
                Il contatto da <strong>{deleteFor.email}</strong> verrà eliminato. Eventuali lead già creati restano in pipeline.
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
