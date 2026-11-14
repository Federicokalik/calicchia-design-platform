import { useState, useRef, useMemo } from 'react';
import { useQuery, useQueryClient, useMutation, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventClickArg, DateSelectArg, EventMountArg, EventDropArg, EventContentArg } from '@fullcalendar/core';
import type { EventResizeDoneArg, EventDragStopArg } from '@fullcalendar/interaction';
import {
  Clock, MapPin, X, Plus, Settings, ExternalLink, Copy, Pencil, Trash2, FolderInput,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FloatingActionMenu } from '@/components/ui/floating-action-menu';
import type { RowAction } from '@/components/ui/row-context-menu';
import { useTopbar } from '@/hooks/use-topbar';
import { useI18n } from '@/hooks/use-i18n';
import { apiFetch } from '@/lib/api';
import {
  CALENDAR_TZ,
  calendarDateToDay,
  calendarDateToIso,
  isoToCalendarAllDayEnd,
  isoToCalendarDate,
  zonedDateToIso,
} from '@/lib/timezone';
import { useConfirm } from '@/hooks/use-confirm';
import EventoEditModal from '@/pages/calendario/evento-edit';
import EventoEditor from '@/pages/calendario/evento/evento-editor';
import {
  CalV2ConflictError,
  calV2ErrorMessage,
  calV2Keys,
  deleteObjectV2,
  duplicateObjectV2,
  getObjectV2,
  listCalendarsV2,
  listOccurrencesV2,
  listOverlaysV2,
  moveObjectV2,
  patchObjectV2,
  useCalendarV2Capabilities,
} from '@/lib/calendar-v2-api';
import {
  allowedScopes,
  durationToMinutes,
  generateEventUid,
  minutesToDuration,
  rebaseAfterConflict,
  shiftTimeMinutes,
} from '@/lib/calendar-v2-model';
import { CAL_V2_ABSENT_TOKEN, CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS } from '@calicchia/shared';
import type {
  CalV2ComponentView,
  CalV2ObjectView,
  CalV2Occurrence,
  CalV2OccurrenceBadge,
  CalV2OccurrenceKind,
  CalV2Op,
  CalV2OverlayItem,
  CalV2PreconditionFailedBody,
  CalV2ReadonlyReason,
  CalV2Scope,
} from '@calicchia/shared';
import { CalendarTabs } from '@/components/layout/calendar-tabs';
import { ScopeDialog } from '@/components/calendar/scope-dialog';
import { ConflictDialog } from '@/components/calendar/conflict-dialog';
import { OccurrenceBadgeIcons, OccurrenceBadgeList } from '@/components/calendar/occurrence-badges';

// Source di eventi su cui sono permesse modifiche dirette dal calendario
// (duplicate, edit, delete). Project/domain/calcom sono read-only aggregati.
const EDITABLE_SOURCES = new Set(['manual', 'admin', 'agent', 'mcp', 'booking']);

// Source trascinabili/ridimensionabili. 'booking' è escluso: spostare l'evento
// NON aggiornerebbe la prenotazione né avviserebbe il partecipante (desync).
const DRAGGABLE_SOURCES = new Set(['manual', 'admin', 'agent', 'mcp']);

/**
 * Date per FullCalendar (che gira con timeZone 'UTC' e il wall-time di Roma,
 * vedi lib/timezone.ts): timed come istante convertito, all-day come giorni di
 * Roma con la fine esclusiva.
 */
function toCalendarRange(startIso: string, endIso: string, allDay: boolean): { start: string; end: string } {
  return allDay
    ? { start: isoToCalendarDate(startIso, true), end: isoToCalendarAllDayEnd(startIso, endIso) }
    : { start: isoToCalendarDate(startIso), end: isoToCalendarDate(endIso) };
}

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
  system:  { backgroundColor: '#ef4444', borderColor: '#dc2626', textColor: '#fff' },
  ics_pull: { backgroundColor: '#0d9488', borderColor: '#0f766e', textColor: '#fff' },
  task:    { backgroundColor: '#06b6d4', borderColor: '#0891b2', textColor: '#fff' },
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
  system: 'Sistema (festività)',
  ics_pull: 'Importato (ICS)',
  task: 'Task',
};

interface CalendarApi {
  id: string;
  slug: string;
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
  // ─── Solo vista con le occorrenze v2 (`caps.occurrences`): `id` è l'id dell'oggetto ───
  v2?: true;
  /** Chiave dell'istanza ('' = evento singolo o master). */
  recurrence_key?: string;
  badges?: CalV2OccurrenceBadge[];
  readonly_reason?: CalV2ReadonlyReason | null;
  occ_kind?: CalV2OccurrenceKind;
  recurring?: boolean;
  /** Occorrenza dell'ultima versione buona di un oggetto in quarantena. */
  stale?: boolean;
  /** COLOR dell'evento; null = colore del calendario. */
  color?: string | null;
  /** Solo all-day: giorni del calendario (fine esclusiva). */
  start_date?: string | null;
  end_date?: string | null;
  /** Festività, chiusura o iscrizione: sola lettura, non sono eventi dell'admin. */
  overlay?: CalV2OverlayItem['source'];
}

/** Titolo mostrato quando l'evento non ha SUMMARY. */
const UNTITLED = '(Senza titolo)';

/** Sorgente (colori, etichette, permessi del pannello) di un'occorrenza v2. */
function sourceOfKind(kind: CalV2OccurrenceKind): string {
  if (kind === 'booking_projection') return 'booking';
  if (kind === 'holiday_system' || kind === 'closure') return 'system';
  return 'manual';
}

function occurrenceToEvent(o: CalV2Occurrence): CalendarEventOcc {
  return {
    id: o.object_id,
    uid: '',
    calendar_id: o.calendar_id,
    summary: o.summary || UNTITLED,
    description: null,
    location: o.location,
    url: null,
    start_time: o.start_utc,
    end_time: o.end_utc,
    all_day: o.all_day,
    source: sourceOfKind(o.kind),
    source_id: o.booking_id,
    status: o.status,
    original_start: null,
    is_override: o.kind === 'override' || o.kind === 'orphan_override',
    v2: true,
    recurrence_key: o.recurrence_key,
    badges: o.badges,
    readonly_reason: o.readonly_reason,
    occ_kind: o.kind,
    recurring: o.recurring,
    stale: o.stale,
    color: o.color,
    start_date: o.start_date,
    end_date: o.end_date,
  };
}

function overlayToEvent(o: CalV2OverlayItem): CalendarEventOcc {
  return {
    id: o.object_id,
    uid: '',
    calendar_id: o.calendar_id,
    summary: o.summary || UNTITLED,
    description: null,
    location: null,
    url: null,
    start_time: o.start_utc,
    end_time: o.end_utc,
    all_day: o.all_day,
    source: o.source === 'subscription' ? 'ics_pull' : 'system',
    source_id: null,
    status: 'confirmed',
    original_start: null,
    is_override: false,
    v2: true,
    recurrence_key: o.recurrence_key,
    badges: [],
    readonly_reason: null,
    color: o.color,
    start_date: o.start_date,
    end_date: o.end_date,
    overlay: o.source,
  };
}

/** Evento della vista v2 costruito dalla vista di un oggetto (copia appena creata): serve ad aprirlo nell'editor. */
function viewToEvent(view: CalV2ObjectView): CalendarEventOcc | null {
  const comp: CalV2ComponentView | null = view.target ?? view.master;
  if (!comp || !view.id) return null;
  return {
    id: view.id,
    uid: view.uid,
    calendar_id: view.calendar_id,
    summary: comp.fields.summary || UNTITLED,
    description: null,
    location: null,
    url: null,
    start_time: comp.start_utc,
    end_time: comp.end_utc,
    all_day: comp.all_day,
    source: 'manual',
    source_id: null,
    status: 'confirmed',
    original_start: null,
    is_override: comp.is_override,
    v2: true,
    recurrence_key: comp.recurrence_key,
    badges: [],
    readonly_reason: view.readonly_reason,
    recurring: view.recurring,
  };
}

/** Chiave stabile di un'occorrenza nella vista v2 (l'id oggetto non basta: una serie ha molte istanze). */
const eventKey = (ev: CalendarEventOcc): string => `${ev.id}|${ev.recurrence_key ?? ''}|${ev.start_time}`;

/** Modificabile dall'editor: oggetti veri (non festività/iscrizioni) e non il blocco conservativo. */
function isObjectEvent(ev: CalendarEventOcc): boolean {
  return ev.v2 ? !ev.overlay && ev.occ_kind !== 'conservative' : !!(ev.id && ev.uid);
}

/**
 * Trascinabile nella vista v2: oggetto vivo, non in sola lettura, né in
 * quarantena né in hold, né una prenotazione (spostarla non aggiornerebbe la
 * prenotazione, come in v1).
 */
function isDraggableV2(ev: CalendarEventOcc, canWrite: boolean): boolean {
  if (!canWrite || ev.overlay || ev.readonly_reason || ev.stale) return false;
  if (ev.occ_kind !== 'event' && ev.occ_kind !== 'override' && ev.occ_kind !== 'orphan_override') return false;
  return !(ev.badges ?? []).some((b) => b === 'quarantined' || b === 'hold');
}

const DAY_MS = 86_400_000;

/** Spezza `[from, to)` in finestre di al più `CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS` giorni (limite di /occurrences e /overlays). */
function splitWindow(fromIso: string, toIso: string): Array<{ from: string; to: string }> {
  const maxMs = CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS * DAY_MS;
  const end = new Date(toIso).getTime();
  const out: Array<{ from: string; to: string }> = [];
  for (let cursor = new Date(fromIso).getTime(); cursor < end; cursor += maxMs) {
    out.push({ from: new Date(cursor).toISOString(), to: new Date(Math.min(cursor + maxMs, end)).toISOString() });
  }
  return out;
}

/** Occorrenze della finestra visibile (senza troncamento); i duplicati fra finestre adiacenti si eliminano. */
async function fetchOccurrencesWindow(from: string, to: string) {
  const parts = await Promise.all(splitWindow(from, to).map((w) => listOccurrencesV2(w)));
  const seen = new Set<string>();
  const occurrences: CalV2Occurrence[] = [];
  for (const part of parts) {
    for (const o of part.occurrences) {
      const key = `${o.object_id}|${o.recurrence_key}|${o.start_utc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      occurrences.push(o);
    }
  }
  return { occurrences, staleCalendarIds: [...new Set(parts.flatMap((p) => p.stale_calendar_ids))] };
}

async function fetchOverlaysWindow(from: string, to: string): Promise<CalV2OverlayItem[]> {
  const parts = await Promise.all(splitWindow(from, to).map((w) => listOverlaysV2(w)));
  const seen = new Set<string>();
  const items: CalV2OverlayItem[] = [];
  for (const part of parts) {
    for (const o of part.items) {
      const key = `${o.source}|${o.object_id}|${o.recurrence_key}|${o.start_utc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(o);
    }
  }
  return items;
}

/** Soglia di sicurezza per tipo (task, progetti) delle sovrapposizioni caricate nella vista. */
const OVERLAY_MAX_ITEMS = 1000;

interface WindowedList { items: any[]; total: number }

/**
 * Elenco a finestra paginato fino al `count` reale dell'API (non più un
 * `limit` fisso). Si ferma alla soglia di sicurezza o a un errore: `total`
 * resta il conteggio vero, così la vista può dire quanti elementi mancano.
 */
async function fetchWindowedList(
  path: string,
  key: 'tasks' | 'projects',
  params: Record<string, string>,
  pageSize: number,
): Promise<WindowedList> {
  const items: any[] = [];
  let total = 0;
  try {
    for (;;) {
      const q = new URLSearchParams({ ...params, limit: String(pageSize), offset: String(items.length) });
      const page = await apiFetch(`${path}?${q}`);
      const rows = (page?.[key] ?? []) as any[];
      items.push(...rows);
      total = Math.max(total, Number(page?.count ?? 0), items.length);
      if (!rows.length || items.length >= total || items.length >= OVERLAY_MAX_ITEMS) break;
    }
  } catch {
    /* le sovrapposizioni non bloccano la vista: restano gli elementi già caricati */
  }
  return { items: items.slice(0, OVERLAY_MAX_ITEMS), total: Math.max(total, items.length) };
}

/** Giorni (YYYY-MM-DD) del primo e dell'ultimo giorno visibili, per i filtri `due_*` e `overlap_*`. */
function visibleDays(start: Date, end: Date): { startDay: string; endDay: string } {
  return {
    startDay: start.toISOString().slice(0, 10),
    endDay: new Date(end.getTime() - 1).toISOString().slice(0, 10),
  };
}

/** Minuti di un `Duration` di FullCalendar (giorni + millisecondi). */
function deltaMinutes(d: { days: number; milliseconds: number }): number {
  return Math.round(d.days * 1440 + d.milliseconds / 60_000);
}

/**
 * Operazioni per spostare o ridimensionare l'istanza `comp` (pre-immagine del
 * target della vista). Lo spostamento dell'inizio trascina la fine; senza
 * DTEND si aggiorna la durata (DURATION) o si scrive la fine. Il server
 * traduce lo scope (`this`, `this_and_future`, `all`) in un'operazione sulla serie.
 */
function buildTimeOps(
  comp: CalV2ComponentView,
  startDelta: number,
  endDelta: number,
): { ops: CalV2Op[]; base: Record<string, string> } | null {
  const f = comp.fields;
  const ops: CalV2Op[] = [];
  const base: Record<string, string> = {};
  const push = (op: CalV2Op & { op: 'set' }) => {
    ops.push(op);
    base[op.field] = comp.tokens[op.field] ?? CAL_V2_ABSENT_TOKEN;
  };
  const newStart = startDelta ? shiftTimeMinutes(f.start, startDelta) : f.start;
  if (startDelta) push({ op: 'set', field: 'start', value: newStart });
  const occMinutes = comp.all_day
    ? Math.round((new Date(comp.end_utc).getTime() - new Date(comp.start_utc).getTime()) / DAY_MS) * 1440
    : Math.round((new Date(comp.end_utc).getTime() - new Date(comp.start_utc).getTime()) / 60_000);
  const newMinutes = occMinutes + endDelta - startDelta;
  if (newMinutes <= 0) return null;
  if (f.end) {
    if (endDelta) push({ op: 'set', field: 'end', value: shiftTimeMinutes(f.end, endDelta) });
  } else if (f.duration) {
    const oldMinutes = durationToMinutes(f.duration);
    if (oldMinutes + endDelta - startDelta !== oldMinutes) {
      push({ op: 'set', field: 'duration', value: minutesToDuration(oldMinutes + endDelta - startDelta) });
    }
  } else if (newMinutes !== occMinutes) {
    push({ op: 'set', field: 'end', value: shiftTimeMinutes(newStart, newMinutes) });
  }
  return ops.length ? { ops, base } : null;
}

/** Calendario sotto il puntatore (voce della legenda con `data-calendar-drop-id`), o null. */
function dropCalendarIdAt(jsEvent: MouseEvent | TouchEvent): string | null {
  const point = 'changedTouches' in jsEvent ? jsEvent.changedTouches[0] : jsEvent;
  if (!point) return null;
  for (const el of document.elementsFromPoint(point.clientX, point.clientY)) {
    const id = (el as HTMLElement).closest?.('[data-calendar-drop-id]')?.getAttribute('data-calendar-drop-id');
    if (id) return id;
  }
  return null;
}

/**
 * Sceglie l'editor dell'evento (contratto F6 §6.1, §9.2.2): il v2 (client CalDAV
 * quasi 1:1) se l'API lo dichiara leggibile, altrimenti il v1 di sempre con le
 * stesse props. La scelta si fa all'apertura e si fissa finché il modale resta
 * aperto, così un cambio delle capacità durante la modifica non rimonta
 * l'editor e non fa perdere la bozza. Con capacità in caricamento, fallite o
 * scadute `v2Readable` è falso e si apre subito il v1: mai un modale vuoto.
 */
function EventEditorHost({ v2Readable, ...props }: {
  v2Readable: boolean;
  initial: CalendarEventOcc | null;
  initialStart?: string;
  initialEnd?: string;
  initialAllDay?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind] = useState<'v1' | 'v2'>(v2Readable ? 'v2' : 'v1');
  return kind === 'v2' ? <EventoEditor {...props} /> : <EventoEditModal {...props} />;
}

export default function CalendarioPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Capacità dell'API v2: decidono quale editor aprire (nessun'altra chiamata v2 da questa pagina).
  const { caps: v2Caps } = useCalendarV2Capabilities();
  // Vista con le occorrenze v2 (`caps.occurrences`, che implica `objects.read`); senza il flag resta /events v1.
  const occMode = !!v2Caps?.occurrences;
  const canWriteV2 = occMode && !!v2Caps?.objects.write;
  const canTools = canWriteV2 && !!v2Caps?.object_tools;
  const confirm = useConfirm();
  const { intlLocale, locale } = useI18n();
  const calendarRef = useRef<FullCalendar>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventOcc | null>(null);
  const [editingEvent, setEditingEvent] = useState<CalendarEventOcc | null>(null);
  const [creatingFromSlot, setCreatingFromSlot] = useState<{ start: string; end: string; allDay: boolean } | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string; startDay: string; endDay: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ event: CalendarEventOcc; x: number; y: number } | null>(null);
  // Scelta "questa occorrenza / tutta la serie" per eventi ricorrenti.
  const [recurringAction, setRecurringAction] = useState<{
    kind: 'move' | 'resize' | 'delete';
    data: CalendarEventOcc;
    startIso?: string;
    endIso?: string;
    revert?: () => void;
  } | null>(null);
  // Calendari/sorgenti nascosti dalla legenda (toggle mostra/nascondi).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const legendRef = useRef<HTMLDivElement>(null);
  // "Sposta in…" aperto per l'occorrenza selezionata (la chiave la rende valida solo per quella).
  const [moveOpenFor, setMoveOpenFor] = useState<string | null>(null);
  // Scelta dell'ambito (modifica da trascinamento o eliminazione) e conflitto 412 della vista v2.
  const [v2Scope, setV2Scope] = useState<{
    action: 'edit' | 'delete';
    id: string;
    key: string;
    etag: string;
    allowed: CalV2Scope[];
    ops: CalV2Op[];
    base: Record<string, string>;
    revert?: () => void;
  } | null>(null);
  const [v2Conflict, setV2Conflict] = useState<{
    body: CalV2PreconditionFailedBody;
    id: string;
    key: string;
    scope: CalV2Scope;
    ops: CalV2Op[];
    revert?: () => void;
  } | null>(null);
  const toggleHidden = (key: string) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Caldes Calendar — eventi multi-calendario (sostituisce Google Calendar).
  // Niente catch-che-svuota: un errore API deve mostrare il banner, non un
  // calendario vuoto identico a "nessun evento". keepPreviousData mantiene
  // visibili gli eventi dell'ultimo fetch riuscito durante errori transitori.
  // Con `caps.occurrences` la sorgente sono le occorrenze v2; la v1 parte subito (anche a capacità ignote, come prima della v2) e si ferma solo con il flag.
  const { data: eventsData, error: eventsV1Error, refetch: refetchEventsV1 } = useQuery({
    queryKey: ['admin-calendar-events', dateRange?.start, dateRange?.end],
    queryFn: async () => {
      if (!dateRange) return { events: [] };
      const params = new URLSearchParams({ from: dateRange.start, to: dateRange.end });
      return await apiFetch(`/api/admin/calendar/events?${params}`);
    },
    enabled: !!dateRange && !occMode,
    retry: 1,
    placeholderData: keepPreviousData,
  });

  // Occorrenze e sovrapposizioni v2 della finestra visibile (spezzata oltre i 100 giorni).
  const { data: occData, error: occError, refetch: refetchOcc } = useQuery({
    queryKey: calV2Keys.occurrences(dateRange?.start ?? '', dateRange?.end ?? ''),
    queryFn: () => fetchOccurrencesWindow(dateRange!.start, dateRange!.end),
    enabled: !!dateRange && occMode,
    retry: 1,
    placeholderData: keepPreviousData,
  });
  const { data: overlayData, error: overlayError, refetch: refetchOverlays } = useQuery({
    queryKey: calV2Keys.overlays(dateRange?.start ?? '', dateRange?.end ?? ''),
    queryFn: () => fetchOverlaysWindow(dateRange!.start, dateRange!.end),
    enabled: !!dateRange && occMode,
    retry: 1,
    placeholderData: keepPreviousData,
  });
  const eventsError = occMode ? occError ?? overlayError : eventsV1Error;
  const refetchEvents = () => {
    if (occMode) { void refetchOcc(); void refetchOverlays(); } else void refetchEventsV1();
  };

  // Calendari dove si può spostare un evento (attivi, scrivibili, con eventi): servono solo agli strumenti sull'oggetto.
  const { data: v2Calendars } = useQuery({
    queryKey: calV2Keys.calendars,
    queryFn: listCalendarsV2,
    enabled: canTools,
    staleTime: 30_000,
  });
  const moveTargets = useMemo(() => new Map(
    (v2Calendars?.calendars ?? [])
      .filter((c) => c.lifecycle === 'active' && !c.readonly_reason && c.components.includes('VEVENT')
        && c.role !== 'bookings' && c.role !== 'holidays' && c.role !== 'subscription' && c.role !== 'tasks')
      .map((c) => [c.id, c]),
  ), [v2Calendars]);

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

  // Progetti che si sovrappongono alla finestra visibile, paginati fino al conteggio vero.
  const { data: projectsWin } = useQuery({
    queryKey: ['projects-calendar', dateRange?.startDay, dateRange?.endDay],
    queryFn: () => fetchWindowedList('/api/client-projects', 'projects',
      { overlap_from: dateRange!.startDay, overlap_to: dateRange!.endDay }, 100),
    enabled: !!dateRange,
    placeholderData: keepPreviousData,
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

  // Task di progetto con due date — aggregati read-only come progetti/domini
  // Solo quelli con scadenza nella finestra visibile, paginati fino al conteggio vero.
  const { data: tasksWin } = useQuery({
    queryKey: ['tasks-calendar', dateRange?.startDay, dateRange?.endDay],
    queryFn: () => fetchWindowedList('/api/project-tasks', 'tasks',
      { due_from: dateRange!.startDay, due_to: dateRange!.endDay }, 200),
    enabled: !!dateRange,
    placeholderData: keepPreviousData,
  });
  const truncatedOverlays = [
    tasksWin && tasksWin.total > tasksWin.items.length ? `${tasksWin.total} task nella finestra: mostrati i primi ${tasksWin.items.length}` : null,
    projectsWin && projectsWin.total > projectsWin.items.length ? `${projectsWin.total} progetti nella finestra: mostrati i primi ${projectsWin.items.length}` : null,
  ].filter((m): m is string => !!m);

  // Eventi della vista v2: occorrenze (modificabili) e sovrapposizioni (festività, chiusure, iscrizioni: sola lettura).
  const v2Events = useMemo(() => [
    ...(occData?.occurrences ?? []).map(occurrenceToEvent),
    ...(overlayData ?? []).map(overlayToEvent),
  ], [occData, overlayData]);
  const staleCalendarNames = (occData?.staleCalendarIds ?? []).map((id) => calendarById.get(id)?.name ?? id);

  // Dopo ogni scrittura: la vista v1 e v2 e gli editor aperti si rileggono.
  const invalidateView = () => {
    for (const key of [
      'admin-calendar-events', 'admin-calendars', 'admin-bookings',
      'admin-calendar-v2-occurrences', 'admin-calendar-v2-overlays', 'admin-calendar-v2-object',
    ]) queryClient.invalidateQueries({ queryKey: [key] });
  };

  // Build events array
  const calendarEvents = (() => {
    const events: any[] = [];
    const occs: CalendarEventOcc[] = occMode ? v2Events : ((eventsData?.events || []) as CalendarEventOcc[]);

    // Festività e chiusure come "coperta": gli eventi interamente coperti da una
    // festività/chiusura vengono nascosti — in ferie il calendario mostra solo
    // la chiusura. Eccezioni: bookings (appuntamenti reali, mai nascosti in
    // silenzio) e il calendario Scadenze. Nascondere "Festività e chiusure"
    // dalla legenda disattiva anche il filtro (escape hatch per vedere tutto).
    const festCal = calendars.find((c) => /^festivit/i.test(c.name));
    const scadenzeCal = calendars.find((c) => c.slug === 'scadenze');
    const festActive = !!festCal && !hidden.has(festCal.id);
    // Con le occorrenze v2 le fasce vengono dalle sovrapposizioni `holiday`/`closure`.
    const isBlock = (e: CalendarEventOcc) => occMode
      ? (e.overlay === 'holiday' || e.overlay === 'closure') && !hidden.has(e.calendar_id)
      : festActive && e.calendar_id === festCal!.id;
    const blockRanges = occs.filter(isBlock)
      .map((e) => ({ s: new Date(e.start_time).getTime(), e: new Date(e.end_time).getTime() }));
    const coveredByBlock = (ev: CalendarEventOcc) => {
      if (!blockRanges.length) return false;
      if (isBlock(ev) || ev.overlay || ev.source === 'booking') return false;
      if (scadenzeCal && ev.calendar_id === scadenzeCal.id) return false;
      const s = new Date(ev.start_time).getTime();
      const e = new Date(ev.end_time).getTime();
      return blockRanges.some((b) => s >= b.s && e <= b.e);
    };

    // Caldes Calendar — eventi multi-calendario (sostituisce Google Calendar)
    for (const ev of occs) {
      if (hidden.has(ev.calendar_id)) continue;
      if (coveredByBlock(ev)) continue;
      const cal = calendarById.get(ev.calendar_id);
      const sourceColor = SOURCE_COLORS[ev.source] || SOURCE_COLORS.manual;
      // Gli all-day v2 portano già i giorni del calendario (fine esclusiva).
      const range = ev.v2 && ev.all_day && ev.start_date && ev.end_date
        ? { start: ev.start_date, end: ev.end_date }
        : toCalendarRange(ev.start_time, ev.end_time, ev.all_day);
      const color = (ev.v2 && ev.color) || cal?.color;
      events.push({
        id: ev.v2 ? `${ev.overlay ? 'overlay' : 'event'}-${eventKey(ev)}` : `event-${ev.id}-${ev.start_time}`,
        title: ev.summary,
        start: range.start,
        end: range.end,
        allDay: ev.all_day,
        backgroundColor: color || sourceColor.backgroundColor,
        borderColor: color || sourceColor.borderColor,
        textColor: '#fff',
        editable: ev.v2 ? isDraggableV2(ev, canWriteV2) : DRAGGABLE_SOURCES.has(ev.source),
        extendedProps: { source: ev.source, data: ev, calendar: cal, badges: ev.badges ?? [] },
      });
      // Sfondo "bloccato" sull'intera fascia di festività/chiusure: rende
      // visivamente chiuso il periodo oltre al chip evento cliccabile.
      if (isBlock(ev)) {
        events.push({
          id: ev.v2 ? `bg-${eventKey(ev)}` : `bg-${ev.id}-${ev.start_time}`,
          start: range.start,
          end: range.end,
          allDay: ev.all_day,
          display: 'background',
          backgroundColor: cal?.color || sourceColor.backgroundColor,
        });
      }
    }

    // Cal.com storico (se ancora presente nel DB legacy)
    for (const b of (hidden.has('calcom') ? [] : calcomData?.bookings || [])) {
      if (b.status === 'cancelled') continue;
      events.push({
        id: `calcom-${b.id}`,
        title: `[Cal.com] ${b.title}`,
        start: isoToCalendarDate(b.start_time),
        end: isoToCalendarDate(b.end_time),
        allDay: false,
        editable: false,
        ...SOURCE_COLORS.calcom,
        // Il pannello dettaglio legge summary/start_time/end_time: con la riga
        // grezza mostrava titolo vuoto e "Invalid Date" (idem progetti e domini).
        extendedProps: {
          source: 'calcom',
          data: {
            summary: `[Cal.com] ${b.title}`, description: b.description ?? null,
            start_time: b.start_time, end_time: b.end_time, all_day: false,
            source: 'calcom', status: b.status, location: b.location ?? null, url: null,
          },
        },
      });
    }

    // Projects (start → end as background bars)
    for (const p of (hidden.has('project') ? [] : projectsWin?.items || [])) {
      if (!p.start_date) continue;
      events.push({
        id: `proj-${p.id}`,
        title: `📐 ${p.name}`,
        start: p.start_date,
        end: p.target_end_date || p.start_date,
        allDay: true,
        editable: false,
        ...SOURCE_COLORS.project,
        extendedProps: {
          source: 'project',
          data: {
            summary: `📐 ${p.name}`, description: p.description ?? null,
            start_time: p.start_date, end_time: p.target_end_date || p.start_date, all_day: true,
            source: 'project', status: p.status, location: null, url: null,
          },
        },
      });
    }

    // Domains (expiry as single-day event)
    for (const d of (hidden.has('domain') ? [] : domainsData?.domains || [])) {
      if (!d.expiration_date) continue;
      events.push({
        id: `domain-${d.id}`,
        title: `🌐 ${d.full_domain || d.domain_name} scade`,
        start: String(d.expiration_date).slice(0, 10),
        allDay: true,
        editable: false,
        ...SOURCE_COLORS.domain,
        extendedProps: {
          source: 'domain',
          data: {
            summary: `🌐 ${d.full_domain || d.domain_name} scade`, description: d.registrar ? `Registrar: ${d.registrar}` : null,
            start_time: String(d.expiration_date).slice(0, 10), end_time: String(d.expiration_date).slice(0, 10), all_day: true,
            source: 'domain', status: d.status, location: null, url: null,
          },
        },
      });
    }

    // Task di progetto: due date come chip all-day; i completati restano
    // visibili ma barrati/attenuati (classe task-done in index.css).
    // Come le Scadenze, restano visibili anche dentro ferie/festività.
    for (const t of (hidden.has('task') ? [] : tasksWin?.items || [])) {
      if (!t.due_date) continue;
      const done = t.status === 'done';
      events.push({
        id: `task-${t.id}`,
        title: `${done ? '✅' : '📋'} ${t.title}`,
        start: t.due_date,
        allDay: true,
        editable: false,
        classNames: done ? ['task-done'] : [],
        ...SOURCE_COLORS.task,
        extendedProps: {
          source: 'task',
          data: {
            summary: `${done ? '✅' : '📋'} ${t.title}`,
            description: [t.project_name, t.milestone_name].filter(Boolean).join(' — ') || null,
            start_time: t.due_date,
            end_time: t.due_date,
            all_day: true,
            source: 'task',
            status: t.status,
            location: null,
            url: null,
          },
        },
      });
    }

    return events;
  })();

  // Una "occorrenza ricorrente" è un'istanza espansa da un master (ha
  // original_start e NON è un override già materializzato come riga a sé).
  const isRecurringOccurrence = (ev: CalendarEventOcc) => !!ev.original_start && !ev.is_override;

  // ─── Vista con le occorrenze v2 (`caps.occurrences`) ───

  /** Ambiti ammessi dal server per questa API (`objects.scopes`), nell'ordine di `allowedScopes`. */
  const supportedScopes = (scopes: CalV2Scope[]): CalV2Scope[] => {
    const supported = v2Caps?.objects.scopes ?? [];
    return supported.length ? scopes.filter((sc) => supported.includes(sc)) : scopes;
  };

  const SCOPE_DONE: Record<CalV2Scope, string> = {
    this: 'Modificata solo questa occorrenza',
    this_and_future: 'Aggiornate questa e le successive',
    all: 'Evento aggiornato',
  };

  /** Scrive lo spostamento nel tempo: 412 → ConflictDialog, altro errore → `revert()`. */
  const runV2Patch = async (a: {
    id: string; key: string; etag: string; scope: CalV2Scope; ops: CalV2Op[]; base: Record<string, string>; revert?: () => void;
  }) => {
    try {
      const result = await patchObjectV2(a.id, a.etag, {
        target: { recurrence_key: a.key }, scope: a.scope, ops: a.ops, base: a.base,
      });
      toast.success(result.noop ? 'Nessuna modifica' : SCOPE_DONE[a.scope]);
      invalidateView();
      setSelectedEvent(null);
    } catch (err) {
      if (err instanceof CalV2ConflictError) {
        setV2Conflict({ body: err.body, id: a.id, key: a.key, scope: a.scope, ops: a.ops, revert: a.revert });
        return;
      }
      a.revert?.();
      toast.error(calV2ErrorMessage(err));
    }
  };

  /**
   * Trascinamento nel tempo e ridimensionamento in modalità v2: legge la vista
   * dell'istanza, scrive start/end con i token della vista (istanza di una
   * serie → scelta dell'ambito), 412 → conflitto per campo.
   */
  const applyMoveOrResizeV2 = async (kind: 'move' | 'resize', info: EventDropArg | EventResizeDoneArg) => {
    const data = info.event.extendedProps.data as CalendarEventOcc | undefined;
    const revert = () => info.revert();
    if (!data?.v2 || !isDraggableV2(data, canWriteV2) || !info.event.start) {
      revert();
      return;
    }
    // Il passaggio fra "tutto il giorno" e orario cambia il tipo di DTSTART: si fa dall'editor.
    if (info.event.allDay !== data.all_day) {
      revert();
      toast.error('Per passare fra «tutto il giorno» e orario usa la modifica dell\'evento');
      return;
    }
    const key = data.recurrence_key ?? '';
    try {
      const view = await getObjectV2(data.id, { recurrenceKey: key });
      const comp = view.target;
      if (!comp || !view.etag || view.readonly_reason) throw new Error('Questo evento non si può modificare');
      const startDelta = kind === 'move'
        ? deltaMinutes((info as EventDropArg).delta)
        : deltaMinutes((info as EventResizeDoneArg).startDelta);
      const endDelta = kind === 'move'
        ? startDelta
        : deltaMinutes((info as EventResizeDoneArg).endDelta);
      const patch = buildTimeOps(comp, startDelta, endDelta);
      if (!patch) {
        revert();
        return;
      }
      const allowed = supportedScopes(allowedScopes(view, key, patch.ops, 'edit'));
      if (!allowed.length) throw new Error('Questa modifica non è ammessa per questo evento');
      if (allowed.length > 1) {
        setV2Scope({ action: 'edit', id: view.id, key, etag: view.etag, allowed, ops: patch.ops, base: patch.base, revert });
        return;
      }
      await runV2Patch({ id: view.id, key, etag: view.etag, scope: allowed[0], ops: patch.ops, base: patch.base, revert });
    } catch (err) {
      revert();
      toast.error(calV2ErrorMessage(err));
    }
  };

  const chooseV2Scope = (scope: CalV2Scope) => {
    const ask = v2Scope;
    setV2Scope(null);
    if (!ask) return;
    if (ask.action === 'delete') void runV2Delete(ask.id, ask.key, ask.etag, scope);
    else void runV2Patch({ id: ask.id, key: ask.key, etag: ask.etag, scope, ops: ask.ops, base: ask.base, revert: ask.revert });
  };

  const cancelV2Scope = () => {
    v2Scope?.revert?.();
    setV2Scope(null);
  };

  // Conflitto: i campi in conflitto si scelgono uno per uno, gli altri si applicano sopra la versione del server.
  const resolveV2Conflict = (keepMine: Set<string>) => {
    const c = v2Conflict;
    if (!c) return;
    setV2Conflict(null);
    try {
      const rebased = rebaseAfterConflict({ ops: c.ops }, c.body, keepMine);
      if (!rebased.ops.length) {
        toast.info('Hai scelto i valori del server: l\'evento resta com\'è');
        c.revert?.();
        invalidateView();
        return;
      }
      void runV2Patch({ id: c.id, key: c.key, etag: rebased.etag, scope: c.scope, ops: rebased.ops, base: rebased.base, revert: c.revert });
    } catch (err) {
      c.revert?.();
      invalidateView();
      toast.error(calV2ErrorMessage(err));
    }
  };

  const dismissV2Conflict = () => {
    v2Conflict?.revert?.();
    setV2Conflict(null);
    invalidateView();
  };

  /** Eliminazione di un'occorrenza v2 con l'ambito scelto (412 → si rilegge la vista). */
  const runV2Delete = async (id: string, key: string, etag: string, scope: CalV2Scope) => {
    try {
      await deleteObjectV2(id, etag, { scope, recurrenceKey: key });
      toast.success(scope === 'this' ? 'Occorrenza eliminata' : scope === 'this_and_future' ? 'Serie accorciata' : 'Evento eliminato');
      setSelectedEvent(null);
    } catch (err) {
      toast.error(err instanceof CalV2ConflictError
        ? 'L\'evento è stato modificato altrove: controlla la versione attuale e riprova'
        : calV2ErrorMessage(err));
    } finally {
      invalidateView();
    }
  };

  const deleteV2 = async (ev: CalendarEventOcc) => {
    const key = ev.recurrence_key ?? '';
    try {
      const view = await getObjectV2(ev.id, { recurrenceKey: key });
      if (!view.etag) throw new Error('L\'evento non ha un ETag: ricarica la vista');
      if (view.delete_blocked_reason) {
        toast.error('L\'evento è legato a una prenotazione attiva: annulla prima la prenotazione');
        return;
      }
      const allowed = supportedScopes(allowedScopes(view, key, [], 'delete'));
      if (!allowed.length) throw new Error('Questo evento non si può eliminare');
      if (allowed.length > 1) {
        setV2Scope({ action: 'delete', id: view.id, key, etag: view.etag, allowed, ops: [], base: {} });
        return;
      }
      const whole = view.recurring && key === '';
      if (await confirm({
        title: whole ? 'Eliminare l\'intera serie?' : 'Eliminare questo evento?',
        description: whole ? 'Verranno eliminate tutte le occorrenze di questo evento ricorrente.' : undefined,
        variant: 'destructive',
      })) await runV2Delete(view.id, key, view.etag, allowed[0]);
    } catch (err) {
      toast.error(calV2ErrorMessage(err));
    }
  };

  /** Sposta la risorsa intera (serie o evento singolo) in un altro calendario, dopo conferma. */
  const moveToCalendar = async (ev: CalendarEventOcc, calendarId: string) => {
    const target = moveTargets.get(calendarId);
    if (!target) {
      toast.error('Questo calendario non accetta eventi');
      return;
    }
    if (calendarId === ev.calendar_id) {
      toast.info('L\'evento è già in questo calendario');
      return;
    }
    const ok = await confirm({
      title: `Spostare «${ev.summary}» in «${target.name}»?`,
      description: ev.recurring ? 'È un evento ricorrente: si sposta l\'intera serie, non solo questa occorrenza.' : undefined,
    });
    if (!ok) return;
    try {
      const view = await getObjectV2(ev.id, { recurrenceKey: ev.recurrence_key ?? '' });
      if (!view.etag) throw new Error('L\'evento non ha un ETag: ricarica la vista');
      if (view.readonly_reason) throw new Error('Questo evento non si può spostare');
      await moveObjectV2(view.id, view.etag, { calendar_id: calendarId });
      toast.success(`Spostato in «${target.name}»`);
      setSelectedEvent(null);
      setMoveOpenFor(null);
    } catch (err) {
      toast.error(err instanceof CalV2ConflictError
        ? 'L\'evento è stato modificato altrove: la vista si aggiorna, riprova'
        : calV2ErrorMessage(err));
    } finally {
      invalidateView();
    }
  };

  /** Duplica come evento nuovo (con l'UID generato qui, per ritentare senza doppioni) e apre la copia nell'editor. */
  const duplicateV2 = async (ev: CalendarEventOcc) => {
    try {
      const result = await duplicateObjectV2(ev.id, { recurrence_key: ev.recurrence_key ?? '', uid: generateEventUid() });
      toast.success('Evento duplicato');
      invalidateView();
      const copy = result.object ? viewToEvent(result.object) : null;
      if (copy) {
        setSelectedEvent(null);
        setEditingEvent(copy);
        setCreatingFromSlot(null);
        setShowEditor(true);
      }
    } catch (err) {
      toast.error(calV2ErrorMessage(err));
    }
  };

  // Rilascio su una voce della legenda = spostamento fra calendari. Nessuno stato React
  // durante il trascinamento: un re-render rigenererebbe gli eventi sotto il puntatore.
  const setLegendDragging = (on: boolean) => {
    legendRef.current?.setAttribute('data-dragging', on ? 'true' : 'false');
  };
  const handleEventDragStop = (info: EventDragStopArg) => {
    setLegendDragging(false);
    const data = info.event.extendedProps.data as CalendarEventOcc | undefined;
    if (!canTools || !data?.v2 || !isDraggableV2(data, canWriteV2)) return;
    const calendarId = dropCalendarIdAt(info.jsEvent);
    if (calendarId) void moveToCalendar(data, calendarId);
  };

  /** Chip dell'evento con le icone dei badge (orfano, quarantena, hold, conservativo, nuovo dal dispositivo). */
  const renderEventContent = (arg: EventContentArg) => {
    const badges = (arg.event.extendedProps.badges ?? []) as CalV2OccurrenceBadge[];
    if (!badges.length) return true;
    const start = arg.event.start;
    const end = arg.event.end;
    const isDot = arg.view.type.startsWith('dayGrid') && !arg.event.allDay
      && !(start && end && end.toISOString().slice(0, 10) !== start.toISOString().slice(0, 10));
    return (
      <div className="fc-event-main-frame">
        {isDot && <div className="fc-daygrid-event-dot" style={{ borderColor: arg.borderColor }} />}
        {arg.timeText && <div className="fc-event-time">{arg.timeText}</div>}
        <div className="fc-event-title-container">
          <div className="fc-event-title fc-sticky">
            <OccurrenceBadgeIcons badges={badges} tone={isDot ? 'plain' : 'chip'} className="mr-0.5" />
            {arg.event.title || ' '}
          </div>
        </div>
      </div>
    );
  };

  // Drag (sposta) + resize (cambia durata: verticale in settimana/giorno,
  // orizzontale in mese). Per gli eventi ricorrenti apre la scelta
  // "questa / tutta la serie"; per singoli/override fa un PUT diretto.
  const applyMoveOrResize = async (kind: 'move' | 'resize', info: EventDropArg | EventResizeDoneArg) => {
    if (occMode) {
      await applyMoveOrResizeV2(kind, info);
      return;
    }
    const source = info.event.extendedProps.source as string | undefined;
    const data = info.event.extendedProps.data as CalendarEventOcc | undefined;
    if (!source || !DRAGGABLE_SOURCES.has(source) || !data?.id || !info.event.start) {
      info.revert();
      return;
    }

    // FullCalendar restituisce il wall-time di Roma nei campi UTC: si riconverte in istanti veri.
    // Un all-day resta a mezzanotte di Roma (fine esclusiva).
    const allDay = info.event.allDay;
    const startIso = allDay ? zonedDateToIso(calendarDateToDay(info.event.start)) : calendarDateToIso(info.event.start);
    const endIso = info.event.end
      ? (allDay ? zonedDateToIso(calendarDateToDay(info.event.end)) : calendarDateToIso(info.event.end))
      : new Date(
          new Date(startIso).getTime() +
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
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
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
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
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
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
      setSelectedEvent(null);
    } catch (err) {
      a.revert?.();
      toast.error(err instanceof Error ? err.message : 'Operazione non riuscita');
    } finally {
      setRecurringAction(null);
    }
  };

  // "Questa e le successive": una sola richiesta all'API (saga recurrence_split
  // con lo store Radicale, transazione unica con Postgres) che tronca la serie
  // prima di questa occorrenza e, per move/resize, crea la nuova serie da qui
  // in poi con i nuovi orari. Mai una serie troncata senza la continuazione.
  const applyToThisAndFollowing = async () => {
    const a = recurringAction;
    if (!a) return;
    try {
      await apiFetch(`/api/admin/calendar/events/${a.data.id}/split`, {
        method: 'POST',
        body: JSON.stringify(a.kind === 'delete'
          ? { original_start: a.data.original_start, delete: true }
          : { original_start: a.data.original_start, start_time: a.startIso, end_time: a.endIso }),
      });
      toast.success(a.kind === 'delete' ? 'Eliminate questa e le successive' : 'Aggiornate questa e le successive');
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
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
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
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
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
      toast.success('Evento eliminato');
      setSelectedEvent(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore eliminazione'),
  });

  // Right-click su un evento → menu contestuale (solo per source editabili).
  const handleEventDidMount = (arg: EventMountArg) => {
    const source = arg.event.extendedProps.source as string | undefined;
    const data = arg.event.extendedProps.data as CalendarEventOcc | undefined;
    if (!source || !data?.id) return;
    // v2: ogni oggetto vero (non festività/iscrizioni); v1: sorgenti editabili con UID.
    if (data.v2 ? !isObjectEvent(data) : !EDITABLE_SOURCES.has(source) || !data.uid) return;
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
  const buildEventActions = (ev: CalendarEventOcc): RowAction[] => ev.source === 'booking'
    ? [
      // Come nel modale: l'evento di una prenotazione non si elimina da qui
      // (il booking resterebbe confermato ma invisibile).
      {
        label: 'Apri prenotazioni',
        icon: Pencil,
        onClick: () => navigate('/calendario/prenotazioni'),
      },
    ]
    : [
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
    // v2: la duplicazione passa da `object_tools`; senza il flag la voce non c'è.
    ...(ev.v2 && !canTools ? [] : [{
      label: 'Duplica',
      icon: Copy,
      onClick: () => (ev.v2 ? void duplicateV2(ev) : duplicateMutation.mutate(ev.id)),
    }]),
    { divider: true },
    {
      label: 'Elimina',
      icon: Trash2,
      destructive: true,
      onClick: async () => {
        if (ev.v2) {
          await deleteV2(ev);
          return;
        }
        // Ricorrente → chiedi questa/serie; singolo → conferma semplice.
        if (isRecurringOccurrence(ev)) {
          setRecurringAction({ kind: 'delete', data: ev });
          return;
        }
        if (await confirm({ title: 'Eliminare questo evento?', variant: 'destructive' })) deleteMutation.mutate(ev.id);
      },
    },
  ];

  // Selezione sulla griglia: wall-time di Roma → istanti veri. Una selezione
  // di giorni interi crea un all-day da mezzanotte a mezzanotte di Roma (fine
  // esclusiva), mai un evento 00:00-00:00 UTC.
  const handleDateSelect = (selectInfo: DateSelectArg) => {
    setCreatingFromSlot(selectInfo.allDay
      ? { start: zonedDateToIso(calendarDateToDay(selectInfo.start)), end: zonedDateToIso(calendarDateToDay(selectInfo.end)), allDay: true }
      : { start: calendarDateToIso(selectInfo.start), end: calendarDateToIso(selectInfo.end), allDay: false });
    setEditingEvent(null);
    setShowEditor(true);
  };

  // Intervallo visibile in istanti veri (mezzanotte di Roma), per le query degli eventi.
  const handleDatesSet = (dateInfo: { start: Date; end: Date }) => {
    setDateRange({
      start: calendarDateToIso(dateInfo.start),
      end: calendarDateToIso(dateInfo.end),
      ...visibleDays(dateInfo.start, dateInfo.end),
    });
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
              <Button variant="outline" size="sm" onClick={applyToThisAndFollowing}>
                Questa e le successive
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

      {/* Vista v2: ambito della modifica trascinata o dell'eliminazione, e conflitto di versione */}
      {v2Scope && (
        <ScopeDialog
          open
          action={v2Scope.action}
          allowed={v2Scope.allowed}
          onChoose={chooseV2Scope}
          onCancel={cancelV2Scope}
        />
      )}
      {v2Conflict && (
        <ConflictDialog
          open
          body={v2Conflict.body}
          pendingOps={v2Conflict.ops}
          onResolve={resolveV2Conflict}
          onReload={dismissV2Conflict}
          onCancel={dismissV2Conflict}
        />
      )}

      {/* Modale crea/edit evento */}
      {showEditor && (
        <EventEditorHost
          v2Readable={!!v2Caps?.objects.read}
          initial={editingEvent}
          initialStart={creatingFromSlot?.start}
          initialEnd={creatingFromSlot?.end}
          initialAllDay={creatingFromSlot?.allDay}
          onClose={() => { setShowEditor(false); setEditingEvent(null); setCreatingFromSlot(null); }}
          onSaved={invalidateView}
        />
      )}

      {/* Legend — click per mostrare/nascondere calendari e sorgenti speciali */}
      <div ref={legendRef} data-dragging="false" className="group flex flex-wrap items-center gap-1.5">
        {calendars.map((cal) => {
          const off = hidden.has(cal.id);
          // Voce di rilascio: trascinare un evento qui lo sposta in questo calendario (v2, `object_tools`).
          const dropTarget = canTools && moveTargets.has(cal.id);
          return (
            <button
              key={cal.id}
              type="button"
              onClick={() => toggleHidden(cal.id)}
              title={dropTarget ? `${off ? 'Mostra' : 'Nascondi'} — rilascia un evento per spostarlo qui` : off ? 'Mostra' : 'Nascondi'}
              {...(dropTarget ? { 'data-calendar-drop-id': cal.id, 'data-testid': `cal-legend-drop-${cal.id}` } : {})}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-opacity hover:bg-accent ${off ? 'opacity-40 line-through' : ''} ${dropTarget ? 'group-data-[dragging=true]:border-dashed group-data-[dragging=true]:border-primary group-data-[dragging=true]:bg-accent' : ''}`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: cal.color }} />
              <span className="text-muted-foreground">{cal.name}</span>
            </button>
          );
        })}
        {(['task', 'project', 'domain', 'calcom'] as const).map((key) => {
          const off = hidden.has(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleHidden(key)}
              title={off ? 'Mostra' : 'Nascondi'}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-opacity hover:bg-accent ${off ? 'opacity-40 line-through' : ''}`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SOURCE_COLORS[key].backgroundColor }} />
              <span className="text-muted-foreground">{SOURCE_LABELS[key]}</span>
            </button>
          );
        })}
      </div>

      {/* Errore caricamento eventi: banner persistente (mai calendario muto-vuoto) */}
      {!!eventsError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>
            Errore nel caricamento eventi: {eventsError instanceof Error ? eventsError.message : 'errore sconosciuto'}
          </span>
          <Button size="sm" variant="outline" className="text-xs shrink-0" onClick={() => refetchEvents()}>
            Riprova
          </Button>
        </div>
      )}

      {/* Calendari con dati forse non aggiornati (collezione non sana) */}
      {occMode && staleCalendarNames.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Dati forse non aggiornati per: {staleCalendarNames.join(', ')}. Dettagli nella pagina Salute.
        </div>
      )}

      {/* Task e progetti oltre la soglia di sicurezza: la vista lo dice invece di tacerlo */}
      {truncatedOverlays.length > 0 && (
        <div data-testid="cal-overlay-more" className="rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {truncatedOverlays.join(' · ')}.
        </div>
      )}

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
            timeZone="UTC"
            now={() => isoToCalendarDate(new Date().toISOString())}
            firstDay={1}
            height="auto"
            events={calendarEvents}
            eventClick={handleEventClick}
            eventDidMount={handleEventDidMount}
            eventWillUnmount={handleEventWillUnmount}
            eventContent={occMode ? renderEventContent : undefined}
            eventDragStart={canTools ? () => setLegendDragging(true) : undefined}
            eventDragStop={canTools ? handleEventDragStop : undefined}
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
                  <div>{new Date(selectedEvent.start_time).toLocaleDateString(intlLocale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: CALENDAR_TZ })}</div>
                  <div className="text-muted-foreground">
                    {selectedEvent.all_day ? 'Tutto il giorno' : (
                      <>
                        {new Date(selectedEvent.start_time).toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit', timeZone: CALENDAR_TZ })}
                        {' — '}
                        {new Date(selectedEvent.end_time).toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit', timeZone: CALENDAR_TZ })}
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

              {selectedEvent.overlay && (
                <p className="text-[11px] text-muted-foreground">
                  {selectedEvent.overlay === 'subscription'
                    ? 'Evento di un\'iscrizione ICS — sola lettura.'
                    : selectedEvent.overlay === 'closure'
                      ? 'Chiusura — sola lettura.'
                      : 'Festività — sola lettura.'}
                </p>
              )}

              {/* Badge della vista v2: orfano, quarantena, hold, conservativo, nuovo dal dispositivo */}
              {selectedEvent.badges && selectedEvent.badges.length > 0 && (
                <OccurrenceBadgeList badges={selectedEvent.badges} />
              )}

              {/* Action buttons — solo per eventi del nuovo sistema, no per legacy calcom/project/domain.
                  Modifica solo su sorgenti editabili: gli ics_pull vengono sovrascritti
                  a ogni sync e i system (festività) sono auto-gestiti dal cron.
                  Nella vista v2 decidono `readonly_reason`, il tipo di occorrenza e le capacità. */}
              {isObjectEvent(selectedEvent) && (() => {
                const sel = selectedEvent;
                const v2 = !!sel.v2;
                const editable = v2 ? true : EDITABLE_SOURCES.has(sel.source);
                const toolable = v2 && canTools && !sel.readonly_reason && !sel.stale
                  && (sel.occ_kind === 'event' || sel.occ_kind === 'override' || sel.occ_kind === 'orphan_override');
                const showDuplicate = v2 ? toolable : true;
                const selKey = eventKey(sel);
                return (
                  <div className="space-y-2">
                    {!editable && (
                      <p className="text-[11px] text-muted-foreground">
                        {sel.source === 'ics_pull'
                          ? 'Evento importato da sottoscrizione ICS — sola lettura. Modificalo nel calendario di origine.'
                          : 'Evento di sistema — sola lettura.'}
                      </p>
                    )}
                    {v2 && sel.readonly_reason && (
                      <p className="text-[11px] text-muted-foreground">
                        {sel.readonly_reason === 'subscription'
                          ? 'Evento di un\'iscrizione ICS — sola lettura. Modificalo nel calendario di origine.'
                          : sel.readonly_reason === 'archive'
                            ? 'Evento dell\'archivio della Fase 0 — sola lettura.'
                            : sel.readonly_reason === 'unreadable'
                              ? 'Testo non interpretabile (in quarantena): si può solo ispezionare ed eliminare.'
                              : 'Evento in sola lettura.'}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      {editable && (
                        <Button
                          size="sm"
                          variant="outline"
                          className={`text-xs ${showDuplicate ? '' : 'col-span-2'}`}
                          onClick={() => {
                            setEditingEvent(sel);
                            setCreatingFromSlot(null);
                            setShowEditor(true);
                            setSelectedEvent(null);
                          }}
                        >
                          <Pencil className="h-3 w-3 mr-1.5" /> {v2 && sel.readonly_reason ? 'Apri' : 'Modifica'}
                        </Button>
                      )}
                      {showDuplicate && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={v2 ? 'cal-panel-duplicate' : undefined}
                          className={`text-xs ${editable ? '' : 'col-span-2'}`}
                          disabled={!v2 && duplicateMutation.isPending}
                          onClick={() => (v2 ? void duplicateV2(sel) : duplicateMutation.mutate(sel.id))}
                        >
                          <Copy className="h-3 w-3 mr-1.5" />
                          {!v2 && duplicateMutation.isPending ? 'Duplico…' : 'Duplica'}
                        </Button>
                      )}
                      {toolable && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="cal-panel-move"
                          className="col-span-2 text-xs"
                          aria-expanded={moveOpenFor === selKey}
                          onClick={() => setMoveOpenFor(moveOpenFor === selKey ? null : selKey)}
                        >
                          <FolderInput className="h-3 w-3 mr-1.5" /> Sposta in…
                        </Button>
                      )}
                    </div>
                    {toolable && moveOpenFor === selKey && (
                      <div className="space-y-1 rounded-md border p-1.5">
                        {sel.recurring && (
                          <p className="px-1 text-[11px] text-muted-foreground">Si sposta l&apos;intera serie.</p>
                        )}
                        {[...moveTargets.values()].filter((c) => c.id !== sel.calendar_id).map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => void moveToCalendar(sel, c.id)}
                            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                          >
                            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                            <span className="truncate">{c.name}</span>
                          </button>
                        ))}
                        {moveTargets.size <= 1 && (
                          <p className="px-1 text-[11px] text-muted-foreground">Nessun altro calendario disponibile.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
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
