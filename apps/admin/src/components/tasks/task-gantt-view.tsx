import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { ProjectTask, TaskStatus } from '@/types/projects';
import { TASK_STATUS_CONFIG } from '@/types/projects';

interface TaskGanttViewProps {
  tasks: ProjectTask[];
  projectStart?: string | null;
  projectEnd?: string | null;
  onItemClick?: (task: ProjectTask) => void;
}

const STATUS_BAR_COLORS: Record<TaskStatus, string> = {
  todo: 'bg-slate-400',
  in_progress: 'bg-blue-500',
  review: 'bg-amber-500',
  done: 'bg-emerald-500',
  blocked: 'bg-red-500',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function diffDays(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

function formatDayShort(d: Date): string {
  return d.toLocaleDateString('it-IT', { day: 'numeric' });
}

function formatMonth(d: Date): string {
  return d.toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
}

interface ComputedTask {
  task: ProjectTask;
  startOffset: number;
  spanDays: number;
}

export function TaskGanttView({ tasks, projectStart, projectEnd, onItemClick }: TaskGanttViewProps) {
  const { rangeStart, totalDays, computed } = useMemo(() => {
    // Base range: project dates if present, otherwise min/max of task due_dates ± 7 days
    const taskDates = tasks
      .filter((t) => t.due_date)
      .map((t) => new Date(t.due_date!));

    let start: Date;
    let end: Date;
    if (projectStart) start = startOfDay(new Date(projectStart));
    else if (taskDates.length) {
      const min = new Date(Math.min(...taskDates.map((d) => d.getTime())));
      start = startOfDay(new Date(min.getTime() - 7 * DAY_MS));
    } else {
      start = startOfDay(new Date(Date.now() - 7 * DAY_MS));
    }

    if (projectEnd) end = startOfDay(new Date(projectEnd));
    else if (taskDates.length) {
      const max = new Date(Math.max(...taskDates.map((d) => d.getTime())));
      end = startOfDay(new Date(max.getTime() + 7 * DAY_MS));
    } else {
      end = startOfDay(new Date(Date.now() + 21 * DAY_MS));
    }

    if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 21 * DAY_MS);

    const total = diffDays(start, end) + 1;

    const computedList: ComputedTask[] = tasks
      .filter((t) => t.due_date)
      .map((t) => {
        const due = startOfDay(new Date(t.due_date!));
        const spanFromEstimate = t.estimated_hours ? Math.max(1, Math.ceil(t.estimated_hours / 8)) : 1;
        const span = Math.min(spanFromEstimate, total);
        const startOffset = Math.max(0, diffDays(start, due) - (span - 1));
        return { task: t, startOffset, spanDays: span };
      })
      .sort((a, b) => a.startOffset - b.startOffset);

    return { rangeStart: start, totalDays: total, computed: computedList };
  }, [tasks, projectStart, projectEnd]);

  // Build date headers
  const days: Date[] = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < totalDays; i++) {
      arr.push(new Date(rangeStart.getTime() + i * DAY_MS));
    }
    return arr;
  }, [rangeStart, totalDays]);

  const monthSpans: Array<{ label: string; span: number }> = useMemo(() => {
    const spans: Array<{ label: string; span: number }> = [];
    let current: { label: string; span: number } | null = null;
    for (const d of days) {
      const label = formatMonth(d);
      if (!current || current.label !== label) {
        if (current) spans.push(current);
        current = { label, span: 1 };
      } else {
        current.span += 1;
      }
    }
    if (current) spans.push(current);
    return spans;
  }, [days]);

  if (computed.length === 0) {
    return (
      <div className="rounded-md border bg-card p-8 text-center text-sm text-muted-foreground">
        Nessun task con data di scadenza. Imposta una <code>due_date</code> sui task per vederli in Gantt.
      </div>
    );
  }

  const COL_WIDTH = 36; // px per day
  const LABEL_WIDTH = 240;
  const todayOffset = diffDays(rangeStart, new Date());
  const showToday = todayOffset >= 0 && todayOffset < totalDays;

  return (
    <div className="rounded-md border bg-card overflow-auto">
      <div style={{ minWidth: LABEL_WIDTH + totalDays * COL_WIDTH }}>
        {/* Month row */}
        <div className="flex border-b bg-muted/40 sticky top-0 z-10">
          <div style={{ width: LABEL_WIDTH }} className="shrink-0 border-r px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Task
          </div>
          <div className="flex">
            {monthSpans.map((m, i) => (
              <div
                key={i}
                style={{ width: m.span * COL_WIDTH }}
                className="border-r px-2 py-2 text-xs font-medium text-foreground/80"
              >
                {m.label}
              </div>
            ))}
          </div>
        </div>

        {/* Day row */}
        <div className="flex border-b bg-muted/20">
          <div style={{ width: LABEL_WIDTH }} className="shrink-0 border-r" />
          <div className="flex relative">
            {days.map((d, i) => {
              const isWeekend = d.getDay() === 0 || d.getDay() === 6;
              const isToday = diffDays(new Date(), d) === 0;
              return (
                <div
                  key={i}
                  style={{ width: COL_WIDTH }}
                  className={cn(
                    'border-r text-center py-1 text-[10px]',
                    isWeekend ? 'bg-muted/50 text-muted-foreground' : 'text-muted-foreground',
                    isToday && 'bg-primary/10 text-primary font-semibold'
                  )}
                >
                  {formatDayShort(d)}
                </div>
              );
            })}
          </div>
        </div>

        {/* Rows */}
        <div className="relative">
          {showToday && (
            <div
              className="absolute top-0 bottom-0 w-px bg-primary/60 z-[5] pointer-events-none"
              style={{ left: LABEL_WIDTH + todayOffset * COL_WIDTH + COL_WIDTH / 2 }}
            />
          )}
          {computed.map((c) => {
            const barColor = STATUS_BAR_COLORS[c.task.status];
            return (
              <div key={c.task.id} className="flex border-b last:border-b-0 hover:bg-muted/30">
                {/* Label */}
                <button
                  type="button"
                  onClick={() => onItemClick?.(c.task)}
                  style={{ width: LABEL_WIDTH }}
                  className="shrink-0 border-r px-3 py-2 text-left text-xs truncate hover:text-foreground text-muted-foreground"
                  title={c.task.title}
                >
                  <span className="text-foreground">{c.task.title}</span>
                  <span className="ml-2 text-[10px]">
                    {TASK_STATUS_CONFIG[c.task.status]?.label}
                  </span>
                </button>

                {/* Timeline cell */}
                <div className="relative flex" style={{ height: 36 }}>
                  {days.map((d, i) => {
                    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                    return (
                      <div
                        key={i}
                        style={{ width: COL_WIDTH }}
                        className={cn('border-r', isWeekend && 'bg-muted/30')}
                      />
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => onItemClick?.(c.task)}
                    className={cn(
                      'absolute top-1/2 -translate-y-1/2 h-5 rounded-sm transition-all hover:h-6 hover:shadow-md cursor-pointer flex items-center px-1.5 text-[10px] text-white font-medium truncate',
                      barColor
                    )}
                    style={{
                      left: c.startOffset * COL_WIDTH + 2,
                      width: Math.max(20, c.spanDays * COL_WIDTH - 4),
                    }}
                  >
                    {c.spanDays > 2 && <span className="truncate">{c.task.title}</span>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
