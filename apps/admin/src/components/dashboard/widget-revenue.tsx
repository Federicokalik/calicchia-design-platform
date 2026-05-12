import { useQuery } from '@tanstack/react-query';
import { TrendingUp } from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';

export function WidgetRevenue() {
  const { t, intlLocale, formatCurrency } = useI18n();
  const { data } = useQuery({
    queryKey: ['widget-revenue'],
    queryFn: () => apiFetch('/api/payment-tracker'),
  });

  const payments = data?.payments || [];

  // Group by month
  const monthMap = new Map<string, number>();
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toLocaleDateString(intlLocale, { month: 'short' });
    monthMap.set(key, 0);
  }

  for (const p of payments) {
    if (p.status !== 'pagata' || !p.paid_date) continue;
    const d = new Date(p.paid_date);
    const key = d.toLocaleDateString(intlLocale, { month: 'short' });
    if (monthMap.has(key)) {
      monthMap.set(key, (monthMap.get(key) || 0) + parseFloat(p.amount || 0));
    }
  }

  const chartData = Array.from(monthMap.entries()).map(([month, revenue]) => ({ month, revenue }));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <TrendingUp className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('dashboard.widgets.revenue.title')}</h3>
        <span className="text-xs text-muted-foreground ml-auto">{t('dashboard.widgets.revenue.range')}</span>
      </div>
      <div className="flex-1 px-2 pb-2 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCurrency(v / 1000).replace(/\s?0([,.]00)?/, '') + 'k'} />
            <Tooltip
              contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
              formatter={(value: number) => [formatCurrency(value), t('dashboard.widgets.revenue.title')]}
            />
            <Area type="monotone" dataKey="revenue" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#revenueGradient)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
