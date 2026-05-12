import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Maximize2, Minimize2, Loader2, Download, FileImage, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTopbar } from '@/hooks/use-topbar';
import { useI18n } from '@/hooks/use-i18n';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { LinkEntityPicker } from '@/components/shared/link-entity-picker';
import type { Board } from '@/types/notes';

const Excalidraw = lazy(async () => {
  await import('@excalidraw/excalidraw/index.css');
  const mod = await import('@excalidraw/excalidraw');
  return { default: mod.Excalidraw };
});

export default function SketchEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { intlLocale } = useI18n();
  const [title, setTitle] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [saving, setSaving] = useState(false);
  const excalidrawAPIRef = useRef<any>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveMutateRef = useRef<((updates: Partial<Board>) => void) | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['board', id],
    queryFn: () => apiFetch(`/api/boards/${id}`),
    enabled: !!id,
  });

  const board: Board | undefined = data?.board;

  // Initialize title from board data
  useEffect(() => {
    if (board?.title && !title) setTitle(board.title);
  }, [board?.title]);

  const saveMutation = useMutation({
    mutationFn: (updates: Partial<Board>) =>
      apiFetch(`/api/boards/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
    onSuccess: () => { setSaving(false); queryClient.invalidateQueries({ queryKey: ['boards'] }); },
    onError: () => { setSaving(false); toast.error('Errore salvataggio'); },
  });

  // Keep a stable ref to mutate so handleChange doesn't re-create
  saveMutateRef.current = saveMutation.mutate;

  const handleChange = useCallback((elements: readonly any[], appState: any) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      setSaving(true);
      saveMutateRef.current?.({
        data: {
          elements: [...elements],
          appState: { viewBackgroundColor: appState.viewBackgroundColor },
        },
      } as any);
    }, 1500);
  }, []);

  const handleTitleBlur = () => {
    if (board && title !== board.title) {
      saveMutation.mutate({ title } as any);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const api = excalidrawAPIRef.current;
    if (!api) { toast.error('Editor non pronto'); return; }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed.type !== 'excalidraw') {
        toast.error('File non valido: atteso formato Excalidraw');
        return;
      }
      api.updateScene({
        elements: parsed.elements || [],
        appState: parsed.appState ? { viewBackgroundColor: parsed.appState.viewBackgroundColor } : undefined,
      });
      if (parsed.files) api.addFiles(Object.values(parsed.files));
      toast.success('File importato');
    } catch (err: any) {
      toast.error('Impossibile leggere il file: ' + (err?.message || 'JSON non valido'));
    }
  };

  const exportAs = async (format: 'png' | 'svg') => {
    const api = excalidrawAPIRef.current;
    if (!api) return;
    const { exportToBlob, exportToSvg } = await import('@excalidraw/excalidraw');
    const elements = api.getSceneElements();
    if (!elements.length) { toast.error('Nessun elemento da esportare'); return; }
    const opts = { elements, appState: { ...api.getAppState(), exportWithDarkMode: true }, files: api.getFiles() };

    if (format === 'png') {
      const blob = await exportToBlob({ ...opts, mimeType: 'image/png', quality: 1 });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${title || 'sketch'}.png`; a.click();
      URL.revokeObjectURL(url);
    } else {
      const svg = await exportToSvg(opts);
      const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${title || 'sketch'}.svg`; a.click();
      URL.revokeObjectURL(url);
    }
    toast.success(`Esportato come ${format.toUpperCase()}`);
  };

  // Hooks BEFORE any early returns
  useTopbar({ title: 'Sketch' });

  if (isLoading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!board) return <div className="text-center text-muted-foreground py-12">Board non trovata</div>;

  const boardData = typeof board.data === 'string' ? JSON.parse(board.data as string) : board.data;
  const initialElements = boardData?.elements || [];

  return (
    <div className={cn(
      fullscreen ? 'fixed inset-0 z-[100] bg-background' : 'space-y-3',
    )}>
      {/* Toolbar — in fullscreen only show minimize button */}
      <div className={cn(
        'flex items-center justify-between',
        fullscreen && 'absolute bottom-4 left-1/2 -translate-x-1/2 z-[110]'
      )}>
        {!fullscreen && (
          <Button variant="ghost" size="sm" onClick={() => navigate('/boards/sketch')}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Sketch
          </Button>
        )}
        <div className="flex items-center gap-2">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {!fullscreen && (
            <>
              <input
                ref={importInputRef}
                type="file"
                accept=".excalidraw,application/json"
                className="hidden"
                onChange={handleImportFile}
              />
              <Button variant="outline" size="sm" onClick={() => importInputRef.current?.click()}>
                <Upload className="h-3.5 w-3.5 mr-1" /> Importa
              </Button>
              <Button variant="outline" size="sm" onClick={() => exportAs('png')}>
                <FileImage className="h-3.5 w-3.5 mr-1" /> PNG
              </Button>
              <Button variant="outline" size="sm" onClick={() => exportAs('svg')}>
                <Download className="h-3.5 w-3.5 mr-1" /> SVG
              </Button>
            </>
          )}
          <Button
            variant={fullscreen ? 'outline' : 'ghost'}
            size={fullscreen ? 'sm' : 'icon'}
            className={fullscreen ? 'bg-background/80 backdrop-blur shadow-lg' : 'h-8 w-8'}
            onClick={() => setFullscreen(!fullscreen)}
          >
            {fullscreen ? <><Minimize2 className="h-4 w-4 mr-1.5" /> Esci fullscreen</> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {!fullscreen && (
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          placeholder="Nome sketch"
          className="w-full text-xl font-bold bg-transparent border-none outline-none placeholder:text-muted-foreground/40"
        />
      )}

      {!fullscreen && (
        <LinkEntityPicker
          linkedType={board.linked_type}
          linkedId={board.linked_id}
          onChange={(type, id) => {
            saveMutation.mutate({ linked_type: type, linked_id: id } as any);
          }}
        />
      )}

      <div className={cn(
        'rounded-xl border overflow-hidden bg-card',
        fullscreen ? 'h-full rounded-none border-none' : 'h-[calc(100vh-14rem)]'
      )}>
        <Suspense fallback={
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Caricamento Excalidraw...
          </div>
        }>
          <Excalidraw
            excalidrawAPI={(api: any) => { excalidrawAPIRef.current = api; }}
            initialData={{
              elements: initialElements,
              appState: {
                ...boardData?.appState,
                scrolledOutside: false,
              },
              scrollToContent: true,
            }}
            onChange={handleChange}
            theme="dark"
            langCode={intlLocale}
            UIOptions={{
              tools: { image: false },
              dockedSidebarBreakpoint: 0,
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
