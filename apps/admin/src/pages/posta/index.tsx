import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Inbox, Send as SendIcon, Trash2, RefreshCw, Plus,
  Mail, Loader2, Reply, AlertCircle, Paperclip,
  Star, Megaphone, Bell, ShieldAlert, SlidersHorizontal,
  Download, History,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTopbar } from '@/hooks/use-topbar';
import { useSetAiEntityContext } from '@/hooks/use-ai-entity-context';
import { apiFetch } from '@/lib/api';
import { SetupWizard } from './setup-wizard';
import { ComposeDialog, type ComposePrefill } from './compose-dialog';
import { RulesDialog } from './rules-dialog';

interface Account {
  id: string;
  email: string;
  display_name: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  active: boolean;
  sent_folder: string | null;
}

type MailCategory = 'all' | 'importanti' | 'normali' | 'aggiornamenti' | 'marketing' | 'spam';

interface MessageSummary {
  id: string;
  from_addr: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: string | null;
  flags: string[];
  has_attachments: boolean;
  category: string;
}

interface MessagesResponse {
  messages: MessageSummary[];
  count: number;
  counts: Record<string, { count: number; unread: number }>;
}

interface FullMessage extends MessageSummary {
  to_addrs: Array<{ address: string; name: string }>;
  body_text: string | null;
  body_html: string | null;
  attachments: Array<{ filename: string; content_type: string; size_bytes: number }>;
  links: Array<{ id: string; entity_type: string; entity_id: string; auto: boolean }>;
}

interface FolderDef { id: string; label: string; icon: typeof Inbox }
function buildFolders(sentFolder: string | null | undefined): FolderDef[] {
  return [
    { id: 'INBOX', label: 'In arrivo', icon: Inbox },
    { id: sentFolder || 'Sent', label: 'Inviati', icon: SendIcon },
    { id: 'Trash', label: 'Cestino', icon: Trash2 },
  ];
}

const CATEGORIES: Array<{ id: MailCategory; label: string; icon: typeof Inbox; color: string }> = [
  { id: 'all', label: 'Tutti', icon: Inbox, color: 'text-muted-foreground' },
  { id: 'importanti', label: 'Importanti', icon: Star, color: 'text-amber-500' },
  { id: 'normali', label: 'Normali', icon: Mail, color: 'text-blue-500' },
  { id: 'aggiornamenti', label: 'Aggiornamenti', icon: Bell, color: 'text-violet-500' },
  { id: 'marketing', label: 'Marketing', icon: Megaphone, color: 'text-emerald-500' },
  { id: 'spam', label: 'Spam', icon: ShieldAlert, color: 'text-red-500' },
];

function formatDateTime(raw: string | null): string {
  if (!raw) return '';
  const d = new Date(raw);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (d >= today) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (diffDays < 7) return d.toLocaleDateString('it-IT', { weekday: 'short' });
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

export default function PostaPage() {
  useTopbar({ title: 'Posta', subtitle: 'Email integrata' });

  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const draftParam = searchParams.get('draft');
  const [folder, setFolder] = useState<string>('INBOX');
  const [category, setCategory] = useState<MailCategory>('importanti');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [composePrefill, setComposePrefill] = useState<ComposePrefill | undefined>();
  const [rulesOpen, setRulesOpen] = useState(false);

  const { data: accountsData, isLoading: accountsLoading } = useQuery<{ accounts: Account[] }>({
    queryKey: ['mail-accounts'],
    queryFn: () => apiFetch('/api/mail/accounts'),
  });
  const accounts = accountsData?.accounts ?? [];
  const account = accounts[0];

  const { data: msgsData, isLoading: msgsLoading } = useQuery<MessagesResponse>({
    queryKey: ['mail-messages', account?.id, folder, category, search],
    queryFn: () => {
      const qs = new URLSearchParams({
        account_id: account!.id,
        folder,
        limit: '100',
      });
      if (category !== 'all') qs.set('category', category);
      if (search) qs.set('search', search);
      return apiFetch(`/api/mail/messages?${qs.toString()}`);
    },
    enabled: !!account?.id,
    refetchInterval: 60_000,
  });
  const messages = msgsData?.messages ?? [];
  const categoryCounts = msgsData?.counts ?? {};

  const { data: fullMsgRaw } = useQuery<{ message: FullMessage }>({
    queryKey: ['mail-message', selectedId],
    queryFn: () => apiFetch(`/api/mail/messages/${selectedId}`),
    enabled: !!selectedId,
  });

  // Normalize jsonb fields that may come back as strings from some drivers
  const fullMsg = useMemo(() => {
    if (!fullMsgRaw?.message) return fullMsgRaw;
    const m = fullMsgRaw.message;
    const asArray = <T,>(v: unknown): T[] => {
      if (Array.isArray(v)) return v as T[];
      if (typeof v === 'string') {
        try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
      }
      return [];
    };
    return {
      message: {
        ...m,
        to_addrs: asArray<{ address: string; name: string }>(m.to_addrs),
        attachments: asArray<{ filename: string; content_type: string; size_bytes: number }>(m.attachments),
        links: asArray<{ id: string; entity_type: string; entity_id: string; auto: boolean }>(m.links),
        flags: asArray<string>(m.flags),
      },
    };
  }, [fullMsgRaw]);

  const syncMutation = useMutation({
    mutationFn: async (silent: boolean = false) => {
      const res = await apiFetch(`/api/mail/sync/${account!.id}`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'latest', limit: 100 }),
      });
      return { res, silent };
    },
    onSuccess: ({ res, silent }: { res: any; silent: boolean }) => {
      const fetched = res?.results?.[0]?.fetched ?? 0;
      if (!silent) toast.success(fetched > 0 ? `${fetched} nuove email` : 'Casella aggiornata');
      queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
    },
    onError: (err, silent) => {
      if (!silent) toast.error(`Sync fallita: ${(err as Error).message}`);
    },
  });

  const importMutation = useMutation({
    mutationFn: async (opts: { mode: 'older' | 'all'; limit?: number }) => {
      return apiFetch(`/api/mail/sync/${account!.id}`, {
        method: 'POST',
        body: JSON.stringify({ mode: opts.mode, limit: opts.limit ?? 500 }),
      });
    },
    onSuccess: (res: any) => {
      const r = res?.results?.[0];
      if (!r) return;
      toast.success(
        `${r.fetched} email importate · ${r.cachedAfter}/${r.serverTotal} totali in cache`,
        { duration: 6000 },
      );
      queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
    },
    onError: (err) => toast.error(`Import fallito: ${(err as Error).message}`),
  });

  // Auto-sync while /posta is open: first run on mount, then every 3 min silent
  useEffect(() => {
    if (!account?.id) return;
    syncMutation.mutate(true);
    const interval = window.setInterval(() => {
      syncMutation.mutate(true);
    }, 3 * 60 * 1000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  const markReadMutation = useMutation({
    mutationFn: async (id: string) =>
      apiFetch(`/api/mail/messages/${id}/flags`, {
        method: 'PATCH',
        body: JSON.stringify({ add: ['\\Seen'] }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
      queryClient.invalidateQueries({ queryKey: ['mail-message'] });
    },
  });

  // Auto-mark as read once the message body has loaded.
  // Depending on selectedId alone misfires: fullMsg arrives async, so the
  // first run sees fullMsg=undefined and the early return makes the effect
  // skip forever for that selection.
  const fullMsgId = fullMsg?.message?.id;
  const fullMsgFlags = fullMsg?.message?.flags;
  useEffect(() => {
    if (!fullMsgId || !fullMsgFlags) return;
    if (!fullMsgFlags.includes('\\Seen')) markReadMutation.mutate(fullMsgId);
    // markReadMutation is stable from useMutation; we intentionally exclude it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullMsgId, fullMsgFlags]);

  // Deep-link: ?draft=<id> → fetch the AI/manual draft and pre-fill Compose
  useEffect(() => {
    if (!draftParam || !account) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/mail/drafts/${draftParam}`);
        if (cancelled || !res?.draft) return;
        const d = res.draft;
        const to = Array.isArray(d.to_addrs) ? d.to_addrs.join(', ') : '';
        const cc = Array.isArray(d.cc_addrs) ? d.cc_addrs.join(', ') : '';
        setComposePrefill({
          to,
          cc: cc || undefined,
          subject: d.subject || '',
          body: d.body || '',
          in_reply_to: d.in_reply_to_msgid || undefined,
          draft_id: d.id,
        });
        setComposeOpen(true);
      } catch (err) {
        toast.error(`Bozza non trovata: ${(err as Error).message}`);
      } finally {
        // Remove the param from URL so re-opening doesn't re-trigger
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete('draft');
          return next;
        }, { replace: true });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftParam, account?.id]);

  // AI context: when a mail is selected, expose it to the AI
  useSetAiEntityContext(
    fullMsg?.message
      ? {
          kind: 'email',
          id: fullMsg.message.id,
          title: fullMsg.message.subject || '(senza oggetto)',
          summary: `da ${fullMsg.message.from_addr ?? '—'}, ${formatDateTime(fullMsg.message.received_at)}`,
        }
      : null,
  );

  const handleReply = () => {
    if (!fullMsg?.message) return;
    const m = fullMsg.message;
    setComposePrefill({
      to: m.from_addr ?? '',
      subject: m.subject?.startsWith('Re:') ? m.subject : `Re: ${m.subject || ''}`,
      body: `\n\n---\nIl ${formatDateTime(m.received_at)} ${m.from_addr} ha scritto:\n${(m.body_text || '').slice(0, 500)}`,
      in_reply_to: m.id,
    });
    setComposeOpen(true);
  };

  const unread = useMemo(
    () => messages.filter((m) => !m.flags.includes('\\Seen')).length,
    [messages],
  );

  // States: loading, no account, ready
  if (accountsLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (accounts.length === 0) {
    return <SetupWizard onSaved={() => queryClient.invalidateQueries({ queryKey: ['mail-accounts'] })} />;
  }

  return (
    <div className="h-[calc(100vh-7rem)] flex rounded-lg border bg-card overflow-hidden">
      {/* Left: folders + categories + account */}
      <aside className="w-56 border-r bg-muted/30 flex flex-col shrink-0">
        <div className="px-3 py-3 border-b">
          <Button
            size="sm"
            className="w-full gap-2"
            onClick={() => {
              setComposePrefill(undefined);
              setComposeOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Nuovo
          </Button>
        </div>
        <nav className="flex-1 overflow-auto py-2">
          {buildFolders(account.sent_folder).map((f) => {
            const Icon = f.icon;
            const active = folder === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => { setFolder(f.id); setSelectedId(null); }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors',
                  active ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-foreground/5',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="flex-1">{f.label}</span>
                {f.id === 'INBOX' && unread > 0 && (
                  <span className="text-[10px] bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">{unread}</span>
                )}
              </button>
            );
          })}

          {folder === 'INBOX' && (
            <>
              <div className="mt-3 mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Categorie
              </div>
              {CATEGORIES.map((cat) => {
                const Icon = cat.icon;
                const active = category === cat.id;
                const info = cat.id === 'all'
                  ? { count: Object.values(categoryCounts).reduce((s, c) => s + c.count, 0), unread: Object.values(categoryCounts).reduce((s, c) => s + c.unread, 0) }
                  : categoryCounts[cat.id] ?? { count: 0, unread: 0 };
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => { setCategory(cat.id); setSelectedId(null); }}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors',
                      active ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-foreground/5',
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5', active ? '' : cat.color)} />
                    <span className="flex-1">{cat.label}</span>
                    {info.unread > 0 ? (
                      <span className="text-[10px] bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 min-w-[16px] text-center">
                        {info.unread}
                      </span>
                    ) : info.count > 0 ? (
                      <span className="text-[10px] text-muted-foreground/60">{info.count}</span>
                    ) : null}
                  </button>
                );
              })}
            </>
          )}
        </nav>
        <div className="border-t">
          <button
            type="button"
            onClick={() => setRulesOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Regole filtraggio
          </button>
          <div className="px-3 pb-2 text-[10px] text-muted-foreground truncate border-t" title={account.email}>
            <div className="pt-1.5">{account.email}</div>
            {account.last_sync_at && (
              <div className="mt-0.5">Sync: {new Date(account.last_sync_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</div>
            )}
            {account.last_error && (
              <div className="mt-0.5 flex items-center gap-1 text-red-500" title={account.last_error}>
                <AlertCircle className="h-3 w-3" /> Errore sync
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Center: message list */}
      <div className="w-96 border-r flex flex-col shrink-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Input
            placeholder="Cerca nelle email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs"
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate(false)}
            title="Sincronizza ora"
          >
            <RefreshCw className={cn('h-4 w-4', syncMutation.isPending && 'animate-spin')} />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                disabled={importMutation.isPending}
                title="Importa mail più vecchie"
              >
                {importMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <History className="h-4 w-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Importa dal server
              </DropdownMenuLabel>
              <DropdownMenuItem onClick={() => importMutation.mutate({ mode: 'older', limit: 200 })}>
                <History className="h-3.5 w-3.5 mr-2" />
                200 più vecchie
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => importMutation.mutate({ mode: 'older', limit: 500 })}>
                <History className="h-3.5 w-3.5 mr-2" />
                500 più vecchie
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => importMutation.mutate({ mode: 'older', limit: 1000 })}>
                <History className="h-3.5 w-3.5 mr-2" />
                1000 più vecchie
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => importMutation.mutate({ mode: 'all', limit: 5000 })}>
                <Download className="h-3.5 w-3.5 mr-2" />
                Tutte le mancanti (fino a 5000)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex-1 overflow-auto">
          {msgsLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : messages.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <Mail className="h-8 w-8 mx-auto mb-3 opacity-40" />
              {folder === 'INBOX'
                ? 'Nessuna email. Clicca Sync per caricare la casella.'
                : `Cartella ${folder} vuota.`}
            </div>
          ) : (
            messages.map((m) => {
              const unread = !m.flags.includes('\\Seen');
              const selected = selectedId === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedId(m.id)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 border-b border-border/40 transition-colors',
                    selected ? 'bg-primary/10' : 'hover:bg-muted/50',
                  )}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={cn('flex-1 text-xs truncate', unread ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                      {m.from_name || m.from_addr || '—'}
                    </span>
                    {unread && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />}
                    <span className="text-[10px] text-muted-foreground shrink-0">{formatDateTime(m.received_at)}</span>
                  </div>
                  <div className={cn('text-xs truncate', unread ? 'font-medium' : '')}>
                    {m.subject || '(senza oggetto)'}
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    {m.has_attachments && <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />}
                    <div className="text-[11px] text-muted-foreground truncate flex-1">{m.snippet || ''}</div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right: reader */}
      <div className="flex-1 flex flex-col min-w-0">
        {!fullMsg?.message ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Seleziona un messaggio per leggerlo.
          </div>
        ) : (
          <>
            <div className="border-b px-4 py-3">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <h2 className="text-base font-semibold truncate">{fullMsg.message.subject || '(senza oggetto)'}</h2>
                  <div className="flex items-baseline gap-2 text-xs text-muted-foreground mt-1">
                    <span className="text-foreground font-medium">{fullMsg.message.from_name || fullMsg.message.from_addr}</span>
                    {fullMsg.message.from_name && <span className="text-muted-foreground">&lt;{fullMsg.message.from_addr}&gt;</span>}
                    <span className="ml-auto shrink-0">{fullMsg.message.received_at ? new Date(fullMsg.message.received_at).toLocaleString('it-IT') : ''}</span>
                  </div>
                  {fullMsg.message.to_addrs?.length > 0 && (
                    <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                      A: {fullMsg.message.to_addrs.map((t) => t.name || t.address).join(', ')}
                    </div>
                  )}
                  {fullMsg.message.links.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {fullMsg.message.links.map((l) => (
                        <span key={l.id} className="text-[10px] rounded bg-primary/10 text-primary px-1.5 py-0.5">
                          {l.entity_type} {l.auto ? '(auto)' : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={handleReply}>
                  <Reply className="h-3.5 w-3.5" /> Rispondi
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {fullMsg.message.body_html ? (
                <iframe
                  title="Email body"
                  srcDoc={`<!DOCTYPE html><html><head><base target="_blank"><style>
                    body { font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 16px; color: #111; }
                    img { max-width: 100%; height: auto; }
                    a { color: #2563eb; }
                    pre, code { background: #f4f4f5; padding: 2px 4px; border-radius: 3px; }
                  </style></head><body>${fullMsg.message.body_html}</body></html>`}
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  className="w-full h-full border-0 bg-white"
                />
              ) : (
                <pre className="whitespace-pre-wrap text-sm p-4 font-sans">{fullMsg.message.body_text || '(nessun contenuto)'}</pre>
              )}
            </div>

            {fullMsg.message.attachments.length > 0 && (
              <div className="border-t px-4 py-2 flex flex-wrap gap-2">
                {fullMsg.message.attachments.map((a, i) => (
                  <div key={i} className="inline-flex items-center gap-2 rounded border px-2 py-1 text-xs text-muted-foreground">
                    <Paperclip className="h-3 w-3" />
                    {a.filename}
                    <span className="text-[10px]">{Math.ceil(a.size_bytes / 1024)} KB</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {account && (
        <ComposeDialog
          open={composeOpen}
          onClose={() => setComposeOpen(false)}
          accountId={account.id}
          prefill={composePrefill}
        />
      )}

      <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </div>
  );
}
