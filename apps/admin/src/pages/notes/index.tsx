import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus, StickyNote, Pin, PinOff, Trash2, Search,
  MessageCircle, Bot, AppWindow, Filter,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { NOTE_TEMPLATES } from '@/data/note-templates';
import type { Note } from '@/types/notes';
import { useI18n } from '@/hooks/use-i18n';

const SOURCE_ICONS: Record<string, React.ElementType> = {
  app: AppWindow,
  telegram: MessageCircle,
  agent: Bot,
};

const SOURCE_LABELS: Record<string, string> = {
  app: 'App',
  telegram: 'Telegram',
  agent: 'AI Agent',
};

export default function NotesPage() {
  const { t, formatRelativeTime } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);

  const { data } = useQuery({
    queryKey: ['notes', { search, source: sourceFilter }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (sourceFilter) params.set('source', sourceFilter);
      return apiFetch(`/api/notes?${params}`);
    },
  });

  const notes: Note[] = data?.notes || [];

  const createMutation = useMutation({
    mutationFn: (template?: { title: string; content: string }) => apiFetch('/api/notes', {
      method: 'POST',
      body: JSON.stringify({
        title: template?.title || 'Senza titolo',
        raw_markdown: template?.content || null,
        source: 'app',
      }),
    }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      navigate(`/notes/${data.note.id}`);
    },
  });

  const pinMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/notes/${id}/pin`, { method: 'PATCH' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['notes'] }); toast.success(t('notes.deleted')); },
  });

  useTopbar({ title: t('nav.notes'), subtitle: t('notes.count', { count: notes.length }) });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div />
        <div className="flex items-center gap-2 relative">
          <Button size="sm" onClick={() => createMutation.mutate(undefined)} disabled={createMutation.isPending}>
            <Plus className="h-4 w-4 mr-1.5" /> {t('notes.emptyNote')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowTemplates(!showTemplates)}>
            {t('notes.fromTemplate')}
          </Button>
          {showTemplates && (
            <div className="absolute top-full right-0 mt-1 z-50 w-64 rounded-xl border bg-popover p-2 shadow-lg">
              {NOTE_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    createMutation.mutate({ title: t.title, content: t.content });
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
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('notes.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <div className="flex items-center gap-1">
          <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
          {['', 'app', 'telegram', 'agent'].map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs transition-colors',
                sourceFilter === s ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {s ? SOURCE_LABELS[s] : t('common.all')}
            </button>
          ))}
        </div>
      </div>

      {/* Notes grid */}
      {notes.length === 0 ? (
        <EmptyState
          title={t('notes.emptyTitle')}
          description={t('notes.emptyDescription')}
          icon={StickyNote}
        >
          <Button size="sm" className="mt-4" onClick={() => createMutation.mutate(undefined)}>
            <Plus className="h-4 w-4 mr-1.5" /> {t('notes.createFirst')}
          </Button>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {notes.map((note) => {
            const SourceIcon = SOURCE_ICONS[note.source] || AppWindow;
            return (
              <div
                key={note.id}
                onClick={() => navigate(`/notes/${note.id}`)}
                className={cn(
                  'group rounded-xl border bg-card p-4 cursor-pointer transition-all hover:shadow-md hover:border-primary/20',
                  note.is_pinned && 'border-primary/30 bg-primary/[0.02]'
                )}
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-medium text-sm line-clamp-1 flex-1">{note.title}</h3>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); pinMutation.mutate(note.id); }}
                      className="p-1 rounded hover:bg-muted"
                    >
                      {note.is_pinned ? <PinOff className="h-3.5 w-3.5 text-primary" /> : <Pin className="h-3.5 w-3.5 text-muted-foreground" />}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (confirm(t('common.confirm'))) deleteMutation.mutate(note.id); }}
                      className="p-1 rounded hover:bg-muted"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </button>
                  </div>
                </div>

                {note.preview && (
                  <p className="text-xs text-muted-foreground line-clamp-3 mb-3">{note.preview}</p>
                )}

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <SourceIcon className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">{formatRelativeTime(note.updated_at)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {note.is_pinned && <Pin className="h-3 w-3 text-primary" />}
                    {note.tags?.slice(0, 2).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[9px] px-1.5 py-0">{tag}</Badge>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
