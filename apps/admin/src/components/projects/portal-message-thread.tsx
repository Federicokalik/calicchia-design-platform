import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

interface PortalMessage {
  id: string;
  content: string;
  sender_name: string;
  sender_type: 'admin' | 'client' | 'collaborator';
  is_internal: boolean;
  attachments: unknown;
  customer_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PortalMessageThreadProps {
  projectId: string;
}

/**
 * Admin-side message thread that mirrors `MessageThread` on the portal
 * (apps/sito-v3/src/components/portal/MessageThread.tsx). Reads/writes via
 * /api/portal-admin/projects/:projectId/messages — the new endpoints added
 * to portal-admin.ts for audit B-006. The admin's POST:
 *  - inserts a project_comments row with customer_id=NULL, is_internal=false
 *  - emits a timeline_event (actor_type='admin')
 *  - emails the customer when an address is on file
 */
export function PortalMessageThread({ projectId }: PortalMessageThreadProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const { data, isLoading } = useQuery<{ messages: PortalMessage[] }>({
    queryKey: ['portal-admin-messages', projectId],
    queryFn: () => apiFetch(`/api/portal-admin/projects/${projectId}/messages`),
    refetchInterval: 30_000,
  });
  const messages = data?.messages ?? [];

  useEffect(() => {
    // Autoscroll to bottom when new messages arrive.
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      apiFetch(`/api/portal-admin/projects/${projectId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }),
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['portal-admin-messages', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-timeline', projectId] });
      toast.success('Messaggio inviato');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Invio fallito');
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || sendMutation.isPending) return;
    sendMutation.mutate(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter sends — matches portal MessageThread UX
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (draft.trim() && !sendMutation.isPending) sendMutation.mutate(draft.trim());
    }
  }

  if (isLoading) return <LoadingState />;

  return (
    <div className="flex flex-col gap-4">
      <div
        ref={scrollerRef}
        className="rounded-lg border bg-card max-h-[480px] overflow-y-auto p-4 space-y-3"
      >
        {messages.length === 0 ? (
          <EmptyState
            title="Nessun messaggio"
            description="I messaggi inviati dal cliente nel portale appariranno qui."
            icon={User}
          />
        ) : (
          messages.map((m) => {
            // Audit B-013: admin/collaborator both align right (outgoing),
            // client aligns left. Badge label discriminates the three.
            const isOutgoing = m.sender_type !== 'client';
            const badgeLabel =
              m.sender_type === 'admin'
                ? 'admin'
                : m.sender_type === 'collaborator'
                  ? 'collab'
                  : 'cliente';
            return (
              <div
                key={m.id}
                className={cn(
                  'flex flex-col gap-1 max-w-[80%] rounded-lg px-3 py-2',
                  isOutgoing
                    ? 'self-end bg-primary/10 ml-auto'
                    : 'self-start bg-muted',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">
                    {m.sender_name || (isOutgoing ? 'Calicchia' : 'Cliente')}
                  </span>
                  <Badge variant={m.sender_type === 'admin' ? 'default' : 'secondary'} className="h-4 px-1.5 text-[10px]">
                    {badgeLabel}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {new Date(m.created_at).toLocaleString('it-IT', {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Scrivi una risposta al cliente… (Ctrl/Cmd + Enter per inviare)"
          rows={3}
          maxLength={5000}
          disabled={sendMutation.isPending}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{draft.length} / 5000</span>
          <Button
            type="submit"
            size="sm"
            disabled={!draft.trim() || sendMutation.isPending}
            className="gap-1.5"
          >
            <Send className="h-3.5 w-3.5" />
            {sendMutation.isPending ? 'Invio…' : 'Invia messaggio'}
          </Button>
        </div>
      </form>
    </div>
  );
}
