import { useQuery } from '@tanstack/react-query';
import { Gauge, Activity } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

interface CapacityWeek {
  week_start: string;
  week_end: string;
  hours_planned: number;
  hours_available: number;
  ratio: number;
  status: 'light' | 'optimal' | 'overbooked';
  billable_hours: number;
  running_timers: number;
  breakdown: Array<{ source: string; hours: number; count: number }>;
}

const SOURCE_LABEL: Record<string, string> = {
  time_entries: 'Time entries',
  'calendar:manual': 'Eventi manuali',
  'calendar:booking': 'Prenotazioni',
  'calendar:admin': 'Eventi admin',
  'calendar:mcp': 'Eventi MCP',
  'calendar:agent': 'Eventi agent',
};

const STATUS_LABEL: Record<CapacityWeek['status'], string> = {
  light: 'Settimana leggera',
  optimal: 'Settimana ottimale',
  overbooked: 'Settimana sovraccarica',
};

const STATUS_BAR_COLOR: Record<CapacityWeek['status'], string> = {
  light: 'bg-blue-500',
  optimal: 'bg-emerald-500',
  overbooked: 'bg-red-500',
};

const STATUS_TEXT_COLOR: Record<CapacityWeek['status'], string> = {
  light: 'text-blue-600 dark:text-blue-400',
  optimal: 'text-emerald-600 dark:text-emerald-400',
  overbooked: 'text-red-600 dark:text-red-400',
};

/**
 * WidgetCapacity — capacità settimanale (time_entries + calendar_events vs soglia).
 *
 * Mostra una barra ore pianificate / ore disponibili con colore in base al ratio.
 * Status: light (<80%), optimal (80-100%), overbooked (>100%).
 */
export function WidgetCapacity() {
  const { data, isLoading } = useQuery<CapacityWeek>({
    queryKey: ['capacity-week'],
    queryFn: () => apiFetch('/api/dashboard/capacity-week'),
    refetchInterval: 5 * 60_000,
  });

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center gap-2 mb-3">
        <Gauge className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Capacità settimanale</h3>
        {data && data.running_timers > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-red-500">
            <Activity className="h-3 w-3 animate-pulse" />
            {data.running_timers} timer
          </span>
        )}
      </div>

      {isLoading || !data ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Caricamento...</p>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-3xl font-bold tabular-nums">
              {data.hours_planned}
              <span className="text-base text-muted-foreground font-normal">
                {' '}/ {data.hours_available}h
              </span>
            </p>
            <span className={cn('text-xs font-medium', STATUS_TEXT_COLOR[data.status])}>
              {STATUS_LABEL[data.status]}
            </span>
          </div>

          {/* Bar */}
          <div className="mt-2 h-2 w-full rounded-full bg-muted overflow-hidden relative">
            <div
              className={cn('h-full transition-all', STATUS_BAR_COLOR[data.status])}
              style={{ width: `${Math.min(100, data.ratio * 100)}%` }}
            />
            {data.ratio > 1 && (
              <div
                className="absolute top-0 right-0 h-full bg-red-500/50"
                style={{ width: `${Math.min(20, (data.ratio - 1) * 100)}%` }}
                aria-hidden
              />
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {data.ratio > 1
              ? `${Math.round((data.ratio - 1) * 100)}% oltre la capacità`
              : `${Math.round(data.ratio * 100)}% della capacità`}
            {data.billable_hours > 0 && (
              <> · {data.billable_hours}h fatturabili</>
            )}
          </p>

          {/* Breakdown */}
          {data.breakdown.length > 0 && (
            <div className="mt-auto pt-3 space-y-1 border-t mt-3">
              {data.breakdown
                .filter((b) => b.hours > 0)
                .slice(0, 4)
                .map((b) => (
                  <div key={b.source} className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground truncate">
                      {SOURCE_LABEL[b.source] ?? b.source}
                      <span className="text-muted-foreground/60"> · {b.count}</span>
                    </span>
                    <span className="font-medium tabular-nums shrink-0">{b.hours}h</span>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
