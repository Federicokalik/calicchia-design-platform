import { useRef, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api';
import type { ProjectPreview } from '@/types/projects';

const PROVIDERS = ['netlify', 'vercel', 'wordpress', 'custom'] as const;
const STATUSES = ['draft', 'review', 'approved', 'archived'] as const;

function readPreviewForm(form: HTMLFormElement) {
  const fd = new FormData(form);
  return {
    title: String(fd.get('title') || '').trim(),
    url: String(fd.get('url') || '').trim(),
    provider: String(fd.get('provider') || 'custom'),
    status: String(fd.get('status') || 'draft'),
    visible_to_client: fd.get('visible_to_client') === 'on',
    sort_order: Number(fd.get('sort_order') || 0),
    notes: String(fd.get('notes') || '').trim() || null,
  };
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-[11px] font-medium text-muted-foreground">{children}</label>;
}

function SelectField({
  name,
  defaultValue,
  children,
}: {
  name: string;
  defaultValue: string;
  children: ReactNode;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      className="h-9 rounded-md border bg-background px-3 text-sm"
    >
      {children}
    </select>
  );
}

export function ProjectPreviewsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const createFormRef = useRef<HTMLFormElement>(null);
  const queryKey = ['project-previews', projectId];

  const { data, isLoading } = useQuery<{ previews: ProjectPreview[] }>({
    queryKey,
    queryFn: () => apiFetch(`/api/client-projects/${projectId}/previews`),
  });
  const previews = data?.previews ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
  };

  const createMutation = useMutation({
    mutationFn: (payload: ReturnType<typeof readPreviewForm>) =>
      apiFetch(`/api/client-projects/${projectId}/previews`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      invalidate();
      createFormRef.current?.reset();
      toast.success('Anteprima aggiunta');
    },
    onError: (err: Error) => toast.error(err.message || 'Creazione anteprima fallita'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ previewId, payload }: { previewId: string; payload: ReturnType<typeof readPreviewForm> }) =>
      apiFetch(`/api/client-projects/${projectId}/previews/${previewId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      invalidate();
      toast.success('Anteprima aggiornata');
    },
    onError: (err: Error) => toast.error(err.message || 'Aggiornamento anteprima fallito'),
  });

  const deleteMutation = useMutation({
    mutationFn: (previewId: string) =>
      apiFetch(`/api/client-projects/${projectId}/previews/${previewId}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      toast.success('Anteprima eliminata');
    },
    onError: (err: Error) => toast.error(err.message || 'Eliminazione anteprima fallita'),
  });

  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Anteprime sito</h3>
          <p className="text-xs text-muted-foreground">
            Bozze navigabili visibili al cliente nel portale.
          </p>
        </div>
        <Badge variant="outline">{previews.length}</Badge>
      </div>

      <form
        ref={createFormRef}
        className="grid gap-3 rounded-md border bg-background/50 p-3 md:grid-cols-[1fr_1.4fr_120px_120px_90px_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          createMutation.mutate(readPreviewForm(event.currentTarget));
        }}
      >
        <div className="space-y-1">
          <FieldLabel>Titolo</FieldLabel>
          <Input name="title" placeholder="Home v1" required />
        </div>
        <div className="space-y-1">
          <FieldLabel>URL https</FieldLabel>
          <Input name="url" placeholder="https://bozza.netlify.app" required />
        </div>
        <div className="space-y-1">
          <FieldLabel>Provider</FieldLabel>
          <SelectField name="provider" defaultValue="custom">
            {PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>{provider}</option>
            ))}
          </SelectField>
        </div>
        <div className="space-y-1">
          <FieldLabel>Stato</FieldLabel>
          <SelectField name="status" defaultValue="draft">
            {STATUSES.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </SelectField>
        </div>
        <div className="space-y-1">
          <FieldLabel>Ordine</FieldLabel>
          <Input name="sort_order" type="number" min={0} defaultValue={previews.length} />
        </div>
        <div className="flex items-end">
          <Button type="submit" size="sm" disabled={createMutation.isPending}>
            <Plus className="h-3.5 w-3.5" /> Aggiungi
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs md:col-span-6">
          <input name="visible_to_client" type="checkbox" defaultChecked className="rounded" />
          Visibile al cliente
        </label>
      </form>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Caricamento anteprime...</p>
      ) : previews.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Nessuna anteprima dedicata. Il portale usera lo staging URL del progetto, se presente.
        </p>
      ) : (
        <div className="space-y-3">
          {previews.map((preview) => (
            <form
              key={preview.id}
              className="grid gap-3 rounded-md border p-3 md:grid-cols-[1fr_1.4fr_120px_120px_90px_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                updateMutation.mutate({
                  previewId: preview.id,
                  payload: readPreviewForm(event.currentTarget),
                });
              }}
            >
              <div className="space-y-1">
                <FieldLabel>Titolo</FieldLabel>
                <Input name="title" defaultValue={preview.title} required />
              </div>
              <div className="space-y-1">
                <FieldLabel>URL https</FieldLabel>
                <Input name="url" defaultValue={preview.url} required />
              </div>
              <div className="space-y-1">
                <FieldLabel>Provider</FieldLabel>
                <SelectField name="provider" defaultValue={preview.provider}>
                  {PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>{provider}</option>
                  ))}
                </SelectField>
              </div>
              <div className="space-y-1">
                <FieldLabel>Stato</FieldLabel>
                <SelectField name="status" defaultValue={preview.status}>
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>{status}</option>
                  ))}
                </SelectField>
              </div>
              <div className="space-y-1">
                <FieldLabel>Ordine</FieldLabel>
                <Input name="sort_order" type="number" min={0} defaultValue={preview.sort_order} />
              </div>
              <div className="flex items-end gap-1">
                <Button type="submit" size="sm" variant="outline" disabled={updateMutation.isPending}>
                  <Save className="h-3.5 w-3.5" />
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={preview.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (confirm('Eliminare questa anteprima?')) deleteMutation.mutate(preview.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  name="visible_to_client"
                  type="checkbox"
                  defaultChecked={preview.visible_to_client}
                  className="rounded"
                />
                Visibile al cliente
              </label>
              <div className="space-y-1 md:col-span-5">
                <FieldLabel>Note interne</FieldLabel>
                <Textarea name="notes" defaultValue={preview.notes ?? ''} rows={2} />
              </div>
            </form>
          ))}
        </div>
      )}
    </div>
  );
}
