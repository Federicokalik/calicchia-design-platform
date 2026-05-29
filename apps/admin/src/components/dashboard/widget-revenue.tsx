import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp } from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  PAYMENT_METHOD_LABELS, PAYMENT_METHOD_COLORS, type PaymentMethod,
} from '@/types/projects';

export function WidgetRevenue() {
  const { t, intlLocale, formatCurrency } = useI18n();
  const { data } = useQuery({
    queryKey: ['widget-revenue'],
    queryFn: () => apiFetch('/api/payment-tracker'),
  });

  const payments = data?.payments || [];

  // Build the 7-month window once so chart + breakdown share the same range.
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 6, 1);

  // Group by month
  const monthMap = new Map<string, number>();
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

  const byMethod = useMemo(() => {
    const map = new Map<PaymentMethod | 'unknown', number>();
    for (const p of payments) {
      if (p.status !== 'pagata' || !p.paid_date) continue;
      const d = new Date(p.paid_date);
      if (d < windowStart) continue;
      const method = (p.payment_method as PaymentMethod | null) ?? 'unknown';
      const amount = parseFloat(p.paid_amount ?? p.amount ?? 0);
      if (!Number.isFinite(amount)) continue;
      map.set(method, (map.get(method) || 0) + amount);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments]);

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
      {byMethod.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-4 pb-3 pt-1 border-t">
          {byMethod.slice(0, 5).map(([method, value]) => (
            <span
              key={method}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                method !== 'unknown' && PAYMENT_METHOD_COLORS[method as PaymentMethod],
                method === 'unknown' && 'bg-muted text-muted-foreground',
              )}
              title={method === 'unknown' ? 'Metodo non specificato' : PAYMENT_METHOD_LABELS[method as PaymentMethod]}
            >
              <span>{method === 'unknown' ? '—' : PAYMENT_METHOD_LABELS[method as PaymentMethod]}</span>
              <span className="font-semibold">{formatCurrency(value)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
