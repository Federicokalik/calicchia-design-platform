import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Info, Trash2 } from 'lucide-react';
import type {
  CalV2FieldValues,
  CalV2Issue,
  CalV2ObjectView,
  CalV2Op,
  CalV2PatchRequest,
  CalV2PreconditionFailedBody,
  CalV2Property,
  CalV2Scope,
  CalV2Time,
  CalV2WriteResult,
} from '@calicchia/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConflictDialog } from '@/components/calendar/conflict-dialog';
import { ScopeDialog } from '@/components/calendar/scope-dialog';
import { useConfirm } from '@/hooks/use-confirm';
import { apiFetch } from '@/lib/api';
import {
  CalV2ApiError,
  CalV2ConflictError,
  calV2ErrorMessage,
  calV2Keys,
  createObjectV2,
  deleteObjectV2,
  getObjectV2,
  patchObjectV2,
  useCalendarV2Capabilities,
} from '@/lib/calendar-v2-api';
import {
  addressToForm,
  allowedScopes,
  buildCreateRequest,
  buildPatch,
  deepEqual,
  draftFromView,
  emptyDraft,
  ensureAlarmDefaults,
  generateEventUid,
  isLikelyAddress,
  normalizeTextFields,
  opKey,
  rebaseAfterConflict,
  timeInstantMs,
  timeRangeError,
  utcMsToWall,
  type EditorDraft,
} from '@/lib/calendar-v2-model';
import { CALENDAR_TZ } from '@/lib/timezone';
import { TabAvanzate } from './tab-avanzate';
import { TabGenerale, type CalendarOption } from './tab-generale';
import { TabPartecipanti } from './tab-partecipanti';
import { TabPromemoria } from './tab-promemoria';
import { TabRicorrenza } from './tab-ricorrenza';
import { TabTempo } from './tab-tempo';

// ─── Props ───────────────────────────────

/** Occorrenza (o evento) della lista v1 `/events`, come la passa la pagina del calendario. */
export interface EditorOccurrence {
  id?: string;
  uid?: string;
  calendar_id: string;
  summary: string;
  start_time: string;
  end_time: string;
  all_day: boolean;
  source?: string;
  /** Istante ISO dell'occorrenza di una serie (non per gli override). */
  original_start?: string | null;
  is_override?: boolean;
}

export interface EventoEditorProps {
  initial?: EditorOccurrence | null;
  /** Nuovo evento da uno slot della griglia. */
  initialStart?: string;
  initialEnd?: string;
  /** Selezione di giorni interi: nuovo evento "tutto il giorno". */
  initialAllDay?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type TabId = 'generale' | 'tempo' | 'ricorrenza' | 'promemoria' | 'partecipanti' | 'avanzate';

const TAB_LABELS: Record<TabId, string> = {
  generale: 'Generale',
  tempo: 'Tempo',
  ricorrenza: 'Ricorrenza',
  promemoria: 'Promemoria',
  partecipanti: 'Partecipanti',
  avanzate: 'Avanzate',
};

/** Campi che cambiano l'anteprima (tempi e ricorrenza). */
const PREVIEW_FIELDS = new Set<string>(['start', 'end', 'duration', 'rrule', 'rdates', 'exdates']);

const READONLY_TEXT: Record<string, string> = {
  subscription: 'Questo evento appartiene a un calendario in sola lettura: è un\'iscrizione a un feed ICS esterno.',
  archive: 'Questo evento appartiene a un calendario archivio (Fase 0): è in sola lettura.',
  unreadable: 'Il testo di questo evento non è interpretabile (è in quarantena): non si può modificare dall\'editor. Il testo grezzo è nella scheda Avanzate; si può ancora eliminare.',
  component_unsupported: 'Questo oggetto è un\'attività o una nota (VTODO o VJOURNAL): l\'editor gestisce solo gli eventi.',
  writes_suspended: 'Le scritture sul calendario sono sospese.',
};

const CAPABILITY_TEXT: Record<string, string> = {
  STORE_POSTGRES: 'il calendario usa ancora l\'archivio interno',
  WRITES_SUSPENDED: 'è in corso un cambio di modalità del calendario',
  WRITE_FREEZE: 'è attivo un blocco delle scritture di manutenzione',
  RADICALE_UNCONFIGURED: 'Radicale non è configurato',
  API_LEVEL_BLOCKED: 'il livello dell\'API non consente le scritture',
};

const NOTICE_TEXT: Record<string, string> = {
  booking_projection: 'Evento generato da una prenotazione: orario e titolo possono essere riscritti dalla prenotazione.',
  index_fallback: 'Radicale non risponde: vedi l\'ultima copia dell\'indice e il salvataggio potrebbe non riuscire.',
  collection_hold: 'La collezione è in sospeso (hold): le scritture possono essere rifiutate finché non viene sistemata.',
};

/** Scheda in cui mostrare un problema, dal nome della proprietà iCalendar. */
function tabForProperty(property: string | undefined): TabId | null {
  if (!property) return null;
  const p = property.toUpperCase();
  if (['SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'STATUS', 'TRANSP', 'CLASS', 'PRIORITY', 'CATEGORIES', 'COLOR', 'GEO'].includes(p)) return 'generale';
  if (['DTSTART', 'DTEND', 'DURATION', 'TZID', 'DUE'].includes(p)) return 'tempo';
  if (['RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID'].includes(p)) return 'ricorrenza';
  if (['VALARM', 'TRIGGER', 'ACTION', 'REPEAT'].includes(p)) return 'promemoria';
  if (['ATTENDEE', 'ORGANIZER'].includes(p)) return 'partecipanti';
  return 'avanzate';
}

type CalendarRow = CalendarOption & { is_default: boolean };

// ─── Caricamento ───────────────────────────────

function LoadingDialog({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogTitle className="sr-only">Evento</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">{text}</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

function ErrorDialog({ error, onRetry, onClose }: { error: unknown; onRetry: () => void; onClose: () => void }) {
  const gone = error instanceof CalV2ApiError && (error.status === 404 || error.code === 'RECURRENCE_TARGET_GONE');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Evento non disponibile</DialogTitle>
        <DialogDescription className="text-sm">
          {gone ? 'L\'evento o questa occorrenza non esiste più: potrebbe essere stato eliminato o spostato da un altro dispositivo. ' : ''}
          {calV2ErrorMessage(error)}
        </DialogDescription>
        <div className="flex justify-end gap-2">
          {!gone && <Button type="button" variant="outline" size="sm" onClick={onRetry}>Riprova</Button>}
          <Button type="button" size="sm" onClick={onClose}>Chiudi</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Editor v2 dell'evento (contratto F6 §6.3): modale a schede sulla vista
 * lossless letta da Radicale. Carica l'oggetto, tiene la bozza e salva con
 * `buildPatch` (solo i campi cambiati) dietro scope, anteprima e conflitti.
 */
export default function EventoEditor(props: EventoEditorProps) {
  const { initial, onClose } = props;
  const objectId = initial?.id ?? '';
  const isEdit = objectId !== '';
  // "Modifica la serie intera": riapre l'oggetto sul master (utile per spostarlo di calendario).
  const [wholeSeries, setWholeSeries] = useState(false);

  const target = wholeSeries
    ? { recurrenceKey: '' }
    : initial?.is_override ? {} : initial?.original_start ? { originalStart: initial.original_start } : {};
  const targetKey = wholeSeries ? 'master' : initial?.is_override ? 'override' : initial?.original_start ? `os:${initial.original_start}` : 'default';

  const objectQuery = useQuery({
    queryKey: calV2Keys.object(objectId, targetKey),
    queryFn: () => getObjectV2(objectId, target),
    enabled: isEdit,
    // La bozza non deve cambiare sotto le mani dell'utente: niente refetch automatici, il ricaricamento è esplicito.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const calendarsQuery = useQuery({
    queryKey: ['admin-calendars'],
    queryFn: () => apiFetch('/api/admin/calendar/calendars'),
  });
  const calendars: CalendarRow[] = useMemo(
    () => ((calendarsQuery.data?.calendars ?? []) as Array<Partial<CalendarRow> & { id: string }>).map((c) => ({
      id: c.id,
      name: c.name ?? c.id,
      color: c.color ?? '#7c3aed',
      timezone: c.timezone || CALENDAR_TZ,
      is_default: !!c.is_default,
    })),
    [calendarsQuery.data],
  );

  if (isEdit && objectQuery.isError) {
    return <ErrorDialog error={objectQuery.error} onRetry={() => { void objectQuery.refetch(); }} onClose={onClose} />;
  }
  if ((isEdit && !objectQuery.data) || (!isEdit && calendarsQuery.isLoading)) {
    return <LoadingDialog text="Caricamento evento…" onClose={onClose} />;
  }

  return (
    <EditorSession
      {...props}
      initialView={isEdit ? objectQuery.data ?? null : null}
      calendars={calendars}
      onOpenSeries={() => setWholeSeries(true)}
    />
  );
}

// ─── Sessione ───────────────────────────────

interface SessionProps extends EventoEditorProps {
  initialView: CalV2ObjectView | null;
  calendars: CalendarRow[];
  onOpenSeries: () => void;
}

/** Tiene la versione del server in uso: dopo "Ricarica" di un conflitto la bozza riparte da quella. */
function EditorSession(props: SessionProps) {
  const [view, setView] = useState<CalV2ObjectView | null>(props.initialView);
  const [generation, setGeneration] = useState(0);
  return (
    <EditorBody
      key={`${view?.etag ?? 'new'}:${generation}`}
      {...props}
      view={view}
      onReload={(next) => { setView(next); setGeneration((g) => g + 1); }}
    />
  );
}

// ─── Bozza iniziale di un evento nuovo ───────────────────────────────

function nextFullHourMs(): number {
  return Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000;
}

function wallTime(ms: number, tz: string): CalV2Time {
  const w = utcMsToWall(ms, tz);
  return { type: 'date-time', ...w, zone: { kind: 'tzid', tzid: tz } };
}

function wallDate(ms: number, tz: string): CalV2Time {
  const w = utcMsToWall(ms, tz);
  return { type: 'date', year: w.year, month: w.month, day: w.day };
}

function initialCreateDraft(
  props: Pick<EventoEditorProps, 'initialStart' | 'initialEnd' | 'initialAllDay'>,
  tz: string,
): EditorDraft {
  const startMs = props.initialStart ? Date.parse(props.initialStart) : NaN;
  const endMs = props.initialEnd ? Date.parse(props.initialEnd) : NaN;
  if (props.initialAllDay) {
    // La griglia lavora in Europe/Rome: i giorni selezionati sono quelli di Roma (fine esclusiva).
    const first = Number.isNaN(startMs) ? wallDate(Date.now(), CALENDAR_TZ) : wallDate(startMs, CALENDAR_TZ);
    let last: CalV2Time | null = Number.isNaN(endMs) ? null : wallDate(endMs, CALENDAR_TZ);
    if (last && timeInstantMs(last, 'UTC') <= timeInstantMs(first, 'UTC')) last = null;
    return emptyDraft(first, last);
  }
  const s = Number.isNaN(startMs) ? nextFullHourMs() : startMs;
  const e = Number.isNaN(endMs) || endMs < s ? s + 3_600_000 : endMs;
  return emptyDraft(wallTime(s, tz), wallTime(e, tz));
}

/** Rimette gli orari nel nuovo fuso del calendario conservando gli istanti (solo se erano nel fuso di prima). */
function retimeToCalendar(fields: CalV2FieldValues, from: string, to: string): Partial<CalV2FieldValues> {
  const move = (t: CalV2Time | null): CalV2Time | null => {
    if (!t || t.type !== 'date-time' || t.zone.kind !== 'tzid' || t.zone.tzid !== from) return t;
    return wallTime(timeInstantMs(t, from), to);
  };
  return { start: move(fields.start) as CalV2Time, end: move(fields.end) };
}

// ─── Corpo dell'editor ───────────────────────────────

interface Conflict {
  body: CalV2PreconditionFailedBody;
  retry: { kind: 'patch'; scope: CalV2Scope; ops: CalV2Op[]; move?: string } | { kind: 'delete'; scope: CalV2Scope };
}

interface BodyProps extends SessionProps {
  view: CalV2ObjectView | null;
  onReload: (next: CalV2ObjectView) => void;
}

function IssueList({ issues }: { issues: CalV2Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="space-y-1" role="alert">
      {issues.map((i, idx) => (
        <li
          key={idx}
          className={`flex gap-1.5 rounded-md border px-2 py-1 text-xs ${
            i.severity === 'error'
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

function EditorBody({ view, calendars, initial, initialStart, initialEnd, initialAllDay, onClose, onSaved, onReload, onOpenSeries }: BodyProps) {
  const confirm = useConfirm();
  const { caps } = useCalendarV2Capabilities();
  const isCreate = view === null;
  const target = view?.target ?? null;
  const targetKey = target?.recurrence_key ?? '';
  const defaultCalendar = calendars.find((c) => c.is_default) ?? calendars[0];

  const [calendarId, setCalendarId] = useState(view?.calendar_id ?? initial?.calendar_id ?? defaultCalendar?.id ?? '');
  const calendarTz = view?.calendar_tz ?? calendars.find((c) => c.id === calendarId)?.timezone ?? CALENDAR_TZ;

  // Bozza di partenza: dal componente target (modifica) o da uno slot/ora corrente (creazione).
  // Calcolata una volta per versione: il corpo viene rimontato quando la versione cambia.
  const [initialDraft] = useState<EditorDraft>(
    () => (target ? draftFromView(target) : initialCreateDraft({ initialStart, initialEnd, initialAllDay }, defaultCalendar?.timezone ?? CALENDAR_TZ)),
  );
  const [draft, setDraft] = useState<EditorDraft>(initialDraft);
  const [uid] = useState(generateEventUid);
  const [tab, setTab] = useState<TabId>(view?.readonly_reason === 'unreadable' ? 'avanzate' : 'generale');
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scopeAsk, setScopeAsk] = useState<{ action: 'edit' | 'delete'; allowed: CalV2Scope[]; ops: CalV2Op[]; base: Record<string, string>; move?: string } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [serverIssues, setServerIssues] = useState<CalV2Issue[]>([]);

  const patchFields = (patch: Partial<CalV2FieldValues>) => setDraft((d) => ({ ...d, fields: { ...d.fields, ...patch } }));
  const setExtra = (extra: Record<string, CalV2Property[]>) => setDraft((d) => ({ ...d, extra }));

  // ─── Stato di scrittura ───
  const readonlyReason = view?.readonly_reason ?? null;
  const writesOff = caps ? !caps.objects.write : false;
  const readOnly = !isCreate && (!!readonlyReason || writesOff || !view?.etag);
  const unreadable = readonlyReason === 'unreadable';
  const disabled = readOnly || saving;
  const writeBlockers = caps?.reasons.map((r) => CAPABILITY_TEXT[r]).filter(Boolean) ?? [];

  // ─── Bozza normalizzata e differenze ───
  const normalized = useMemo<EditorDraft>(() => {
    const base = normalizeTextFields(initialDraft, draft);
    const initialAlarms = new Set(initialDraft.fields.alarms.map((a) => JSON.stringify(a)));
    // I promemoria toccati vengono completati dei testi richiesti dallo standard; gli altri restano identici.
    base.fields.alarms = base.fields.alarms.map((a) => (initialAlarms.has(JSON.stringify(a)) ? a : ensureAlarmDefaults(a)));
    return base;
  }, [initialDraft, draft]);

  const patch = useMemo(
    () => (target && !isCreate ? buildPatch(initialDraft, normalized, target.tokens) : { ops: [] as CalV2Op[], base: {} as Record<string, string> }),
    [target, isCreate, initialDraft, normalized],
  );
  const calendarChanged = !isCreate && !!view && calendarId !== view.calendar_id;
  const dirty = isCreate ? !deepEqual(normalized, initialDraft) : patch.ops.length > 0 || calendarChanged;

  // ─── Validazione locale ───
  const calendarMissing = isCreate && !calendarId;
  const summaryMissing = (isCreate || !!initialDraft.fields.summary) && !normalized.fields.summary;
  const timeError = timeRangeError(draft.fields, calendarTz);
  const addressesInvalid = [...draft.fields.attendees, ...(draft.fields.organizer ? [draft.fields.organizer] : [])]
    .some((p) => !isLikelyAddress(addressToForm(p).email));
  const blockers = [
    summaryMissing && attempted ? 'Inserisci il titolo.' : null,
    timeError,
    addressesInvalid ? 'Correggi gli indirizzi email degli invitati.' : null,
    calendarMissing ? 'Scegli un calendario.' : null,
  ].filter((x): x is string => !!x);
  const canWrite = !disabled && (isCreate || !!target);
  const saveEnabled = canWrite && (isCreate || dirty) && !summaryMissing && !timeError && !addressesInvalid && !calendarMissing;

  // ─── Scope ───
  const scopesFor = (ops: readonly CalV2Op[], move?: string): CalV2Scope[] => {
    if (!view) return [];
    let scopes = allowedScopes(view, targetKey, ops, 'edit');
    if (move) scopes = scopes.filter((s) => s === 'all');
    const supported = caps?.objects.scopes ?? [];
    if (supported.length) scopes = scopes.filter((s) => supported.includes(s));
    return scopes;
  };

  // ─── Anteprima (dryRun, debounce 500 ms) ───
  const previewOps = patch.ops.filter((o) => o.op === 'set' && PREVIEW_FIELDS.has(o.field));
  const previewScope = view ? (() => {
    const s = scopesFor(previewOps);
    return s.includes('all') ? 'all' : s[0];
  })() : undefined;
  const dryRunOk = caps ? caps.objects.dry_run : true;
  const previewRequest = ((): unknown => {
    if (!dryRunOk || timeError || addressesInvalid || readonlyReason || unreadable) return null;
    if (isCreate) {
      if (!normalized.fields.rrule) return null;
      return buildCreateRequest(
        { ...normalized, fields: { ...normalized.fields, summary: normalized.fields.summary ?? 'Evento' } },
        calendarId, uid, true,
      );
    }
    if (!previewOps.length || !previewScope) return null;
    const base: Record<string, string> = {};
    for (const o of previewOps) base[opKey(o)] = patch.base[opKey(o)];
    return { target: { recurrence_key: targetKey }, scope: previewScope, ops: previewOps, base, dryRun: true } satisfies CalV2PatchRequest;
  })();

  const payload = previewRequest ? JSON.stringify(previewRequest) : '';
  const [debounced, setDebounced] = useState(payload);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(payload), 500);
    return () => clearTimeout(t);
  }, [payload]);

  const previewQuery = useQuery({
    queryKey: calV2Keys.preview(view?.id ?? 'new', debounced),
    queryFn: () => (isCreate
      ? createObjectV2(JSON.parse(debounced))
      : patchObjectV2(view!.id, view!.etag!, JSON.parse(debounced))),
    enabled: debounced !== '' && payload !== '',
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
    gcTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const previewActive = payload !== '';
  const previewData = previewActive ? previewQuery.data : undefined;
  const preview = previewData?.object?.preview ?? view?.preview ?? null;
  const previewPending = previewActive && (payload !== debounced || previewQuery.isFetching);
  const orphaned = previewData?.orphaned_overrides ?? [];
  const issues = useMemo(() => {
    const all = [...(previewData?.issues ?? []), ...serverIssues];
    const seen = new Set<string>();
    return all.filter((i) => {
      const key = `${i.severity}:${i.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [previewData, serverIssues]);

  // ─── Esiti ───
  const finish = (message: string, kind: 'success' | 'info' | 'warning' = 'success') => {
    toast[kind](message);
    onSaved();
    onClose();
  };

  const finishWrite = (result: CalV2WriteResult, created: boolean) => {
    if (result.orphaned_overrides.length) {
      toast.warning(`${result.orphaned_overrides.length} occorrenze modificate non corrispondono più alla serie`);
    }
    if (created) finish('Evento creato');
    else if (result.noop) finish('Nessuna modifica da salvare', 'info');
    else if (result.tail) finish('Serie divisa: le modifiche valgono da questa occorrenza in poi');
    else if (result.merged) finish('Evento aggiornato (unito alle modifiche fatte altrove)');
    else finish('Evento aggiornato');
  };

  const handleError = (err: unknown, retry?: Conflict['retry']) => {
    if (err instanceof CalV2ConflictError) {
      if (retry) setConflict({ body: err.body, retry });
      else toast.error(err.message);
      return;
    }
    if (err instanceof CalV2ApiError) {
      if (err.code === 'VALIDATION_FAILED' && Array.isArray(err.details?.issues)) {
        const list = err.details.issues as CalV2Issue[];
        setServerIssues(list);
        const firstError = list.find((i) => i.severity === 'error') ?? list[0];
        if (firstError) setTab(tabForProperty(firstError.property) ?? 'generale');
        toast.error(err.message || 'Alcuni dati non sono validi');
        return;
      }
      if (err.code === 'RECURRENCE_TARGET_GONE' || err.code === 'NOT_FOUND' || err.status === 404) {
        toast.error(`${err.message}. Ricarico il calendario.`);
        onSaved();
        onClose();
        return;
      }
      if (err.code === 'MOVE_CONFLICT' && err.details?.patched) {
        toast.warning(`Modifiche salvate, ma lo spostamento nell'altro calendario non è riuscito: ${err.message}`);
        onSaved();
        onClose();
        return;
      }
      if (err.code === 'OBJECT_EXISTS') {
        finish('L\'evento risulta già creato: probabilmente il salvataggio precedente era riuscito', 'info');
        return;
      }
    }
    // 503 (scritture sospese o Radicale irraggiungibile) e il resto: il form resta com'è.
    toast.error(calV2ErrorMessage(err));
  };

  // ─── Scritture ───
  const runPatch = async (args: { etag: string; ops: CalV2Op[]; base: Record<string, string>; scope: CalV2Scope; move?: string }) => {
    if (!view) return;
    setSaving(true);
    setServerIssues([]);
    try {
      const result = await patchObjectV2(view.id, args.etag, {
        target: { recurrence_key: targetKey },
        scope: args.scope,
        ops: args.ops,
        base: args.base,
        ...(args.move ? { move_to_calendar_id: args.move } : {}),
      });
      finishWrite(result, false);
    } catch (err) {
      handleError(err, { kind: 'patch', scope: args.scope, ops: args.ops, move: args.move });
    } finally {
      setSaving(false);
    }
  };

  const runDelete = async (scope: CalV2Scope, etag: string) => {
    if (!view) return;
    setSaving(true);
    try {
      await deleteObjectV2(view.id, etag, { scope, recurrenceKey: targetKey });
      finish(scope === 'this' ? 'Occorrenza eliminata' : scope === 'this_and_future' ? 'Serie accorciata' : view.recurring ? 'Serie eliminata' : 'Evento eliminato');
    } catch (err) {
      handleError(err, { kind: 'delete', scope });
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setAttempted(true);
    if (!saveEnabled) return;
    if (isCreate) {
      setSaving(true);
      setServerIssues([]);
      try {
        finishWrite(await createObjectV2(buildCreateRequest(normalized, calendarId, uid)), true);
      } catch (err) {
        handleError(err);
      } finally {
        setSaving(false);
      }
      return;
    }
    const move = calendarChanged ? calendarId : undefined;
    if (!patch.ops.length && !move) {
      onClose();
      return;
    }
    const allowed = scopesFor(patch.ops, move);
    if (!allowed.length) {
      toast.error('Questa combinazione di modifiche non è ammessa per questo evento.');
      return;
    }
    if (allowed.length === 1) {
      await runPatch({ etag: view!.etag!, ops: patch.ops, base: patch.base, scope: allowed[0], move });
    } else {
      setScopeAsk({ action: 'edit', allowed, ops: patch.ops, base: patch.base, move });
    }
  };

  const startDelete = async () => {
    if (!view?.etag || view.delete_blocked_reason) return;
    const allowed = allowedScopes(view, targetKey, [], 'delete');
    if (!allowed.length) return;
    if (allowed.length > 1) {
      setScopeAsk({ action: 'delete', allowed, ops: [], base: {} });
      return;
    }
    const whole = view.recurring && targetKey === '';
    if (await confirm({
      title: whole ? 'Eliminare l\'intera serie?' : 'Eliminare questo evento?',
      description: whole ? 'Verranno eliminate tutte le occorrenze di questo evento ricorrente.' : undefined,
      variant: 'destructive',
    })) await runDelete(allowed[0], view.etag);
  };

  const onScopeChosen = (scope: CalV2Scope) => {
    const ask = scopeAsk;
    setScopeAsk(null);
    if (!ask || !view?.etag) return;
    // La scelta dell'ambito è già esplicita: nessuna seconda conferma.
    if (ask.action === 'delete') void runDelete(scope, view.etag);
    else void runPatch({ etag: view.etag, ops: ask.ops, base: ask.base, scope, move: ask.move });
  };

  const resolveConflict = (keepMine: Set<string>) => {
    const c = conflict;
    if (!c) return;
    setConflict(null);
    const etag = c.body.current.etag;
    if (!etag) {
      toast.error('La versione del server non ha un ETag: ricarico l\'evento');
      onReload(c.body.current);
      return;
    }
    if (c.retry.kind === 'delete') {
      void runDelete(c.retry.scope, etag);
      return;
    }
    const rebased = rebaseAfterConflict({ ops: c.retry.ops }, c.body, keepMine);
    if (!rebased.ops.length && !c.retry.move) {
      toast.info('Hai scelto i valori del server: apro la versione attuale');
      onReload(c.body.current);
      return;
    }
    void runPatch({ etag: rebased.etag, ops: rebased.ops, base: rebased.base, scope: c.retry.scope, move: c.retry.move });
  };

  const requestClose = async () => {
    if (saving) return;
    if (dirty && !readOnly && !(await confirm({
      title: 'Scartare le modifiche?',
      description: 'Le modifiche non salvate andranno perse.',
      variant: 'destructive',
    }))) return;
    onClose();
  };

  const openSeries = async () => {
    if (dirty && !(await confirm({
      title: 'Aprire la serie intera?',
      description: 'Le modifiche non salvate di questa occorrenza andranno perse.',
      variant: 'destructive',
    }))) return;
    onOpenSeries();
  };

  // ─── Schede ───
  const hasForm = isCreate || !!target;
  const tabs: TabId[] = !hasForm
    ? ['avanzate']
    : [
        'generale', 'tempo',
        ...(target?.is_override ? [] : ['ricorrenza' as const]),
        'promemoria', 'partecipanti', 'avanzate',
      ];
  const issueTab = (i: CalV2Issue): TabId => tabForProperty(i.property) ?? 'generale';
  const issueTabs = new Set(issues.filter((i) => i.severity === 'error').map(issueTab));
  const tabIssues = (id: TabId) => issues.filter((i) => issueTab(i) === id);

  const calendarLockedReason = isCreate ? null
    : targetKey !== ''
      ? 'In una serie il calendario si cambia solo per la serie intera.'
      : null;

  const canDelete = !isCreate && !!view?.etag && !writesOff && !view.delete_blocked_reason && (!readonlyReason || readonlyReason === 'unreadable');
  const heading = isCreate ? 'Nuovo evento' : 'Modifica evento';
  const kindBadge = !view?.recurring ? null : targetKey === '' ? 'Serie' : target?.is_override ? 'Occorrenza modificata' : 'Occorrenza della serie';

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void requestClose(); }}>
      <DialogContent className="max-w-3xl gap-0 p-0" aria-describedby={undefined}>
        <div className="flex flex-wrap items-center gap-2 border-b px-6 py-4 pr-14">
          <DialogTitle className="text-base font-semibold">{heading}</DialogTitle>
          {kindBadge && <Badge variant="secondary">{kindBadge}</Badge>}
        </div>

        <div className="max-h-[calc(100dvh-14rem)] min-h-[22rem] space-y-3 overflow-y-auto px-6 py-4">
          {readOnly && (
            <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium">Sola lettura</p>
                <p>
                  {readonlyReason && readonlyReason !== 'writes_suspended'
                    ? READONLY_TEXT[readonlyReason]
                    : writesOff || readonlyReason === 'writes_suspended'
                      ? `${READONLY_TEXT.writes_suspended}${writeBlockers.length ? ` Motivo: ${writeBlockers.join('; ')}.` : ''}`
                      : 'Radicale non ha fornito la versione corrente dell\'evento.'}
                </p>
              </div>
            </div>
          )}
          {(view?.notices ?? []).filter((n) => NOTICE_TEXT[n]).map((n) => (
            <div key={n} className="flex gap-2 rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>{NOTICE_TEXT[n]}</span>
            </div>
          ))}
          {view?.delete_blocked_reason === 'booking_active' && (
            <div className="flex gap-2 rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>Prenotazione attiva: per eliminare questo evento annulla prima la prenotazione.</span>
            </div>
          )}

          <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
            <TabsList className="flex h-auto w-full flex-wrap justify-start">
              {tabs.map((id) => (
                <TabsTrigger key={id} value={id} className="relative">
                  {TAB_LABELS[id]}
                  {issueTabs.has(id) && <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-destructive" aria-label="Contiene errori" />}
                </TabsTrigger>
              ))}
            </TabsList>

            {hasForm ? (
              <>
                <TabsContent value="generale" className="space-y-3 pt-3">
                  <IssueList issues={tabIssues('generale')} />
                  <TabGenerale
                    fields={draft.fields}
                    onChange={patchFields}
                    disabled={disabled}
                    mode={isCreate ? 'create' : 'edit'}
                    calendars={calendars}
                    calendarId={calendarId}
                    onCalendarChange={(id) => {
                      if (isCreate) {
                        const from = calendars.find((c) => c.id === calendarId)?.timezone ?? CALENDAR_TZ;
                        const to = calendars.find((c) => c.id === id)?.timezone ?? CALENDAR_TZ;
                        if (from !== to) patchFields(retimeToCalendar(draft.fields, from, to));
                      }
                      setCalendarId(id);
                    }}
                    calendarLockedReason={calendarLockedReason}
                    onOpenSeries={calendarLockedReason && view?.recurring && view.master ? () => { void openSeries(); } : undefined}
                    summaryError={summaryMissing && (attempted || !isCreate) ? 'Il titolo è obbligatorio.' : null}
                  />
                </TabsContent>

                <TabsContent value="tempo" className="space-y-3 pt-3">
                  <IssueList issues={tabIssues('tempo')} />
                  <TabTempo fields={draft.fields} onChange={patchFields} tz={calendarTz} disabled={disabled} error={timeError} />
                </TabsContent>

                {!target?.is_override && (
                  <TabsContent value="ricorrenza" className="space-y-3 pt-3">
                    <IssueList issues={tabIssues('ricorrenza')} />
                    <TabRicorrenza
                      fields={draft.fields}
                      onChange={patchFields}
                      tz={calendarTz}
                      disabled={disabled}
                      preview={preview}
                      previewPending={previewPending}
                      orphanedOverrides={orphaned}
                    />
                  </TabsContent>
                )}

                <TabsContent value="promemoria" className="space-y-3 pt-3">
                  <IssueList issues={tabIssues('promemoria')} />
                  <TabPromemoria
                    alarms={draft.fields.alarms}
                    onChange={(alarms) => patchFields({ alarms })}
                    tz={calendarTz}
                    disabled={disabled}
                  />
                </TabsContent>

                <TabsContent value="partecipanti" className="space-y-3 pt-3">
                  <IssueList issues={tabIssues('partecipanti')} />
                  <TabPartecipanti fields={draft.fields} onChange={patchFields} disabled={disabled} />
                </TabsContent>
              </>
            ) : null}

            <TabsContent value="avanzate" className="space-y-3 pt-3">
              <IssueList issues={tabIssues('avanzate')} />
              <TabAvanzate
                mode={isCreate ? 'create' : 'edit'}
                view={view}
                target={target}
                extra={draft.extra}
                onExtraChange={setExtra}
                disabled={disabled || unreadable}
              />
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-6 py-4">
          <div className="flex flex-wrap gap-2">
            {canDelete && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={saving}
                onClick={() => { void startDelete(); }}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Elimina
              </Button>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {blockers.length > 0 && !readOnly && (
              <span className="max-w-xs text-right text-xs text-destructive">{blockers[0]}</span>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => { void requestClose(); }}>
              {readOnly ? 'Chiudi' : 'Annulla'}
            </Button>
            {!readOnly && (
              <Button type="button" size="sm" onClick={() => { void save(); }} disabled={saving || (attempted && !saveEnabled) || (!isCreate && !dirty)}>
                {saving ? 'Salvataggio…' : 'Salva'}
              </Button>
            )}
          </div>
        </div>

        <ScopeDialog
          open={!!scopeAsk}
          action={scopeAsk?.action ?? 'edit'}
          allowed={scopeAsk?.allowed ?? []}
          onChoose={onScopeChosen}
          onCancel={() => setScopeAsk(null)}
        />
        {conflict && (
          <ConflictDialog
            key={conflict.body.current.etag ?? 'conflict'}
            open
            body={conflict.body}
            pendingOps={conflict.retry.kind === 'patch' ? conflict.retry.ops : []}
            onResolve={resolveConflict}
            onReload={() => { const c = conflict; setConflict(null); onReload(c.body.current); }}
            onCancel={() => setConflict(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
