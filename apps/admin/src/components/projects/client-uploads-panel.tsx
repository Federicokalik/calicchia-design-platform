import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Download, Eye, File, FileArchive, FileImage, FileText, FileVideo,
  Loader2, Trash2, Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { ClientUploadLightbox } from '@/components/projects/client-upload-lightbox';
import { useConfirm } from '@/hooks/use-confirm';
import { CLIENT_UPLOADS_QUERY_KEY, useClientUploads } from '@/hooks/use-client-uploads';
import { apiFetch } from '@/lib/api';
import {
  downloadClientUpload,
  formatBytes,
  formatUploadDate,
  getPreviewKind,
  type ClientUpload,
  type ClientUploadStatus,
  type ClientUploadsScope,
} from '@/lib/client-uploads';
import { cn } from '@/lib/utils';

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
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { data, isLoading } = useClientUploads({ customerId, projectId }, includeAll);
  const files = data?.files ?? [];
  const previewable = files.filter((file) => getPreviewKind(file) !== null);
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

  const handleDownload = async (file: ClientUpload) => {
    setDownloadingId(file.id);
    try {
      await downloadClientUpload(file.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download non riuscito');
    } finally {
      setDownloadingId(null);
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
            const canPreview = getPreviewKind(file) !== null;
            const downloading = downloadingId === file.id;

            return (
              <div key={file.id} className="flex items-center gap-3 px-4 py-3">
                <Icon className={cn('h-5 w-5 shrink-0', completed ? 'text-muted-foreground' : 'text-muted-foreground/40')} />
                <div className="flex-1 min-w-0">
                  {canPreview ? (
                    <button
                      type="button"
                      className="block max-w-full truncate text-left text-sm font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                      title={`Anteprima: ${file.original_name}`}
                      onClick={() => setPreviewId(file.id)}
                    >
                      {file.original_name}
                    </button>
                  ) : (
                    <p
                      className={cn('text-sm font-medium truncate', !completed && 'text-muted-foreground')}
                      title={file.original_name}
                    >
                      {file.original_name}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground truncate">
                    {showProject && <>{file.project_name ?? 'Archivio generale'} · </>}
                    {formatBytes(file.size)} · {formatUploadDate(file.uploaded_at)}
                  </p>
                </div>

                {statusCfg && (
                  <Badge variant="outline" className={cn('text-[10px] shrink-0', statusCfg.className)} title={statusCfg.hint}>
                    {statusCfg.label}
                  </Badge>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  {canPreview && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Anteprima"
                      onClick={() => setPreviewId(file.id)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  )}
                  {completed && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Scarica"
                      disabled={downloading}
                      onClick={() => handleDownload(file)}
                    >
                      {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
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

      <ClientUploadLightbox
        files={previewable}
        activeId={previewId}
        onActiveChange={setPreviewId}
        onDownload={handleDownload}
        downloadingId={downloadingId}
        showProject={showProject}
      />
    </div>
  );
}
