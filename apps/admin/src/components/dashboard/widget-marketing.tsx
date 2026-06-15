import { useQuery } from '@tanstack/react-query';
import { Megaphone } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';
import type { Campaign } from '@/types/marketing';

function eur(n: number): string {
  return `€${n.toLocaleString('it-IT', { maximumFractionDigits: 0 })}`;
}

export function WidgetMarketing() {
  const { t } = useI18n();
  const { data } = useQuery({
    queryKey: ['widget-marketing'],
    queryFn: () => apiFetch('/api/marketing/campaigns'),
  });

  const campaigns: Campaign[] = data?.campaigns || [];
  const active = campaigns.filter((c) => c.status === 'active');
  const planned = active.reduce((s, c) => s + Number(c.budget_planned || 0), 0);
  const actual = active.reduce((s, c) => s + Number(c.budget_actual || 0), 0);
  const pending = campaigns.reduce((s, c) => s + (c.pending_approval_count || 0), 0);
  const budgetPct = planned > 0 ? Math.min(100, Math.round((actual / planned) * 100)) : 0;

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center gap-2 mb-3">
        <Megaphone className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('dashboard.widgets.marketing.title')}</h3>
        <span className="text-xs text-muted-foreground ml-auto">{active.length} attive</span>
      </div>

      <div className="grid grid-cols-2 gap-3 flex-1">
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">Budget attivo</p>
          <p className="text-lg font-bold tabular-nums">{eur(actual)}</p>
          <p className="text-[11px] text-muted-foreground">di {eur(planned)} previsti</p>
          {planned > 0 && (
            <div className="mt-2 h-1.5 rounded-full bg-background overflow-hidden">
              <div className="h-full bg-primary" style={{ width: `${budgetPct}%` }} />
            </div>
          )}
        </div>
        <div className="rounded-lg bg-muted/50 p-3 flex flex-col">
          <p className="text-xs text-muted-foreground">Asset da approvare</p>
          <p className="text-lg font-bold tabular-nums">{pending}</p>
          <p className="text-[11px] text-muted-foreground mt-auto">in attesa del cliente</p>
        </div>
      </div>
    </div>
  );
}
