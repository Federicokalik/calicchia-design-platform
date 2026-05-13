import { cn } from '@/lib/utils';

interface Step {
  step: number;
  count: number;
}

interface Props {
  steps: Step[];
  stepLabels?: string[];
}

export function FunnelView({ steps, stepLabels = [] }: Props) {
  if (steps.length === 0) {
    return <div className="text-xs text-muted-foreground py-8 text-center">Funnel senza step.</div>;
  }
  const top = steps[0]?.count || 0;
  return (
    <div className="space-y-2">
      {steps.map((s, i) => {
        const prev = i === 0 ? null : steps[i - 1].count;
        const pctFromTop = top > 0 ? (s.count / top) * 100 : 0;
        const dropoff = prev !== null && prev > 0 ? Math.round((1 - s.count / prev) * 100) : null;
        return (
          <div key={s.step} className="relative rounded-lg border bg-card p-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-semibold">
                  {s.step}
                </span>
                <span className="text-sm font-medium">{stepLabels[i] ?? `Step ${s.step}`}</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {dropoff !== null && dropoff > 0 && (
                  <span className="text-red-600">-{dropoff}%</span>
                )}
                <span className="font-semibold text-foreground tabular-nums">
                  {s.count.toLocaleString('it-IT')}
                </span>
              </div>
            </div>
            <div className="relative h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={cn('absolute inset-y-0 left-0 rounded-full bg-primary transition-all')}
                style={{ width: `${pctFromTop}%` }}
              />
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {pctFromTop.toFixed(1)}% di chi è entrato al primo step
            </p>
          </div>
        );
      })}
    </div>
  );
}
