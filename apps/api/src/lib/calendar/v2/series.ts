/**
 * Semantica degli scope della v2 (F6, contratto
 * docs/calendar-radicale/contracts/f6-modules.md §3.3, §3.7, §3.8, §5.4).
 *
 * Modulo PURO: nessun I/O, nessun database, nessun import dello store. Applica
 * le op wire (`CalV2Op`) a un `CalendarObject` con la patch lossless di
 * calendar-core e le operazioni di serie di recurrence-ops:
 *  - 'this': patch dell'override dell'istanza (creato se manca); le op su
 *    rrule, rdates ed exdates sono SCOPE_INVALID;
 *  - 'all': patch del master. Da un'istanza, start/end diventano uno
 *    spostamento Δ della serie (shiftSeries sul DTSTART del master) e la
 *    durata nuova va sul master; un cambio di RRULE passa da changeRecurrence.
 *    I campi non temporali toccati si propagano agli override non
 *    personalizzati (il cui valore coincideva con quello precedente del
 *    master) e all'override del target;
 *  - 'this_and_future': anteprima della saga (splitSeries) con le op sulla
 *    nuova serie; la scrittura la fa splitRecurringEvent dello store, che usa
 *    applyOpsToNewSeries (la stessa funzione) per la nuova serie;
 *  - eliminazione con scope: planScopedDelete.
 *
 * Il confronto per i conflitti (conflictingKeys, §3.3 passi 3-4) lavora su
 * token opachi calcolati da view.ts.
 */

import {
  addDays,
  addDurationToTime,
  applyComponentOps,
  applyPatch,
  type CalendarObject,
  canonicalPropertyText,
  changeRecurrence,
  cloneCalendarObject,
  daysBetween,
  durationFromMs,
  excludeOccurrence,
  expandObject,
  fieldValuesEqual,
  getProperties,
  getProperty,
  type IcsComponent,
  type IcsDate,
  type IcsDateTime,
  type IcsDuration,
  type IcsProperty,
  type IcsTime,
  icsDateToString,
  materializeOverride,
  MASTER_RECURRENCE_KEY,
  msToWall,
  type PatchFieldName,
  type PatchOp,
  readFieldValues,
  readTimeProperty,
  RecurrenceTargetError,
  shiftSeries,
  splitSeries,
  stringToIcsDate,
  timesEqual,
  timeToUtcMs,
  truncateSeries,
  utcMsToTime,
  type ZoneContext,
} from '@calicchia/calendar-core';
import {
  CAL_V2_FIELDS,
  CAL_V2_RESERVED_PROPERTIES,
  CAL_V2_SERIES_ONLY_FIELDS,
  type CalV2FieldConflict,
  type CalV2Op,
  type CalV2Scope,
} from '@calicchia/shared';
import { CalendarV2Error, invalidValue } from './errors';
import { resolveTargetComponent, tokenFor } from './view';

export interface ScopedPatchContext {
  tz: string;
  now: Date;
}

export interface ScopedPatchResult {
  object: CalendarObject;
  changed: string[];
  noop: boolean;
  sequenceBumped: boolean;
  /** Chiave del target dopo la patch (cambia solo con una ritipizzazione). */
  targetKey: string;
  rekeyed: Map<string, string>;
  orphanedOverrides: string[];
}

const RESERVED: ReadonlySet<string> = new Set(CAL_V2_RESERVED_PROPERTIES);
const FIELD_SET: ReadonlySet<string> = new Set(CAL_V2_FIELDS);
const SERIES_ONLY: ReadonlySet<string> = new Set(CAL_V2_SERIES_ONLY_FIELDS);
/** Campi che spostano o rimodellano la serie: li gestisce il master (shiftSeries, changeRecurrence), mai la propagazione. */
const TEMPORAL: ReadonlySet<string> = new Set(['start', 'end', 'duration', 'rrule', 'rdates', 'exdates']);
/** Campi la cui modifica incrementa SEQUENCE (come patch.ts). */
const SEQUENCE_FIELDS: ReadonlySet<string> = new Set(['start', 'end', 'duration', 'rrule', 'rdates', 'exdates', 'location', 'status']);
const PROPERTY_NAME_RE = /^[A-Z][A-Z0-9-]*$/;
/** UID segnaposto dell'anteprima di "questa e le successive" (la saga ne genera uno vero). */
const PLAN_UID = 'anteprima-serie@caldes.invalid';
const DAY_MS = 86_400_000;

// ─── Op wire → core ───────────────────────────────

/** Errore di scope non ammesso (400 SCOPE_INVALID). */
export function scopeInvalid(message: string): CalendarV2Error {
  return new CalendarV2Error('SCOPE_INVALID', 400, message);
}

/**
 * Op wire → PatchOp di calendar-core ('set_property' → 'setProperty'). Rifiuta
 * i nomi riservati (CAL_V2_RESERVED_PROPERTIES) e i nomi non validi
 * (400 VALIDATION_FAILED).
 */
export function toCoreOps(ops: readonly CalV2Op[]): PatchOp[] {
  return ops.map((op): PatchOp => {
    if (op.op === 'set') return op as unknown as PatchOp;
    const name = op.name;
    if (!PROPERTY_NAME_RE.test(name)) throw invalidValue(`Nome di proprietà non valido: "${name.slice(0, 40)}"`, name.slice(0, 40));
    if (RESERVED.has(name)) throw invalidValue(`${name} si modifica con il campo tipizzato, non come proprietà`, name);
    for (const p of op.properties) {
      if (p.name !== name) throw invalidValue(`La proprietà ${p.name.slice(0, 40)} non corrisponde a ${name}`, name);
    }
    return { op: 'setProperty', name, properties: op.properties.map((p) => ({ name: p.name, params: p.params.map((x) => ({ name: x.name, values: [...x.values] })), value: p.value })) };
  });
}

/** Chiave di una op nei token e nei conflitti: il nome del campo o 'prop:<NOME>'. */
export function opKey(op: PatchOp): string {
  return op.op === 'set' ? op.field : `prop:${op.name.toUpperCase()}`;
}

/** Nome di un campo cambiato (patch.ts) → nome del DTO: i campi tipizzati così come sono, le proprietà come 'prop:<NOME>'. */
function changedName(name: string): string {
  return FIELD_SET.has(name) ? name : `prop:${name.toUpperCase()}`;
}

function setOp<F extends PatchFieldName>(ops: readonly PatchOp[], field: F): Extract<PatchOp, { op: 'set'; field: F }> | undefined {
  return ops.find((o): o is Extract<PatchOp, { op: 'set'; field: F }> => o.op === 'set' && o.field === field);
}

// ─── Forma dell'oggetto e controllo degli scope ───────────────────────────────

/** Master con RRULE o RDATE. */
export function isRecurringObject(obj: CalendarObject): boolean {
  return Boolean(obj.master && (getProperty(obj.master, 'RRULE') || getProperty(obj.master, 'RDATE')));
}

/**
 * Combinazioni di scope, target e campi ammesse dal §3.8 (scritture) e dal
 * §3.7 (eliminazioni). Lancia SCOPE_INVALID. Non controlla che l'istanza
 * esista (lo fanno le operazioni di calendar-core: RECURRENCE_TARGET_GONE).
 */
export function assertScope(obj: CalendarObject, targetKey: string, scope: CalV2Scope, ops: readonly PatchOp[] | null): void {
  if (!obj.master) {
    if (scope !== 'this' || targetKey === MASTER_RECURRENCE_KEY) {
      throw scopeInvalid('Evento senza serie principale: solo l\'occorrenza indicata può essere modificata');
    }
    return;
  }
  if (!isRecurringObject(obj)) {
    if (scope !== 'all') throw scopeInvalid('L\'evento non è ricorrente: l\'unico scope ammesso è "tutto"');
    if (targetKey !== MASTER_RECURRENCE_KEY) throw new RecurrenceTargetError('RECURRENCE_TARGET_GONE', 'Occorrenza non più presente', targetKey);
    return;
  }
  if (targetKey === MASTER_RECURRENCE_KEY && scope !== 'all') {
    throw scopeInvalid('Dall\'evento principale della serie si modifica solo tutta la serie');
  }
  if (scope === 'this' && ops?.some((o) => o.op === 'set' && SERIES_ONLY.has(o.field))) {
    throw scopeInvalid('Ricorrenza, date aggiunte ed escluse si cambiano per tutta la serie, non per una sola occorrenza');
  }
}

// ─── Aritmetica sui tempi ───────────────────────────────

function wallMs(t: IcsTime): number {
  return t.type === 'date'
    ? Date.UTC(t.year, t.month - 1, t.day)
    : Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, Math.min(t.second, 59));
}

/** La parte data di un valore (un DATE-TIME contribuisce con la propria data da muro). */
function dateOf(t: IcsTime): IcsDate {
  return { type: 'date', year: t.year, month: t.month, day: t.day };
}

function shiftedDate(t: IcsTime, days: number): IcsDate {
  return stringToIcsDate(addDays(icsDateToString(dateOf(t)), days));
}

/** `t` espresso nel tipo e nella zona di `like` (stesso istante). */
function inZoneOf(t: IcsTime, like: IcsTime, zctx: ZoneContext): IcsTime {
  return utcMsToTime(timeToUtcMs(t, zctx), like, zctx);
}

/**
 * Nuovo DTSTART del master quando l'istanza passa da `s0` a `s1`: Δ = s1 − s0
 * (in ora da muro nella zona di s1) applicato al DTSTART del master. Un cambio
 * di tipo (all-day ↔ timed) sposta la data del master dello stesso numero di
 * giorni e prende l'ora e la zona del nuovo valore.
 */
function movedMasterStart(m0: IcsTime, s0: IcsTime, s1: IcsTime, zctx: ZoneContext): IcsTime {
  if (s1.type === 'date') {
    const s0Local = s0.type === 'date' ? s0 : inZoneOf(s0, s1, zctx);
    const mLocal = m0.type === 'date' ? m0 : inZoneOf(m0, s1, zctx);
    return shiftedDate(mLocal, daysBetween(icsDateToString(dateOf(s0Local)), icsDateToString(s1)));
  }
  if (s0.type === 'date' || m0.type === 'date') {
    const s0Local = s0.type === 'date' ? s0 : inZoneOf(s0, s1, zctx);
    const mLocal = m0.type === 'date' ? m0 : inZoneOf(m0, s1, zctx);
    const days = daysBetween(icsDateToString(dateOf(s0Local)), icsDateToString(dateOf(s1)));
    const d = shiftedDate(mLocal, days);
    return { type: 'date-time', year: d.year, month: d.month, day: d.day, hour: s1.hour, minute: s1.minute, second: s1.second, zone: s1.zone };
  }
  const delta = wallMs(s1) - wallMs(inZoneOf(s0, s1, zctx));
  const wall = msToWall(wallMs(inZoneOf(m0, s1, zctx)) + delta);
  const out: IcsDateTime = { type: 'date-time', year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: wall.second, zone: s1.zone };
  return out;
}

/** Durata fra due valori dello stesso tipo: giorni interi per gli all-day, tempo esatto per i timed. */
function durationBetween(start: IcsTime, end: IcsTime, zctx: ZoneContext): IcsDuration {
  if (start.type === 'date' && end.type === 'date') {
    const days = Math.max(0, daysBetween(icsDateToString(start), icsDateToString(end)));
    return { negative: false, weeks: 0, days, hours: 0, minutes: 0, seconds: 0 };
  }
  if (start.type === 'date-time' && end.type === 'date-time') {
    return durationFromMs(Math.max(0, timeToUtcMs(end, zctx) - timeToUtcMs(start, zctx)));
  }
  throw invalidValue('Inizio e fine devono essere entrambi giorni interi o entrambi con orario', 'DTEND');
}

function readStart(c: IcsComponent): IcsTime | null {
  const p = getProperty(c, 'DTSTART');
  if (!p) return null;
  try {
    return readTimeProperty(p);
  } catch {
    return null;
  }
}

// ─── Op di un'istanza → op del master ───────────────────────────────

/**
 * Scope 'all' da un'istanza (§3.8): start ed end dell'istanza diventano lo
 * spostamento Δ del DTSTART del master e la durata nuova (nuovo end − nuovo
 * start) va sul master come DTEND, o come DURATION se il master la usa. Gli
 * altri campi restano così come sono.
 */
function instanceOpsToMaster(obj: CalendarObject, pre: IcsComponent, ops: readonly PatchOp[], ctx: ScopedPatchContext): PatchOp[] {
  const startOp = setOp(ops, 'start');
  const endOp = setOp(ops, 'end');
  if (!startOp && !endOp) return [...ops];
  const master = obj.master as IcsComponent;
  const zctx: ZoneContext = { tz: ctx.tz, timezones: obj.timezones };
  const s0 = readStart(pre);
  const m0 = readStart(master);
  if (!s0 || !m0) throw invalidValue('DTSTART non leggibile', 'DTSTART');
  const s1 = startOp ? startOp.value : s0;
  const m1 = startOp ? movedMasterStart(m0, s0, s1, zctx) : m0;
  const out: PatchOp[] = ops.filter((o) => !(o.op === 'set' && (o.field === 'start' || o.field === 'end')));
  if (startOp) out.unshift({ op: 'set', field: 'start', value: m1 });
  if (endOp) {
    const e1 = endOp.value;
    if (e1 === null) {
      out.push({ op: 'set', field: 'end', value: null });
    } else {
      const duration = durationBetween(s1, e1, zctx);
      const usesDuration = !getProperty(master, 'DTEND') && getProperty(master, 'DURATION');
      if (usesDuration) out.push({ op: 'set', field: 'duration', value: duration });
      else out.push({ op: 'set', field: 'end', value: addDurationToTime(m1, duration, zctx) });
    }
  }
  return out;
}

// ─── Confronti per la propagazione e per i conflitti ───────────────────────────────

function fieldOf(c: IcsComponent, field: PatchFieldName): unknown {
  try {
    return readFieldValues(c, [field])[field] ?? null;
  } catch {
    return undefined;
  }
}

function rawKey(props: readonly IcsProperty[]): string {
  return props.map((p) => canonicalPropertyText(p)).sort().join('\u0000');
}

/** true se il componente ha, per la op, lo stesso valore del riferimento (override non personalizzato). */
function sameAsReference(op: PatchOp, c: IcsComponent, reference: IcsComponent): boolean {
  if (op.op === 'setProperty') {
    const name = op.name.toUpperCase();
    return rawKey(getProperties(c, name)) === rawKey(getProperties(reference, name));
  }
  const a = fieldOf(c, op.field);
  const b = fieldOf(reference, op.field);
  if (a === undefined || b === undefined) return false;
  return fieldValuesEqual(op.field, a as never, b as never);
}

/** Nomi dei campi (e 'prop:<NOME>' delle proprietà toccate) il cui valore differisce fra due versioni di un componente. */
function diffNames(before: IcsComponent, after: IcsComponent, ops: readonly PatchOp[]): string[] {
  const out: string[] = [];
  for (const f of CAL_V2_FIELDS) {
    const a = fieldOf(before, f);
    const b = fieldOf(after, f);
    if (a === undefined || b === undefined) {
      if (a !== b) out.push(f);
      continue;
    }
    if (!fieldValuesEqual(f, a as never, b as never)) out.push(f);
  }
  for (const op of ops) {
    if (op.op !== 'setProperty') continue;
    const name = op.name.toUpperCase();
    if (rawKey(getProperties(before, name)) !== rawKey(getProperties(after, name))) out.push(`prop:${name}`);
  }
  return out;
}

// ─── Scope 'all' ───────────────────────────────

function applyAll(obj: CalendarObject, targetKey: string, ops: readonly PatchOp[], ctx: ScopedPatchContext): ScopedPatchResult {
  const master0 = obj.master;
  if (!master0) throw new RecurrenceTargetError('NO_MASTER', 'Oggetto senza evento principale: indicare l\'occorrenza da modificare', targetKey);
  const recurring = isRecurringObject(obj);

  let masterOps: PatchOp[] = [...ops];
  let targetOverride = -1;
  if (targetKey !== MASTER_RECURRENCE_KEY) {
    const mat = materializeOverride(obj, targetKey, ctx);
    if (!mat.created) targetOverride = mat.index;
    masterOps = instanceOpsToMaster(obj, mat.object.overrides[mat.index], ops, ctx);
  }

  let work = cloneCalendarObject(obj);
  const orphaned = new Set<string>();
  const rekeyed = new Map<string, string>();

  // Spostamento della serie (stesso tipo di DTSTART, anche con cambio di zona): shiftSeries porta con sé RECURRENCE-ID, EXDATE, RDATE e UNTIL.
  const rruleOp = setOp(masterOps, 'rrule');
  const rruleChanged = Boolean(rruleOp && !fieldValuesEqual('rrule', (fieldOf(master0, 'rrule') ?? null) as never, rruleOp.value as never));
  const startOp = setOp(masterOps, 'start');
  let shifted = false;
  if (recurring && startOp) {
    const current = readStart(master0);
    if (current && current.type === startOp.value.type && !timesEqual(current, startOp.value)) {
      const res = shiftSeries(work, startOp.value, ctx, { strict: !rruleChanged });
      work = res.object;
      for (const [from, to] of res.rekeyed) rekeyed.set(from, to);
      for (const key of res.orphanedOverrides) orphaned.add(key);
      shifted = true;
    }
  }

  // Cambio di regola.
  if (rruleOp && rruleChanged) {
    const res = changeRecurrence(work, rruleOp.value, {}, ctx);
    work = res.object;
    for (const key of res.orphanedOverrides) orphaned.add(key);
  }

  // Resto delle op sul master.
  const rest = masterOps.filter((o) => !(o.op === 'set' && (o.field === 'rrule' || (o.field === 'start' && shifted))));
  const patched = applyPatch(work, MASTER_RECURRENCE_KEY, rest, ctx);
  const result = patched.object;
  if (patched.rekeyed) for (const [from, to] of patched.rekeyed) rekeyed.set(from, to);

  // Propagazione dei campi non temporali agli override non personalizzati e a quello del target.
  const names = new Set<string>(diffNames(master0, result.master as IcsComponent, masterOps));
  if (recurring) {
    const propagated = masterOps.filter((o) => !(o.op === 'set' && TEMPORAL.has(o.field)));
    for (const op of propagated) {
      result.overrides.forEach((override, i) => {
        if (i !== targetOverride && !sameAsReference(op, override, master0)) return;
        const res = applyComponentOps(override, [op], { tz: ctx.tz, now: ctx.now, timezones: result.timezones });
        for (const name of res.changed) names.add(changedName(name));
      });
    }
  }

  const changed = [...names];
  if (changed.length === 0 && rekeyed.size === 0) {
    return { object: cloneCalendarObject(obj), changed: [], noop: true, sequenceBumped: false, targetKey, rekeyed, orphanedOverrides: [...orphaned] };
  }
  return {
    object: result,
    changed,
    noop: false,
    sequenceBumped: changed.some((n) => SEQUENCE_FIELDS.has(n)),
    targetKey: rekeyed.get(targetKey) ?? targetKey,
    rekeyed,
    orphanedOverrides: [...orphaned],
  };
}

/**
 * Op sulla nuova serie di "questa e le successive": le stesse regole di
 * 'all' sul master della coda (spostamento con shiftSeries, cambio di regola,
 * propagazione agli override della coda). Usata dalla saga dello store
 * (splitRecurringEvent con `ops`) e da planThisAndFuture, così anteprima e
 * scrittura coincidono.
 */
export function applyOpsToNewSeries(tail: CalendarObject, ops: readonly PatchOp[], ctx: ScopedPatchContext): CalendarObject {
  return applyAll(tail, MASTER_RECURRENCE_KEY, ops, ctx).object;
}

// ─── Scope 'this' e 'all' ───────────────────────────────

/**
 * Scope 'this' o 'all' (§3.8), propagazione inclusa. Lancia
 * CalendarV2Error('SCOPE_INVALID'), RecurrenceTargetError e IcsValueError.
 */
export function applyScopedPatch(
  obj: CalendarObject,
  targetKey: string,
  scope: 'this' | 'all',
  ops: readonly CalV2Op[],
  ctx: ScopedPatchContext,
): ScopedPatchResult {
  const core = toCoreOps(ops);
  assertScope(obj, targetKey, scope, core);
  if (scope === 'all') return applyAll(obj, targetKey, core, ctx);
  const res = applyPatch(obj, targetKey, core, { tz: ctx.tz, now: ctx.now, createOverride: true });
  return {
    object: res.object,
    changed: res.changed.map(changedName),
    noop: res.noop,
    sequenceBumped: res.sequenceBumped,
    targetKey,
    rekeyed: res.rekeyed ?? new Map(),
    orphanedOverrides: [],
  };
}

// ─── Conflitti (§3.3) ───────────────────────────────

/**
 * Chiavi in conflitto rispetto al testo corrente (§3.3 passi 3 e 4). Una
 * chiave toccata dalle op è in conflitto se il token di `base` differisce dal
 * token corrente del target (o manca) E applicare la op al testo corrente la
 * cambierebbe ancora: se il server ha già il valore richiesto non c'è
 * conflitto (un nuovo invio della propria modifica già riuscita è un noop).
 * `theirs` e `yours` sono nel formato wire.
 */
export function conflictingKeys(
  current: CalendarObject,
  targetKey: string,
  scope: CalV2Scope,
  ops: readonly CalV2Op[],
  base: Readonly<Record<string, string>>,
  ctx: ScopedPatchContext,
): CalV2FieldConflict[] {
  void scope;
  const target = resolveTargetComponent(current, targetKey, ctx);
  if (!target) throw new RecurrenceTargetError('RECURRENCE_TARGET_GONE', 'Occorrenza non più presente', targetKey);
  const core = toCoreOps(ops);
  const conflicts: CalV2FieldConflict[] = [];
  const seen = new Set<string>();
  core.forEach((op, i) => {
    const key = opKey(op);
    if (seen.has(key)) return;
    seen.add(key);
    if (!tokenDiffers(target.component, key, base[key])) return;
    const wire = ops[i];
    if (op.op === 'set') {
      const theirs = fieldOf(target.component, op.field);
      if (theirs !== undefined && fieldValuesEqual(op.field, theirs as never, op.value as never)) return;
      conflicts.push({ field: key, theirs: theirs ?? null, yours: wire.op === 'set' ? wire.value : null });
    } else {
      const name = op.name.toUpperCase();
      const theirs = getProperties(target.component, name);
      if (rawKey(theirs) === rawKey(op.properties)) return;
      conflicts.push({ field: key, theirs: theirs.map((p) => ({ name: p.name, params: p.params.map((x) => ({ name: x.name, values: [...x.values] })), value: p.value })), yours: wire.op === 'set_property' ? wire.properties : [] });
    }
  });
  return conflicts;
}

/**
 * Chiavi delle op il cui valore differisce da quello corrente del target
 * (master, override o pre-immagine): ciò che una modifica cambierebbe davvero.
 * Serve a "questa e le successive", dove la modifica va su una serie nuova e il
 * confronto con l'originale decide se c'è qualcosa da fare.
 */
export function changedKeys(obj: CalendarObject, targetKey: string, ops: readonly CalV2Op[], ctx: ScopedPatchContext): string[] {
  const target = resolveTargetComponent(obj, targetKey, ctx);
  if (!target) throw new RecurrenceTargetError('RECURRENCE_TARGET_GONE', 'Occorrenza non più presente', targetKey);
  const out: string[] = [];
  for (const op of toCoreOps(ops)) {
    if (op.op === 'set') {
      const theirs = fieldOf(target.component, op.field);
      if (theirs === undefined || !fieldValuesEqual(op.field, theirs as never, op.value as never)) out.push(op.field);
    } else if (rawKey(getProperties(target.component, op.name.toUpperCase())) !== rawKey(op.properties)) {
      out.push(`prop:${op.name.toUpperCase()}`);
    }
  }
  return out;
}

function tokenDiffers(component: IcsComponent, key: string, baseToken: string | undefined): boolean {
  return baseToken === undefined || baseToken !== tokenFor(component, key);
}

// ─── Questa e le successive ───────────────────────────────

/**
 * Anteprima di 'this_and_future' (splitSeries di calendar-core, senza
 * scrivere): vecchia serie troncata e nuova serie con le op. Se K è la prima
 * istanza è come 'all' (`wholeSeries`, head null, tail = serie intera con le op).
 */
export function planThisAndFuture(
  obj: CalendarObject,
  targetKey: string,
  ops: readonly CalV2Op[],
  ctx: ScopedPatchContext,
): { wholeSeries: boolean; head: CalendarObject | null; tail: CalendarObject } {
  const core = toCoreOps(ops);
  assertScope(obj, targetKey, 'this_and_future', core);
  const split = splitSeries(obj, targetKey, { newUid: PLAN_UID }, ctx);
  if (split.wholeSeries || !split.tail) {
    return { wholeSeries: true, head: null, tail: applyAll(obj, targetKey, core, ctx).object };
  }
  return { wholeSeries: false, head: split.head, tail: applyOpsToNewSeries(split.tail, core, ctx) };
}

// ─── Eliminazione con scope (§3.7) ───────────────────────────────

/** true se all'oggetto resta almeno un'istanza non annullata (o se non si può decidere: scelta prudente). */
function hasVisibleInstance(obj: CalendarObject, ctx: ScopedPatchContext): boolean {
  const first = obj.master ? readStart(obj.master) : null;
  let from = Date.UTC(1970, 0, 1);
  try {
    if (first) from = timeToUtcMs(first, { tz: ctx.tz, timezones: obj.timezones }) - DAY_MS;
  } catch {
    return true;
  }
  const res = expandObject(obj, { from, to: from + 120 * 366 * DAY_MS, tz: ctx.tz, maxOccurrences: 50, computeRangeEnd: false });
  if (res.health !== 'ok') return true;
  return res.occurrences.some((o) => (o.kind === 'event' || o.kind === 'override' || o.kind === 'orphan_override') && o.status !== 'CANCELLED');
}

/**
 * Piano di una DELETE con scope (§3.7): 'all' elimina la risorsa; 'this' toglie
 * l'istanza (EXDATE tipizzato e override rimosso), e se non resta nessuna
 * istanza elimina la risorsa; 'this_and_future' tronca la serie (truncateSeries)
 * e, se K è la prima istanza, elimina la risorsa. Gli scope non ammessi per la
 * forma dell'oggetto sono SCOPE_INVALID.
 */
export function planScopedDelete(
  obj: CalendarObject,
  targetKey: string,
  scope: CalV2Scope,
  ctx: ScopedPatchContext,
): { action: 'put'; object: CalendarObject } | { action: 'delete' } {
  if (scope === 'all') return { action: 'delete' };
  if (!obj.master) {
    if (scope !== 'this' || targetKey === MASTER_RECURRENCE_KEY) throw scopeInvalid('Evento senza serie principale: si elimina solo l\'occorrenza indicata');
  } else if (!isRecurringObject(obj)) {
    throw scopeInvalid('L\'evento non è ricorrente: l\'unico scope ammesso è "tutto"');
  } else if (targetKey === MASTER_RECURRENCE_KEY) {
    throw scopeInvalid('Dall\'evento principale della serie si elimina solo tutta la serie');
  }
  if (scope === 'this') {
    const object = excludeOccurrence(obj, targetKey, ctx);
    return hasVisibleInstance(object, ctx) ? { action: 'put', object } : { action: 'delete' };
  }
  const object = truncateSeries(obj, targetKey, ctx);
  return object ? { action: 'put', object } : { action: 'delete' };
}
