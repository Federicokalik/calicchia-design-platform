/**
 * Modello puro dell'editor del calendario v2 (nessun React; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §6.2).
 *
 * L'admin non importa calendar-core: lavora sul JSON dei DTO di
 * `@calicchia/shared` partendo sempre dal componente grezzo ricevuto dal
 * server. Un VALARM o un ATTENDEE modificato conserva quindi le proprietà e i
 * parametri che l'editor non conosce, e un campo non toccato non genera
 * nessuna operazione (la scrittura è lossless, design §8).
 */

import {
  CAL_V2_ABSENT_TOKEN,
  CAL_V2_FIELDS,
  CAL_V2_SERIES_ONLY_FIELDS,
  type CalV2Component,
  type CalV2CreateRequest,
  type CalV2DateTime,
  type CalV2Duration,
  type CalV2FieldValues,
  type CalV2ComponentView,
  type CalV2ObjectView,
  type CalV2Op,
  type CalV2Param,
  type CalV2PreconditionFailedBody,
  type CalV2Property,
  type CalV2Scope,
  type CalV2Time,
} from '@calicchia/shared';

// ─── Utilità generiche ───────────────────────────────

/** Copia profonda di un valore JSON. */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Uguaglianza profonda di valori JSON (indipendente dall'ordine delle chiavi). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao);
  if (ka.length !== Object.keys(bo).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** UID per un evento nuovo, generato all'apertura del form (retry sicuro, contratto §3.6). */
export function generateEventUid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  let id: string;
  if (c && typeof c.randomUUID === 'function') {
    id = c.randomUUID();
  } else {
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${id}@calicchia.design`;
}

// ─── Bozza dell'editor ───────────────────────────────

export interface EditorDraft {
  fields: CalV2FieldValues;
  /** Proprietà non tipizzate per nome (X-*, CONFERENCE, ATTACH, RELATED-TO, ...). */
  extra: Record<string, CalV2Property[]>;
}

/** Bozza di partenza dal componente target (copia: la vista resta immutata). */
export function draftFromView(target: CalV2ComponentView): EditorDraft {
  return { fields: cloneJson(target.fields), extra: cloneJson(target.extra_properties) };
}

/** Campi tipizzati di un evento vuoto (creazione). */
export function emptyFields(start: CalV2Time, end: CalV2Time | null): CalV2FieldValues {
  return {
    summary: null,
    description: null,
    location: null,
    url: null,
    status: null,
    transp: null,
    class: null,
    priority: null,
    categories: [],
    color: null,
    geo: null,
    start,
    end,
    duration: null,
    rrule: null,
    rdates: [],
    exdates: [],
    alarms: [],
    organizer: null,
    attendees: [],
  };
}

export function emptyDraft(start: CalV2Time, end: CalV2Time | null): EditorDraft {
  return { fields: emptyFields(start, end), extra: {} };
}

/**
 * Normalizza i testi liberi toccati dall'utente (trim, vuoto → null) senza
 * cambiare quelli rimasti uguali all'iniziale: una pura rinomina non deve
 * generare operazioni su descrizione e luogo.
 */
export function normalizeTextFields(initial: EditorDraft, draft: EditorDraft): EditorDraft {
  const next = cloneJson(draft);
  for (const f of ['summary', 'description', 'location', 'url', 'class', 'color'] as const) {
    const cur = next.fields[f];
    if (cur === initial.fields[f]) continue;
    const trimmed = typeof cur === 'string' ? cur.trim() : cur;
    next.fields[f] = (trimmed ? trimmed : null) as never;
  }
  return next;
}

/** Chiave dei token/base di una proprietà non tipizzata. */
export function propKey(name: string): string {
  return `prop:${name}`;
}

/** Chiave (campo o `prop:<NOME>`) toccata da un'operazione. */
export function opKey(op: CalV2Op): string {
  return op.op === 'set' ? op.field : propKey(op.name);
}

/**
 * Operazioni solo per i campi e le proprietà cambiati (confronto profondo),
 * con il token di base preso da `target.tokens` (`CAL_V2_ABSENT_TOKEN` per le
 * proprietà nuove). Se nessun promemoria è cambiato non esce l'op `alarms`.
 */
export function buildPatch(
  initial: EditorDraft,
  draft: EditorDraft,
  tokens: Record<string, string>,
): { ops: CalV2Op[]; base: Record<string, string> } {
  const ops: CalV2Op[] = [];
  const base: Record<string, string> = {};
  for (const field of CAL_V2_FIELDS) {
    if (deepEqual(initial.fields[field], draft.fields[field])) continue;
    ops.push({ op: 'set', field, value: cloneJson(draft.fields[field]) } as CalV2Op);
    base[field] = tokens[field] ?? CAL_V2_ABSENT_TOKEN;
  }
  const names = new Set([...Object.keys(initial.extra), ...Object.keys(draft.extra)]);
  for (const name of [...names].sort()) {
    const before = initial.extra[name] ?? [];
    const after = draft.extra[name] ?? [];
    if (deepEqual(before, after)) continue;
    ops.push({ op: 'set_property', name, properties: cloneJson(after) });
    const key = propKey(name);
    base[key] = tokens[key] ?? CAL_V2_ABSENT_TOKEN;
  }
  return { ops, base };
}

/** Richiesta di creazione dai campi del form: solo ciò che differisce da un evento vuoto, più start e titolo. */
export function buildCreateRequest(draft: EditorDraft, calendarId: string, uid: string, dryRun = false): CalV2CreateRequest {
  const empty = emptyFields(draft.fields.start, null);
  const fields: Record<string, unknown> = { start: cloneJson(draft.fields.start) };
  for (const field of CAL_V2_FIELDS) {
    if (field === 'start') continue;
    if (field === 'summary' ? draft.fields.summary === null : deepEqual(empty[field], draft.fields[field])) continue;
    fields[field] = cloneJson(draft.fields[field]);
  }
  const properties: Record<string, CalV2Property[]> = {};
  for (const [name, list] of Object.entries(draft.extra)) {
    if (list.length) properties[name] = cloneJson(list);
  }
  const req: CalV2CreateRequest = {
    calendar_id: calendarId,
    uid,
    fields: fields as CalV2CreateRequest['fields'],
  };
  if (Object.keys(properties).length) req.properties = properties;
  if (dryRun) req.dryRun = true;
  return req;
}

// ─── Scope ───────────────────────────────

/** Vero se fra le operazioni c'è un campo di serie (rrule, rdates, exdates): mai con scope `this`. */
export function touchesSeriesFields(ops: readonly CalV2Op[]): boolean {
  return ops.some((o) => o.op === 'set' && (CAL_V2_SERIES_ONLY_FIELDS as readonly string[]).includes(o.field));
}

/**
 * Scope ammessi (contratto §3.7 e §3.8) per il target `targetKey`:
 * evento singolo o master → solo `all` (si applica senza chiedere);
 * istanza o override di una serie → tutti e tre, `this` escluso se si toccano
 * ricorrenza o date della serie; override senza master → solo `this`
 * (in eliminazione anche `all`, che cancella la risorsa).
 */
export function allowedScopes(
  view: CalV2ObjectView,
  targetKey: string,
  ops: readonly CalV2Op[],
  action: 'edit' | 'delete',
): CalV2Scope[] {
  if (view.parse_error !== null) return action === 'delete' ? ['all'] : [];
  if (!view.master) {
    if (view.overrides.length === 0) return [];
    return action === 'delete' ? ['this', 'all'] : ['this'];
  }
  if (!view.recurring || targetKey === '') return ['all'];
  if (action === 'delete') return ['this', 'this_and_future', 'all'];
  return touchesSeriesFields(ops) ? ['this_and_future', 'all'] : ['this', 'this_and_future', 'all'];
}

// ─── Fusi e tempi ───────────────────────────────

export interface TimeForm {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:mm` (o `HH:mm:ss` se ci sono secondi); null per una DATE. */
  time: string | null;
  /** TZID IANA, `UTC` per l'ora Zulu, null se fluttuante o DATE. */
  tzid: string | null;
  floating: boolean;
}

export function timeToForm(t: CalV2Time): TimeForm {
  const date = `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
  if (t.type === 'date') return { date, time: null, tzid: null, floating: false };
  const time = t.second ? `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}` : `${pad(t.hour)}:${pad(t.minute)}`;
  if (t.zone.kind === 'utc') return { date, time, tzid: 'UTC', floating: false };
  if (t.zone.kind === 'floating') return { date, time, tzid: null, floating: true };
  return { date, time, tzid: t.zone.tzid, floating: false };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Vero se data (e ora, se presente) del form sono interpretabili. */
export function isTimeFormValid(f: TimeForm): boolean {
  const d = DATE_RE.exec(f.date);
  if (!d) return false;
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== day) return false;
  if (f.time === null) return true;
  const t = TIME_RE.exec(f.time);
  return !!t && Number(t[1]) < 24 && Number(t[2]) < 60 && Number(t[3] ?? 0) < 60;
}

/**
 * Form → tempo del DTO. Senza ora è una DATE; con l'ora, `floating` vince,
 * `tzid === 'UTC'` è l'ora Zulu, altrimenti è TZID. Senza fuso né
 * fluttuante il valore resta fluttuante (l'editor imposta sempre un TZID).
 */
export function formToTime(f: TimeForm): CalV2Time {
  if (!isTimeFormValid(f)) throw new RangeError('Data o ora non valide');
  const d = DATE_RE.exec(f.date)!;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  if (f.time === null) return { type: 'date', year, month, day };
  const t = TIME_RE.exec(f.time)!;
  const zone: CalV2DateTime['zone'] = f.floating || !f.tzid
    ? { kind: 'floating' }
    : f.tzid === 'UTC' ? { kind: 'utc' } : { kind: 'tzid', tzid: f.tzid };
  return {
    type: 'date-time', year, month, day,
    hour: Number(t[1]), minute: Number(t[2]), second: Number(t[3] ?? 0),
    zone,
  };
}

/** Millisecondi "da muro" (le componenti lette come se fossero UTC). */
function wallMs(t: CalV2Time): number {
  return t.type === 'date'
    ? Date.UTC(t.year, t.month - 1, t.day)
    : Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
}

function timeFromWallMs(ms: number, like: CalV2Time): CalV2Time {
  const d = new Date(ms);
  const date = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  if (like.type === 'date') return { type: 'date', ...date };
  return { ...like, ...date, hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

/** Sposta un tempo di N minuti da muro (stesso fuso: la durata nominale resta quella). */
export function shiftTimeMinutes(t: CalV2Time, minutes: number): CalV2Time {
  return timeFromWallMs(wallMs(t) + minutes * 60_000, t);
}

/** Sposta un tempo di N giorni di calendario. */
export function shiftTimeDays(t: CalV2Time, days: number): CalV2Time {
  return shiftTimeMinutes(t, days * 1440);
}

/** Differenza `b - a` in minuti da muro (come `durationToMinutes` per DTEND - DTSTART nello stesso fuso). */
export function wallDiffMinutes(a: CalV2Time, b: CalV2Time): number {
  return Math.round((wallMs(b) - wallMs(a)) / 60_000);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(tz: string): Intl.DateTimeFormat | null {
  let f = formatterCache.get(tz);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return null;
  }
  formatterCache.set(tz, f);
  return f;
}

/** Offset (ms) del fuso `tz` rispetto a UTC all'istante `ts` (0 se il fuso è sconosciuto). */
function tzOffsetMs(ts: number, tz: string): number {
  const f = tzFormatter(tz);
  if (!f) return 0;
  const parts = f.formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - ts;
}

/** Istante UTC (ms) di un'ora da muro nel fuso `tz` (offset a due passaggi per i bordi DST). */
export function wallToUtcMs(wall: number, tz: string): number {
  let ts = wall - tzOffsetMs(wall, tz);
  const second = wall - tzOffsetMs(ts, tz);
  if (second !== ts) ts = second;
  return ts;
}

/** Componenti da muro di un istante UTC nel fuso `tz`. */
export function utcMsToWall(ms: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const d = new Date(ms + tzOffsetMs(ms, tz));
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
}

/** Istante UTC (ms) di un tempo; i valori fluttuanti e le DATE usano `fallbackTz`. */
export function timeInstantMs(t: CalV2Time, fallbackTz: string): number {
  const wall = wallMs(t);
  if (t.type === 'date') return wallToUtcMs(wall, fallbackTz);
  if (t.zone.kind === 'utc') return wall;
  return wallToUtcMs(wall, t.zone.kind === 'tzid' ? t.zone.tzid : fallbackTz);
}

/** Errore di coerenza fra inizio, fine e durata (null se va bene); `tz` serve per i valori fluttuanti. */
export function timeRangeError(fields: Pick<CalV2FieldValues, 'start' | 'end' | 'duration'>, tz: string): string | null {
  const { start, end, duration } = fields;
  if (duration && durationToMinutes(duration) < 0) return 'La durata non può essere negativa';
  if (!end) return null;
  if ((start.type === 'date') !== (end.type === 'date')) {
    return "Inizio e fine devono essere entrambi con l'ora oppure entrambi di giornata intera";
  }
  if (start.type === 'date') return wallMs(end) <= wallMs(start) ? "L'ultimo giorno non può precedere il primo" : null;
  return timeInstantMs(end, tz) < timeInstantMs(start, tz) ? "La fine non può precedere l'inizio" : null;
}

type TimeFields = Pick<CalV2FieldValues, 'start' | 'end' | 'duration'>;

/**
 * Passa un evento da "con l'ora" a "tutto il giorno" e viceversa. Verso la
 * giornata intera la fine (esclusiva) è il giorno dopo l'ultimo; verso l'ora
 * l'evento parte alle 9:00 nel fuso `tz` e dura un'ora. La forma dell'evento
 * (DTEND o DURATION) si conserva.
 */
export function setAllDay(fields: TimeFields, allDay: boolean, tz: string): TimeFields {
  const { start, end, duration } = fields;
  if (allDay === (start.type === 'date')) return fields;
  if (allDay) {
    const day = (t: CalV2Time): CalV2Time => ({ type: 'date', year: t.year, month: t.month, day: t.day });
    const startDate = day(start);
    let endDate: CalV2Time | null = null;
    if (end) {
      endDate = day(end);
      if (end.type === 'date-time' && (end.hour || end.minute || end.second)) endDate = shiftTimeDays(endDate, 1);
      if (wallMs(endDate) <= wallMs(startDate)) endDate = shiftTimeDays(startDate, 1);
    }
    const days = duration ? Math.max(1, Math.ceil(durationToMinutes(duration) / 1440)) : 0;
    return {
      start: startDate,
      end: endDate,
      duration: duration ? { negative: false, weeks: 0, days, hours: 0, minutes: 0, seconds: 0 } : null,
    };
  }
  const timedStart: CalV2Time = {
    type: 'date-time', year: start.year, month: start.month, day: start.day,
    hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: tz },
  };
  if (duration) return { start: timedStart, end: null, duration: minutesToDuration(60) };
  return { start: timedStart, end: shiftTimeMinutes(timedStart, 60), duration: null };
}

/** Fusi IANA noti al browser (più `UTC`), ordinati. */
export function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = [];
  try {
    zones = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  if (!zones.length) zones = ['Europe/Rome', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
  return [...new Set([...zones, 'UTC'])].sort((a, b) => a.localeCompare(b));
}

// ─── Durate ───────────────────────────────

/** Durata → minuti (arrotondati; il segno vale per tutta la durata). */
export function durationToMinutes(d: CalV2Duration): number {
  const total = ((d.weeks * 7 + d.days) * 24 + d.hours) * 60 + d.minutes + d.seconds / 60;
  return Math.round(d.negative ? -total : total);
}

/** Minuti → durata in giorni, ore e minuti (mai settimane: non si mescolano con le altre unità, RFC 5545). */
export function minutesToDuration(minutes: number): CalV2Duration {
  const negative = minutes < 0;
  const abs = Math.round(Math.abs(minutes));
  return {
    negative,
    weeks: 0,
    days: Math.floor(abs / 1440),
    hours: Math.floor((abs % 1440) / 60),
    minutes: abs % 60,
    seconds: 0,
  };
}

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

/** `-PT15M` → durata; null se non è una durata iCalendar. */
export function parseDurationString(s: string): CalV2Duration | null {
  const m = DURATION_RE.exec(s.trim());
  if (!m || /^[+-]?P$/i.test(s.trim()) || /T$/i.test(s.trim())) return null;
  return {
    negative: m[1] === '-',
    weeks: Number(m[2] ?? 0), days: Number(m[3] ?? 0),
    hours: Number(m[4] ?? 0), minutes: Number(m[5] ?? 0), seconds: Number(m[6] ?? 0),
  };
}

/** Durata → `-PT15M`. */
export function formatDurationString(d: CalV2Duration): string {
  let out = d.negative ? '-P' : 'P';
  if (d.weeks) out += `${d.weeks}W`;
  if (d.days) out += `${d.days}D`;
  if (d.hours || d.minutes || d.seconds) {
    out += 'T';
    if (d.hours) out += `${d.hours}H`;
    if (d.minutes) out += `${d.minutes}M`;
    if (d.seconds) out += `${d.seconds}S`;
  }
  return out === 'P' || out === '-P' ? `${out}T0S` : out;
}

export type DurationUnit = 'minutes' | 'hours' | 'days' | 'weeks';

/** Quantità e unità più naturali di una durata (per i campi numerici dei form). */
export function durationToAmountUnit(d: CalV2Duration): { amount: number; unit: DurationUnit; negative: boolean } {
  const minutes = Math.abs(durationToMinutes(d));
  if (minutes > 0 && minutes % 10080 === 0) return { amount: minutes / 10080, unit: 'weeks', negative: d.negative };
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: 'days', negative: d.negative };
  if (minutes > 0 && minutes % 60 === 0) return { amount: minutes / 60, unit: 'hours', negative: d.negative };
  return { amount: minutes, unit: 'minutes', negative: d.negative };
}

export function amountUnitToDuration(amount: number, unit: DurationUnit, negative: boolean): CalV2Duration {
  const factor = unit === 'weeks' ? 10080 : unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1;
  const d = minutesToDuration(Math.max(0, Math.round(amount)) * factor);
  return { ...d, negative: negative && durationToMinutes(d) !== 0 };
}

// ─── Descrizioni per l'interfaccia ───────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  summary: 'Titolo',
  description: 'Descrizione',
  location: 'Luogo',
  url: 'URL',
  status: 'Stato',
  transp: 'Mostra come',
  class: 'Visibilità',
  priority: 'Priorità',
  categories: 'Categorie',
  color: 'Colore',
  geo: 'Coordinate',
  start: 'Inizio',
  end: 'Fine',
  duration: 'Durata',
  rrule: 'Ricorrenza',
  rdates: 'Date aggiuntive',
  exdates: 'Date escluse',
  alarms: 'Promemoria',
  organizer: 'Organizzatore',
  attendees: 'Invitati',
};

/** Etichetta italiana di un campo o di `prop:<NOME>`. */
export function fieldLabel(key: string): string {
  if (key.startsWith('prop:')) return `Proprietà ${key.slice(5)}`;
  return FIELD_LABELS[key] ?? key;
}

export const STATUS_LABELS: Record<string, string> = {
  CONFIRMED: 'Confermato',
  TENTATIVE: 'Provvisorio',
  CANCELLED: 'Annullato',
};

export const TRANSP_LABELS: Record<string, string> = {
  OPAQUE: 'Occupato',
  TRANSPARENT: 'Libero',
};

export const CLASS_LABELS: Record<string, string> = {
  PUBLIC: 'Pubblico',
  PRIVATE: 'Privato',
  CONFIDENTIAL: 'Riservato',
};

const UNIT_LABELS: Record<DurationUnit, [string, string]> = {
  minutes: ['minuto', 'minuti'],
  hours: ['ora', 'ore'],
  days: ['giorno', 'giorni'],
  weeks: ['settimana', 'settimane'],
};

export function unitLabel(unit: DurationUnit, amount: number): string {
  return UNIT_LABELS[unit][amount === 1 ? 0 : 1];
}

/** `1 ora e 30 minuti`, `2 giorni`. */
export function describeDuration(d: CalV2Duration): string {
  const parts: string[] = [];
  const days = d.weeks * 7 + d.days;
  if (days) parts.push(`${days} ${days === 1 ? 'giorno' : 'giorni'}`);
  if (d.hours) parts.push(`${d.hours} ${d.hours === 1 ? 'ora' : 'ore'}`);
  if (d.minutes) parts.push(`${d.minutes} ${d.minutes === 1 ? 'minuto' : 'minuti'}`);
  if (d.seconds) parts.push(`${d.seconds} s`);
  if (!parts.length) return '0 minuti';
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0];
}

/** `17/10/2026 09:30` (+ fuso se diverso da quello dell'evento); gli istanti UTC sono convertiti nel fuso dell'evento. */
export function describeTime(t: CalV2Time, eventTz: string): string {
  if (t.type === 'date') return `${pad(t.day)}/${pad(t.month)}/${pad(t.year, 4)} (tutto il giorno)`;
  const fmt = (x: { year: number; month: number; day: number; hour: number; minute: number }) =>
    `${pad(x.day)}/${pad(x.month)}/${pad(x.year, 4)} ${pad(x.hour)}:${pad(x.minute)}`;
  if (t.zone.kind === 'utc') return fmt(utcMsToWall(wallMs(t), eventTz));
  if (t.zone.kind === 'floating') return `${fmt(t)} (fluttuante)`;
  return t.zone.tzid === eventTz ? fmt(t) : `${fmt(t)} (${t.zone.tzid})`;
}

function describeProperties(list: readonly CalV2Property[]): string {
  return list.length ? list.map((p) => p.value).join('; ') : '—';
}

/** Valore wire di un campo (o di `prop:<NOME>`) in italiano, per il dialogo dei conflitti. */
export function describeFieldValue(key: string, value: unknown, eventTz: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (key.startsWith('prop:')) return Array.isArray(value) ? describeProperties(value as CalV2Property[]) : String(value);
  switch (key) {
    case 'status': return STATUS_LABELS[String(value)] ?? String(value);
    case 'transp': return TRANSP_LABELS[String(value)] ?? String(value);
    case 'class': return CLASS_LABELS[String(value).toUpperCase()] ?? String(value);
    case 'categories': return Array.isArray(value) && value.length ? value.join(', ') : '—';
    case 'geo': {
      const g = value as { lat?: number; lon?: number };
      return typeof g.lat === 'number' && typeof g.lon === 'number' ? `${g.lat}, ${g.lon}` : '—';
    }
    case 'start':
    case 'end':
      return describeTime(value as CalV2Time, eventTz);
    case 'duration':
      return describeDuration(value as CalV2Duration);
    case 'rdates':
    case 'exdates': {
      const list = Array.isArray(value) ? (value as Array<CalV2Time | { type: 'period'; start: CalV2DateTime }>) : [];
      if (!list.length) return '—';
      const shown = list.slice(0, 3).map((x) => describeTime(x.type === 'period' ? x.start : x, eventTz)).join('; ');
      return list.length > 3 ? `${list.length} date (${shown}; …)` : shown;
    }
    case 'alarms': {
      const list = Array.isArray(value) ? (value as CalV2Component[]) : [];
      if (!list.length) return 'Nessun promemoria';
      return `${list.length} promemoria: ${list.map((a) => describeAlarm(alarmToForm(a))).join('; ')}`;
    }
    case 'organizer': {
      const p = value as CalV2Property;
      return describeAddress(addressToForm(p));
    }
    case 'attendees': {
      const list = Array.isArray(value) ? (value as CalV2Property[]) : [];
      return list.length ? list.map((p) => describeAddress(addressToForm(p))).join('; ') : 'Nessun invitato';
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

// ─── Promemoria (VALARM) ───────────────────────────────

export type AlarmTriggerForm =
  | { kind: 'relative'; related: 'START' | 'END'; /** Negativo = prima. */ offset: CalV2Duration }
  | { kind: 'absolute'; at: CalV2DateTime };

export interface AlarmForm {
  /** DISPLAY, EMAIL, AUDIO (o un valore sconosciuto, conservato). */
  action: string;
  trigger: AlarmTriggerForm;
  description: string;
  summary: string;
  /** Indirizzi degli ATTENDEE del promemoria (senza `mailto:`). */
  attendees: string[];
}

export const ALARM_ACTIONS: Record<string, string> = { DISPLAY: 'Notifica', EMAIL: 'Email', AUDIO: 'Suono' };

const DEFAULT_ALARM_TEXT = 'Promemoria';

function findProp(props: readonly CalV2Property[], name: string): CalV2Property | undefined {
  return props.find((p) => p.name.toUpperCase() === name);
}

function getParam(params: readonly CalV2Param[], name: string): string | null {
  const p = params.find((x) => x.name.toUpperCase() === name);
  return p && p.values.length ? p.values.join(',') : null;
}

/**
 * Imposta (o rimuove, con `value` null) un parametro, nella stessa posizione se
 * esiste; se uguale lo lascia com'è (senza distinguere le maiuscole, salvo
 * `exact`, per i valori liberi come CN).
 */
function setParam(params: readonly CalV2Param[], name: string, value: string | null, exact = false): CalV2Param[] {
  const out = params.map((p) => cloneJson(p));
  const idx = out.findIndex((p) => p.name.toUpperCase() === name);
  if (value === null) return idx >= 0 ? out.filter((_, i) => i !== idx) : out;
  if (idx >= 0) {
    const cur = out[idx];
    if (cur.values.length === 1 && (exact ? cur.values[0] === value : cur.values[0].toUpperCase() === value.toUpperCase())) return out;
    out[idx] = { name: cur.name, values: [value] };
    return out;
  }
  return [...out, { name, values: [value] }];
}

function parseAlarmDateTime(s: string): CalV2DateTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/i.exec(s.trim());
  if (!m) return null;
  return {
    type: 'date-time',
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]),
    zone: { kind: 'utc' },
  };
}

function formatAlarmDateTime(t: CalV2DateTime): string {
  return `${pad(t.year, 4)}${pad(t.month)}${pad(t.day)}T${pad(t.hour)}${pad(t.minute)}${pad(t.second)}Z`;
}

function decodeTrigger(prop: CalV2Property | undefined): AlarmTriggerForm {
  if (prop) {
    if ((getParam(prop.params, 'VALUE') ?? '').toUpperCase() === 'DATE-TIME') {
      const at = parseAlarmDateTime(prop.value);
      if (at) return { kind: 'absolute', at };
    } else {
      const offset = parseDurationString(prop.value);
      if (offset) {
        const related = (getParam(prop.params, 'RELATED') ?? 'START').toUpperCase() === 'END' ? 'END' : 'START';
        return { kind: 'relative', related, offset };
      }
    }
  }
  return { kind: 'relative', related: 'START', offset: { negative: true, weeks: 0, days: 0, hours: 0, minutes: 15, seconds: 0 } };
}

function stripMailto(value: string): string {
  return /^mailto:/i.test(value) ? value.slice(7) : value;
}

/** Decodifica un VALARM grezzo nel form (solo i campi che l'editor sa modificare). */
export function alarmToForm(raw: CalV2Component): AlarmForm {
  return {
    action: (findProp(raw.properties, 'ACTION')?.value ?? 'DISPLAY').toUpperCase(),
    trigger: decodeTrigger(findProp(raw.properties, 'TRIGGER')),
    description: findProp(raw.properties, 'DESCRIPTION')?.value ?? '',
    summary: findProp(raw.properties, 'SUMMARY')?.value ?? '',
    attendees: raw.properties.filter((p) => p.name.toUpperCase() === 'ATTENDEE').map((p) => stripMailto(p.value)),
  };
}

/** Nuovo promemoria di default: notifica 15 minuti prima dell'inizio. */
export function newAlarmForm(): AlarmForm {
  return {
    action: 'DISPLAY',
    trigger: { kind: 'relative', related: 'START', offset: { negative: true, weeks: 0, days: 0, hours: 0, minutes: 15, seconds: 0 } },
    description: DEFAULT_ALARM_TEXT,
    summary: '',
    attendees: [],
  };
}

/** `Notifica, 15 minuti prima dell'inizio`. */
export function describeAlarm(form: AlarmForm): string {
  const action = ALARM_ACTIONS[form.action] ?? form.action;
  if (form.trigger.kind === 'absolute') {
    return `${action}, il ${describeTime(form.trigger.at, 'Europe/Rome')}`;
  }
  const { amount, unit, negative } = durationToAmountUnit(form.trigger.offset);
  const target = form.trigger.related === 'END' ? 'della fine' : "dell'inizio";
  if (amount === 0) return `${action}, ${form.trigger.related === 'END' ? 'alla fine' : "all'inizio"}`;
  return `${action}, ${amount} ${unitLabel(unit, amount)} ${negative ? 'prima' : 'dopo'} ${target}`;
}

function sameTrigger(a: AlarmTriggerForm, b: AlarmTriggerForm): boolean {
  return deepEqual(a, b);
}

function buildTriggerProperty(form: AlarmTriggerForm, existing: CalV2Property | undefined): CalV2Property {
  if (existing && sameTrigger(decodeTrigger(existing), form)) return existing;
  let params = existing ? existing.params.map((p) => cloneJson(p)) : [];
  if (form.kind === 'absolute') {
    params = setParam(setParam(params, 'VALUE', 'DATE-TIME'), 'RELATED', null);
    return { name: existing?.name ?? 'TRIGGER', params, value: formatAlarmDateTime(form.at) };
  }
  if ((getParam(params, 'VALUE') ?? 'DURATION').toUpperCase() !== 'DURATION') params = setParam(params, 'VALUE', null);
  params = setParam(params, 'RELATED', form.related === 'END' ? 'END' : null);
  return { name: existing?.name ?? 'TRIGGER', params, value: formatDurationString(form.offset) };
}

/**
 * VALARM dal form partendo da `raw`: sostituisce solo ACTION, TRIGGER,
 * DESCRIPTION, SUMMARY e ATTENDEE; ogni altra proprietà, parametro e
 * sotto-componente (X-APPLE-DEFAULT-ALARM, UID, REPEAT/DURATION, ...) resta
 * dove sta. Un valore invariato si rimanda identico (anche i suoi parametri).
 */
export function alarmFromForm(form: AlarmForm, raw: CalV2Component | null): CalV2Component {
  const base: CalV2Component = raw ? cloneJson(raw) : { name: 'VALARM', properties: [], components: [] };
  const action = form.action.toUpperCase();
  // Testo vuoto = proprietà assente (i valori predefiniti li aggiunge `ensureAlarmDefaults` al salvataggio).
  const text = {
    DESCRIPTION: form.description.trim() === '' ? '' : form.description,
    SUMMARY: form.summary.trim() === '' ? '' : form.summary,
  };
  const keepAddresses = new Map(form.attendees.map((a) => [stripMailto(a.trim()).toLowerCase(), a.trim()]));

  const out: CalV2Property[] = [];
  const done = new Set<string>();
  const seenAttendees = new Set<string>();
  for (const prop of base.properties) {
    const name = prop.name.toUpperCase();
    if (name === 'ACTION' || name === 'DESCRIPTION' || name === 'SUMMARY' || name === 'TRIGGER') {
      if (done.has(name)) continue; // duplicati non validi: resta il primo
      done.add(name);
      if (name === 'ACTION') {
        out.push(prop.value.toUpperCase() === action ? prop : { ...prop, value: action });
      } else if (name === 'TRIGGER') {
        out.push(buildTriggerProperty(form.trigger, prop));
      } else {
        const wanted = text[name as 'DESCRIPTION' | 'SUMMARY'];
        if (!wanted) continue; // il form lo svuota: la proprietà sparisce
        out.push(prop.value === wanted ? prop : { ...prop, value: wanted });
      }
    } else if (name === 'ATTENDEE') {
      const key = stripMailto(prop.value).toLowerCase();
      if (!keepAddresses.has(key) || seenAttendees.has(key)) continue;
      seenAttendees.add(key);
      out.push(prop);
    } else {
      out.push(prop);
    }
  }
  if (!done.has('ACTION')) out.push({ name: 'ACTION', params: [], value: action });
  if (!done.has('TRIGGER')) out.push(buildTriggerProperty(form.trigger, undefined));
  if (!done.has('DESCRIPTION') && text.DESCRIPTION) out.push({ name: 'DESCRIPTION', params: [], value: text.DESCRIPTION });
  if (!done.has('SUMMARY') && text.SUMMARY) out.push({ name: 'SUMMARY', params: [], value: text.SUMMARY });
  for (const [key, original] of keepAddresses) {
    if (seenAttendees.has(key) || !original) continue;
    out.push({ name: 'ATTENDEE', params: [], value: /^[a-z][a-z0-9+.-]*:/i.test(original) ? original : `mailto:${original}` });
  }
  return { ...base, properties: out };
}

/**
 * Completa un VALARM modificato con i testi richiesti dallo standard (DISPLAY
 * ed EMAIL vogliono DESCRIPTION, EMAIL anche SUMMARY): l'editor li lascia
 * vuoti mentre l'utente scrive, il salvataggio li riempie con un predefinito.
 */
export function ensureAlarmDefaults(alarm: CalV2Component): CalV2Component {
  const action = (findProp(alarm.properties, 'ACTION')?.value ?? '').toUpperCase();
  const missing = (name: string) => !(findProp(alarm.properties, name)?.value ?? '').trim();
  const additions: CalV2Property[] = [];
  if ((action === 'DISPLAY' || action === 'EMAIL') && missing('DESCRIPTION')) {
    additions.push({ name: 'DESCRIPTION', params: [], value: DEFAULT_ALARM_TEXT });
  }
  if (action === 'EMAIL' && missing('SUMMARY')) additions.push({ name: 'SUMMARY', params: [], value: DEFAULT_ALARM_TEXT });
  if (!additions.length) return alarm;
  const names = new Set(additions.map((p) => p.name));
  return { ...alarm, properties: [...alarm.properties.filter((p) => !names.has(p.name.toUpperCase())), ...additions] };
}

/** Vero se il VALARM è il promemoria predefinito del dispositivo (X-APPLE-DEFAULT-ALARM:TRUE). */
export function isAppleDefaultAlarm(alarm: CalV2Component): boolean {
  return (findProp(alarm.properties, 'X-APPLE-DEFAULT-ALARM')?.value ?? '').toUpperCase() === 'TRUE';
}

// ─── Indirizzi (ORGANIZER, ATTENDEE) ───────────────────────────────

export interface AddressForm {
  /** Indirizzo senza `mailto:` (o l'URI intero, se non è mailto). */
  email: string;
  cn: string;
  /** CHAIR, REQ-PARTICIPANT, OPT-PARTICIPANT, NON-PARTICIPANT; '' = non indicato. */
  role: string;
  /** NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE, DELEGATED; '' = non indicato. */
  partstat: string;
  /** null = parametro assente. */
  rsvp: boolean | null;
}

export const ATTENDEE_ROLES: Record<string, string> = {
  CHAIR: 'Presidente',
  'REQ-PARTICIPANT': 'Partecipante richiesto',
  'OPT-PARTICIPANT': 'Partecipante facoltativo',
  'NON-PARTICIPANT': 'Solo informato',
};

export const ATTENDEE_PARTSTATS: Record<string, string> = {
  'NEEDS-ACTION': 'In attesa di risposta',
  ACCEPTED: 'Accettato',
  DECLINED: 'Rifiutato',
  TENTATIVE: 'Provvisorio',
  DELEGATED: 'Delegato',
};

export function addressToForm(prop: CalV2Property): AddressForm {
  const rsvp = getParam(prop.params, 'RSVP');
  return {
    email: stripMailto(prop.value),
    cn: getParam(prop.params, 'CN') ?? '',
    role: (getParam(prop.params, 'ROLE') ?? '').toUpperCase(),
    partstat: (getParam(prop.params, 'PARTSTAT') ?? '').toUpperCase(),
    rsvp: rsvp === null ? null : rsvp.toUpperCase() === 'TRUE',
  };
}

export function newAddressForm(): AddressForm {
  return { email: '', cn: '', role: 'REQ-PARTICIPANT', partstat: 'NEEDS-ACTION', rsvp: true };
}

export function describeAddress(form: AddressForm): string {
  return form.cn ? `${form.cn} <${form.email}>` : form.email;
}

/** Indirizzo plausibile: email oppure URI con schema (`urn:uuid:`, `/principals/`...). */
export function isLikelyAddress(value: string): boolean {
  const v = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^[a-z][a-z0-9+.-]*:\S+$/i.test(v);
}

function addressValue(email: string, raw: CalV2Property | null): string {
  const trimmed = email.trim();
  if (raw && stripMailto(raw.value) === trimmed) return raw.value; // invariato: stesso testo (e stesso schema)
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `mailto:${trimmed}`;
}

/**
 * ATTENDEE/ORGANIZER dal form partendo da `raw`: sostituisce valore, CN, ROLE,
 * PARTSTAT e RSVP; ogni altro parametro (DELEGATED-FROM, SENT-BY, CUTYPE,
 * X-...) resta com'è.
 */
export function addressFromForm(form: AddressForm, raw: CalV2Property | null, name: 'ATTENDEE' | 'ORGANIZER'): CalV2Property {
  let params = raw ? raw.params.map((p) => cloneJson(p)) : [];
  const cn = form.cn.trim();
  params = setParam(params, 'CN', cn === '' ? null : cn, true);
  params = setParam(params, 'ROLE', form.role || null);
  params = setParam(params, 'PARTSTAT', form.partstat || null);
  params = setParam(params, 'RSVP', form.rsvp === null ? null : form.rsvp ? 'TRUE' : 'FALSE');
  return { name, params, value: addressValue(form.email, raw) };
}

// ─── Conflitti (412) ───────────────────────────────

/**
 * Nuovo tentativo dopo un 412: dalle operazioni in sospeso si scartano quelle
 * in conflitto che l'utente non ha scelto di mantenere (prende il valore del
 * server); ETag e token di base vengono dalla versione del server.
 */
export function rebaseAfterConflict(
  pending: { ops: CalV2Op[] },
  body: CalV2PreconditionFailedBody,
  keepMine: ReadonlySet<string>,
): { etag: string; ops: CalV2Op[]; base: Record<string, string> } {
  const etag = body.current.etag;
  if (!etag) throw new Error('La versione del server non ha un ETag: ricarica l\'evento');
  const conflicting = new Set(body.conflicts.map((c) => c.field));
  const ops = pending.ops.filter((op) => {
    const key = opKey(op);
    return !conflicting.has(key) || keepMine.has(key);
  });
  const tokens = body.current.target?.tokens ?? body.current.master?.tokens ?? {};
  const base: Record<string, string> = {};
  for (const op of ops) {
    const key = opKey(op);
    base[key] = tokens[key] ?? CAL_V2_ABSENT_TOKEN;
  }
  return { etag, ops, base };
}

// ─── Ricorrenza (form della RRULE) ───────────────────────────────

export type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_SHORT: Record<Weekday, string> = { MO: 'Lun', TU: 'Mar', WE: 'Mer', TH: 'Gio', FR: 'Ven', SA: 'Sab', SU: 'Dom' };
export const WEEKDAY_LONG: Record<Weekday, string> = {
  MO: 'lunedì', TU: 'martedì', WE: 'mercoledì', TH: 'giovedì', FR: 'venerdì', SA: 'sabato', SU: 'domenica',
};

export interface RecurrenceForm {
  freq: RecurrenceFreq;
  interval: number;
  /** WEEKLY: giorni scelti. */
  byDay: Weekday[];
  monthlyMode: 'monthday' | 'weekday';
  /** MONTHLY per giorno del mese. */
  byMonthDay: number;
  /** MONTHLY per posizione: 1-4 o -1 (ultimo). */
  setPos: number;
  setPosDay: Weekday;
  end: 'never' | 'count' | 'until';
  count: number;
  /** `YYYY-MM-DD` (giorno locale incluso). */
  untilDate: string;
  /** UNTIL originale, riscritto così com'è finché l'utente non cambia la data. */
  untilRaw: string | null;
  /** WKST originale, conservato. */
  wkst: string | null;
}

const REPRESENTABLE_KEYS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYSETPOS', 'WKST']);

function rruleParts(rrule: string): Array<[string, string]> {
  return rrule
    .replace(/^RRULE:/i, '')
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf('=');
      return i < 0 ? [part.toUpperCase(), ''] : [part.slice(0, i).toUpperCase(), part.slice(i + 1)];
    });
}

/** Giorno locale (`YYYY-MM-DD`) di un UNTIL (DATE, UTC o fluttuante) nel fuso `tz`. */
export function untilToLocalDate(until: string, tz: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(until.trim());
  if (!m) return null;
  if (m[7]) {
    const w = utcMsToWall(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])), tz);
    return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** UNTIL a fine giornata locale (`start` decide il formato: DATE, UTC o fluttuante). */
export function localDateToUntil(date: string, start: CalV2Time, tz: string): string | null {
  const d = DATE_RE.exec(date);
  if (!d) return null;
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  if (start.type === 'date') return `${pad(y, 4)}${pad(m)}${pad(day)}`;
  if (start.zone.kind === 'floating') return `${pad(y, 4)}${pad(m)}${pad(day)}T235959`;
  const zone = start.zone.kind === 'tzid' ? start.zone.tzid : tz;
  const utc = new Date(wallToUtcMs(Date.UTC(y, m - 1, day, 23, 59, 59), zone));
  return `${pad(utc.getUTCFullYear(), 4)}${pad(utc.getUTCMonth() + 1)}${pad(utc.getUTCDate())}T${pad(utc.getUTCHours())}${pad(utc.getUTCMinutes())}${pad(utc.getUTCSeconds())}Z`;
}

/** Nome del giorno della settimana di un tempo (per i default del form). */
export function weekdayOf(t: CalV2Time): Weekday {
  const idx = new Date(Date.UTC(t.year, t.month - 1, t.day)).getUTCDay(); // 0 = domenica
  return WEEKDAYS[(idx + 6) % 7];
}

/** Form predefinito per una ricorrenza nuova che parte da `start`. */
export function defaultRecurrenceForm(start: CalV2Time, freq: RecurrenceFreq = 'WEEKLY'): RecurrenceForm {
  return {
    freq,
    interval: 1,
    byDay: [weekdayOf(start)],
    monthlyMode: 'monthday',
    byMonthDay: start.day,
    setPos: Math.min(4, Math.ceil(start.day / 7)),
    setPosDay: weekdayOf(start),
    end: 'never',
    count: 10,
    untilDate: '',
    untilRaw: null,
    wkst: null,
  };
}

/**
 * RRULE → form; null se la regola non è rappresentabile (parti fuori da
 * FREQ, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYSETPOS, WKST o
 * combinazioni non coperte): il chiamante la mostra come testo modificabile.
 */
export function parseRecurrenceForm(rrule: string, start: CalV2Time, tz: string): RecurrenceForm | null {
  const parts = rruleParts(rrule);
  if (!parts.length) return null;
  const map = new Map<string, string>();
  for (const [k, v] of parts) {
    if (!REPRESENTABLE_KEYS.has(k) || map.has(k)) return null;
    map.set(k, v);
  }
  const freq = map.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  const form = defaultRecurrenceForm(start, freq);
  if (map.has('INTERVAL')) {
    const n = Number(map.get('INTERVAL'));
    if (!Number.isInteger(n) || n < 1) return null;
    form.interval = n;
  }
  if (map.has('COUNT') && map.has('UNTIL')) return null;
  if (map.has('COUNT')) {
    const n = Number(map.get('COUNT'));
    if (!Number.isInteger(n) || n < 1) return null;
    form.end = 'count';
    form.count = n;
  }
  if (map.has('UNTIL')) {
    const raw = map.get('UNTIL')!;
    const date = untilToLocalDate(raw, tz);
    if (!date) return null;
    form.end = 'until';
    form.untilDate = date;
    form.untilRaw = raw;
  }
  form.wkst = map.get('WKST') ?? null;
  const byDay = map.get('BYDAY');
  const byMonthDay = map.get('BYMONTHDAY');
  const bySetPos = map.get('BYSETPOS');
  const days = byDay ? byDay.split(',') : [];
  const plainDay = (d: string): d is Weekday => (WEEKDAYS as readonly string[]).includes(d);
  if (freq === 'DAILY' || freq === 'YEARLY') {
    if (byDay || byMonthDay || bySetPos) return null;
  } else if (freq === 'WEEKLY') {
    if (byMonthDay || bySetPos) return null;
    if (days.length && !days.every(plainDay)) return null;
    form.byDay = days.length ? (days as Weekday[]) : [weekdayOf(start)];
    // Senza BYDAY il server usa il giorno dell'inizio: lo rendiamo esplicito solo se l'utente modifica la regola.
  } else {
    // MONTHLY
    if (byMonthDay && (byDay || bySetPos)) return null;
    if (byMonthDay) {
      const n = Number(byMonthDay);
      if (!Number.isInteger(n) || n < 1 || n > 31) return null;
      form.monthlyMode = 'monthday';
      form.byMonthDay = n;
    } else if (byDay) {
      let pos: number;
      let day: string;
      if (bySetPos) {
        if (days.length !== 1 || !plainDay(days[0])) return null;
        pos = Number(bySetPos);
        day = days[0];
      } else {
        const m = /^([+-]?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(days[0] ?? '');
        if (days.length !== 1 || !m) return null;
        pos = Number(m[1]);
        day = m[2];
      }
      if (![1, 2, 3, 4, -1].includes(pos)) return null;
      form.monthlyMode = 'weekday';
      form.setPos = pos;
      form.setPosDay = day as Weekday;
    } else if (bySetPos) {
      return null;
    }
  }
  return form;
}

/** Form → RRULE (senza prefisso). I parametri non toccati (UNTIL, WKST) si riscrivono come stavano. */
export function buildRecurrenceRule(form: RecurrenceForm, start: CalV2Time, tz: string): string {
  const parts: string[] = [`FREQ=${form.freq}`];
  if (form.interval > 1) parts.push(`INTERVAL=${form.interval}`);
  if (form.freq === 'WEEKLY') {
    const days = WEEKDAYS.filter((d) => form.byDay.includes(d));
    parts.push(`BYDAY=${(days.length ? days : [weekdayOf(start)]).join(',')}`);
  } else if (form.freq === 'MONTHLY') {
    if (form.monthlyMode === 'weekday') parts.push(`BYDAY=${form.setPosDay}`, `BYSETPOS=${form.setPos}`);
    else parts.push(`BYMONTHDAY=${form.byMonthDay}`);
  }
  if (form.end === 'count') parts.push(`COUNT=${Math.max(1, Math.round(form.count))}`);
  if (form.end === 'until') {
    const until = form.untilRaw ?? localDateToUntil(form.untilDate, start, tz);
    if (until) parts.push(`UNTIL=${until}`);
  }
  if (form.wkst) parts.push(`WKST=${form.wkst}`);
  return parts.join(';');
}
