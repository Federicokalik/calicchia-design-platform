import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CloudDownload,
  Upload,
  Trash2,
  Loader2,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Lock,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch, API_BASE } from '@/lib/api';
import { useConfirm } from '@/hooks/use-confirm';

interface KbFileInfo {
  name: string;
  size_bytes: number;
  modified: string;
  is_private: boolean;
}

interface KbStatusResponse {
  s4_configured: boolean;
  metadata: {
    source: 's4' | 'local';
    file_count: number;
    latest_modified: string | null;
    loaded_at?: string;
  };
  files: KbFileInfo[];
  kb_dir: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function KnowledgeBaseSection() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const { data, isLoading } = useQuery<KbStatusResponse>({
    queryKey: ['admin-kb-status'],
    queryFn: () => apiFetch('/api/admin/kb/status'),
  });

  const importMutation = useMutation({
    mutationFn: () => apiFetch('/api/admin/kb/import', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (res: { metadata?: { file_count: number } }) => {
      const count = res?.metadata?.file_count ?? 0;
      toast.success(`Import completato: ${count} file caricati`);
      queryClient.invalidateQueries({ queryKey: ['admin-kb-status'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Import fallito'),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      // apiFetch supports FormData natively and runs the 401 refresh flow
      // that the previous raw fetch was bypassing (audit D-005).
      const data = await apiFetch('/api/admin/kb/upload', {
        method: 'POST',
        body: form,
      });
      return data as { file: { name: string; size_bytes: number } };
    },
    onSuccess: (res) => {
      toast.success(`Caricato ${res.file.name}`);
      queryClient.invalidateQueries({ queryKey: ['admin-kb-status'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/admin/kb/files/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: (_, name) => {
      toast.success(`Cancellato ${name}`);
      queryClient.invalidateQueries({ queryKey: ['admin-kb-status'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.md')) {
        toast.error(`${file.name}: solo file .md ammessi`);
        continue;
      }
      uploadMutation.mutate(file);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Caricamento stato KB…
      </div>
    );
  }

  if (!data) return null;

  const { metadata, files, s4_configured, kb_dir } = data;
  const empty = files.length === 0;
  const isFromS4 = metadata.source === 's4';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Knowledge Base AI</h2>
        <p className="text-sm text-muted-foreground">
          File <code className="text-xs">.md</code> consultati dal generatore preventivi AI.
          Vivono in <code className="text-xs">{kb_dir}</code> dentro il container, sono
          gitignored e <b>vanno caricati a ogni redeploy</b> — da MEGA S4 o manualmente.
        </p>
      </div>

      {/* Status card */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-start gap-3">
          {empty ? (
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
          )}
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">
                {empty ? 'Knowledge base vuota' : `${files.length} file caricati`}
              </span>
              <Badge variant={isFromS4 ? 'default' : 'secondary'} className="text-[10px]">
                Origine: {isFromS4 ? 'S4' : 'locale'}
              </Badge>
              {empty ? (
                <Badge variant="destructive" className="text-[10px]">
                  AI preventivi non disponibile
                </Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Ultima modifica file: {formatDate(metadata.latest_modified)} · Ultimo import:{' '}
              {formatDate(metadata.loaded_at)}
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-medium flex items-center gap-2">
              <CloudDownload className="h-4 w-4" />
              Importa da MEGA S4
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Scarica tutti i <code>*.md</code> sotto <code>s3://&lt;bucket&gt;/kb/</code> e li mette
              in <code>{kb_dir}</code>. Idempotente.
            </p>
          </div>
          <Button
            onClick={() => importMutation.mutate()}
            disabled={!s4_configured || importMutation.isPending}
            size="sm"
          >
            {importMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                Importazione in corso…
              </>
            ) : (
              <>
                <CloudDownload className="h-3.5 w-3.5 mr-2" />
                Re-importa da S4
              </>
            )}
          </Button>
        </div>
        {!s4_configured && (
          <p className="text-xs text-amber-700 flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" />
            S4 non configurato lato container (variabili <code>S4_*</code> mancanti).
            Usa l&apos;upload manuale qui sotto, oppure setta le env e riavvia il container.
          </p>
        )}
      </div>

      {/* Drag-drop upload */}
      <div className="rounded-lg border p-4 space-y-3">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Upload className="h-4 w-4" />
            Carica manualmente file <code>.md</code>
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            File ammessi: <code>pricing_knowledge_base.md</code>,{' '}
            <code>profile_knowledge_base.md</code>, <code>*_private.md</code>. Max 2 MB.
          </p>
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/20 hover:border-muted-foreground/40'
          }`}
        >
          {uploadMutation.isPending ? (
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Upload in corso…
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <Upload className="h-5 w-5" />
              <span>
                Trascina qui i file <code>.md</code> o clicca per selezionarli
              </span>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,text/markdown"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* File list */}
      <div className="rounded-lg border">
        <div className="p-4 border-b">
          <h3 className="text-sm font-medium">File presenti</h3>
        </div>
        {empty ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Nessun file caricato. Importa da S4 o carica manualmente.
          </div>
        ) : (
          <div className="divide-y">
            {files.map((file) => (
              <div key={file.name} className="flex items-center gap-3 p-3 text-sm">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs truncate">{file.name}</span>
                    {file.is_private && (
                      <Badge variant="outline" className="text-[10px]">
                        private
                      </Badge>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {formatBytes(file.size_bytes)} · modificato {formatDate(file.modified)}
                  </p>
                </div>
                <a
                  href={`${API_BASE}/api/admin/kb/files/${encodeURIComponent(file.name)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  title="Apri in nuova tab"
                >
                  <ExternalLink className="h-3 w-3" />
                  apri
                </a>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (await confirm({ title: `Cancellare ${file.name}?`, variant: 'destructive' })) deleteMutation.mutate(file.name);
                  }}
                  disabled={deleteMutation.isPending}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
