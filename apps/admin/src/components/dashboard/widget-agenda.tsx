import { useQuery } from '@tanstack/react-query';
import { Calendar, Video, CheckSquare, FolderKanban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';

interface AgendaItem {
  id: string;
  time: string;
  title: string;
  type: 'booking' | 'task' | 'project';
  meta?: string;
}

const typeConfig = {
  booking: { icon: Video, color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  task: { icon: CheckSquare, color: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  project: { icon: FolderKanban, color: 'bg-purple-500/10 text-purple-600 dark:text-purple-400' },
};

export function WidgetAgenda() {
  const { t, formatDate, formatDateTime } = useI18n();
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();

  // Caldes Calendar — eventi multi-calendario di oggi (sostituisce Google Calendar + Cal.com)
  const { data: eventsData } = useQuery({
    queryKey: ['agenda-events', todayStart],
    queryFn: async () => {
      try {
        return await apiFetch(`/api/admin/calendar/events?from=${todayStart}&to=${todayEnd}`);
      } catch { return { events: [] }; }
    },
  });

  // Fetch tasks due today
  const { data: tasksData } = useQuery({
    queryKey: ['agenda-tasks', todayStart],
    queryFn: async () => {
      try {
        const todayDate = today.toISOString().split('T')[0];
        return await apiFetch(`/api/project-tasks?due_date=${todayDate}&limit=20`);
      } catch { return { tasks: [] }; }
    },
  });

  // Build agenda items
  const items: AgendaItem[] = [];

  // Eventi calendario interno (sostituisce Google + Cal.com)
  for (const ev of eventsData?.events || []) {
    if (ev.status === 'cancelled') continue;
    items.push({
      id: `event-${ev.id}-${ev.start_time}`,
      time: ev.all_day ? t('common.allDay') : formatDateTime(ev.start_time, { hour: '2-digit', minute: '2-digit' }),
      title: ev.summary,
      type: 'booking',
      meta: ev.location || (ev.url ? t('common.online') : undefined),
    });
  }

  // Tasks due today
  for (const t of tasksData?.tasks || []) {
    if (t.status === 'done') continue;
    items.push({
      id: `task-${t.id}`,
      time: t.due_date ? formatDateTime(t.due_date, { hour: '2-digit', minute: '2-digit' }) : '-',
      title: t.title,
      type: 'task',
      meta: t.project_name || undefined,
    });
  }

  // Sort by time
  items.sort((a, b) => a.time.localeCompare(b.time));

  const dateStr = formatDate(today, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('dashboard.widgets.agenda.title')}</h3>
        <span className="text-xs text-muted-foreground capitalize">{dateStr}</span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-4">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Calendar className="h-8 w-8 text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">{t('dashboard.widgets.agenda.empty')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const config = typeConfig[item.type];
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-3 rounded-lg p-2.5 hover:bg-muted/50 transition-colors"
                >
                  <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', config.color)}>
                    <config.icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">{item.time}</span>
                      {item.meta && (
                        <span className="text-xs text-muted-foreground">· {item.meta}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
