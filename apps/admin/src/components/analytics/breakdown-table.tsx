import { cn } from '@/lib/utils';

interface Row {
  key: string | null;
  label: string;
  pageviews: number;
  visitors: number;
  sessions: number;
}

interface Props {
  rows: Row[];
  totalPageviews?: number;
  emptyText?: string;
  /** What value to show as the bar fill metric. */
  metric?: 'pageviews' | 'visitors' | 'sessions';
}

export function BreakdownTable({ rows, totalPageviews, emptyText = 'Nessun dato', metric = 'pageviews' }: Props) {
  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">{emptyText}</div>
    );
  }

  const max = Math.max(...rows.map((r) => r[metric]));
  const total = totalPageviews ?? rows.reduce((acc, r) => acc + r.pageviews, 0);

  return (
    <div className="space-y-1">
      {rows.map((r, i) => {
        const v = r[metric];
        const pct = max > 0 ? (v / max) * 100 : 0;
        const share = total > 0 ? (r.pageviews / total) * 100 : 0;
        return (
          <div key={`${r.key ?? '-'}-${i}`} className="relative flex items-center gap-3 px-3 py-1.5 text-xs rounded-md hover:bg-muted/30 transition-colors">
            <div
              className={cn('absolute inset-y-1 left-1 rounded bg-primary/10 pointer-events-none')}
              style={{ width: `${pct}%` }}
            />
            <span className="relative flex-1 truncate font-medium">{r.label}</span>
            <span className="relative tabular-nums text-muted-foreground w-12 text-right">
              {share.toFixed(1)}%
            </span>
            <span className="relative tabular-nums w-16 text-right font-semibold">
              {v.toLocaleString('it-IT')}
            </span>
          </div>
        );
      })}
    </div>
  );
}
