import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Layers, Plus, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

interface MktList {
  id: string;
  name: string;
  description: string | null;
  kind: 'static' | 'imported';
  member_count: number;
  created_at: string;
}

export default function ListsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [deleteFor, setDeleteFor] = useState<MktList | null>(null);

  const { data, isLoading } = useQuery<{ lists: MktList[] }>({
    queryKey: ['mkt-lists'],
    queryFn: () => apiFetch('/api/email-marketing/lists'),
  });
  const lists = data?.lists ?? [];

  const createMutation = useMutation({
    mutationFn: () => apiFetch('/api/email-marketing/lists', {
      method: 'POST',
      body: JSON.stringify({ name, description: description || undefined }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mkt-lists'] });
      toast.success('Lista creata');
      setName(''); setDescription(''); setCreateOpen(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Creazione fallita'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/email-marketing/lists/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mkt-lists'] });
      toast.success('Lista eliminata');
      setDeleteFor(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Eliminazione fallita'),
  });

  const actions = useMemo(() => (
    <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
      <Plus className="h-4 w-4" /> Nuova lista
    </Button>
  ), []);

  useTopbar({ title: 'Liste', subtitle: `${lists.length} liste`, actions });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      {lists.length === 0 ? (
        <EmptyState title="Nessuna lista" description="Crea una lista o importane una da CSV nella sezione Contatti." icon={Layers} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {lists.map((l) => (
            <div key={l.id} className="rounded-lg border bg-card p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-medium truncate">{l.name}</h3>
                  {l.description && <p className="text-xs text-muted-foreground line-clamp-2">{l.description}</p>}
                </div>
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => setDeleteFor(l)} aria-label="Elimina">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-[10px] gap-1">
                  <Users className="h-3 w-3" />{l.member_count} contatti
                </Badge>
                {l.kind === 'imported' && <Badge variant="outline" className="text-[10px]">importata</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nuova lista</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="es. Prospect Milano" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Descrizione (opzionale)</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Annulla</Button>
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !name.trim()}>Crea</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {deleteFor && (
        <AlertDialog open onOpenChange={(o) => !o && setDeleteFor(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Eliminare "{deleteFor.name}"?</AlertDialogTitle>
              <AlertDialogDescription>
                La lista verrà eliminata. I contatti restano nell'audience; viene rimossa solo l'appartenenza alla lista.
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
