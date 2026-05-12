import { useState } from 'react';
import { Send, Lock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ProjectComment } from '@/types/projects';

interface CommentsThreadProps {
  comments: ProjectComment[];
  currentUserId: string;
  onAdd: (content: string, isInternal: boolean) => void;
  onDelete: (id: string) => void;
}

export function CommentsThread({ comments, currentUserId, onAdd, onDelete }: CommentsThreadProps) {
  const [content, setContent] = useState('');
  const [isInternal, setIsInternal] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    onAdd(content.trim(), isInternal);
    setContent('');
  };

  return (
    <div className="space-y-4">
      {/* Comments list */}
      {comments.length > 0 ? (
        <div className="space-y-3">
          {comments.map(comment => (
            <div
              key={comment.id}
              className={`rounded-lg border p-3 ${comment.is_internal ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800' : 'bg-card'}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-6 w-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">
                    {(comment.user_email || '?')[0].toUpperCase()}
                  </div>
                  <span className="text-xs font-medium">{comment.user_email || 'Utente'}</span>
                  {comment.is_internal && (
                    <span className="flex items-center gap-0.5 text-[10px] text-amber-600 font-medium">
                      <Lock className="h-3 w-3" />
                      Interno
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(comment.created_at).toLocaleString('it-IT', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {comment.user_id === currentUserId && (
                    <button
                      onClick={() => onDelete(comment.id)}
                      className="text-destructive/60 hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
              <p className="text-sm mt-2 whitespace-pre-wrap">{comment.content}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-center text-sm text-muted-foreground py-6">Nessun commento</p>
      )}

      {/* Add comment form */}
      <form onSubmit={handleSubmit} className="space-y-2">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Scrivi un commento..."
          className="w-full rounded-lg border bg-background p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
          rows={3}
        />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={isInternal}
              onChange={(e) => setIsInternal(e.target.checked)}
              className="rounded"
            />
            <Lock className="h-3 w-3" />
            Nota interna (non visibile al cliente)
          </label>
          <Button type="submit" size="sm" disabled={!content.trim()}>
            <Send className="h-4 w-4 mr-1" />
            Invia
          </Button>
        </div>
      </form>
    </div>
  );
}
