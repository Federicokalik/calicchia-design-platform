import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MessageCircle, Send, Search, Archive, ArchiveRestore, Sparkles, Check, X, Pencil,
  Loader2, RefreshCw, Inbox, AlertCircle, Activity, DownloadCloud, Users, User as UserIcon,
  Phone, MoreHorizontal, ArrowLeft, Trash2, UserPlus, MailOpen, Link2, Zap, MessageSquare,
  Paperclip, FileText, Smile, Reply, Pin, PinOff, BellOff, Bell, CircleDot, StickyNote,
  BrainCircuit, Tag, Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { EmptyState } from '@/components/shared/empty-state';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { formatPhoneE164, initialsOf, avatarColorFor } from '@/lib/format';
import { useWhatsAppStream } from '@/hooks/use-whatsapp-stream';
import { useBrowserNotifications } from '@/hooks/use-browser-notifications';
import { CustomerPanel } from './customer-panel';

// ---------- types ----------

interface ConversationSummary {
  id: string;
  chat_id: string;
  phone: string;
  contact_name: string | null;
  ai_mode: 'off' | 'triage' | 'auto_reply';
  customer_id: string | null;
  customer_name: string | null;
  lead_id: string | null;
  company_name: string | null;
  lead_name: string | null;
  unread_count: number;
  archived: boolean;
  is_group: boolean;
  pinned: boolean;
  muted_until: string | null;
  status: 'open' | 'waiting' | 'resolved';
  internal_note: string | null;
  ai_instructions: string | null;
  tags: string[];
  last_message_at: string | null;
  last_message_preview: string | null;
  // Only present on detail responses (GET /:id):
  pref_marketing?: boolean | null;
  pref_operational?: boolean | null;
  pref_transactional?: boolean | null;
  last_outbound_at?: string | null;
  scheduled_pending?: number;
}

interface WaMessage {
  id: string;
  conversation_id: string;
  external_id: string | null;
  direction: 'inbound' | 'outbound';
  category: string;
  type: string;
  body: string | null;
  media_path: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_size: number | null;
  ack_status: 'sent' | 'delivered' | 'read' | null;
  sender_kind: 'user' | 'admin' | 'ai' | 'workflow' | 'system';
  ai_draft: boolean;
  ai_draft_approved_at: string | null;
  reply_to_external_id: string | null;
  created_at: string;
  meta?: {
    push_name?: string;
    filename?: string;
    reactions?: Array<{ emoji: string; from: string | null; at: string }>;
    target?: string | null;
    revoked?: boolean;
    edited?: boolean;
    [k: string]: unknown;
  } | null;
}

interface QuickReply { label: string; text: string }

type TabKey = 'chats' | 'groups' | 'archived';

// ---------- helpers ----------

function formatRelativeTime(raw: string | null): string {
  if (!raw) return '';
  const d = new Date(raw);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (d >= today) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (diffDays < 7) return d.toLocaleDateString('it-IT', { weekday: 'short' });
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

function dayLabelOf(raw: string): string {
  const d = new Date(raw);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d >= today) return 'Oggi';
  if (d >= y) return 'Ieri';
  const diffDays = (today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays < 7) return d.toLocaleDateString('it-IT', { weekday: 'long' });
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

type MessageRow = { kind: 'msg'; msg: WaMessage } | { kind: 'sep'; key: string; label: string };

function groupMessagesByDay(messages: WaMessage[]): MessageRow[] {
  const out: MessageRow[] = [];
  let lastDay = '';
  for (const m of messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) {
      out.push({ kind: 'sep', key: `sep-${day}`, label: dayLabelOf(m.created_at) });
      lastDay = day;
    }
    out.push({ kind: 'msg', msg: m });
  }
  return out;
}

// Best-effort name lookup for a conversation.
function displayNameOf(c: Pick<ConversationSummary, 'customer_name' | 'lead_name' | 'contact_name' | 'phone'>): string {
  return c.customer_name || c.lead_name || c.contact_name || formatPhoneE164(c.phone) || c.phone;
}

// ---------- atoms ----------

function AckTicks({ status }: { status: WaMessage['ack_status'] }) {
  // GOWA reports ack as 'sent' | 'delivered' | 'read'. Null means we just
  // pushed the row locally and haven't received an ack yet — show a single
  // grey tick so the operator sees the message did leave the composer.
  if (!status || status === 'sent') {
    return (
      <svg viewBox="0 0 16 16" className="wa-tick" width="14" height="14" aria-label="inviato">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  const colorClass = status === 'read' ? 'wa-tick-read' : 'wa-tick';
  return (
    <svg viewBox="0 0 18 16" className={colorClass} width="16" height="14" aria-label={status === 'read' ? 'letto' : 'consegnato'}>
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M1.5 8.5l3 3 6-7M6 11.5l3 3 8-9" />
    </svg>
  );
}

function Avatar({ name, seedKey, size = 36 }: { name: string; seedKey: string; size?: number }) {
  return (
    <div
      className="rounded-full flex items-center justify-center text-white text-xs font-medium select-none shrink-0"
      style={{ width: size, height: size, backgroundColor: avatarColorFor(seedKey) }}
      aria-hidden
    >
      {initialsOf(name)}
    </div>
  );
}

// ---------- page ----------

export default function WhatsAppInboxPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('chats');
  const [draft, setDraft] = useState('');
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [createLeadOpen, setCreateLeadOpen] = useState(false);
  const [linkCustomerOpen, setLinkCustomerOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pendingMedia, setPendingMedia] = useState<{ file: File; previewUrl: string } | null>(null);
  const [replyingTo, setReplyingTo] = useState<WaMessage | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [olderMessages, setOlderMessages] = useState<WaMessage[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);

  // Browser notifications + WebAudio beep on inbound messages.
  const notifications = useBrowserNotifications();
  const notificationsRef = useRef(notifications);
  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);

  // Typing indicator state. We track {conversationId, state} and auto-clear
  // after 5s of no new typing event, mirroring how WhatsApp itself behaves.
  const [typingFor, setTypingFor] = useState<string | null>(null);
  const [typingState, setTypingState] = useState<'composing' | 'recording' | 'paused' | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Real-time SSE. While connected we kill the polling intervals; the stream
  // handler invalidates queries on push. Falls back to interval polling if
  // SSE can't reach (proxy strip / first-event timeout).
  const { connected: streamConnected } = useWhatsAppStream({
    onInbound: (convId) => {
      // Skip beep/notify if the user is already looking at that exact thread —
      // there is nothing they would miss.
      if (typeof document !== 'undefined' && !document.hidden && convId === selectedId) return;
      // Honour per-conversation mute.
      const conv = conversationsRef.current.find((c) => c.id === convId);
      if (conv?.muted_until && new Date(conv.muted_until).getTime() > Date.now()) return;
      const title = conv ? displayNameOf(conv) : 'Nuovo messaggio WhatsApp';
      notificationsRef.current.notify({
        title: `${title}`,
        body: conv?.last_message_preview || 'Hai un nuovo messaggio',
        tag: `wa-${convId}`,
      });
    },
    onTyping: (convId, state) => {
      setTypingFor(convId);
      setTypingState(state === 'paused' ? null : state);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        setTypingFor(null);
        setTypingState(null);
      }, 5000);
    },
  });

  // ---------- queries ----------

  const { data: status } = useQuery<{ configured: boolean; connected: boolean; reason?: string }>({
    queryKey: ['whatsapp-status'],
    queryFn: () => apiFetch('/api/whatsapp-admin/status'),
    refetchInterval: 30_000,
  });

  // Fetch is segmented only by archived/active — group vs 1-to-1 is filtered
  // client-side so switching between Chats and Gruppi doesn't trigger a refetch.
  const archivedFilter = activeTab === 'archived';
  const { data: convData, refetch: refetchConvs } = useQuery<{ conversations: ConversationSummary[] }>({
    queryKey: ['wa-conversations', archivedFilter, search],
    queryFn: () => apiFetch(`/api/whatsapp-admin/conversations?${new URLSearchParams({
      archived: archivedFilter ? '1' : '0',
      ...(search ? { q: search } : {}),
      limit: '100',
    })}`),
    refetchInterval: streamConnected ? false : 5_000,
  });

  const conversations = useMemo<ConversationSummary[]>(() => convData?.conversations ?? [], [convData]);

  const visibleConversations = useMemo(() => {
    if (activeTab === 'archived') return conversations;
    return conversations.filter((c) => (activeTab === 'groups' ? c.is_group : !c.is_group));
  }, [conversations, activeTab]);

  // Counters for the tab labels (across active list — archived tab has its own filter)
  const tabCounts = useMemo(() => {
    const chats = conversations.filter((c) => !c.is_group);
    const groups = conversations.filter((c) => c.is_group);
    const unreadOf = (arr: ConversationSummary[]) => arr.reduce((s, c) => s + (c.unread_count > 0 ? 1 : 0), 0);
    return { chats: chats.length, chatsUnread: unreadOf(chats), groups: groups.length, groupsUnread: unreadOf(groups) };
  }, [conversations]);

  const selectedId = conversationId || searchParams.get('id') || undefined;

  const { data: msgData, refetch: refetchMessages } = useQuery<{ messages: WaMessage[] }>({
    queryKey: ['wa-messages', selectedId],
    queryFn: () => selectedId
      ? apiFetch(`/api/whatsapp-admin/conversations/${selectedId}/messages?limit=100`)
      : Promise.resolve({ messages: [] }),
    enabled: Boolean(selectedId),
    refetchInterval: streamConnected ? false : 5_000,
  });

  const latestMessages = useMemo<WaMessage[]>(() => msgData?.messages ?? [], [msgData]);
  // Reset paginated older messages when switching threads — they only make
  // sense in the context of the currently open conversation.
  useEffect(() => { setOlderMessages([]); }, [selectedId]);
  const messages = useMemo<WaMessage[]>(() => [...olderMessages, ...latestMessages], [olderMessages, latestMessages]);
  const baseSelectedConv = conversations.find((c) => c.id === selectedId);

  // GET /:id delivers fields the list endpoint omits: opt-out flags from
  // communication_preferences, scheduled_pending count, last_outbound_at.
  // We merge them on top of the list row.
  const { data: convDetail } = useQuery<ConversationSummary>({
    queryKey: ['wa-conv-detail', selectedId],
    queryFn: () => apiFetch(`/api/whatsapp-admin/conversations/${selectedId}`),
    enabled: Boolean(selectedId),
    refetchInterval: streamConnected ? false : 15_000,
  });
  const selectedConv: ConversationSummary | undefined = baseSelectedConv
    ? { ...baseSelectedConv, ...(convDetail || {}) }
    : convDetail || undefined;
  const groupedMessages = useMemo(() => groupMessagesByDay(messages), [messages]);
  const canLoadMore = latestMessages.length === 100 && olderMessages.length === 0
    || (olderMessages.length > 0 && olderMessages.length % 50 === 0);

  // In-thread search — fetched lazily.
  const trimmedQuery = searchQuery.trim();
  const { data: searchData, isFetching: isSearching } = useQuery<{ matches: Array<{ id: string; body: string | null; created_at: string; direction: 'inbound' | 'outbound' }> }>({
    queryKey: ['wa-search', selectedId, trimmedQuery],
    queryFn: () => apiFetch(`/api/whatsapp-admin/conversations/${selectedId}/search?q=${encodeURIComponent(trimmedQuery)}`),
    enabled: Boolean(selectedId) && searchOpen && trimmedQuery.length >= 2,
  });

  const loadOlderMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) return { messages: [] };
      const oldest = messages[0]?.created_at;
      if (!oldest) return { messages: [] };
      const res = await apiFetch(`/api/whatsapp-admin/conversations/${selectedId}/messages?limit=50&before=${encodeURIComponent(oldest)}`) as { messages: WaMessage[] };
      return res;
    },
    onSuccess: (res) => {
      if (!res.messages?.length) return;
      const container = threadScrollRef.current;
      const prevHeight = container?.scrollHeight ?? 0;
      setOlderMessages((prev) => [...res.messages, ...prev]);
      // Restore scroll position after the new rows render.
      requestAnimationFrame(() => {
        if (container) container.scrollTop = container.scrollHeight - prevHeight;
      });
    },
  });

  const { data: settingsData } = useQuery({
    queryKey: ['settings', 'whatsapp'],
    queryFn: () => apiFetch('/api/settings'),
  });
  const waSettings = (((settingsData as any)?.settings ?? settingsData) || {}) as Record<string, any>;
  const quickReplies: QuickReply[] = Array.isArray(waSettings.whatsapp?.quick_replies) ? waSettings.whatsapp.quick_replies : [];

  // ---------- effects ----------

  // Auto-mark-read when opening a conv that has unread messages.
  const selectedConvUnread = selectedConv?.unread_count ?? 0;
  useEffect(() => {
    if (selectedId && selectedConvUnread > 0) {
      apiFetch(`/api/whatsapp-admin/conversations/${selectedId}/read`, { method: 'POST' })
        .then(() => refetchConvs())
        .catch(() => { /* ignore */ });
    }
  }, [selectedId, selectedConvUnread, refetchConvs]);

  // Auto-scroll to bottom when new messages arrive or thread changes.
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, selectedId]);

  // Mirror conversations into a ref so the SSE onInbound callback can read
  // the freshest list without triggering a hook restart.
  const conversationsRef = useRef(conversations);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

  // Per-conversation draft persistence. Switching threads saves the current
  // draft to localStorage and restores the new one. Send/upload success
  // explicitly clears its slot below.
  const draftStorageKey = (id: string) => `wa-draft:${id}`;
  const prevSelectedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    if (prev && prev !== selectedId) {
      // Save outgoing draft for the old conversation.
      try {
        if (draft) localStorage.setItem(draftStorageKey(prev), draft);
        else localStorage.removeItem(draftStorageKey(prev));
      } catch { /* quota / disabled */ }
    }
    // Restore draft for the new conversation.
    if (selectedId) {
      try {
        const stored = localStorage.getItem(draftStorageKey(selectedId)) || '';
        setDraft(stored);
      } catch { setDraft(''); }
    } else {
      setDraft('');
    }
    prevSelectedRef.current = selectedId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  // Persist on every keystroke so a tab crash doesn't lose what the user typed.
  useEffect(() => {
    if (!selectedId) return;
    try {
      if (draft) localStorage.setItem(draftStorageKey(selectedId), draft);
      else localStorage.removeItem(draftStorageKey(selectedId));
    } catch { /* ignore */ }
  }, [draft, selectedId]);

  // Document title — unread count is the sum of conversations' unread_count,
  // counted only for visible conversations (we don't surface archived in the
  // title).
  useEffect(() => {
    const unread = conversations
      .filter((c) => !c.archived)
      .reduce((acc, c) => acc + (c.unread_count > 0 ? 1 : 0), 0);
    const baseTitle = 'WhatsApp · Calicchia Design';
    const original = document.title;
    document.title = unread > 0 ? `(${unread}) ${baseTitle}` : baseTitle;
    return () => { document.title = original; };
  }, [conversations]);

  // ---------- mutations ----------

  const sendMutation = useMutation({
    mutationFn: ({ id, text, replyToExternalId }: { id: string; text: string; replyToExternalId?: string }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text,
          category: 'operational',
          ...(replyToExternalId ? { reply_to: { external_id: replyToExternalId } } : {}),
        }),
      }),
    onSuccess: (_, vars) => {
      setDraft('');
      setReplyingTo(null);
      try { localStorage.removeItem(`wa-draft:${vars.id}`); } catch { /* ignore */ }
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

  // Upload uses raw fetch instead of apiFetch so we can hand off the
  // FormData unmodified — apiFetch forces Content-Type which would strip the
  // multipart boundary.
  const uploadMutation = useMutation({
    mutationFn: async ({ id, file, caption, replyToExternalId }: { id: string; file: File; caption: string; replyToExternalId?: string }) => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      if (caption) fd.append('caption', caption);
      if (replyToExternalId) fd.append('reply_to_external_id', replyToExternalId);
      const res = await fetch(`/api/whatsapp-admin/conversations/${id}/messages/media`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data;
    },
    onSuccess: (_, vars) => {
      clearPendingMedia();
      setDraft('');
      setReplyingTo(null);
      try { localStorage.removeItem(`wa-draft:${vars.id}`); } catch { /* ignore */ }
      refetchMessages();
      refetchConvs();
    },
    onError: (err: Error) => {
      if (err.message === 'file_too_large') toast.error('File troppo grande (max 16MB)');
      else if (err.message === 'unsupported_mime') toast.error('Tipo di file non supportato');
      else if (err.message?.includes('opt_out')) toast.error('Il destinatario ha disattivato i messaggi non essenziali');
      else toast.error(err.message || 'Errore upload');
    },
  });

  const reactMutation = useMutation({
    mutationFn: ({ msgId, emoji }: { msgId: string; emoji: string }) =>
      apiFetch(`/api/whatsapp-admin/messages/${msgId}/react`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      }),
    onSuccess: () => { refetchMessages(); },
    onError: (err: Error) => toast.error(err.message || 'Errore reazione'),
  });

  function clearPendingMedia() {
    setPendingMedia((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  }

  function attachFile(file: File) {
    // Reject obviously bad shapes early — server validates again.
    if (file.size > 16 * 1024 * 1024) {
      toast.error('File troppo grande (max 16MB)');
      return;
    }
    // Replace any existing pending media (don't queue multiple).
    if (pendingMedia) URL.revokeObjectURL(pendingMedia.previewUrl);
    setPendingMedia({ file, previewUrl: URL.createObjectURL(file) });
  }

  function submitComposer() {
    if (!selectedConv) return;
    // GOWA's reply quote needs the *remote* message id. Outbound messages we
    // just sent won't have it until the ack lands, so silently skip the
    // quote in that edge case rather than failing.
    const replyToExternalId = replyingTo?.external_id || undefined;
    if (pendingMedia) {
      uploadMutation.mutate({
        id: selectedConv.id,
        file: pendingMedia.file,
        caption: draft.trim(),
        replyToExternalId,
      });
    } else if (draft.trim()) {
      sendMutation.mutate({
        id: selectedConv.id,
        text: draft.trim(),
        replyToExternalId,
      });
    }
  }

  // Revoke object URL on unmount.
  useEffect(() => () => {
    if (pendingMedia) URL.revokeObjectURL(pendingMedia.previewUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const syncMutation = useMutation({
    mutationFn: () => apiFetch('/api/whatsapp-admin/sync', { method: 'POST' }),
    onSuccess: (data: { totalChats: number; createdConvs: number; createdMessages: number; errors: unknown[] }) => {
      toast.success(
        `Sync completata: ${data.createdConvs} nuove chat, ${data.createdMessages} nuovi messaggi (su ${data.totalChats} chat)` +
          (data.errors.length ? ` — ${data.errors.length} errori, vedi log api` : ''),
      );
      refetchConvs();
    },
    onError: (err: Error) => toast.error(`Sync fallita: ${err.message}`),
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

  const unreadMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/unread`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Segnato come non letto');
      refetchConvs();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      toast.success('Conversazione eliminata');
      setConfirmDeleteId(null);
      if (selectedId === id) navigate('/whatsapp');
      refetchConvs();
    },
    onError: (err: Error) => toast.error(err.message || 'Errore eliminazione'),
  });

  const linkMutation = useMutation({
    mutationFn: ({ id, customer_id, lead_id }: { id: string; customer_id?: string | null; lead_id?: string | null }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/link`, {
        method: 'POST',
        body: JSON.stringify({ customer_id: customer_id ?? null, lead_id: lead_id ?? null }),
      }),
    onSuccess: () => {
      toast.success('Conversazione collegata');
      refetchConvs();
      qc.invalidateQueries({ queryKey: ['wa-conversations'] });
    },
  });

  const pinMutation = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/pin`, {
        method: 'POST',
        body: JSON.stringify({ pinned }),
      }),
    onSuccess: () => { refetchConvs(); },
  });

  const muteMutation = useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number | null }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/mute`, {
        method: 'POST',
        body: JSON.stringify(minutes === null ? { muted_until: null } : { minutes }),
      }),
    onSuccess: () => { refetchConvs(); },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'open' | 'waiting' | 'resolved' }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => { refetchConvs(); },
  });

  const noteMutation = useMutation({
    mutationFn: ({ id, internal_note }: { id: string; internal_note: string | null }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/note`, {
        method: 'POST',
        body: JSON.stringify({ internal_note }),
      }),
    onSuccess: () => { toast.success('Nota salvata'); refetchConvs(); },
  });

  const aiInstructionsMutation = useMutation({
    mutationFn: ({ id, ai_instructions }: { id: string; ai_instructions: string | null }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/ai-instructions`, {
        method: 'POST',
        body: JSON.stringify({ ai_instructions }),
      }),
    onSuccess: () => { toast.success('Istruzioni AI salvate'); refetchConvs(); },
  });

  const tagsMutation = useMutation({
    mutationFn: ({ id, tags }: { id: string; tags: string[] }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tags }),
      }),
    onSuccess: () => { toast.success('Tag aggiornati'); refetchConvs(); },
  });

  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [aiInstructionsDialogOpen, setAiInstructionsDialogOpen] = useState(false);
  const [tagsDialogOpen, setTagsDialogOpen] = useState(false);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduleListOpen, setScheduleListOpen] = useState(false);

  const scheduleMutation = useMutation({
    mutationFn: ({ id, body, send_at }: { id: string; body: string; send_at: string }) =>
      apiFetch(`/api/whatsapp-admin/conversations/${id}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ body, send_at }),
      }),
    onSuccess: () => {
      toast.success('Messaggio pianificato');
      setScheduleDialogOpen(false);
      setDraft('');
      qc.invalidateQueries({ queryKey: ['wa-scheduled', selectedId] });
      refetchConvs();
    },
    onError: (err: Error) => {
      const msg = err.message === 'send_at_must_be_future' ? 'La data deve essere almeno 1 minuto nel futuro' : (err.message || 'Errore pianificazione');
      toast.error(msg);
    },
  });

  const cancelScheduleMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/whatsapp-admin/scheduled/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Pianificazione annullata');
      qc.invalidateQueries({ queryKey: ['wa-scheduled', selectedId] });
      refetchConvs();
    },
  });

  // ---------- render ----------

  const isThreadOpen = Boolean(selectedConv);

  return (
    <div className="flex flex-col md:flex-row h-[100dvh] md:h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* ============================== LIST PANE ============================== */}
      <aside
        className={cn(
          'w-full md:w-[340px] border-r bg-background flex-col',
          isThreadOpen ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="p-3 border-b space-y-2">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-semibold flex items-center gap-2">
              <MessageCircle className="h-4 w-4" /> WhatsApp
            </h1>
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => refetchConvs()} title="Aggiorna">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon" variant="ghost" className="h-8 w-8"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                title="Importa chat + messaggi esistenti da GOWA (backfill)"
              >
                {syncMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />}
              </Button>
              <Link to="/whatsapp/events">
                <Button size="icon" variant="ghost" className="h-8 w-8" title="Eventi side-channel (gruppi, newsletter, chiamate)">
                  <Activity className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-muted rounded-md p-1">
            <TabButton active={activeTab === 'chats'} onClick={() => setActiveTab('chats')} icon={<MessageSquare className="h-3.5 w-3.5" />} label="Chat" count={tabCounts.chats} unread={tabCounts.chatsUnread} />
            <TabButton active={activeTab === 'groups'} onClick={() => setActiveTab('groups')} icon={<Users className="h-3.5 w-3.5" />} label="Gruppi" count={tabCounts.groups} unread={tabCounts.groupsUnread} />
            <TabButton active={activeTab === 'archived'} onClick={() => setActiveTab('archived')} icon={<Archive className="h-3.5 w-3.5" />} label="Archivio" />
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

          {notifications.supported && notifications.permission === 'default' && (
            <button
              onClick={() => { void notifications.request(); }}
              className="w-full text-left text-[11px] px-2 py-1.5 rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/60"
            >
              <span className="font-medium">Abilita notifiche desktop</span>
              <span className="block text-blue-700/70 dark:text-blue-300/70">Ricevi un avviso quando arriva un messaggio.</span>
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {visibleConversations.length === 0 ? (
            <EmptyState
              title={
                activeTab === 'archived' ? 'Nessuna conversazione archiviata' :
                activeTab === 'groups' ? 'Nessun gruppo' : 'Nessuna conversazione'
              }
              description={activeTab === 'archived' ? '' : 'I messaggi WhatsApp appariranno qui appena arrivano.'}
              icon={Inbox}
            />
          ) : visibleConversations.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              selected={selectedId === conv.id}
              onSelect={() => navigate(`/whatsapp/${conv.id}`)}
              onArchive={() => archiveMutation.mutate({ id: conv.id, archived: !conv.archived })}
              onMarkUnread={() => unreadMutation.mutate(conv.id)}
              onDelete={() => setConfirmDeleteId(conv.id)}
              onCreateLead={() => { navigate(`/whatsapp/${conv.id}`); setCreateLeadOpen(true); }}
              onLinkCustomer={() => { navigate(`/whatsapp/${conv.id}`); setLinkCustomerOpen(true); }}
              onPinToggle={() => pinMutation.mutate({ id: conv.id, pinned: !conv.pinned })}
            />
          ))}
        </div>
      </aside>

      {/* ============================== THREAD PANE ============================== */}
      <main
        className={cn(
          'flex-1 flex-col wa-thread-bg',
          isThreadOpen ? 'flex' : 'hidden md:flex',
        )}
      >
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
            <ThreadHeader
              conv={selectedConv}
              connected={Boolean(status?.connected)}
              searchOpen={searchOpen}
              onToggleSearch={() => setSearchOpen((v) => !v)}
              onTogglePanel={() => setPanelOpen((v) => !v)}
              onBack={() => navigate('/whatsapp')}
              onAiModeChange={(mode) => aiModeMutation.mutate({ id: selectedConv.id, mode })}
              onArchive={() => archiveMutation.mutate({ id: selectedConv.id, archived: !selectedConv.archived })}
              onDelete={() => setConfirmDeleteId(selectedConv.id)}
              onCreateLead={() => setCreateLeadOpen(true)}
              onLinkCustomer={() => setLinkCustomerOpen(true)}
              onPinToggle={() => pinMutation.mutate({ id: selectedConv.id, pinned: !selectedConv.pinned })}
              onMute={(minutes) => muteMutation.mutate({ id: selectedConv.id, minutes })}
              onStatusChange={(s) => statusMutation.mutate({ id: selectedConv.id, status: s })}
              onOpenNoteDialog={() => setNoteDialogOpen(true)}
              onOpenAiInstructionsDialog={() => setAiInstructionsDialogOpen(true)}
              onOpenTagsDialog={() => setTagsDialogOpen(true)}
              typingState={typingFor === selectedConv.id ? typingState : null}
            />

            {searchOpen && (
              <ThreadSearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onClose={() => { setSearchOpen(false); setSearchQuery(''); }}
                results={searchData?.matches ?? []}
                loading={isSearching}
                onJump={(msgId) => {
                  const el = document.querySelector(`[data-message-id="${msgId}"]`);
                  if (el instanceof HTMLElement) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.classList.add('ring-2', 'ring-primary');
                    setTimeout(() => el.classList.remove('ring-2', 'ring-primary'), 1800);
                  }
                }}
              />
            )}

            <div
              ref={threadScrollRef}
              className={cn(
                'relative flex-1 overflow-y-auto scrollbar-thin px-3 md:px-5 py-4',
                dragOver && 'outline-2 outline-dashed outline-primary -outline-offset-8',
              )}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files?.[0];
                if (file) attachFile(file);
              }}
            >
              {dragOver && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 pointer-events-none">
                  <div className="rounded-2xl border-2 border-dashed border-primary bg-background/90 px-6 py-4 text-sm font-medium">
                    Rilascia per allegare
                  </div>
                </div>
              )}
              {canLoadMore && (
                <div className="flex justify-center pb-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => loadOlderMutation.mutate()}
                    disabled={loadOlderMutation.isPending}
                  >
                    {loadOlderMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Carica messaggi precedenti'}
                  </Button>
                </div>
              )}
              {groupedMessages.length === 0 ? (
                <p className="text-center text-xs wa-meta py-8">Nessun messaggio.</p>
              ) : groupedMessages.map((row) => row.kind === 'sep' ? (
                <div key={row.key} className="flex justify-center py-3">
                  <span className="wa-day-separator">{row.label}</span>
                </div>
              ) : (
                <MessageBubble
                  key={row.msg.id}
                  message={row.msg}
                  allMessages={messages}
                  isGroup={selectedConv.is_group}
                  contactName={selectedConv.contact_name || selectedConv.phone}
                  seedKey={selectedConv.phone}
                  isEditing={editingDraftId === row.msg.id}
                  editingText={editingText}
                  onEditChange={setEditingText}
                  onStartEdit={() => { setEditingDraftId(row.msg.id); setEditingText(row.msg.body || ''); }}
                  onCancelEdit={() => { setEditingDraftId(null); setEditingText(''); }}
                  onSaveEdit={() => editDraftMutation.mutate({ msgId: row.msg.id, body: editingText })}
                  onApprove={() => approveMutation.mutate(row.msg.id)}
                  onDiscard={() => discardMutation.mutate(row.msg.id)}
                  onReply={() => setReplyingTo(row.msg)}
                  onReact={(emoji) => reactMutation.mutate({ msgId: row.msg.id, emoji })}
                />
              ))}
              <div ref={threadEndRef} />
            </div>

            {/* Composer */}
            <div className="border-t bg-background" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
              {selectedConv && selectedConv.last_outbound_at === null && !selectedConv.is_group && (
                <div className="flex items-start gap-2 px-3 pt-2 text-xs text-blue-700 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-300 border-b border-blue-100 dark:border-blue-950 py-1.5">
                  <span className="text-base leading-none">🆕</span>
                  <span>
                    <b>Primo contatto:</b> al prossimo messaggio verrà accodato automaticamente il disclaimer GDPR (configurabile in Impostazioni → WhatsApp).
                  </span>
                </div>
              )}
              {replyingTo && (
                <div className="flex items-start gap-2 px-3 pt-2 pb-1">
                  <div className="flex-1 border-l-4 border-primary bg-muted/60 rounded-r-md px-2 py-1.5">
                    <p className="text-[11px] font-medium text-primary">
                      Rispondi a {replyingTo.direction === 'outbound' ? 'te stesso' : (selectedConv.contact_name || formatPhoneE164(selectedConv.phone))}
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-2">{replyingTo.body || `[${replyingTo.type}]`}</p>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setReplyingTo(null)} title="Annulla risposta">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}

              {pendingMedia && (
                <div className="flex items-start gap-2 px-3 pt-2 pb-1">
                  <div className="flex-1 flex items-center gap-2 rounded-md bg-muted/60 px-2 py-2">
                    {pendingMedia.file.type.startsWith('image/') ? (
                      <img src={pendingMedia.previewUrl} alt="" className="h-16 w-16 object-cover rounded" />
                    ) : (
                      <div className="h-16 w-16 rounded bg-background border flex items-center justify-center">
                        <FileText className="h-6 w-6 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{pendingMedia.file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(pendingMedia.file.size / 1024).toFixed(0)} KB · {pendingMedia.file.type || 'sconosciuto'}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">La didascalia opzionale è il testo qui sotto.</p>
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={clearPendingMedia} title="Rimuovi allegato">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}

              <div className="p-2 md:p-3 flex items-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) attachFile(f);
                    // Reset value so picking the same file twice still fires onChange.
                    e.target.value = '';
                  }}
                />

                <Button
                  size="icon"
                  variant="ghost"
                  className="h-11 w-11 shrink-0"
                  title="Allega file"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="h-4 w-4" />
                </Button>

                {quickReplies.length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="icon" variant="ghost" className="h-11 w-11 shrink-0" title="Risposte rapide">
                        <Zap className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" side="top" className="w-72 p-1">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-2 py-1.5">Risposte rapide</div>
                      {quickReplies.map((qr, i) => (
                        <button
                          key={i}
                          className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-muted text-sm"
                          onClick={() => setDraft(qr.text)}
                        >
                          <div className="font-medium truncate">{qr.label}</div>
                          <div className="text-xs text-muted-foreground line-clamp-1">{qr.text}</div>
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>
                )}

                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
                    const file = item?.getAsFile();
                    if (file) {
                      e.preventDefault();
                      attachFile(file);
                    }
                  }}
                  placeholder={pendingMedia ? 'Didascalia (opzionale)…' : 'Scrivi un messaggio…'}
                  className="min-h-[44px] max-h-[200px] text-sm resize-none flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      submitComposer();
                    }
                  }}
                />

                <div className="flex items-end gap-0.5 shrink-0">
                  <Button
                    size="icon"
                    className="h-11 w-11 rounded-r-none"
                    onClick={submitComposer}
                    disabled={(!draft.trim() && !pendingMedia) || sendMutation.isPending || uploadMutation.isPending || !status?.connected}
                  >
                    {(sendMutation.isPending || uploadMutation.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        className="h-11 w-7 rounded-l-none border-l border-primary-foreground/30 px-1"
                        title="Opzioni invio"
                        disabled={!status?.connected}
                      >
                        <Clock className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="top">
                      <DropdownMenuItem
                        onClick={() => setScheduleDialogOpen(true)}
                        disabled={!draft.trim() || Boolean(pendingMedia)}
                      >
                        <Clock className="h-3.5 w-3.5 mr-2" /> Pianifica invio…
                      </DropdownMenuItem>
                      {selectedConv && (selectedConv.scheduled_pending ?? 0) > 0 && (
                        <DropdownMenuItem onClick={() => setScheduleListOpen(true)}>
                          <Inbox className="h-3.5 w-3.5 mr-2" /> Programmati ({selectedConv.scheduled_pending})
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* ============================== DIALOGS ============================== */}
      <AlertDialog open={Boolean(confirmDeleteId)} onOpenChange={(o) => !o && setConfirmDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminare la conversazione?</AlertDialogTitle>
            <AlertDialogDescription>
              La chat e tutti i messaggi verranno rimossi dall'inbox admin. La conversazione resta intatta sul telefono — non avvisa il contatto.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmDeleteId && deleteMutation.mutate(confirmDeleteId)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Elimina
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {selectedConv && (
        <CreateLeadDialog
          open={createLeadOpen}
          onOpenChange={setCreateLeadOpen}
          conv={selectedConv}
          onCreated={(leadId) => {
            linkMutation.mutate({ id: selectedConv.id, lead_id: leadId });
            setCreateLeadOpen(false);
          }}
        />
      )}

      {selectedConv && (
        <LinkCustomerDialog
          open={linkCustomerOpen}
          onOpenChange={setLinkCustomerOpen}
          onPick={(customerId) => {
            linkMutation.mutate({ id: selectedConv.id, customer_id: customerId });
            setLinkCustomerOpen(false);
          }}
        />
      )}

      {selectedConv && (selectedConv.customer_id || selectedConv.lead_id) && (
        <CustomerPanel
          open={panelOpen}
          onOpenChange={setPanelOpen}
          customerId={selectedConv.customer_id}
          leadId={selectedConv.lead_id}
        />
      )}

      {selectedConv && (
        <TextEditorDialog
          open={noteDialogOpen}
          onOpenChange={setNoteDialogOpen}
          title="Nota interna"
          description="Visibile solo nel gestionale. Non viene inviata al contatto."
          initialValue={selectedConv.internal_note || ''}
          onSave={(value) => {
            noteMutation.mutate({ id: selectedConv.id, internal_note: value.trim() ? value : null });
            setNoteDialogOpen(false);
          }}
        />
      )}

      {selectedConv && (
        <TextEditorDialog
          open={aiInstructionsDialogOpen}
          onOpenChange={setAiInstructionsDialogOpen}
          title="Istruzioni AI per questa conversazione"
          description={`Suggerimenti che modificano il comportamento dell'AI solo per questo contatto. Esempio: "Scrive in dialetto, rispondi in italiano standard formale".`}
          initialValue={selectedConv.ai_instructions || ''}
          onSave={(value) => {
            aiInstructionsMutation.mutate({ id: selectedConv.id, ai_instructions: value.trim() ? value : null });
            setAiInstructionsDialogOpen(false);
          }}
        />
      )}

      {selectedConv && (
        <TagsDialog
          open={tagsDialogOpen}
          onOpenChange={setTagsDialogOpen}
          initialTags={selectedConv.tags || []}
          onSave={(tags) => {
            tagsMutation.mutate({ id: selectedConv.id, tags });
            setTagsDialogOpen(false);
          }}
        />
      )}

      {selectedConv && (
        <ScheduleDialog
          open={scheduleDialogOpen}
          onOpenChange={setScheduleDialogOpen}
          initialBody={draft}
          onSubmit={(body, sendAt) => scheduleMutation.mutate({ id: selectedConv.id, body, send_at: sendAt })}
          pending={scheduleMutation.isPending}
        />
      )}

      {selectedConv && (
        <ScheduleListDialog
          open={scheduleListOpen}
          onOpenChange={setScheduleListOpen}
          conversationId={selectedConv.id}
          onCancel={(id) => cancelScheduleMutation.mutate(id)}
        />
      )}
    </div>
  );
}

// ---------- list row ----------

interface ConversationRowProps {
  conv: ConversationSummary;
  selected: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onMarkUnread: () => void;
  onDelete: () => void;
  onCreateLead: () => void;
  onLinkCustomer: () => void;
  onPinToggle: () => void;
}

function ConversationRow({ conv, selected, onSelect, onArchive, onMarkUnread, onDelete, onCreateLead, onLinkCustomer, onPinToggle }: ConversationRowProps) {
  const navigate = useNavigate();
  const name = displayNameOf(conv);
  const isLinked = Boolean(conv.customer_id || conv.lead_id);
  const muted = conv.muted_until ? new Date(conv.muted_until).getTime() > Date.now() : false;

  return (
    <div
      className={cn(
        'group w-full text-left px-3 py-2.5 border-b hover:bg-muted/50 transition-colors cursor-pointer flex items-start gap-3',
        selected && 'bg-muted',
        conv.pinned && !conv.archived && 'bg-amber-50/30 dark:bg-amber-950/10',
      )}
      onClick={onSelect}
    >
      {conv.is_group ? (
        <div className="w-9 h-9 rounded-full bg-muted-foreground/20 flex items-center justify-center shrink-0" aria-hidden>
          <Users className="h-4 w-4 text-muted-foreground" />
        </div>
      ) : (
        <Avatar name={name} seedKey={conv.phone || conv.chat_id} />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className={cn('text-sm truncate flex-1', conv.unread_count > 0 && 'font-semibold')}>{name}</p>
          {conv.status === 'waiting' && <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" title="In attesa" />}
          {conv.status === 'resolved' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" title="Risolta" />}
          {conv.pinned && <Pin className="h-3 w-3 text-amber-500 shrink-0" />}
          {muted && <BellOff className="h-3 w-3 text-muted-foreground shrink-0" />}
          {conv.ai_mode !== 'off' && (
            <Sparkles className={cn('h-3 w-3 shrink-0', conv.ai_mode === 'auto_reply' ? 'text-emerald-500' : 'text-violet-500')} />
          )}
        </div>
        {!conv.is_group && (
          <p className="text-[11px] text-muted-foreground truncate">
            {formatPhoneE164(conv.phone)}
            {conv.company_name && <span className="ml-1">· {conv.company_name}</span>}
          </p>
        )}
        <p className="text-xs text-muted-foreground truncate mt-0.5">{conv.last_message_preview || '—'}</p>
      </div>

      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className="text-[10px] text-muted-foreground">{formatRelativeTime(conv.last_message_at)}</span>
        <div className="flex items-center gap-1">
          {conv.unread_count > 0 && (
            <Badge variant="default" className="h-4 min-w-4 px-1 text-[10px]">{conv.unread_count}</Badge>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              {isLinked && (
                <DropdownMenuItem onClick={() => {
                  if (conv.customer_id) navigate(`/clienti/${conv.customer_id}`);
                  else if (conv.lead_id) navigate(`/pipeline?lead=${conv.lead_id}`);
                }}>
                  <UserIcon className="h-3.5 w-3.5 mr-2" /> Apri scheda
                </DropdownMenuItem>
              )}
              {!isLinked && !conv.is_group && (
                <>
                  <DropdownMenuItem onClick={onCreateLead}>
                    <UserPlus className="h-3.5 w-3.5 mr-2" /> Crea lead da questa chat
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onLinkCustomer}>
                    <Link2 className="h-3.5 w-3.5 mr-2" /> Collega a cliente esistente
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onPinToggle}>
                {conv.pinned ? <><PinOff className="h-3.5 w-3.5 mr-2" /> Rimuovi pin</> : <><Pin className="h-3.5 w-3.5 mr-2" /> Fissa in cima</>}
              </DropdownMenuItem>
              {conv.unread_count === 0 && (
                <DropdownMenuItem onClick={onMarkUnread}>
                  <MailOpen className="h-3.5 w-3.5 mr-2" /> Segna come non letto
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onArchive}>
                {conv.archived ? <><ArchiveRestore className="h-3.5 w-3.5 mr-2" /> Riporta in inbox</> : <><Archive className="h-3.5 w-3.5 mr-2" /> Archivia</>}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete} className="text-red-600 focus:text-red-600">
                <Trash2 className="h-3.5 w-3.5 mr-2" /> Elimina chat
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, label, count, unread }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number; unread?: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 flex items-center justify-center gap-1.5 rounded text-xs font-medium px-2 py-1.5 transition-colors',
        active ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      <span>{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className={cn('text-[10px] rounded px-1', unread ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/15 text-muted-foreground')}>
          {unread ? `${unread}/${count}` : count}
        </span>
      )}
    </button>
  );
}

// ---------- thread header ----------

interface ThreadHeaderProps {
  conv: ConversationSummary;
  connected: boolean;
  searchOpen: boolean;
  onToggleSearch: () => void;
  onTogglePanel: () => void;
  onBack: () => void;
  onAiModeChange: (mode: string) => void;
  onArchive: () => void;
  onDelete: () => void;
  onCreateLead: () => void;
  onLinkCustomer: () => void;
  onPinToggle: () => void;
  onMute: (minutes: number | null) => void;
  onStatusChange: (status: 'open' | 'waiting' | 'resolved') => void;
  onOpenNoteDialog: () => void;
  onOpenAiInstructionsDialog: () => void;
  onOpenTagsDialog: () => void;
  typingState?: 'composing' | 'recording' | 'paused' | null;
}

function ThreadHeader({
  conv, connected, searchOpen, onToggleSearch, onTogglePanel, onBack, onAiModeChange,
  onArchive, onDelete, onCreateLead, onLinkCustomer, onPinToggle, onMute,
  onStatusChange, onOpenNoteDialog, onOpenAiInstructionsDialog, onOpenTagsDialog,
  typingState,
}: ThreadHeaderProps) {
  const name = displayNameOf(conv);
  const linkedHref = conv.customer_id
    ? `/clienti/${conv.customer_id}`
    : conv.lead_id
      ? `/pipeline?lead=${conv.lead_id}`
      : null;
  const phoneHref = conv.phone ? `tel:+${conv.phone.replace(/\D/g, '')}` : null;
  const muted = conv.muted_until ? new Date(conv.muted_until).getTime() > Date.now() : false;
  const subtitle = typingState
    ? (typingState === 'recording' ? 'sta registrando un audio…' : typingState === 'paused' ? 'sta scrivendo…' : 'sta scrivendo…')
    : null;

  return (
    <div className="flex items-center gap-2 px-2 md:px-4 py-2 border-b bg-background">
      <Button variant="ghost" size="icon" className="h-9 w-9 md:hidden shrink-0" onClick={onBack} aria-label="Indietro">
        <ArrowLeft className="h-4 w-4" />
      </Button>

      {conv.is_group ? (
        <div className="w-9 h-9 rounded-full bg-muted-foreground/20 flex items-center justify-center shrink-0" aria-hidden>
          <Users className="h-4 w-4 text-muted-foreground" />
        </div>
      ) : (
        <Avatar name={name} seedKey={conv.phone || conv.chat_id} />
      )}

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold truncate flex items-center gap-2">
          {name}
          <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', connected ? 'bg-emerald-500' : 'bg-rose-500')} aria-label={connected ? 'connesso' : 'non connesso'} />
          {conv.pinned && <Pin className="h-3 w-3 text-amber-500 shrink-0" aria-label="bloccata in cima" />}
          {muted && <BellOff className="h-3 w-3 text-muted-foreground shrink-0" aria-label="silenziata" />}
          {conv.status === 'waiting' && (
            <Badge variant="outline" className="h-4 px-1 text-[10px] bg-amber-50 text-amber-700 border-amber-200">In attesa</Badge>
          )}
          {conv.status === 'resolved' && (
            <Badge variant="outline" className="h-4 px-1 text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Risolta</Badge>
          )}
          {conv.pref_operational === false && (
            <Badge variant="outline" className="h-4 px-1 text-[10px] bg-rose-50 text-rose-700 border-rose-200" title="Il contatto ha disattivato i messaggi non transazionali (STOP).">Opt-out</Badge>
          )}
          {conv.pref_operational !== false && conv.pref_marketing === false && (
            <Badge variant="outline" className="h-4 px-1 text-[10px] bg-amber-50 text-amber-700 border-amber-200" title="Niente messaggi marketing — solo operativi/transazionali.">No marketing</Badge>
          )}
        </p>
        <p className="text-xs truncate" style={{ color: subtitle ? 'rgb(16 185 129)' : undefined }}>
          {subtitle ? (
            <span className="italic">{subtitle}</span>
          ) : (
            <span className="text-muted-foreground">
              {!conv.is_group && formatPhoneE164(conv.phone)}
              {conv.company_name && <span className="ml-2">{conv.company_name}</span>}
            </span>
          )}
        </p>
        {conv.tags && conv.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {conv.tags.map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0">#{t}</Badge>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1">
        {linkedHref && (
          <Button variant="ghost" size="icon" className="h-9 w-9" title="Mostra scheda" onClick={onTogglePanel}>
            <UserIcon className="h-4 w-4" />
          </Button>
        )}
        {phoneHref && !conv.is_group && (
          <a href={phoneHref}>
            <Button variant="ghost" size="icon" className="h-9 w-9" title="Chiama" type="button">
              <Phone className="h-4 w-4" />
            </Button>
          </a>
        )}
        <Button
          variant={searchOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="h-9 w-9"
          title="Cerca nella chat"
          onClick={onToggleSearch}
        >
          <Search className="h-4 w-4" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9" title="Modalità AI">
              <Sparkles className={cn('h-4 w-4', conv.ai_mode === 'auto_reply' && 'text-emerald-500', conv.ai_mode === 'triage' && 'text-violet-500')} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Modalità AI</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onAiModeChange('off')}>
              {conv.ai_mode === 'off' && <Check className="h-3.5 w-3.5 mr-2" />} Off
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAiModeChange('triage')}>
              {conv.ai_mode === 'triage' && <Check className="h-3.5 w-3.5 mr-2" />} Triage (bozza)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAiModeChange('auto_reply')}>
              {conv.ai_mode === 'auto_reply' && <Check className="h-3.5 w-3.5 mr-2" />} Auto-reply
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9" title="Altre azioni">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Stato</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onStatusChange('open')}>
              {conv.status === 'open' && <Check className="h-3.5 w-3.5 mr-2" />} <CircleDot className="h-3.5 w-3.5 mr-2 text-blue-500" /> Aperta
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onStatusChange('waiting')}>
              {conv.status === 'waiting' && <Check className="h-3.5 w-3.5 mr-2" />} <Clock className="h-3.5 w-3.5 mr-2 text-amber-500" /> In attesa
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onStatusChange('resolved')}>
              {conv.status === 'resolved' && <Check className="h-3.5 w-3.5 mr-2" />} <Check className="h-3.5 w-3.5 mr-2 text-emerald-500" /> Risolta
            </DropdownMenuItem>
            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={onPinToggle}>
              {conv.pinned ? <><PinOff className="h-3.5 w-3.5 mr-2" /> Rimuovi pin</> : <><Pin className="h-3.5 w-3.5 mr-2" /> Fissa in cima</>}
            </DropdownMenuItem>

            {muted ? (
              <DropdownMenuItem onClick={() => onMute(null)}>
                <Bell className="h-3.5 w-3.5 mr-2" /> Riattiva notifiche
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onClick={() => onMute(60)}>
                  <BellOff className="h-3.5 w-3.5 mr-2" /> Silenzia 1 ora
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMute(60 * 8)}>
                  <BellOff className="h-3.5 w-3.5 mr-2" /> Silenzia 8 ore
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMute(60 * 24)}>
                  <BellOff className="h-3.5 w-3.5 mr-2" /> Silenzia 24 ore
                </DropdownMenuItem>
              </>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenNoteDialog}>
              <StickyNote className="h-3.5 w-3.5 mr-2" /> Nota interna {conv.internal_note && <span className="ml-auto text-[10px] text-muted-foreground">✓</span>}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenTagsDialog}>
              <Tag className="h-3.5 w-3.5 mr-2" /> Tag {conv.tags?.length ? <span className="ml-auto text-[10px] text-muted-foreground">{conv.tags.length}</span> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenAiInstructionsDialog}>
              <BrainCircuit className="h-3.5 w-3.5 mr-2" /> Istruzioni AI {conv.ai_instructions && <span className="ml-auto text-[10px] text-muted-foreground">✓</span>}
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            {!linkedHref && !conv.is_group && (
              <>
                <DropdownMenuItem onClick={onCreateLead}>
                  <UserPlus className="h-3.5 w-3.5 mr-2" /> Crea lead
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onLinkCustomer}>
                  <Link2 className="h-3.5 w-3.5 mr-2" /> Collega a cliente
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={onArchive}>
              {conv.archived ? <><ArchiveRestore className="h-3.5 w-3.5 mr-2" /> Riporta in inbox</> : <><Archive className="h-3.5 w-3.5 mr-2" /> Archivia</>}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} className="text-red-600 focus:text-red-600">
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Elimina chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------- thread search bar ----------

interface ThreadSearchBarProps {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  results: Array<{ id: string; body: string | null; created_at: string; direction: 'inbound' | 'outbound' }>;
  loading: boolean;
  onJump: (msgId: string) => void;
}

function ThreadSearchBar({ value, onChange, onClose, results, loading, onJump }: ThreadSearchBarProps) {
  return (
    <div className="border-b bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <Input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Cerca nella chat (≥2 caratteri)…"
          className="h-8 text-sm flex-1"
        />
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} title="Chiudi ricerca">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {value.trim().length >= 2 && (
        <div className="max-h-64 overflow-y-auto border-t">
          {loading ? (
            <div className="p-3 text-center text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" /> Ricerca…
            </div>
          ) : results.length === 0 ? (
            <p className="p-3 text-center text-xs text-muted-foreground">Nessun risultato</p>
          ) : (
            results.map((r) => (
              <button
                key={r.id}
                onClick={() => onJump(r.id)}
                className="w-full text-left px-3 py-2 hover:bg-muted text-xs border-b last:border-b-0"
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', r.direction === 'outbound' ? 'bg-emerald-500' : 'bg-blue-500')} />
                  <span className="text-muted-foreground">
                    {new Date(r.created_at).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="line-clamp-2">{r.body}</p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------- message bubble ----------

interface BubbleProps {
  message: WaMessage;
  allMessages: WaMessage[];
  isGroup: boolean;
  contactName: string;
  seedKey: string;
  isEditing: boolean;
  editingText: string;
  onEditChange: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onApprove: () => void;
  onDiscard: () => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
}

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏'];

function MessageBubble({
  message, allMessages, isGroup, contactName, seedKey,
  isEditing, editingText, onEditChange, onStartEdit, onCancelEdit, onSaveEdit, onApprove, onDiscard,
  onReply, onReact,
}: BubbleProps) {
  const m = message;
  const isOut = m.direction === 'outbound';
  const isDraft = m.ai_draft && !m.ai_draft_approved_at;
  const groupSender = isGroup && !isOut ? m.meta?.push_name || null : null;
  const reactions = Array.isArray(m.meta?.reactions) ? m.meta!.reactions : [];

  // Resolve the quoted message — if we have it loaded locally we render its
  // preview, otherwise we show a generic stub so the user knows this is a reply.
  const quoted = m.reply_to_external_id
    ? allMessages.find((x) => x.external_id === m.reply_to_external_id)
    : null;

  return (
    <div
      data-message-id={m.id}
      className={cn('group flex items-end gap-2 mb-1.5 rounded-md transition-shadow', isOut ? 'justify-end' : 'justify-start')}
    >
      {!isOut && (
        <div className="hidden md:block self-end shrink-0">
          <Avatar name={contactName} seedKey={seedKey} size={28} />
        </div>
      )}

      {/* Hover actions on the leading side of the bubble (Reply + React). */}
      {!isDraft && !isEditing && (
        <div
          className={cn(
            'flex items-center gap-0.5 self-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity',
            isOut ? 'order-first' : 'order-last',
          )}
        >
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onReply} title="Rispondi">
            <Reply className="h-3.5 w-3.5" />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7" title="Reagisci">
                <Smile className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-auto p-1 flex gap-0.5">
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  className="text-xl px-1.5 py-1 rounded hover:bg-muted"
                  onClick={() => onReact(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      )}

      <div className="relative">
        <div
          className={cn(
            'max-w-[78vw] md:max-w-[60ch] rounded-2xl px-3 py-1.5 text-sm shadow-sm',
            isOut
              ? isDraft
                ? 'bg-violet-100 border border-dashed border-violet-400 text-violet-900'
                : 'wa-bubble-out'
              : 'wa-bubble-in',
            // Add bottom space when reactions overlay would otherwise clip the timestamp.
            reactions.length > 0 && 'mb-3',
          )}
        >
          {groupSender && (
            <div className="text-[11px] font-medium mb-0.5" style={{ color: avatarColorFor(seedKey) }}>
              {groupSender}
            </div>
          )}

          {isDraft && (
            <div className="text-[10px] uppercase tracking-wide font-semibold text-violet-700 mb-1 flex items-center gap-1">
              <Sparkles className="h-3 w-3" /> Bozza AI
            </div>
          )}

          {/* Reply quote card — rendered inside the bubble like WhatsApp does. */}
          {quoted && (
            <div className="mb-1.5 border-l-4 border-primary bg-black/5 dark:bg-white/5 rounded-r px-2 py-1 text-xs">
              <p className="font-medium opacity-80">
                {quoted.direction === 'outbound' ? 'Tu' : (quoted.meta?.push_name || contactName)}
              </p>
              <p className="line-clamp-2 opacity-80">{quoted.body || `[${quoted.type}]`}</p>
            </div>
          )}
          {!quoted && m.reply_to_external_id && (
            <div className="mb-1.5 border-l-4 border-primary/40 bg-black/5 dark:bg-white/5 rounded-r px-2 py-1 text-xs italic opacity-70">
              Messaggio originale
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
              <MediaContent m={m} />
              <div className={cn('flex items-center gap-1 mt-0.5 text-[10px]', isOut ? 'justify-end wa-meta' : 'wa-meta')}>
                <span>{formatRelativeTime(m.created_at)}</span>
                {isOut && !isDraft && <AckTicks status={m.ack_status} />}
                {m.sender_kind === 'ai' && !isDraft && (
                  <span className="flex items-center gap-0.5"><Sparkles className="h-2.5 w-2.5" />AI</span>
                )}
              </div>
              {isDraft && (
                <div className="flex flex-wrap gap-1 mt-2">
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

        {/* Reactions overlay — bottom-right corner like WhatsApp. */}
        {reactions.length > 0 && (
          <div className={cn('absolute -bottom-2.5 flex gap-0.5 text-xs', isOut ? 'right-2' : 'left-2')}>
            {summarizeReactions(reactions).map((r) => (
              <span
                key={r.emoji}
                className="bg-background border rounded-full px-1.5 py-0.5 shadow-sm"
                title={r.from.join(', ') || undefined}
              >
                {r.emoji}{r.count > 1 && <span className="ml-0.5 text-[10px]">{r.count}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function summarizeReactions(reactions: Array<{ emoji: string; from: string | null; at: string }>) {
  const m = new Map<string, { emoji: string; count: number; from: string[] }>();
  for (const r of reactions) {
    if (!r.emoji) continue;
    const cur = m.get(r.emoji) || { emoji: r.emoji, count: 0, from: [] };
    cur.count += 1;
    if (r.from) cur.from.push(r.from);
    m.set(r.emoji, cur);
  }
  return Array.from(m.values());
}

function MediaContent({ m }: { m: WaMessage }) {
  if (m.type === 'text' || (m.type === 'reaction' && !m.media_url)) {
    return <p className="whitespace-pre-wrap break-words">{m.body || (m.type === 'reaction' ? '👍' : '')}</p>;
  }
  if (m.type === 'image' && m.media_url) {
    return (
      <div className="space-y-1">
        <img src={m.media_url} alt={m.body || 'immagine'} className="rounded-lg max-w-full max-h-80 object-contain" />
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
      </div>
    );
  }
  if (m.type === 'video' && m.media_url) {
    return (
      <div className="space-y-1">
        <video src={m.media_url} controls className="rounded-lg max-w-full max-h-80" />
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
      </div>
    );
  }
  if (m.type === 'audio' && m.media_url) {
    return (
      <div className="space-y-1">
        <audio src={m.media_url} controls className="w-full min-w-[200px]" />
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
      </div>
    );
  }
  if (m.type === 'document' && m.media_url) {
    const filename = m.meta?.filename || 'documento';
    const sizeKb = m.media_size ? `${(m.media_size / 1024).toFixed(0)} KB` : '';
    return (
      <a
        href={m.media_url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-black/5 dark:bg-white/5 rounded-md px-2 py-1.5 hover:bg-black/10 dark:hover:bg-white/10"
      >
        <FileText className="h-5 w-5 shrink-0 opacity-70" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{filename}</p>
          {(sizeKb || m.media_mime) && <p className="text-[11px] opacity-60">{[sizeKb, m.media_mime].filter(Boolean).join(' · ')}</p>}
        </div>
      </a>
    );
  }
  // Unknown / unsupported type — placeholder.
  return <p className="italic opacity-70">[{m.type}]{m.body ? ` ${m.body}` : ''}</p>;
}

// ---------- dialogs: create lead / link customer ----------

function CreateLeadDialog({ open, onOpenChange, conv, onCreated }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  conv: ConversationSummary;
  onCreated: (leadId: string) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');

  useEffect(() => {
    if (open) {
      setName(conv.contact_name || '');
      setEmail('');
      setCompany('');
    }
  }, [open, conv.contact_name]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = (await apiFetch('/api/leads', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim() || formatPhoneE164(conv.phone),
          phone: conv.phone,
          email: email.trim() || null,
          company: company.trim() || null,
          source: 'whatsapp',
        }),
      })) as { lead: { id: string } };
      return res.lead;
    },
    onSuccess: (lead) => {
      toast.success('Lead creato');
      onCreated(lead.id);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore creazione lead'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Crea lead da questa chat</DialogTitle>
          <DialogDescription>
            Il lead viene collegato automaticamente alla conversazione. Telefono pre-compilato da WhatsApp.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Nome</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={formatPhoneE164(conv.phone)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Email (opzionale)</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Azienda (opzionale)</label>
            <Input value={company} onChange={(e) => setCompany(e.target.value)} />
          </div>
          <div className="text-xs text-muted-foreground">
            Telefono: <span className="font-mono">{formatPhoneE164(conv.phone)}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Crea e collega'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkCustomerDialog({ open, onOpenChange, onPick }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (customerId: string) => void;
}) {
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery<{ customers: Array<{ id: string; contact_name: string | null; company_name: string | null; email: string | null }> }>({
    queryKey: ['customer-search', q],
    queryFn: () => apiFetch(`/api/customers?${new URLSearchParams({ search: q, limit: '20' })}`),
    enabled: open,
  });
  const customers = data?.customers ?? [];

  useEffect(() => { if (open) setQ(''); }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Collega a cliente esistente</DialogTitle>
          <DialogDescription>Cerca per nome, azienda o email.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca…" />
          <div className="max-h-72 overflow-y-auto border rounded-md">
            {isLoading ? (
              <div className="p-4 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline" /></div>
            ) : customers.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">Nessun risultato</div>
            ) : customers.map((c) => (
              <button
                key={c.id}
                onClick={() => onPick(c.id)}
                className="w-full text-left px-3 py-2 hover:bg-muted border-b last:border-b-0"
              >
                <div className="text-sm font-medium truncate">{c.contact_name || c.company_name || c.email || c.id}</div>
                {c.company_name && c.contact_name && (
                  <div className="text-xs text-muted-foreground truncate">{c.company_name}</div>
                )}
                {c.email && <div className="text-xs text-muted-foreground truncate">{c.email}</div>}
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- generic text editor dialog (note + AI instructions) ----------

function TextEditorDialog({
  open, onOpenChange, title, description, initialValue, onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  initialValue: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => { if (open) setValue(initialValue); }, [open, initialValue]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-h-[160px] text-sm"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button onClick={() => onSave(value)}>Salva</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- schedule dialog ----------

function ScheduleDialog({
  open, onOpenChange, initialBody, onSubmit, pending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialBody: string;
  onSubmit: (body: string, sendAtISO: string) => void;
  pending: boolean;
}) {
  // Default to "in 1 hour" — most schedule sends are short-term reminders.
  const defaultLocal = useMemo(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    // datetime-local wants `YYYY-MM-DDTHH:mm` in local time.
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const [body, setBody] = useState(initialBody);
  const [when, setWhen] = useState(defaultLocal);

  useEffect(() => { if (open) { setBody(initialBody); setWhen(defaultLocal); } }, [open, initialBody, defaultLocal]);

  function submit() {
    const text = body.trim();
    if (!text) { toast.error('Testo obbligatorio'); return; }
    const target = new Date(when);
    if (Number.isNaN(target.getTime())) { toast.error('Data non valida'); return; }
    onSubmit(text, target.toISOString());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pianifica messaggio</DialogTitle>
          <DialogDescription>
            Verrà inviato automaticamente alla data scelta. Lo trovi sotto "Programmati" finché non parte.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Quando</label>
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Testo</label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[100px] text-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Clock className="h-3.5 w-3.5 mr-1" />}
            Pianifica
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- schedule list dialog ----------

interface ScheduledRow {
  id: string;
  body: string;
  send_at: string;
  sent_at: string | null;
  error: string | null;
  attempts: number;
}

function ScheduleListDialog({
  open, onOpenChange, conversationId, onCancel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  conversationId: string;
  onCancel: (id: string) => void;
}) {
  const { data, isLoading } = useQuery<{ scheduled: ScheduledRow[] }>({
    queryKey: ['wa-scheduled', conversationId],
    queryFn: () => apiFetch(`/api/whatsapp-admin/conversations/${conversationId}/scheduled`),
    enabled: open,
  });
  const rows = data?.scheduled ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Messaggi pianificati</DialogTitle>
          <DialogDescription>I messaggi qui sotto verranno inviati alla data indicata. Puoi annullare quelli ancora in attesa.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {isLoading ? (
            <div className="p-3 text-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline" /></div>
          ) : rows.length === 0 ? (
            <p className="p-3 text-center text-sm text-muted-foreground italic">Nessun messaggio pianificato.</p>
          ) : rows.map((r) => {
            const sent = Boolean(r.sent_at);
            const failed = Boolean(r.error);
            return (
              <div key={r.id} className="border rounded-md p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs">
                    <Clock className="h-3 w-3 inline mr-1 opacity-60" />
                    <span className="font-mono">{new Date(r.send_at).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  {sent ? (
                    <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">inviato</Badge>
                  ) : failed ? (
                    <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-200">errore</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200">in attesa</Badge>
                  )}
                </div>
                <p className="text-sm mt-1 line-clamp-3">{r.body}</p>
                {failed && <p className="text-[11px] text-rose-600 mt-1">{r.error}</p>}
                {!sent && (
                  <div className="flex justify-end mt-1">
                    <Button size="sm" variant="ghost" onClick={() => onCancel(r.id)} className="h-7 text-xs">
                      <X className="h-3 w-3 mr-1" /> Annulla
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Chiudi</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- tags editor dialog ----------

function TagsDialog({
  open, onOpenChange, initialTags, onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialTags: string[];
  onSave: (tags: string[]) => void;
}) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [input, setInput] = useState('');
  useEffect(() => { if (open) { setTags(initialTags); setInput(''); } }, [open, initialTags]);

  function addTag(raw: string) {
    const t = raw.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) return;
    if (t.length > 40) return;
    setTags((arr) => [...arr, t]);
    setInput('');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tag conversazione</DialogTitle>
          <DialogDescription>Aggiungi etichette per filtrare e organizzare. Solo lettere/numeri, max 40 caratteri.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag(input);
              }
            }}
            placeholder="Aggiungi tag e premi Invio…"
          />
          <div className="flex flex-wrap gap-1.5 min-h-[2.5rem]">
            {tags.length === 0 ? (
              <span className="text-xs text-muted-foreground italic">Nessun tag</span>
            ) : tags.map((t) => (
              <Badge key={t} variant="secondary" className="text-xs gap-1">
                #{t}
                <button onClick={() => setTags((arr) => arr.filter((x) => x !== t))} className="hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button onClick={() => onSave(tags)}>Salva tag</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
