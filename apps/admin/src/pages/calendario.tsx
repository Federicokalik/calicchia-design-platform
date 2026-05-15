import { useState, useRef, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventClickArg, DateSelectArg } from '@fullcalendar/core';
import {
  Clock, MapPin, X, Plus, Settings, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTopbar } from '@/hooks/use-topbar';
import { useI18n } from '@/hooks/use-i18n';
import { apiFetch } from '@/lib/api';
import EventoEditModal from '@/pages/calendario/evento-edit';
import { CalendarTabs } from '@/components/layout/calendar-tabs';

// Colors per source (fallback se evento non ha colore custom dal calendario)
const SOURCE_COLORS: Record<string, { backgroundColor: string; borderColor: string; textColor: string }> = {
  manual:  { backgroundColor: '#7c3aed', borderColor: '#6d28d9', textColor: '#fff' },
  booking: { backgroundColor: '#0ea5e9', borderColor: '#0284c7', textColor: '#fff' },
  admin:   { backgroundColor: '#7c3aed', borderColor: '#6d28d9', textColor: '#fff' },
  agent:   { backgroundColor: '#a855f7', borderColor: '#9333ea', textColor: '#fff' },
  mcp:     { backgroundColor: '#a855f7', borderColor: '#9333ea', textColor: '#fff' },
  project: { backgroundColor: '#f97316', borderColor: '#ea580c', textColor: '#fff' },
  domain:  { backgroundColor: '#ef4444', borderColor: '#dc2626', textColor: '#fff' },
  calcom:  { backgroundColor: '#94a3b8', borderColor: '#64748b', textColor: '#fff' },
};

const SOURCE_LABELS: Record<string, string> = {
  manual: 'Manuale',
  booking: 'Booking',
  admin: 'Admin',
  agent: 'Agente',
  mcp: 'MCP',
  project: 'Progetto',
  domain: 'Dominio',
  calcom: 'Cal.com (storico)',
};

interface CalendarApi {
  id: string;
  name: string;
  color: string;
}

interface CalendarEventOcc {
  id: string;
  uid: string;
  calendar_id: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  source: string;
  source_id: string | null;
  status: string;
  original_start: string | null;
  is_override: boolean;
}

export default function CalendarioPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { intlLocale, locale } = useI18n();
  const calendarRef = useRef<FullCalendar>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventOcc | null>(null);
  const [editingEvent, setEditingEvent] = useState<CalendarEventOcc | null>(null);
  const [creatingFromSlot, setCreatingFromSlot] = useState<{ start: string; end: string } | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string } | null>(null);

  // Caldes Calendar — eventi multi-calendario (sostituisce Google Calendar)
  const { data: eventsData } = useQuery({
    queryKey: ['admin-calendar-events', dateRange?.start, dateRange?.end],
    queryFn: async () => {
      if (!dateRange) return { events: [] };
      const params = new URLSearchParams({ from: dateRange.start, to: dateRange.end });
      try {
        return await apiFetch(`/api/admin/calendar/events?${params}`);
      } catch { return { events: [] }; }
    },
    enabled: !!dateRange,
  });

  // Calendari per colore + lookup
  const { data: calData } = useQuery({
    queryKey: ['admin-calendars'],
    queryFn: () => apiFetch('/api/admin/calendar/calendars'),
  });
  const calendars: CalendarApi[] = calData?.calendars || [];
  const calendarById = new Map(calendars.map((c) => [c.id, c]));

  // Cal.com bookings (storico legacy, mostrati solo se presenti)
  const { data: calcomData } = useQuery({
    queryKey: ['calcom-bookings', dateRange?.start, dateRange?.end],
    queryFn: async () => {
      if (!dateRange) return { bookings: [] };
      const params = new URLSearchParams({ after_start: dateRange.start, before_end: dateRange.end, limit: '100' });
      try {
        return await apiFetch(`/api/calcom/bookings?${params}`);
      } catch { return { bookings: [] }; }
    },
    enabled: !!dateRange,
  });

  // Projects (for start/end dates)
  const { data: projectsData } = useQuery({
    queryKey: ['projects-calendar'],
    queryFn: async () => {
      try {
        return await apiFetch('/api/client-projects?limit=50');
      } catch { return { projects: [] }; }
    },
  });

  // Domains (for expiry dates)
  const { data: domainsData } = useQuery({
    queryKey: ['domains-calendar'],
    queryFn: async () => {
      try {
        return await apiFetch('/api/domains');
      } catch { return { domains: [] }; }
    },
  });

  // Build events array
  const calendarEvents = (() => {
    const events: any[] = [];

    // Caldes Calendar — eventi multi-calendario (sostituisce Google Calendar)
    for (const ev of (eventsData?.events || []) as CalendarEventOcc[]) {
      const cal = calendarById.get(ev.calendar_id);
      const sourceColor = SOURCE_COLORS[ev.source] || SOURCE_COLORS.manual;
      events.push({
        id: `event-${ev.id}-${ev.start_time}`,
        title: ev.summary,
        start: ev.start_time,
        end: ev.end_time,
        allDay: ev.all_day,
        backgroundColor: cal?.color || sourceColor.backgroundColor,
        borderColor: cal?.color || sourceColor.borderColor,
        textColor: '#fff',
        extendedProps: { source: ev.source, data: ev, calendar: cal },
      });
    }

    // Cal.com storico (se ancora presente nel DB legacy)
    for (const b of calcomData?.bookings || []) {
      if (b.status === 'cancelled') continue;
      events.push({
        id: `calcom-${b.id}`,
        title: `[Cal.com] ${b.title}`,
        start: b.start_time,
        end: b.end_time,
        allDay: false,
        ...SOURCE_COLORS.calcom,
        extendedProps: { source: 'calcom', data: b },
      });
    }

    // Projects (start → end as background bars)
    for (const p of projectsData?.projects || []) {
      if (!p.start_date) continue;
      events.push({
        id: `proj-${p.id}`,
        title: `📐 ${p.name}`,
        start: p.start_date,
        end: p.target_end_date || p.start_date,
        allDay: true,
        ...SOURCE_COLORS.project,
        extendedProps: { source: 'project', data: p },
      });
    }

    // Domains (expiry as single-day event)
    for (const d of domainsData?.domains || []) {
      if (!d.expiry_date) continue;
      events.push({
        id: `domain-${d.id}`,
        title: `🌐 ${d.domain_name} scade`,
        start: d.expiry_date,
        allDay: true,
        ...SOURCE_COLORS.domain,
        extendedProps: { source: 'domain', data: d },
      });
    }

    return events;
  })();

  const handleEventClick = (info: EventClickArg) => {
    const { data, source } = info.event.extendedProps;
    setSelectedEvent(data);
    // Per eventi calendar interni: apri editor cliccando "Modifica" nel pannello dettaglio
    if (['manual', 'admin', 'agent', 'mcp', 'booking'].includes(source)) {
      // resta sul pannello detail; user può cliccare Edit
    }
  };

  const handleDateSelect = (selectInfo: DateSelectArg) => {
    setCreatingFromSlot({ start: selectInfo.startStr, end: selectInfo.endStr });
    setEditingEvent(null);
    setShowEditor(true);
  };

  const handleDatesSet = (dateInfo: { startStr: string; endStr: string }) => {
    setDateRange({ start: dateInfo.startStr, end: dateInfo.endStr });
  };

  const topbarActions = useMemo(() => (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => navigate('/calendario/calendari')}>
        <Settings className="h-3.5 w-3.5 mr-1.5" /> Calendari
      </Button>
      <Button size="sm" onClick={() => { setEditingEvent(null); setCreatingFromSlot(null); setShowEditor(true); }}>
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Nuovo evento
      </Button>
    </div>
  ), [navigate]);

  useTopbar({
    title: 'Calendario',
    subtitle: 'Caldes Calendar — eventi multi-calendario self-hosted',
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      <CalendarTabs />

      {/* Modale crea/edit evento */}
      {showEditor && (
        <EventoEditModal
          initial={editingEvent}
          initialStart={creatingFromSlot?.start}
          initialEnd={creatingFromSlot?.end}
          onClose={() => { setShowEditor(false); setEditingEvent(null); setCreatingFromSlot(null); }}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
          }}
        />
      )}

      {/* Legend — mostra calendari + sources speciali */}
      <div className="flex flex-wrap items-center gap-3">
        {calendars.map((cal) => (
          <div key={cal.id} className="flex items-center gap-1.5">
            <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: cal.color }} />
            <span className="text-xs text-muted-foreground">{cal.name}</span>
          </div>
        ))}
        {(['project', 'domain', 'calcom'] as const).map((key) => (
          <div key={key} className="flex items-center gap-1.5">
            <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SOURCE_COLORS[key].backgroundColor }} />
            <span className="text-xs text-muted-foreground">{SOURCE_LABELS[key]}</span>
          </div>
        ))}
      </div>

      {/* Calendar + Detail */}
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="rounded-lg border bg-card p-4">
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="timeGridWeek"
            headerToolbar={{
              left: 'prev,next today',
              center: 'title',
              right: 'dayGridMonth,timeGridWeek,timeGridDay',
            }}
            locale={locale}
            firstDay={1}
            height="auto"
            events={calendarEvents}
            eventClick={handleEventClick}
            datesSet={handleDatesSet}
            select={handleDateSelect}
            selectable
            selectMirror
            buttonText={locale === 'en'
              ? { today: 'Today', month: 'Month', week: 'Week', day: 'Day' }
              : { today: 'Oggi', month: 'Mese', week: 'Settimana', day: 'Giorno' }}
            dayMaxEvents={3}
            eventTimeFormat={{ hour: '2-digit', minute: '2-digit', meridiem: false }}
          />
        </div>

        {/* Event detail */}
        <div className="space-y-3">
          {selectedEvent ? (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between">
                <h3 className="text-sm font-semibold">
                  {selectedEvent.summary}
                </h3>
                <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setSelectedEvent(null)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              {selectedEvent.source && (
                <Badge variant="outline" className="text-[10px]">
                  {SOURCE_LABELS[selectedEvent.source] || selectedEvent.source}
                </Badge>
              )}

              <div className="flex items-center gap-2 text-xs">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <div>{new Date(selectedEvent.start_time).toLocaleDateString(intlLocale, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
                  <div className="text-muted-foreground">
                    {selectedEvent.all_day ? 'Tutto il giorno' : (
                      <>
                        {new Date(selectedEvent.start_time).toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' })}
                        {' — '}
                        {new Date(selectedEvent.end_time).toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' })}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {selectedEvent.location && (
                <div className="flex items-center gap-2 text-xs">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{selectedEvent.location}</span>
                </div>
              )}

              {selectedEvent.url && (
                <a href={selectedEvent.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-primary hover:underline">
                  <ExternalLink className="h-3.5 w-3.5" /> {selectedEvent.url}
                </a>
              )}

              {selectedEvent.description && (
                <p className="text-xs text-muted-foreground whitespace-pre-wrap">{selectedEvent.description}</p>
              )}

              {/* Edit button — solo per eventi del nuovo sistema, no per legacy calcom */}
              {selectedEvent.id && selectedEvent.uid && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full text-xs"
                  onClick={() => {
                    setEditingEvent(selectedEvent);
                    setCreatingFromSlot(null);
                    setShowEditor(true);
                    setSelectedEvent(null);
                  }}
                >
                  Modifica evento
                </Button>
              )}
            </div>
          ) : (
            <div className="rounded-lg border bg-card flex flex-col items-center justify-center py-12 text-center">
              <Clock className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-xs text-muted-foreground">Clicca un evento o seleziona uno slot vuoto</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
