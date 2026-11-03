/**
 * Abbinamento degli override alle occorrenze del master (design §6.4).
 *
 * ical.js abbina gli override con il confronto esatto dei valori, quindi un
 * RECURRENCE-ID DATE-TIME su un master DATE (o viceversa), o un TZID diverso
 * da quello del DTSTART, non sostituisce nulla: l'occorrenza originale resta e
 * l'override sparisce dal busy. Qui l'abbinamento è proprio e tollerante:
 * - entrambi DATE-TIME con zona (UTC o TZID): istante UTC al secondo;
 * - DATE contro DATE-TIME (in qualunque ordine) o entrambi DATE: data locale
 *   nel fuso del calendario (un DATE-TIME con TZID si converte prima nel fuso
 *   del calendario);
 * - floating: ora locale interpretata nel fuso del calendario, poi come sopra.
 * Quando il DTSTART del master è un DATE la chiave è sempre la data.
 *
 * Con un master DATE-TIME un RECURRENCE-ID DATE indica "l'occorrenza di quel
 * giorno": si abbina alla PRIMA occorrenza del master che cade in quella data
 * locale (le altre dello stesso giorno, in una serie oraria, restano del
 * master). Le EXDATE non tolgono l'istanza ai fini dell'abbinamento: un
 * override su un'istanza esclusa prevale (come ical.js e Google).
 */

import { addDays, localDateOf, localMidnightUtcMs } from './allday';
import {
  type CalendarObject,
  formatTimeValue,
  getProperty,
  type IcsComponent,
  type IcsTime,
  readTimeProperty,
  timeToUtcMs,
  type ZoneContext,
} from './model';
import {
  DAY_MS,
  dateKeyOf,
  daysFromCivil,
  DEFAULT_ITERATION_BUDGET,
  ExpansionBudget,
  ExpansionBudgetError,
  readMasterSpec,
  RecurRuleError,
  scanMarginMs,
  Series,
  type SeriesInstance,
} from './recur';
import { DEFAULT_TZ, ianaName, msToWall } from './tz-registry';

export interface MatchContext {
  /** Fuso IANA del calendario. */
  tz: string;
  /** VTIMEZONE dell'oggetto (TZID non IANA). */
  timezones?: readonly IcsComponent[];
}

/** Contesto di conversione: un fuso del calendario sconosciuto ricade su DEFAULT_TZ (mai un'eccezione per dati sbagliati). */
export function matchZoneContext(ctx: MatchContext): ZoneContext {
  return { tz: ctx.tz && ianaName(ctx.tz) ? ctx.tz : DEFAULT_TZ, timezones: ctx.timezones };
}

const zctx = matchZoneContext;

/** Istante (ms UTC) → chiave 'YYYYMMDDTHHMMSSZ'. */
export function instantKeyOfMs(ms: number): string {
  return formatTimeValue({ type: 'date-time', ...msToWall(Math.floor(ms / 1000) * 1000), zone: { kind: 'utc' } });
}

/** 'YYYY-MM-DD' → 'YYYYMMDD'. */
function compactDate(date: string): string {
  return date.replace(/-/g, '');
}

/** Chiave istante 'YYYYMMDDTHHMMSSZ' al secondo. */
function instantKey(t: IcsTime, ctx: ZoneContext): string {
  return instantKeyOfMs(timeToUtcMs(t, ctx));
}

/**
 * Chiave di confronto di un istante di occorrenza o di un RECURRENCE-ID,
 * secondo le regole del modulo. `masterType` è il tipo del DTSTART del master:
 * - master DATE: sempre la data locale, 'YYYYMMDD';
 * - master DATE-TIME: 'YYYYMMDDTHHMMSSZ' (istante al secondo) per un
 *   DATE-TIME, 'YYYYMMDD' (la data) per un DATE.
 * Due valori dello stesso tipo si riferiscono alla stessa occorrenza se e solo
 * se hanno la stessa chiave; un DATE contro un DATE-TIME si confronta sulla
 * data (isSameOccurrence, OverrideIndex). Lancia IcsValueError/TimezoneError
 * solo per valori impossibili da convertire.
 */
export function matchKey(t: IcsTime, masterType: 'date' | 'date-time', ctx: MatchContext): string {
  const z = zctx(ctx);
  if (masterType === 'date' || t.type === 'date') return compactDate(dateKeyOf(t, z));
  return instantKey(t, z);
}

/** True se `a` e `b` indicano la stessa occorrenza (stessa matchKey; data locale se uno dei due è un DATE). */
export function isSameOccurrence(a: IcsTime, b: IcsTime, masterType: 'date' | 'date-time', ctx: MatchContext): boolean {
  const type = masterType === 'date' || a.type === 'date' || b.type === 'date' ? 'date' : 'date-time';
  return matchKey(a, type, ctx) === matchKey(b, type, ctx);
}

/** Indice degli override di un oggetto, costruito una volta per espansione. */
export interface OverrideIndex {
  /**
   * Override che sostituisce l'occorrenza del master che inizia in
   * `occurrenceStart` (valore dello stesso tipo e zona del DTSTART del
   * master): indice in obj.overrides, o undefined. Per i duplicati restituisce
   * il vincitore (SEQUENCE più alta, a parità l'ultimo nel file). Un
   * RECURRENCE-ID DATE su un master DATE-TIME viene restituito per ogni
   * occorrenza di quella data: expandObject lo usa solo per la prima.
   */
  lookup(occurrenceStart: IcsTime): number | undefined;
  /** Indici degli override "ombra" (stesso RECURRENCE-ID di un vincitore). */
  readonly shadowed: readonly number[];
  /** Indici degli override con RECURRENCE-ID illeggibile: l'espansione li tratta come orfani. */
  readonly invalid: readonly number[];
  /** matchKey di ogni override valido (indice → chiave), per gli orfani e la diagnostica. */
  readonly keys: ReadonlyMap<number, string>;
}

// ============================================
// Lettura degli override (uso interno di expand e recurrence-ops)
// ============================================

/** Override letto per l'abbinamento. */
export interface OverrideInfo {
  index: number;
  component: IcsComponent;
  /** RECURRENCE-ID, o null se illeggibile. */
  rid: IcsTime | null;
  /** Istante del RECURRENCE-ID (DATE: mezzanotte locale nel fuso del calendario). */
  ridUtc: number | null;
  /** 'instant': abbinamento sull'istante; 'date': sulla data locale. null se illeggibile. */
  kind: 'instant' | 'date' | null;
  /** Istante al secondo (kind 'instant'). */
  sec: number | null;
  /** Data locale 'YYYY-MM-DD' (kind 'date'). */
  date: string | null;
  /** matchKey pubblica. */
  key: string | null;
  sequence: number;
  /** RECURRENCE-ID;RANGE=THISANDFUTURE (trattato come singola istanza). */
  thisAndFuture: boolean;
}

export interface OverrideSet {
  infos: OverrideInfo[];
  /** Vincitori per chiave (indici in obj.overrides), nell'ordine del file. */
  winners: number[];
  shadowed: number[];
  invalid: number[];
}

function sequenceOf(c: IcsComponent): number {
  const v = getProperty(c, 'SEQUENCE')?.value.trim() ?? '';
  return /^[+-]?\d{1,9}$/.test(v) ? Number(v) : 0;
}

/** True se `a` vince su `b` fra due override della stessa istanza: SEQUENCE più alta, a parità l'ultimo nel file. */
export function overrideWins(a: OverrideInfo, b: OverrideInfo): boolean {
  if (a.sequence !== b.sequence) return a.sequence > b.sequence;
  return a.index > b.index;
}

/** Tipo del DTSTART del master per l'abbinamento ('date-time' se manca o è illeggibile). */
export function masterTypeOf(obj: CalendarObject): 'date' | 'date-time' {
  const p = obj.master ? getProperty(obj.master, 'DTSTART') : null;
  if (!p) return 'date-time';
  try {
    return readTimeProperty(p).type;
  } catch {
    return 'date-time';
  }
}

/** Legge i RECURRENCE-ID e sceglie i vincitori fra gli override con la stessa chiave. */
export function readOverrides(obj: CalendarObject, masterType: 'date' | 'date-time', ctx: MatchContext): OverrideSet {
  const z = zctx(ctx);
  const infos: OverrideInfo[] = [];
  const invalid: number[] = [];
  const byKey = new Map<string, number>();
  const shadowed: number[] = [];
  obj.overrides.forEach((component, index) => {
    const info: OverrideInfo = {
      index,
      component,
      rid: null,
      ridUtc: null,
      kind: null,
      sec: null,
      date: null,
      key: null,
      sequence: sequenceOf(component),
      thisAndFuture: false,
    };
    infos.push(info);
    const p = getProperty(component, 'RECURRENCE-ID');
    if (!p) {
      invalid.push(index);
      return;
    }
    try {
      const rid = readTimeProperty(p);
      info.rid = rid;
      info.thisAndFuture = (p.params.find((x) => x.name === 'RANGE')?.values[0] ?? '').toUpperCase() === 'THISANDFUTURE';
      info.ridUtc = timeToUtcMs(rid, z);
      if (masterType === 'date' || rid.type === 'date') {
        info.kind = 'date';
        info.date = dateKeyOf(rid, z);
        info.key = compactDate(info.date);
      } else {
        info.kind = 'instant';
        info.sec = Math.floor(info.ridUtc / 1000);
        info.key = instantKeyOfMs(info.sec * 1000);
      }
    } catch {
      info.rid = null;
      info.kind = null;
      invalid.push(index);
      return;
    }
    const k = info.key as string;
    const prev = byKey.get(k);
    if (prev === undefined) {
      byKey.set(k, index);
    } else if (overrideWins(info, infos[prev])) {
      shadowed.push(prev);
      byKey.set(k, index);
    } else {
      shadowed.push(index);
    }
  });
  const winners = [...byKey.values()].sort((a, b) => a - b);
  return { infos, winners, shadowed: shadowed.sort((a, b) => a - b), invalid };
}

/** Costruisce l'indice degli override dell'oggetto (nessun override → indice vuoto). */
export function buildOverrideIndex(obj: CalendarObject, ctx: MatchContext): OverrideIndex {
  const masterType = masterTypeOf(obj);
  const set = readOverrides(obj, masterType, ctx);
  const z = zctx(ctx);
  const instant = new Map<string, number>();
  const date = new Map<string, number>();
  const keys = new Map<number, string>();
  for (const i of set.winners) {
    const info = set.infos[i];
    keys.set(i, info.key as string);
    if (info.kind === 'instant') instant.set(info.key as string, i);
    else date.set(info.date as string, i);
  }
  for (const i of set.shadowed) keys.set(i, set.infos[i].key as string);
  return {
    lookup(occurrenceStart: IcsTime): number | undefined {
      try {
        if (masterType === 'date' || occurrenceStart.type === 'date') return date.get(dateKeyOf(occurrenceStart, z));
        const hit = instant.get(instantKey(occurrenceStart, z));
        if (hit !== undefined || date.size === 0) return hit;
        return date.get(dateKeyOf(occurrenceStart, z));
      } catch {
        return undefined;
      }
    },
    shadowed: set.shadowed,
    invalid: set.invalid,
    keys,
  };
}

// ============================================
// Risoluzione: quale istanza del master sostituisce ogni override
// ============================================

/** Esito dell'abbinamento di un override vincitore. */
export type OverrideResolution =
  | { status: 'matched'; instance: SeriesInstance }
  | { status: 'orphan' }
  /** Appartenenza non decisa (budget esaurito o master non interpretabile): resta override, scelta prudente. */
  | { status: 'undetermined' };

/**
 * Abbina gli override vincitori alle istanze di una serie man mano che le
 * scansioni le offrono. Un'istanza è identificata dall'istante al secondo
 * (master DATE-TIME) o dalla data (master DATE). Se due override (uno per
 * istante e uno per data) colpiscono la stessa istanza vince quello con
 * SEQUENCE più alta, a parità l'ultimo nel file; l'altro diventa ombra.
 */
export class OverrideResolver {
  private readonly bySec = new Map<number, number[]>();
  private readonly byDate = new Map<string, number[]>();
  private readonly pending = new Set<number>();
  private readonly settled = new Map<number, OverrideResolution>();
  /** Istanza (secondo o data) → override che la sostituisce. */
  readonly replaced = new Map<number | string, number>();
  /** Override vincitori per chiave ma battuti da un altro override sulla stessa istanza. */
  readonly extraShadowed: number[] = [];

  constructor(
    private readonly set: OverrideSet,
    private readonly series: Series,
    private readonly ctx: ZoneContext,
  ) {
    for (const i of set.winners) {
      const info = set.infos[i];
      this.pending.add(i);
      if (info.kind === 'instant') push(this.bySec, info.sec as number, i);
      else push(this.byDate, info.date as string, i);
    }
  }

  /** Identità di un'istanza per `replaced` (Series.idOf). */
  instanceId(inst: SeriesInstance): number | string {
    return this.series.idOf(inst);
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingIndices(): number[] {
    return [...this.pending].sort((a, b) => a - b);
  }

  /**
   * Offre un'istanza. [coverStart, coverEnd] è l'intervallo (ms UTC) in cui
   * la scansione corrente produce TUTTE le istanze: un override per data si
   * abbina solo se la sua giornata è interamente coperta (serve la prima
   * istanza del giorno).
   */
  offer(inst: SeriesInstance, coverStart: number, coverEnd: number): void {
    if (this.pending.size === 0) return;
    if (this.series.spec.allDay) {
      const d = Series.wallDate(inst.wallMs);
      const list = this.byDate.get(d);
      if (list) {
        this.byDate.delete(d);
        for (const i of list) this.assign(i, inst);
      }
      return;
    }
    const sec = Math.floor(inst.utcMs / 1000);
    const list = this.bySec.get(sec);
    if (list) {
      this.bySec.delete(sec);
      for (const i of list) this.assign(i, inst);
    }
    if (this.byDate.size > 0) {
      const d = localDateOf(inst.utcMs, this.ctx.tz);
      const dl = this.byDate.get(d);
      if (dl && this.dayCovered(d, coverStart, coverEnd)) {
        this.byDate.delete(d);
        for (const i of dl) this.assign(i, inst);
      }
    }
  }

  private dayCovered(d: string, coverStart: number, coverEnd: number): boolean {
    return localMidnightUtcMs(d, this.ctx.tz) >= coverStart && localMidnightUtcMs(addDays(d, 1), this.ctx.tz) <= coverEnd;
  }

  private assign(i: number, inst: SeriesInstance): void {
    this.pending.delete(i);
    const id = this.instanceId(inst);
    const prev = this.replaced.get(id);
    if (prev !== undefined) {
      const a = this.set.infos[i];
      const b = this.set.infos[prev];
      if (overrideWins(a, b)) {
        this.settled.set(prev, { status: 'orphan' });
        this.extraShadowed.push(prev);
        this.replaced.set(id, i);
        this.settled.set(i, { status: 'matched', instance: inst });
      } else {
        this.settled.set(i, { status: 'orphan' });
        this.extraShadowed.push(i);
      }
      return;
    }
    this.replaced.set(id, i);
    this.settled.set(i, { status: 'matched', instance: inst });
  }

  /** Bersaglio (ms UTC) di un override: [inizio, fine] dell'istante o della giornata. */
  target(i: number): [number, number] {
    const info = this.set.infos[i];
    if (info.kind === 'instant') return [info.ridUtc as number, info.ridUtc as number];
    const d = info.date as string;
    if (this.series.spec.allDay) {
      const s = this.series.utcOf(dateWall(d));
      return [s, s];
    }
    return [localMidnightUtcMs(d, this.ctx.tz), localMidnightUtcMs(addDays(d, 1), this.ctx.tz)];
  }

  /** Dopo una scansione completa di [coverStart, coverEnd]: gli override con il bersaglio lì dentro e senza istanza sono orfani. */
  settleWithin(coverStart: number, coverEnd: number): void {
    for (const i of [...this.pending]) this.settleIfCovered(i, coverStart, coverEnd);
  }

  /** Come settleWithin per il solo override `i` (le scansioni mirate di resolvePending: costo lineare, non quadratico). */
  private settleIfCovered(i: number, coverStart: number, coverEnd: number): void {
    if (!this.pending.has(i)) return;
    const [a, b] = this.target(i);
    if (a >= coverStart && b <= coverEnd) {
      this.pending.delete(i);
      this.remove(i);
      this.settled.set(i, { status: 'orphan' });
    }
  }

  private remove(i: number): void {
    const info = this.set.infos[i];
    if (info.kind === 'instant') drop(this.bySec, info.sec as number, i);
    else drop(this.byDate, info.date as string, i);
  }

  /**
   * Risolve gli override ancora in sospeso con scansioni mirate attorno al
   * loro bersaglio (fast-forward senza COUNT; con COUNT una sola scansione dal
   * DTSTART fino all'ultimo bersaglio). Lancia ExpansionBudgetError se il
   * budget finisce: gli override non risolti restano 'undetermined'.
   */
  resolvePending(): void {
    if (this.pending.size === 0) return;
    const series = this.series;
    const margin = scanMarginMs(series.spec);
    if (series.canSeek) {
      for (const i of this.pendingIndices()) {
        if (!this.pending.has(i)) continue;
        const [a, b] = this.target(i);
        const seek = series.wallOf(a) - margin;
        const limit = series.wallOf(b) + margin;
        for (const inst of series.instances(seek, limit)) this.offer(inst, a, b);
        // Solo l'override cercato: gli altri in sospeso con il bersaglio in [a, b]
        // si chiudono nella propria scansione (rifare il giro di tutti i pending a
        // ogni override costava O(n²) con migliaia di orfani).
        this.settleIfCovered(i, a, b);
      }
      return;
    }
    let maxB = Number.NEGATIVE_INFINITY;
    for (const i of this.pending) maxB = Math.max(maxB, this.target(i)[1]);
    const limit = series.wallOf(maxB) + margin;
    for (const inst of series.instances(null, limit)) this.offer(inst, Number.NEGATIVE_INFINITY, maxB);
    this.settleWithin(Number.NEGATIVE_INFINITY, maxB);
  }

  /** Esito di un vincitore (gli override ancora in sospeso sono 'undetermined'). */
  resolution(i: number): OverrideResolution {
    return this.settled.get(i) ?? { status: 'undetermined' };
  }
}

function push<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function drop<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (!list) return;
  const rest = list.filter((x) => x !== value);
  if (rest.length) map.set(key, rest);
  else map.delete(key);
}

/** Ora da muro (ms) della mezzanotte di una data 'YYYY-MM-DD'. */
function dateWall(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return daysFromCivil(y, m, day) * DAY_MS;
}

// ============================================
// Orfani
// ============================================

export interface OrphanCheckOptions extends MatchContext {
  /** Iterazioni massime per verificare l'appartenenza (default EXPANSION_ITERATION_BUDGET). */
  iterationBudget?: number;
}

export interface OrphanCheckResult {
  /**
   * Override il cui RECURRENCE-ID non appartiene all'insieme delle istanze
   * del master (DTSTART ∪ RRULE ∪ RDATE; le EXDATE NON tolgono l'istanza,
   * perché un override su un'istanza esclusa prevale). Senza master, tutti
   * gli override sono orfani.
   */
  orphans: number[];
  /** Override con RECURRENCE-ID illeggibile. */
  invalid: number[];
  /** Override duplicati di un vincitore. */
  shadowed: number[];
  /**
   * Appartenenza non decisa per budget esaurito (o master non
   * interpretabile): NON classificati orfani (restano override, scelta
   * prudente) e segnalati.
   */
  undetermined: number[];
}

/**
 * Classifica gli override dell'oggetto indipendentemente da qualsiasi
 * finestra (per i badge dell'admin, l'anomalia ORPHAN_OVERRIDE_NOT_IN_RULE
 * della migrazione e il 409 sui target spariti di recurrence-ops). Non lancia
 * per dati sbagliati.
 */
export function findOrphanOverrides(obj: CalendarObject, opts: OrphanCheckOptions): OrphanCheckResult {
  const z = zctx(opts);
  const masterType = masterTypeOf(obj);
  const set = readOverrides(obj, masterType, z);
  if (!obj.master) {
    return { orphans: [...set.winners], invalid: set.invalid, shadowed: set.shadowed, undetermined: [] };
  }
  const read = readMasterSpec(obj.master, z);
  if (read.ok !== true) {
    return { orphans: [], invalid: set.invalid, shadowed: set.shadowed, undetermined: [...set.winners] };
  }
  const budget = new ExpansionBudget(opts.iterationBudget ?? DEFAULT_ITERATION_BUDGET);
  const series = new Series(read.spec, z, budget);
  const resolver = new OverrideResolver(set, series, z);
  try {
    resolver.resolvePending();
  } catch (err) {
    // Budget esaurito, o regola che il motore rifiuta durante l'iterazione:
    // gli override non risolti restano 'undetermined'.
    if (!(err instanceof ExpansionBudgetError) && !(err instanceof RecurRuleError)) throw err;
  }
  const orphans: number[] = [];
  const undetermined: number[] = [];
  const extra = new Set(resolver.extraShadowed);
  for (const i of set.winners) {
    if (extra.has(i)) continue;
    const r = resolver.resolution(i);
    if (r.status === 'orphan') orphans.push(i);
    else if (r.status === 'undetermined') undetermined.push(i);
  }
  return {
    orphans,
    invalid: set.invalid,
    shadowed: [...set.shadowed, ...resolver.extraShadowed].sort((a, b) => a - b),
    undetermined,
  };
}
