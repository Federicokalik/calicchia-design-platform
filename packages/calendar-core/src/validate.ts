/**
 * Validazione degli oggetti prima della scrittura (design §8, punto 1).
 *
 * Si applica alle scritture dell'API (admin, MCP, job, migrazione) prima della
 * PUT su Radicale; gli oggetti scritti dai device non passano di qui (li
 * giudica la salute per oggetto dell'indice). Le severità 'error' bloccano la
 * scrittura (ValidationError → 400/422 in admin, {error} in MCP); le
 * 'warning' finiscono nel report e nei log.
 *
 * Esiti per oggetto, mai eccezioni per dati sbagliati: ogni problema è una
 * ValidationIssue con un codice stabile. Anche un difetto interno diventa un
 * issue di errore (la scrittura si blocca: meglio un 400 spiegato di un
 * oggetto che Radicale rifiuta o che l'indice mette in quarantena).
 *
 * Le istanze si contano con lo stesso motore dell'indice, così ciò che
 * l'API scrive non finisce mai in quarantena né troncato da
 * materialized_until:
 * - nell'orizzonte (TOO_MANY_INSTANCES): expandObject con la stessa finestra
 *   dell'indice, lo stesso tetto e lo stesso budget di iterazioni; una RRULE
 *   che il motore (recur.ts) non sa leggere è RRULE_INVALID anche se supera
 *   i controlli di questo modulo;
 * - stima di Radicale (RADICALE_LIMIT), come radicale/item/__init__.py 3.7.8
 *   (max_vevent_rrule_occurrence): COUNT oltre il limite, (UNTIL − DTSTART) /
 *   intervallo nominale della FREQ oltre il limite (senza INTERVAL, come
 *   Radicale), conteggio completo delle regole con UNTIL oltre il limite.
 *   Radicale conta con dateutil (vobject), lo stesso algoritmo di recur.ts.
 *
 * Modifiche di oggetti esistenti (`previous`): gli errori già presenti
 * nell'oggetto prima della modifica (stesso codice, componente e proprietà)
 * diventano avvisi, così un difetto scritto da un device non blocca la
 * modifica di un altro campo; restano errori quelli che Radicale rifiuterebbe
 * comunque (RADICALE_LIMIT, COMPONENT_NOT_ALLOWED).
 */

import { CalendarCoreError } from './errors';
import { EXPANSION_ITERATION_BUDGET, type ExpansionResult, expandObject } from './expand';
import { collectTzidRefs, utf8ByteLength } from './ics-text';
import {
  type CalendarObject,
  componentRecurrenceKey,
  durationToSeconds,
  formatTimeValue,
  getProperties,
  getProperty,
  getParamValue,
  type IcsComponent,
  type IcsDuration,
  type IcsPeriod,
  type IcsTime,
  MASTER_RECURRENCE_KEY,
  objectComponents,
  parseDateValue,
  parseDateTimeValue,
  parseDurationValue,
  readTimeListProperty,
  readTimeProperty,
  type SchedulableComponentType,
  timeToUtcMs,
  type ZoneContext,
} from './model';
import { componentUid } from './parse';
import { ExpansionBudget, ExpansionBudgetError, parseRecurRule, readMasterSpec, RecurRuleError, Series } from './recur';
import { serializeObject } from './serialize';
import { DEFAULT_TZ, isValidIanaZone, resolveTzid } from './tz-registry';

/** Dimensione massima del testo di un oggetto scritto dall'API: 1 MiB. */
export const MAX_OBJECT_BYTES = 1024 * 1024;

/** Istanze massime nell'orizzonte per un oggetto scritto dall'API (stesso tetto dell'espansione). */
export const MAX_INSTANCES_IN_HORIZON = 5000;

/** Stima massima di occorrenze totali accettata da Radicale (max_vevent_rrule_occurrence, design §3.2). */
export const RADICALE_MAX_OCCURRENCES = 50_000;

export type ValidationCode =
  /** Componente non ammesso dal component-set della collezione. */
  | 'COMPONENT_NOT_ALLOWED'
  | 'MISSING_UID'
  /** Override con UID diverso dal master. */
  | 'OVERRIDE_UID_MISMATCH'
  | 'MISSING_DTSTART'
  /** Valore di una proprietà temporale o numerica non interpretabile. */
  | 'INVALID_VALUE'
  /** RRULE non interpretabile (parti sconosciute, valori fuori dominio, BYxxx incoerenti). */
  | 'RRULE_INVALID'
  /** FREQ=SECONDLY o MINUTELY. */
  | 'RRULE_FREQ_NOT_ALLOWED'
  /** COUNT e UNTIL insieme (RFC 5545 li vieta). */
  | 'RRULE_COUNT_AND_UNTIL'
  /** UNTIL di tipo diverso da DTSTART, o non UTC con DTSTART con TZID. */
  | 'UNTIL_TYPE_MISMATCH'
  | 'UNTIL_BEFORE_DTSTART'
  /** Più di MAX_INSTANCES_IN_HORIZON istanze nell'orizzonte. */
  | 'TOO_MANY_INSTANCES'
  /** Stima totale oltre RADICALE_MAX_OCCURRENCES (Radicale rifiuterebbe la PUT). */
  | 'RADICALE_LIMIT'
  | 'DTEND_TYPE_MISMATCH'
  | 'EXDATE_TYPE_MISMATCH'
  | 'RDATE_TYPE_MISMATCH'
  | 'RECURRENCE_ID_TYPE_MISMATCH'
  /** DTEND non successivo a DTSTART (o DURATION non positiva). */
  | 'END_NOT_AFTER_START'
  | 'DTEND_AND_DURATION'
  /** Testo serializzato oltre MAX_OBJECT_BYTES. */
  | 'TOO_LARGE'
  /** TZID né IANA, né mappato, né definito da un VTIMEZONE dell'oggetto. */
  | 'UNKNOWN_TZID'
  /** Due override con la stessa recurrence key. */
  | 'DUPLICATE_OVERRIDE';

export interface ValidationIssue {
  code: ValidationCode;
  severity: 'error' | 'warning';
  /** Messaggio in italiano, mostrabile all'utente. */
  message: string;
  property?: string;
  /** Componente interessato: MASTER_RECURRENCE_KEY o la chiave dell'override. */
  recurrenceKey?: string;
}

export interface ValidateOptions {
  /** Fuso IANA del calendario. */
  tz: string;
  /** Component-set della collezione. Default ['VEVENT']. */
  allowedComponents?: readonly SchedulableComponentType[];
  /** Orizzonte per il conteggio delle istanze (ms UTC); default [now − 400 g, now + 800 g]. */
  horizon?: { from: number; to: number };
  /** Default MAX_INSTANCES_IN_HORIZON. */
  maxInstances?: number;
  /** Default RADICALE_MAX_OCCURRENCES. */
  radicaleMaxOccurrences?: number;
  /** Default MAX_OBJECT_BYTES. */
  maxBytes?: number;
  /** Byte del testo che si sta per scrivere, se già serializzato; altrimenti lo misura serializeObject. */
  serializedBytes?: number;
  /** Orologio per l'orizzonte di default. */
  now?: Date;
  /**
   * Oggetto prima della modifica (patch di un oggetto esistente): i suoi
   * errori, se l'oggetto nuovo li ha ancora (stesso codice, recurrence key e
   * proprietà), diventano avvisi, salvo RADICALE_LIMIT e
   * COMPONENT_NOT_ALLOWED. Omesso o null per le creazioni.
   */
  previous?: CalendarObject | null;
}

export interface ValidationResult {
  /** True se non ci sono issue di severità 'error'. */
  ok: boolean;
  issues: ValidationIssue[];
}

export class ValidationError extends CalendarCoreError {
  declare readonly code: 'VALIDATION_FAILED';
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const errors = issues.filter((i) => i.severity === 'error');
    super('VALIDATION_FAILED', errors.map((i) => i.message).join('; ') || 'Oggetto non valido', {
      codes: errors.map((i) => i.code),
    });
    this.issues = issues;
  }
}

const DAY_MS = 86_400_000;
const HORIZON_PAST_DAYS = 400;
const HORIZON_FUTURE_DAYS = 800;

/**
 * Valida l'oggetto: component-set; UID presente e uguale in master e
 * override; DTSTART presente e valido; niente RRULE SECONDLY o MINUTELY;
 * RRULE interpretabile e senza COUNT+UNTIL; al massimo `maxInstances` istanze
 * nell'orizzonte e stima totale ≤ `radicaleMaxOccurrences`; UNTIL ≥ DTSTART e
 * dello stesso tipo (UTC se DTSTART ha TZID); DTEND, EXDATE, RDATE e
 * RECURRENCE-ID dello stesso tipo di DTSTART; DTEND > DTSTART (DURATION
 * positiva); non DTEND e DURATION insieme; TZID risolvibili; override senza
 * duplicati; testo ≤ `maxBytes`. Non lancia per dati sbagliati.
 *
 * Tolleranze (warning, non errori): DTEND con DURATION:PT0S (quirk di
 * Thunderbird che Radicale corregge da sé), valori non standard di STATUS,
 * TRANSP, CLASS, PRIORITY, SEQUENCE e GEO, RRULE ripetute (vale la prima) o
 * in un override, parti RSCALE=GREGORIAN, SKIP=OMIT e X-... della RRULE
 * (ignorate dall'espansione; altri RSCALE o SKIP sono errori), fuso del
 * calendario sconosciuto (vale DEFAULT_TZ, come nell'espansione).
 */
export function validateObject(obj: CalendarObject, opts: ValidateOptions): ValidationResult {
  const issues = collectIssues(obj, opts);
  if (opts.previous) {
    const before = new Set(
      collectIssues(opts.previous, { ...opts, previous: null, serializedBytes: undefined })
        .filter((i) => i.severity === 'error')
        .map(issueIdentity),
    );
    for (const issue of issues) {
      if (issue.severity !== 'error' || ALWAYS_BLOCKING.has(issue.code) || !before.has(issueIdentity(issue))) continue;
      issue.severity = 'warning';
      issue.message = `${issue.message} (già presente prima della modifica)`;
    }
  }
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** Errori che bloccano anche se c'erano già: Radicale rifiuterebbe comunque la PUT. */
const ALWAYS_BLOCKING: ReadonlySet<ValidationCode> = new Set<ValidationCode>(['RADICALE_LIMIT', 'COMPONENT_NOT_ALLOWED']);

function issueIdentity(i: ValidationIssue): string {
  return `${i.code}|${i.recurrenceKey ?? ''}|${i.property ?? ''}`;
}

function collectIssues(obj: CalendarObject, opts: ValidateOptions): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  try {
    runValidation(obj, opts, issues);
  } catch (err) {
    issues.push({
      code: 'INVALID_VALUE',
      severity: 'error',
      message: `Validazione non completata: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
    });
  }
  return issues;
}

/** Come validateObject, ma lancia ValidationError se ci sono errori. */
export function assertValidObject(obj: CalendarObject, opts: ValidateOptions): void {
  const result = validateObject(obj, opts);
  if (!result.ok) throw new ValidationError(result.issues);
}

/**
 * Validazione di una sola RRULE rispetto al DTSTART che la accompagna
 * (anteprima dell'editor, MCP create_event): parti e valori ammessi da RFC
 * 5545, FREQ non SECONDLY/MINUTELY, COUNT e UNTIL non insieme, UNTIL dello
 * stesso tipo e non precedente a DTSTART.
 */
export function validateRrule(rrule: string, dtstart: IcsTime, opts: { tz: string }): ValidationIssue[] {
  try {
    return analyzeRrule(rrule, dtstart, { tz: opts.tz || DEFAULT_TZ }).issues;
  } catch (err) {
    return [
      {
        code: 'RRULE_INVALID',
        severity: 'error',
        message: `RRULE non valida: ${err instanceof Error ? err.message.slice(0, 120) : 'errore interno'}`,
        property: 'RRULE',
      },
    ];
  }
}

// ============================================
// RRULE: parti, canonica, analisi
// ============================================

export const RRULE_FREQUENCIES = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RruleFreq = (typeof RRULE_FREQUENCIES)[number];

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const BY_PARTS = ['BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS'];
const KNOWN_PARTS = new Set(['FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'WKST', ...BY_PARTS]);
/**
 * RFC 7529: l'espansione (recur.ts) ignora RSCALE=GREGORIAN e SKIP=OMIT (il
 * comportamento di RFC 5545) e rifiuta gli altri valori.
 */
const EXTENSION_PARTS: ReadonlyMap<string, string> = new Map([
  ['RSCALE', 'GREGORIAN'],
  ['SKIP', 'OMIT'],
]);
/** Intervallo nominale per FREQ della stima di Radicale (RRULE_FREQUENCIES_TO_INTERVAL). */
const RADICALE_FREQ_SECONDS: Record<RruleFreq, number> = {
  YEARLY: 60 * 60 * 24 * 365,
  MONTHLY: (60 * 60 * 24 * 365) / 12,
  WEEKLY: 60 * 60 * 24 * 7,
  DAILY: 60 * 60 * 24,
  HOURLY: 60 * 60,
  MINUTELY: 60,
  SECONDLY: 1,
};
/** Giorni massimi per mese (febbraio bisestile). */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface RrulePart {
  /** Nome in maiuscolo. */
  key: string;
  /** Valore senza spazi ai bordi. */
  value: string;
}

/** Parti di una RRULE (con o senza prefisso "RRULE:"), nell'ordine del testo; parti vuote ignorate. Non valida nulla. */
export function rruleParts(raw: string): RrulePart[] {
  return raw
    .trim()
    .replace(/^RRULE:/i, '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => {
      const eq = p.indexOf('=');
      return eq < 0 ? { key: p.toUpperCase(), value: '' } : { key: p.slice(0, eq).trim().toUpperCase(), value: p.slice(eq + 1).trim() };
    });
}

/**
 * Testo canonico di una RRULE per i confronti (fingerprint, patch): parti
 * ordinate per nome, valori in maiuscolo, liste BYxxx ordinate e senza
 * duplicati, INTERVAL=1 e WKST=MO omessi (default di RFC 5545). Non valida.
 */
export function canonicalRruleText(raw: string): string {
  const parts = rruleParts(raw)
    .map(({ key, value }) => {
      let v = value.toUpperCase();
      if (BY_PARTS.includes(key)) {
        const list = [...new Set(v.split(',').map((x) => x.trim()).filter((x) => x !== ''))];
        list.sort((a, b) => {
          const na = Number(a);
          const nb = Number(b);
          if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
          return a < b ? -1 : a > b ? 1 : 0;
        });
        v = list.join(',');
      } else if (key === 'INTERVAL' || key === 'COUNT') {
        v = /^\d+$/.test(v) ? String(Number(v)) : v;
      }
      return { key, value: v };
    })
    .filter(({ key, value }) => !(key === 'INTERVAL' && value === '1') && !(key === 'WKST' && value === 'MO'));
  parts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return parts.map(({ key, value }) => `${key}=${value}`).join(';');
}

interface RruleAnalysis {
  issues: ValidationIssue[];
  /** Null se FREQ manca o non è valida. */
  freq: RruleFreq | null;
  interval: number;
  count: number | null;
  until: IcsTime | null;
  /** True se non ci sono errori e il motore dell'espansione legge la regola: le istanze si possono contare. */
  iterable: boolean;
}

function rruleIssue(code: ValidationCode, message: string, severity: 'error' | 'warning' = 'error'): ValidationIssue {
  return { code, severity, message, property: 'RRULE' };
}

function parseIntList(value: string, min: number, max: number, allowNegative: boolean): number[] | null {
  if (value === '') return null;
  const out: number[] = [];
  for (const part of value.split(',')) {
    const v = part.trim();
    if (!/^[+-]?\d{1,4}$/.test(v)) return null;
    const n = Number(v);
    if (n === 0 && min > 0) return null;
    if (n < 0 && !allowNegative) return null;
    if (Math.abs(n) < min || Math.abs(n) > max) return null;
    out.push(n);
  }
  return out;
}

/** Analisi completa di una RRULE rispetto al suo DTSTART (senza conteggio delle istanze). */
function analyzeRrule(rrule: string, dtstart: IcsTime, ctx: ZoneContext): RruleAnalysis {
  const issues: ValidationIssue[] = [];
  const result: RruleAnalysis = { issues, freq: null, interval: 1, count: null, until: null, iterable: false };
  const raw = rrule.trim().replace(/^RRULE:/i, '');
  if (raw === '') {
    issues.push(rruleIssue('RRULE_INVALID', 'RRULE vuota'));
    return result;
  }
  if (/[\r\n]/.test(raw)) {
    issues.push(rruleIssue('RRULE_INVALID', 'RRULE con un a capo'));
    return result;
  }
  for (const segment of raw.split(';')) {
    if (segment.trim() !== '' && !segment.includes('=')) {
      issues.push(rruleIssue('RRULE_INVALID', `Parte "${segment.trim().slice(0, 20)}" della RRULE senza valore`));
    }
  }
  const parts = rruleParts(raw).filter((p) => p.value !== '' || raw.toUpperCase().includes(`${p.key}=`));
  const map = new Map<string, string>();
  for (const { key, value } of parts) {
    if (map.has(key)) {
      issues.push(rruleIssue('RRULE_INVALID', `Parte ${key.slice(0, 20)} ripetuta nella RRULE`));
      continue;
    }
    map.set(key, value);
    const supported = EXTENSION_PARTS.get(key);
    if (supported !== undefined) {
      if (value.toUpperCase() === supported) {
        issues.push(rruleIssue('RRULE_INVALID', `${key}=${supported} (RFC 7529) ignorata: è già il comportamento predefinito`, 'warning'));
      } else {
        issues.push(rruleIssue('RRULE_INVALID', `${key}=${value.slice(0, 20)} (RFC 7529) non supportata`));
      }
    } else if (key.startsWith('X-')) {
      issues.push(rruleIssue('RRULE_INVALID', `Parte ${key.slice(0, 20)} della RRULE ignorata nel calcolo delle occorrenze`, 'warning'));
    } else if (!KNOWN_PARTS.has(key)) {
      issues.push(rruleIssue('RRULE_INVALID', `Parte "${key.slice(0, 20)}" sconosciuta nella RRULE`));
    }
  }

  const freqRaw = map.get('FREQ')?.toUpperCase();
  if (!freqRaw) {
    issues.push(rruleIssue('RRULE_INVALID', 'RRULE senza FREQ'));
  } else if (!(RRULE_FREQUENCIES as readonly string[]).includes(freqRaw)) {
    issues.push(rruleIssue('RRULE_INVALID', `FREQ "${freqRaw.slice(0, 20)}" non valida`));
  } else {
    result.freq = freqRaw as RruleFreq;
    if (result.freq === 'SECONDLY' || result.freq === 'MINUTELY') {
      issues.push(rruleIssue('RRULE_FREQ_NOT_ALLOWED', `Ricorrenza ${result.freq === 'SECONDLY' ? 'al secondo' : 'al minuto'} non ammessa`));
    }
  }
  const freq = result.freq;

  const intervalRaw = map.get('INTERVAL');
  if (intervalRaw !== undefined) {
    if (!/^\d{1,6}$/.test(intervalRaw) || Number(intervalRaw) < 1) {
      issues.push(rruleIssue('RRULE_INVALID', 'INTERVAL deve essere un intero positivo'));
    } else {
      result.interval = Number(intervalRaw);
    }
  }
  const countRaw = map.get('COUNT');
  if (countRaw !== undefined) {
    if (!/^\d{1,9}$/.test(countRaw) || Number(countRaw) < 1) issues.push(rruleIssue('RRULE_INVALID', 'COUNT deve essere un intero positivo'));
    else result.count = Number(countRaw);
  }
  const untilRaw = map.get('UNTIL');
  if (untilRaw !== undefined) {
    try {
      result.until = /^\d{8}$/.test(untilRaw) ? parseDateValue(untilRaw, 'RRULE') : parseDateTimeValue(untilRaw, null, 'RRULE');
    } catch {
      issues.push(rruleIssue('RRULE_INVALID', `UNTIL non valido: "${untilRaw.slice(0, 30)}"`));
    }
  }
  if (countRaw !== undefined && untilRaw !== undefined) {
    issues.push(rruleIssue('RRULE_COUNT_AND_UNTIL', 'COUNT e UNTIL non possono comparire insieme'));
  }

  // Domini e coerenza delle parti BYxxx (RFC 5545 §3.3.10).
  const by = (key: string, min: number, max: number, neg: boolean, label: string): number[] | null => {
    const v = map.get(key);
    if (v === undefined) return null;
    const list = parseIntList(v, min, max, neg);
    if (!list) issues.push(rruleIssue('RRULE_INVALID', `${key} non valido: ${label}`));
    return list;
  };
  by('BYSECOND', 0, 60, false, 'valori da 0 a 60');
  by('BYMINUTE', 0, 59, false, 'valori da 0 a 59');
  by('BYHOUR', 0, 23, false, 'valori da 0 a 23');
  const byMonthDay = by('BYMONTHDAY', 1, 31, true, 'valori da 1 a 31 (anche negativi)');
  by('BYYEARDAY', 1, 366, true, 'valori da 1 a 366 (anche negativi)');
  by('BYWEEKNO', 1, 53, true, 'valori da 1 a 53 (anche negativi)');
  const byMonth = by('BYMONTH', 1, 12, false, 'valori da 1 a 12');
  by('BYSETPOS', 1, 366, true, 'valori da 1 a 366 (anche negativi)');

  const byDayRaw = map.get('BYDAY');
  let maxOrdinal = 0;
  if (byDayRaw !== undefined) {
    const items = byDayRaw.toUpperCase().split(',').map((s) => s.trim());
    for (const item of items) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
      if (!m) {
        issues.push(rruleIssue('RRULE_INVALID', `BYDAY non valido: "${item.slice(0, 10)}"`));
        continue;
      }
      if (m[1] != null) {
        const n = Math.abs(Number(m[1]));
        if (n < 1 || n > 53) issues.push(rruleIssue('RRULE_INVALID', `Ordinale di BYDAY fuori dominio: "${item.slice(0, 10)}"`));
        maxOrdinal = Math.max(maxOrdinal, n);
      }
    }
  }
  const wkst = map.get('WKST');
  if (wkst !== undefined && !WEEKDAYS.includes(wkst.toUpperCase())) issues.push(rruleIssue('RRULE_INVALID', `WKST non valido: "${wkst.slice(0, 10)}"`));

  if (freq) {
    if (maxOrdinal > 0) {
      if (freq !== 'MONTHLY' && freq !== 'YEARLY') {
        issues.push(rruleIssue('RRULE_INVALID', 'BYDAY con ordinale ammesso solo con FREQ=MONTHLY o YEARLY'));
      } else if (freq === 'YEARLY' && map.has('BYWEEKNO')) {
        issues.push(rruleIssue('RRULE_INVALID', 'BYDAY con ordinale non ammesso insieme a BYWEEKNO'));
      } else if ((freq === 'MONTHLY' || map.has('BYMONTH')) && maxOrdinal > 5) {
        issues.push(rruleIssue('RRULE_INVALID', 'Ordinale di BYDAY oltre 5 in una ricorrenza mensile'));
      }
    }
    if (map.has('BYMONTHDAY') && freq === 'WEEKLY') issues.push(rruleIssue('RRULE_INVALID', 'BYMONTHDAY non ammesso con FREQ=WEEKLY'));
    if (map.has('BYYEARDAY') && (freq === 'DAILY' || freq === 'WEEKLY' || freq === 'MONTHLY')) {
      issues.push(rruleIssue('RRULE_INVALID', `BYYEARDAY non ammesso con FREQ=${freq}`));
    }
    if (map.has('BYWEEKNO') && freq !== 'YEARLY') issues.push(rruleIssue('RRULE_INVALID', 'BYWEEKNO ammesso solo con FREQ=YEARLY'));
  }
  if (map.has('BYSETPOS') && !BY_PARTS.some((k) => k !== 'BYSETPOS' && map.has(k))) {
    issues.push(rruleIssue('RRULE_INVALID', 'BYSETPOS richiede almeno un\'altra parte BYxxx'));
  }
  // Combinazioni che non producono mai istanze (ical.js le itera male o a lungo).
  if (byMonthDay && byMonth) {
    const possible = byMonth.some((month) => byMonthDay.some((d) => Math.abs(d) <= MONTH_MAX_DAYS[month - 1]));
    if (!possible) issues.push(rruleIssue('RRULE_INVALID', 'BYMONTHDAY e BYMONTH incompatibili: la regola non produce occorrenze'));
  }

  // UNTIL rispetto al DTSTART.
  if (result.until) {
    const until = result.until;
    let typeOk = true;
    if (dtstart.type === 'date' && until.type !== 'date') typeOk = false;
    if (dtstart.type === 'date-time') {
      if (until.type !== 'date-time') typeOk = false;
      else if (dtstart.zone.kind === 'floating' ? until.zone.kind !== 'floating' : until.zone.kind !== 'utc') typeOk = false;
    }
    if (!typeOk) {
      const expected = dtstart.type === 'date' ? 'una data (VALUE=DATE)' : dtstart.zone.kind === 'floating' ? 'un orario locale (senza Z)' : 'un istante UTC (con Z)';
      issues.push(rruleIssue('UNTIL_TYPE_MISMATCH', `UNTIL deve essere ${expected} come il DTSTART`));
    }
    try {
      const before =
        dtstart.type === 'date' && until.type === 'date'
          ? formatTimeValue(until) < formatTimeValue(dtstart)
          : timeToUtcMs(until, ctx) < timeToUtcMs(dtstart, ctx);
      if (before) issues.push(rruleIssue('UNTIL_BEFORE_DTSTART', 'UNTIL precedente all\'inizio della serie'));
    } catch {
      // Fuso non convertibile: lo segnala la verifica dei TZID.
    }
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  if (!hasErrors) {
    // Ultima verifica: il motore dell'espansione (recur.ts) deve saperla leggere,
    // altrimenti l'indice metterebbe l'oggetto in quarantena (invalid-rrule).
    const parsed = parseRecurRule(raw);
    if (parsed.ok) result.iterable = true;
    else issues.push(rruleIssue('RRULE_INVALID', `RRULE non interpretabile: ${parsed.reason.slice(0, 80)}`));
  }
  return result;
}

// ============================================
// Validazione dell'oggetto
// ============================================

interface ComponentFacts {
  component: IcsComponent;
  key: string;
  start: IcsTime | null;
  isMaster: boolean;
}

function push(
  issues: ValidationIssue[],
  code: ValidationCode,
  message: string,
  extra: { severity?: 'error' | 'warning'; property?: string; recurrenceKey?: string } = {},
): void {
  const issue: ValidationIssue = { code, severity: extra.severity ?? 'error', message };
  if (extra.property) issue.property = extra.property;
  if (extra.recurrenceKey !== undefined) issue.recurrenceKey = extra.recurrenceKey;
  issues.push(issue);
}

function rawKeyOf(c: IcsComponent): string {
  const p = getProperty(c, 'RECURRENCE-ID');
  return p ? `~${getParamValue(p, 'TZID') ?? ''}|${p.value.trim()}` : MASTER_RECURRENCE_KEY;
}

function runValidation(obj: CalendarObject, opts: ValidateOptions, issues: ValidationIssue[]): void {
  let tz = opts.tz || DEFAULT_TZ;
  if (!isValidIanaZone(tz)) {
    // Come expandObject: un fuso del calendario sconosciuto ricade su DEFAULT_TZ (dato della collezione, non dell'oggetto).
    push(issues, 'UNKNOWN_TZID', `Fuso del calendario "${tz.slice(0, 60)}" sconosciuto: usato ${DEFAULT_TZ}`, { severity: 'warning' });
    tz = DEFAULT_TZ;
  }
  const ctx: ZoneContext = { tz, timezones: obj.timezones };
  const allowed = opts.allowedComponents ?? ['VEVENT'];

  // Struttura e component-set.
  if (!allowed.includes(obj.componentType)) {
    push(issues, 'COMPONENT_NOT_ALLOWED', `Componenti ${obj.componentType} non ammessi in questo calendario`);
  }
  for (const other of obj.otherComponents) {
    push(issues, 'COMPONENT_NOT_ALLOWED', `Componente ${other.name.slice(0, 30)} non ammesso in una risorsa del calendario`);
  }
  const components = objectComponents(obj);
  if (components.length === 0) {
    push(issues, 'INVALID_VALUE', 'Oggetto senza componenti');
    return;
  }
  const objectUid = obj.uid.trim();
  if (objectUid === '') push(issues, 'MISSING_UID', 'Oggetto senza UID');

  const facts: ComponentFacts[] = [];
  const seenKeys = new Map<string, number>();
  const masterStart = obj.master ? safeStart(obj.master) : null;

  for (const c of components) {
    const isMaster = c === obj.master;
    let key = MASTER_RECURRENCE_KEY;
    if (!isMaster) {
      try {
        key = componentRecurrenceKey(c, ctx);
      } catch {
        key = rawKeyOf(c);
      }
    }
    const rk = { recurrenceKey: key };
    if (c.name.toUpperCase() !== obj.componentType) {
      push(issues, 'COMPONENT_NOT_ALLOWED', `Componente ${c.name.slice(0, 30)} in un oggetto ${obj.componentType}`, rk);
    }
    if (isMaster && getProperty(c, 'RECURRENCE-ID')) push(issues, 'INVALID_VALUE', 'Il master ha un RECURRENCE-ID', { ...rk, property: 'RECURRENCE-ID' });
    if (!isMaster && !getProperty(c, 'RECURRENCE-ID')) push(issues, 'INVALID_VALUE', 'Override senza RECURRENCE-ID', { ...rk, property: 'RECURRENCE-ID' });

    const uid = componentUid(c);
    if (uid == null) push(issues, 'MISSING_UID', `${c.name.slice(0, 20)} senza UID`, { ...rk, property: 'UID' });
    else if (objectUid !== '' && uid !== objectUid) {
      push(issues, 'OVERRIDE_UID_MISMATCH', isMaster ? 'UID del master diverso da quello dell\'oggetto' : 'Override con UID diverso dal master', {
        ...rk,
        property: 'UID',
      });
    }

    if (!isMaster) {
      const prev = seenKeys.get(key) ?? 0;
      if (prev === 1) push(issues, 'DUPLICATE_OVERRIDE', 'Più override per la stessa occorrenza', rk);
      seenKeys.set(key, prev + 1);
    }

    const start = validateComponentTimes(c, isMaster, masterStart, ctx, issues, key);
    validateSoftValues(c, issues, key);
    for (const tzid of collectTzidRefs([c])) {
      if (resolveTzid(tzid, obj.timezones).kind === 'unknown') {
        push(issues, 'UNKNOWN_TZID', `Fuso orario sconosciuto: "${tzid.slice(0, 60)}"`, { ...rk, property: 'TZID' });
      }
    }
    facts.push({ component: c, key, start, isMaster });
  }

  // Istanze nell'orizzonte e limite di Radicale (solo master con DTSTART valido).
  const master = facts.find((f) => f.isMaster);
  if (master && master.start) checkInstances(master.component, master.start, obj, ctx, opts, issues);

  // Dimensione.
  let bytes = opts.serializedBytes;
  if (bytes == null) {
    try {
      bytes = utf8ByteLength(serializeObject(obj));
    } catch (err) {
      push(issues, 'INVALID_VALUE', `Oggetto non serializzabile: ${err instanceof Error ? err.message.slice(0, 160) : 'errore'}`);
    }
  }
  const maxBytes = opts.maxBytes ?? MAX_OBJECT_BYTES;
  if (bytes != null && bytes > maxBytes) {
    push(issues, 'TOO_LARGE', `Evento troppo grande (${Math.ceil(bytes / 1024)} KiB, massimo ${Math.floor(maxBytes / 1024)} KiB)`);
  }
}

function safeStart(c: IcsComponent): IcsTime | null {
  const p = getProperty(c, 'DTSTART');
  if (!p) return null;
  try {
    return readTimeProperty(p);
  } catch {
    return null;
  }
}

function typeLabel(t: IcsTime): string {
  return t.type === 'date' ? 'data (tutto il giorno)' : 'data e ora';
}

/** Controlli sui tempi di un componente; restituisce il DTSTART leggibile o null. */
function validateComponentTimes(
  c: IcsComponent,
  isMaster: boolean,
  masterStart: IcsTime | null,
  ctx: ZoneContext,
  issues: ValidationIssue[],
  key: string,
): IcsTime | null {
  const rk = { recurrenceKey: key };
  const isTodo = c.name.toUpperCase() === 'VTODO';
  const endName = isTodo ? 'DUE' : 'DTEND';

  for (const name of ['DTSTART', endName, 'DURATION', 'RECURRENCE-ID']) {
    if (getProperties(c, name).length > 1) push(issues, 'INVALID_VALUE', `${name} presente più volte`, { ...rk, property: name });
  }

  let start: IcsTime | null = null;
  const startProp = getProperty(c, 'DTSTART');
  if (!startProp) {
    if (c.name.toUpperCase() === 'VEVENT') push(issues, 'MISSING_DTSTART', 'Evento senza data di inizio', { ...rk, property: 'DTSTART' });
  } else {
    try {
      start = readTimeProperty(startProp);
    } catch {
      push(issues, 'INVALID_VALUE', `DTSTART non valido: "${startProp.value.slice(0, 30)}"`, { ...rk, property: 'DTSTART' });
    }
  }

  let end: IcsTime | null = null;
  const endProp = getProperty(c, endName);
  if (endProp) {
    try {
      end = readTimeProperty(endProp);
    } catch {
      push(issues, 'INVALID_VALUE', `${endName} non valido: "${endProp.value.slice(0, 30)}"`, { ...rk, property: endName });
    }
  }
  let duration: IcsDuration | null = null;
  const durationProp = getProperty(c, 'DURATION');
  if (durationProp) {
    try {
      duration = parseDurationValue(durationProp.value, 'DURATION');
    } catch {
      push(issues, 'INVALID_VALUE', `DURATION non valida: "${durationProp.value.slice(0, 30)}"`, { ...rk, property: 'DURATION' });
    }
  }

  if (endProp && durationProp) {
    const zero = duration != null && durationToSeconds(duration) === 0;
    push(issues, 'DTEND_AND_DURATION', `${endName} e DURATION non possono comparire insieme`, {
      ...rk,
      property: 'DURATION',
      // Quirk di Thunderbird (DTEND più DURATION:PT0S): Radicale toglie la durata nulla da sé.
      severity: zero ? 'warning' : 'error',
    });
  }

  if (start && end) {
    if (start.type !== end.type) {
      push(issues, 'DTEND_TYPE_MISMATCH', `${endName} deve essere una ${typeLabel(start)} come il DTSTART`, { ...rk, property: endName });
    } else if (!isAfter(end, start, ctx)) {
      push(issues, 'END_NOT_AFTER_START', 'La fine deve essere successiva all\'inizio', { ...rk, property: endName });
    }
  }
  if (start && duration && !endProp) {
    if (start.type === 'date' && (duration.hours || duration.minutes || duration.seconds)) {
      push(issues, 'INVALID_VALUE', 'DURATION con ore o minuti su un evento di tutto il giorno', { ...rk, property: 'DURATION' });
    }
    if (durationToSeconds(duration) <= 0) push(issues, 'END_NOT_AFTER_START', 'La durata deve essere positiva', { ...rk, property: 'DURATION' });
  }

  // RECURRENCE-ID degli override: stesso tipo del DTSTART del master.
  const ridProp = getProperty(c, 'RECURRENCE-ID');
  if (!isMaster && ridProp) {
    try {
      const rid = readTimeProperty(ridProp);
      if (masterStart && rid.type !== masterStart.type) {
        push(issues, 'RECURRENCE_ID_TYPE_MISMATCH', `RECURRENCE-ID deve essere una ${typeLabel(masterStart)} come il DTSTART della serie`, {
          ...rk,
          property: 'RECURRENCE-ID',
        });
      }
    } catch {
      push(issues, 'INVALID_VALUE', `RECURRENCE-ID non valido: "${ridProp.value.slice(0, 30)}"`, { ...rk, property: 'RECURRENCE-ID' });
    }
  }

  // EXDATE e RDATE: stesso tipo del DTSTART.
  for (const p of getProperties(c, 'EXDATE')) {
    let values: Array<IcsTime | IcsPeriod>;
    try {
      values = readTimeListProperty(p);
    } catch {
      push(issues, 'INVALID_VALUE', `EXDATE non valido: "${p.value.slice(0, 30)}"`, { ...rk, property: 'EXDATE' });
      continue;
    }
    if (values.some((v) => v.type === 'period')) {
      push(issues, 'INVALID_VALUE', 'EXDATE non ammette periodi', { ...rk, property: 'EXDATE' });
    } else if (start && values.some((v) => v.type !== start?.type)) {
      push(issues, 'EXDATE_TYPE_MISMATCH', `EXDATE deve essere una ${typeLabel(start)} come il DTSTART`, { ...rk, property: 'EXDATE' });
    }
  }
  for (const p of getProperties(c, 'RDATE')) {
    let values: Array<IcsTime | IcsPeriod>;
    try {
      values = readTimeListProperty(p);
    } catch {
      push(issues, 'INVALID_VALUE', `RDATE non valido: "${p.value.slice(0, 30)}"`, { ...rk, property: 'RDATE' });
      continue;
    }
    for (const v of values) {
      if (v.type === 'period') {
        if (start?.type === 'date') {
          push(issues, 'RDATE_TYPE_MISMATCH', 'RDATE con periodi non ammessa su un evento di tutto il giorno', { ...rk, property: 'RDATE' });
          break;
        }
        const positive = v.end ? isAfter(v.end, v.start, ctx) : v.duration != null && durationToSeconds(v.duration) > 0;
        if (!positive) {
          push(issues, 'INVALID_VALUE', 'Periodo di RDATE con fine non successiva all\'inizio', { ...rk, property: 'RDATE' });
          break;
        }
      } else if (start && v.type !== start.type) {
        push(issues, 'RDATE_TYPE_MISMATCH', `RDATE deve essere una ${typeLabel(start)} come il DTSTART`, { ...rk, property: 'RDATE' });
        break;
      }
    }
  }

  // RRULE: solo nel master; più RRULE → vale la prima.
  const rrules = getProperties(c, 'RRULE');
  if (rrules.length > 0 && !isMaster) {
    push(issues, 'RRULE_INVALID', 'RRULE in un override: ignorata', { ...rk, property: 'RRULE', severity: 'warning' });
  } else if (rrules.length > 0) {
    if (rrules.length > 1) push(issues, 'RRULE_INVALID', 'Più RRULE nello stesso evento: vale la prima', { ...rk, property: 'RRULE', severity: 'warning' });
    if (start) {
      for (const issue of analyzeRrule(rrules[0].value, start, ctx).issues) issues.push({ ...issue, recurrenceKey: key });
    }
  }
  return start;
}

function isAfter(a: IcsTime, b: IcsTime, ctx: ZoneContext): boolean {
  if (a.type === 'date' && b.type === 'date') return formatTimeValue(a) > formatTimeValue(b);
  return timeToUtcMs(a, ctx) > timeToUtcMs(b, ctx);
}

/** Valori non standard: avvisi, non errori (il componente può arrivare da un device). */
function validateSoftValues(c: IcsComponent, issues: ValidationIssue[], key: string): void {
  const rk = { recurrenceKey: key, severity: 'warning' as const };
  const name = c.name.toUpperCase();
  const statusOk: Record<string, string[]> = {
    VEVENT: ['TENTATIVE', 'CONFIRMED', 'CANCELLED'],
    VTODO: ['NEEDS-ACTION', 'COMPLETED', 'IN-PROCESS', 'CANCELLED'],
    VJOURNAL: ['DRAFT', 'FINAL', 'CANCELLED'],
  };
  const status = getProperty(c, 'STATUS')?.value.trim().toUpperCase();
  if (status && statusOk[name] && !statusOk[name].includes(status)) {
    push(issues, 'INVALID_VALUE', `STATUS "${status.slice(0, 20)}" non standard per ${name}`, { ...rk, property: 'STATUS' });
  }
  const transp = getProperty(c, 'TRANSP')?.value.trim().toUpperCase();
  if (transp && transp !== 'OPAQUE' && transp !== 'TRANSPARENT') {
    push(issues, 'INVALID_VALUE', `TRANSP "${transp.slice(0, 20)}" non valido`, { ...rk, property: 'TRANSP' });
  }
  const priority = getProperty(c, 'PRIORITY')?.value.trim();
  if (priority != null && !(/^\d$/.test(priority))) {
    push(issues, 'INVALID_VALUE', 'PRIORITY deve essere un intero da 0 a 9', { ...rk, property: 'PRIORITY' });
  }
  const sequence = getProperty(c, 'SEQUENCE')?.value.trim();
  if (sequence != null && !/^\d{1,9}$/.test(sequence)) {
    push(issues, 'INVALID_VALUE', 'SEQUENCE deve essere un intero non negativo', { ...rk, property: 'SEQUENCE' });
  }
  const geo = getProperty(c, 'GEO')?.value;
  if (geo != null) {
    const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*[;,]\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(geo);
    if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) push(issues, 'INVALID_VALUE', 'GEO non valido', { ...rk, property: 'GEO' });
  }
}


// ============================================
// Conteggio delle istanze
// ============================================

function checkInstances(
  master: IcsComponent,
  start: IcsTime,
  obj: CalendarObject,
  ctx: ZoneContext,
  opts: ValidateOptions,
  issues: ValidationIssue[],
): void {
  const rrules = getProperties(master, 'RRULE');
  const rdateProps = getProperties(master, 'RDATE');
  if (rrules.length === 0 && rdateProps.length === 0) return;
  const rk = { recurrenceKey: MASTER_RECURRENCE_KEY, property: 'RRULE' };

  const analysis = rrules.length > 0 ? analyzeRrule(rrules[0].value, start, ctx) : null;
  if (analysis && !analysis.iterable) return; // Errori già segnalati.

  const maxInstances = Math.max(1, Math.floor(opts.maxInstances ?? MAX_INSTANCES_IN_HORIZON));
  const radicaleMax = opts.radicaleMaxOccurrences ?? RADICALE_MAX_OCCURRENCES;
  const nowMs = (opts.now ?? new Date()).getTime();
  const horizon = opts.horizon ?? { from: nowMs - HORIZON_PAST_DAYS * DAY_MS, to: nowMs + HORIZON_FUTURE_DAYS * DAY_MS };

  // Stima di Radicale (prima del conteggio: non costa iterazioni).
  if (analysis && analysis.freq) {
    if (analysis.count != null && analysis.count > radicaleMax) {
      push(issues, 'RADICALE_LIMIT', `Troppe ripetizioni: COUNT=${analysis.count} (massimo ${radicaleMax})`, rk);
      return;
    }
    if (analysis.until) {
      try {
        const seconds = (timeToUtcMs(analysis.until, ctx) - timeToUtcMs(start, ctx)) / 1000;
        const estimate = seconds / RADICALE_FREQ_SECONDS[analysis.freq];
        if (estimate > radicaleMax) {
          push(issues, 'RADICALE_LIMIT', `Serie troppo lunga per il server: circa ${Math.round(estimate)} ripetizioni stimate (massimo ${radicaleMax})`, rk);
          return;
        }
      } catch {
        // Fuso non convertibile: già segnalato.
      }
    }
  }

  // Istanze nell'orizzonte: stesso motore, tetto e budget dell'indice.
  let expansion: ExpansionResult;
  try {
    expansion = expandObject(obj, { from: horizon.from, to: horizon.to, tz: ctx.tz, maxOccurrences: maxInstances, computeRangeEnd: false });
  } catch (err) {
    push(issues, 'RRULE_INVALID', `Ricorrenza non calcolabile: ${err instanceof Error ? err.message.slice(0, 80) : 'errore'}`, rk);
    return;
  }
  if (expansion.health === 'quarantined') {
    reportQuarantine(expansion, issues, rk);
    return;
  }
  if (expansion.materializedUntil != null) {
    push(issues, 'TOO_MANY_INSTANCES', `Troppe occorrenze: più di ${maxInstances} nel periodo gestito dal calendario`, rk);
    return;
  }

  // Conteggio completo come Radicale per le regole con UNTIL (con COUNT il totale è già noto,
  // le regole illimitate Radicale non le conta).
  if (analysis && analysis.until && analysis.count == null) {
    const total = countTotalInstances(master, ctx, radicaleMax);
    if (total === 'exhausted') {
      push(issues, 'TOO_MANY_INSTANCES', 'Ricorrenza troppo lunga da verificare: accorciala o indica una data di fine più vicina', rk);
    } else if (total != null && total > radicaleMax) {
      push(issues, 'RADICALE_LIMIT', `Troppe ripetizioni: più di ${radicaleMax}`, rk);
    }
  }
}

/** Esito di un'espansione in quarantena → issue (solo se nessun controllo precedente ne ha già spiegato il motivo). */
function reportQuarantine(expansion: ExpansionResult, issues: ValidationIssue[], rk: { recurrenceKey: string; property: string }): void {
  switch (expansion.healthReason) {
    case 'expansion-budget':
      push(issues, 'TOO_MANY_INSTANCES', 'Ricorrenza troppo fitta o troppo lunga da calcolare', rk);
      return;
    case 'invalid-rrule':
      push(issues, 'RRULE_INVALID', 'RRULE non interpretabile dal motore delle ricorrenze', rk);
      return;
    default:
      if (issues.some((i) => i.severity === 'error')) return;
      push(
        issues,
        expansion.healthReason === 'invalid-timezone' ? 'UNKNOWN_TZID' : 'INVALID_VALUE',
        expansion.healthReason === 'invalid-timezone' ? 'Fuso orario dell\'evento non interpretabile' : 'Tempi dell\'evento non interpretabili',
        { recurrenceKey: MASTER_RECURRENCE_KEY },
      );
  }
}

/**
 * Istanze totali della serie (DTSTART ∪ RRULE ∪ RDATE − EXDATE), contate fino
 * a `cap` + 1 come len(list(rruleset)) di Radicale. null se la regola non ha
 * una fine o il master non è leggibile (già segnalato); 'exhausted' se il
 * budget di iterazioni finisce prima.
 */
function countTotalInstances(master: IcsComponent, ctx: ZoneContext, cap: number): number | 'exhausted' | null {
  const read = readMasterSpec(master, ctx);
  if (read.ok !== true) return null;
  const series = new Series(read.spec, ctx, new ExpansionBudget(EXPANSION_ITERATION_BUDGET));
  if (series.untilUpperUtc == null) return null;
  // Oltre UNTIL il motore si ferma da sé: il limite serve solo a chiudere la scansione delle RDATE.
  const limitWall = series.wallOf(series.untilUpperUtc) + 2 * DAY_MS;
  let total = 0;
  try {
    for (const inst of series.instances(null, limitWall)) {
      if (series.isExcluded(inst)) continue;
      total++;
      if (total > cap) break;
    }
  } catch (err) {
    if (err instanceof ExpansionBudgetError) return 'exhausted';
    if (err instanceof RecurRuleError) return null;
    throw err;
  }
  return total;
}
