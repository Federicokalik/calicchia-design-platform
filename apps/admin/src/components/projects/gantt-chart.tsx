import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ClientProjectView } from '@/types/projects';
import { PROJECT_STATUS_CONFIG } from '@/types/projects';

type ZoomLevel = 'week' | 'month' | 'quarter';

interface GanttChartProps {
  projects: ClientProjectView[];
}

const ZOOM_CONFIG: Record<ZoomLevel, { label: string; daysVisible: number; cellDays: number }> = {
  week: { label: 'Settimana', daysVisible: 56, cellDays: 7 },
  month: { label: 'Mese', daysVisible: 180, cellDays: 30 },
  quarter: { label: 'Trimestre', daysVisible: 365, cellDays: 91 },
};

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function formatHeader(date: Date, zoom: ZoomLevel): string {
  if (zoom === 'week') {
    return date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  }
  if (zoom === 'month') {
    return date.toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
  }
  const q = Math.ceil((date.getMonth() + 1) / 3);
  return `Q${q} ${date.getFullYear().toString().slice(2)}`;
}

const statusBarColors: Record<string, string> = {
  draft: 'bg-slate-400',
  proposal: 'bg-purple-400',
  approved: 'bg-blue-400',
  in_progress: 'bg-amber-500',
  review: 'bg-orange-400',
  completed: 'bg-emerald-500',
  on_hold: 'bg-zinc-400',
  cancelled: 'bg-red-400',
};

export function GanttChart({ projects }: GanttChartProps) {
  const navigate = useNavigate();
  const [zoom, setZoom] = useState<ZoomLevel>('month');
  const [offsetDays, setOffsetDays] = useState(0);

  const config = ZOOM_CONFIG[zoom];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const viewStart = addDays(today, offsetDays - 14); // start 2 weeks before offset
  const viewEnd = addDays(viewStart, config.daysVisible);
  const totalDays = config.daysVisible;

  // Generate time cells
  const cells = useMemo(() => {
    const result: { date: Date; label: string }[] = [];
    let current = new Date(viewStart);
    while (current < viewEnd) {
      result.push({ date: new Date(current), label: formatHeader(current, zoom) });
      current = addDays(current, config.cellDays);
    }
    return result;
  }, [viewStart.getTime(), zoom]);

  // Today line position
  const todayOffset = diffDays(viewStart, today);
  const todayPercent = (todayOffset / totalDays) * 100;

  const scroll = (dir: 'left' | 'right') => {
    setOffsetDays((d) => d + (dir === 'right' ? config.cellDays * 3 : -config.cellDays * 3));
  };

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => scroll('left')}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOffsetDays(0)}>
          Oggi
        </Button>
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => scroll('right')}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <div className="ml-auto flex gap-1">
          {(Object.keys(ZOOM_CONFIG) as ZoomLevel[]).map((z) => (
            <Button
              key={z}
              variant={zoom === z ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setZoom(z)}
            >
              {ZOOM_CONFIG[z].label}
            </Button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="rounded-lg border bg-card overflow-hidden">
        {/* Header */}
        <div className="flex border-b bg-muted/50">
          <div className="w-[220px] shrink-0 px-3 py-2 text-xs font-medium text-muted-foreground border-r">
            Progetto
          </div>
          <div className="flex-1 flex relative">
            {cells.map((cell, i) => (
              <div
                key={i}
                className="flex-1 px-1 py-2 text-center text-[10px] font-medium text-muted-foreground border-r last:border-r-0 truncate"
              >
                {cell.label}
              </div>
            ))}
          </div>
        </div>

        {/* Rows */}
        {projects.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            Nessun progetto
          </div>
        ) : (
          projects.map((project) => {
            const start = project.start_date ? new Date(project.start_date) : today;
            const end = project.target_end_date ? new Date(project.target_end_date) : addDays(start, 30);

            const barStart = Math.max(0, diffDays(viewStart, start));
            const barEnd = Math.min(totalDays, diffDays(viewStart, end));
            const barLeft = (barStart / totalDays) * 100;
            const barWidth = Math.max(1, ((barEnd - barStart) / totalDays) * 100);
            const isVisible = barEnd > 0 && barStart < totalDays;

            const statusCfg = PROJECT_STATUS_CONFIG[project.status];

            return (
              <div
                key={project.id}
                className="flex border-b last:border-b-0 hover:bg-muted/20 cursor-pointer transition-colors group"
                onClick={() => navigate(`/progetti/${project.id}`)}
              >
                {/* Project name */}
                <div className="w-[220px] shrink-0 px-3 py-2.5 border-r">
                  <p className="text-sm font-medium truncate">{project.name}</p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {project.customer_name || 'Nessun cliente'}
                    {' · '}
                    <span className={statusCfg?.color}>{statusCfg?.label}</span>
                  </p>
                </div>

                {/* Timeline bar */}
                <div className="flex-1 relative py-2.5 px-1">
                  {/* Grid lines */}
                  <div className="absolute inset-0 flex">
                    {cells.map((_, i) => (
                      <div key={i} className="flex-1 border-r last:border-r-0 border-border/30" />
                    ))}
                  </div>

                  {/* Today line */}
                  {todayPercent >= 0 && todayPercent <= 100 && (
                    <div
                      className="absolute top-0 bottom-0 w-px bg-primary/50 z-10"
                      style={{ left: `${todayPercent}%` }}
                    />
                  )}

                  {/* Bar */}
                  {isVisible && (
                    <div
                      className={cn(
                        'absolute top-1/2 -translate-y-1/2 h-6 rounded-md z-20 transition-all',
                        statusBarColors[project.status] || 'bg-primary',
                        'group-hover:h-7 group-hover:shadow-md',
                      )}
                      style={{ left: `${barLeft}%`, width: `${barWidth}%`, minWidth: '8px' }}
                    >
                      {/* Progress fill */}
                      {project.progress_percentage > 0 && (
                        <div
                          className="h-full rounded-md bg-white/20"
                          style={{ width: `${project.progress_percentage}%` }}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
