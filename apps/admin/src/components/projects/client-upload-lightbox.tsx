import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DocxPreview } from '@/components/projects/client-upload-docx-preview';
import { useClientUploadPreviewUrl } from '@/hooks/use-client-uploads';
import {
  formatBytes,
  formatUploadDate,
  getPreviewKind,
  type ClientUpload,
  type ClientUploadPreviewKind,
} from '@/lib/client-uploads';
import { cn } from '@/lib/utils';

interface ClientUploadLightboxProps {
  /** Previewable files, in list order (prev/next walks this array). */
  files: ClientUpload[];
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  onDownload: (file: ClientUpload) => void;
  downloadingId: string | null;
  showProject: boolean;
}

export function ClientUploadLightbox({
  files,
  activeId,
  onActiveChange,
  onDownload,
  downloadingId,
  showProject,
}: ClientUploadLightboxProps) {
  const index = activeId ? files.findIndex((f) => f.id === activeId) : -1;
  const file = index >= 0 ? files[index] : null;
  const kind = file ? getPreviewKind(file) : null;
  // DOCX is parsed from bytes proxied by the API, not from a presigned URL.
  const usesUrl = kind !== null && kind !== 'docx';
  const { data: url, isLoading, error } = useClientUploadPreviewUrl(usesUrl ? file!.id : null);
  const canNavigate = files.length > 1;
  const contentRef = useRef<HTMLDivElement>(null);

  const go = (delta: number) => {
    if (!canNavigate || index < 0) return;
    onActiveChange(files[(index + delta + files.length) % files.length].id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrow keys on a focused <video> seek: leave them to the player.
    if (event.target instanceof HTMLMediaElement) return;
    if (event.key === 'ArrowRight') go(1);
    else if (event.key === 'ArrowLeft') go(-1);
  };

  return (
    <Dialog open={!!file} onOpenChange={(open) => { if (!open) onActiveChange(null); }}>
      <DialogContent
        ref={contentRef}
        className="flex h-[calc(100dvh-2rem)] max-w-[min(1400px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0 focus:outline-none"
        // Radix would focus the first button (Scarica): Enter would download.
        // Focus the dialog itself so ←/→ work right away and Enter is inert.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onKeyDown={onKeyDown}
      >
        {file && kind && (
          <>
            <div className="flex items-center gap-2 border-b px-4 py-3 pr-14">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-sm font-semibold" title={file.original_name}>
                  {file.original_name}
                </DialogTitle>
                <DialogDescription className="truncate text-xs">
                  {showProject && `${file.project_name ?? 'Archivio generale'} · `}
                  {formatBytes(file.size)} · {formatUploadDate(file.uploaded_at)}
                  {canNavigate && ` · ${index + 1} di ${files.length}`}
                </DialogDescription>
              </div>
              {usesUrl && url && (
                <Button asChild variant="ghost" size="sm" className="shrink-0" title="Apri in una nuova scheda">
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    <span className="hidden sm:inline">Nuova scheda</span>
                  </a>
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={downloadingId === file.id}
                onClick={() => onDownload(file)}
              >
                {downloadingId === file.id
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Download className="h-4 w-4" />}
                <span className="hidden sm:inline">Scarica</span>
              </Button>
            </div>

            <div
              className={cn(
                'relative flex min-h-0 flex-1 items-center justify-center bg-neutral-950',
                (kind === 'image' || kind === 'video') && 'p-4 sm:px-16',
              )}
            >
              {kind === 'docx' ? (
                <DocxPane key={file.id} fileId={file.id} onDownload={() => onDownload(file)} />
              ) : isLoading ? (
                <Loader2 className="h-6 w-6 animate-spin text-white/60" />
              ) : error || !url ? (
                <PreviewFallback
                  message={error instanceof Error ? error.message : 'Anteprima non disponibile.'}
                  onDownload={() => onDownload(file)}
                />
              ) : (
                // Keyed by file: resets the media-error state and tears down
                // the previous <video>/<iframe> instead of swapping its src.
                <PreviewMedia key={file.id} file={file} kind={kind} url={url} onDownload={() => onDownload(file)} />
              )}

              {canNavigate && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute left-2 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full opacity-80 hover:opacity-100"
                    title="Precedente (←)"
                    onClick={() => go(-1)}
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute right-2 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full opacity-80 hover:opacity-100"
                    title="Successivo (→)"
                    onClick={() => go(1)}
                  >
                    <ChevronRight className="h-5 w-5" />
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewMedia({
  file,
  kind,
  url,
  onDownload,
}: {
  file: ClientUpload;
  kind: Exclude<ClientUploadPreviewKind, 'docx'>;
  url: string;
  onDownload: () => void;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <PreviewFallback
        message="Il browser non riesce a mostrare questo file (formato o codec non supportato, es. video HEVC)."
        onDownload={onDownload}
      />
    );
  }

  switch (kind) {
    case 'image':
      return (
        <img
          src={url}
          alt={file.original_name}
          className="max-h-full max-w-full object-contain"
          onError={() => setFailed(true)}
        />
      );
    case 'video':
      return (
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          className="max-h-full max-w-full"
          onError={() => setFailed(true)}
        />
      );
    case 'pdf':
      // Native browser PDF viewer. No sandbox: it would disable the viewer,
      // and the S4 origin is cross-origin to the admin anyway.
      return <iframe src={url} title={file.original_name} className="h-full w-full border-0 bg-white" />;
  }
}

function DocxPane({ fileId, onDownload }: { fileId: string; onDownload: () => void }) {
  const [failure, setFailure] = useState<string | null>(null);
  const handleError = useCallback((message: string) => setFailure(message), []);

  if (failure) return <PreviewFallback message={failure} onDownload={onDownload} />;
  return <DocxPreview fileId={fileId} onError={handleError} />;
}

function PreviewFallback({ message, onDownload }: { message: string; onDownload: () => void }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 text-center text-white/80">
      <AlertTriangle className="h-8 w-8 text-amber-400" />
      <p className="text-sm">{message}</p>
      <Button type="button" variant="secondary" size="sm" onClick={onDownload}>
        <Download className="h-4 w-4" /> Scarica il file
      </Button>
    </div>
  );
}
