/**
 * Espansione delle occorrenze (design §6.4, §6.5, §6.9, §9).
 *
 * Principi:
 * - Abbinamento proprio degli override (override-match.ts), non quello
 *   implicito di ical.js: tollerante al tipo (DATE contro DATE-TIME
 *   confrontati sulla data locale nel fuso del calendario).
 * - Override non abbinati → occorrenze autonome `orphan_override`, bloccanti
 *   secondo le proprie proprietà, con avviso: non spariscono più dal busy.
 * - Tetto: al massimo `maxOccurrences` (5000) occorrenze per oggetto contate
 *   SOLO dentro la finestra; per raggiungere la finestra c'è un budget
 *   separato di `iterationBudget` (200k) iterazioni. Il motore (recur.ts, lo
 *   stesso algoritmo di python-dateutil, usato da rrule.js nel codice legacy e
 *   da Radicale) salta in modo esatto ai periodi vicini alla finestra quando
 *   la regola non ha COUNT: una DAILY dal 2010 arriva alla settimana corrente
 *   in poche iterazioni, una HOURLY o MINUTELY infinita si ferma al tetto
 *   (materializedUntil) senza esaurire il budget. Con COUNT si conta dal
 *   DTSTART (RFC 5545), quindi le iterazioni partono da lì.
 * - Budget esaurito → `health: 'quarantined'`, `healthReason:
 *   'expansion-budget'` e una sola occorrenza `conservative` su
 *   [max(DTSTART, from), min(UNTIL, to)), bloccante solo se il master
 *   bloccherebbe (model.computeBlocks con le proprietà del master).
 * - Oltre `maxOccurrences` nella finestra → `materializedUntil` = inizio della
 *   prima occorrenza non materializzata; le decisioni oltre quella data
 *   richiamano expandObject sulla sola finestra richiesta.
 * - Mai un'eccezione per dati sbagliati: RRULE invalida, TZID rotto, DTSTART
 *   illeggibile finiscono in `health`/`healthReason` (con occorrenza
 *   conservativa quando l'intervallo è noto) e in `warnings`. Lancia solo
 *   CalendarCoreError('INTERNAL') per difetti del codice (o una finestra non
 *   valida, che è un difetto del chiamante).
 *
 * Le recurrence key delle occorrenze restituite sono uniche per oggetto
 * (cal_occurrences ha PRIMARY KEY (object_id, recurrence_key)) e le
 * occorrenze all-day hanno sempre endDate > startDate.
 */

import { addDays, compareDates, type DateString, isLocalMidnight, localDateOf, localMidnightUtcMs } from './allday';
import { CalendarCoreError } from './errors';
import {
  addDurationToTime,
  type CalendarObject,
  CONSERVATIVE_RECURRENCE_KEY,
  type ExpansionKind,
  formatTimeValue,
  getProperty,
  type IcsComponent,
  type IcsDuration,
  type IcsTime,
  MASTER_RECURRENCE_KEY,
  parseDurationValue,
  parseTimeValue,
  readTimeProperty,
  recurrenceKeyOf,
  timeToUtcMs,
  type ZoneContext,
} from './model';
import {
  masterTypeOf,
  type OverrideInfo,
  OverrideResolver,
  type OverrideSet,
  readOverrides,
} from './override-match';
import {
  DAY_MS,
  DEFAULT_ITERATION_BUDGET,
  ExpansionBudget,
  ExpansionBudgetError,
  HOUR_MS,
  type MasterSpec,
  readMasterSpec,
  RecurRuleError,
  scanMarginMs,
  Series,
  type SeriesInstance,
  typedLikeStart,
} from './recur';
import { DEFAULT_TZ, ianaZone, isValidIanaZone, resolveTzid, zonedToUtc } from './tz-registry';

/** Occorrenze massime materializzate per oggetto dentro la finestra (design §6.4). */
export const MAX_OCCURRENCES_PER_OBJECT = 5000;

/** Iterazioni massime dell'iteratore di ricorrenza per oggetto (design §6.4). */
export const EXPANSION_ITERATION_BUDGET = DEFAULT_ITERATION_BUDGET;

export interface ExpandOptions {
  /** Inizio della finestra (incluso), ms UTC. Per l'indice: horizon_start (oggi − 400 g). */
  from: number;
  /** Fine della finestra (esclusa), ms UTC. Per l'indice: horizon_end (oggi + 800 g). */
  to: number;
  /** Fuso IANA del calendario: interpreta floating, DATE e TZID sconosciuti. */
  tz: string;
  /** Default MAX_OCCURRENCES_PER_OBJECT. */
  maxOccurrences?: number;
  /** Default EXPANSION_ITERATION_BUDGET. */
  iterationBudget?: number;
  /**
   * Default true. Con false le serie con COUNT non vengono iterate oltre la
   * finestra solo per calcolare `rangeEnd` (che resta null se la fine non è
   * stata raggiunta): è la scelta per l'espansione al volo su finestre
   * piccole (busy oltre materializedUntil, admin fuori orizzonte), dove
   * rangeEnd non serve.
   */
  computeRangeEnd?: boolean;
}

/** Riferimento al componente che fornisce le proprietà dell'occorrenza. */
export type OccurrenceSource = { type: 'master' } | { type: 'override'; index: number };

export interface ExpandedOccurrence {
  /**
   * Recurrence key canonica (model.recurrenceKeyOf) dell'occorrenza del
   * master che rappresenta, calcolata sul tipo del DTSTART del master;
   * MASTER_RECURRENCE_KEY per un evento singolo; per un orfano, la chiave del
   * suo RECURRENCE-ID; CONSERVATIVE_RECURRENCE_KEY per l'occorrenza
   * `conservative` di un oggetto in quarantena. Unica nell'esito.
   */
  recurrenceKey: string;
  kind: ExpansionKind;
  source: OccurrenceSource;
  /** Inizio, ms UTC (all-day: mezzanotte locale nel fuso del calendario). */
  startUtc: number;
  /** Fine esclusiva, ms UTC, ≥ startUtc (durata nulla ammessa). */
  endUtc: number;
  allDay: boolean;
  /** All-day: data di inizio; null per i timed. */
  startDate: DateString | null;
  /** All-day: data di fine esclusiva (sempre > startDate); null per i timed. */
  endDate: DateString | null;
  /** STATUS del componente sorgente in maiuscolo, o null se assente. */
  status: string | null;
  /** TRANSP esplicito del componente sorgente in maiuscolo, o null se assente. */
  transp: string | null;
  /**
   * Override e orfani: inizio dell'occorrenza originale (ms UTC). Per un
   * override abbinato è l'inizio dell'occorrenza del master che sostituisce
   * (coincide con il RECURRENCE-ID quando i tipi coincidono); per un orfano è
   * l'istante del suo RECURRENCE-ID. Null per le occorrenze del master e per
   * i singoli.
   */
  originalStartUtc: number | null;
}

export type ExpansionHealthReason =
  /** Budget di iterazioni esaurito prima di coprire la finestra. */
  | 'expansion-budget'
  /** RRULE non interpretabile o con valori vietati: conservativa su [max(DTSTART, from), to). */
  | 'invalid-rrule'
  /** DTSTART, DTEND, DURATION, RECURRENCE-ID o RDATE illeggibili (model.readEvent fatale). */
  | 'invalid-value'
  /** VTIMEZONE referenziato non interpretabile. */
  | 'invalid-timezone';

export type ExpandWarningCode =
  | 'ORPHAN_OVERRIDE'
  | 'DUPLICATE_RECURRENCE_ID'
  | 'RANGE_THISANDFUTURE_IGNORED'
  | 'EXDATE_TYPE_MISMATCH'
  | 'UNKNOWN_TZID'
  | 'MULTIPLE_RRULE'
  | 'MAX_OCCURRENCES'
  | 'EXPANSION_BUDGET'
  /** Override con RECURRENCE-ID o tempi illeggibili: trattato come orfano o con i tempi dell'istanza. */
  | 'INVALID_OVERRIDE'
  /** EXDATE illeggibile, ignorata (più occorrenze, quindi più busy). */
  | 'INVALID_EXDATE'
  /** RDATE di tipo diverso da DTSTART, convertita al tipo del DTSTART. */
  | 'RDATE_TYPE_MISMATCH'
  /** UNTIL di tipo diverso da DTSTART (un DATE su un master DATE-TIME include tutta la giornata). */
  | 'UNTIL_TYPE_MISMATCH'
  /** RRULE con parti ignorate o combinazioni vietate da RFC 5545 (vedi messaggio). */
  | 'RRULE_NONSTANDARD'
  /**
   * BYDAY con giorni semplici e ordinali in MONTHLY/YEARLY (es. BYDAY=MO,1FR):
   * vale l'unione (RFC 5545, come i device); il legacy (rrule.js) e Radicale
   * (dateutil) richiedono entrambe le forme e non ne mostrano le occorrenze.
   */
  | 'MIXED_BYDAY'
  /** DTSTART non soddisfa la regola: resta la prima occorrenza (RFC 5545), dateutil e il legacy la scartano. */
  | 'DTSTART_NOT_IN_RULE'
  /** DTEND precedente a DTSTART: durata nulla. */
  | 'END_BEFORE_START';

export interface ExpandWarning {
  code: ExpandWarningCode;
  message: string;
  recurrenceKey?: string;
}

export interface ExpansionResult {
  /** Occorrenze che si sovrappongono alla finestra, ordinate per startUtc e poi per recurrenceKey. */
  occurrences: ExpandedOccurrence[];
  /** True se il master ha RRULE o RDATE. */
  isRecurring: boolean;
  health: 'ok' | 'quarantined';
  healthReason: ExpansionHealthReason | null;
  /** Istante (ms UTC, escluso) fino al quale le occorrenze sono complete quando il tetto le ha troncate; null se complete. */
  materializedUntil: number | null;
  /**
   * Inizio della prima occorrenza dell'oggetto, anche fuori finestra
   * (cal_objects.range_start); null se ignoto. È il DTSTART (o una RDATE o un
   * override precedenti), anche se un'EXDATE esclude la prima istanza: un
   * limite inferiore.
   */
  rangeStart: number | null;
  /**
   * Fine dell'ultima occorrenza (cal_objects.range_end); null se la serie è
   * illimitata o la fine è ignota. Esatta per i singoli, le serie solo RDATE
   * e quelle concluse dentro la scansione; per una serie con UNTIL conclusa
   * fuori dalla scansione è il limite superiore UNTIL + durata.
   */
  rangeEnd: number | null;
  /** Iterazioni consumate (metriche e test del budget). */
  iterations: number;
  warnings: ExpandWarning[];
}

// ============================================
// Espansione
// ============================================

/** Margine dopo l'occorrenza che fa scattare il tetto: copre l'inversione d'ordine dei soli orari nel buco del cambio d'ora. */
const TRUNCATION_MARGIN_MS = 3 * HOUR_MS;

/**
 * Espande un oggetto calendario nella finestra [from, to).
 *
 * Comportamento:
 * - include le occorrenze che si SOVRAPPONGONO alla finestra (inizio < to e
 *   fine > from), comprese quelle iniziate prima di `from` e ancora in corso;
 *   un'occorrenza a durata nulla è inclusa se from ≤ inizio < to;
 * - master non ricorrente: una sola occorrenza (kind 'event', chiave
 *   MASTER_RECURRENCE_KEY);
 * - serie: DTSTART (sempre prima occorrenza, RFC 5545) ∪ RRULE (la prima; le
 *   altre → avviso MULTIPLE_RRULE) ∪ RDATE (anche PERIOD, con la propria
 *   durata) − EXDATE. EXDATE tollerante al tipo: un DATE su un master
 *   DATE-TIME esclude le occorrenze di quella data locale, un DATE-TIME su un
 *   master DATE esclude la data locale dell'istante (avviso
 *   EXDATE_TYPE_MISMATCH);
 * - UNTIL inclusivo; COUNT contato dal DTSTART (non dalla finestra);
 * - ora da muro nel fuso del DTSTART: la serie non slitta al cambio d'ora;
 *   orari inesistenti o ambigui secondo RFC 5545 (tz-registry.zonedToUtc);
 *   floating e DATE nel fuso del calendario;
 * - durata delle istanze: DURATION se presente (giorni nominali, ore
 *   esatte), altrimenti DTEND − DTSTART (durata esatta, RFC 5545 §3.8.5.3);
 *   senza entrambe, nulla per i timed e un giorno per gli all-day;
 * - override abbinati (override-match.ts): sostituiscono l'occorrenza del
 *   master con le proprie proprietà (kind 'override'), anche se spostati
 *   fuori finestra (allora l'occorrenza del master sparisce dalla finestra);
 *   un override STATUS:CANCELLED resta come occorrenza con status CANCELLED
 *   (non blocca, serve all'admin e al feed); un override su un'istanza
 *   esclusa da EXDATE resta un override (prevale, come ical.js e Google); un
 *   override senza DTEND né DURATION eredita la durata del master;
 * - override non abbinati: kind 'orphan_override' con le proprie proprietà e
 *   avviso ORPHAN_OVERRIDE; se l'appartenenza non si può decidere (budget)
 *   restano 'override' (scelta prudente);
 * - override duplicati (stesso RECURRENCE-ID): vince quello con SEQUENCE più
 *   alta, a parità l'ultimo nel file (avviso DUPLICATE_RECURRENCE_ID);
 * - RANGE=THISANDFUTURE: trattato come override della sola istanza (avviso
 *   RANGE_THISANDFUTURE_IGNORED);
 * - tetto e budget come descritti in testa al modulo.
 */
export function expandObject(obj: CalendarObject, opts: ExpandOptions): ExpansionResult {
  if (!Number.isFinite(opts.from) || !Number.isFinite(opts.to) || opts.from > opts.to) {
    throw new CalendarCoreError('INTERNAL', 'expandObject: finestra non valida', { from: opts.from, to: opts.to });
  }
  const warnings: ExpandWarning[] = [];
  let tz = opts.tz;
  if (!tz || !isValidIanaZone(tz)) {
    warnings.push({ code: 'UNKNOWN_TZID', message: `Fuso del calendario "${String(tz).slice(0, 60)}" sconosciuto: usato ${DEFAULT_TZ}` });
    tz = DEFAULT_TZ;
  }
  const budget = new ExpansionBudget(Math.max(1, Math.floor(opts.iterationBudget ?? EXPANSION_ITERATION_BUDGET)));
  const expander = new Expander(obj, {
    from: opts.from,
    to: opts.to,
    ctx: { tz, timezones: obj.timezones },
    maxOccurrences: Math.max(1, Math.floor(opts.maxOccurrences ?? MAX_OCCURRENCES_PER_OBJECT)),
    budget,
    computeRangeEnd: opts.computeRangeEnd !== false,
    warnings,
  });
  try {
    return expander.run();
  } catch (err) {
    if (err instanceof CalendarCoreError && err.code === 'INTERNAL') throw err;
    throw new CalendarCoreError('INTERNAL', `expandObject: ${err instanceof Error ? err.message : String(err)}`, { context: 'expandObject' });
  }
}

interface ExpanderOptions {
  from: number;
  to: number;
  ctx: ZoneContext;
  maxOccurrences: number;
  budget: ExpansionBudget;
  computeRangeEnd: boolean;
  warnings: ExpandWarning[];
}

/** Tempi propri di un componente, letti senza eccezioni. */
interface OwnTiming {
  start: IcsTime;
  startUtc: number;
  end: IcsTime | null;
  duration: IcsDuration | null;
  /** True se DTEND/DUE o DURATION c'erano ma erano illeggibili. */
  brokenEnd: boolean;
}

function upper(c: IcsComponent, name: string): string | null {
  const p = getProperty(c, name);
  if (!p) return null;
  const v = p.value.replace(/\\(.)/g, '$1').trim().toUpperCase();
  return v || null;
}

class Expander {
  private readonly obj: CalendarObject;
  private readonly from: number;
  private readonly to: number;
  private readonly ctx: ZoneContext;
  private readonly maxOcc: number;
  private readonly budget: ExpansionBudget;
  private readonly computeRangeEnd: boolean;
  private readonly warnings: ExpandWarning[];
  private readonly keys = new Set<string>();

  constructor(obj: CalendarObject, o: ExpanderOptions) {
    this.obj = obj;
    this.from = o.from;
    this.to = o.to;
    this.ctx = o.ctx;
    this.maxOcc = o.maxOccurrences;
    this.budget = o.budget;
    this.computeRangeEnd = o.computeRangeEnd;
    this.warnings = o.warnings;
  }

  private warn(code: ExpandWarningCode, message: string, recurrenceKey?: string): void {
    this.warnings.push(recurrenceKey === undefined ? { code, message } : { code, message, recurrenceKey });
  }

  private overlaps(start: number, end: number): boolean {
    if (start >= this.to) return false;
    return end > this.from || (end === start && start >= this.from);
  }

  run(): ExpansionResult {
    const obj = this.obj;
    const masterType = masterTypeOf(obj);
    const set = readOverrides(obj, masterType, this.ctx);
    for (const i of set.shadowed) {
      this.warn('DUPLICATE_RECURRENCE_ID', 'Override duplicato: vale quello con SEQUENCE più alta (a parità l\'ultimo)', set.infos[i].key ?? undefined);
    }
    for (let k = 0; k < set.invalid.length; k++) this.warn('INVALID_OVERRIDE', 'Override con RECURRENCE-ID illeggibile: trattato come orfano');
    for (const i of set.winners) {
      if (set.infos[i].thisAndFuture) {
        this.warn('RANGE_THISANDFUTURE_IGNORED', 'RANGE=THISANDFUTURE: override della sola istanza', set.infos[i].key ?? undefined);
      }
    }
    if (!obj.master) return this.overridesOnly(set);
    const read = readMasterSpec(obj.master, this.ctx);
    if (read.ok === 'no-start') return this.overridesOnly(set);
    if (read.ok === false) {
      for (const w of read.warnings) this.warn(w.code, w.message);
      return this.quarantine(read.reason, read.message, {
        start: read.approxStartUtc,
        end: read.approxEndUtc,
        recurring: read.recurring,
        allDay: read.allDay,
        status: read.status,
        transp: read.transp,
        set,
        master: null,
      });
    }
    const spec = read.spec;
    for (const w of spec.warnings) this.warn(w.code, w.message);
    return this.expandSeries(spec, set);
  }

  // ─── Oggetto senza master: solo override (tutti orfani) ───

  private overridesOnly(set: OverrideSet): ExpansionResult {
    const occurrences: ExpandedOccurrence[] = [];
    let rangeStart: number | null = null;
    let rangeEnd: number | null = null;
    let readable = 0;
    for (const i of [...set.winners, ...set.invalid].sort((a, b) => a - b)) {
      const info = set.infos[i];
      const occ = this.overrideOccurrence(info, null, null, null, 'orphan_override');
      if (!occ) continue;
      readable++;
      rangeStart = rangeStart == null ? occ.startUtc : Math.min(rangeStart, occ.startUtc);
      rangeEnd = rangeEnd == null ? occ.endUtc : Math.max(rangeEnd, occ.endUtc);
      this.warn('ORPHAN_OVERRIDE', 'Override senza master: occorrenza autonoma', occ.recurrenceKey);
      if (this.overlaps(occ.startUtc, occ.endUtc) && this.claim(occ.recurrenceKey)) occurrences.push(occ);
    }
    const quarantined = this.obj.overrides.length > 0 && readable === 0;
    return this.result(occurrences, {
      isRecurring: false,
      health: quarantined ? 'quarantined' : 'ok',
      healthReason: quarantined ? 'invalid-value' : null,
      materializedUntil: null,
      rangeStart,
      rangeEnd,
    });
  }

  // ─── Quarantena con occorrenza conservativa ───

  private quarantine(
    reason: 'expansion-budget' | 'invalid-rrule' | 'invalid-value' | 'invalid-timezone',
    message: string,
    q: {
      start: number | null;
      end: number | null;
      recurring: boolean;
      allDay: boolean;
      status: string | null;
      transp: string | null;
      set: OverrideSet;
      master: MasterSpec | null;
    },
  ): ExpansionResult {
    if (reason === 'expansion-budget') this.warn('EXPANSION_BUDGET', message);
    const occurrences: ExpandedOccurrence[] = [];
    if (q.start != null) {
      let start = Math.max(q.start, this.from);
      let end = Math.min(q.end ?? this.to, this.to);
      // Gli override che cadono nella finestra allargano il blocco (il busy non perde gli spostamenti).
      for (const i of q.set.winners) {
        const occ = this.overrideOccurrence(q.set.infos[i], q.master, null, null, 'override');
        if (!occ || !this.overlaps(occ.startUtc, occ.endUtc)) continue;
        start = Math.min(start, Math.max(occ.startUtc, this.from));
        end = Math.max(end, Math.min(occ.endUtc, this.to));
      }
      if (end > start) {
        const occ: ExpandedOccurrence = {
          recurrenceKey: CONSERVATIVE_RECURRENCE_KEY,
          kind: 'conservative',
          source: { type: 'master' },
          startUtc: start,
          endUtc: end,
          allDay: false,
          startDate: null,
          endDate: null,
          status: q.status,
          transp: q.transp,
          originalStartUtc: null,
        };
        if (q.allDay) {
          const sd = localDateOf(start, this.ctx.tz);
          let ed = isLocalMidnight(end, this.ctx.tz) ? localDateOf(end, this.ctx.tz) : addDays(localDateOf(end, this.ctx.tz), 1);
          if (compareDates(ed, sd) <= 0) ed = addDays(sd, 1);
          occ.allDay = true;
          occ.startDate = sd;
          occ.endDate = ed;
          occ.startUtc = localMidnightUtcMs(sd, this.ctx.tz);
          occ.endUtc = localMidnightUtcMs(ed, this.ctx.tz);
        }
        occurrences.push(occ);
      }
    }
    return this.result(occurrences, {
      isRecurring: q.recurring,
      health: 'quarantined',
      healthReason: reason,
      materializedUntil: null,
      rangeStart: q.start,
      rangeEnd: q.end,
    });
  }

  // ─── Serie ───

  private expandSeries(spec: MasterSpec, set: OverrideSet): ExpansionResult {
    const series = new Series(spec, this.ctx, this.budget);
    const isRecurring = Boolean(spec.rule) || spec.rdates.length > 0;
    const quarantineFrom = (reason: 'expansion-budget' | 'invalid-rrule', message: string): ExpansionResult =>
      this.quarantine(reason, message, {
        start: spec.dtstartUtcMs,
        end: series.untilUpperUtc != null ? series.untilUpperUtc + series.maxDurationMs() : spec.rule ? null : spec.dtstartUtcMs + series.maxDurationMs(),
        recurring: isRecurring,
        allDay: spec.allDay,
        status: spec.status,
        transp: spec.transp,
        set,
        master: spec,
      });

    try {
      if (spec.rule && !series.dtstartInRule()) {
        this.warn('DTSTART_NOT_IN_RULE', 'DTSTART non soddisfa la RRULE: resta la prima occorrenza (RFC 5545)');
      }
    } catch (err) {
      if (err instanceof RecurRuleError) return quarantineFrom('invalid-rrule', err.message);
      if (err instanceof ExpansionBudgetError) return quarantineFrom('expansion-budget', err.message);
      throw err;
    }

    const resolver = new OverrideResolver(set, series, this.ctx);
    const margin = scanMarginMs(spec);
    const maxDur = series.maxDurationMs();
    const scanStartUtc = this.from - maxDur - margin;
    const scanEndUtc = this.to + margin;
    const canSeek = series.canSeek;
    const seekWall = canSeek && scanStartUtc > spec.dtstartUtcMs ? series.wallOf(scanStartUtc) : null;
    const coverStart = seekWall == null ? Number.NEGATIVE_INFINITY : scanStartUtc + margin;
    const windowLimitWall = series.wallOf(scanEndUtc);
    // Senza fast-forward (COUNT, o nessuna RRULE) una sola passata dal DTSTART:
    // prosegue fino alla fine della serie (rangeEnd) o almeno fino all'ultimo
    // RECURRENCE-ID degli override.
    let passLimitWall = windowLimitWall;
    if (!canSeek) {
      if (this.computeRangeEnd || !spec.rule) {
        passLimitWall = Number.POSITIVE_INFINITY;
      } else {
        for (const i of resolver.pendingIndices()) {
          passLimitWall = Math.max(passLimitWall, series.wallOf(resolver.target(i)[1]) + margin);
        }
      }
    }

    const masterOccs: ExpandedOccurrence[] = [];
    const state = { completed: false };
    let truncateWall: number | null = null;
    let windowCovered = false;
    let maxInstanceEnd = Number.NEGATIVE_INFINITY;
    let seenInstances = 0;
    let lastWall = Number.NEGATIVE_INFINITY;
    let failure: 'budget' | 'rule' | null = null;
    let failureMessage = '';
    const nonRecurring = !isRecurring;
    try {
      for (const inst of series.instances(seekWall, passLimitWall, state)) {
        lastWall = Math.max(lastWall, inst.wallMs);
        if (inst.wallMs > windowLimitWall) windowCovered = true;
        if (truncateWall != null && inst.wallMs > truncateWall) {
          windowCovered = true;
          // Con il fast-forward le istanze oltre il tetto non servono più; senza, si prosegue solo per override e fine.
          if (canSeek || !(this.computeRangeEnd || resolver.hasPending)) break;
        }
        seenInstances++;
        resolver.offer(inst, coverStart, Number.POSITIVE_INFINITY);
        const end = series.endUtcOf(inst);
        if (end > maxInstanceEnd) maxInstanceEnd = end;
        if (resolver.replaced.has(series.idOf(inst))) continue;
        if (series.isExcluded(inst)) continue;
        if (truncateWall != null && inst.wallMs > truncateWall) continue;
        if (!this.overlaps(inst.utcMs, end)) continue;
        masterOccs.push(this.masterOccurrence(series, inst, end, nonRecurring));
        if (truncateWall == null && masterOccs.length > this.maxOcc) truncateWall = inst.wallMs + TRUNCATION_MARGIN_MS;
      }
      if (state.completed) windowCovered = true;
    } catch (err) {
      if (err instanceof ExpansionBudgetError) failure = 'budget';
      else if (err instanceof RecurRuleError) failure = 'rule';
      else throw err;
      failureMessage = err instanceof Error ? err.message : String(err);
    }
    if (failure === 'rule') return quarantineFrom('invalid-rrule', failureMessage);
    if (failure === 'budget' && !windowCovered) return quarantineFrom('expansion-budget', failureMessage);

    // Override con il bersaglio dentro la parte scandita: senza istanza sono orfani.
    const coveredUntil = state.completed
      ? Number.POSITIVE_INFINITY
      : failure
        ? series.utcOf(lastWall) - margin
        : truncateWall != null && canSeek
          ? series.utcOf(truncateWall - TRUNCATION_MARGIN_MS)
          : series.utcOf(passLimitWall === Number.POSITIVE_INFINITY ? lastWall : passLimitWall) - margin;
    resolver.settleWithin(coverStart, coveredUntil);
    let undetermined = 0;
    if (resolver.hasPending && canSeek && !failure) {
      try {
        resolver.resolvePending();
      } catch (err) {
        if (!(err instanceof ExpansionBudgetError) && !(err instanceof RecurRuleError)) throw err;
      }
    }

    // Override.
    const overrideOccs: ExpandedOccurrence[] = [];
    const extra = new Set(resolver.extraShadowed);
    for (const i of resolver.extraShadowed) {
      this.warn('DUPLICATE_RECURRENCE_ID', 'Due override sulla stessa istanza: vale quello con SEQUENCE più alta (a parità l\'ultimo)', set.infos[i].key ?? undefined);
    }
    let rangeStart: number | null = spec.dtstartUtcMs;
    for (const r of spec.rdates) rangeStart = Math.min(rangeStart, series.utcOf(r.wallMs));
    let overridesEnd = Number.NEGATIVE_INFINITY;
    for (const i of set.winners) {
      if (extra.has(i)) continue;
      const info = set.infos[i];
      const res = resolver.resolution(i);
      if (res.status === 'undetermined') undetermined++;
      const occ = this.overrideOccurrence(info, spec, series, res.status === 'matched' ? res.instance : null, res.status === 'orphan' ? 'orphan_override' : 'override');
      if (!occ) continue;
      rangeStart = Math.min(rangeStart, occ.startUtc);
      overridesEnd = Math.max(overridesEnd, occ.endUtc);
      if (res.status === 'orphan') this.warn('ORPHAN_OVERRIDE', 'RECURRENCE-ID fuori dalla regola: occorrenza autonoma', occ.recurrenceKey);
      if (this.overlaps(occ.startUtc, occ.endUtc)) overrideOccs.push(occ);
    }
    // RECURRENCE-ID illeggibili: orfani con i propri tempi.
    for (const i of set.invalid) {
      const occ = this.overrideOccurrence(set.infos[i], spec, series, null, 'orphan_override');
      if (!occ) continue;
      rangeStart = Math.min(rangeStart, occ.startUtc);
      overridesEnd = Math.max(overridesEnd, occ.endUtc);
      if (this.overlaps(occ.startUtc, occ.endUtc)) overrideOccs.push(occ);
    }
    if (undetermined > 0) {
      this.warn('EXPANSION_BUDGET', `Appartenenza alla regola non decisa per ${undetermined} override (budget esaurito): restano override`);
    }

    // Unione, chiavi uniche, tetto.
    const all: ExpandedOccurrence[] = [];
    for (const occ of masterOccs) {
      this.keys.add(occ.recurrenceKey);
      all.push(occ);
    }
    for (const occ of overrideOccs) {
      if (this.claim(occ.recurrenceKey)) all.push(occ);
      else this.warn('INVALID_OVERRIDE', 'Override con la stessa chiave di un\'altra occorrenza: ignorato', occ.recurrenceKey);
    }
    sortOccurrences(all);
    let materializedUntil: number | null = null;
    let occurrences = all;
    if (all.length > this.maxOcc) {
      materializedUntil = all[this.maxOcc].startUtc;
      occurrences = all.filter((o) => o.startUtc < (materializedUntil as number));
      this.warn('MAX_OCCURRENCES', `Oltre ${this.maxOcc} occorrenze nella finestra: materializzate fino a ${new Date(materializedUntil).toISOString()}`);
    }

    // Fine dell'oggetto.
    let rangeEnd: number | null;
    if (!isRecurring) {
      rangeEnd = Math.max(maxInstanceEnd, overridesEnd);
    } else if (!series.bounded) {
      rangeEnd = null;
    } else if (state.completed && (seekWall == null || seenInstances > 0)) {
      rangeEnd = Math.max(maxInstanceEnd, overridesEnd);
    } else if (series.untilUpperUtc != null) {
      let end = series.untilUpperUtc + maxDur;
      spec.rdates.forEach((r, index) => {
        end = Math.max(end, series.endUtcOf({ wallMs: r.wallMs, utcMs: series.utcOf(r.wallMs), rdate: index }));
      });
      rangeEnd = Math.max(end, overridesEnd);
    } else {
      rangeEnd = null;
    }
    if (rangeEnd != null && !Number.isFinite(rangeEnd)) rangeEnd = null;
    if (rangeEnd != null && rangeStart != null && rangeEnd < rangeStart) rangeEnd = rangeStart;

    return this.result(occurrences, {
      isRecurring,
      health: 'ok',
      healthReason: null,
      materializedUntil,
      rangeStart,
      rangeEnd,
    });
  }

  private masterOccurrence(series: Series, inst: SeriesInstance, end: number, single: boolean): ExpandedOccurrence {
    const spec = series.spec;
    const occ: ExpandedOccurrence = {
      recurrenceKey: single ? MASTER_RECURRENCE_KEY : series.keyOf(inst),
      kind: 'event',
      source: { type: 'master' },
      startUtc: inst.utcMs,
      endUtc: Math.max(end, inst.utcMs),
      allDay: spec.allDay,
      startDate: null,
      endDate: null,
      status: spec.status,
      transp: spec.transp,
      originalStartUtc: null,
    };
    if (spec.allDay) {
      occ.startDate = Series.wallDate(inst.wallMs);
      occ.endDate = series.endDateOf(inst);
      if (inst.rdate >= 0 && spec.rdates[inst.rdate].periodEndUtc != null) {
        // PERIOD su un all-day non ha senso: vale la durata del master (avviso già emesso).
        occ.endUtc = localMidnightUtcMs(occ.endDate, this.ctx.tz);
      }
    }
    return occ;
  }

  /** Prenota una recurrence key nell'esito; false se già presa. */
  private claim(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }

  /** Tempi propri di un override (o null se DTSTART manca o è illeggibile). */
  private ownTiming(c: IcsComponent): OwnTiming | null {
    let start: IcsTime;
    let startUtc: number;
    try {
      const p = getProperty(c, 'DTSTART');
      if (!p) return null;
      start = readTimeProperty(p);
      startUtc = timeToUtcMs(start, this.ctx);
    } catch {
      return null;
    }
    let end: IcsTime | null = null;
    let duration: IcsDuration | null = null;
    let brokenEnd = false;
    try {
      const e = getProperty(c, c.name === 'VTODO' ? 'DUE' : 'DTEND');
      if (e) {
        end = readTimeProperty(e);
        timeToUtcMs(end, this.ctx);
      }
    } catch {
      end = null;
      brokenEnd = true;
    }
    if (!end) {
      try {
        const d = getProperty(c, 'DURATION');
        if (d) duration = parseDurationValue(d.value, 'DURATION');
      } catch {
        duration = null;
        brokenEnd = true;
      }
    }
    return { start, startUtc, end, duration, brokenEnd };
  }

  /**
   * Occorrenza di un override: tempi propri (DTSTART/DTEND/DURATION; senza
   * fine, la durata del master), altrimenti quelli dell'istanza abbinata o
   * del RECURRENCE-ID. null se non c'è alcun tempo utilizzabile.
   */
  private overrideOccurrence(
    info: OverrideInfo,
    spec: MasterSpec | null,
    series: Series | null,
    instance: SeriesInstance | null,
    kind: 'override' | 'orphan_override',
  ): ExpandedOccurrence | null {
    const c = info.component;
    const tz = this.ctx.tz;
    const own = this.ownTiming(c);
    if (own?.brokenEnd) this.warn('INVALID_OVERRIDE', 'Override con DTEND o DURATION illeggibili: durata del master', info.key ?? undefined);
    let startUtc: number;
    let endUtc: number;
    let allDay: boolean;
    let startDate: string | null = null;
    let endDate: string | null = null;
    if (!own) {
      if (instance && series) {
        startUtc = instance.utcMs;
        endUtc = series.endUtcOf(instance);
        allDay = series.spec.allDay;
        if (allDay) {
          startDate = Series.wallDate(instance.wallMs);
          endDate = series.endDateOf(instance);
        }
      } else if (info.rid && info.ridUtc != null) {
        startUtc = info.ridUtc;
        allDay = info.rid.type === 'date';
        if (allDay) {
          startDate = localDateOf(startUtc, tz);
          const days = spec && spec.duration.kind === 'days' ? spec.duration.days : 1;
          endDate = addDays(startDate, days);
          endUtc = localMidnightUtcMs(endDate, tz);
        } else {
          endUtc = startUtc + (spec && spec.duration.kind === 'exact' ? spec.duration.ms : 0);
        }
      } else {
        return null;
      }
      this.warn('INVALID_OVERRIDE', 'Override senza DTSTART leggibile: tempi dell\'istanza originale', info.key ?? undefined);
    } else {
      allDay = own.start.type === 'date';
      startUtc = own.startUtc;
      if (allDay) {
        const sd = formatTimeValue(own.start).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
        let ed: string;
        if (own.end) {
          ed = own.end.type === 'date'
            ? formatTimeValue(own.end).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
            : isLocalMidnight(timeToUtcMs(own.end, this.ctx), tz)
              ? localDateOf(timeToUtcMs(own.end, this.ctx), tz)
              : addDays(localDateOf(timeToUtcMs(own.end, this.ctx), tz), 1);
        } else if (own.duration) {
          const d = own.duration;
          const days = (d.negative ? -1 : 1) * (d.weeks * 7 + d.days);
          const hasTime = d.hours > 0 || d.minutes > 0 || d.seconds > 0;
          ed = addDays(sd, days + (hasTime && !d.negative ? 1 : 0));
        } else {
          const days = spec && spec.duration.kind === 'days' ? spec.duration.days : 1;
          ed = addDays(sd, days);
        }
        if (compareDates(ed, sd) <= 0) ed = addDays(sd, 1);
        startDate = sd;
        endDate = ed;
        startUtc = localMidnightUtcMs(sd, tz);
        endUtc = localMidnightUtcMs(ed, tz);
      } else if (own.end) {
        endUtc = timeToUtcMs(own.end, this.ctx);
      } else if (own.duration) {
        try {
          endUtc = timeToUtcMs(addDurationToTime(own.start, own.duration, this.ctx), this.ctx);
        } catch {
          endUtc = startUtc;
        }
      } else if (spec && series && !spec.allDay) {
        // Senza fine propria: la durata del master (RFC 5545 vorrebbe durata nulla; per il busy è più sicuro così).
        endUtc = series.endUtcOf({ wallMs: series.wallOf(startUtc), utcMs: startUtc, rdate: -1 });
      } else {
        endUtc = startUtc;
      }
      if (endUtc < startUtc) endUtc = startUtc;
    }

    // Chiave: istanza abbinata (tipo del master) / RECURRENCE-ID convertito (indeciso) / RECURRENCE-ID (orfano).
    let recurrenceKey: string;
    let originalStartUtc: number | null = info.ridUtc;
    if (instance && series) {
      recurrenceKey = series.keyOf(instance);
      originalStartUtc = instance.utcMs;
    } else if (info.rid) {
      try {
        recurrenceKey = kind === 'override' && spec ? recurrenceKeyOf(typedLikeStart(info.rid, spec.dtstart, this.ctx), this.ctx) : recurrenceKeyOf(info.rid, this.ctx);
      } catch {
        recurrenceKey = recurrenceKeyOf(info.rid, this.ctx);
      }
    } else if (own) {
      recurrenceKey = recurrenceKeyOf(own.start, this.ctx);
      originalStartUtc = null;
    } else {
      return null;
    }
    return {
      recurrenceKey,
      kind,
      source: { type: 'override', index: info.index },
      startUtc,
      endUtc,
      allDay,
      startDate,
      endDate,
      status: upper(c, 'STATUS'),
      transp: upper(c, 'TRANSP'),
      originalStartUtc,
    };
  }

  private result(
    occurrences: ExpandedOccurrence[],
    r: Pick<ExpansionResult, 'isRecurring' | 'health' | 'healthReason' | 'materializedUntil' | 'rangeStart' | 'rangeEnd'>,
  ): ExpansionResult {
    sortOccurrences(occurrences);
    return { occurrences, ...r, iterations: this.budget.used, warnings: this.warnings };
  }
}

function sortOccurrences(list: ExpandedOccurrence[]): void {
  list.sort((a, b) => a.startUtc - b.startUtc || (a.recurrenceKey < b.recurrenceKey ? -1 : a.recurrenceKey > b.recurrenceKey ? 1 : 0));
}

// ============================================
// Busy conservativo da testo illeggibile
// ============================================

/** Intervallo estratto da un testo illeggibile per il busy conservativo. */
export interface ConservativeRange {
  /** Inizio, ms UTC. */
  start: number;
  /** Fine, ms UTC; null = aperta (serie senza UNTIL né COUNT: il chiamante usa la fine della finestra). */
  end: number | null;
  /** True se nel testo c'è una RRULE o una RDATE. */
  recurring: boolean;
}

interface LooseLine {
  name: string;
  params: Map<string, string>;
  value: string;
}

/** Riga di contenuto letta in modo tollerante (virgolette nei parametri comprese); null se non ha la forma NOME[;...]:VALORE. */
function looseLine(line: string): LooseLine | null {
  let i = 0;
  const n = line.length;
  while (i < n && /[A-Za-z0-9-]/.test(line[i])) i++;
  if (i === 0) return null;
  const name = line.slice(0, i).toUpperCase();
  const params = new Map<string, string>();
  while (i < n && line[i] === ';') {
    i++;
    const ps = i;
    while (i < n && line[i] !== '=' && line[i] !== ':' && line[i] !== ';') i++;
    const pname = line.slice(ps, i).toUpperCase();
    let pval = '';
    if (line[i] === '=') {
      i++;
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return null;
        pval = line.slice(i + 1, close);
        i = close + 1;
      } else {
        const vs = i;
        while (i < n && line[i] !== ';' && line[i] !== ':') i++;
        pval = line.slice(vs, i);
      }
    }
    if (pname && !params.has(pname)) params.set(pname, pval);
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

/** Valore temporale letto in modo tollerante (anche con spazzatura attorno alle cifre). */
function looseTime(value: string, params: Map<string, string>): IcsTime | null {
  const v = value.trim();
  try {
    return parseTimeValue(v, { value: params.get('VALUE') ?? null, tzid: params.get('TZID') ?? null }, null);
  } catch {
    const m = /(\d{8})(?:T(\d{6})(Z)?)?/i.exec(v);
    if (!m) return null;
    try {
      return parseTimeValue(m[2] ? `${m[1]}T${m[2]}${m[3] ? 'Z' : ''}` : m[1], { tzid: params.get('TZID') ?? null }, null);
    } catch {
      return null;
    }
  }
}

/** Istante di un valore tollerante: DATE → mezzanotte locale; TZID IANA o mappato; floating e TZID ignoti nel fuso del calendario. */
function looseMs(t: IcsTime, tz: string): number {
  if (t.type === 'date') return localMidnightUtcMs(formatTimeValue(t).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), tz);
  const wall = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: Math.min(t.second, 59) };
  if (t.zone.kind === 'utc') return zonedToUtc(wall, { kind: 'utc' });
  if (t.zone.kind === 'tzid') {
    const res = resolveTzid(t.zone.tzid);
    if (res.kind === 'iana') return zonedToUtc(wall, ianaZone(res.iana));
  }
  return zonedToUtc(wall, ianaZone(tz));
}

interface LooseRecord {
  start: IcsTime | null;
  end: IcsTime | null;
  duration: IcsDuration | null;
  rrule: string | null;
  rdates: IcsTime[];
  rdateBroken: boolean;
}

/**
 * Busy conservativo per un oggetto che non si riesce a interpretare (design
 * §6.5, "quarantena senza versione buona"): estrae in modo tollerante, riga
 * per riga sul testo grezzo (unfolding compreso, VTIMEZONE e VALARM esclusi),
 * DTSTART e fine di ogni VEVENT/VTODO/VJOURNAL e restituisce l'intervallo che
 * li copre tutti (override spostati compresi). La fine di un componente è
 * l'UNTIL della RRULE più la durata se presente, altrimenti DTEND o DTSTART +
 * DURATION, altrimenti un giorno per i DATE e un'ora per i DATE-TIME; TZID
 * risolto con tz-registry, floating e TZID ignoti nel fuso `tz`. Con una RRULE
 * senza UNTIL (COUNT o infinita) la fine è aperta (null). Restituisce null se
 * non trova un DTSTART leggibile (oggetto escluso dal busy con badge
 * "illeggibile", rischio residuo dichiarato dal design). Non lancia mai.
 */
export function conservativeRangeFromText(raw: string, opts: { tz: string }): ConservativeRange | null {
  try {
    const tz = opts.tz && isValidIanaZone(opts.tz) ? opts.tz : DEFAULT_TZ;
    const text = String(raw).replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, '');
    const lines = text.split(/\r\n|\n|\r/);
    const stack: string[] = [];
    const records: LooseRecord[] = [];
    let current: LooseRecord | null = null;
    let currentDepth = -1;
    const sawBegin = lines.some((l) => /^BEGIN:(VEVENT|VTODO|VJOURNAL)\s*$/i.test(l));
    if (!sawBegin) {
      // Frammento senza struttura: tutto ciò che sta fuori dai VTIMEZONE vale come un componente.
      current = { start: null, end: null, duration: null, rrule: null, rdates: [], rdateBroken: false };
      records.push(current);
    }
    for (const line of lines) {
      const l = looseLine(line);
      if (!l) continue;
      if (l.name === 'BEGIN') {
        const comp = l.value.trim().toUpperCase();
        stack.push(comp);
        if (sawBegin && (comp === 'VEVENT' || comp === 'VTODO' || comp === 'VJOURNAL') && !current) {
          current = { start: null, end: null, duration: null, rrule: null, rdates: [], rdateBroken: false };
          currentDepth = stack.length;
          records.push(current);
        }
        continue;
      }
      if (l.name === 'END') {
        if (sawBegin && current && stack.length === currentDepth) {
          current = null;
          currentDepth = -1;
        }
        stack.pop();
        continue;
      }
      if (!current) continue;
      if (sawBegin ? stack.length !== currentDepth : stack.some((s) => s !== 'VCALENDAR' && s !== 'VEVENT' && s !== 'VTODO' && s !== 'VJOURNAL')) continue;
      switch (l.name) {
        case 'DTSTART':
          if (!current.start) current.start = looseTime(l.value, l.params);
          break;
        case 'DTEND':
        case 'DUE':
          if (!current.end) current.end = looseTime(l.value, l.params);
          break;
        case 'DURATION':
          if (!current.duration) {
            try {
              current.duration = parseDurationValue(l.value, 'DURATION');
            } catch {
              current.duration = null;
            }
          }
          break;
        case 'RRULE':
          if (!current.rrule) current.rrule = l.value;
          break;
        case 'RDATE':
          for (const part of l.value.split(',')) {
            const t = looseTime(part.split('/')[0], l.params);
            if (t) current.rdates.push(t);
            else current.rdateBroken = true;
          }
          break;
        default:
          break;
      }
    }
    let start: number | null = null;
    let end: number | null = null;
    let open = false;
    let recurring = false;
    for (const r of records) {
      if (!r.start) continue;
      const s = looseMs(r.start, tz);
      const isDate = r.start.type === 'date';
      let dur = isDate ? DAY_MS : HOUR_MS;
      if (r.end) {
        const e = looseMs(r.end, tz);
        if (e > s) dur = e - s;
      } else if (r.duration && !r.duration.negative) {
        const d = r.duration;
        const ms = ((d.weeks * 7 + d.days) * 86400 + d.hours * 3600 + d.minutes * 60 + d.seconds) * 1000;
        if (ms > 0) dur = ms;
      }
      let e = s + dur;
      if (r.rrule != null) {
        recurring = true;
        const m = /(?:^|;)\s*UNTIL\s*=\s*([0-9TZtz]+)/i.exec(r.rrule);
        const until = m ? looseTime(m[1], new Map()) : null;
        if (until) {
          e = Math.max(e, looseMs(until, tz) + dur);
        } else {
          open = true;
        }
      }
      if (r.rdates.length > 0 || r.rdateBroken) {
        recurring = true;
        if (r.rdateBroken) open = true;
        for (const rd of r.rdates) e = Math.max(e, looseMs(rd, tz) + dur);
      }
      start = start == null ? s : Math.min(start, s);
      end = end == null ? e : Math.max(end, e);
    }
    if (start == null || !Number.isFinite(start)) return null;
    return { start, end: open || end == null || !Number.isFinite(end) ? null : Math.max(end, start), recurring };
  } catch {
    return null;
  }
}
