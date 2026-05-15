'use client';

import { useRef, useState, useTransition, type ChangeEvent, type DragEvent } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { uploadPortalFileAction } from '@/lib/portal-actions';
import type { PortalProject } from '@/lib/portal-api';

interface UploadZoneProps {
  projects?: PortalProject[];
}

export function UploadZone({ projects = [] }: UploadZoneProps) {
  // TODO P0-06 polish: progress per chunk, multiple files, drag preview and retry queue.
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const setFile = (files: FileList | null) => {
    const file = files?.[0];
    setFileName(file?.name ?? null);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!event.dataTransfer.files.length || !inputRef.current) return;
    inputRef.current.files = event.dataTransfer.files;
    setFile(event.dataTransfer.files);
  };

  return (
    <form
      ref={formRef}
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          try {
            await uploadPortalFileAction(formData);
            formRef.current?.reset();
            setFileName(null);
            router.refresh();
          } catch {
            setError('Upload non completato. Verifica il file e riprova.');
          }
        });
      }}
    >
      {projects.length > 0 && (
        <label className="flex flex-col gap-3">
          <MonoLabel>PROGETTO</MonoLabel>
          <select
            name="projectId"
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
          {fileName ?? 'Seleziona o trascina un file'}
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
          onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files)}
        />
      </label>

      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--color-text-error)' }}>
          {error}
        </p>
      )}

      <Button type="submit" disabled={pending || !fileName}>
        {pending ? 'Caricamento...' : 'Carica file'}
      </Button>
    </form>
  );
}
