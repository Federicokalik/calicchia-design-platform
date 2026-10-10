/**
 * Preparazione delle righe dell'indice (fase F2 del passaggio a Radicale;
 * design §6.2 passo 7, §6.4, §6.5, §9; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §2.3-§2.5 e §5.1).
 *
 * Modulo PURO: niente database, niente rete, niente orologio implicito. Dal
 * testo di una risorsa (collezione, href, etag, ICS) calcola tutto ciò che
 * l'indicizzatore scrive in cal_objects, cal_components e cal_occurrences,
 * usando @calicchia/calendar-core:
 *  - parse (parseCalendarObject, tollerante alle righe malformate);
 *  - espansione nell'orizzonte con tetto e budget (expandObject), abbinamento
 *    degli override e orfani autonomi (findOrphanOverrides fuori finestra);
 *  - fingerprint semantico (semanticFingerprint: niente DTSTAMP, LAST-MODIFIED
 *    e SEQUENCE) e SHA-256 del testo;
 *  - provenienza solo da ruolo e href (deriveProvenance), kind
 *    (classifyOccurrenceKind) e regola blocks (computeBlocks, decisione 6 con
 *    CAL_ALLDAY_OPAQUE_BLOCKS);
 *  - quarantena senza eccezioni: testo illeggibile, RRULE o valori non
 *    validi, budget esaurito; con l'occorrenza conservativa dell'espansione o,
 *    se il testo non si parsa, quella estratta in modo tollerante
 *    (conservativeRangeFromText).
 *
 * La validazione di scrittura (validateObject) NON decide la quarantena:
 * serve all'API prima di scrivere (STORE). Un oggetto scritto da un device con
 * un difetto che Radicale accetta (es. EXDATE DATE su una serie oraria) resta
 * indicizzato e blocca: nasconderlo dal busy sarebbe peggio (invariante 2).
 *
 * Lo stesso modulo gira dentro un worker_thread (runIndexWorker) quando una
 * collezione supera i 200 oggetti, per non bloccare l'event loop che serve
 * verify-credentials (design §6.2 passo 7, revisione red-team punto 16). I
 * dati scambiati sono solo strutture semplici (stringhe ISO, numeri, array).
 */

import { createHash } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import {
  allDayRangeFromIcs,
  type CalendarObject,
  classifyOccurrenceKind,
  computeBlocks,
  conservativeRangeFromText,
  DEFAULT_TZ,
  deriveProvenance,
  type ExpandedOccurrence,
  type ExpansionResult,
  expandObject,
  findOrphanOverrides,
  getProperty,
  getTextValue,
  type IcsComponent,
  type IcsPeriod,
  type IcsTime,
  icsDateToString,
  isValidIanaZone,
  legacyStatusOf,
  parseCalendarObject,
  readEvent,
  readTimeProperty,
  recurrenceKeyOf,
  recurrenceKeyToTime,
  semanticFingerprint,
  timeToIso,
  timeToUtcMs,
  toLegacyEventFields,
  X_CALDES,
  type ZoneContext,
} from '@calicchia/calendar-core';
import {
  CONSERVATIVE_RECURRENCE_KEY,
  HEALTH_REASONS,
  MASTER_RECURRENCE_KEY,
  type ObjectComponent,
  type OccurrenceKind,
  type OriginStore,
} from '../index-model';
import type { CalendarEventSource, CalendarEventStatus } from '../types';
import type { CalendarRole } from './types';

// ─── Tipi condivisi con indexer.ts (che li riesporta: contratto §5.1) ─────

/** Contesto di una collezione per l'indicizzazione. */
export interface CollectionContext {
  calendarId: string;
  collectionName: string;
  role: CalendarRole;
  /** Fuso IANA del calendario (floating, DATE e TZID sconosciuti). */
  timezone: string;
  originStore: OriginStore;
  /** false per role=subscription: niente versioni (fonte remota). */
  versions: boolean;
  /** Decisione 6: con allDayOpaqueBlocks gli all-day TRANSP:OPAQUE bloccano (CAL_ALLDAY_OPAQUE_BLOCKS=on). */
  blockRules: { allDayOpaqueBlocks: boolean };
}

/** Una risorsa da indicizzare. */
export interface RawItem {
  /** Nome della risorsa nella collezione, decodificato. */
  href: string;
  /** null per origin_store 'remote'. */
  etag: string | null;
  /** Testo; null = illeggibile. */
  raw: string | null;
  /** remote: già calcolato da ics-split. */
  semanticFp?: string | null;
}

export interface ChangeSetInput {
  context: CollectionContext;
  upserts: RawItem[];
  /** Cancellazioni confermate (passate dall'interruttore anti-cancellazione). */
  deletes: string[];
  /** 404 con file su disco (skip_broken_item di Radicale): raw letto dal mount se possibile. */
  radicaleSkipped: RawItem[];
  /** Remote mode, primo 404 di una risorsa: resta e continua a bloccare. */
  pending404: string[];
  /** upserts ∪ radicaleSkipped = collezione intera. */
  full: boolean;
  horizon: { start: Date; end: Date };
  /** 'sync' | 'write-through:<actor>' | 'rebuild' | 'subscription-pull' | ... */
  actor: string;
  idStrategy?: 'random' | 'deterministic';
}

/** Riga di cal_components preparata (tempi in ISO UTC, date 'YYYY-MM-DD'). */
export interface PreparedComponent {
  recurrenceKey: string;
  component: 'VEVENT' | 'VTODO' | 'VJOURNAL';
  uid: string | null;
  /** SUMMARY così com'è (null se assente o vuoto): l'adattatore legacy applica '(senza titolo)'. */
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  status: CalendarEventStatus;
  transp: 'OPAQUE' | 'TRANSPARENT' | null;
  class: string | null;
  startUtc: string | null;
  endUtc: string | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  tzid: string | null;
  floating: boolean;
  rrule: string | null;
  rdates: string[];
  exdates: string[];
  recurrenceIdUtc: string | null;
  orphan: boolean;
  sequence: number | null;
  dtstamp: string | null;
  created: string | null;
  lastModified: string | null;
  xSource: string | null;
  xSourceId: string | null;
  hasAlarms: boolean;
  hasAttendees: boolean;
}

/** Riga di cal_occurrences preparata (senza id: l'apply risolve componentKey nell'id del componente). */
export interface PreparedOccurrence {
  recurrenceKey: string;
  /** recurrence_key del componente che la produce; null per il blocco conservativo. */
  componentKey: string | null;
  startUtc: string;
  endUtc: string;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  status: CalendarEventStatus;
  transp: 'OPAQUE' | 'TRANSPARENT';
  kind: OccurrenceKind;
  blocks: boolean;
}

/** Componenti e occorrenze di un testo, con i campi di intervallo di cal_objects. */
export interface PreparedMaterialization {
  components: PreparedComponent[];
  occurrences: PreparedOccurrence[];
  rangeStart: string | null;
  rangeEnd: string | null;
  isRecurring: boolean;
  materializedUntil: string | null;
}

/** Una risorsa preparata per l'apply. */
export interface PreparedItem extends PreparedMaterialization {
  href: string;
  /** 'upsert' (testo servito da Radicale o dal feed) o 'radicale-skip' (404 con file su disco). */
  origin: 'upsert' | 'radicale-skip';
  etag: string | null;
  /** Testo da salvare (senza caratteri NUL, che Postgres rifiuta); null se illeggibile. */
  raw: string | null;
  /** SHA-256 esadecimale del testo originale (null se illeggibile). */
  sha256: string | null;
  sizeBytes: number | null;
  uid: string | null;
  component: ObjectComponent;
  semanticFp: string | null;
  source: CalendarEventSource;
  sourceId: string | null;
  xSource: string | null;
  xSourceId: string | null;
  /** X-CALDES-LEGACY-ID del master, se è un UUID (oggetti migrati: id stabile). */
  legacyId: string | null;
  health: 'ok' | 'quarantined';
  healthReason: string | null;
  /** Il testo si parsa ed espande: versione valid=true, utilizzabile come ultima buona. */
  valid: boolean;
  /**
   * Quarantena per testo non valido: prevalgono le occorrenze dell'ultima
   * versione buona (design §6.5); quelle di questo item sono il ripiego
   * (occorrenza conservativa). false per ok e per il budget esaurito.
   */
  preferLastGood: boolean;
  /** recurrence_key degli override correnti (componenti diversi dal master). */
  overrideKeys: string[];
  /** Codici degli avvisi d'espansione rilevanti per la salute (es. ORPHAN_OVERRIDE). */
  warnings: string[];
}

/** Contesto di preparazione: collezione e finestra in ms UTC. */
export interface PrepareContext {
  context: CollectionContext;
  from: number;
  to: number;
}

// ─── Utilità ───────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INT32_MAX = 2_147_483_647;

/** Fuso valido per l'espansione (un fuso sconosciuto ricade su Europe/Rome, come calendar-core). */
export function safeTimezone(tz: string | null | undefined): string {
  return tz && isValidIanaZone(tz) ? tz : DEFAULT_TZ;
}

/** Postgres rifiuta il carattere NUL nei TEXT: lo si sostituisce (il testo resta riconoscibile). */
export function pgText(s: string): string;
export function pgText(s: string | null): string | null;
export function pgText(s: string | null): string | null {
  if (s === null) return null;
  return s.includes('\u0000') ? s.replace(/\u0000/g, '�') : s;
}

function emptyToNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.trim() === '' ? null : pgText(s);
}

/** SHA-256 esadecimale dei byte UTF-8 (identico a contentSha256 di calendar-core, ma con node:crypto). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Testo "srotolato" (unfolding RFC 5545) per le estrazioni tolleranti. */
function unfold(raw: string): string {
  return raw.replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, '');
}

/** UID estratto in modo tollerante da un testo che non si parsa (per riconoscere i MOVE); null se assente. */
export function looseUid(raw: string): string | null {
  const m = /^UID(?:;[^:\r\n]*)?:(.*)$/im.exec(unfold(raw));
  const uid = m?.[1]?.trim() ?? '';
  return uid && uid.length <= 1024 ? pgText(uid) : null;
}

/** Componente dichiarato da un testo che non si parsa. */
function looseComponent(raw: string): ObjectComponent {
  const m = /^BEGIN:(VEVENT|VTODO|VJOURNAL)[ \t]*$/im.exec(raw);
  return (m?.[1]?.toUpperCase() as ObjectComponent | undefined) ?? 'UNKNOWN';
}

function zoneContext(obj: CalendarObject | null, tz: string): ZoneContext {
  return { tz, timezones: obj?.timezones };
}

/** Valore temporale → ISO UTC (DATE → mezzanotte locale) o 'YYYY-MM-DD' per le liste all-day. */
function listValue(t: IcsTime | IcsPeriod, allDay: boolean, zctx: ZoneContext): string | null {
  try {
    if (t.type === 'period') return timeToIso(t.start, zctx);
    if (t.type === 'date') return allDay ? icsDateToString(t) : timeToIso(t, zctx);
    return timeToIso(t, zctx);
  } catch {
    return null;
  }
}

function isoOrNull(t: IcsTime | null, zctx: ZoneContext): string | null {
  if (!t) return null;
  try {
    return timeToIso(t, zctx);
  } catch {
    return null;
  }
}

function clampInt(n: number | null): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  return Math.max(-INT32_MAX, Math.min(INT32_MAX, Math.trunc(n)));
}

// ─── Componenti ───────────────────────────────

/** Riga di cal_components da un VEVENT/VTODO/VJOURNAL; null se il componente non si legge. */
function componentRow(
  c: IcsComponent,
  key: string,
  opts: { orphan: boolean; ridUtcFallback: number | null; zctx: ZoneContext },
): PreparedComponent | null {
  let view: ReturnType<typeof readEvent>;
  try {
    view = readEvent(c);
  } catch {
    return null;
  }
  const zctx = opts.zctx;
  let startUtc: string | null = null;
  let endUtc: string | null = null;
  let recurrenceIdUtc: string | null = null;
  try {
    const legacy = toLegacyEventFields(c, { tz: zctx.tz, timezones: zctx.timezones });
    startUtc = legacy.start_time;
    endUtc = legacy.end_time;
    recurrenceIdUtc = legacy.recurrence_id;
  } catch {
    // VTODO senza DTSTART, UID mancante: i tempi restano nulli.
  }
  if (key !== MASTER_RECURRENCE_KEY) {
    // cal_components_override_check: un override ha sempre recurrence_id_utc.
    recurrenceIdUtc ??= opts.ridUtcFallback !== null ? iso(opts.ridUtcFallback) : startUtc;
    if (!recurrenceIdUtc) return null;
  } else {
    recurrenceIdUtc = null;
  }
  const allDay = view.start?.type === 'date';
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (view.start && view.start.type === 'date') {
    try {
      const range = allDayRangeFromIcs(view.start, view.end, view.end ? null : view.duration, { tz: zctx.tz, timezones: zctx.timezones });
      startDate = range.start;
      endDate = range.end;
    } catch {
      startDate = null;
      endDate = null;
    }
  }
  const zone = view.start && view.start.type === 'date-time' ? view.start.zone : null;
  const transp = view.transp === 'OPAQUE' || view.transp === 'TRANSPARENT' ? view.transp : null;
  const name = c.name.toUpperCase();
  return {
    recurrenceKey: key,
    component: name === 'VTODO' || name === 'VJOURNAL' ? name : 'VEVENT',
    uid: view.uid ? pgText(view.uid) : null,
    summary: emptyToNull(view.summary),
    description: emptyToNull(view.description),
    location: emptyToNull(view.location),
    url: emptyToNull(view.url),
    status: legacyStatusOf(view.status),
    transp,
    class: emptyToNull(view.classification),
    startUtc,
    endUtc,
    allDay,
    startDate,
    endDate,
    tzid: zone && zone.kind === 'tzid' ? pgText(zone.tzid) : null,
    floating: zone?.kind === 'floating',
    rrule: view.rrules[0] ? pgText(view.rrules[0]) : null,
    rdates: view.rdates.map((t) => listValue(t, allDay, zctx)).filter((v): v is string => v !== null),
    exdates: view.exdates.map((t) => listValue(t, allDay, zctx)).filter((v): v is string => v !== null),
    recurrenceIdUtc,
    orphan: key !== MASTER_RECURRENCE_KEY && opts.orphan,
    sequence: clampInt(view.sequence),
    dtstamp: isoOrNull(view.dtstamp, zctx),
    created: isoOrNull(view.created, zctx),
    lastModified: isoOrNull(view.lastModified, zctx),
    xSource: emptyToNull(view.caldes.source),
    xSourceId: emptyToNull(view.caldes.sourceId),
    hasAlarms: view.alarms.length > 0,
    hasAttendees: view.attendees.length > 0,
  };
}

/** DTSTART del master, se leggibile. */
function masterStart(obj: CalendarObject): IcsTime | null {
  const p = obj.master ? getProperty(obj.master, 'DTSTART') : null;
  if (!p) return null;
  try {
    return readTimeProperty(p);
  } catch {
    return null;
  }
}

/**
 * Chiave di un override fuori dalla finestra espansa: quella che expandObject
 * gli darebbe (istanza del master sul tipo del suo DTSTART: un RECURRENCE-ID
 * DATE su una serie oraria vale l'ora del master in quel giorno); con
 * RECURRENCE-ID illeggibile, il DTSTART dell'override. null se nessuno dei due.
 */
function fallbackOverrideKey(c: IcsComponent, start: IcsTime | null, zctx: ZoneContext): { key: string; ridUtc: number | null } | null {
  const ridProp = getProperty(c, 'RECURRENCE-ID');
  if (ridProp) {
    try {
      const rid = readTimeProperty(ridProp);
      const ridUtc = timeToUtcMs(rid, zctx);
      const key = start ? recurrenceKeyOf(recurrenceKeyToTime(recurrenceKeyOf(rid, zctx), start, zctx), zctx) : recurrenceKeyOf(rid, zctx);
      return { key, ridUtc };
    } catch {
      /* si prova il DTSTART */
    }
  }
  const own = getProperty(c, 'DTSTART');
  if (!own) return null;
  try {
    const t = readTimeProperty(own);
    return { key: recurrenceKeyOf(t, zctx), ridUtc: timeToUtcMs(t, zctx) };
  } catch {
    return null;
  }
}

interface ComponentSet {
  components: PreparedComponent[];
  /** Indice dell'override → recurrence_key del suo componente (solo quelli salvati). */
  overrideKey: Map<number, string>;
  hasMaster: boolean;
}

/**
 * Componenti dell'oggetto: master (chiave '') e un componente per ogni
 * override vincitore, con la chiave delle occorrenze di expandObject quando
 * l'override cade nella finestra e quella calcolata allo stesso modo
 * altrimenti; orfani da expandObject o, fuori finestra, da findOrphanOverrides.
 */
function buildComponents(obj: CalendarObject, expansion: ExpansionResult | null, zctx: ZoneContext): ComponentSet {
  const components: PreparedComponent[] = [];
  const overrideKey = new Map<number, string>();
  const used = new Set<string>();
  let hasMaster = false;
  if (obj.master) {
    const row = componentRow(obj.master, MASTER_RECURRENCE_KEY, { orphan: false, ridUtcFallback: null, zctx });
    if (row) {
      components.push(row);
      used.add(MASTER_RECURRENCE_KEY);
      hasMaster = true;
    }
  }
  if (obj.overrides.length === 0) return { components, overrideKey, hasMaster };

  const inWindow = new Map<number, ExpandedOccurrence>();
  for (const occ of expansion?.occurrences ?? []) {
    if (occ.source.type === 'override') inWindow.set(occ.source.index, occ);
  }
  let orphanCheck: ReturnType<typeof findOrphanOverrides> | null = null;
  const orphans = (): ReturnType<typeof findOrphanOverrides> => {
    if (!orphanCheck) {
      try {
        orphanCheck = findOrphanOverrides(obj, { tz: zctx.tz, timezones: zctx.timezones });
      } catch {
        orphanCheck = { orphans: [], invalid: [], shadowed: [], undetermined: [] };
      }
    }
    return orphanCheck;
  };
  const start = masterStart(obj);
  // Prima gli override espansi (vincitori certi), poi gli altri nell'ordine del file.
  const order = [...inWindow.keys(), ...obj.overrides.map((_, i) => i).filter((i) => !inWindow.has(i))];
  for (const index of order) {
    const c = obj.overrides[index];
    const occ = inWindow.get(index);
    let key: string;
    let orphan: boolean;
    let ridUtc: number | null;
    if (occ) {
      key = occ.recurrenceKey;
      orphan = occ.kind === 'orphan_override';
      ridUtc = occ.originalStartUtc ?? occ.startUtc;
    } else {
      const check = orphans();
      if (check.shadowed.includes(index)) continue;
      const fb = fallbackOverrideKey(c, start, zctx);
      if (!fb) continue;
      key = fb.key;
      ridUtc = fb.ridUtc;
      orphan = check.orphans.includes(index) || check.invalid.includes(index) || !obj.master;
    }
    if (key === MASTER_RECURRENCE_KEY || key === CONSERVATIVE_RECURRENCE_KEY || used.has(key)) continue;
    const row = componentRow(c, key, { orphan, ridUtcFallback: ridUtc, zctx });
    if (!row) continue;
    used.add(key);
    overrideKey.set(index, key);
    components.push(row);
  }
  return { components, overrideKey, hasMaster };
}

// ─── Occorrenze ───────────────────────────────

function occurrenceRow(
  occ: ExpandedOccurrence,
  componentKey: string | null,
  componentType: string,
  href: string,
  context: CollectionContext,
): PreparedOccurrence {
  const kind = classifyOccurrenceKind(context.role, href, occ.kind);
  let allDay = occ.allDay;
  let startDate = occ.startDate;
  let endDate = occ.endDate;
  if (allDay && (!startDate || !endDate || startDate >= endDate)) {
    // cal_occurrences_allday_check: senza date coerenti l'occorrenza resta un intervallo orario.
    allDay = false;
    startDate = null;
    endDate = null;
  }
  const blocks = computeBlocks(
    { componentType, status: occ.status, transp: occ.transp, allDay: occ.allDay, kind },
    { allDayOpaqueBlocks: context.blockRules.allDayOpaqueBlocks },
  );
  return {
    recurrenceKey: occ.recurrenceKey,
    componentKey: occ.recurrenceKey === CONSERVATIVE_RECURRENCE_KEY ? null : componentKey,
    startUtc: iso(occ.startUtc),
    endUtc: iso(Math.max(occ.endUtc, occ.startUtc)),
    allDay,
    startDate: allDay ? startDate : null,
    endDate: allDay ? endDate : null,
    status: legacyStatusOf(occ.status),
    transp: occ.transp === 'TRANSPARENT' ? 'TRANSPARENT' : 'OPAQUE',
    kind,
    // Una proiezione non blocca mai (cal_occurrences_projection_check).
    blocks: kind === 'booking_projection' ? false : blocks,
  };
}

/** Occorrenze dell'espansione con le chiavi dei componenti salvati. */
function occurrenceRows(obj: CalendarObject, expansion: ExpansionResult, set: ComponentSet, href: string, context: CollectionContext): PreparedOccurrence[] {
  return expansion.occurrences.map((occ) => {
    let componentKey: string | null = null;
    if (occ.source.type === 'master') componentKey = set.hasMaster ? MASTER_RECURRENCE_KEY : null;
    else componentKey = set.overrideKey.get(occ.source.index) ?? null;
    return occurrenceRow(occ, componentKey, obj.componentType, href, context);
  });
}

/**
 * Blocco conservativo dal testo grezzo (design §6.5, quarantena senza versione
 * buona): l'intervallo estratto in modo tollerante, ritagliato sulla finestra;
 * fine aperta → fine della finestra. Nessuna occorrenza se il testo non ha un
 * DTSTART leggibile o se l'intervallo cade tutto fuori dalla finestra.
 */
export function conservativeFromText(
  raw: string,
  href: string,
  componentType: ObjectComponent,
  pc: PrepareContext,
): { occurrences: PreparedOccurrence[]; range: { start: number; end: number | null; recurring: boolean } | null } {
  const tz = safeTimezone(pc.context.timezone);
  const range = conservativeRangeFromText(raw, { tz });
  if (!range) return { occurrences: [], range: null };
  if ((range.end !== null && range.end <= pc.from) || range.start >= pc.to) return { occurrences: [], range };
  const start = Math.max(range.start, pc.from);
  const end = Math.max(start, Math.min(range.end ?? pc.to, pc.to));
  const kind = classifyOccurrenceKind(pc.context.role, href, 'conservative');
  // Senza sapere STATUS e TRANSP si blocca (conservativo), salvo proiezioni e componenti non VEVENT.
  const blocks = kind !== 'booking_projection' && (componentType === 'VEVENT' || componentType === 'UNKNOWN');
  return {
    occurrences: [
      {
        recurrenceKey: CONSERVATIVE_RECURRENCE_KEY,
        componentKey: null,
        startUtc: iso(start),
        endUtc: iso(end),
        allDay: false,
        startDate: null,
        endDate: null,
        status: 'confirmed',
        transp: 'OPAQUE',
        kind,
        blocks,
      },
    ],
    range,
  };
}

// ─── Preparazione di un item ───────────────────────────────

function parseReason(code: string): string {
  switch (code) {
    case 'TOO_LARGE':
      return HEALTH_REASONS.tooLarge;
    case 'NO_COMPONENT':
      return HEALTH_REASONS.noComponent;
    case 'MULTIPLE_UIDS':
      return HEALTH_REASONS.mixedUids;
    default:
      return HEALTH_REASONS.parseError;
  }
}

function emptyMaterialization(): PreparedMaterialization {
  return { components: [], occurrences: [], rangeStart: null, rangeEnd: null, isRecurring: false, materializedUntil: null };
}

/** Item in quarantena per un testo che non si parsa (o assente): blocco conservativo dal testo. */
function unparseableItem(
  item: RawItem,
  origin: PreparedItem['origin'],
  reason: string,
  pc: PrepareContext,
  base: Pick<PreparedItem, 'href' | 'etag' | 'raw' | 'sha256' | 'sizeBytes'>,
): PreparedItem {
  const raw = item.raw;
  const component = raw === null ? 'UNKNOWN' : looseComponent(raw);
  const uid = raw === null ? null : looseUid(raw);
  const prov = deriveProvenance({ role: pc.context.role, href: item.href, component: null, uid });
  let materialization = emptyMaterialization();
  if (raw !== null) {
    const fallback = conservativeFromText(raw, item.href, component, pc);
    materialization = {
      components: [],
      occurrences: fallback.occurrences,
      rangeStart: fallback.range ? iso(fallback.range.start) : null,
      rangeEnd: fallback.range && fallback.range.end !== null ? iso(Math.max(fallback.range.end, fallback.range.start)) : null,
      isRecurring: fallback.range?.recurring ?? false,
      materializedUntil: null,
    };
  }
  return {
    ...base,
    ...materialization,
    origin,
    uid,
    component,
    semanticFp: null,
    source: prov.source,
    sourceId: prov.source_id ? pgText(prov.source_id) : null,
    xSource: null,
    xSourceId: null,
    legacyId: null,
    health: 'quarantined',
    healthReason: reason,
    valid: false,
    preferLastGood: true,
    overrideKeys: [],
    warnings: [],
  };
}

/** Componenti e occorrenze di un oggetto già parsato, con l'esito dell'espansione. */
function materialize(obj: CalendarObject, href: string, pc: PrepareContext): { materialization: PreparedMaterialization; expansion: ExpansionResult; set: ComponentSet } {
  const tz = safeTimezone(pc.context.timezone);
  const zctx = zoneContext(obj, tz);
  const expansion = expandObject(obj, { from: pc.from, to: pc.to, tz });
  const set = buildComponents(obj, expansion, zctx);
  const occurrences = occurrenceRows(obj, expansion, set, href, pc.context);
  return {
    expansion,
    set,
    materialization: {
      components: set.components,
      occurrences,
      rangeStart: expansion.rangeStart !== null ? iso(expansion.rangeStart) : null,
      rangeEnd: expansion.rangeEnd !== null ? iso(Math.max(expansion.rangeEnd, expansion.rangeStart ?? expansion.rangeEnd)) : null,
      isRecurring: expansion.isRecurring,
      materializedUntil: expansion.materializedUntil !== null ? iso(expansion.materializedUntil) : null,
    },
  };
}

/**
 * Prepara una risorsa. Non lancia mai: un errore inatteso (difetto del codice
 * su un testo particolare) mette in quarantena il solo oggetto con il motivo
 * 'index-error' e il blocco conservativo dal testo.
 */
export function prepareItem(item: RawItem, origin: PreparedItem['origin'], pc: PrepareContext): PreparedItem {
  const raw = item.raw;
  const base = {
    href: item.href,
    etag: item.etag,
    raw: raw === null ? null : pgText(raw),
    sha256: raw === null ? null : sha256Hex(raw),
    sizeBytes: raw === null ? null : Buffer.byteLength(raw, 'utf8'),
  };
  if (raw === null) {
    return unparseableItem(item, origin, origin === 'radicale-skip' ? HEALTH_REASONS.radicaleSkip : HEALTH_REASONS.unreadable, pc, base);
  }
  try {
    const parsed = parseCalendarObject(raw, { malformedLines: 'skip' });
    if (!parsed.ok) {
      return unparseableItem(item, origin, origin === 'radicale-skip' ? HEALTH_REASONS.radicaleSkip : parseReason(parsed.error.code), pc, base);
    }
    const obj = parsed.value;
    const first = obj.master ?? obj.overrides[0] ?? null;
    const prov = deriveProvenance({ role: pc.context.role, href: item.href, component: first, uid: obj.uid });
    let semanticFp: string | null = item.semanticFp ?? null;
    if (!semanticFp) {
      try {
        semanticFp = semanticFingerprint(obj);
      } catch {
        semanticFp = null;
      }
    }
    const legacyRaw = obj.master ? getTextValue(obj.master, X_CALDES.LEGACY_ID)?.trim() ?? null : null;
    const { materialization, expansion, set } = materialize(obj, item.href, pc);
    const common = {
      ...base,
      origin,
      uid: pgText(obj.uid),
      component: obj.componentType as ObjectComponent,
      semanticFp,
      source: prov.source,
      sourceId: prov.source_id ? pgText(prov.source_id) : null,
      xSource: first ? emptyToNull(getTextValue(first, X_CALDES.SOURCE)) : null,
      xSourceId: first ? emptyToNull(getTextValue(first, X_CALDES.SOURCE_ID)) : null,
      legacyId: legacyRaw && UUID_RE.test(legacyRaw) ? legacyRaw.toLowerCase() : null,
      overrideKeys: [...set.overrideKey.values()],
      warnings: [...new Set(expansion.warnings.map((w) => w.code))],
    };
    if (origin === 'radicale-skip') {
      // Radicale non serve il file ai device (vobject non lo legge): quarantena,
      // ma il busy usa la sua espansione se esiste (o la conservativa).
      const occurrences = materialization.occurrences.length > 0
        ? materialization.occurrences
        : conservativeFromText(raw, item.href, common.component, pc).occurrences;
      return { ...common, ...materialization, occurrences, health: 'quarantined', healthReason: HEALTH_REASONS.radicaleSkip, valid: false, preferLastGood: true };
    }
    if (expansion.health === 'quarantined') {
      const reason = expansion.healthReason ?? HEALTH_REASONS.parseError;
      const occurrences = materialization.occurrences.length > 0
        ? materialization.occurrences
        : conservativeFromText(raw, item.href, common.component, pc).occurrences;
      return {
        ...common,
        ...materialization,
        occurrences,
        health: 'quarantined',
        healthReason: reason,
        valid: false,
        // Budget esaurito: vale l'occorrenza conservativa dell'espansione (contratto §2.5).
        preferLastGood: reason !== HEALTH_REASONS.expansionBudget,
      };
    }
    return { ...common, ...materialization, health: 'ok', healthReason: null, valid: true, preferLastGood: false };
  } catch (err) {
    const item2 = unparseableItem(item, origin, 'index-error', pc, base);
    item2.warnings = [`INDEX_ERROR:${errorMessage(err).slice(0, 120)}`];
    return item2;
  }
}

/**
 * Fingerprint semantico di un testo già indicizzato (stesso calcolo di
 * prepareItem); null se il testo non si parsa o il fingerprint non si calcola.
 * Serve al confronto "invariato" delle iscrizioni in quarantena, il cui
 * semantic_fp in cal_objects è NULL per contratto.
 */
export function semanticFingerprintOfRaw(raw: string): string | null {
  try {
    const parsed = parseCalendarObject(raw, { malformedLines: 'skip' });
    return parsed.ok ? semanticFingerprint(parsed.value) : null;
  } catch {
    return null;
  }
}

/** Contesto di preparazione da un change set. */
export function prepareContextOf(input: Pick<ChangeSetInput, 'context' | 'horizon'>): PrepareContext {
  const from = input.horizon.start.getTime();
  const to = input.horizon.end.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('orizzonte non valido per l\'indicizzazione');
  return { context: input.context, from, to };
}

/** Prepara tutte le risorse di un change set (upserts e 404 con file su disco), nell'ordine. */
export function prepareItems(input: Pick<ChangeSetInput, 'context' | 'horizon' | 'upserts' | 'radicaleSkipped'>): PreparedItem[] {
  const pc = prepareContextOf(input);
  const out: PreparedItem[] = [];
  for (const item of input.upserts) out.push(prepareItem(item, 'upsert', pc));
  for (const item of input.radicaleSkipped) out.push(prepareItem(item, 'radicale-skip', pc));
  return out;
}

/**
 * Item in quarantena forzata con il motivo dato (auditor: file su disco che
 * Radicale non elenca; admin): componenti e occorrenze dal testo se si parsa,
 * altrimenti il blocco conservativo; prevale l'ultima versione buona.
 */
export function prepareForcedQuarantine(href: string, raw: string | null, reason: string, pc: PrepareContext): PreparedItem {
  const item = prepareItem({ href, etag: null, raw }, 'radicale-skip', pc);
  return { ...item, health: 'quarantined', healthReason: reason, valid: false, preferLastGood: true };
}

/**
 * Componenti e occorrenze dell'ultima versione buona di un oggetto in
 * quarantena (design §6.5), da marcare stale; null se quel testo non si
 * espande più (non dovrebbe: era valido).
 */
export function prepareLastGood(href: string, raw: string, pc: PrepareContext): PreparedMaterialization | null {
  try {
    const parsed = parseCalendarObject(raw, { malformedLines: 'skip' });
    if (!parsed.ok) return null;
    const { materialization, expansion } = materialize(parsed.value, href, pc);
    if (expansion.health !== 'ok') return null;
    return materialization;
  } catch {
    return null;
  }
}

// ─── Espansione al volo (oltre materialized_until, fuori orizzonte) ────────

export interface OnTheFlyOccurrence {
  recurrenceKey: string;
  start: Date;
  end: Date;
  allDay: boolean;
  kind: OccurrenceKind;
  blocks: boolean;
}

/**
 * Espande il testo di un oggetto indicizzato sulla finestra [from, to).
 * Non lancia: testo illeggibile o espansione in quarantena → blocco
 * conservativo della sola finestra (intersecata con l'intervallo estratto dal
 * testo, se c'è), `conservative: true`.
 */
export function expandRawOnTheFly(
  raw: string | null,
  href: string,
  context: CollectionContext,
  window: { from: number; to: number },
): { occurrences: OnTheFlyOccurrence[]; conservative: boolean } {
  const pc: PrepareContext = { context, from: window.from, to: window.to };
  const conservativeWindow = (componentType: ObjectComponent): { occurrences: OnTheFlyOccurrence[]; conservative: boolean } => {
    let start = window.from;
    let end = window.to;
    if (raw !== null) {
      const range = conservativeRangeFromText(raw, { tz: safeTimezone(context.timezone) });
      if (range) {
        if ((range.end !== null && range.end <= window.from) || range.start >= window.to) return { occurrences: [], conservative: true };
        start = Math.max(start, range.start);
        end = Math.min(end, range.end ?? end);
      }
    }
    const kind = classifyOccurrenceKind(context.role, href, 'conservative');
    const blocks = kind !== 'booking_projection' && (componentType === 'VEVENT' || componentType === 'UNKNOWN');
    return {
      occurrences: [{ recurrenceKey: CONSERVATIVE_RECURRENCE_KEY, start: new Date(start), end: new Date(Math.max(start, end)), allDay: false, kind, blocks }],
      conservative: true,
    };
  };
  if (raw === null) return conservativeWindow('UNKNOWN');
  try {
    const parsed = parseCalendarObject(raw, { malformedLines: 'skip' });
    if (!parsed.ok) return conservativeWindow(looseComponent(raw));
    const obj = parsed.value;
    const tz = safeTimezone(context.timezone);
    const expansion = expandObject(obj, { from: window.from, to: window.to, tz, computeRangeEnd: false });
    if (expansion.health !== 'ok' && expansion.occurrences.length === 0) return conservativeWindow(obj.componentType);
    const occurrences = expansion.occurrences.map((occ) => {
      const row = occurrenceRow(occ, null, obj.componentType, href, pc.context);
      return { recurrenceKey: row.recurrenceKey, start: new Date(occ.startUtc), end: new Date(Math.max(occ.endUtc, occ.startUtc)), allDay: occ.allDay, kind: row.kind, blocks: row.blocks };
    });
    return { occurrences, conservative: expansion.health !== 'ok' };
  } catch {
    return conservativeWindow(looseComponent(raw));
  }
}

// ─── Worker thread ───────────────────────────────

/** Richiesta al worker: prepara gli item di un change set. */
export interface IndexWorkerRequest {
  id: number;
  input: Pick<ChangeSetInput, 'context' | 'horizon' | 'upserts' | 'radicaleSkipped'>;
}

export type IndexWorkerResponse =
  | { id: number; ok: true; items: PreparedItem[] }
  | { id: number; ok: false; error: string };

/**
 * Corpo del worker_thread dell'indicizzatore: risponde alle richieste di
 * preparazione una alla volta. Lo avvia il bootstrap di indexer.ts (che
 * registra prima il loader TypeScript); non va chiamato nel thread principale.
 */
export function runIndexWorker(): void {
  const port = parentPort;
  if (!port) throw new Error('runIndexWorker: da chiamare solo dentro un worker_thread');
  port.on('message', (msg: IndexWorkerRequest) => {
    let response: IndexWorkerResponse;
    try {
      response = { id: msg.id, ok: true, items: prepareItems(msg.input) };
    } catch (err) {
      response = { id: msg.id, ok: false, error: errorMessage(err) };
    }
    port.postMessage(response);
  });
}
