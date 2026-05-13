import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Calculator, Calendar, AlertTriangle, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/shared/loading-state';
import { useTopbar } from '@/hooks/use-topbar';
import { useI18n } from '@/hooks/use-i18n';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

interface TaxForecast {
  year: number;
  taxes: {
    gross_revenue_eur: number;
    taxable_eur: number;
    irpef_eur: number;
    inps_eur: number;
    total_due_eur: number;
    plafond_eur: number;
    plafond_percent: number;
    plafond_warning: 'ok' | 'approaching' | 'exceeded';
    effective_tax_rate: number;
    regime: 'forfettario' | 'ordinario' | 'none';
  };
  deadlines: { label: string; date: string; amount_eur: number }[];
  monthly_revenue: { month: string; total: number }[];
}

const MONTHS_IT = [
  'gen', 'feb', 'mar', 'apr', 'mag', 'giu',
  'lug', 'ago', 'set', 'ott', 'nov', 'dic',
];

function formatMonth(iso: string): string {
  const d = new Date(iso);
  return MONTHS_IT[d.getMonth()] ?? '';
}

export default function TassePage() {
  const { formatCurrency } = useI18n();

  useTopbar({
    title: 'Tasse stimate',
    subtitle: 'Regime forfettario — calcoli su ricavi YTD',
  });

  const { data, isLoading } = useQuery<TaxForecast>({
    queryKey: ['tax-forecast', 'full'],
    queryFn: () => apiFetch('/api/tax/forecast'),
  });

  if (isLoading) return <LoadingState />;
  if (!data) return <p className="text-sm text-muted-foreground">Dati non disponibili.</p>;

  const { taxes, deadlines, monthly_revenue, year } = data;
  const plafondPercent = Math.min(taxes.plafond_percent, 100);
  const plafondOverflow = taxes.plafond_percent > 100;
  const barColor =
    taxes.plafond_warning === 'ok'
      ? 'bg-emerald-500'
      : taxes.plafond_warning === 'approaching'
        ? 'bg-amber-500'
        : 'bg-red-500';

  const chartData = monthly_revenue.map((m) => ({
    month: formatMonth(m.month),
    revenue: m.total,
  }));

  if (taxes.regime !== 'forfettario') {
    return (
      <div className="space-y-4 max-w-2xl">
        <div className="rounded-lg border bg-amber-500/10 border-amber-500/30 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium">
              Regime fiscale impostato su "{taxes.regime}"
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Il calcolo automatico delle tasse è disponibile solo per il regime forfettario.
              Vai in Impostazioni → Studio freelance per cambiare regime.
            </p>
            <Link to="/impostazioni">
              <Button variant="outline" size="sm" className="mt-3">
                Apri Impostazioni <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Riepilogo */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Ricavi {year} (YTD)
          </p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">
            {formatCurrency(taxes.gross_revenue_eur)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">fatture draft/open/paid</p>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Imponibile
          </p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">
            {formatCurrency(taxes.taxable_eur)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            ricavi × coefficiente
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Totale dovuto
          </p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">
            {formatCurrency(taxes.total_due_eur)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            {Math.round(taxes.effective_tax_rate * 100)}% sui ricavi
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Plafond
          </p>
          <p className={cn(
            'text-2xl font-semibold mt-1 tabular-nums',
            plafondOverflow && 'text-red-600 dark:text-red-400',
            taxes.plafond_warning === 'approaching' && 'text-amber-600 dark:text-amber-400',
          )}>
            {Math.round(taxes.plafond_percent)}%
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            su {formatCurrency(taxes.plafond_eur)}
          </p>
        </div>
      </div>

      {/* Plafond bar */}
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-semibold flex items-center gap-2">
            <Calculator className="h-4 w-4 text-muted-foreground" />
            Soglia plafond forfettario
          </p>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatCurrency(taxes.gross_revenue_eur)} / {formatCurrency(taxes.plafond_eur)}
          </span>
        </div>
        <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={cn('h-full transition-all', barColor)}
            style={{ width: `${Math.max(2, plafondPercent)}%` }}
          />
        </div>
        {taxes.plafond_warning === 'approaching' && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Attenzione: ti stai avvicinando alla soglia. Sopra 85k esci dal forfettario.
          </p>
        )}
        {plafondOverflow && (
          <p className="text-xs text-red-600 dark:text-red-400 font-medium">
            Plafond superato: dall'anno prossimo passi al regime ordinario.
          </p>
        )}
      </div>

      {/* Breakdown calcolo */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <p className="text-sm font-semibold">Dettaglio calcolo</p>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">Ricavi lordi YTD</span>
              <span className="font-medium tabular-nums">{formatCurrency(taxes.gross_revenue_eur)}</span>
            </div>
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">× coefficiente redditività</span>
              <span className="font-medium tabular-nums">
                = {formatCurrency(taxes.taxable_eur)}
              </span>
            </div>
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">IRPEF sostitutiva (5%)</span>
              <span className="font-medium tabular-nums">{formatCurrency(taxes.irpef_eur)}</span>
            </div>
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">INPS gest. separata</span>
              <span className="font-medium tabular-nums">{formatCurrency(taxes.inps_eur)}</span>
            </div>
            <div className="flex justify-between pt-1">
              <span className="font-semibold">Totale da versare</span>
              <span className="font-bold tabular-nums text-lg">
                {formatCurrency(taxes.total_due_eur)}
              </span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground pt-2 border-t">
            Riferimento normativo: L. 190/2014 art. 1 commi 54-89. Le tariffe e il coefficiente
            sono configurabili in Impostazioni → Studio freelance.
          </p>
        </div>

        {/* Scadenze F24 */}
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <p className="text-sm font-semibold flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            Scadenze F24 {year}
          </p>
          <div className="space-y-2">
            {deadlines.map((d) => (
              <div
                key={d.date}
                className="flex items-center justify-between border-l-2 border-muted pl-3 py-1"
              >
                <div>
                  <p className="text-sm font-medium">{d.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(d.date).toLocaleDateString('it-IT', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </p>
                </div>
                <Badge variant="outline" className="tabular-nums">
                  {formatCurrency(d.amount_eur)}
                </Badge>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground pt-2 border-t">
            Stime semplificate: acconti calcolati al 50% del totale dovuto.
            Verifica con il commercialista per valori esatti.
          </p>
        </div>
      </div>

      {/* Grafico ricavi mensili */}
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <p className="text-sm font-semibold">Ricavi mensili {year}</p>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="tasseRevenueGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${Math.round(v / 1000)}k`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
                formatter={(value: number) => [formatCurrency(value), 'Ricavi']}
              />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#tasseRevenueGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
