import { useQuery } from '@tanstack/react-query';
import { Kanban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';

const STAGE_COLORS: Record<string, string> = {
  new: 'bg-blue-500',
  contacted: 'bg-cyan-500',
  proposal: 'bg-amber-500',
  negotiation: 'bg-purple-500',
};

const STAGES = ['new', 'contacted', 'proposal', 'negotiation'];

export function WidgetPipeline() {
  const { t, formatStatus } = useI18n();
  const { data } = useQuery({
    queryKey: ['widget-pipeline'],
    queryFn: () => apiFetch('/api/leads'),
  });

  const leads = data?.leads || [];
  const activeLeads = leads.filter((l: any) => !['won', 'lost'].includes(l.status));

  const stages = STAGES.map((status) => ({
    label: formatStatus('lead', status),
    count: activeLeads.filter((l: any) => l.status === status).length,
    color: STAGE_COLORS[status],
  }));

  const total = stages.reduce((s, st) => s + st.count, 0);

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center gap-2 mb-3">
        <Kanban className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('dashboard.widgets.pipeline.title')}</h3>
        <span className="text-xs text-muted-foreground ml-auto">{total} lead</span>
      </div>
      {total > 0 && (
        <div className="flex h-2 rounded-full overflow-hidden mb-3">
          {stages.map((s) => s.count > 0 && (
            <div key={s.label} className={cn('transition-all', s.color)} style={{ width: `${(s.count / total) * 100}%` }} />
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 flex-1">
        {stages.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <div className={cn('h-2.5 w-2.5 rounded-full shrink-0', s.color)} />
            <span className="text-xs text-muted-foreground truncate">{s.label}</span>
            <span className="text-xs font-semibold ml-auto">{s.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
