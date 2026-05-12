import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Pin, PinOff, Trash2, X, Plus, MessageCircle, Bot, AppWindow, Loader2, Download, Printer, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';
import { LinkEntityPicker } from '@/components/shared/link-entity-picker';
import TiptapEditor from '@/components/notes/tiptap-editor';
import type { JSONContent } from '@tiptap/react';
import type { Note } from '@/types/notes';

const SOURCE_ICONS: Record<string, React.ElementType> = {
  app: AppWindow, telegram: MessageCircle, agent: Bot,
};

export default function NoteEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState<JSONContent | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentInitialized = useRef(false);

  const { data, isLoading } = useQuery({
    queryKey: ['note', id],
    queryFn: () => apiFetch(`/api/notes/${id}`),
    enabled: !!id,
  });

  const note: Note | undefined = data?.note;
  const SourceIcon = note ? (SOURCE_ICONS[note.source] || AppWindow) : AppWindow;

  // Initialize state from fetched note
  useEffect(() => {
    if (note && !contentInitialized.current) {
      setTitle(note.title);
      setTags(note.tags || []);
      // If note has raw_markdown but no content, use markdown as initial content
      if (note.content) {
        setContent(note.content as JSONContent);
      } else if (note.raw_markdown) {
        // Tiptap will parse this as text content
        setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: note.raw_markdown }] }] });
      }
      contentInitialized.current = true;
    }
  }, [note]);

  const saveMutation = useMutation({
    mutationFn: (data: Partial<Note>) =>
      apiFetch(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      setSaving(false);
      setLastSaved(new Date());
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
    onError: () => { setSaving(false); toast.error('Errore salvataggio'); },
  });

  const pinMutation = useMutation({
    mutationFn: (_?: void) => apiFetch(`/api/notes/${id}/pin`, { method: 'PATCH' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['note', id] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (_?: void) => apiFetch(`/api/notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Nota eliminata'); navigate('/notes'); },
  });

  // Autosave on content change (debounced 1s)
  const scheduleAutosave = useCallback((updates: Partial<Note>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      setSaving(true);
      saveMutation.mutate(updates);
    }, 1000);
  }, [saveMutation]);

  const handleContentChange = useCallback((json: JSONContent) => {
    setContent(json);
    if (contentInitialized.current) {
      scheduleAutosave({ content: json as any });
    }
  }, [scheduleAutosave]);

  const handleTitleBlur = () => {
    if (note && title !== note.title) {
      saveMutation.mutate({ title } as any);
    }
  };

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) {
      const newTags = [...tags, t];
      setTags(newTags);
      setTagInput('');
      saveMutation.mutate({ tags: newTags } as any);
    }
  };

  const removeTag = (tag: string) => {
    const newTags = tags.filter((t) => t !== tag);
    setTags(newTags);
    saveMutation.mutate({ tags: newTags } as any);
  };

  useTopbar({ title: 'Nota' });

  if (isLoading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!note) return <div className="text-center text-muted-foreground py-12">Nota non trovata</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate('/notes')}>
          <ArrowLeft className="h-4 w-4 mr-1.5" /> Note
        </Button>
        <div className="flex items-center gap-2">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {lastSaved && !saving && (
            <span className="text-[10px] text-muted-foreground">
              Salvato {lastSaved.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={async () => {
            const TurndownService = (await import('turndown')).default;
            const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
            const el = document.querySelector('.ProseMirror');
            const md = el ? td.turndown(el.innerHTML) : (note?.raw_markdown || '');
            const blob = new Blob([`# ${title}\n\n${md}`], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `${title || 'nota'}.md`; a.click();
            URL.revokeObjectURL(url);
          }}>
            <Download className="h-3.5 w-3.5 mr-1" /> MD
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1" /> PDF
          </Button>
        </div>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <SourceIcon className="h-4 w-4 text-muted-foreground" />
          <Badge variant="outline" className="text-[10px]">{note.source}</Badge>
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => pinMutation.mutate()}>
          {note.is_pinned ? <PinOff className="h-4 w-4 text-primary" /> : <Pin className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { if (confirm('Eliminare questa nota?')) deleteMutation.mutate(); }}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      {/* Title */}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleTitleBlur}
        placeholder="Senza titolo"
        className="w-full text-2xl font-bold bg-transparent border-none outline-none placeholder:text-muted-foreground/40"
      />

      {/* Tags */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="text-xs gap-1 pr-1">
            {tag}
            <button onClick={() => removeTag(tag)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
          </Badge>
        ))}
        <div className="flex items-center gap-1">
          <Input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            placeholder="Aggiungi tag..."
            className="h-6 w-24 text-xs border-none bg-transparent px-1"
          />
          {tagInput && (
            <button onClick={addTag} className="text-muted-foreground hover:text-primary">
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Link to entity */}
      <LinkEntityPicker
        linkedType={note.linked_type}
        linkedId={note.linked_id}
        onChange={(type, id) => {
          saveMutation.mutate({ linked_type: type, linked_id: id } as any);
        }}
      />

      {/* AI Summary */}
      {summary && (
        <div className="rounded-lg border bg-primary/5 border-primary/20 p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-medium text-primary flex items-center gap-1"><Sparkles className="h-3 w-3" /> Riassunto AI</span>
            <button onClick={() => setSummary(null)} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
          </div>
          <p className="text-xs text-muted-foreground">{summary}</p>
        </div>
      )}

      {/* AI Actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline" size="sm"
          disabled={summarizing}
          onClick={async () => {
            setSummarizing(true);
            try {
              const el = document.querySelector('.ProseMirror');
              const text = el?.textContent || note?.raw_markdown || '';
              const res = await apiFetch('/api/ai/knowledge/summarize', {
                method: 'POST', body: JSON.stringify({ content: text, title }),
              });
              setSummary(res.summary);
            } catch { toast.error('Errore AI'); }
            setSummarizing(false);
          }}
        >
          {summarizing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
          Riassumi
        </Button>
      </div>

      {/* Editor */}
      <TiptapEditor
        content={content}
        onChange={handleContentChange}
        onForceSave={() => {
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          setSaving(true);
          saveMutation.mutate({ content: content as any });
        }}
      />
    </div>
  );
}
