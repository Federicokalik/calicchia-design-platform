import { useMemo } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventClickArg, EventInput } from '@fullcalendar/core';
import type { ProjectTask, TaskStatus } from '@/types/projects';
import { useI18n } from '@/hooks/use-i18n';

interface TaskCalendarViewProps {
  tasks: ProjectTask[];
  onItemClick?: (task: ProjectTask) => void;
}

const STATUS_COLORS: Record<TaskStatus, { bg: string; border: string; text: string }> = {
  todo: { bg: '#e2e8f0', border: '#cbd5e1', text: '#334155' },
  in_progress: { bg: '#3b82f6', border: '#2563eb', text: '#fff' },
  review: { bg: '#f59e0b', border: '#d97706', text: '#fff' },
  done: { bg: '#22c55e', border: '#16a34a', text: '#fff' },
  blocked: { bg: '#ef4444', border: '#dc2626', text: '#fff' },
};

export function TaskCalendarView({ tasks, onItemClick }: TaskCalendarViewProps) {
  const { locale } = useI18n();
  const events: EventInput[] = useMemo(() => {
    return tasks
      .filter((t) => t.due_date)
      .map((t) => {
        const colors = STATUS_COLORS[t.status];
        return {
          id: t.id,
          title: t.title,
          start: t.due_date!,
          allDay: true,
          backgroundColor: colors.bg,
          borderColor: colors.border,
          textColor: colors.text,
          extendedProps: { task: t },
        };
      });
  }, [tasks]);

  const handleEventClick = (info: EventClickArg) => {
    const task = info.event.extendedProps.task as ProjectTask | undefined;
    if (task && onItemClick) onItemClick(task);
  };

  return (
    <div className="rounded-md border bg-card p-3 fc-themed">
      <FullCalendar
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{
          left: 'prev,next today',
          center: 'title',
          right: 'dayGridMonth,timeGridWeek',
        }}
        locale={locale}
        firstDay={1}
        height="auto"
        events={events}
        eventClick={handleEventClick}
        eventDisplay="block"
        dayMaxEvents={4}
        buttonText={{
          today: locale === 'en' ? 'Today' : 'Oggi',
          month: locale === 'en' ? 'Month' : 'Mese',
          week: locale === 'en' ? 'Week' : 'Settimana',
        }}
        noEventsText={locale === 'en' ? 'No tasks with deadlines' : 'Nessun task con scadenza'}
      />
    </div>
  );
}
