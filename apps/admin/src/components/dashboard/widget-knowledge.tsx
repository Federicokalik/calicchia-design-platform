import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { StickyNote, PenTool, GitBranch, ArrowRight } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';

const KIND_CONFIG: Record<string, { icon: React.ElementType; path: string; color: string }> = {
  note: { icon: StickyNote, path: '/notes', color: 'text-amber-500' },
  sketch: { icon: PenTool, path: '/boards/sketch', color: 'text-blue-500' },
  mindmap: { icon: GitBranch, path: '/boards/mindmap', color: 'text-violet-500' },
};

export function WidgetKnowledge() {
  const { t, formatRelativeTime } = useI18n();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['knowledge-recent'],
    queryFn: () => apiFetch('/api/knowledge/recent?limit=6'),
  });
  const { data: stats } = useQuery({
    queryKey: ['knowledge-stats'],
    queryFn: () => apiFetch('/api/knowledge/stats'),
  });

  const items = data?.items || [];
  const s = stats || { notes: 0, sketches: 0, mindmaps: 0 };

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">{t('dashboard.widgets.knowledge.title')}</h3>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>{s.notes} note</span>
          <span>{s.sketches} sketch</span>
          <span>{s.mindmaps} {t('nav.mindMaps').toLowerCase()}</span>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">{t('dashboard.widgets.knowledge.empty')}</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item: any) => {
            const config = KIND_CONFIG[item.kind] || KIND_CONFIG.note;
            const Icon = config.icon;
            return (
              <button
                key={`${item.kind}-${item.id}`}
                onClick={() => navigate(item.kind === 'note' ? `/notes/${item.id}` : `${config.path}/${item.id}`)}
                className="flex items-center gap-2.5 w-full rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted transition-colors"
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${config.color}`} />
                <span className="flex-1 truncate text-xs">{item.title}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{formatRelativeTime(item.updated_at, { compact: true })}</span>
              </button>
            );
          })}
        </div>
      )}

      <button
        onClick={() => navigate('/notes')}
        className="flex items-center gap-1 mt-3 text-[10px] text-primary hover:underline"
      >
        {t('dashboard.widgets.knowledge.viewAll')} <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
}
