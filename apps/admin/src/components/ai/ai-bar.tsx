import { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import Markdown from 'react-markdown';
import { Send, Sparkles, X, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { useAiEntityContext, useClearAiEntityContext } from '@/hooks/use-ai-entity-context';
import { useI18n } from '@/hooks/use-i18n';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const CONTEXT_BY_PREFIX: Array<readonly [string, string]> = [
  ['/pipeline', 'pipeline'],
  ['/clienti', 'clienti'],
  ['/preventivi', 'preventivi'],
  ['/progetti', 'progetti'],
  ['/calendario', 'calendario'],
  ['/blog', 'blog'],
  ['/portfolio', 'portfolio'],
  ['/domini', 'domini'],
  ['/fatturazione', 'fatturazione'],
  ['/analytics', 'analytics'],
  ['/oggi', 'oggi'],
  ['/posta', 'posta'],
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
  // Mobile-only collapsed state. On phones the full pill+suggestions stack
  // takes too much space over content, so by default we render just a FAB.
  // Desktop ignores this and always renders the full bar.
  // Collapsable everywhere. On mobile we start collapsed because the bar
  // covers content; on desktop we start expanded (productivity assist) but
  // the user can minimize to a FAB when it gets in the way.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return true;
    return !window.matchMedia('(min-width: 1024px)').matches;
  });
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

  // ⌘J shortcut — collapsed → expand to full chat; otherwise toggle chat panel.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        if (collapsed) {
          setCollapsed(false);
          setExpanded(true);
        } else {
          setExpanded((v) => !v);
        }
      }
      if (e.key === 'Escape') {
        if (expanded) setExpanded(false);
        else if (!collapsed) setCollapsed(true);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [expanded, collapsed]);

  useEffect(() => {
    if (expanded && !collapsed) setTimeout(() => inputRef.current?.focus(), 100);
  }, [expanded, collapsed]);

  const openFromFab = () => {
    setCollapsed(false);
    setExpanded(true);
  };

  const collapseToFab = () => {
    setCollapsed(true);
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
      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), role: 'assistant', content: res.reply || t('ai.noReply') }]);
    } catch {
      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), role: 'assistant', content: t('ai.connectionError') }]);
    } finally {
      setIsLoading(false);
    }
  };

  // Collapsed state: render only the FAB. Tap opens straight into chat mode.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={openFromFab}
        className="fixed bottom-4 right-4 h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl active:scale-95 transition-all flex items-center justify-center z-[var(--z-ai-bubble)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t('ai.openAssistant')}
      >
        <Sparkles className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-4 right-4 flex flex-col items-end gap-2 z-[var(--z-ai-bubble)]"
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
        <div className="flex gap-2 justify-end flex-wrap">
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
