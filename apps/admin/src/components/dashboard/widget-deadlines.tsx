import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Globe, CalendarClock } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/use-i18n';

function urgencyColor(days: number) {
  if (days <= 7) return 'text-red-600 dark:text-red-400';
  if (days <= 14) return 'text-amber-600 dark:text-amber-400';
  return 'text-muted-foreground';
}

export function WidgetDeadlines() {
  const { t } = useI18n();
  const { data: domainsData } = useQuery({
    queryKey: ['widget-deadlines-domains'],
    queryFn: () => apiFetch('/api/domains'),
  });

  const domains = (domainsData?.domains || [])
    .filter((d: any) => d.expiry_date)
    .map((d: any) => ({
      id: d.id,
      label: d.domain_name,
      date: d.expiry_date,
      daysLeft: Math.ceil((new Date(d.expiry_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
      type: 'domain' as const,
    }))
    .filter((d: any) => d.daysLeft >= 0 && d.daysLeft <= 60)
    .sort((a: any, b: any) => a.daysLeft - b.daysLeft)
    .slice(0, 6);

  const typeIcons = { domain: Globe, milestone: CalendarClock };

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('dashboard.widgets.deadlines.title')}</h3>
      </div>
      <div className="space-y-2 flex-1 overflow-y-auto scrollbar-thin">
        {domains.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">{t('dashboard.widgets.deadlines.empty')}</p>
        ) : (
          domains.map((item: any) => {
            const Icon = typeIcons[item.type as keyof typeof typeIcons] || Globe;
            return (
              <div key={item.id} className="flex items-center gap-2.5">
                <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs truncate flex-1">{item.label}</span>
                <span className={cn('text-xs font-medium shrink-0', urgencyColor(item.daysLeft))}>
                  {item.daysLeft}{t('dashboard.widgets.kpi.next30Days').replace('30', '')}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
