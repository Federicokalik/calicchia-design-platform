import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MessageCircle, Send, Search, Archive, ArchiveRestore, Sparkles,
  Check, X, Pencil, Loader2, RefreshCw, Inbox, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';

interface ConversationSummary {
  id: string;
  chat_id: string;
  phone: string;
  contact_name: string | null;
  ai_mode: 'off' | 'triage' | 'auto_reply';
  customer_id: string | null;
  customer_name: string | null;
  company_name: string | null;
  lead_name: string | null;
  unread_count: number;
  archived: boolean;
  last_message_at: string | null;
  last_message_preview: string | null;
}

interface WaMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  category: string;
  type: string;
  body: string | null;
  media_path: string | null;
  media_mime: string | null;
  ack_status: string | null;
  sender_kind: 'user' | 'admin' | 'ai' | 'workflow' | 'system';
  ai_draft: boolean;
  ai_draft_approved_at: string | null;
  created_at: string;
}

function formatRelativeTime(raw: string | null): string {
  if (!raw) return '';
  const d = new Date(raw);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (d >= today) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (diffDays < 7) return d.toLocaleDateString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

export default function WhatsAppInboxPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [archivedView, setArchivedView] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const { data: status } = useQuery<{ configured: boolean; connected: boolean; reason?: string }>({
    queryKey: ['whatsapp-status'],
    queryFn: () => apiFetch('/api/whatsapp-admin/status'),
    refetchInterval: 30_000,
  });

  const { data: convData, refetch: refetchConvs } = useQuery<{ conversations: ConversationSummary[] }>({
    queryKey: ['wa-conversations', archivedView, search],
    queryFn: () => apiFetch(`/api/whatsapp-admin/conversations?${new URLSearchParams({
      archived: archivedView ? '1' : '0',
      ...(search ? { q: search } : {}),
      limit: '50',
    })}`),
    refetchInterval: 10_000,
  });

  const conversations = convData?.conversations ?? [];
  const selectedId = conversationId || searchParams.get('id') || conversations[0]?.id;

  const { data: msgData, refetch: refetchMessages } = useQuery<{ messages: WaMessage[] }>({
    queryKey: ['wa-messages', selectedId],
    queryFn: () => selectedId ? apiFetch(`/api/whatsapp-admin/conversations/${selectedId}/messages?limit=100`) : Promise.resolve({ messages: [] }),
    enabled: Boolean(selectedId),
    refetchInterval: 10_000,
  });

  const messages = msgData?.messages ?? [];
  const selectedConv = conversations.find(c => c.id === selectedId);

  // Auto-mark-read quando seleziono una conv con unread.
  // Dipendiamo da id+unread separati per non rifirare ogni volta che cambia un altro campo.
  const selectedConvId = selectedConv?.id;
  const selectedConvUnread = selectedConv?.unread_count ?? 0;
  useEffect(() => {
    if (selectedConvId && selectedConvUnread > 0) {
      apiFetch(`/api/whatsapp-admin/conversations/${selectedConvId}/read`, { method: 'POST' })
        .then(() => refetchConvs())
        .catch(() => { /* ignore */ });
    }
  }, [selectedConvId, selectedConvUnread, refetchConvs]);

  const sendMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, category: 'operational' }),
      }),
    onSuccess: () => {
      setDraft('');
      refetchMessages();
      refetchConvs();
    },
    onError: (err: Error) => {
      if (err.message?.includes('opt_out')) {
        toast.error('Il destinatario ha disattivato i messaggi non essenziali');
      } else {
        toast.error(err.message || 'Errore invio');
      }
    },
  });

  const aiModeMutation = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: string }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/ai-mode`, {
        method: 'POST',
        body: JSON.stringify({ ai_mode: mode }),
      }),
    onSuccess: () => {
      toast.success('Modalità AI aggiornata');
      refetchConvs();
    },
  });

  const approveMutation = useMutation({
    mutationFn: (msgId: string) => apiFetch(`/api/whatsapp-admin/messages/${msgId}/approve`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Bozza inviata');
      refetchMessages();
      refetchConvs();
    },
    onError: (err: Error) => toast.error(err.message || 'Errore invio bozza'),
  });

  const discardMutation = useMutation({
    mutationFn: (msgId: string) => apiFetch(`/api/whatsapp-admin/messages/${msgId}/discard`, { method: 'POST' }),
    onSuccess: () => { refetchMessages(); },
  });

  const editDraftMutation = useMutation({
    mutationFn: ({ msgId, body }: { msgId: string; body: string }) =>
      apiFetch(`/api/whatsapp-admin/messages/${msgId}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      setEditingDraftId(null);
      setEditingText('');
      refetchMessages();
    },
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived }),
      }),
    onSuccess: () => { refetchConvs(); },
  });

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Left pane — conversations list */}
      <aside className="w-[340px] border-r flex flex-col bg-background">
        <div className="p-3 border-b space-y-2">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-semibold flex items-center gap-2">
              <MessageCircle className="h-4 w-4" /> WhatsApp
            </h1>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => refetchConvs()}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant={archivedView ? 'default' : 'ghost'}
                onClick={() => setArchivedView(!archivedView)}
                title="Archivio"
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca contatto, numero, testo…"
              className="h-9 pl-8 text-sm"
            />
          </div>
          {status && !status.connected && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-600 px-1">
              <AlertCircle className="h-3 w-3" />
              {status.configured ? 'Non connesso' : (status.reason || 'GOWA non configurato')}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {conversations.length === 0 ? (
            <EmptyState
              title={archivedView ? 'Nessuna conversazione archiviata' : 'Nessuna conversazione'}
              description={archivedView ? '' : 'I messaggi WhatsApp appariranno qui appena arrivano.'}
              icon={Inbox}
            />
          ) : conversations.map(conv => (
            <button
              key={conv.id}
              onClick={() => navigate(`/whatsapp/${conv.id}`)}
              className={cn(
                'w-full text-left px-3 py-2.5 border-b hover:bg-muted/50 transition-colors',
                selectedId === conv.id && 'bg-muted'
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className={cn('text-sm truncate', conv.unread_count > 0 && 'font-semibold')}>
                      {conv.customer_name || conv.lead_name || conv.contact_name || conv.phone}
                    </p>
                    {conv.ai_mode !== 'off' && (
                      <Sparkles className={cn(
                        'h-3 w-3 shrink-0',
                        conv.ai_mode === 'auto_reply' ? 'text-emerald-500' : 'text-violet-500'
                      )} />
                    )}
                  </div>
                  {conv.company_name && (
                    <p className="text-[10px] text-muted-foreground truncate">{conv.company_name}</p>
                  )}
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {conv.last_message_preview || '—'}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="text-[10px] text-muted-foreground">{formatRelativeTime(conv.last_message_at)}</span>
                  {conv.unread_count > 0 && (
                    <Badge variant="default" className="h-4 min-w-4 px-1 text-[10px]">{conv.unread_count}</Badge>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Right pane — thread */}
      <main className="flex-1 flex flex-col bg-muted/30">
        {!selectedConv ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              title="Seleziona una conversazione"
              description="Oppure aspetta che ne arrivi una nuova."
              icon={MessageCircle}
            />
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b bg-background">
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">
                  {selectedConv.customer_name || selectedConv.lead_name || selectedConv.contact_name || selectedConv.phone}
                </p>
                <p className="text-xs text-muted-foreground">
                  {selectedConv.company_name && <span className="mr-2">{selectedConv.company_name}</span>}
                  <span>{selectedConv.phone}</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={selectedConv.ai_mode}
                  onValueChange={(v) => aiModeMutation.mutate({ id: selectedConv.id, mode: v })}
                >
                  <SelectTrigger className="h-8 text-xs w-[180px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">AI: Off</SelectItem>
                    <SelectItem value="triage">AI: Triage (bozza)</SelectItem>
                    <SelectItem value="auto_reply">AI: Auto-reply</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => archiveMutation.mutate({ id: selectedConv.id, archived: !selectedConv.archived })}
                  title={selectedConv.archived ? 'Riporta in inbox' : 'Archivia'}
                >
                  {selectedConv.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            {/* Messages thread */}
            <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4 space-y-2">
              {messages.length === 0 ? (
                <p className="text-center text-xs text-muted-foreground py-8">Nessun messaggio.</p>
              ) : messages.map(m => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  isEditing={editingDraftId === m.id}
                  editingText={editingText}
                  onEditChange={setEditingText}
                  onStartEdit={() => { setEditingDraftId(m.id); setEditingText(m.body || ''); }}
                  onCancelEdit={() => { setEditingDraftId(null); setEditingText(''); }}
                  onSaveEdit={() => editDraftMutation.mutate({ msgId: m.id, body: editingText })}
                  onApprove={() => approveMutation.mutate(m.id)}
                  onDiscard={() => discardMutation.mutate(m.id)}
                />
              ))}
            </div>

            {/* Composer */}
            <div className="border-t bg-background p-3 flex items-end gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Scrivi un messaggio…"
                className="min-h-[60px] text-sm resize-none flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) {
                    sendMutation.mutate({ id: selectedConv.id, text: draft.trim() });
                  }
                }}
              />
              <Button
                onClick={() => draft.trim() && sendMutation.mutate({ id: selectedConv.id, text: draft.trim() })}
                disabled={!draft.trim() || sendMutation.isPending || !status?.connected}
              >
                {sendMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

interface BubbleProps {
  message: WaMessage;
  isEditing: boolean;
  editingText: string;
  onEditChange: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onApprove: () => void;
  onDiscard: () => void;
}

function MessageBubble({ message, isEditing, editingText, onEditChange, onStartEdit, onCancelEdit, onSaveEdit, onApprove, onDiscard }: BubbleProps) {
  const m = message;
  const isOut = m.direction === 'outbound';
  const isDraft = m.ai_draft && !m.ai_draft_approved_at;

  return (
    <div className={cn('flex', isOut ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[70%] rounded-2xl px-3.5 py-2 text-sm',
          isOut
            ? isDraft
              ? 'bg-violet-100 border border-violet-300 text-violet-900'
              : 'bg-primary text-primary-foreground'
            : 'bg-background border'
        )}
      >
        {isDraft && (
          <div className="text-[10px] uppercase tracking-wide font-semibold text-violet-700 mb-1 flex items-center gap-1">
            <Sparkles className="h-3 w-3" /> Bozza AI
          </div>
        )}

        {isEditing ? (
          <div className="space-y-2">
            <Textarea
              value={editingText}
              onChange={(e) => onEditChange(e.target.value)}
              className="min-h-[80px] text-sm bg-white text-foreground"
            />
            <div className="flex gap-1 justify-end">
              <Button size="sm" variant="ghost" onClick={onCancelEdit}>Annulla</Button>
              <Button size="sm" onClick={onSaveEdit}>Salva</Button>
            </div>
          </div>
        ) : (
          <>
            {m.type === 'text' || m.type === 'reaction' ? (
              <p className="whitespace-pre-wrap break-words">{m.body || (m.type === 'reaction' ? '👍' : '')}</p>
            ) : m.type === 'image' && m.media_path ? (
              <img src={`/media/${m.media_path}`} alt="" className="rounded-lg max-w-full" />
            ) : (
              <p className="italic opacity-70">[{m.type}]{m.body ? ` ${m.body}` : ''}</p>
            )}
            <div className={cn('flex items-center gap-1.5 mt-1 text-[10px]', isOut ? 'opacity-70 justify-end' : 'text-muted-foreground')}>
              <span>{formatRelativeTime(m.created_at)}</span>
              {isOut && !isDraft && m.ack_status && (
                <CheckCircle2 className={cn('h-2.5 w-2.5', m.ack_status === 'read' && 'text-blue-300')} />
              )}
              {m.sender_kind === 'ai' && !isDraft && (
                <span className="flex items-center gap-0.5"><Sparkles className="h-2.5 w-2.5" />AI</span>
              )}
            </div>
            {isDraft && (
              <div className="flex gap-1 mt-2">
                <Button size="sm" onClick={onApprove} className="h-7 text-xs">
                  <Check className="h-3 w-3 mr-1" /> Approva e invia
                </Button>
                <Button size="sm" variant="outline" onClick={onStartEdit} className="h-7 text-xs">
                  <Pencil className="h-3 w-3 mr-1" /> Modifica
                </Button>
                <Button size="sm" variant="ghost" onClick={onDiscard} className="h-7 text-xs">
                  <X className="h-3 w-3 mr-1" /> Scarta
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
