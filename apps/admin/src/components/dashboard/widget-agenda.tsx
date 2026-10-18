import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Calendar, Video, CheckSquare, FolderKanban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import {
  CALENDAR_TZ,
  addDaysToDate,
  isoToZonedDate,
  zonedDateToIso,
  zonedDayWindow,
} from '@/lib/timezone';
import { listOccurrencesV2, listOverlaysV2, useCalendarV2Capabilities } from '@/lib/calendar-v2-api';
import { useI18n } from '@/hooks/use-i18n';

interface AgendaItem {
  id: string;
  /** Istante di ordinamento (ms): i task senza orario valgono la mezzanotte del giorno, quindi precedono gli eventi dello stesso giorno. */
  sortMs: number;
  /** Giorno Europe/Rome (YYYY-MM-DD). */
  day: string;
  allDay: boolean;
  /** Orario di inizio (ISO) degli eventi con orario. */
  startIso?: string;
  title: string;
  type: 'booking' | 'task' | 'project';
  meta?: string;
  done?: boolean;
}

const typeConfig = {
  booking: { icon: Video, color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  task: { icon: CheckSquare, color: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  project: { icon: FolderKanban, color: 'bg-purple-500/10 text-purple-600 dark:text-purple-400' },
};

type AgendaWindow = 'today' | 'tomorrow' | 'week';

const WINDOW_DAYS: Record<AgendaWindow, { offset: number; days: number }> = {
  today: { offset: 0, days: 1 },
  tomorrow: { offset: 1, days: 1 },
  week: { offset: 0, days: 7 },
};

/** Elementi mostrati per volta; "Mostra altri" ne aggiunge altrettanti. */
const PAGE_SIZE = 8;
/** Task caricati per richiesta (l'API ne accetta al massimo 200). */
const TASK_PAGE_SIZE = 50;

interface AgendaEvent {
  id: string;
  start: string;
  end: string;
  allDay: boolean;
  /** Per gli all-day: primo giorno (YYYY-MM-DD) già nel fuso del calendario. */
  startDate: string | null;
  title: string;
  location: string | null;
  url: string | null;
}

export function WidgetAgenda() {
  const { t, formatDate, formatDateTime } = useI18n();
  const { caps } = useCalendarV2Capabilities();
  // Con le occorrenze v2 gli eventi arrivano da /occurrences e /overlays, altrimenti da /events v1.
  const useOccurrences = !!caps?.occurrences;
  const [win, setWin] = useState<AgendaWindow>('today');
  const [visible, setVisible] = useState(PAGE_SIZE);

  // Finestra nel fuso del calendario (Europe/Rome), non in quello del browser.
  const todayLocal = zonedDayWindow(new Date()).dateLocal;
  const { offset, days } = WINDOW_DAYS[win];
  const firstDay = addDaysToDate(todayLocal, offset);
  const lastDay = addDaysToDate(firstDay, days - 1);
  const fromIso = zonedDateToIso(firstDay);
  const toIso = zonedDateToIso(addDaysToDate(lastDay, 1));

  const changeWindow = (next: AgendaWindow) => {
    setWin(next);
    setVisible(PAGE_SIZE);
  };

  // Caldes Calendar — eventi multi-calendario della finestra (sostituisce Google Calendar + Cal.com)
  const { data: events = [], isLoading: eventsLoading } = useQuery({
    queryKey: ['agenda-events', useOccurrences ? 'v2' : 'v1', fromIso, toIso],
    queryFn: async (): Promise<AgendaEvent[]> => {
      if (useOccurrences) {
        const [occ, overlays] = await Promise.all([
          listOccurrencesV2({ from: fromIso, to: toIso }),
          listOverlaysV2({ from: fromIso, to: toIso }),
        ]);
        return [
          ...occ.occurrences
            .filter((o) => o.status !== 'cancelled')
            .map((o) => ({
              id: `${o.object_id}-${o.recurrence_key}-${o.start_utc}`,
              start: o.start_utc,
              end: o.end_utc,
              allDay: o.all_day,
              startDate: o.start_date,
              title: o.summary ?? '',
              location: o.location,
              url: null,
            })),
          ...overlays.items.map((o) => ({
            id: `overlay-${o.object_id}-${o.recurrence_key}-${o.start_utc}`,
            start: o.start_utc,
            end: o.end_utc,
            allDay: o.all_day,
            startDate: o.start_date,
            title: o.summary ?? '',
            location: null,
            url: null,
          })),
        ];
      }
      try {
        const data = await apiFetch(`/api/admin/calendar/events?from=${fromIso}&to=${toIso}`);
        return ((data?.events || []) as Array<Record<string, any>>)
          .filter((ev) => ev.status !== 'cancelled')
          .map((ev) => ({
            id: `event-${ev.id}-${ev.start_time}`,
            start: ev.start_time,
            end: ev.end_time,
            allDay: !!ev.all_day,
            startDate: null,
            title: ev.summary,
            location: ev.location ?? null,
            url: ev.url ?? null,
          }));
      } catch { return []; }
    },
    staleTime: 30_000,
  });

  // Task con scadenza nella finestra: pagine successive su richiesta, conteggio vero dall'API.
  const tasksQuery = useInfiniteQuery({
    queryKey: ['agenda-tasks', firstDay, lastDay],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      try {
        const q = new URLSearchParams({
          due_from: firstDay, due_to: lastDay, limit: String(TASK_PAGE_SIZE), offset: String(pageParam),
        });
        return await apiFetch(`/api/project-tasks?${q}`) as { tasks?: Array<Record<string, any>>; count?: number };
      } catch { return { tasks: [], count: 0 }; }
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + (p.tasks?.length ?? 0), 0);
      return (last.tasks?.length ?? 0) > 0 && loaded < (last.count ?? 0) ? loaded : undefined;
    },
    staleTime: 30_000,
  });

  const tasks = useMemo(() => tasksQuery.data?.pages.flatMap((p) => p.tasks ?? []) ?? [], [tasksQuery.data]);
  const tasksTotal = Math.max(tasksQuery.data?.pages[0]?.count ?? 0, tasks.length);

  // Elementi della finestra, in ordine cronologico.
  const items = useMemo(() => {
    const out: AgendaItem[] = [];
    for (const ev of events) {
      const startMs = new Date(ev.start).getTime();
      const day = ev.allDay ? (ev.startDate ?? isoToZonedDate(ev.start)) : isoToZonedDate(ev.start);
      out.push({
        id: ev.id,
        sortMs: ev.allDay ? new Date(zonedDateToIso(day)).getTime() : startMs,
        day: day < firstDay ? firstDay : day,
        allDay: ev.allDay,
        startIso: ev.allDay ? undefined : ev.start,
        title: ev.title,
        type: 'booking',
        meta: ev.location || (ev.url ? t('common.online') : undefined),
      });
    }
    for (const task of tasks) {
      if (!task.due_date) continue;
      const day = String(task.due_date).slice(0, 10);
      out.push({
        id: `task-${task.id}`,
        // due_date è una colonna date (senza orario): è un impegno "tutto il giorno"
        sortMs: new Date(zonedDateToIso(day)).getTime(),
        day,
        allDay: true,
        title: task.title,
        type: 'task',
        meta: task.project_name || undefined,
        done: task.status === 'done',
      });
    }
    out.sort((a, b) => a.sortMs - b.sortMs || a.title.localeCompare(b.title));
    return out;
  }, [events, tasks, firstDay, t]);

  const total = events.length + tasksTotal;
  const shown = items.slice(0, visible);
  const remaining = Math.max(0, total - shown.length);

  // Se servono più task di quelli caricati, carica la pagina successiva.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = tasksQuery;
  useEffect(() => {
    if (items.length < visible && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [items.length, visible, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const dateStr = formatDate(zonedDateToIso(firstDay), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: CALENDAR_TZ,
  });

  const timeLabel = (item: AgendaItem): string => {
    const time = item.allDay
      ? t('common.allDay')
      : formatDateTime(item.startIso!, { hour: '2-digit', minute: '2-digit', timeZone: CALENDAR_TZ });
    if (days === 1) return time;
    const dayLabel = formatDate(zonedDateToIso(item.day), { weekday: 'short', day: 'numeric', month: 'short', timeZone: CALENDAR_TZ });
    return `${dayLabel} · ${time}`;
  };

  const emptyKey = win === 'today'
    ? 'dashboard.widgets.agenda.empty'
    : win === 'tomorrow' ? 'dashboard.widgets.agenda.emptyTomorrow' : 'dashboard.widgets.agenda.emptyWeek';
  const loading = eventsLoading || tasksQuery.isLoading;

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-2">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('dashboard.widgets.agenda.title')}</h3>
        <span className="text-xs text-muted-foreground capitalize">{days === 1 ? dateStr : t('dashboard.widgets.agenda.week')}</span>
        <div className="ml-auto flex gap-1" role="group" aria-label={t('dashboard.widgets.agenda.window')}>
          {(['today', 'tomorrow', 'week'] as const).map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`cal-agenda-window-${key}`}
              aria-pressed={win === key}
              onClick={() => changeWindow(key)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent',
                win === key && 'bg-accent font-medium',
              )}
            >
              {t(`dashboard.widgets.agenda.window.${key}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-4">
        {!loading && total === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Calendar className="h-8 w-8 text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">{t(emptyKey)}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {shown.map((item) => {
              const config = typeConfig[item.type];
              return (
                <div
                  key={item.id}
                  className={cn(
                    'flex items-start gap-3 rounded-lg p-2.5 hover:bg-muted/50 transition-colors',
                    item.done && 'opacity-60',
                  )}
                >
                  <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', config.color)}>
                    <config.icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={cn('text-sm font-medium truncate', item.done && 'line-through')}>{item.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">{timeLabel(item)}</span>
                      {item.meta && (
                        <span className="text-xs text-muted-foreground">· {item.meta}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {remaining > 0 && (
              <button
                type="button"
                data-testid="cal-agenda-more"
                disabled={isFetchingNextPage}
                onClick={() => setVisible((v) => v + PAGE_SIZE)}
                className="w-full rounded-lg border border-dashed py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 disabled:opacity-60"
              >
                {t('dashboard.widgets.agenda.more', { count: remaining })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
