import { useQuery } from '@tanstack/react-query';
import { Calculator, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';
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
}

/**
 * WidgetTasse — KPI tasse stimate per il forfettario.
 *
 * Mostra il totale dovuto (IRPEF + INPS) calcolato sui ricavi YTD, con
 * breakdown e barra del plafond. Link alla pagina /tasse per il dettaglio.
 */
export function WidgetTasse() {
  const { formatCurrency } = useI18n();
  const { data, isLoading } = useQuery<TaxForecast>({
    queryKey: ['tax-forecast'],
    queryFn: () => apiFetch('/api/tax/forecast'),
  });

  const t = data?.taxes;
  const plafondPercent = t ? Math.min(t.plafond_percent, 100) : 0;
  const plafondOverflow = t && t.plafond_percent > 100;

  const barColor =
    !t || t.plafond_warning === 'ok'
      ? 'bg-emerald-500'
      : t.plafond_warning === 'approaching'
        ? 'bg-amber-500'
        : 'bg-red-500';

  return (
    <Link
      to="/tasse"
      className="flex flex-col h-full p-4 hover:bg-muted/30 transition-colors rounded-lg"
    >
      <div className="flex items-center gap-2 mb-3">
        <Calculator className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">
          Tasse stimate {data?.year ?? new Date().getFullYear()}
        </h3>
        {t?.plafond_warning === 'exceeded' && (
          <AlertTriangle className="h-3.5 w-3.5 text-red-500 ml-auto" />
        )}
      </div>

      {isLoading || !t ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Caricamento...</p>
        </div>
      ) : t.regime !== 'forfettario' ? (
        <div className="flex-1 flex flex-col items-start justify-center gap-1">
          <p className="text-xs text-muted-foreground">
            Regime "{t.regime}" — calcolo automatico non disponibile.
          </p>
          <p className="text-[10px] text-muted-foreground">
            Imposta vat_regime='forfettario' in Studio freelance.
          </p>
        </div>
      ) : (
        <>
          <div className="flex-1">
            <p className="text-3xl font-bold tabular-nums">{formatCurrency(t.total_due_eur)}</p>
            <p className="text-xs text-muted-foreground">
              da versare ({Math.round(t.effective_tax_rate * 100)}% sui ricavi)
            </p>

            <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
              <div>
                <p className="text-muted-foreground">IRPEF (5%)</p>
                <p className="font-semibold tabular-nums">{formatCurrency(t.irpef_eur)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">INPS gest. sep.</p>
                <p className="font-semibold tabular-nums">{formatCurrency(t.inps_eur)}</p>
              </div>
            </div>
          </div>

          <div className="mt-3 space-y-1">
            <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Plafond {Math.round(t.plafond_percent)}%</span>
              <span className="tabular-nums">
                {formatCurrency(t.gross_revenue_eur)} / {formatCurrency(t.plafond_eur)}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={cn('h-full transition-all', barColor)}
                style={{ width: `${Math.max(2, plafondPercent)}%` }}
              />
            </div>
            {plafondOverflow && (
              <p className="text-[10px] text-red-500 font-medium">
                Plafond superato: rientro in ordinario l'anno prossimo
              </p>
            )}
          </div>
        </>
      )}
    </Link>
  );
}
