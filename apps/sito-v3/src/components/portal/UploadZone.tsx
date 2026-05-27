'use client';

import { useRef, useState, useTransition, type ChangeEvent, type DragEvent } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { revalidatePortalFilesAction } from '@/lib/portal-actions';
import { uploadFileFromBrowser, type UploadProgress } from '@/lib/portal-upload-client';
import type { PortalProject } from '@/lib/portal-api';

interface UploadZoneProps {
  projects?: PortalProject[];
}

/**
 * Audit B-014: switched from a Server-Action FormData upload (which
 * streamed every byte through Next.js) to a client-side multipart upload
 * that PUTs chunks directly to S4 from the browser. The Server Action
 * is only invoked after a successful upload to refresh server-rendered
 * file lists.
 */
export function UploadZone({ projects = [] }: UploadZoneProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [file, setFileState] = useState<File | null>(null);
  const [projectId, setProjectId] = useState<string>('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [uploading, setUploading] = useState(false);
  const [, startRevalidate] = useTransition();

  const onPickFile = (files: FileList | null) => {
    setFileState(files?.[0] ?? null);
    setError(null);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!event.dataTransfer.files.length || !inputRef.current) return;
    inputRef.current.files = event.dataTransfer.files;
    onPickFile(event.dataTransfer.files);
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    setProgress(null);
    try {
      await uploadFileFromBrowser(file, {
        projectId: projectId || undefined,
        onProgress: (p) => setProgress(p),
      });
      // Reset UI
      formRef.current?.reset();
      setFileState(null);
      setProjectId('');
      setProgress(null);
      // Revalidate server-rendered file lists (Server Action — no payload).
      startRevalidate(() => {
        revalidatePortalFilesAction()
          .then(() => router.refresh())
          .catch(() => undefined);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload non completato. Riprova.');
    } finally {
      setUploading(false);
    }
  };

  const percent = progress
    ? Math.min(100, Math.round((progress.bytesUploaded / progress.totalBytes) * 100))
    : 0;

  return (
    <form ref={formRef} className="flex flex-col gap-6" onSubmit={onSubmit}>
      {projects.length > 0 && (
        <label className="flex flex-col gap-3">
          <MonoLabel>PROGETTO</MonoLabel>
          <select
            name="projectId"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="px-4 py-4 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border-strong)',
              color: 'var(--color-text-primary)',
            }}
          >
            <option value="">Archivio generale</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className="flex min-h-[260px] cursor-pointer flex-col items-center justify-center gap-5 px-8 py-16 text-center transition-hover-color"
        style={{
          border: `2px dashed ${dragging ? 'var(--color-text-primary)' : 'var(--color-border-strong)'}`,
          background: dragging ? 'var(--color-surface-elev)' : 'transparent',
        }}
      >
        <MonoLabel>{dragging ? 'RILASCIA' : 'UPLOAD'}</MonoLabel>
        <span
          className="font-[family-name:var(--font-display)] text-2xl md:text-3xl"
          style={{ fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.15 }}
        >
          {file?.name ?? 'Seleziona o trascina un file'}
        </span>
        <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          PDF, immagini, archivi, documenti Office e video.
        </span>
        <input
          ref={inputRef}
          name="file"
          type="file"
          required
          className="hidden"
          onChange={(event: ChangeEvent<HTMLInputElement>) => onPickFile(event.target.files)}
        />
      </label>

      {progress && (
        <div className="flex flex-col gap-2" aria-live="polite">
          <div className="flex items-baseline justify-between text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            <span>Chunk {progress.currentPart}/{progress.totalParts}</span>
            <span className="tabular-nums">{percent}%</span>
          </div>
          <div
            className="h-1 w-full overflow-hidden"
            style={{ background: 'var(--color-border)' }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full transition-[width] duration-150"
              style={{ width: `${percent}%`, background: 'var(--color-text-primary)' }}
            />
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--color-text-error)' }}>
          {error}
        </p>
      )}

      <Button type="submit" disabled={uploading || !file}>
        {uploading ? 'Caricamento...' : 'Carica file'}
      </Button>
    </form>
  );
}
