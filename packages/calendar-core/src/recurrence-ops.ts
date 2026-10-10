/**
 * Operazioni sulle ricorrenze, tutte lato server (design §8, "Ricorrenze").
 *
 * Regole comuni:
 * - le funzioni non modificano l'oggetto in ingresso: restituiscono una copia
 *   (model.cloneCalendarObject) con le modifiche;
 * - i target sono recurrence key canoniche (model.recurrenceKeyOf, calcolate
 *   sul tipo del DTSTART del master), le stesse delle occorrenze di
 *   expandObject; un target che non appartiene più all'insieme corrente delle
 *   istanze dell'oggetto (né occorrenza del master né override esistente) →
 *   RecurrenceTargetError('RECURRENCE_TARGET_GONE'), che l'API traduce in 409
 *   CALENDAR_CONFLICT: niente nuovi orfani;
 * - RECURRENCE-ID ed EXDATE si scrivono sempre dello stesso tipo e con lo
 *   stesso TZID del DTSTART del master (model.recurrenceKeyToTime);
 * - DTSTAMP e LAST-MODIFIED dei componenti toccati vanno a `ctx.now`;
 *   SEQUENCE+1 quando cambiano orari o ricorrenza (EXDATE e RDATE compresi,
 *   RFC 5546), come patch.ts;
 * - VALARM, ATTENDEE, X-* e parametri sconosciuti restano dove sono: le
 *   proprietà toccate si riscrivono al loro posto, le altre non si toccano.
 *
 * Semantica rispetto al codice di oggi (apps/api/src/lib/calendar/events.ts e
 * calendario.tsx dell'admin):
 * - "solo questa" = createOccurrenceOverride (override con RECURRENCE-ID,
 *   upsert: un'occorrenza ha al massimo un override);
 * - "elimina questa" = oggi un override STATUS:CANCELLED; qui EXDATE più la
 *   rimozione dell'override (design §8): stesso effetto su admin, feed e busy
 *   (il feed legacy già traduce gli override cancellati in EXDATE);
 * - "questa e le successive" = oggi UNTIL sulla vecchia serie e una nuova serie
 *   senza COUNT, non atomico; qui la saga del design con COUNT residuo,
 *   override ed EXDATE spostati nella nuova serie;
 * - "tutta la serie" = oggi spostamento del master di Δ (gli override restavano
 *   agganciati al vecchio orario e diventavano orfani); qui lo stesso Δ si
 *   applica anche a RECURRENCE-ID, EXDATE, RDATE e UNTIL (design §14).
 */

import { localDateOf } from './allday';
import { CalendarCoreError, IcsValueError } from './errors';
import {
  type CalendarObject,
  cloneCalendarObject,
  cloneComponent,
  createCalendarObject,
  createProperty,
  createTimeListProperties,
  createTimeProperty,
  encodeText,
  formatDurationValue,
  formatTimeValue,
  getProperties,
  getProperty,
  type IcsComponent,
  type IcsDuration,
  type IcsParam,
  type IcsPeriod,
  type IcsProperty,
  type IcsTime,
  isRecurrenceKey,
  MASTER_RECURRENCE_KEY,
  CONSERVATIVE_RECURRENCE_KEY,
  parseDurationValue,
  parseTimeValue,
  readTimeListProperty,
  readTimeProperty,
  recurrenceKeyOf,
  recurrenceKeyToTime,
  removeProperties,
  setProperties,
  setProperty,
  timeParams,
  timeToUtcMs,
  utcMsToTime,
  X_CALDES,
  type ZoneContext,
} from './model';
import { matchZoneContext, OverrideResolver, type OverrideSet, readOverrides } from './override-match';
import {
  civilFromDays,
  DAY_MS,
  daysFromCivil,
  DEFAULT_ITERATION_BUDGET,
  ExpansionBudget,
  ExpansionBudgetError,
  formatUntil,
  type MasterSpec,
  parseRecurRule,
  readMasterSpec,
  RecurRuleError,
  scanMarginMs,
  Series,
  type SeriesInstance,
  setRrulePart,
  typedLikeStart,
  wallOfTime,
} from './recur';
import { ianaZone, msToWall, zonedToUtc } from './tz-registry';

export type RecurrenceTargetErrorCode =
  /** Il target non è (più) un'istanza dell'oggetto: 409 CALENDAR_CONFLICT. */
  | 'RECURRENCE_TARGET_GONE'
  /** Operazione da serie su un oggetto senza RRULE né RDATE. */
  | 'NOT_RECURRING'
  /** Recurrence key malformata, o MASTER_RECURRENCE_KEY dove serve un'occorrenza. */
  | 'INVALID_TARGET'
  /** Oggetto senza master (soli override): le operazioni di serie non sono possibili. */
  | 'NO_MASTER';

export class RecurrenceTargetError extends CalendarCoreError {
  declare readonly code: RecurrenceTargetErrorCode;
  readonly recurrenceKey: string | null;

  constructor(code: RecurrenceTargetErrorCode, message: string, recurrenceKey: string | null = null) {
    super(code, message, { recurrenceKey });
    this.recurrenceKey = recurrenceKey;
  }
}

export interface RecurrenceOpContext {
  /** Fuso IANA del calendario. */
  tz: string;
  /** DTSTAMP/LAST-MODIFIED dei componenti toccati. */
  now: Date;
  /** Iterazioni massime per verificare l'appartenenza dei target (default EXPANSION_ITERATION_BUDGET). */
  iterationBudget?: number;
}

// ============================================
// Utilità sull'albero
// ============================================

function utcStamp(d: Date): string {
  return formatTimeValue({ type: 'date-time', ...msToWall(Math.floor(d.getTime() / 1000) * 1000), zone: { kind: 'utc' } });
}

/** DTSTAMP e LAST-MODIFIED a `now` (al loro posto se c'erano). */
function touch(c: IcsComponent, now: Date): void {
  const v = utcStamp(now);
  setProperty(c, { name: 'DTSTAMP', params: [], value: v });
  setProperty(c, { name: 'LAST-MODIFIED', params: [], value: v });
}

function readSequence(c: IcsComponent): number {
  const v = getProperty(c, 'SEQUENCE')?.value.trim() ?? '';
  return /^[+-]?\d{1,9}$/.test(v) ? Math.max(0, Number(v)) : 0;
}

function bumpSequence(c: IcsComponent): void {
  setProperty(c, { name: 'SEQUENCE', params: [], value: String(readSequence(c) + 1) });
}

/** Modifica "significativa" (orari o ricorrenza): SEQUENCE+1 più DTSTAMP e LAST-MODIFIED. */
function significant(c: IcsComponent, now: Date): void {
  bumpSequence(c);
  touch(c, now);
}

/** Parametri di una proprietà temporale con VALUE e TZID presi da `t` e gli altri conservati. */
function timeParamsKeeping(old: IcsProperty | null, t: IcsTime): IcsParam[] {
  const rest = (old?.params ?? []).filter((p) => p.name !== 'VALUE' && p.name !== 'TZID').map((p) => ({ name: p.name, values: [...p.values] }));
  return [...timeParams(t), ...rest];
}

/** Imposta una proprietà temporale (DTSTART, DTEND, RECURRENCE-ID) al suo posto, conservando i parametri estranei. */
function setTimeProperty(c: IcsComponent, name: string, t: IcsTime): void {
  const old = getProperty(c, name);
  setProperty(c, { name, params: timeParamsKeeping(old, t), value: formatTimeValue(t) });
}

/** Inserisce una proprietà subito dopo la prima con nome `after` (in coda se manca). */
function insertAfter(c: IcsComponent, after: string, prop: IcsProperty): void {
  const idx = c.properties.findIndex((p) => p.name === after);
  if (idx < 0) c.properties.push(prop);
  else c.properties.splice(idx + 1, 0, prop);
}

/** Firma VALUE/TZID dei soli parametri temporali (le proprietà con altri parametri non si fondono). */
function onlyTimeParams(p: IcsProperty): boolean {
  return p.params.every((x) => x.name === 'VALUE' || x.name === 'TZID');
}

function sameTimeParams(p: IcsProperty, t: IcsTime): boolean {
  const want = timeParams(t);
  const value = (p.params.find((x) => x.name === 'VALUE')?.values[0] ?? '').toUpperCase();
  const tzid = p.params.find((x) => x.name === 'TZID')?.values[0] ?? null;
  const wantValue = want.find((x) => x.name === 'VALUE')?.values[0] ?? '';
  const wantTzid = want.find((x) => x.name === 'TZID')?.values[0] ?? null;
  if (value === 'PERIOD') return false;
  return (value === wantValue || (value === 'DATE-TIME' && wantValue === '')) && tzid === wantTzid;
}

/** Aggiunge un valore a una lista temporale (EXDATE, RDATE): nella proprietà con la stessa firma, o in una nuova dopo l'ultima con quel nome. */
function appendTimeListValue(c: IcsComponent, name: string, t: IcsTime): void {
  const value = formatTimeValue(t);
  const props = getProperties(c, name);
  for (const p of props) {
    if (!onlyTimeParams(p) || !sameTimeParams(p, t)) continue;
    const parts = p.value.split(',').map((s) => s.trim());
    if (!parts.includes(value)) p.value = [...parts.filter(Boolean), value].join(',');
    return;
  }
  const prop = createTimeProperty(name, t);
  const lastIdx = c.properties.map((p) => p.name).lastIndexOf(name);
  if (lastIdx >= 0) c.properties.splice(lastIdx + 1, 0, prop);
  else insertAfter(c, getProperty(c, 'RRULE') ? 'RRULE' : 'DTSTART', prop);
}

/**
 * Toglie da una lista temporale (EXDATE, RDATE) i valori per cui `drop`
 * restituisce true, riscrivendo il solo valore della proprietà (parametri e
 * altri valori restano); le proprietà svuotate spariscono. Restituisce quanti
 * valori ha tolto. I valori illeggibili restano.
 */
function removeTimeListValues(c: IcsComponent, name: string, drop: (v: IcsTime | IcsPeriod) => boolean): number {
  let removed = 0;
  const upper = name.toUpperCase();
  const keep: IcsProperty[] = [];
  for (const p of c.properties) {
    if (p.name !== upper) {
      keep.push(p);
      continue;
    }
    const type = (p.params.find((x) => x.name === 'VALUE')?.values[0] ?? '').toUpperCase();
    const tzid = p.params.find((x) => x.name === 'TZID')?.values[0] ?? null;
    const parts = p.value.split(',');
    const rest: string[] = [];
    for (const raw of parts) {
      const v = raw.trim();
      if (!v) continue;
      let parsed: IcsTime | IcsPeriod | null = null;
      try {
        parsed = type === 'PERIOD' ? (readTimeListProperty({ name: upper, params: p.params, value: v })[0] ?? null) : parseTimeValue(v, { value: type || null, tzid }, upper);
      } catch {
        parsed = null;
      }
      if (parsed && drop(parsed)) removed++;
      else rest.push(raw);
    }
    if (rest.length > 0) keep.push(rest.length === parts.length ? p : { ...p, value: rest.join(',') });
  }
  c.properties = keep;
  return removed;
}

/** Valori leggibili di una lista temporale (gli illeggibili si ignorano). */
function readTimeList(c: IcsComponent, name: string): Array<IcsTime | IcsPeriod> {
  const out: Array<IcsTime | IcsPeriod> = [];
  for (const p of getProperties(c, name)) {
    try {
      out.push(...readTimeListProperty(p));
    } catch {
      /* valore illeggibile: ignorato */
    }
  }
  return out;
}

// ============================================
// Analisi dell'oggetto (serie, override, appartenenza)
// ============================================

interface Analysis {
  zctx: ZoneContext;
  spec: MasterSpec;
  series: Series;
  set: OverrideSet;
  resolver: OverrideResolver;
  extraShadowed: Set<number>;
  margin: number;
}

function zoneContext(obj: CalendarObject, ctx: RecurrenceOpContext): ZoneContext {
  return matchZoneContext({ tz: ctx.tz, timezones: obj.timezones });
}

function budgetOf(ctx: RecurrenceOpContext): ExpansionBudget {
  return new ExpansionBudget(Math.max(1, Math.floor(ctx.iterationBudget ?? DEFAULT_ITERATION_BUDGET)));
}

function checkTarget(key: string, allowMaster: boolean): void {
  if (typeof key !== 'string' || key === CONSERVATIVE_RECURRENCE_KEY || !isRecurrenceKey(key) || (!allowMaster && key === MASTER_RECURRENCE_KEY)) {
    throw new RecurrenceTargetError('INVALID_TARGET', `Recurrence key non valida per questa operazione: "${String(key).slice(0, 30)}"`, typeof key === 'string' ? key : null);
  }
}

function analyze(obj: CalendarObject, ctx: RecurrenceOpContext): Analysis {
  if (!obj.master) throw new RecurrenceTargetError('NO_MASTER', 'Oggetto senza evento principale (solo occorrenze modificate): operazione non possibile');
  const zctx = zoneContext(obj, ctx);
  const read = readMasterSpec(obj.master, zctx);
  if (read.ok === 'no-start') throw new IcsValueError('MISSING_PROPERTY', 'Componente senza DTSTART: operazione non possibile', { property: 'DTSTART' });
  if (read.ok === false) throw new IcsValueError('INVALID_VALUE', `Evento principale non interpretabile (${read.reason}): ${read.message}`);
  const spec = read.spec;
  const series = new Series(spec, zctx, budgetOf(ctx));
  const set = readOverrides(obj, spec.allDay ? 'date' : 'date-time', zctx);
  const resolver = new OverrideResolver(set, series, zctx);
  try {
    resolver.resolvePending();
  } catch (err) {
    if (!(err instanceof ExpansionBudgetError) && !(err instanceof RecurRuleError)) throw err;
  }
  return { zctx, spec, series, set, resolver, extraShadowed: new Set(resolver.extraShadowed), margin: scanMarginMs(spec) };
}

function isRecurringSpec(spec: MasterSpec): boolean {
  return Boolean(spec.rule) || spec.rdates.length > 0;
}

/** Valore temporale (tipo e zona del DTSTART) di una recurrence key. */
function targetTime(an: Analysis, key: string): IcsTime {
  try {
    return recurrenceKeyToTime(key, an.spec.dtstart, an.zctx);
  } catch {
    throw new RecurrenceTargetError('INVALID_TARGET', `Recurrence key non valida: "${key.slice(0, 30)}"`, key);
  }
}

interface InstanceLookup {
  instance: SeriesInstance | null;
  /** Appartenenza non decisa per budget esaurito. */
  undetermined: boolean;
}

/** Istanza del master (DTSTART ∪ RRULE ∪ RDATE, EXDATE ignorate) che corrisponde alla chiave. */
function instanceForKey(an: Analysis, key: string): InstanceLookup {
  const t = targetTime(an, key);
  const wall = wallOfTime(t);
  const series = an.series;
  const id = series.spec.allDay ? Series.wallDate(wall) : Math.floor(series.utcOf(wall) / 1000);
  try {
    const seek = series.canSeek ? wall - an.margin : null;
    for (const inst of series.instances(seek, wall + an.margin)) {
      if (series.idOf(inst) === id) return { instance: inst, undetermined: false };
    }
    return { instance: null, undetermined: false };
  } catch (err) {
    if (err instanceof ExpansionBudgetError || err instanceof RecurRuleError) return { instance: null, undetermined: true };
    throw err;
  }
}

/** Chiave dell'occorrenza che expandObject assegna a un override (vincitore) o null. */
function overrideOccurrenceKey(an: Analysis, i: number): string | null {
  const info = an.set.infos[i];
  const r = an.resolver.resolution(i);
  try {
    if (r.status === 'matched') return an.series.keyOf(r.instance);
    if (!info.rid) return null;
    if (r.status === 'orphan') return recurrenceKeyOf(info.rid, an.zctx);
    return recurrenceKeyOf(typedLikeStart(info.rid, an.spec.dtstart, an.zctx), an.zctx);
  } catch {
    return null;
  }
}

function componentKey(c: IcsComponent, zctx: ZoneContext): string | null {
  try {
    const p = getProperty(c, 'RECURRENCE-ID');
    if (p) return recurrenceKeyOf(readTimeProperty(p), zctx);
    const s = getProperty(c, 'DTSTART');
    return s ? recurrenceKeyOf(readTimeProperty(s), zctx) : null;
  } catch {
    return null;
  }
}

/** Override (vincitore) che corrisponde alla chiave: stessa chiave di expandObject, o chiave grezza del suo RECURRENCE-ID. */
function overrideForKey(an: Analysis, key: string): number | undefined {
  for (const i of an.set.winners) {
    if (an.extraShadowed.has(i)) continue;
    if (overrideOccurrenceKey(an, i) === key) return i;
  }
  for (const i of an.set.winners) {
    if (an.extraShadowed.has(i)) continue;
    if (componentKey(an.set.infos[i].component, an.zctx) === key) return i;
  }
  // RECURRENCE-ID illeggibile: expandObject li espone con la chiave del proprio DTSTART.
  for (const i of an.set.invalid) {
    if (componentKey(an.set.infos[i].component, an.zctx) === key) return i;
  }
  return undefined;
}

/** Inizio (ms UTC e ora da muro della serie) dell'occorrenza originale di un override. */
function overrideOriginalStart(an: Analysis, i: number): { utc: number; wall: number } | null {
  const r = an.resolver.resolution(i);
  if (r.status === 'matched') return { utc: r.instance.utcMs, wall: r.instance.wallMs };
  const info = an.set.infos[i];
  if (!info.rid || info.ridUtc == null) return null;
  try {
    const t = typedLikeStart(info.rid, an.spec.dtstart, an.zctx);
    const wall = wallOfTime(t);
    return { utc: an.series.utcOf(wall), wall };
  } catch {
    return { utc: info.ridUtc, wall: an.series.wallOf(info.ridUtc) };
  }
}

function removeOverride(obj: CalendarObject, index: number): void {
  obj.overrides.splice(index, 1);
}

function gone(key: string): RecurrenceTargetError {
  return new RecurrenceTargetError('RECURRENCE_TARGET_GONE', 'L\'occorrenza non fa più parte della serie (modificata o eliminata altrove)', key);
}

/** Fine (valore tipizzato come DTEND del master) dell'istanza: stessa durata del master. */
function instanceEnd(an: Analysis, inst: SeriesInstance, dtend: IcsTime): IcsTime {
  const series = an.series;
  if (series.spec.allDay) {
    const endDate = series.endDateOf(inst);
    const [y, m, d] = endDate.split('-').map(Number);
    if (dtend.type === 'date') return { type: 'date', year: y, month: m, day: d };
    return utcMsToTime(series.utcOf(daysFromCivil(y, m, d) * DAY_MS), dtend, an.zctx);
  }
  return utcMsToTime(series.endUtcOf({ ...inst, rdate: -1 }), dtend, an.zctx);
}

/** Copia del master spostata all'istanza: DTSTART all'istanza, DTEND con la stessa durata, senza RRULE/RDATE/EXDATE. */
function masterCopyAt(an: Analysis, master: IcsComponent, inst: SeriesInstance): IcsComponent {
  const c = cloneComponent(master);
  for (const name of ['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'RECURRENCE-ID', X_CALDES.LEGACY_ID]) removeProperties(c, name);
  const t = an.series.timeOf(inst.wallMs);
  setTimeProperty(c, 'DTSTART', t);
  const endName = master.name === 'VTODO' ? 'DUE' : 'DTEND';
  const endProp = getProperty(master, endName);
  if (endProp) {
    try {
      setTimeProperty(c, endName, instanceEnd(an, inst, readTimeProperty(endProp)));
    } catch {
      /* DTEND illeggibile: resta com'è (readMasterSpec l'avrebbe già rifiutato) */
    }
  }
  return c;
}

// ============================================
// Operazioni
// ============================================

/**
 * True se `recurrenceKey` è un'istanza corrente dell'oggetto: occorrenza del
 * master (DTSTART ∪ RRULE ∪ RDATE − EXDATE) oppure override esistente.
 * MASTER_RECURRENCE_KEY vale true se c'è un master. Con l'appartenenza non
 * decidibile per budget esaurito restituisce true (scelta prudente: niente
 * 409 spuri). Lancia RecurrenceTargetError('INVALID_TARGET') per una chiave
 * malformata.
 */
export function occurrenceExists(obj: CalendarObject, recurrenceKey: string, ctx: RecurrenceOpContext): boolean {
  checkTarget(recurrenceKey, true);
  if (recurrenceKey === MASTER_RECURRENCE_KEY) return obj.master != null;
  if (!obj.master) {
    const zctx = zoneContext(obj, ctx);
    return obj.overrides.some((c) => componentKey(c, zctx) === recurrenceKey);
  }
  const an = analyze(obj, ctx);
  if (overrideForKey(an, recurrenceKey) !== undefined) return true;
  const look = instanceForKey(an, recurrenceKey);
  if (look.undetermined) return true;
  return look.instance != null && !an.series.isExcluded(look.instance);
}

export interface MaterializeResult {
  object: CalendarObject;
  /** Indice dell'override in object.overrides. */
  index: number;
  /** False se l'override esisteva già (nessuna modifica). */
  created: boolean;
}

/**
 * "Solo questa", primo passo: restituisce l'override dell'istanza,
 * creandolo se manca come copia del master all'istanza (stesse proprietà,
 * VALARM e X-* compresi, senza RRULE, RDATE ed EXDATE e senza
 * X-CALDES-LEGACY-ID, che identifica la riga legacy del master; DTSTART
 * all'istanza, DTEND/DURATION con la stessa durata; RECURRENCE-ID dello
 * stesso tipo e TZID del DTSTART del master). La modifica dei campi la
 * applica poi patch.ts sull'override restituito.
 */
export function materializeOverride(obj: CalendarObject, recurrenceKey: string, ctx: RecurrenceOpContext): MaterializeResult {
  checkTarget(recurrenceKey, false);
  const an = analyze(obj, ctx);
  if (!isRecurringSpec(an.spec)) throw new RecurrenceTargetError('NOT_RECURRING', 'L\'evento non è ricorrente', recurrenceKey);
  const existing = overrideForKey(an, recurrenceKey);
  if (existing !== undefined) return { object: cloneCalendarObject(obj), index: existing, created: false };
  const look = instanceForKey(an, recurrenceKey);
  let inst = look.instance;
  if (!inst) {
    if (!look.undetermined) throw gone(recurrenceKey);
    const t = targetTime(an, recurrenceKey);
    const wall = wallOfTime(t);
    inst = { wallMs: wall, utcMs: an.series.utcOf(wall), rdate: -1 };
  } else if (an.series.isExcluded(inst)) {
    throw gone(recurrenceKey);
  }
  const out = cloneCalendarObject(obj);
  const master = out.master as IcsComponent;
  const c = masterCopyAt(an, master, inst);
  const rid = createTimeProperty('RECURRENCE-ID', an.series.timeOf(inst.wallMs));
  insertAfter(c, 'DTSTART', rid);
  touch(c, ctx.now);
  out.overrides.push(c);
  return { object: out, index: out.overrides.length - 1, created: true };
}

/**
 * "Elimina questa": EXDATE tipizzato come il DTSTART più rimozione
 * dell'eventuale override. Un'istanza solo RDATE viene tolta dalla RDATE; un
 * override orfano (fuori dalla regola) viene solo rimosso.
 */
export function excludeOccurrence(obj: CalendarObject, recurrenceKey: string, ctx: RecurrenceOpContext): CalendarObject {
  checkTarget(recurrenceKey, false);
  if (!obj.master) {
    const zctx = zoneContext(obj, ctx);
    const idx = obj.overrides.findIndex((c) => componentKey(c, zctx) === recurrenceKey);
    if (idx < 0) throw new RecurrenceTargetError('NO_MASTER', 'Oggetto senza evento principale: occorrenza non trovata', recurrenceKey);
    const out = cloneCalendarObject(obj);
    removeOverride(out, idx);
    return out;
  }
  const an = analyze(obj, ctx);
  const ov = overrideForKey(an, recurrenceKey);
  const look = instanceForKey(an, recurrenceKey);
  const out = cloneCalendarObject(obj);
  const master = out.master as IcsComponent;
  if (!look.instance && !look.undetermined) {
    if (ov === undefined) throw gone(recurrenceKey);
    removeOverride(out, ov);
    return out;
  }
  const inst = look.instance;
  const excluded = inst ? an.series.isExcluded(inst) : false;
  if (excluded && ov === undefined) throw gone(recurrenceKey);
  if (ov !== undefined) removeOverride(out, ov);
  if (excluded) return out;
  if (inst && inst.rdate >= 0) {
    // Istanza solo RDATE: si toglie dalla RDATE (un'EXDATE la escluderebbe comunque, ma lascerebbe la RDATE morta).
    const wall = inst.wallMs;
    removeTimeListValues(master, 'RDATE', (v) => {
      try {
        const start = v.type === 'period' ? v.start : v;
        return wallOfTime(typedLikeStart(start, an.spec.dtstart, an.zctx)) === wall;
      } catch {
        return false;
      }
    });
  } else {
    const t = inst ? an.series.timeOf(inst.wallMs) : targetTime(an, recurrenceKey);
    appendTimeListValue(master, 'EXDATE', t);
  }
  significant(master, ctx.now);
  return out;
}

/**
 * "Ripristina occorrenza" (admin v2): toglie l'EXDATE corrispondente (match
 * tollerante al tipo). Nessun effetto se l'istanza non è esclusa; target fuori
 * dalla regola → RECURRENCE_TARGET_GONE.
 */
export function restoreOccurrence(obj: CalendarObject, recurrenceKey: string, ctx: RecurrenceOpContext): CalendarObject {
  checkTarget(recurrenceKey, false);
  const an = analyze(obj, ctx);
  const look = instanceForKey(an, recurrenceKey);
  if (!look.instance) {
    if (look.undetermined) return cloneCalendarObject(obj);
    throw gone(recurrenceKey);
  }
  const inst = look.instance;
  const out = cloneCalendarObject(obj);
  if (!an.series.isExcluded(inst)) return out;
  const master = out.master as IcsComponent;
  const allDay = an.spec.allDay;
  const instDate = allDay ? Series.wallDate(inst.wallMs) : localDateOf(inst.utcMs, an.zctx.tz);
  const instSec = Math.floor(inst.utcMs / 1000);
  const removed = removeTimeListValues(master, 'EXDATE', (v) => {
    if (v.type === 'period') return false;
    try {
      if (allDay || v.type === 'date') {
        const d = v.type === 'date' || v.zone.kind === 'floating'
          ? `${String(v.year).padStart(4, '0')}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`
          : localDateOf(timeToUtcMs(v, an.zctx), an.zctx.tz);
        return d === instDate;
      }
      return Math.floor(timeToUtcMs(v, an.zctx) / 1000) === instSec;
    } catch {
      return false;
    }
  });
  if (removed > 0) significant(master, ctx.now);
  return out;
}

export interface ShiftSeriesResult {
  object: CalendarObject;
  /** Vecchia recurrence key → nuova, per ri-chiavare cal_object_ids degli override. */
  rekeyed: Map<string, string>;
}

/** Valore spostato di `deltaMs` in ora da muro, riportato al tipo e alla zona di `like` (il nuovo DTSTART). */
function shifted(an: Analysis, v: IcsTime, deltaMs: number, like: IcsTime): IcsTime {
  const typed = typedLikeStart(v, an.spec.dtstart, an.zctx);
  const w = msToWall(wallOfTime(typed) + deltaMs);
  if (like.type === 'date') return { type: 'date', year: w.year, month: w.month, day: w.day };
  return { type: 'date-time', ...w, zone: like.zone };
}

/** UNTIL per una regola riscritta: DATE per un master DATE, UTC per un DATE-TIME con zona, floating per un floating. */
function untilFor(t: IcsTime, zctx: ZoneContext): string {
  if (t.type === 'date' || t.zone.kind !== 'tzid') return formatUntil(t);
  const ms = timeToUtcMs(t, zctx);
  return formatUntil({ type: 'date-time', ...msToWall(Math.floor(ms / 1000) * 1000), zone: { kind: 'utc' } });
}

/**
 * "Tutta la serie", spostamento: porta il DTSTART del master a `newStart`
 * (DTEND con la stessa durata) e applica lo stesso Δ, in ora da muro del fuso
 * del DTSTART (giorni nominali più parte oraria), a RECURRENCE-ID degli
 * override, EXDATE, RDATE e UNTIL (così il numero di istanze non cambia;
 * l'UNTIL DATE si sposta degli stessi giorni). Gli orari propri degli
 * override non vengono toccati. `newStart` di tipo diverso (timed ↔ all-day)
 * converte anche RECURRENCE-ID, EXDATE, RDATE e UNTIL al nuovo tipo; la
 * durata diventa di giorni interi (almeno uno) o di 24 ore per giorno.
 */
export function shiftSeries(obj: CalendarObject, newStart: IcsTime, ctx: RecurrenceOpContext): ShiftSeriesResult {
  const an = analyze(obj, ctx);
  const spec = an.spec;
  const zctx = an.zctx;
  const old = spec.dtstart;
  const out = cloneCalendarObject(obj);
  const master = out.master as IcsComponent;
  const rekeyed = new Map<string, string>();
  const deltaMs = wallOfTime(newStart) - wallOfTime(old);
  const typeChange = old.type !== newStart.type;
  const zoneChange = !typeChange && old.type === 'date-time' && newStart.type === 'date-time' && JSON.stringify(old.zone) !== JSON.stringify(newStart.zone);
  if (deltaMs === 0 && !typeChange && !zoneChange) return { object: out, rekeyed };
  let newStartUtc: number;
  try {
    newStartUtc = timeToUtcMs(newStart, zctx);
  } catch (err) {
    throw err instanceof CalendarCoreError ? err : new IcsValueError('INVALID_VALUE', 'Nuovo inizio non convertibile', { property: 'DTSTART' });
  }

  // DTSTART e fine.
  setTimeProperty(master, 'DTSTART', newStart);
  const endName = master.name === 'VTODO' ? 'DUE' : 'DTEND';
  const endProp = getProperty(master, endName);
  const d = spec.duration;
  if (endProp) {
    const oldEnd = readTimeProperty(endProp);
    let newEnd: IcsTime;
    if (newStart.type === 'date') {
      const days = d.kind === 'days' ? d.days : Math.max(1, Math.ceil((d.kind === 'exact' ? d.ms : d.days * DAY_MS + d.ms) / DAY_MS));
      const civ = civilFromDays(daysFromCivil(newStart.year, newStart.month, newStart.day) + days);
      newEnd = { type: 'date', ...civ };
    } else if (old.type === 'date') {
      const days = d.kind === 'days' ? d.days : 1;
      const w = msToWall(wallOfTime(newStart) + days * DAY_MS);
      newEnd = { type: 'date-time', ...w, zone: newStart.zone };
    } else {
      const sameZone = oldEnd.type === 'date-time' && JSON.stringify(oldEnd.zone) === JSON.stringify(old.zone);
      const endUtc = d.kind === 'exact' ? newStartUtc + d.ms : d.kind === 'nominal' ? newStartUtc + d.days * DAY_MS + d.ms : newStartUtc + d.days * DAY_MS;
      newEnd = utcMsToTime(endUtc, sameZone ? newStart : oldEnd, zctx);
    }
    setTimeProperty(master, endName, newEnd);
  } else if (typeChange) {
    const durProp = getProperty(master, 'DURATION');
    if (durProp && newStart.type === 'date') {
      let dur: IcsDuration | null = null;
      try {
        dur = parseDurationValue(durProp.value, 'DURATION');
      } catch {
        dur = null;
      }
      const secs = dur ? (dur.weeks * 7 + dur.days) * 86400 + dur.hours * 3600 + dur.minutes * 60 + dur.seconds : 86400;
      const days = Math.max(1, Math.ceil(secs / 86400));
      setProperty(master, { name: 'DURATION', params: durProp.params, value: formatDurationValue({ negative: false, weeks: 0, days, hours: 0, minutes: 0, seconds: 0 }) });
    }
  }

  // EXDATE e RDATE: riscritte nel tipo del nuovo DTSTART.
  for (const name of ['EXDATE', 'RDATE']) {
    const values = readTimeList(master, name);
    if (values.length === 0) continue;
    const moved: Array<IcsTime | IcsPeriod> = [];
    for (const v of values) {
      if (v.type === 'period') {
        const start = shifted(an, v.start, deltaMs, newStart);
        if (start.type === 'date') moved.push(start);
        else moved.push({ type: 'period', start, end: null, duration: v.duration ?? durationBetween(v, zctx) });
      } else {
        moved.push(shifted(an, v, deltaMs, newStart));
      }
    }
    setProperties(master, name, createTimeListProperties(name, moved));
  }

  // UNTIL: stesso Δ, scritto nel tipo del nuovo DTSTART (DATE, UTC o floating).
  if (spec.rule?.until) {
    const u = spec.rule.until;
    let base: IcsTime;
    if (u.type === 'date' && old.type === 'date-time') {
      // UNTIL DATE su un master DATE-TIME: tutta la giornata, cioè fino al suo ultimo secondo.
      base = { type: 'date-time', year: u.year, month: u.month, day: u.day, hour: 23, minute: 59, second: 59, zone: old.zone };
    } else if (u.type === 'date-time' && u.zone.kind === 'floating' && old.type === 'date-time') {
      base = { ...u, zone: old.zone };
    } else {
      base = u;
    }
    const rr = getProperty(master, 'RRULE');
    if (rr) rr.value = setRrulePart(rr.value, 'UNTIL', untilFor(shifted(an, base, deltaMs, newStart), zctx));
  }
  significant(master, ctx.now);

  // Override: RECURRENCE-ID spostati, orari propri invariati.
  out.overrides.forEach((ov, index) => {
    const info = an.set.infos[index];
    if (!info.rid) return;
    const oldKey = componentKey(obj.overrides[index], zctx);
    const newRid = shifted(an, info.rid, deltaMs, newStart);
    setTimeProperty(ov, 'RECURRENCE-ID', newRid);
    significant(ov, ctx.now);
    const newKey = recurrenceKeyOf(newRid, zctx);
    if (oldKey != null && oldKey !== newKey) rekeyed.set(oldKey, newKey);
  });
  return { object: out, rekeyed };
}

function durationBetween(p: IcsPeriod, zctx: ZoneContext): IcsDuration {
  if (p.duration) return p.duration;
  const ms = Math.max(0, timeToUtcMs(p.end as IcsTime, zctx) - timeToUtcMs(p.start, zctx));
  const s = Math.round(ms / 1000);
  return { negative: false, weeks: 0, days: 0, hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}

export interface ChangeRecurrenceOptions {
  /** True: calcola soltanto gli effetti, `object` è l'oggetto invariato. */
  dryRun?: boolean;
}

export interface ChangeRecurrenceResult {
  object: CalendarObject;
  /** Recurrence key degli override che con la nuova regola resterebbero orfani. */
  orphanedOverrides: string[];
  /** Recurrence key delle EXDATE che non corrispondono più a nessuna istanza (rimosse se non dryRun). */
  staleExdates: string[];
}

/**
 * RRULE con UNTIL dello stesso tipo del DTSTART (Radicale rifiuta i tipi
 * misti), con la semantica dell'espansione: UNTIL DATE su un master DATE-TIME
 * → ultimo secondo di quella giornata locale; UNTIL DATE-TIME su un master
 * DATE → data locale nel fuso del calendario; UNTIL floating su un master con
 * zona → stessa ora da muro in quella zona, in UTC.
 */
function normalizeRrule(rrule: string, dtstart: IcsTime, zctx: ZoneContext): string {
  const parsed = parseRecurRule(rrule);
  if (!parsed.ok) throw new IcsValueError('INVALID_VALUE', `RRULE non valida: ${parsed.reason}`, { property: 'RRULE', value: rrule });
  const rule = parsed.rule;
  const body = rrule.trim().replace(/^RRULE:/i, '');
  if (dtstart.type === 'date' && (['HOURLY', 'MINUTELY', 'SECONDLY'].includes(rule.freq) || rule.byhour || rule.byminute || rule.bysecond)) {
    throw new IcsValueError('INVALID_VALUE', 'RRULE oraria su un evento di tutto il giorno', { property: 'RRULE', value: rrule });
  }
  const u = rule.until;
  if (!u) return body;
  if (dtstart.type === 'date') {
    if (u.type === 'date') return body;
    const ms = u.zone.kind === 'utc' ? wallOfTime(u) : zonedToUtc(msToWall(wallOfTime(u)), ianaZone(zctx.tz));
    return setRrulePart(body, 'UNTIL', localDateOf(ms, zctx.tz).replace(/-/g, ''));
  }
  const floatingMaster = dtstart.zone.kind === 'floating';
  if (u.type === 'date') {
    const last: IcsTime = { type: 'date-time', year: u.year, month: u.month, day: u.day, hour: 23, minute: 59, second: 59, zone: floatingMaster ? { kind: 'floating' } : dtstart.zone };
    return setRrulePart(body, 'UNTIL', floatingMaster ? formatUntil(last) : untilFor(last, zctx));
  }
  if (floatingMaster) {
    if (u.zone.kind === 'floating') return body;
    // UTC su un master floating: la stessa ora da muro nel fuso del calendario.
    return setRrulePart(body, 'UNTIL', formatUntil(utcMsToTime(wallOfTime(u), dtstart, zctx)));
  }
  if (u.zone.kind === 'floating') {
    return setRrulePart(body, 'UNTIL', untilFor({ ...u, zone: dtstart.zone }, zctx));
  }
  return body;
}

/**
 * "Tutta la serie", cambio di RRULE (null = la serie diventa un evento
 * singolo: spariscono anche RDATE ed EXDATE). Con `dryRun` restituisce gli
 * override che diventerebbero orfani senza modificare nulla; senza dryRun
 * applica la regola (UNTIL normalizzato al tipo del DTSTART), toglie le
 * EXDATE che non corrispondono più a nessuna istanza e lascia gli override
 * orfani dove sono (l'admin decide con orphanedOverrides). Una RRULE non
 * valida lancia IcsValueError('INVALID_VALUE').
 */
export function changeRecurrence(
  obj: CalendarObject,
  rrule: string | null,
  opts: ChangeRecurrenceOptions,
  ctx: RecurrenceOpContext,
): ChangeRecurrenceResult {
  const an = analyze(obj, ctx);
  const zctx = an.zctx;
  const candidate = cloneCalendarObject(obj);
  const master = candidate.master as IcsComponent;
  const staleExdates: string[] = [];
  if (rrule == null || rrule.trim() === '') {
    for (const v of readTimeList(master, 'EXDATE')) {
      if (v.type !== 'period') staleExdates.push(recurrenceKeyOf(v, zctx));
    }
    removeProperties(master, 'RRULE');
    removeProperties(master, 'RDATE');
    removeProperties(master, 'EXDATE');
    removeProperties(master, 'EXRULE');
  } else {
    const value = normalizeRrule(rrule, an.spec.dtstart, zctx);
    const old = getProperty(master, 'RRULE');
    if (old) setProperty(master, { name: 'RRULE', params: old.params, value });
    else insertAfter(master, getProperty(master, 'DTEND') ? 'DTEND' : 'DTSTART', createProperty('RRULE', value));
    removeProperties(master, 'EXRULE');
  }
  const cand = analyze(candidate, ctx);
  if (rrule != null && rrule.trim() !== '') {
    // EXDATE che non corrispondono più a nessuna istanza della nuova serie.
    const dead = new Set<string>();
    for (const v of readTimeList(master, 'EXDATE')) {
      if (v.type === 'period') continue;
      let key: string;
      let canonical: string;
      try {
        key = recurrenceKeyOf(v, zctx);
        canonical = recurrenceKeyOf(typedLikeStart(v, cand.spec.dtstart, zctx), zctx);
      } catch {
        continue;
      }
      const look = instanceForKey(cand, canonical);
      if (!look.instance && !look.undetermined) {
        staleExdates.push(key);
        dead.add(key);
      }
    }
    if (dead.size > 0) {
      removeTimeListValues(master, 'EXDATE', (v) => {
        if (v.type === 'period') return false;
        try {
          return dead.has(recurrenceKeyOf(v, zctx));
        } catch {
          return false;
        }
      });
    }
  }
  const orphanedOverrides: string[] = [];
  for (const i of cand.set.winners) {
    if (cand.extraShadowed.has(i)) continue;
    if (cand.resolver.resolution(i).status !== 'orphan') continue;
    const k = componentKey(candidate.overrides[i], zctx);
    if (k != null) orphanedOverrides.push(k);
  }
  if (opts.dryRun) return { object: cloneCalendarObject(obj), orphanedOverrides, staleExdates };
  significant(master, ctx.now);
  return { object: candidate, orphanedOverrides, staleExdates };
}

interface Cut {
  /** Istante e ora da muro (zona del DTSTART) dell'istanza di taglio. */
  utc: number;
  wall: number;
  time: IcsTime;
  /** Istanze della RRULE (DTSTART compreso, EXDATE comprese) prima del taglio, per COUNT; null se non calcolate. */
  countBefore: number | null;
  /** True se prima del taglio non resta alcuna occorrenza visibile. */
  first: boolean;
}

function computeCut(an: Analysis, key: string): Cut {
  const ov = overrideForKey(an, key);
  const look = instanceForKey(an, key);
  let utc: number;
  let wall: number;
  if (look.instance) {
    if (an.series.isExcluded(look.instance) && ov === undefined) throw gone(key);
    utc = look.instance.utcMs;
    wall = look.instance.wallMs;
  } else if (ov !== undefined) {
    const s = overrideOriginalStart(an, ov);
    if (!s) throw gone(key);
    utc = s.utc;
    wall = s.wall;
  } else if (look.undetermined) {
    const t = targetTime(an, key);
    wall = wallOfTime(t);
    utc = an.series.utcOf(wall);
  } else {
    throw gone(key);
  }
  const series = an.series;
  const spec = an.spec;
  // Resta qualcosa prima del taglio? DTSTART non escluso basta; altrimenti override precedenti o istanze visibili.
  let first = wall <= spec.dtstartWallMs;
  if (!first) {
    const dtInst: SeriesInstance = { wallMs: spec.dtstartWallMs, utcMs: spec.dtstartUtcMs, rdate: -1 };
    const dtReplaced = an.resolver.replaced.has(series.idOf(dtInst));
    if (series.isExcluded(dtInst) && !dtReplaced) {
      first = true;
      for (const i of an.set.winners) {
        const s = overrideOriginalStart(an, i);
        if (s && s.wall < wall) {
          first = false;
          break;
        }
      }
      if (first) {
        try {
          for (const inst of series.instances(null, wall - 1)) {
            if (inst.wallMs >= wall) break;
            if (!series.isExcluded(inst)) {
              first = false;
              break;
            }
          }
        } catch (err) {
          if (!(err instanceof ExpansionBudgetError) && !(err instanceof RecurRuleError)) throw err;
          first = false;
        }
      }
    }
  }
  let countBefore: number | null = null;
  if (spec.rule?.count != null && !first) {
    try {
      let n = 0;
      for (const inst of series.instances(null, wall - 1)) {
        if (inst.wallMs >= wall) break;
        if (inst.rdate < 0) n++;
      }
      countBefore = n;
    } catch (err) {
      if (!(err instanceof ExpansionBudgetError) && !(err instanceof RecurRuleError)) throw err;
      countBefore = null;
    }
  }
  return { utc, wall, time: series.timeOf(wall), countBefore, first };
}

/** Applica il taglio al master e agli override di `out` (copia): UNTIL o COUNT, poi via override, EXDATE e RDATE dal taglio in poi. */
function applyTruncation(an: Analysis, out: CalendarObject, cut: Cut, now: Date): void {
  const master = out.master as IcsComponent;
  const spec = an.spec;
  const zctx = an.zctx;
  const rr = getProperty(master, 'RRULE');
  if (rr && spec.rule) {
    if (spec.rule.count != null && cut.countBefore != null) {
      rr.value = setRrulePart(rr.value, 'COUNT', String(Math.max(1, cut.countBefore)));
    } else {
      let until: string;
      if (spec.allDay) {
        const civ = civilFromDays(Math.floor(cut.wall / DAY_MS) - 1);
        until = formatUntil({ type: 'date', ...civ });
      } else if (spec.dtstart.type === 'date-time' && spec.dtstart.zone.kind === 'floating') {
        until = formatUntil({ type: 'date-time', ...msToWall(cut.wall - 1000), zone: { kind: 'floating' } });
      } else {
        until = formatUntil({ type: 'date-time', ...msToWall(Math.floor(cut.utc / 1000) * 1000 - 1000), zone: { kind: 'utc' } });
      }
      rr.value = setRrulePart(setRrulePart(rr.value, 'COUNT', null), 'UNTIL', until);
    }
  }
  const wallOf = (v: IcsTime): number | null => {
    try {
      return wallOfTime(typedLikeStart(v, spec.dtstart, zctx));
    } catch {
      return null;
    }
  };
  removeTimeListValues(master, 'EXDATE', (v) => v.type !== 'period' && (wallOf(v) ?? Number.NEGATIVE_INFINITY) >= cut.wall);
  removeTimeListValues(master, 'RDATE', (v) => (wallOf(v.type === 'period' ? v.start : v) ?? Number.NEGATIVE_INFINITY) >= cut.wall);
  const drop = new Set<number>();
  // Override con l'occorrenza originale dal taglio in poi (quelli con RECURRENCE-ID illeggibile restano).
  an.set.infos.forEach((_, i) => {
    const s = overrideOriginalStart(an, i);
    if (s && s.wall >= cut.wall) drop.add(i);
  });
  out.overrides = out.overrides.filter((_, i) => !drop.has(i));
  significant(master, now);
}

/**
 * "Elimina questa e le successive" (e passo (b) della saga di splitSeries):
 * UNTIL al giorno precedente (master DATE) o all'istante di taglio − 1 s
 * (master DATE-TIME, UNTIL in UTC; floating per un master floating); con
 * COUNT, COUNT ridotto alle istanze precedenti al taglio; override, EXDATE e
 * RDATE dal taglio in poi rimossi. Un taglio sulla prima istanza (o quando
 * prima del taglio non resta alcuna occorrenza visibile) equivale a eliminare
 * la serie: in quel caso restituisce null (il chiamante cancella la risorsa).
 */
export function truncateSeries(obj: CalendarObject, recurrenceKey: string, ctx: RecurrenceOpContext): CalendarObject | null {
  checkTarget(recurrenceKey, false);
  const an = analyze(obj, ctx);
  if (!isRecurringSpec(an.spec)) throw new RecurrenceTargetError('NOT_RECURRING', 'L\'evento non è ricorrente', recurrenceKey);
  const cut = computeCut(an, recurrenceKey);
  if (cut.first) return null;
  const out = cloneCalendarObject(obj);
  applyTruncation(an, out, cut, ctx.now);
  return out;
}

export interface SplitSeriesResult {
  /** True se il taglio cade sulla prima istanza: nessuno split, l'operazione vale per tutta la serie (head = oggetto invariato, tail = null). */
  wholeSeries: boolean;
  /** Vecchia serie troncata (truncateSeries). */
  head: CalendarObject;
  /**
   * Nuova serie: UID `newUid`, DTSTART all'istanza di taglio (stesso tipo e
   * TZID), stessa RRULE con COUNT residuo se c'era COUNT, RELATED-TO;
   * RELTYPE=SIBLING verso il vecchio UID, override ed EXDATE dal taglio in poi
   * (RECURRENCE-ID ricalcolati), SEQUENCE 0, CREATED e DTSTAMP a ctx.now.
   */
  tail: CalendarObject | null;
}

/**
 * "Questa e le successive": i due oggetti della saga in cal_jobs (design §8):
 * (a) PUT della nuova serie, (b) PUT del vecchio master troncato,
 * compensazione con DELETE della nuova serie. Funzione pura: le scritture le
 * fa la saga.
 */
export function splitSeries(
  obj: CalendarObject,
  recurrenceKey: string,
  opts: { newUid: string },
  ctx: RecurrenceOpContext,
): SplitSeriesResult {
  checkTarget(recurrenceKey, false);
  if (!opts.newUid || !opts.newUid.trim()) throw new IcsValueError('MISSING_PROPERTY', 'UID della nuova serie mancante', { property: 'UID' });
  const an = analyze(obj, ctx);
  if (!isRecurringSpec(an.spec)) throw new RecurrenceTargetError('NOT_RECURRING', 'L\'evento non è ricorrente', recurrenceKey);
  const cut = computeCut(an, recurrenceKey);
  if (cut.first) return { wholeSeries: true, head: cloneCalendarObject(obj), tail: null };
  const head = cloneCalendarObject(obj);
  applyTruncation(an, head, cut, ctx.now);

  const spec = an.spec;
  const zctx = an.zctx;
  const newUid = opts.newUid.trim();
  const now = ctx.now;
  const stamp = utcStamp(now);
  const src = obj.master as IcsComponent;
  const cutInst: SeriesInstance = { wallMs: cut.wall, utcMs: cut.utc, rdate: -1 };
  const tm = masterCopyAt(an, src, cutInst);
  setProperty(tm, { name: 'UID', params: getProperty(src, 'UID')?.params ?? [], value: encodeText(newUid) });
  // RRULE: stessa regola, COUNT residuo.
  const rr = getProperty(src, 'RRULE');
  if (rr) {
    let value = rr.value;
    if (spec.rule?.count != null) {
      const residual = cut.countBefore != null ? Math.max(1, spec.rule.count - cut.countBefore) : spec.rule.count;
      value = setRrulePart(value, 'COUNT', String(residual));
    }
    insertAfter(tm, getProperty(tm, 'DTEND') ? 'DTEND' : getProperty(tm, 'DURATION') ? 'DURATION' : 'DTSTART', { name: 'RRULE', params: rr.params.map((p) => ({ name: p.name, values: [...p.values] })), value });
  }
  const typedWall = (v: IcsTime): number | null => {
    try {
      return wallOfTime(typedLikeStart(v, spec.dtstart, zctx));
    } catch {
      return null;
    }
  };
  // RDATE ed EXDATE dal taglio in poi.
  for (const name of ['RDATE', 'EXDATE']) {
    const kept: Array<IcsTime | IcsPeriod> = [];
    for (const v of readTimeList(src, name)) {
      const start = v.type === 'period' ? v.start : v;
      const w = typedWall(start);
      if (w == null || w < cut.wall) continue;
      if (name === 'EXDATE') kept.push(typedLikeStart(start, spec.dtstart, zctx));
      else kept.push(v.type === 'period' ? v : typedLikeStart(v, spec.dtstart, zctx));
    }
    if (kept.length > 0) {
      const props = createTimeListProperties(name, kept);
      const anchor = getProperty(tm, 'RRULE') ? 'RRULE' : 'DTSTART';
      for (const p of props.reverse()) insertAfter(tm, anchor, p);
    }
  }
  const oldUid = getProperty(src, 'UID')?.value ?? encodeText(obj.uid);
  const related = getProperties(tm, 'RELATED-TO').some((p) => p.value === oldUid && (p.params.find((x) => x.name === 'RELTYPE')?.values[0] ?? '').toUpperCase() === 'SIBLING');
  if (!related) tm.properties.push({ name: 'RELATED-TO', params: [{ name: 'RELTYPE', values: ['SIBLING'] }], value: oldUid });
  const resetIdentity = (c: IcsComponent): void => {
    removeProperties(c, X_CALDES.LEGACY_ID);
    setProperty(c, { name: 'SEQUENCE', params: [], value: '0' });
    setProperty(c, { name: 'DTSTAMP', params: [], value: stamp });
    setProperty(c, { name: 'CREATED', params: [], value: stamp });
    setProperty(c, { name: 'LAST-MODIFIED', params: [], value: stamp });
  };
  resetIdentity(tm);
  // Override dal taglio in poi, con RECURRENCE-ID ricalcolati nel tipo del nuovo DTSTART.
  const tailOverrides: IcsComponent[] = [];
  an.set.infos.forEach((info, i) => {
    const s = overrideOriginalStart(an, i);
    if (!s || s.wall < cut.wall) return;
    const c = cloneComponent(obj.overrides[i]);
    setProperty(c, { name: 'UID', params: getProperty(c, 'UID')?.params ?? [], value: encodeText(newUid) });
    if (info.rid) setTimeProperty(c, 'RECURRENCE-ID', an.series.timeOf(s.wall));
    resetIdentity(c);
    tailOverrides.push(c);
  });
  const tail = createCalendarObject({
    uid: newUid,
    componentType: obj.componentType,
    master: tm,
    overrides: tailOverrides,
    timezones: obj.timezones.map(cloneComponent),
    calendarProperties: obj.calendarProperties.map((p) => ({ name: p.name, params: p.params.map((x) => ({ name: x.name, values: [...x.values] })), value: p.value })),
  });
  return { wholeSeries: false, head, tail };
}

/**
 * "Duplica": copia come evento singolo nato alla data dell'occorrenza (non a
 * quella del master): proprietà del componente dell'istanza (override se
 * c'è, altrimenti master), DTSTART/DTEND dell'istanza, senza RRULE, RDATE,
 * EXDATE e RECURRENCE-ID, UID `newUid`, SEQUENCE 0, CREATED e DTSTAMP a
 * ctx.now, VALARM e X-* copiati (X-CALDES-LEGACY-ID escluso).
 * MASTER_RECURRENCE_KEY duplica un evento singolo o la prima istanza.
 */
export function duplicateOccurrence(
  obj: CalendarObject,
  recurrenceKey: string,
  opts: { newUid: string },
  ctx: RecurrenceOpContext,
): CalendarObject {
  checkTarget(recurrenceKey, true);
  if (!opts.newUid || !opts.newUid.trim()) throw new IcsValueError('MISSING_PROPERTY', 'UID della copia mancante', { property: 'UID' });
  const newUid = opts.newUid.trim();
  let copy: IcsComponent;
  if (recurrenceKey === MASTER_RECURRENCE_KEY) {
    if (!obj.master) throw new RecurrenceTargetError('NO_MASTER', 'Oggetto senza evento principale', recurrenceKey);
    copy = cloneComponent(obj.master);
  } else if (!obj.master) {
    const zctx = zoneContext(obj, ctx);
    const idx = obj.overrides.findIndex((c) => componentKey(c, zctx) === recurrenceKey);
    if (idx < 0) throw gone(recurrenceKey);
    copy = cloneComponent(obj.overrides[idx]);
  } else {
    const an = analyze(obj, ctx);
    const ov = overrideForKey(an, recurrenceKey);
    if (ov !== undefined) {
      copy = cloneComponent(obj.overrides[ov]);
      if (!getProperty(copy, 'DTSTART')) {
        const s = overrideOriginalStart(an, ov);
        if (!s) throw gone(recurrenceKey);
        copy = masterCopyAt(an, obj.master, { wallMs: s.wall, utcMs: s.utc, rdate: -1 });
      }
    } else {
      const look = instanceForKey(an, recurrenceKey);
      if (!look.instance || an.series.isExcluded(look.instance)) throw gone(recurrenceKey);
      copy = masterCopyAt(an, obj.master, look.instance);
    }
  }
  for (const name of ['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'RECURRENCE-ID', X_CALDES.LEGACY_ID]) removeProperties(copy, name);
  setProperty(copy, { name: 'UID', params: getProperty(copy, 'UID')?.params ?? [], value: encodeText(newUid) });
  const stamp = utcStamp(ctx.now);
  setProperty(copy, { name: 'SEQUENCE', params: [], value: '0' });
  setProperty(copy, { name: 'DTSTAMP', params: [], value: stamp });
  setProperty(copy, { name: 'CREATED', params: [], value: stamp });
  setProperty(copy, { name: 'LAST-MODIFIED', params: [], value: stamp });
  return createCalendarObject({
    uid: newUid,
    componentType: obj.componentType,
    master: copy,
    timezones: obj.timezones.map(cloneComponent),
    calendarProperties: obj.calendarProperties.map((p) => ({ name: p.name, params: p.params.map((x) => ({ name: x.name, values: [...x.values] })), value: p.value })),
  });
}
