import { useQuery } from '@tanstack/react-query';
import { Activity, UserPlus, CreditCard, CheckCircle2, FileText } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/use-i18n';

const iconMap: Record<string, { icon: typeof Activity; color: string }> = {
  lead: { icon: UserPlus, color: 'text-blue-500' },
  payment: { icon: CreditCard, color: 'text-emerald-500' },
  task: { icon: CheckCircle2, color: 'text-violet-500' },
  blog: { icon: FileText, color: 'text-amber-500' },
  default: { icon: Activity, color: 'text-muted-foreground' },
};

export function WidgetFeed() {
  const { t, formatRelativeTime, formatLeadSource } = useI18n();
  // Fetch recent leads as activity
  const { data: leadsData } = useQuery({
    queryKey: ['widget-feed-leads'],
    queryFn: () => apiFetch('/api/leads'),
  });

  const leads = (leadsData?.leads || []).slice(0, 5);

  const feedItems = leads.map((l: any) => ({
    id: l.id,
    type: 'lead',
    text: t('dashboard.widgets.feed.newLead', {
      name: l.name,
      company: l.company ? ` (${l.company})` : '',
      source: formatLeadSource(l.source),
    }),
    time: l.created_at,
  }));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('dashboard.widgets.feed.title')}</h3>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-4">
        {feedItems.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">{t('dashboard.widgets.feed.empty')}</p>
        ) : (
          <div className="space-y-1">
            {feedItems.map((item: any) => {
              const cfg = iconMap[item.type] || iconMap.default;
              return (
                <div key={item.id} className="flex items-start gap-3 rounded-lg p-2 hover:bg-muted/50 transition-colors">
                  <cfg.icon className={cn('h-4 w-4 mt-0.5 shrink-0', cfg.color)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs leading-relaxed">{item.text}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{formatRelativeTime(item.time)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
