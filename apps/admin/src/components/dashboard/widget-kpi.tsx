import { useQuery } from '@tanstack/react-query';
import { TrendingUp, FolderKanban, Kanban, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';

interface KpiCard {
  label: string;
  value: string;
  change: string;
  trend: 'up' | 'down' | 'neutral';
  icon: React.ComponentType<{ className?: string }>;
}

export function WidgetKpi() {
  const { t, formatCurrency } = useI18n();
  const { data: leadsData } = useQuery({
    queryKey: ['kpi-leads'],
    queryFn: () => apiFetch('/api/leads'),
  });

  const { data: projectsData } = useQuery({
    queryKey: ['kpi-projects'],
    queryFn: () => apiFetch('/api/client-projects?limit=100'),
  });

  const { data: domainsData } = useQuery({
    queryKey: ['kpi-domains'],
    queryFn: () => apiFetch('/api/domains'),
  });

  const { data: paymentsData } = useQuery({
    queryKey: ['kpi-payments'],
    queryFn: () => apiFetch('/api/payment-tracker'),
  });

  const leads = leadsData?.leads || [];
  const projects = projectsData?.projects || [];
  const domains = domainsData?.domains || [];
  const payments = paymentsData?.payments || [];

  const activeLeads = leads.filter((l: any) => !['won', 'lost'].includes(l.status)).length;
  const activeProjects = projects.filter((p: any) => p.status === 'in_progress').length;
  const revenueMese = payments.filter((p: any) => p.status === 'pagata').reduce((s: number, p: any) => s + parseFloat(p.amount || 0), 0);
  const expiringDomains = domains.filter((d: any) => {
    if (!d.expiry_date) return false;
    const days = Math.ceil((new Date(d.expiry_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return days >= 0 && days <= 30;
  }).length;

  const kpis: KpiCard[] = [
    { label: t('dashboard.widgets.kpi.monthRevenue'), value: formatCurrency(revenueMese), change: '', trend: 'up', icon: TrendingUp },
    { label: t('dashboard.widgets.kpi.activeProjects'), value: String(activeProjects), change: '', trend: 'up', icon: FolderKanban },
    { label: t('dashboard.widgets.kpi.pipelineLeads'), value: String(activeLeads), change: '', trend: 'up', icon: Kanban },
    { label: t('dashboard.widgets.kpi.expiringDomains'), value: String(expiringDomains), change: t('dashboard.widgets.kpi.next30Days'), trend: 'neutral', icon: Globe },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 p-4 h-full">
      {kpis.map((kpi) => (
        <div key={kpi.label} className="flex flex-col justify-between rounded-lg bg-muted/50 p-3">
          <div className="flex items-center justify-between">
            <kpi.icon className="h-4 w-4 text-muted-foreground" />
            {kpi.change && (
              <span className={cn('text-xs font-medium', kpi.trend === 'up' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                {kpi.change}
              </span>
            )}
          </div>
          <div className="mt-2">
            <p className="text-2xl font-bold tracking-tight">{kpi.value}</p>
            <p className="text-xs text-muted-foreground">{kpi.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
