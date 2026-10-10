/**
 * Patch lossless per campo e CAS per campo (design §8, §11, §13.8).
 *
 * Regole:
 * - si toccano solo le proprietà dei campi nelle ops: VALARM, ATTENDEE, X-*,
 *   parametri sconosciuti (LANGUAGE, X-APPLE-*...) e l'ordine delle altre
 *   proprietà restano invariati; una proprietà modificata conserva i propri
 *   parametri non legati al tipo (per i tempi si riscrivono solo VALUE e
 *   TZID), tranne SUMMARY, DESCRIPTION e LOCATION: quando il valore cambia
 *   resta solo LANGUAGE (ALTREP e simili descrivono il valore vecchio) e si
 *   tolgono le rappresentazioni alternative dello stesso contenuto
 *   (X-ALT-DESC con DESCRIPTION, X-APPLE-STRUCTURED-LOCATION con LOCATION);
 * - SEQUENCE+1 (partendo da 0 se assente) quando cambiano start, end,
 *   duration, rrule, rdates, exdates, location o status; LAST-MODIFIED e
 *   DTSTAMP a `now` per qualsiasi modifica effettiva; nessuna modifica
 *   effettiva (valori già uguali) → `noop: true` e oggetto invariato;
 * - start/end/duration: impostare `end` toglie DURATION e viceversa; il
 *   passaggio timed ↔ all-day ritipizza anche EXDATE, RDATE, UNTIL e i
 *   RECURRENCE-ID degli override del master (stesse regole di
 *   recurrence-ops.shiftSeries);
 * - CAS per campo: se `base` è dato, per ogni campo toccato il valore corrente
 *   (semantico, fieldValuesEqual) deve coincidere con `base[campo]`;
 *   altrimenti PatchConflictError con {field, base, theirs, yours} e nessuna
 *   modifica. Senza `base` vale la base implicita (semantica di admin v1 e
 *   MCP: valori letti subito prima, un solo retry su 412).
 *
 * Ritipizzazione (timed ↔ all-day, e floating ↔ con zona per UNTIL):
 * - DATE-TIME → DATE: la data da muro del valore (UTC → data locale nel fuso
 *   del vecchio DTSTART, o del calendario);
 * - DATE → DATE-TIME: quella data all'ora da muro del nuovo DTSTART, nella sua
 *   zona; UNTIL in UTC se il DTSTART ha una zona (RFC 5545), floating se è
 *   floating. Un UNTIL DATE diventa così l'istante dell'ultima istanza: resta
 *   inclusivo come prima.
 *
 * Coerenza: dopo ops che toccano i tempi, DTEND/DUE deve essere dello stesso
 * tipo di DTSTART e successivo, DURATION positiva (giorni interi sugli
 * all-day); altrimenti IcsValueError('INVALID_VALUE') e nessuna modifica. Le
 * incoerenze preesistenti non bloccano le ops che non toccano i tempi.
 */

import { localDateOf, stringToIcsDate } from './allday';
import { CalendarCoreError, IcsValueError, toCoreError } from './errors';
import { canonicalComponentText, canonicalDurationText, canonicalPropertyText } from './fingerprint';
import { appendAll, encodeText } from './ics-text';
import {
  buildEventFromLegacy,
  type CalendarObject,
  cloneCalendarObject,
  cloneComponent,
  cloneProperty,
  componentRecurrenceKey,
  createTimeListProperties,
  createTimeProperty,
  durationToSeconds,
  formatDurationValue,
  formatTimeValue,
  getProperties,
  getProperty,
  getTextValue,
  type IcsComponent,
  type IcsDateTime,
  type IcsDuration,
  type IcsGeo,
  type IcsParam,
  type IcsPeriod,
  type IcsProperty,
  type IcsTime,
  joinTextList,
  type LegacyEventFields,
  type LegacyEventInput,
  type LegacyEventStatus,
  MASTER_RECURRENCE_KEY,
  parseDateTimeValue,
  parseDateValue,
  parseDurationValue,
  parseRecurrenceKey,
  readTimeListProperty,
  readTimeProperty,
  recurrenceKeyOf,
  removeProperties,
  setProperties,
  setProperty,
  splitTextList,
  timeParams,
  timeToUtcMs,
  toLegacyEventFields,
  utcMsToTime,
  type ZoneContext,
} from './model';
import { materializeOverride, RecurrenceTargetError } from './recurrence-ops';
import { DEFAULT_TZ, ianaName, msToWall, resolveTzid, resolveZone, utcToZoned } from './tz-registry';
import { canonicalRruleText } from './validate';

/** Valori tipizzati dei campi modificabili. */
export interface PatchFieldValues {
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED' | null;
  /** null = TRANSP assente (timed OPAQUE, all-day non bloccante: decisione 6). */
  transp: 'OPAQUE' | 'TRANSPARENT' | null;
  /** CLASS: PUBLIC, PRIVATE, CONFIDENTIAL o x-name; null = assente. */
  class: string | null;
  /** 0-9, null = assente. */
  priority: number | null;
  categories: string[];
  color: string | null;
  geo: IcsGeo | null;
  start: IcsTime;
  /** DTEND (DUE per i VTODO); null = rimosso. */
  end: IcsTime | null;
  duration: IcsDuration | null;
  /** RRULE grezza senza prefisso; null = nessuna ricorrenza. */
  rrule: string | null;
  rdates: Array<IcsTime | IcsPeriod>;
  exdates: IcsTime[];
  /** VALARM completi (sostituiscono tutti quelli esistenti). */
  alarms: IcsComponent[];
  organizer: IcsProperty | null;
  attendees: IcsProperty[];
}

export type PatchFieldName = keyof PatchFieldValues;

/** Operazione su un campo tipizzato, o sostituzione grezza di una proprietà non tipizzata (X-*, CONFERENCE, ATTACH...). */
export type PatchOp =
  | { [F in PatchFieldName]: { op: 'set'; field: F; value: PatchFieldValues[F] } }[PatchFieldName]
  | {
      op: 'setProperty';
      /** Nome della proprietà (non uno dei campi tipizzati: per quelli si usa 'set'). */
      name: string;
      /** Proprietà che sostituiscono tutte quelle con quel nome; [] le rimuove. */
      properties: IcsProperty[];
    };

/** Valori di partenza per il CAS: campi tipizzati più proprietà grezze per nome. */
export type PatchBase = Partial<PatchFieldValues> & { properties?: Record<string, IcsProperty[]> };

export interface FieldConflict {
  /** Nome del campo o della proprietà grezza. */
  field: string;
  base: unknown;
  theirs: unknown;
  yours: unknown;
}

export class PatchConflictError extends CalendarCoreError {
  declare readonly code: 'PATCH_CONFLICT';
  readonly conflicts: FieldConflict[];

  constructor(conflicts: FieldConflict[]) {
    super('PATCH_CONFLICT', `Conflitto sui campi: ${conflicts.map((c) => c.field).join(', ')}`, {
      fields: conflicts.map((c) => c.field),
    });
    this.conflicts = conflicts;
  }
}

export interface PatchContext {
  /** Fuso IANA del calendario. */
  tz: string;
  /** LAST-MODIFIED e DTSTAMP. */
  now: Date;
}

export interface PatchOptions extends PatchContext {
  /** CAS per campo (vedi testa del modulo). */
  base?: PatchBase;
  /**
   * Target non master senza override: true (default) lo materializza con
   * recurrence-ops.materializeOverride prima di applicare le ops; false →
   * RecurrenceTargetError('RECURRENCE_TARGET_GONE').
   */
  createOverride?: boolean;
}

export interface PatchResult {
  object: CalendarObject;
  /** Campi e proprietà grezze effettivamente cambiati. */
  changed: string[];
  noop: boolean;
  sequenceBumped: boolean;
  /**
   * Solo se il passaggio timed ↔ all-day del master ha ritipizzato i
   * RECURRENCE-ID degli override: vecchia recurrence key → nuova, per
   * ri-chiavare cal_object_ids (come ShiftSeriesResult.rekeyed).
   */
  rekeyed?: Map<string, string>;
}

/** Ordine canonico dei campi (readFieldValues senza `fields`, diffFieldValues). */
const ALL_FIELDS: readonly PatchFieldName[] = [
  'summary',
  'description',
  'location',
  'url',
  'status',
  'transp',
  'class',
  'priority',
  'categories',
  'color',
  'geo',
  'start',
  'end',
  'duration',
  'rrule',
  'rdates',
  'exdates',
  'alarms',
  'organizer',
  'attendees',
];

/** Campi la cui modifica incrementa SEQUENCE. */
const SEQUENCE_FIELDS: ReadonlySet<string> = new Set(['start', 'end', 'duration', 'rrule', 'rdates', 'exdates', 'location', 'status']);

/** Proprietà gestite dai campi tipizzati o dalla patch stessa: mai con 'setProperty'. */
const RESERVED_RAW: ReadonlySet<string> = new Set([
  'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'STATUS', 'TRANSP', 'CLASS', 'PRIORITY', 'CATEGORIES', 'COLOR', 'GEO',
  'DTSTART', 'DTEND', 'DUE', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'ORGANIZER', 'ATTENDEE',
  'UID', 'RECURRENCE-ID', 'DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE',
]);

type FieldValue = PatchFieldValues[PatchFieldName];

/**
 * Applica le ops al componente indicato da `recurrenceKey`
 * (MASTER_RECURRENCE_KEY = master; altrimenti l'override di quell'istanza)
 * su una copia dell'oggetto. Errori: PatchConflictError (CAS),
 * RecurrenceTargetError (target sparito), IcsValueError (valori incoerenti,
 * es. end non successivo a start).
 *
 * Il target di un override si risolve con le stesse chiavi di expandObject
 * (recurrence-ops.materializeOverride: vincitore fra gli override duplicati,
 * RECURRENCE-ID di tipo diverso da quello del DTSTART abbinato sulla data
 * locale, prima occorrenza del giorno per un RECURRENCE-ID DATE su una serie
 * oraria), così la recurrence key di cal_occurrences indica sempre il
 * componente che l'utente vede. Senza un master ricorrente leggibile (solo
 * override, evento singolo con orfani, master illeggibile) si cerca fra gli
 * override esistenti per chiave esatta o, a tipi diversi, per data locale.
 * Un override appena materializzato che le ops lasciano identico al master
 * non viene scritto (noop).
 */
export function applyPatch(obj: CalendarObject, recurrenceKey: string, ops: readonly PatchOp[], opts: PatchOptions): PatchResult {
  try {
    const tz = opts.tz || DEFAULT_TZ;
    let work = cloneCalendarObject(obj);
    let target: IcsComponent;
    if (recurrenceKey === MASTER_RECURRENCE_KEY) {
      if (!work.master) throw new RecurrenceTargetError('NO_MASTER', 'Oggetto senza master: indicare l\'occorrenza da modificare');
      target = work.master;
    } else {
      const located = locateOverride(work, recurrenceKey, { tz, now: opts.now }, opts.createOverride !== false);
      work = located.object;
      target = located.target;
    }

    if (opts.base) {
      const conflicts = checkBase(target, ops, opts.base);
      if (conflicts.length > 0) throw new PatchConflictError(conflicts);
    }

    const ctx: ZoneContext = { tz, timezones: work.timezones };
    const oldStart = readStartSafe(target);
    const res = applyComponentOps(target, ops, { tz, now: opts.now, timezones: work.timezones });
    if (res.changed.length === 0) {
      return { object: cloneCalendarObject(obj), changed: [], noop: true, sequenceBumped: false };
    }

    let rekeyed: Map<string, string> | undefined;
    if (target === work.master && res.changed.includes('start')) {
      const newStart = readStartSafe(target);
      if (oldStart && newStart && oldStart.type !== newStart.type) {
        rekeyed = retypeOverrideIds(work, oldStart, newStart, ctx, opts.now);
      }
    }
    const result: PatchResult = { object: work, changed: res.changed, noop: false, sequenceBumped: res.sequenceBumped };
    if (rekeyed && rekeyed.size > 0) result.rekeyed = rekeyed;
    return result;
  } catch (err) {
    throw toCoreError(err, 'applyPatch');
  }
}

/**
 * Applica le ops a un singolo componente, in place (per i job e per i
 * moduli che hanno già scelto il componente). Stesse regole di applyPatch,
 * senza CAS. `timezones` sono i VTIMEZONE dell'oggetto.
 *
 * In caso di errore (IcsValueError per valori non validi o incoerenti) il
 * componente resta invariato.
 */
export function applyComponentOps(
  component: IcsComponent,
  ops: readonly PatchOp[],
  ctx: PatchContext & { timezones?: readonly IcsComponent[] },
): { changed: string[]; sequenceBumped: boolean } {
  const snapshot = cloneComponent(component);
  try {
    const zctx: ZoneContext = { tz: ctx.tz || DEFAULT_TZ, timezones: ctx.timezones };
    checkOps(ops);
    const changed = new Set<string>();
    const oldStart = readStartSafe(component);
    let timesTouched = false;

    for (const op of ops) {
      if (op.op === 'setProperty') {
        if (applyRawOp(component, op)) changed.add(op.name.toUpperCase());
        continue;
      }
      // Un valore corrente illeggibile non è uguale a nulla: la op lo sovrascrive.
      const current = readFieldSafe(component, op.field);
      if (current !== UNREADABLE && fieldValuesEqual(op.field, current as never, op.value as never)) continue;
      writeField(component, op.field, op.value, changed);
      changed.add(op.field);
      if (op.field === 'start' || op.field === 'end' || op.field === 'duration' || op.field === 'rdates' || op.field === 'exdates' || op.field === 'rrule') {
        timesTouched = true;
      }
    }

    if (changed.has('start') && oldStart) {
      const newStart = readStartSafe(component);
      if (newStart) for (const f of retypeComponentValues(component, oldStart, newStart, zctx)) changed.add(f);
    }
    if (timesTouched) checkCoherence(component, zctx);

    let sequenceBumped = false;
    if (changed.size > 0) {
      sequenceBumped = [...changed].some((f) => SEQUENCE_FIELDS.has(f));
      stamp(component, ctx.now, sequenceBumped);
    }
    return { changed: [...changed], sequenceBumped };
  } catch (err) {
    component.properties = snapshot.properties;
    component.components = snapshot.components;
    throw toCoreError(err, 'applyComponentOps');
  }
}

/** Valori correnti dei campi (tutti se `fields` è omesso), per base/theirs e per l'editor. */
export function readFieldValues(component: IcsComponent, fields?: readonly PatchFieldName[]): Partial<PatchFieldValues> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? ALL_FIELDS) {
    const v = readField(component, f);
    if (v !== undefined) out[f] = v;
  }
  return out as Partial<PatchFieldValues>;
}

/**
 * Uguaglianza semantica dei valori di un campo: tempi confrontati per tipo,
 * zona e ora (stesso istante in zone diverse = diversi: è una modifica);
 * RRULE confrontate per parti senza ordine; liste (categorie, EXDATE, RDATE,
 * attendees) senza ordine e senza duplicati; VALARM per testo canonico;
 * TEXT dopo la decodifica.
 *
 * Stringhe vuote e null sono equivalenti; i fine riga dei TEXT si
 * confrontano normalizzati; durate in forma canonica (P1W = P7D, PT60M =
 * PT1H). `undefined` vale come null.
 */
export function fieldValuesEqual<F extends PatchFieldName>(field: F, a: PatchFieldValues[F], b: PatchFieldValues[F]): boolean {
  return fieldKey(field, a) === fieldKey(field, b);
}

/** Conflitti fra `base` e il componente corrente sui soli campi toccati da `ops` (vuoto = nessun conflitto). */
export function checkBase(component: IcsComponent, ops: readonly PatchOp[], base: PatchBase): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    if (op.op === 'set') {
      if (seen.has(op.field)) continue;
      seen.add(op.field);
      if (!Object.prototype.hasOwnProperty.call(base, op.field) || base[op.field] === undefined) continue;
      const read = readFieldSafe(component, op.field);
      const theirs = read === UNREADABLE ? null : read;
      if (read === UNREADABLE || !fieldValuesEqual(op.field, base[op.field] as never, theirs as never)) {
        conflicts.push({ field: op.field, base: base[op.field], theirs: theirs ?? null, yours: op.value });
      }
    } else {
      const name = op.name.toUpperCase();
      if (seen.has(name)) continue;
      seen.add(name);
      const baseProps = lookupBaseProperties(base, name);
      if (baseProps === undefined) continue;
      const theirs = getProperties(component, name).map(cloneProperty);
      if (rawKey(baseProps) !== rawKey(theirs)) conflicts.push({ field: name, base: baseProps, theirs, yours: op.properties });
    }
  }
  return conflicts;
}

/** Ops che portano i valori `before` ai valori `after` (solo i campi diversi, secondo fieldValuesEqual). */
export function diffFieldValues(before: Partial<PatchFieldValues>, after: Partial<PatchFieldValues>): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const f of ALL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(after, f) || after[f] === undefined) continue;
    const b = before[f];
    if (b !== undefined && fieldValuesEqual(f, b as never, after[f] as never)) continue;
    ops.push({ op: 'set', field: f, value: after[f] } as PatchOp);
  }
  return ops;
}

/** Input di updateEvent dell'API v1 (UpdateEventInput in apps/api/src/lib/calendar/events.ts). */
export interface LegacyEventUpdate {
  summary?: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  start_time?: string;
  end_time?: string;
  all_day?: boolean;
  rrule?: string | null;
  exdates?: string[];
  status?: LegacyEventStatus;
  /** Spostamento di calendario: non è una patch (MOVE), viene ignorato qui e gestito dallo store. */
  calendar_id?: string;
}

/**
 * Traduzione di un updateEvent v1 in ops sul componente corrente, con le
 * convenzioni di model.buildEventFromLegacy (fuso del calendario per i timed,
 * TZID del DTSTART corrente per le serie, VALUE=DATE per gli all-day, UNTIL ed
 * EXDATE normalizzati). Campi assenti → nessuna op; stringhe vuote → null. Le
 * validazioni dei messaggi di oggi (end > start, RRULE valida) le fa lo store
 * prima di chiamarla, con gli stessi testi di events.ts.
 *
 * Dettagli:
 * - solo i campi diversi dal valore corrente producono un'op (un update che
 *   riscrive gli stessi valori è un noop);
 * - un DTSTART timed esistente conserva la propria zona (TZID, UTC o
 *   floating: si cambia l'istante, non la rappresentazione); un evento che
 *   diventa timed prende il fuso del calendario;
 * - end_time come istante fisso, come il legacy: su un evento con DURATION
 *   un cambio di orari scrive DTEND (la fine non "segue" l'inizio);
 * - rrule ed exdates passati dal client seguono la semantica legacy
 *   (normalizeLegacyRrule); se cambia solo all_day, EXDATE e UNTIL esistenti
 *   li ritipizza applyComponentOps;
 * - uno spostamento di "tutta la serie" con Δ su RECURRENCE-ID ed EXDATE
 *   (design §8) non è compito di questa funzione: lo store usa
 *   recurrence-ops.shiftSeries.
 * `ctx.timezones` (VTIMEZONE dell'oggetto) serve per i TZID non IANA.
 */
export function opsFromLegacyUpdate(
  component: IcsComponent,
  input: LegacyEventUpdate,
  ctx: PatchContext & { timezones?: readonly IcsComponent[] },
): PatchOp[] {
  try {
    const tz = ctx.tz || DEFAULT_TZ;
    const zctx: ZoneContext = { tz, timezones: ctx.timezones };
    const candidate: Partial<PatchFieldValues> = {};
    const textOrNull = (v: string | null | undefined): string | null => (v == null || v === '' ? null : v);
    if (input.summary !== undefined) candidate.summary = textOrNull(input.summary);
    if (input.description !== undefined) candidate.description = textOrNull(input.description);
    if (input.location !== undefined) candidate.location = textOrNull(input.location);
    if (input.url !== undefined) candidate.url = textOrNull(input.url);
    if (input.status !== undefined) candidate.status = input.status.toUpperCase() as PatchFieldValues['status'];

    const timesTouched = input.start_time !== undefined || input.end_time !== undefined || input.all_day !== undefined;
    if (timesTouched || input.rrule !== undefined || input.exdates !== undefined) {
      Object.assign(candidate, legacyTimeCandidates(component, input, zctx, ctx.now));
    }

    const current = readFieldValues(component, Object.keys(candidate) as PatchFieldName[]);
    const ops = diffFieldValues(current, candidate);
    return skipEquivalentEnd(component, ops, zctx);
  } catch (err) {
    throw toCoreError(err, 'opsFromLegacyUpdate');
  }
}

/**
 * Shadow mirror (design §13.8): ops per campo che portano un oggetto già
 * presente in Radicale dallo stato `before` (legacy_snapshot) allo stato
 * `after` (riga legacy corrente), così VALARM, ATTENDEE e X-* scritti dai
 * device restano. Solo i campi diversi.
 *
 * I campi uguali fra `before` e `after` non producono ops anche se Radicale
 * ha un valore diverso (modifica del device da preservare); quelli diversi si
 * traducono con opsFromLegacyUpdate. uid e recurrence_id sono l'identità
 * dell'oggetto e non si modificano.
 */
export function opsFromLegacyDiff(
  component: IcsComponent,
  before: LegacyEventFields,
  after: LegacyEventFields,
  ctx: PatchContext & { timezones?: readonly IcsComponent[] },
): PatchOp[] {
  try {
    const update: LegacyEventUpdate = {};
    const sameText = (a: string | null, b: string | null): boolean => (a ?? '') === (b ?? '');
    if (before.summary !== after.summary) update.summary = after.summary;
    if (!sameText(before.description, after.description)) update.description = after.description;
    if (!sameText(before.location, after.location)) update.location = after.location;
    if (!sameText(before.url, after.url)) update.url = after.url;
    if (before.status !== after.status) update.status = after.status;
    const startChanged = Date.parse(before.start_time) !== Date.parse(after.start_time);
    const endChanged = Date.parse(before.end_time) !== Date.parse(after.end_time);
    if (startChanged || endChanged || before.all_day !== after.all_day) {
      // Gli all-day si calcolano dalla coppia inizio-fine: si passano entrambi.
      update.start_time = after.start_time;
      update.end_time = after.end_time;
      update.all_day = after.all_day;
    }
    if ((before.rrule ? canonicalRruleText(before.rrule) : '') !== (after.rrule ? canonicalRruleText(after.rrule) : '')) {
      update.rrule = after.rrule;
    }
    const msSet = (list: readonly string[]): string => [...new Set(list.map((d) => Date.parse(d)))].sort((a, b) => a - b).join(',');
    if (msSet(before.exdates) !== msSet(after.exdates)) update.exdates = [...after.exdates];
    return opsFromLegacyUpdate(component, update, ctx);
  } catch (err) {
    throw toCoreError(err, 'opsFromLegacyDiff');
  }
}

/**
 * Update v1 (UpdateEventInput; anche createOccurrenceOverride tradotto in
 * start_time/end_time/summary/description) applicato al componente indicato
 * da `recurrenceKey`, in un solo passo: risolve il target come applyPatch
 * (materializzando l'override di un'istanza se serve), calcola le ops con
 * opsFromLegacyUpdate sul componente risolto (non sul master: un override
 * ha orari e testi propri) e le applica. `opts.base` resta disponibile per il
 * CAS; admin v1 e MCP usano la base implicita. Un update che non cambia nulla
 * è un noop con l'oggetto invariato (nessun override materializzato).
 */
export function applyLegacyUpdate(
  obj: CalendarObject,
  recurrenceKey: string,
  input: LegacyEventUpdate,
  opts: PatchOptions,
): PatchResult & { ops: PatchOp[] } {
  try {
    const tz = opts.tz || DEFAULT_TZ;
    let work = cloneCalendarObject(obj);
    let target: IcsComponent;
    if (recurrenceKey === MASTER_RECURRENCE_KEY) {
      if (!work.master) throw new RecurrenceTargetError('NO_MASTER', 'Oggetto senza master: indicare l\'occorrenza da modificare');
      target = work.master;
    } else {
      const located = locateOverride(work, recurrenceKey, { tz, now: opts.now }, opts.createOverride !== false);
      work = located.object;
      target = located.target;
    }
    const ops = opsFromLegacyUpdate(target, input, { tz, now: opts.now, timezones: work.timezones });
    const unchanged = { object: cloneCalendarObject(obj), changed: [], noop: true, sequenceBumped: false, ops };
    if (ops.length === 0) return unchanged;
    const res = applyPatch(work, recurrenceKey, ops, { ...opts, tz });
    return res.noop ? unchanged : { ...res, ops };
  } catch (err) {
    throw toCoreError(err, 'applyLegacyUpdate');
  }
}

// ============================================
// Lettura dei campi
// ============================================

function endPropertyName(c: IcsComponent): 'DTEND' | 'DUE' {
  return c.name.toUpperCase() === 'VTODO' ? 'DUE' : 'DTEND';
}

function emptyToNull(s: string | null | undefined): string | null {
  return s == null || s === '' ? null : s;
}

function readStartSafe(c: IcsComponent): IcsTime | null {
  const p = getProperty(c, 'DTSTART');
  if (!p) return null;
  try {
    return readTimeProperty(p);
  } catch {
    return null;
  }
}

/** Valore corrente di un campo; undefined se il campo non ha senso (DTSTART assente). Tempi illeggibili → IcsValueError. */
function readField(c: IcsComponent, field: PatchFieldName): FieldValue | undefined {
  switch (field) {
    case 'summary':
      return emptyToNull(getTextValue(c, 'SUMMARY'));
    case 'description':
      return emptyToNull(getTextValue(c, 'DESCRIPTION'));
    case 'location':
      return emptyToNull(getTextValue(c, 'LOCATION'));
    case 'url':
      return emptyToNull(getProperty(c, 'URL')?.value.trim() ?? null);
    case 'color':
      return emptyToNull(getProperty(c, 'COLOR')?.value.trim() ?? null);
    case 'status':
      return upperOrNull(getTextValue(c, 'STATUS')) as PatchFieldValues['status'];
    case 'transp':
      return upperOrNull(getTextValue(c, 'TRANSP')) as PatchFieldValues['transp'];
    case 'class':
      return upperOrNull(getTextValue(c, 'CLASS'));
    case 'priority': {
      const v = getProperty(c, 'PRIORITY')?.value.trim();
      return v != null && /^[+-]?\d+$/.test(v) ? Number(v) : null;
    }
    case 'categories': {
      const out: string[] = [];
      for (const p of getProperties(c, 'CATEGORIES')) appendAll(out, splitTextList(p.value).filter((s) => s !== ''));
      return out;
    }
    case 'geo': {
      const v = getProperty(c, 'GEO')?.value;
      if (v == null) return null;
      const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*[;,]\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(v);
      return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
    }
    case 'start': {
      const p = getProperty(c, 'DTSTART');
      return p ? readTimeProperty(p) : undefined;
    }
    case 'end': {
      const p = getProperty(c, endPropertyName(c));
      return p ? readTimeProperty(p) : null;
    }
    case 'duration': {
      const p = getProperty(c, 'DURATION');
      return p ? parseDurationValue(p.value, 'DURATION') : null;
    }
    case 'rrule': {
      const p = getProperty(c, 'RRULE');
      return p ? p.value.trim().replace(/^RRULE:/i, '') || null : null;
    }
    case 'rdates': {
      const out: Array<IcsTime | IcsPeriod> = [];
      for (const p of getProperties(c, 'RDATE')) appendAll(out, readTimeListProperty(p));
      return out;
    }
    case 'exdates': {
      const out: IcsTime[] = [];
      for (const p of getProperties(c, 'EXDATE')) {
        for (const v of readTimeListProperty(p)) if (v.type !== 'period') out.push(v);
      }
      return out;
    }
    case 'alarms':
      return c.components.filter((x) => x.name.toUpperCase() === 'VALARM').map(cloneComponent);
    case 'organizer': {
      const p = getProperty(c, 'ORGANIZER');
      return p ? cloneProperty(p) : null;
    }
    case 'attendees':
      return getProperties(c, 'ATTENDEE').map(cloneProperty);
    default:
      return undefined;
  }
}

/** Segnaposto di un valore corrente illeggibile (tempo o durata non validi). */
const UNREADABLE = Symbol('illeggibile');

function readFieldSafe(c: IcsComponent, field: PatchFieldName): FieldValue | undefined | typeof UNREADABLE {
  try {
    return readField(c, field);
  } catch {
    return UNREADABLE;
  }
}

function upperOrNull(s: string | null): string | null {
  if (s == null) return null;
  const v = s.trim().toUpperCase();
  return v === '' ? null : v;
}

// ============================================
// Confronto semantico
// ============================================

function timeKey(t: IcsTime): string {
  return `${formatTimeValue(t)}|${timeParams(t)
    .map((p) => `${p.name}=${p.values.join(',')}`)
    .join(';')}`;
}

function listTimeKey(v: IcsTime | IcsPeriod): string {
  if (v.type !== 'period') return timeKey(v);
  return `P:${timeKey(v.start)}/${v.end ? timeKey(v.end) : canonicalDurationText(v.duration ?? { negative: false, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 })}`;
}

function sortedUnique(keys: string[]): string {
  return [...new Set(keys)].sort().join('\u0000');
}

function rawKey(props: readonly IcsProperty[]): string {
  return props.map((p) => canonicalPropertyText(p)).sort().join('\u0000');
}

/** Chiave semantica di un valore di campo: due valori sono uguali se e solo se hanno la stessa chiave. */
function fieldKey(field: PatchFieldName, value: unknown): string {
  if (value === undefined || value === null) {
    return field === 'categories' || field === 'rdates' || field === 'exdates' || field === 'alarms' || field === 'attendees' ? '' : '\u0000null';
  }
  switch (field) {
    case 'summary':
    case 'description':
    case 'location': {
      const s = String(value).replace(/\r\n|\r/g, '\n');
      return s === '' ? '\u0000null' : `t:${s}`;
    }
    case 'url':
    case 'color': {
      const s = String(value).trim();
      return s === '' ? '\u0000null' : `s:${s}`;
    }
    case 'status':
    case 'transp':
    case 'class': {
      const s = String(value).trim().toUpperCase();
      return s === '' ? '\u0000null' : `e:${s}`;
    }
    case 'priority':
      return `n:${Number(value)}`;
    case 'categories':
      return sortedUnique((value as string[]).filter((s) => s !== ''));
    case 'geo': {
      const g = value as IcsGeo;
      return `g:${Math.round(g.lat * 1e6)};${Math.round(g.lon * 1e6)}`;
    }
    case 'start':
    case 'end':
      return timeKey(value as IcsTime);
    case 'duration':
      return `d:${canonicalDurationText(value as IcsDuration)}`;
    case 'rrule': {
      const s = String(value).trim();
      return s === '' ? '\u0000null' : `r:${canonicalRruleText(s)}`;
    }
    case 'rdates':
    case 'exdates':
      return sortedUnique((value as Array<IcsTime | IcsPeriod>).map(listTimeKey));
    case 'alarms':
      return (value as IcsComponent[]).map((c) => canonicalComponentText(c)).sort().join('\u0000');
    case 'organizer':
      return `o:${canonicalPropertyText(value as IcsProperty)}`;
    case 'attendees':
      return sortedUnique((value as IcsProperty[]).map((p) => canonicalPropertyText(p)));
    default:
      return JSON.stringify(value);
  }
}

function lookupBaseProperties(base: PatchBase, name: string): IcsProperty[] | undefined {
  const props = base.properties;
  if (!props) return undefined;
  if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
  const key = Object.keys(props).find((k) => k.toUpperCase() === name);
  return key ? props[key] : undefined;
}

// ============================================
// Scrittura dei campi
// ============================================

function invalid(message: string, property: string | null = null): IcsValueError {
  return new IcsValueError('INVALID_VALUE', message, { property });
}

function checkOps(ops: readonly PatchOp[]): void {
  let end = false;
  let duration = false;
  for (const op of ops) {
    if (op.op === 'set') {
      if (!ALL_FIELDS.includes(op.field)) throw invalid(`Campo sconosciuto: ${String(op.field).slice(0, 30)}`);
      if (op.field === 'end' && op.value != null) end = true;
      if (op.field === 'duration' && op.value != null) duration = true;
      if (op.field === 'start' && op.value == null) throw invalid('DTSTART non si può rimuovere', 'DTSTART');
    } else if (op.op === 'setProperty') {
      const name = String(op.name ?? '').toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_.-]*$/.test(name)) throw invalid(`Nome di proprietà non valido: "${String(op.name).slice(0, 30)}"`);
      if (RESERVED_RAW.has(name)) throw invalid(`${name} si modifica con il campo tipizzato, non con setProperty`, name);
      for (const p of op.properties) {
        if (p.name.toUpperCase() !== name) throw invalid(`Proprietà ${p.name.slice(0, 30)} in un'operazione su ${name}`, name);
        if (/[\r\n]/.test(p.value)) throw invalid(`Valore di ${name} con un a capo`, name);
      }
    } else {
      throw invalid('Operazione sconosciuta');
    }
  }
  if (end && duration) throw invalid('DTEND e DURATION non possono essere impostati insieme', 'DURATION');
}

function applyRawOp(c: IcsComponent, op: { name: string; properties: IcsProperty[] }): boolean {
  const name = op.name.toUpperCase();
  const current = getProperties(c, name);
  if (rawKey(current) === rawKey(op.properties)) return false;
  setProperties(
    c,
    name,
    op.properties.map((p) => ({ ...cloneProperty(p), name })),
  );
  return true;
}

/** Parametri non legati al tipo (VALUE e TZID esclusi) della proprietà esistente. */
function extraParams(c: IcsComponent, name: string): IcsParam[] {
  const p = getProperty(c, name);
  return p ? p.params.filter((x) => x.name !== 'VALUE' && x.name !== 'TZID').map((x) => ({ name: x.name, values: [...x.values] })) : [];
}

function existingParams(c: IcsComponent, name: string): IcsParam[] {
  const p = getProperty(c, name);
  return p ? p.params.map((x) => ({ name: x.name, values: [...x.values] })) : [];
}

function setSimple(c: IcsComponent, name: string, value: string | null): void {
  if (value == null || value === '') {
    removeProperties(c, name);
    return;
  }
  if (/[\r\n]/.test(value)) throw invalid(`Valore di ${name} con un a capo`, name);
  setProperty(c, { name, params: existingParams(c, name), value });
}

function formatGeoNumber(n: number): string {
  return String(Number(n.toFixed(6)));
}

/**
 * Proprietà che rappresentano lo stesso contenuto in un'altra forma: quando il
 * campo cambia diventano false e si tolgono (X-ALT-DESC: descrizione HTML di
 * Outlook; X-APPLE-STRUCTURED-LOCATION: mappa, pin e tempo di viaggio su iOS e
 * macOS, che i client Apple rigenerano dalla LOCATION). GEO resta: può non
 * derivare dalla LOCATION.
 */
const TEXT_FIELD_DEPENDENTS: Readonly<Record<'SUMMARY' | 'DESCRIPTION' | 'LOCATION', readonly string[]>> = {
  SUMMARY: [],
  DESCRIPTION: ['X-ALT-DESC'],
  LOCATION: ['X-APPLE-STRUCTURED-LOCATION'],
};

/**
 * Scrive un campo TEXT che cambia davvero (writeField è chiamata solo allora):
 * dei parametri resta solo LANGUAGE. ALTREP (RFC 5545 §3.2.1, per esempio la
 * descrizione HTML data:text/html di Thunderbird, che i client preferiscono al
 * testo) e gli altri parametri descrivono il valore vecchio: conservarli
 * mostrerebbe sui device, e pubblicherebbe nel feed, il contenuto tolto. Le
 * proprietà dipendenti (TEXT_FIELD_DEPENDENTS) si tolgono, anche quando il
 * campo viene rimosso.
 */
function writeTextField(c: IcsComponent, name: 'SUMMARY' | 'DESCRIPTION' | 'LOCATION', text: string | null): void {
  for (const dependent of TEXT_FIELD_DEPENDENTS[name]) removeProperties(c, dependent);
  if (text == null || text === '') {
    removeProperties(c, name);
    return;
  }
  const existing = getProperty(c, name);
  const params = existing
    ? existing.params.filter((x) => x.name.toUpperCase() === 'LANGUAGE').map((x) => ({ name: x.name, values: [...x.values] }))
    : [];
  setProperty(c, { name, params, value: encodeText(text) });
}

function writeField(c: IcsComponent, field: PatchFieldName, value: unknown, changed: Set<string>): void {
  switch (field) {
    case 'summary':
      writeTextField(c, 'SUMMARY', emptyToNull(value as string | null));
      return;
    case 'description':
      writeTextField(c, 'DESCRIPTION', emptyToNull(value as string | null));
      return;
    case 'location':
      writeTextField(c, 'LOCATION', emptyToNull(value as string | null));
      return;
    case 'url':
      setSimple(c, 'URL', emptyToNull((value as string | null)?.trim() ?? null));
      return;
    case 'color':
      setSimple(c, 'COLOR', emptyToNull((value as string | null)?.trim() ?? null));
      return;
    case 'status':
    case 'transp':
    case 'class': {
      const name = field === 'class' ? 'CLASS' : field.toUpperCase();
      const v = value == null ? null : String(value).trim().toUpperCase();
      setSimple(c, name, emptyToNull(v));
      return;
    }
    case 'priority': {
      if (value == null) {
        removeProperties(c, 'PRIORITY');
        return;
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 9) throw invalid('PRIORITY deve essere un intero da 0 a 9', 'PRIORITY');
      setProperty(c, { name: 'PRIORITY', params: existingParams(c, 'PRIORITY'), value: String(n) });
      return;
    }
    case 'categories': {
      const list = ((value as string[] | null) ?? []).filter((s) => s !== '');
      if (list.length === 0) {
        removeProperties(c, 'CATEGORIES');
        return;
      }
      setProperties(c, 'CATEGORIES', [{ name: 'CATEGORIES', params: existingParams(c, 'CATEGORIES'), value: joinTextList(list) }]);
      return;
    }
    case 'geo': {
      if (value == null) {
        removeProperties(c, 'GEO');
        return;
      }
      const g = value as IcsGeo;
      if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon) || Math.abs(g.lat) > 90 || Math.abs(g.lon) > 180) throw invalid('GEO non valido', 'GEO');
      setProperty(c, { name: 'GEO', params: existingParams(c, 'GEO'), value: `${formatGeoNumber(g.lat)};${formatGeoNumber(g.lon)}` });
      return;
    }
    case 'start':
      setProperty(c, createTimeProperty('DTSTART', value as IcsTime, extraParams(c, 'DTSTART')));
      return;
    case 'end': {
      const name = endPropertyName(c);
      if (value == null) {
        removeProperties(c, name);
        return;
      }
      setProperty(c, createTimeProperty(name, value as IcsTime, extraParams(c, name)));
      if (removeProperties(c, 'DURATION') > 0) changed.add('duration');
      return;
    }
    case 'duration': {
      if (value == null) {
        removeProperties(c, 'DURATION');
        return;
      }
      setProperty(c, { name: 'DURATION', params: existingParams(c, 'DURATION').filter((p) => p.name !== 'VALUE'), value: formatDurationValue(value as IcsDuration) });
      if (removeProperties(c, endPropertyName(c)) > 0) changed.add('end');
      return;
    }
    case 'rrule': {
      const raw = value == null ? null : String(value).trim().replace(/^RRULE:/i, '');
      if (raw == null || raw === '') {
        removeProperties(c, 'RRULE');
        return;
      }
      if (/[\r\n]/.test(raw)) throw invalid('RRULE con un a capo', 'RRULE');
      setProperties(c, 'RRULE', [{ name: 'RRULE', params: existingParams(c, 'RRULE'), value: raw }]);
      return;
    }
    case 'rdates': {
      const list = (value as Array<IcsTime | IcsPeriod> | null) ?? [];
      setProperties(c, 'RDATE', list.length > 0 ? createTimeListProperties('RDATE', dedupeList(list)) : []);
      return;
    }
    case 'exdates': {
      const list = (value as IcsTime[] | null) ?? [];
      if (list.some((v) => (v as IcsTime | IcsPeriod).type === 'period')) throw invalid('EXDATE non ammette periodi', 'EXDATE');
      setProperties(c, 'EXDATE', list.length > 0 ? createTimeListProperties('EXDATE', dedupeList(list)) : []);
      return;
    }
    case 'alarms': {
      const list = (value as IcsComponent[] | null) ?? [];
      for (const a of list) if (a.name.toUpperCase() !== 'VALARM') throw invalid(`Componente ${a.name.slice(0, 20)} al posto di un VALARM`, 'VALARM');
      const idx = c.components.findIndex((x) => x.name.toUpperCase() === 'VALARM');
      const rest = c.components.filter((x) => x.name.toUpperCase() !== 'VALARM');
      const at = idx < 0 ? rest.length : c.components.slice(0, idx).filter((x) => x.name.toUpperCase() !== 'VALARM').length;
      c.components = appendAll(appendAll(rest.slice(0, at), list.map(cloneComponent)), rest.slice(at));
      return;
    }
    case 'organizer': {
      if (value == null) {
        removeProperties(c, 'ORGANIZER');
        return;
      }
      const p = value as IcsProperty;
      if (p.name.toUpperCase() !== 'ORGANIZER') throw invalid(`Proprietà ${p.name.slice(0, 20)} al posto di ORGANIZER`, 'ORGANIZER');
      setProperty(c, { ...cloneProperty(p), name: 'ORGANIZER' });
      return;
    }
    case 'attendees': {
      const list = (value as IcsProperty[] | null) ?? [];
      for (const p of list) if (p.name.toUpperCase() !== 'ATTENDEE') throw invalid(`Proprietà ${p.name.slice(0, 20)} al posto di ATTENDEE`, 'ATTENDEE');
      setProperties(c, 'ATTENDEE', list.map((p) => ({ ...cloneProperty(p), name: 'ATTENDEE' })));
      return;
    }
    default:
      throw invalid(`Campo sconosciuto: ${String(field).slice(0, 30)}`);
  }
}

function dedupeList<T extends IcsTime | IcsPeriod>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = listTimeKey(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function utcStamp(d: Date): string {
  return formatTimeValue({ type: 'date-time', ...msToWall(d.getTime()), zone: { kind: 'utc' } });
}

/** DTSTAMP e LAST-MODIFIED a `now`; SEQUENCE+1 (da 0 se assente o illeggibile) se richiesto. */
function stamp(c: IcsComponent, now: Date, bumpSequence: boolean): void {
  const ts = utcStamp(now);
  setProperty(c, { name: 'DTSTAMP', params: [], value: ts });
  setProperty(c, { name: 'LAST-MODIFIED', params: [], value: ts });
  if (bumpSequence) {
    const cur = getProperty(c, 'SEQUENCE')?.value.trim();
    const n = cur != null && /^\d{1,9}$/.test(cur) ? Number(cur) : 0;
    setProperty(c, { name: 'SEQUENCE', params: [], value: String(n + 1) });
  }
}

/** DTEND/DUE dello stesso tipo e successivo a DTSTART; DURATION positiva (giorni interi sugli all-day). */
function checkCoherence(c: IcsComponent, ctx: ZoneContext): void {
  const start = readStartSafe(c);
  if (!start) {
    if (c.name.toUpperCase() === 'VEVENT') throw invalid('Evento senza DTSTART leggibile', 'DTSTART');
    return;
  }
  const endName = endPropertyName(c);
  const endProp = getProperty(c, endName);
  if (endProp) {
    const end = readTimeProperty(endProp);
    if (end.type !== start.type) throw invalid(`${endName} deve essere dello stesso tipo di DTSTART`, endName);
    const after = end.type === 'date' ? formatTimeValue(end) > formatTimeValue(start) : timeToUtcMs(end, ctx) > timeToUtcMs(start, ctx);
    if (!after) throw invalid('La fine deve essere successiva all\'inizio', endName);
  }
  const durProp = getProperty(c, 'DURATION');
  if (durProp && !endProp) {
    const d = parseDurationValue(durProp.value, 'DURATION');
    if (durationToSeconds(d) <= 0) throw invalid('La durata deve essere positiva', 'DURATION');
    if (start.type === 'date' && (d.hours || d.minutes || d.seconds)) throw invalid('Durata con ore o minuti su un evento di tutto il giorno', 'DURATION');
  }
}

// ============================================
// Ritipizzazione timed ↔ all-day
// ============================================

type TimeClass = 'date' | 'floating' | 'zoned';

function timeClass(t: IcsTime): TimeClass {
  if (t.type === 'date') return 'date';
  return t.zone.kind === 'floating' ? 'floating' : 'zoned';
}

/** Zona di riferimento per leggere la data locale di un istante UTC: quella del vecchio DTSTART, o il fuso del calendario. */
function referenceDate(ms: number, oldStart: IcsTime, ctx: ZoneContext): IcsTime {
  if (oldStart.type === 'date-time' && oldStart.zone.kind === 'tzid') {
    const zone = resolveZone(oldStart.zone, { tz: ctx.tz, timezones: ctx.timezones }).zone;
    const w = utcToZoned(ms, zone);
    return { type: 'date', year: w.year, month: w.month, day: w.day };
  }
  return stringToIcsDate(localDateOf(ms, ctx.tz));
}

/** Valore di una lista (EXDATE, RDATE, RECURRENCE-ID) portato al tipo del nuovo DTSTART. */
function retypeTime(t: IcsTime, oldStart: IcsTime, newStart: IcsTime, ctx: ZoneContext): IcsTime {
  if (t.type === newStart.type) return t;
  if (newStart.type === 'date') {
    const dt = t as IcsDateTime;
    if (dt.zone.kind === 'utc') return referenceDate(timeToUtcMs(dt, ctx), oldStart, ctx);
    return { type: 'date', year: dt.year, month: dt.month, day: dt.day };
  }
  return { type: 'date-time', year: t.year, month: t.month, day: t.day, hour: newStart.hour, minute: newStart.minute, second: newStart.second, zone: newStart.zone };
}

/** UNTIL portato alla classe del nuovo DTSTART (DATE, floating o UTC). */
function retypeUntil(until: IcsTime, oldStart: IcsTime, newStart: IcsTime, ctx: ZoneContext): IcsTime {
  const target = timeClass(newStart);
  if (target === 'date') {
    if (until.type === 'date') return until;
    if (until.zone.kind === 'utc') return referenceDate(timeToUtcMs(until, ctx), oldStart, ctx);
    return { type: 'date', year: until.year, month: until.month, day: until.day };
  }
  const ns = newStart as IcsDateTime;
  // DATE → istante dell'ultima istanza (stessa ora da muro del nuovo DTSTART).
  const asDateTime: IcsDateTime =
    until.type === 'date'
      ? { type: 'date-time', year: until.year, month: until.month, day: until.day, hour: ns.hour, minute: ns.minute, second: ns.second, zone: ns.zone }
      : until;
  if (target === 'floating') {
    if (asDateTime.zone.kind === 'floating') return asDateTime;
    const w = utcToZoned(timeToUtcMs(asDateTime, ctx), resolveZone({ kind: 'floating' }, { tz: ctx.tz }).zone);
    return { type: 'date-time', ...w, zone: { kind: 'floating' } };
  }
  if (asDateTime.zone.kind === 'utc') return asDateTime;
  return { type: 'date-time', ...msToWall(timeToUtcMs(asDateTime, ctx)), zone: { kind: 'utc' } };
}

/** RRULE con UNTIL riscritto (le altre parti restano come sono); null se non serve cambiare nulla. */
function rewriteUntil(raw: string, map: (until: IcsTime) => IcsTime): string | null {
  const parts = raw.trim().replace(/^RRULE:/i, '').split(';');
  let changed = false;
  const out = parts.map((part) => {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim().toUpperCase() !== 'UNTIL') return part;
    const value = part.slice(eq + 1).trim();
    let until: IcsTime;
    try {
      until = /^\d{8}$/.test(value) ? parseDateValue(value, 'RRULE') : parseDateTimeValue(value, null, 'RRULE');
    } catch {
      return part; // UNTIL illeggibile: lo segnala validate.
    }
    const next = map(until);
    const formatted = formatTimeValue(next);
    if (formatted === value.toUpperCase()) return part;
    changed = true;
    return `UNTIL=${formatted}`;
  });
  return changed ? out.join(';') : null;
}

/** Ritipizza EXDATE, RDATE e UNTIL del componente dopo un cambio di classe del DTSTART; restituisce i campi toccati. */
function retypeComponentValues(c: IcsComponent, oldStart: IcsTime, newStart: IcsTime, ctx: ZoneContext): string[] {
  const touched: string[] = [];
  const oldClass = timeClass(oldStart);
  const newClass = timeClass(newStart);
  if (oldClass === newClass) return touched;

  if (oldStart.type !== newStart.type) {
    const exProps = getProperties(c, 'EXDATE');
    if (exProps.length > 0) {
      const values: IcsTime[] = [];
      let retyped = false;
      for (const p of exProps) {
        for (const v of readTimeListProperty(p)) {
          if (v.type === 'period') continue;
          const nv = retypeTime(v, oldStart, newStart, ctx);
          if (nv !== v) retyped = true;
          values.push(nv);
        }
      }
      if (retyped) {
        setProperties(c, 'EXDATE', values.length > 0 ? createTimeListProperties('EXDATE', dedupeList(values)) : []);
        touched.push('exdates');
      }
    }
    const rdProps = getProperties(c, 'RDATE');
    if (rdProps.length > 0) {
      const values: Array<IcsTime | IcsPeriod> = [];
      let retyped = false;
      for (const p of rdProps) {
        for (const v of readTimeListProperty(p)) {
          if (v.type === 'period') {
            if (newStart.type === 'date') {
              values.push(retypeTime(v.start, oldStart, newStart, ctx));
              retyped = true;
            } else values.push(v);
            continue;
          }
          const nv = retypeTime(v, oldStart, newStart, ctx);
          if (nv !== v) retyped = true;
          values.push(nv);
        }
      }
      if (retyped) {
        setProperties(c, 'RDATE', values.length > 0 ? createTimeListProperties('RDATE', dedupeList(values)) : []);
        touched.push('rdates');
      }
    }
  }

  const rrules = getProperties(c, 'RRULE');
  if (rrules.length > 0) {
    let rewritten = false;
    const next = rrules.map((p) => {
      const v = rewriteUntil(p.value, (u) => retypeUntil(u, oldStart, newStart, ctx));
      if (v == null) return p;
      rewritten = true;
      return { ...cloneProperty(p), value: v };
    });
    if (rewritten) {
      setProperties(c, 'RRULE', next);
      touched.push('rrule');
    }
  }
  return touched;
}

/** RECURRENCE-ID degli override portati al tipo del nuovo DTSTART del master; vecchia chiave → nuova. */
function retypeOverrideIds(obj: CalendarObject, oldStart: IcsTime, newStart: IcsTime, ctx: ZoneContext, now: Date): Map<string, string> {
  const rekeyed = new Map<string, string>();
  for (const ov of obj.overrides) {
    const p = getProperty(ov, 'RECURRENCE-ID');
    if (!p) continue;
    let rid: IcsTime;
    try {
      rid = readTimeProperty(p);
    } catch {
      continue;
    }
    if (rid.type === newStart.type) continue;
    const nrid = retypeTime(rid, oldStart, newStart, ctx);
    const extras = p.params.filter((x) => x.name !== 'VALUE' && x.name !== 'TZID');
    setProperty(ov, createTimeProperty('RECURRENCE-ID', nrid, extras));
    stamp(ov, now, true);
    rekeyed.set(recurrenceKeyOf(rid, ctx), recurrenceKeyOf(nrid, ctx));
  }
  return rekeyed;
}

// ============================================
// Ricerca dell'override
// ============================================

/** Data locale (nel fuso del calendario) di un valore, per l'abbinamento tollerante al tipo. */
function localDateKey(t: IcsTime, ctx: ZoneContext): string {
  if (t.type === 'date') return formatTimeValue(t);
  if (t.zone.kind === 'floating') return formatTimeValue(t).slice(0, 8);
  return localDateOf(timeToUtcMs(t, ctx), ctx.tz).replace(/-/g, '');
}

/**
 * Override indicato da una recurrence key, materializzato se manca (vedi
 * applyPatch). Con `create` false un'istanza senza override proprio è
 * RECURRENCE_TARGET_GONE: chi chiede di modificare "quell'override" non deve
 * crearne uno nuovo.
 */
function locateOverride(
  obj: CalendarObject,
  key: string,
  ctx: { tz: string; now: Date },
  create: boolean,
): { object: CalendarObject; target: IcsComponent } {
  const gone = (): RecurrenceTargetError =>
    new RecurrenceTargetError('RECURRENCE_TARGET_GONE', 'L\'occorrenza non fa più parte dell\'evento (modificata o eliminata altrove)', key);
  const zctx: ZoneContext = { tz: ctx.tz, timezones: obj.timezones };
  if (obj.master) {
    try {
      const mat = materializeOverride(obj, key, ctx);
      if (mat.created && !create) throw gone();
      return { object: mat.object, target: mat.object.overrides[mat.index] };
    } catch (err) {
      // Evento singolo con override orfani, o master non interpretabile: restano
      // modificabili gli override che esistono già.
      const fallback = (err instanceof RecurrenceTargetError && err.code === 'NOT_RECURRING') || err instanceof IcsValueError;
      if (!fallback) throw err;
      const idx = findOverrideIndex(obj, key, zctx);
      if (idx >= 0) return { object: obj, target: obj.overrides[idx] };
      throw err instanceof RecurrenceTargetError ? gone() : err;
    }
  }
  const idx = findOverrideIndex(obj, key, zctx);
  if (idx < 0) throw gone();
  return { object: obj, target: obj.overrides[idx] };
}

/** SEQUENCE di un componente (0 se assente o illeggibile), per scegliere fra override duplicati. */
function sequenceOf(c: IcsComponent): number {
  const v = getProperty(c, 'SEQUENCE')?.value.trim() ?? '';
  return /^[+-]?\d{1,9}$/.test(v) ? Number(v) : 0;
}

/** Fra più indici candidati, quello che expandObject mostra: SEQUENCE più alta, a parità l'ultimo nel file. */
function winnerOf(obj: CalendarObject, indices: number[]): number {
  let best = -1;
  for (const i of indices) {
    if (best < 0 || sequenceOf(obj.overrides[i]) >= sequenceOf(obj.overrides[best])) best = i;
  }
  return best;
}

/**
 * Ricerca diretta fra gli override esistenti (oggetti senza master ricorrente
 * leggibile): chiave esatta del RECURRENCE-ID (o del DTSTART se il
 * RECURRENCE-ID è illeggibile, come la espone expandObject), altrimenti, a
 * tipi diversi, la data locale nel fuso del calendario.
 */
function findOverrideIndex(obj: CalendarObject, key: string, ctx: ZoneContext): number {
  const exact: number[] = [];
  obj.overrides.forEach((ov, i) => {
    let k: string | null = null;
    try {
      k = componentRecurrenceKey(ov, ctx);
    } catch {
      const start = getProperty(ov, 'DTSTART');
      try {
        k = start ? recurrenceKeyOf(readTimeProperty(start), ctx) : null;
      } catch {
        k = null;
      }
    }
    if (k === key) exact.push(i);
  });
  if (exact.length > 0) return winnerOf(obj, exact);
  let parsed: ReturnType<typeof parseRecurrenceKey>;
  try {
    parsed = parseRecurrenceKey(key);
  } catch {
    return -1;
  }
  if (parsed.type === 'master' || parsed.type === 'conservative') return -1;
  const keyIsDate = parsed.type === 'date';
  const keyDate =
    parsed.type === 'date'
      ? parsed.date.replace(/-/g, '')
      : parsed.type === 'instant'
        ? localDateOf(parsed.utcMs, ctx.tz).replace(/-/g, '')
        : `${String(parsed.wall.year).padStart(4, '0')}${String(parsed.wall.month).padStart(2, '0')}${String(parsed.wall.day).padStart(2, '0')}`;
  const byDate: number[] = [];
  obj.overrides.forEach((ov, i) => {
    const p = getProperty(ov, 'RECURRENCE-ID');
    if (!p) return;
    try {
      const rid = readTimeProperty(p);
      // Solo per tipi diversi: a parità di tipo vale la chiave esatta.
      if ((rid.type === 'date') !== keyIsDate && localDateKey(rid, ctx) === keyDate) byDate.push(i);
    } catch {
      // RECURRENCE-ID illeggibile: considerato sopra con il DTSTART.
    }
  });
  return byDate.length > 0 ? winnerOf(obj, byDate) : -1;
}

// ============================================
// Traduzione dell'update v1
// ============================================

/** IANA del fuso di un DTSTART timed con TZID, se risolvibile; altrimenti null. */
function startIana(start: IcsTime, timezones: readonly IcsComponent[] | undefined): string | null {
  if (start.type !== 'date-time' || start.zone.kind !== 'tzid') return null;
  const res = resolveTzid(start.zone.tzid, timezones);
  return res.kind === 'iana' ? ianaName(res.iana) : null;
}

/** Valori candidati dei campi temporali per un update v1 (start, end, rrule, exdates secondo i campi presenti). */
function legacyTimeCandidates(component: IcsComponent, input: LegacyEventUpdate, ctx: ZoneContext, now: Date): Partial<PatchFieldValues> {
  const current = toLegacyEventFields(component, { tz: ctx.tz, timezones: ctx.timezones });
  const currentStart = readTimeProperty(getProperty(component, 'DTSTART') as IcsProperty);
  const allDay = input.all_day ?? current.all_day;
  const merged: LegacyEventInput = {
    uid: current.uid,
    summary: current.summary,
    start_time: input.start_time ?? current.start_time,
    end_time: input.end_time ?? current.end_time,
    all_day: allDay,
    rrule: input.rrule !== undefined ? input.rrule || null : current.rrule,
    exdates: input.exdates !== undefined ? input.exdates : current.exdates,
    status: current.status,
  };
  const seriesTz = startIana(currentStart, ctx.timezones) ?? ctx.tz;
  const fresh = buildEventFromLegacy(merged, { tz: ctx.tz, seriesTz, now });
  const freshValues = readFieldValues(fresh, ['start', 'end', 'rrule', 'exdates']);

  // Zona dei timed: quella del DTSTART corrente se era timed, altrimenti quella scelta da buildEventFromLegacy.
  const like: IcsTime | null = !allDay && currentStart.type === 'date-time' ? currentStart : null;
  const inZone = (t: IcsTime): IcsTime => (like && t.type === 'date-time' ? utcMsToTime(timeToUtcMs(t, ctx), like, ctx) : t);

  const out: Partial<PatchFieldValues> = {};
  const newStart = freshValues.start ? inZone(freshValues.start) : undefined;
  if (input.start_time !== undefined || input.end_time !== undefined || input.all_day !== undefined) {
    if (newStart) out.start = newStart;
    if (freshValues.end) out.end = inZone(freshValues.end);
  }
  if (input.rrule !== undefined) {
    const rrule = freshValues.rrule ?? null;
    out.rrule = rrule && newStart ? alignUntil(rrule, newStart, ctx) : rrule;
  }
  if (input.exdates !== undefined) out.exdates = (freshValues.exdates ?? []).map(inZone);
  return out;
}

/** UNTIL coerente con la classe del DTSTART (DATE, floating, UTC) per una RRULE già normalizzata. */
function alignUntil(rrule: string, start: IcsTime, ctx: ZoneContext): string {
  const cls = timeClass(start);
  const rewritten = rewriteUntil(rrule, (until) => {
    if (cls === 'date' && until.type === 'date') return until;
    if (cls === 'floating' && until.type === 'date-time' && until.zone.kind === 'floating') return until;
    if (cls === 'zoned' && until.type === 'date-time' && until.zone.kind === 'utc') return until;
    return retypeUntil(until, start, start, ctx);
  });
  return rewritten ?? rrule;
}

/**
 * Un evento con DURATION e senza DTEND: l'op `end` calcolata dalla stessa
 * fine (istante uguale, tipo invariato) non è una modifica e non deve
 * trasformare DURATION in DTEND.
 */
function skipEquivalentEnd(component: IcsComponent, ops: PatchOp[], ctx: ZoneContext): PatchOp[] {
  const endOp = ops.find((o) => o.op === 'set' && o.field === 'end') as { op: 'set'; field: 'end'; value: IcsTime | null } | undefined;
  if (!endOp || endOp.value == null) return ops;
  if (getProperty(component, endPropertyName(component)) || !getProperty(component, 'DURATION')) return ops;
  if (ops.some((o) => o.op === 'set' && o.field === 'start')) return ops;
  try {
    const current = toLegacyEventFields(component, { tz: ctx.tz, timezones: ctx.timezones });
    const start = readTimeProperty(getProperty(component, 'DTSTART') as IcsProperty);
    if (endOp.value.type === start.type && timeToUtcMs(endOp.value, ctx) === Date.parse(current.end_time)) return ops.filter((o) => o !== endOp);
  } catch {
    // In caso di dubbio l'op resta.
  }
  return ops;
}
