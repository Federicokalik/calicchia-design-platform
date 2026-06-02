import { useState, useRef, useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventClickArg, DateSelectArg, EventMountArg, EventDropArg } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import {
  Clock, MapPin, X, Plus, Settings, ExternalLink, Copy, Pencil, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FloatingActionMenu } from '@/components/ui/floating-action-menu';
import type { RowAction } from '@/components/ui/row-context-menu';
import { useTopbar } from '@/hooks/use-topbar';
import { useI18n } from '@/hooks/use-i18n';
import { apiFetch } from '@/lib/api';
import { useConfirm } from '@/hooks/use-confirm';
import EventoEditModal from '@/pages/calendario/evento-edit';
import { CalendarTabs } from '@/components/layout/calendar-tabs';

// Source di eventi su cui sono permesse modifiche dirette dal calendario
// (duplicate, edit, delete). Project/domain/calcom sono read-only aggregati.
const EDITABLE_SOURCES = new Set(['manual', 'admin', 'agent', 'mcp', 'booking']);

// Source trascinabili/ridimensionabili. 'booking' è escluso: spostare l'evento
// NON aggiornerebbe la prenotazione né avviserebbe il partecipante (desync).
const DRAGGABLE_SOURCES = new Set(['manual', 'admin', 'agent', 'mcp']);

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
  const confirm = useConfirm();
  const { intlLocale, locale } = useI18n();
  const calendarRef = useRef<FullCalendar>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventOcc | null>(null);
  const [editingEvent, setEditingEvent] = useState<CalendarEventOcc | null>(null);
  const [creatingFromSlot, setCreatingFromSlot] = useState<{ start: string; end: string } | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ event: CalendarEventOcc; x: number; y: number } | null>(null);
  // Scelta "questa occorrenza / tutta la serie" per eventi ricorrenti.
  const [recurringAction, setRecurringAction] = useState<{
    kind: 'move' | 'resize' | 'delete';
    data: CalendarEventOcc;
    startIso?: string;
    endIso?: string;
    revert?: () => void;
  } | null>(null);

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
        editable: DRAGGABLE_SOURCES.has(ev.source),
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
        editable: false,
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
        editable: false,
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
        editable: false,
        ...SOURCE_COLORS.domain,
        extendedProps: { source: 'domain', data: d },
      });
    }

    return events;
  })();

  // Una "occorrenza ricorrente" è un'istanza espansa da un master (ha
  // original_start e NON è un override già materializzato come riga a sé).
  const isRecurringOccurrence = (ev: CalendarEventOcc) => !!ev.original_start && !ev.is_override;

  // Drag (sposta) + resize (cambia durata: verticale in settimana/giorno,
  // orizzontale in mese). Per gli eventi ricorrenti apre la scelta
  // "questa / tutta la serie"; per singoli/override fa un PUT diretto.
  const applyMoveOrResize = async (kind: 'move' | 'resize', info: EventDropArg | EventResizeDoneArg) => {
    const source = info.event.extendedProps.source as string | undefined;
    const data = info.event.extendedProps.data as CalendarEventOcc | undefined;
    if (!source || !DRAGGABLE_SOURCES.has(source) || !data?.id || !info.event.start) {
      info.revert();
      return;
    }

    const startIso = info.event.start.toISOString();
    const endIso = info.event.end
      ? info.event.end.toISOString()
      : new Date(
          info.event.start.getTime() +
            (new Date(data.end_time).getTime() - new Date(data.start_time).getTime()),
        ).toISOString();

    if (isRecurringOccurrence(data)) {
      // Chiedi prima: solo questa o tutta la serie. Il revert resta disponibile
      // se l'utente annulla o l'operazione fallisce.
      setRecurringAction({ kind, data, startIso, endIso, revert: () => info.revert() });
      return;
    }

    try {
      await apiFetch(`/api/admin/calendar/events/${data.id}`, {
        method: 'PUT',
        body: JSON.stringify({ start_time: startIso, end_time: endIso }),
      });
      toast.success('Evento aggiornato');
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
    } catch (err) {
      info.revert();
      toast.error(err instanceof Error ? err.message : 'Spostamento non riuscito');
    }
  };

  const handleEventDrop = (info: EventDropArg) => { void applyMoveOrResize('move', info); };
  const handleEventResize = (info: EventResizeDoneArg) => { void applyMoveOrResize('resize', info); };

  // Applica l'azione ricorrente alla SOLA occorrenza (crea un'eccezione).
  const applyToThisOccurrence = async () => {
    const a = recurringAction;
    if (!a) return;
    try {
      const body: Record<string, unknown> = { original_start: a.data.original_start };
      if (a.kind === 'delete') body.status = 'cancelled';
      else { body.new_start = a.startIso; body.new_end = a.endIso; }
      await apiFetch(`/api/admin/calendar/events/${a.data.id}/exception`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      toast.success(a.kind === 'delete' ? 'Occorrenza eliminata' : 'Modificata solo questa occorrenza');
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      setSelectedEvent(null);
    } catch (err) {
      a.revert?.();
      toast.error(err instanceof Error ? err.message : 'Operazione non riuscita');
    } finally {
      setRecurringAction(null);
    }
  };

  // Applica l'azione ricorrente a TUTTA la serie (agisce sul master).
  const applyToWholeSeries = async () => {
    const a = recurringAction;
    if (!a) return;
    try {
      if (a.kind === 'delete') {
        await apiFetch(`/api/admin/calendar/events/${a.data.id}`, { method: 'DELETE' });
        toast.success('Serie eliminata');
      } else {
        const res = await apiFetch(`/api/admin/calendar/events/${a.data.id}`);
        const master = res?.event as { start_time: string; end_time: string } | undefined;
        if (!master) throw new Error('Evento master non trovato');
        const masterStart = new Date(master.start_time).getTime();
        const masterEnd = new Date(master.end_time).getTime();
        if (a.kind === 'move') {
          const delta = new Date(a.startIso!).getTime() - new Date(a.data.original_start!).getTime();
          await apiFetch(`/api/admin/calendar/events/${a.data.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              start_time: new Date(masterStart + delta).toISOString(),
              end_time: new Date(masterEnd + delta).toISOString(),
            }),
          });
          toast.success('Spostata tutta la serie');
        } else {
          const newDuration = new Date(a.endIso!).getTime() - new Date(a.startIso!).getTime();
          await apiFetch(`/api/admin/calendar/events/${a.data.id}`, {
            method: 'PUT',
            body: JSON.stringify({ end_time: new Date(masterStart + newDuration).toISOString() }),
          });
          toast.success('Durata aggiornata su tutta la serie');
        }
      }
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      setSelectedEvent(null);
    } catch (err) {
      a.revert?.();
      toast.error(err instanceof Error ? err.message : 'Operazione non riuscita');
    } finally {
      setRecurringAction(null);
    }
  };

  const cancelRecurringAction = () => {
    recurringAction?.revert?.();
    setRecurringAction(null);
  };

  const handleEventClick = (info: EventClickArg) => {
    const { data, source } = info.event.extendedProps;
    setSelectedEvent(data);
    // Per eventi calendar interni: apri editor cliccando "Modifica" nel pannello dettaglio
    if (EDITABLE_SOURCES.has(source)) {
      // resta sul pannello detail; user può cliccare Edit
    }
  };

  const duplicateMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/calendar/events/${id}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      toast.success('Evento duplicato');
      // Apri il modal sulla copia per consentire ritocchi immediati
      const copy = data?.event;
      if (copy) {
        setSelectedEvent(null);
        setEditingEvent(copy);
        setCreatingFromSlot(null);
        setShowEditor(true);
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore duplicazione'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/calendar/events/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      toast.success('Evento eliminato');
      setSelectedEvent(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore eliminazione'),
  });

  // Right-click su un evento → menu contestuale (solo per source editabili).
  const handleEventDidMount = (arg: EventMountArg) => {
    const source = arg.event.extendedProps.source as string | undefined;
    if (!source || !EDITABLE_SOURCES.has(source)) return;
    const data = arg.event.extendedProps.data as CalendarEventOcc | undefined;
    if (!data?.id || !data.uid) return;
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      setCtxMenu({ event: data, x: e.clientX, y: e.clientY });
    };
    arg.el.addEventListener('contextmenu', handler);
    (arg.el as HTMLElement & { __ctxHandler?: (e: MouseEvent) => void }).__ctxHandler = handler;
  };

  const handleEventWillUnmount = (arg: EventMountArg) => {
    const el = arg.el as HTMLElement & { __ctxHandler?: (e: MouseEvent) => void };
    if (el.__ctxHandler) {
      el.removeEventListener('contextmenu', el.__ctxHandler);
      delete el.__ctxHandler;
    }
  };

  // Right-click context menu actions per evento del calendario. Mirror delle
  // azioni del detail panel: Modifica / Duplica / Elimina.
  const buildEventActions = (ev: CalendarEventOcc): RowAction[] => [
    {
      label: 'Modifica',
      icon: Pencil,
      onClick: () => {
        setEditingEvent(ev);
        setCreatingFromSlot(null);
        setShowEditor(true);
        setSelectedEvent(null);
      },
    },
    {
      label: 'Duplica',
      icon: Copy,
      onClick: () => duplicateMutation.mutate(ev.id),
    },
    { divider: true },
    {
      label: 'Elimina',
      icon: Trash2,
      destructive: true,
      onClick: async () => {
        // Ricorrente → chiedi questa/serie; singolo → conferma semplice.
        if (isRecurringOccurrence(ev)) {
          setRecurringAction({ kind: 'delete', data: ev });
          return;
        }
        if (await confirm({ title: 'Eliminare questo evento?', variant: 'destructive' })) deleteMutation.mutate(ev.id);
      },
    },
  ];

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

      {/* Scelta questa-occorrenza / tutta-la-serie per eventi ricorrenti */}
      {recurringAction && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={cancelRecurringAction}>
          <div className="bg-card border rounded-lg shadow-lg max-w-sm w-full p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 className="font-semibold text-sm">
                {recurringAction.kind === 'delete' ? 'Eliminare evento ricorrente' : 'Modificare evento ricorrente'}
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                «{recurringAction.data.summary}» fa parte di una serie. A cosa applichi la modifica?
              </p>
            </div>
            <div className="grid gap-2">
              <Button
                variant={recurringAction.kind === 'delete' ? 'destructive' : 'default'}
                size="sm"
                onClick={applyToThisOccurrence}
              >
                Solo questa occorrenza
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={recurringAction.kind === 'delete' ? 'text-destructive' : ''}
                onClick={applyToWholeSeries}
              >
                Tutta la serie
              </Button>
              <Button variant="ghost" size="sm" onClick={cancelRecurringAction}>Annulla</Button>
            </div>
          </div>
        </div>
      )}

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
            eventDidMount={handleEventDidMount}
            eventWillUnmount={handleEventWillUnmount}
            datesSet={handleDatesSet}
            select={handleDateSelect}
            editable
            eventStartEditable
            eventDurationEditable
            eventResizableFromStart
            eventDrop={handleEventDrop}
            eventResize={handleEventResize}
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
          {ctxMenu && (
            <FloatingActionMenu
              actions={buildEventActions(ctxMenu.event)}
              x={ctxMenu.x}
              y={ctxMenu.y}
              onClose={() => setCtxMenu(null)}
            />
          )}

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

              {/* Action buttons — solo per eventi del nuovo sistema, no per legacy calcom/project/domain */}
              {selectedEvent.id && selectedEvent.uid && (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs"
                    onClick={() => {
                      setEditingEvent(selectedEvent);
                      setCreatingFromSlot(null);
                      setShowEditor(true);
                      setSelectedEvent(null);
                    }}
                  >
                    <Pencil className="h-3 w-3 mr-1.5" /> Modifica
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs"
                    disabled={duplicateMutation.isPending}
                    onClick={() => duplicateMutation.mutate(selectedEvent.id)}
                  >
                    <Copy className="h-3 w-3 mr-1.5" />
                    {duplicateMutation.isPending ? 'Duplico…' : 'Duplica'}
                  </Button>
                </div>
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
