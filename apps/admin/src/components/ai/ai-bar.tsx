import { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import Markdown from 'react-markdown';
import { Send, Sparkles, X, Minimize2, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { useAiEntityContext, useClearAiEntityContext } from '@/hooks/use-ai-entity-context';
import { useAiPanel } from '@/hooks/use-ai-panel';
import { useI18n } from '@/hooks/use-i18n';

interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pendingAction?: PendingAction | null;
  actionState?: 'pending' | 'running' | 'done' | 'cancelled';
}

const CONTEXT_BY_PREFIX: Array<readonly [string, string]> = [
  ['/pipeline', 'pipeline'],
  ['/clienti', 'clienti'],
  ['/contatti', 'contatti'],
  ['/preventivi', 'preventivi'],
  ['/progetti', 'progetti'],
  ['/calendario', 'calendario'],
  ['/time-tracking', 'time-tracking'],
  ['/blog', 'blog'],
  ['/portfolio', 'portfolio'],
  ['/cms', 'cms'],
  ['/servizi', 'servizi'],
  ['/domini', 'domini'],
  ['/fatturazione', 'fatturazione'],
  ['/spese', 'spese'],
  ['/tasse', 'tasse'],
  ['/firme', 'firme'],
  ['/analytics', 'analytics'],
  ['/oggi', 'oggi'],
  ['/posta', 'posta'],
  ['/whatsapp', 'whatsapp'],
  ['/marketing', 'marketing'],
  ['/privacy', 'privacy'],
  ['/impostazioni', 'impostazioni'],
  ['/workflows', 'workflows'],
  ['/brain', 'brain'],
  ['/notes', 'notes'],
  ['/collaboratori', 'collaboratori'],
  ['/boards', 'boards'],
];

function getPageContext(pathname: string): string {
  if (pathname === '/') return 'dashboard';
  for (const [prefix, ctx] of CONTEXT_BY_PREFIX) {
    if (pathname.startsWith(prefix)) return ctx;
  }
  return 'admin';
}

const SUGGESTIONS: Record<string, string[]> = {
  dashboard: ['ai.suggestions.dashboard.summary', 'ai.suggestions.dashboard.pipeline', 'ai.suggestions.dashboard.revenue'],
  pipeline: ['ai.suggestions.pipeline.followups', 'ai.suggestions.pipeline.price'],
  default: ['ai.suggestions.default.help', 'ai.suggestions.default.email'],
};

export function AiBar() {
  const { t } = useI18n();
  const location = useLocation();
  const [expanded, setExpanded] = useState(false);
  // Open-state is shared (sidebar trigger + ⌘J + FAB all drive it). At rest the
  // panel is closed; on desktop nothing is shown (the sidebar holds the trigger),
  // on mobile a FAB remains. `collapsed` mirrors the legacy local flag.
  const { open, setOpen } = useAiPanel();
  const collapsed = !open;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pageContext = getPageContext(location.pathname);
  const entity = useAiEntityContext();
  const clearEntity = useClearAiEntityContext();
  const context = entity
    ? `${pageContext} · ${entity.kind}: ${entity.title}${entity.summary ? ` (${entity.summary})` : ''}`
    : pageContext;
  const suggestions = SUGGESTIONS[pageContext] || SUGGESTIONS.default;

  // ⌘J shortcut — closed → open full chat; otherwise toggle the chat panel.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setExpanded(true);
        } else {
          setExpanded((v) => !v);
        }
      }
      if (e.key === 'Escape') {
        if (expanded) setExpanded(false);
        else if (open) setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [expanded, open, setOpen]);

  useEffect(() => {
    if (expanded && !collapsed) setTimeout(() => inputRef.current?.focus(), 100);
  }, [expanded, collapsed]);

  const openFromFab = () => {
    setOpen(true);
    setExpanded(true);
  };

  const collapseToFab = () => {
    setOpen(false);
    setExpanded(false);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || isLoading) return;

    setMessages((prev) => [...prev, { id: Date.now().toString(), role: 'user', content: msg }]);
    setInput('');
    setIsLoading(true);
    if (!expanded) setExpanded(true);

    try {
      const res = await apiFetch('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: msg,
          context,
          entity: entity ?? undefined,
          history: messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const pending: PendingAction | null = Array.isArray(res.pending_actions) && res.pending_actions.length > 0
        ? res.pending_actions[0]
        : null;
      setMessages((prev) => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: res.reply || t('ai.noReply'),
        pendingAction: pending,
        actionState: pending ? 'pending' : undefined,
      }]);
    } catch {
      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), role: 'assistant', content: t('ai.connectionError') }]);
    } finally {
      setIsLoading(false);
    }
  };

  // "Esegui" button — runs exactly the previewed tool+args via the dedicated
  // endpoint (no second LLM round-trip), so the user never has to re-type "sì".
  const runAction = async (messageId: string, action: PendingAction) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, actionState: 'running' } : m)));
    try {
      const res = await apiFetch('/api/ai/execute-action', {
        method: 'POST',
        body: JSON.stringify({ tool: action.tool, args: action.args }),
      });
      // ok:false (rate limit / tool error) → keep the button available to retry.
      setMessages((prev) => [
        ...prev.map((m) => (m.id === messageId ? { ...m, actionState: res.ok ? ('done' as const) : ('pending' as const) } : m)),
        { id: (Date.now() + 1).toString(), role: 'assistant', content: res.reply || t('ai.noReply') },
      ]);
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, actionState: 'pending' } : m)));
      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), role: 'assistant', content: t('ai.connectionError') }]);
    }
  };

  const cancelAction = (messageId: string) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, actionState: 'cancelled' } : m)));
  };

  // Closed state: mobile keeps a FAB; desktop shows nothing (the sidebar holds
  // the trigger) so the assistant never overlaps page content at rest.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={openFromFab}
        className="lg:hidden fixed bottom-4 left-4 h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl active:scale-95 transition-all flex items-center justify-center z-[var(--z-ai-bubble)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t('ai.openAssistant')}
      >
        <Sparkles className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-4 left-4 flex flex-col items-start gap-2 z-[var(--z-ai-bubble)]"
      style={{ maxWidth: '420px', width: 'min(420px, calc(100vw - 2rem))' }}
    >

      {/* Chat panel (expands upward). max-h with dvh prevents covering more
          than ~70% of viewport on phone landscape. */}
      <div
        className={cn(
          'w-full ai-bubble-island overflow-hidden transition-all duration-300 ease-out',
          expanded
            ? 'max-h-[min(70dvh,460px)] opacity-100'
            : 'max-h-0 opacity-0 pointer-events-none',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-11 border-b">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold">AI Assistant</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 lg:h-7 lg:w-7"
              onClick={() => setMessages([])}
              aria-label={t('ai.clear')}
              title={t('ai.clear')}
            >
              <X className="h-4 w-4 lg:h-3 lg:w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 lg:h-7 lg:w-7"
              onClick={collapseToFab}
              aria-label={t('ai.minimize')}
              title={t('ai.minimize')}
            >
              <Minimize2 className="h-4 w-4 lg:h-3 lg:w-3" />
            </Button>
          </div>
        </div>

        {/* Entity context pill */}
        {entity && (
          <div className="border-b bg-primary/5 px-4 py-1.5 flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground shrink-0 uppercase tracking-wide">{t('ai.context')}</span>
            <span className="text-xs font-medium text-foreground flex-1 truncate">
              {entity.kind} · {entity.title}
            </span>
            <button
              type="button"
              onClick={clearEntity}
              className="text-muted-foreground hover:text-foreground p-0.5"
              title={t('ai.removeContext')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="overflow-y-auto p-3 space-y-2.5 scrollbar-thin" style={{ height: '340px' }}>
          {messages.length === 0 && (
            <div className="text-center pt-12">
              <Sparkles className="h-7 w-7 text-primary/15 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">{t('ai.empty')}</p>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn(
                'max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-br-sm'
                  : 'bg-muted rounded-bl-sm',
              )}>
                {msg.role === 'assistant' ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:mb-1 [&>ul]:mb-1 [&>ul]:pl-4 [&>li]:text-[13px] [&>p]:text-[13px] [&_strong]:text-primary">
                    <Markdown>{msg.content}</Markdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                )}

                {/* Action confirmation — replaces re-typing "sì": one click runs
                    exactly the previewed tool+args. */}
                {msg.role === 'assistant' && msg.pendingAction && (
                  <div className="mt-2 flex items-center gap-2">
                    {msg.actionState === 'done' ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-primary">
                        <Check className="h-3.5 w-3.5" /> {msg.pendingAction.label}
                      </span>
                    ) : msg.actionState === 'cancelled' ? (
                      <span className="text-[12px] text-muted-foreground">{t('ai.actionCancelled')}</span>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          className="h-7 px-3 text-xs rounded-full"
                          disabled={msg.actionState === 'running'}
                          onClick={() => runAction(msg.id, msg.pendingAction!)}
                        >
                          {msg.actionState === 'running' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                          {t('ai.execute')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-3 text-xs rounded-full"
                          disabled={msg.actionState === 'running'}
                          onClick={() => cancelAction(msg.id)}
                        >
                          {t('ai.cancel')}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-2xl rounded-bl-sm px-3 py-2.5">
                <div className="flex gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Suggestion chips. min-h-9 / px-3 / text-xs respects the 8dp grid +
          44px tap rule (chip is short but still 36px which is acceptable for
          secondary actions per Material guidance; primary actions get 44). */}
      {!expanded && (
        <div className="flex gap-2 justify-start flex-wrap">
          {suggestions.map((s) => (
            <button
              key={s}
              className="min-h-9 inline-flex items-center text-xs rounded-full bg-card border border-border/50 px-3 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shadow-sm"
              onClick={() => sendMessage(t(s))}
            >
              {t(s)}
            </button>
          ))}
        </div>
      )}

      {/* Input pill (always visible). Mobile: 56px high pill + 16px input
          font to avoid iOS auto-zoom. Desktop shrinks both back down.
          The leading Sparkles is clickable to collapse back to FAB. */}
      <form
        onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
        className="w-full ai-bubble-island flex items-center gap-2 px-3 h-14 lg:h-11"
      >
        <button
          type="button"
          onClick={collapseToFab}
          aria-label={t('ai.minimize')}
          title={t('ai.minimize')}
          className="h-11 w-11 lg:h-7 lg:w-7 inline-flex items-center justify-center rounded-full text-primary shrink-0 hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Sparkles className="h-4 w-4" />
        </button>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => messages.length > 0 && !expanded && setExpanded(true)}
          placeholder={t('ai.placeholder')}
          className="flex-1 bg-transparent text-base lg:text-sm outline-none placeholder:text-muted-foreground/40"
          disabled={isLoading}
        />
        {input.trim() ? (
          <Button
            type="submit"
            size="icon"
            className="h-11 w-11 lg:h-7 lg:w-7 rounded-full shrink-0"
            disabled={isLoading}
            aria-label="Invia"
          >
            <Send className="h-4 w-4 lg:h-3.5 lg:w-3.5" />
          </Button>
        ) : (
          <kbd className="hidden sm:inline-flex pointer-events-none h-5 select-none items-center rounded border bg-muted/50 px-1.5 font-mono text-[10px] text-muted-foreground/40">
            ⌘J
          </kbd>
        )}
      </form>
    </div>
  );
}
