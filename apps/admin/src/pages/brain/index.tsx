import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Brain, MessageCircle, Lightbulb, BookOpen, Search, Trash2,
  StickyNote, PenTool, GitBranch, Sparkles, Edit3, Check, X,
  Monitor, MessageSquare, ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/use-i18n';

const TABS = [
  { id: 'overview', labelKey: 'secondBrain.tabs.overview', icon: Brain },
  { id: 'conversations', labelKey: 'secondBrain.tabs.conversations', icon: MessageCircle },
  { id: 'facts', labelKey: 'secondBrain.tabs.facts', icon: Lightbulb },
  { id: 'knowledge', labelKey: 'secondBrain.tabs.knowledge', icon: BookOpen },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ─── OVERVIEW TAB ───
function OverviewTab() {
  const { t, formatRelativeTime } = useI18n();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['brain-overview'], queryFn: () => apiFetch('/api/brain/overview') });
  const stats = data?.stats || {};
  const recentFacts = data?.recentFacts || [];
  const recentConvs = data?.recentConversations || [];
  const topCategories = data?.topCategories || [];

  const KPI = [
    { label: t('secondBrain.stats.conversations'), value: stats.conversations || 0, icon: MessageCircle, color: 'text-blue-500' },
    { label: t('secondBrain.stats.facts'), value: stats.facts || 0, icon: Lightbulb, color: 'text-amber-500' },
    { label: t('secondBrain.stats.preferences'), value: stats.preferences || 0, icon: Sparkles, color: 'text-violet-500' },
    { label: t('secondBrain.stats.notes'), value: stats.notes || 0, icon: StickyNote, color: 'text-emerald-500' },
    { label: t('secondBrain.stats.sketches'), value: stats.sketches || 0, icon: PenTool, color: 'text-cyan-500' },
    { label: t('secondBrain.stats.maps'), value: stats.mindmaps || 0, icon: GitBranch, color: 'text-rose-500' },
  ];

  return (
    <div className="space-y-5">
      {/* KPI Grid */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
        {KPI.map((k) => (
          <div key={k.label} className="rounded-xl border bg-card p-4 text-center">
            <k.icon className={cn('h-5 w-5 mx-auto mb-2', k.color)} />
            <p className="text-2xl font-bold">{k.value}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{k.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Recent Conversations */}
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-muted-foreground" /> {t('secondBrain.recentConversations')}
          </h3>
          {recentConvs.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">{t('secondBrain.noConversations')}</p>
          ) : (
            <div className="space-y-2">
              {recentConvs.map((c: any) => (
                <div key={c.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-muted/50 transition-colors cursor-pointer">
                  {c.channel === 'telegram' ? <MessageSquare className="h-3.5 w-3.5 text-blue-400 mt-0.5 shrink-0" /> : <Monitor className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs line-clamp-2">{c.summary || t('secondBrain.noSummary')}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{formatRelativeTime(c.created_at)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Facts */}
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-muted-foreground" /> {t('secondBrain.recentFacts')}
          </h3>
          {recentFacts.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">{t('secondBrain.noFacts')}</p>
          ) : (
            <div className="space-y-2">
              {recentFacts.map((f: any) => (
                <div key={f.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-amber-400 mt-1.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs line-clamp-2">{f.fact}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {f.entity_type && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{f.entity_type}</Badge>}
                      <span className="text-[10px] text-muted-foreground">{formatRelativeTime(f.created_at)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tag Cloud */}
      {topCategories.length > 0 && (
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-semibold mb-3">{t('secondBrain.knowledgeCategories')}</h3>
          <div className="flex flex-wrap gap-2">
            {topCategories.map((cat: any) => (
              <Badge key={cat.category} variant="secondary" className="text-xs">
                {cat.category || t('secondBrain.generic')} <span className="ml-1 text-muted-foreground">({cat.count})</span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Quick Access */}
      <div className="grid grid-cols-3 gap-3">
        <button onClick={() => navigate('/notes')} className="rounded-xl border bg-card p-4 hover:border-primary/30 transition-colors text-center">
          <StickyNote className="h-6 w-6 mx-auto mb-2 text-emerald-500" />
          <p className="text-xs font-medium">Note</p>
          <p className="text-[10px] text-muted-foreground">{stats.notes || 0} note</p>
        </button>
        <button onClick={() => navigate('/boards/sketch')} className="rounded-xl border bg-card p-4 hover:border-primary/30 transition-colors text-center">
          <PenTool className="h-6 w-6 mx-auto mb-2 text-cyan-500" />
          <p className="text-xs font-medium">Sketch</p>
          <p className="text-[10px] text-muted-foreground">{stats.sketches || 0} sketch</p>
        </button>
        <button onClick={() => navigate('/boards/mindmap')} className="rounded-xl border bg-card p-4 hover:border-primary/30 transition-colors text-center">
          <GitBranch className="h-6 w-6 mx-auto mb-2 text-rose-500" />
          <p className="text-xs font-medium">Mappe</p>
          <p className="text-[10px] text-muted-foreground">{stats.mindmaps || 0} {t('secondBrain.stats.maps').toLowerCase()}</p>
        </button>
      </div>
    </div>
  );
}

// ─── CONVERSATIONS TAB ───
function ConversationsTab() {
  const { t, formatRelativeTime } = useI18n();
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('');

  const { data } = useQuery({
    queryKey: ['brain-conversations', search, channel],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (channel) params.set('channel', channel);
      return apiFetch(`/api/brain/conversations?${params}`);
    },
  });

  const conversations = data?.conversations || [];
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t('secondBrain.searchConversations')} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9" />
        </div>
        <div className="flex gap-1">
          {[{ v: '', l: t('common.all') }, { v: 'admin', l: 'Admin' }, { v: 'telegram', l: 'Telegram' }].map((f) => (
            <button key={f.v} onClick={() => setChannel(f.v)} className={cn('px-2.5 py-1 rounded-md text-xs transition-colors', channel === f.v ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted')}>{f.l}</button>
          ))}
        </div>
      </div>

      {conversations.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">{t('secondBrain.noConversationResults')}</div>
      ) : (
        <div className="space-y-2">
          {conversations.map((conv: any) => {
            const messages = typeof conv.messages === 'string' ? JSON.parse(conv.messages) : (conv.messages || []);
            const isExpanded = expandedId === conv.id;

            return (
              <div key={conv.id} className="rounded-xl border bg-card overflow-hidden">
                <button
                  onClick={() => setExpandedId(isExpanded ? null : conv.id)}
                  className="flex items-center gap-3 w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                >
                  {conv.channel === 'telegram' ? <MessageSquare className="h-4 w-4 text-blue-400 shrink-0" /> : <Monitor className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium line-clamp-1">{conv.summary || t('secondBrain.noSummary')}</p>
                    <p className="text-[10px] text-muted-foreground">{formatRelativeTime(conv.created_at)} · {messages.length} {t('secondBrain.stats.conversations').toLowerCase()}{conv.tokens_used ? ` · ${conv.tokens_used} token` : ''}</p>
                  </div>
                  <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', isExpanded && 'rotate-90')} />
                </button>

                {isExpanded && messages.length > 0 && (
                  <div className="border-t px-4 py-3 space-y-3 max-h-96 overflow-y-auto">
                    {messages.map((msg: any, i: number) => (
                      <div key={i} className={cn('flex gap-2.5', msg.role === 'user' ? 'justify-end' : '')}>
                        <div className={cn(
                          'rounded-lg px-3 py-2 max-w-[80%] text-xs',
                          msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                        )}>
                          {msg.content}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── FACTS TAB ───
function FactsTab() {
  const { t, formatRelativeTime } = useI18n();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  const { data } = useQuery({
    queryKey: ['brain-facts', search, category],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (category) params.set('entity_type', category);
      return apiFetch(`/api/brain/facts?${params}`);
    },
  });

  const facts = data?.facts || [];
  const categories = data?.categories || [];

  const updateMutation = useMutation({
    mutationFn: ({ id, fact }: { id: string; fact: string }) =>
      apiFetch(`/api/brain/facts/${id}`, { method: 'PUT', body: JSON.stringify({ fact }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['brain-facts'] }); setEditingId(null); toast.success(t('common.updated')); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/brain/facts/${id}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['brain-facts'] }); toast.success(t('common.delete')); },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t('secondBrain.searchFacts')} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9" />
        </div>
      </div>

      {/* Category filters */}
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setCategory('')} className={cn('px-2.5 py-1 rounded-md text-xs transition-colors', !category ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted')}>
            {t('common.all')} ({data?.count || 0})
          </button>
          {categories.map((cat: any) => (
            <button key={cat.category} onClick={() => setCategory(cat.category)} className={cn('px-2.5 py-1 rounded-md text-xs transition-colors', category === cat.category ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted')}>
              {cat.category || t('secondBrain.generic')} ({cat.count})
            </button>
          ))}
        </div>
      )}

      {facts.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          <Lightbulb className="h-8 w-8 mx-auto mb-3 text-muted-foreground/30" />
          {t('secondBrain.noFactsLearned')}
        </div>
      ) : (
        <div className="space-y-2">
          {facts.map((fact: any) => (
            <div key={fact.id} className="group rounded-xl border bg-card px-4 py-3 flex items-start gap-3">
              <div className="h-2 w-2 rounded-full bg-amber-400 mt-2 shrink-0" />
              <div className="flex-1 min-w-0">
                {editingId === fact.id ? (
                  <div className="space-y-2">
                    <Textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={2} className="text-xs" />
                    <div className="flex gap-1">
                      <Button size="sm" variant="default" onClick={() => updateMutation.mutate({ id: fact.id, fact: editContent })}>
                        <Check className="h-3 w-3 mr-1" /> {t('common.save')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-xs">{fact.content}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {fact.category && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{fact.category}</Badge>}
                      {fact.entity_type && <Badge variant="secondary" className="text-[9px] px-1.5 py-0">{fact.entity_type}</Badge>}
                      <span className="text-[10px] text-muted-foreground">{fact.source} · {formatRelativeTime(fact.created_at)}</span>
                    </div>
                  </>
                )}
              </div>
              {editingId !== fact.id && (
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => { setEditingId(fact.id); setEditContent(fact.content); }} className="p-1 rounded hover:bg-muted">
                    <Edit3 className="h-3 w-3 text-muted-foreground" />
                  </button>
                  <button onClick={() => { if (confirm(t('common.confirm'))) deleteMutation.mutate(fact.id); }} className="p-1 rounded hover:bg-muted">
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── KNOWLEDGE TAB ───
function KnowledgeTab() {
  const { t, formatRelativeTime } = useI18n();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const { data: notesData } = useQuery({
    queryKey: ['brain-knowledge-notes', search],
    queryFn: () => apiFetch(`/api/notes?search=${search}&limit=20`),
    enabled: !typeFilter || typeFilter === 'note',
  });

  const { data: boardsData } = useQuery({
    queryKey: ['brain-knowledge-boards', search],
    queryFn: () => apiFetch(`/api/boards?search=${search}&limit=20`),
    enabled: !typeFilter || typeFilter === 'sketch' || typeFilter === 'mindmap',
  });

  const notes = notesData?.notes || [];
  const boards = (boardsData?.boards || []).filter((b: any) => !typeFilter || b.type === typeFilter);

  const all = [
    ...notes.map((n: any) => ({ ...n, kind: 'note' as const })),
    ...boards.map((b: any) => ({ ...b, kind: b.type as 'sketch' | 'mindmap' })),
  ].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  const KIND_ICON: Record<string, React.ElementType> = { note: StickyNote, sketch: PenTool, mindmap: GitBranch };
  const KIND_COLOR: Record<string, string> = { note: 'text-emerald-500', sketch: 'text-cyan-500', mindmap: 'text-rose-500' };
  const KIND_PATH: Record<string, string> = { note: '/notes', sketch: '/boards/sketch', mindmap: '/boards/mindmap' };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t('secondBrain.searchKnowledge')} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9" />
        </div>
        <div className="flex gap-1">
          {[{ v: '', l: t('common.all') }, { v: 'note', l: t('nav.notes') }, { v: 'sketch', l: t('nav.sketch') }, { v: 'mindmap', l: t('nav.mindMaps') }].map((f) => (
            <button key={f.v} onClick={() => setTypeFilter(f.v)} className={cn('px-2.5 py-1 rounded-md text-xs transition-colors', typeFilter === f.v ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted')}>{f.l}</button>
          ))}
        </div>
      </div>

      {all.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">{t('secondBrain.noKnowledgeResults')}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {all.map((item) => {
            const Icon = KIND_ICON[item.kind];
            const color = KIND_COLOR[item.kind];
            const path = KIND_PATH[item.kind];
            return (
              <div
                key={`${item.kind}-${item.id}`}
                onClick={() => navigate(`${path}/${item.id}`)}
                className="rounded-xl border bg-card p-4 cursor-pointer hover:shadow-md hover:border-primary/20 transition-all"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Icon className={cn('h-4 w-4', color)} />
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0">{item.kind}</Badge>
                </div>
                <h4 className="text-sm font-medium line-clamp-1">{item.title}</h4>
                {'preview' in item && item.preview && (
                  <p className="text-[11px] text-muted-foreground line-clamp-2 mt-1">{item.preview}</p>
                )}
                <p className="text-[10px] text-muted-foreground mt-2">{formatRelativeTime(item.updated_at)}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── MAIN PAGE ───
export default function BrainPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<TabId>('overview');

  useTopbar({ title: t('secondBrain.title'), subtitle: t('secondBrain.subtitle') });

  return (
    <div className="space-y-5">
      {/* Tab nav */}
      <div className="flex items-center gap-1 border-b">
        {TABS.map((tabItem) => (
          <button
            key={tabItem.id}
            onClick={() => setTab(tabItem.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
              tab === tabItem.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <tabItem.icon className="h-4 w-4" />
            {t(tabItem.labelKey)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && <OverviewTab />}
      {tab === 'conversations' && <ConversationsTab />}
      {tab === 'facts' && <FactsTab />}
      {tab === 'knowledge' && <KnowledgeTab />}
    </div>
  );
}
