import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Download, ExternalLink, File, FileArchive, FileImage, FileText, FileVideo,
  Loader2, Trash2, Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { useConfirm } from '@/hooks/use-confirm';
import {
  CLIENT_UPLOADS_QUERY_KEY, useClientUploads,
  type ClientUpload, type ClientUploadStatus, type ClientUploadsScope,
} from '@/hooks/use-client-uploads';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

// Must mirror INLINE_UPLOAD_TYPES in apps/api/src/routes/portal-admin.ts:
// the API forces a download for anything else anyway.
const PREVIEWABLE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'application/pdf',
  'video/mp4', 'video/quicktime',
]);

const STATUS_LABEL: Record<Exclude<ClientUploadStatus, 'completed'>, { label: string; className: string; hint: string }> = {
  uploading: {
    label: 'Incompleto',
    className: 'border-amber-500/40 text-amber-600',
    hint: 'Caricamento iniziato ma mai concluso (connessione persa o pagina chiusa).',
  },
  failed: {
    label: 'Interrotto',
    className: 'border-muted-foreground/40 text-muted-foreground',
    hint: 'Caricamento annullato o fallito lato storage.',
  },
  rejected: {
    label: 'Rifiutato',
    className: 'border-destructive/40 text-destructive',
    hint: 'Il contenuto non corrispondeva al tipo dichiarato: il file è stato scartato.',
  },
};

function formatBytes(value: number | string): string {
  const bytes = Number(value) || 0;
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

function fileIcon(contentType: string) {
  if (contentType.startsWith('image/')) return FileImage;
  if (contentType.startsWith('video/')) return FileVideo;
  if (/zip|rar|7z/.test(contentType)) return FileArchive;
  if (contentType === 'application/pdf' || contentType.includes('officedocument')) return FileText;
  return File;
}

export function ClientUploadsPanel({ customerId, projectId }: ClientUploadsScope) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [includeAll, setIncludeAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useClientUploads({ customerId, projectId }, includeAll);
  const files = data?.files ?? [];
  // In the customer view files can belong to different projects (or none).
  const showProject = !projectId;

  const deleteMutation = useMutation({
    mutationFn: (uploadId: string) =>
      apiFetch(`/api/portal-admin/uploads/${uploadId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [CLIENT_UPLOADS_QUERY_KEY] });
      toast.success('File eliminato');
    },
    onError: (err: Error) => toast.error(err.message || 'Eliminazione file fallita'),
  });

  const openFile = async (file: ClientUpload, mode: 'inline' | 'download') => {
    // Open the tab synchronously, inside the click: a window.open() after the
    // await below would be eaten by the popup blocker.
    const tab = mode === 'inline' ? window.open('', '_blank') : null;
    setBusyId(file.id);
    try {
      const res: { url: string } = await apiFetch(
        `/api/portal-admin/uploads/${file.id}/url?disposition=${mode === 'inline' ? 'inline' : 'attachment'}`,
      );
      if (tab) {
        tab.opener = null;
        tab.location.href = res.url;
      } else {
        // Content-Disposition: attachment → the browser downloads, no navigation.
        window.location.assign(res.url);
      }
    } catch (err) {
      tab?.close();
      toast.error(err instanceof Error ? err.message : 'Impossibile aprire il file');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">File caricati dal cliente</h3>
          <p className="text-xs text-muted-foreground">
            {showProject
              ? 'Tutto ciò che il cliente ha inviato dal portale, per qualsiasi progetto o in archivio generale.'
              : 'File inviati dal cliente dal portale e associati a questo progetto.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch id={`uploads-all-${projectId ?? customerId}`} checked={includeAll} onCheckedChange={setIncludeAll} />
            <Label htmlFor={`uploads-all-${projectId ?? customerId}`} className="text-xs text-muted-foreground">
              Mostra tentativi non riusciti
            </Label>
          </div>
          <Badge variant="outline">{files.length}</Badge>
        </div>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : files.length === 0 ? (
        <EmptyState
          title="Nessun file ricevuto"
          description={
            includeAll
              ? 'Il cliente non ha ancora provato a caricare file.'
              : 'Quando il cliente carica un file dall’area clienti comparirà qui.'
          }
          icon={Upload}
        />
      ) : (
        <div className="rounded-md border divide-y">
          {files.map((file) => {
            const Icon = fileIcon(file.content_type);
            const completed = file.status === 'completed';
            const statusCfg = file.status === 'completed' ? null : STATUS_LABEL[file.status];
            const busy = busyId === file.id;

            return (
              <div key={file.id} className="flex items-center gap-3 px-4 py-3">
                <Icon className={cn('h-5 w-5 shrink-0', completed ? 'text-muted-foreground' : 'text-muted-foreground/40')} />
                <div className="flex-1 min-w-0">
                  <p
                    className={cn('text-sm font-medium truncate', !completed && 'text-muted-foreground')}
                    title={file.original_name}
                  >
                    {file.original_name}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {showProject && <>{file.project_name ?? 'Archivio generale'} · </>}
                    {formatBytes(file.size)} ·{' '}
                    {new Date(file.uploaded_at).toLocaleString('it-IT', {
                      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>

                {statusCfg && (
                  <Badge variant="outline" className={cn('text-[10px] shrink-0', statusCfg.className)} title={statusCfg.hint}>
                    {statusCfg.label}
                  </Badge>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  {completed && PREVIEWABLE_TYPES.has(file.content_type) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Apri in una nuova scheda"
                      disabled={busy}
                      onClick={() => openFile(file, 'inline')}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  )}
                  {completed && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Scarica"
                      disabled={busy}
                      onClick={() => openFile(file, 'download')}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    title="Elimina"
                    disabled={deleteMutation.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Eliminare "${file.original_name}"?`,
                        description: 'Il file viene rimosso dallo storage e sparisce anche dall’area clienti. Operazione irreversibile.',
                        confirmText: 'Elimina',
                        variant: 'destructive',
                      });
                      if (ok) deleteMutation.mutate(file.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
