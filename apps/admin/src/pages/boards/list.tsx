import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, PenTool, GitBranch, Trash2, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { MINDMAP_TEMPLATES } from '@/data/mindmap-templates';
import type { Board } from '@/types/notes';
import { useI18n } from '@/hooks/use-i18n';

interface BoardListProps {
  type: 'sketch' | 'mindmap';
}

const TYPE_CONFIG = {
  sketch: { label: 'Sketch', icon: PenTool, path: '/boards/sketch', description: 'Disegni e wireframe a mano libera' },
  mindmap: { label: 'Mappe', icon: GitBranch, path: '/boards/mindmap', description: 'Mappe concettuali e brainstorming' },
};

export default function BoardListPage({ type }: BoardListProps) {
  const { t, formatRelativeTime } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = TYPE_CONFIG[type];
  const [showTemplates, setShowTemplates] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['boards', type],
    queryFn: () => apiFetch(`/api/boards?type=${type}`),
  });

  const boards: Board[] = data?.boards || [];

  const createMutation = useMutation({
    mutationFn: (template?: { title: string; data: any }) => apiFetch('/api/boards', {
      method: 'POST',
      body: JSON.stringify({
        title: template?.title || (type === 'sketch' ? 'Nuovo sketch' : 'Nuova mappa'),
        type,
        data: template?.data || (type === 'mindmap'
          ? { nodes: [{ id: '1', type: 'mindmapNode', position: { x: 250, y: 200 }, data: { label: 'Idea centrale' } }], edges: [] }
          : {}),
      }),
    }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['boards', type] });
      navigate(`${config.path}/${data.board.id}`);
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Errore creazione');
    },
  });

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so re-importing the same file works
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      if (parsed.type !== 'excalidraw') {
        toast.error('File non valido: atteso formato Excalidraw');
        return;
      }

      const baseTitle = file.name.replace(/\.excalidraw(\.json)?$/i, '') || 'Sketch importato';
      createMutation.mutate({
        title: baseTitle,
        data: {
          elements: parsed.elements || [],
          appState: { viewBackgroundColor: parsed.appState?.viewBackgroundColor },
        },
      });
    } catch (err: any) {
      toast.error('Impossibile leggere il file: ' + (err?.message || 'JSON non valido'));
    }
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/boards/${id}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['boards', type] }); toast.success('Eliminata'); },
    onError: (err: any) => { toast.error(err?.message || 'Errore eliminazione'); },
  });

  useTopbar({ title: type === 'sketch' ? t('nav.sketch') : t('nav.mindMaps'), subtitle: `${boards.length} ${type === 'sketch' ? t('nav.sketch').toLowerCase() : t('nav.mindMaps').toLowerCase()}` });

  if (isLoading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end relative">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => createMutation.mutate(undefined)} disabled={createMutation.isPending}>
            <Plus className="h-4 w-4 mr-1.5" /> {type === 'sketch' ? t('command.newSketch') : t('command.newMindMap')}
          </Button>
          {type === 'sketch' && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".excalidraw,application/json"
                className="hidden"
                onChange={handleImportFile}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={createMutation.isPending}
              >
                <Upload className="h-4 w-4 mr-1.5" /> {t('common.import')}
              </Button>
            </>
          )}
          {type === 'mindmap' && (
            <Button size="sm" variant="outline" onClick={() => setShowTemplates(!showTemplates)}>
              {t('notes.fromTemplate')}
            </Button>
          )}
        </div>
        {showTemplates && type === 'mindmap' && (
          <div className="absolute top-full right-0 mt-1 z-50 w-64 rounded-xl border bg-popover p-2 shadow-lg">
            {MINDMAP_TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  createMutation.mutate({ title: t.title, data: { nodes: t.nodes, edges: t.edges } });
                  setShowTemplates(false);
                }}
                className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2 text-left hover:bg-muted transition-colors"
              >
                <span className="text-base">{t.icon}</span>
                <div>
                  <p className="text-xs font-medium">{t.title}</p>
                  <p className="text-[10px] text-muted-foreground">{t.description}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

  {boards.length === 0 ? (
      <EmptyState
        title={`Nessun ${config.label.toLowerCase()}`}
        description={config.description}
        icon={config.icon}
      >
        <Button size="sm" className="mt-4" onClick={() => createMutation.mutate(undefined)}>
          <Plus className="h-4 w-4 mr-1.5" /> Crea {type === 'sketch' ? 'primo sketch' : 'prima mappa'}
        </Button>
      </EmptyState>
  ) : (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {boards.map((board) => (
        <div
          key={board.id}
          onClick={() => navigate(`${config.path}/${board.id}`)}
          className="group rounded-xl border bg-card cursor-pointer transition-all hover:shadow-md hover:border-primary/20 overflow-hidden"
        >
          <div className="h-32 bg-muted/30 flex items-center justify-center">
            <config.icon className="h-10 w-10 text-muted-foreground/30" />
          </div>
          <div className="p-3 flex items-center justify-between">
            <div>
              <h3 className="font-medium text-sm">{board.title}</h3>
              <p className="text-[10px] text-muted-foreground mt-0.5">{formatRelativeTime(board.updated_at)}</p>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); if (confirm(t('common.confirm'))) deleteMutation.mutate(board.id); }}
              className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-muted transition"
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )}
    </div>
  );
}
