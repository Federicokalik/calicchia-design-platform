/**
 * Verifica per calendario della migrazione a Radicale (fase F3 del piano;
 * design §13.7; contratto docs/calendar-radicale/contracts/f3-modules.md §8).
 *
 * Confronta Postgres (autorevole in F3) e Radicale su cinque livelli e
 * produce una riga `diff` per differenza, con un semaforo per calendario:
 *
 *  - V1 strutturale: righe vive del ledger contro PROPFIND getetag
 *    (LEDGER_ETAG_MISMATCH, LEDGER_TARGET_MISSING, TARGET_UNTRACKED,
 *    LEDGER_INTENT_PENDING, COLLECTION_MISSING);
 *  - V2 contenuto: multiget e fingerprint semantico contro il piano corrente
 *    (gli oggetti voluti dal serializer); per le righe adottate o derivate solo
 *    i campi del piano, le proprietà in più (VALARM, ATTENDEE, X-*) non contano;
 *  - V3 occorrenze: listOccurrences del codice legacy congelato (PgLegacyStore)
 *    contro expandObject di calendar-core sul contenuto di Radicale, su
 *    [oggi − 365, oggi + 730] a finestre di al più 60 giorni (il legacy espande
 *    al massimo 500 occorrenze per master: una serie lun-ven ne ha più di 700
 *    sull'intervallo intero e senza finestre comparirebbero rossi falsi). Le
 *    occorrenze si abbinano per oggetto (chiave legacy) e istanza originale;
 *  - V4 busy: intervalli fusi del busy legacy (calendari bloccanti, confermati,
 *    timed, proiezioni delle prenotazioni escluse) contro il busy della
 *    destinazione (computeBlocks più blocks_availability), su [oggi, oggi +
 *    180] (14 giorni nel giro orario dello shadow), senza iscrizioni (entra nel
 *    colore) e con le iscrizioni (informativa);
 *  - V5 feed: insieme di (UID pubblicato, istanze nella finestra del feed) del
 *    feed legacy contro buildFeed di calendar-core sugli oggetti di Radicale,
 *    per i calendari con il feed attivo.
 *
 * Colori: verde senza differenze, giallo con sole differenze ATTESE (motivo
 * in EXPECTED_DIFF_REASONS, preso dagli expected_reasons dell'oggetto del
 * serializer o dal motivo del salto), rosso con almeno una inattesa. Ogni
 * differenza ha una firma (diffSignature): alla fine del run l'accettazione
 * delle differenze con la stessa firma nei run precedenti si riporta su
 * questo run (report.carryOverAcceptances), così il giro notturno dello shadow
 * non chiede di riaccettare ogni notte le stesse differenze attese.
 *
 * La verifica gira sotto il lock `cal-migration` (nessuno shadow nel
 * frattempo), legge sorgente e destinazione una volta e usa lo stesso `now`
 * per tutte le finestre. Non scrive né su Radicale né sul ledger. Nessun dato
 * personale nei dettagli: id, UID, istanti, etag, fingerprint e conteggi.
 */

import { createHash } from 'node:crypto';
import {
  type CalendarObject,
  classifyOccurrenceKind,
  componentRecurrenceKey,
  computeBlocks,
  expandObject,
  type ExpandedOccurrence,
  FEED_FUTURE_DAYS,
  FEED_PAST_DAYS,
  type FeedObjectInput,
  buildFeed,
  feedUid,
  fieldValuesEqual,
  getProperties,
  type IcsComponent,
  legacyAllDayPointToDate,
  legacyAllDayToRange,
  localDateOf,
  localMidnightUtcMs,
  parseCalendarObject,
  parseIcs,
  parseObjectHref,
  type PatchFieldName,
  readFieldValues,
  splitCalendar,
  X_CALDES,
} from '@calicchia/calendar-core';
import { logger as rootLogger } from '../../logger';
import { feedUidDomain, feedWindowAnchor, readBookingProjectionData } from '../feed-builder';
import type { Db } from '../radicale/policy';
import { getPgLegacyStore } from '../store';
import type { CalendarEventOccurrence } from '../types';
import { readLedger, withMigrationRunLock } from './apply';
import { effectivePlanScope, readTargetSnapshot, type TargetSnapshot } from './plan';
import { assertMigrationWritable, requireRadicale } from './preflight';
import { buildVerdicts, carryOverAcceptances, type DiffRowLite } from './report';
import { canonicalJson, type LegacySource, loadLegacySource, serializeLegacy } from './serialize';
import {
  DEFAULT_MIGRATION_OPTIONS,
  type ExpectedDiffReason,
  type LedgerRow,
  type LegacyKey,
  MIGRATION_LIMITS,
  type MigrationCalendar,
  MigrationError,
  type MigrationItemInput,
  type MigrationOptions,
  type MigrationRunContext,
  type MigrationScope,
  resolveMigrationOptions,
  type SerializationResult,
  type SerializedObject,
  type SkipCode,
  type SkippedSource,
  type VerifyColor,
  type VerifyDiff,
  type VerifyDiffCode,
  type VerifyDiffDetail,
  type VerifyLevel,
  VERIFY_LEVELS,
  type VerifyParams,
  type VerifySummary,
  worstColor,
} from './types';

const log = rootLogger.child({ scope: 'calendar-migration-verify' });

const DAY_MS = 86_400_000;
/** Il contratto ammette al più 500 righe per addItems. */
const ROWS_CHUNK = 500;
/** Differenze dello stesso tipo per oggetto oltre le quali si scrive una riga riassuntiva. */
export const MAX_DIFFS_PER_OBJECT = 100;
/** Elementi degli elenchi nei dettagli (istanze del feed, chiavi del busy). */
const DETAIL_LIST_MAX = 20;

// ─── Motivi attesi per livello (contratto §8.1) ───────────────────────────────

/**
 * Motivi ammessi per livello, in ordine di specificità (vince il primo che
 * l'oggetto ha). V1 e V2 non ammettono differenze attese.
 *
 * V5 comprende, oltre ai motivi elencati nel contratto, quelli che
 * EXPECTED_DIFF_REASONS di types.ts documenta anche per il feed
 * (BOOKING_REGENERATED, DUPLICATE_HOLIDAY_SKIPPED) e quelli che cambiano le
 * istanze pubblicate di un oggetto per effetto di un'opzione dell'anteprima
 * (UNTIL_REALIGNED, MIXED_BYDAY, INVALID_RRULE_SINGLE, ALLDAY_NORMALIZED):
 * restano gialle da accettare, mai verdi.
 */
export const LEVEL_EXPECTED_REASONS: Readonly<Record<'V3' | 'V4' | 'V5', readonly ExpectedDiffReason[]>> = Object.freeze({
  V3: ['NON_PROJECTION_MOVED', 'ORPHAN_CONVERTED', 'DST_REALIGNED', 'UNTIL_REALIGNED', 'INVALID_RRULE_SINGLE', 'MIXED_BYDAY',
    'ALLDAY_NORMALIZED', 'CANCELLED_MASTER_SKIPPED', 'DUPLICATE_HOLIDAY_SKIPPED', 'BOOKING_DRIFT', 'BOOKING_REGENERATED'],
  V4: ['DST_REALIGNED', 'UNTIL_REALIGNED', 'INVALID_RRULE_SINGLE', 'MIXED_BYDAY', 'BOOKING_DRIFT'],
  V5: ['OVERRIDE_UID_MASTER', 'CANCELLED_OVERRIDE_SUPPRESSED', 'DST_REALIGNED', 'ORPHAN_CONVERTED', 'CANCELLED_MASTER_SKIPPED',
    'NON_PROJECTION_MOVED', 'DUPLICATE_HOLIDAY_SKIPPED', 'BOOKING_REGENERATED', 'BOOKING_DRIFT', 'UNTIL_REALIGNED', 'MIXED_BYDAY',
    'INVALID_RRULE_SINGLE', 'ALLDAY_NORMALIZED'],
});

/** UID presenti in un feed e non nell'altro: solo i motivi che spiegano la presenza (un UID diverso dal legacy è rosso). */
const V5_MISSING_OVERRIDE_REASONS: readonly ExpectedDiffReason[] = ['OVERRIDE_UID_MASTER', 'ORPHAN_CONVERTED', 'CANCELLED_MASTER_SKIPPED', 'NON_PROJECTION_MOVED'];
const V5_MISSING_REASONS: readonly ExpectedDiffReason[] = ['CANCELLED_MASTER_SKIPPED', 'DUPLICATE_HOLIDAY_SKIPPED', 'NON_PROJECTION_MOVED', 'BOOKING_DRIFT', 'ORPHAN_CONVERTED'];
const V5_EXTRA_REASONS: readonly ExpectedDiffReason[] = ['NON_PROJECTION_MOVED', 'BOOKING_REGENERATED', 'ORPHAN_CONVERTED'];
const V4_SUBSCRIPTION_MISSING: ExpectedDiffReason = 'SUBSCRIPTION_RESYNCED';
const V4_SUBSCRIPTION_EXTRA: ExpectedDiffReason = 'SUBSCRIPTION_BLOCKING_IMPACT';

/** Motivo atteso di una sorgente saltata dal serializer. */
const SKIP_REASONS: Readonly<Partial<Record<SkipCode, ExpectedDiffReason>>> = Object.freeze({
  CANCELLED_MASTER: 'CANCELLED_MASTER_SKIPPED',
  DUPLICATE_HOLIDAY: 'DUPLICATE_HOLIDAY_SKIPPED',
  BOOKING_NOT_PROJECTED: 'BOOKING_DRIFT',
  // Orfano scartato per scelta (opzione orphans: discard): stessa classe dell'orfano convertito.
  ORPHAN_DISCARDED: 'ORPHAN_CONVERTED',
});

// ─── Funzioni pure del contratto ───────────────────────────────

/** Finestre di al più `maxDays` giorni su [from, to) (V3; design §13.7). Pura. */
export function v3Windows(from: Date, to: Date, maxDays: number = MIGRATION_LIMITS.v3WindowDays): Array<{ from: Date; to: Date }> {
  const a = from.getTime();
  const b = to.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError('v3Windows: estremi non validi');
  if (!Number.isFinite(maxDays) || maxDays <= 0) throw new TypeError(`v3Windows: ampiezza non valida (${maxDays})`);
  const step = Math.max(1, Math.floor(maxDays * DAY_MS));
  const out: Array<{ from: Date; to: Date }> = [];
  for (let t = a; t < b; t += step) out.push({ from: new Date(t), to: new Date(Math.min(t + step, b)) });
  return out;
}

/**
 * Firma di una differenza (VerifyDiffDetail.signature): sha256 del JSON
 * canonico di livello, codice, calendario, chiave legacy, motivo, valori
 * legacy e destinazione e variante del busy. Pura.
 */
export function diffSignature(diff: Omit<VerifyDiff, 'detail'> & { detail: Omit<VerifyDiffDetail, 'signature'> }): string {
  const d = diff.detail;
  const payload = canonicalJson([
    diff.level,
    diff.code,
    diff.calendar_id ?? null,
    diff.legacy_key ?? null,
    d.reason ?? null,
    d.legacy ?? null,
    d.target ?? null,
    d.variant ?? null,
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ─── Indice della sorgente e della destinazione ───────────────────────────────

type SourceRow = LegacySource['events'][number];

interface VerifyIndex {
  source: LegacySource;
  serialization: SerializationResult;
  calById: Map<string, MigrationCalendar>;
  rowsById: Map<string, SourceRow>;
  sByKey: Map<string, SerializedObject>;
  sByCalHref: Map<string, SerializedObject>;
  skipByKey: Map<string, SkippedSource>;
  ledger: LedgerRow[];
  ledgerByCalHref: Map<string, LedgerRow>;
  target: TargetSnapshot;
  parsed: Map<string, CalendarObject | null>;
  now: Date;
}

function calHref(calendarId: string, href: string): string {
  return `${calendarId}|${href}`;
}

function parsedTarget(idx: VerifyIndex, calendarId: string, href: string): CalendarObject | null {
  const k = calHref(calendarId, href);
  if (idx.parsed.has(k)) return idx.parsed.get(k) ?? null;
  const t = idx.target.collections.get(calendarId)?.objects.get(href);
  let obj: CalendarObject | null = null;
  if (t?.raw) {
    const res = parseCalendarObject(t.raw);
    obj = res.ok ? res.value : null;
  }
  idx.parsed.set(k, obj);
  return obj;
}

/** Chiave legacy dell'oggetto della destinazione: riga del ledger, poi oggetto voluto allo stesso href. */
function targetKey(idx: VerifyIndex, calendarId: string, href: string): string {
  const l = idx.ledgerByCalHref.get(calHref(calendarId, href));
  if (l) return l.legacy_key;
  const s = idx.sByCalHref.get(calHref(calendarId, href));
  return s ? s.legacy_key : `untracked:${href}`;
}

function isLegacyKey(key: string): key is LegacyKey {
  return /^(event|detached|booking|archive):/.test(key);
}

/** Primo motivo ammesso fra quelli dell'oggetto, del salto e (per le proiezioni) della rigenerazione. */
function reasonFor(idx: VerifyIndex, key: string, allowed: readonly ExpectedDiffReason[]): ExpectedDiffReason | null {
  const candidates = new Set<ExpectedDiffReason>();
  const s = idx.sByKey.get(key);
  if (s) for (const r of s.expected_reasons) candidates.add(r);
  const skip = idx.skipByKey.get(key);
  if (skip) {
    const r = SKIP_REASONS[skip.code];
    if (r) candidates.add(r);
  }
  if (key.startsWith('booking:')) candidates.add('BOOKING_REGENERATED');
  for (const r of allowed) if (candidates.has(r)) return r;
  return null;
}

// ─── Raccolta delle differenze ───────────────────────────────

class DiffCollector {
  readonly diffs: VerifyDiff[] = [];
  private readonly perGroup = new Map<string, { count: number; omitted: number; sample: VerifyDiff }>();

  constructor(private readonly verified: ReadonlySet<string>) {}

  /**
   * Aggiunge una differenza (solo per i calendari verificati, salvo `global`:
   * V4 è globale e una differenza del busy entra nel colore di ogni calendario
   * con oggetti sovrapposti, anche se escluso dal piano), con il tetto per
   * oggetto e codice.
   */
  add(input: Omit<VerifyDiff, 'detail' | 'expected'> & { detail: Omit<VerifyDiffDetail, 'signature'>; expected?: boolean; global?: boolean }): void {
    if (!input.calendar_id || (!input.global && !this.verified.has(input.calendar_id))) return;
    const expected = input.expected ?? input.detail.reason !== null;
    const groupKey = `${input.level}|${input.code}|${input.calendar_id}|${input.legacy_key ?? input.href ?? ''}|${input.detail.variant ?? ''}`;
    const group = this.perGroup.get(groupKey);
    const diff: VerifyDiff = {
      level: input.level,
      code: input.code,
      expected,
      calendar_id: input.calendar_id,
      collection_name: input.collection_name,
      href: input.href,
      legacy_key: input.legacy_key,
      detail: { ...input.detail, signature: '' },
    };
    if (group && group.count >= MAX_DIFFS_PER_OBJECT) {
      group.omitted += 1;
      return;
    }
    diff.detail.signature = diffSignature(diff);
    this.diffs.push(diff);
    if (group) group.count += 1;
    else this.perGroup.set(groupKey, { count: 1, omitted: 0, sample: diff });
  }

  /** Righe riassuntive dei gruppi oltre il tetto (firma stabile, senza il conteggio). */
  finish(): void {
    for (const g of this.perGroup.values()) {
      if (g.omitted === 0) continue;
      const s = g.sample;
      const diff: VerifyDiff = {
        level: s.level,
        code: s.code,
        expected: s.expected,
        calendar_id: s.calendar_id,
        collection_name: s.collection_name,
        href: s.href,
        legacy_key: s.legacy_key,
        detail: {
          reason: s.detail.reason,
          signature: '',
          variant: s.detail.variant,
          legacy: { omitted: true },
          target: null,
          message: `altre ${g.omitted} differenze dello stesso tipo per questo oggetto (elenco troncato a ${MAX_DIFFS_PER_OBJECT})`,
        },
      };
      diff.detail.signature = diffSignature({ ...diff, detail: { ...diff.detail, message: null } });
      this.diffs.push(diff);
    }
  }
}

// ─── V1 ───────────────────────────────

function verifyV1(idx: VerifyIndex, calendars: readonly MigrationCalendar[], out: DiffCollector, opts: { orphans: boolean }): void {
  for (const cal of calendars) {
    const name = cal.collection_name as string;
    const coll = idx.target.collections.get(cal.id);
    if (!coll || !coll.exists) {
      out.add({ level: 'V1', code: 'COLLECTION_MISSING', calendar_id: cal.id, collection_name: name, href: null, legacy_key: null, detail: { reason: null, legacy: { collection_name: name }, target: null, message: 'Collezione assente su Radicale: serve "Crea collezioni mancanti"' } });
      continue;
    }
    const tracked = new Set<string>();
    for (const l of idx.ledger) {
      if (l.calendar_id !== cal.id) continue;
      if (l.intent_op) {
        tracked.add(l.href);
        const t = coll.objects.get(l.href);
        out.add({ level: 'V1', code: 'LEDGER_INTENT_PENDING', calendar_id: cal.id, collection_name: name, href: l.href, legacy_key: l.legacy_key, detail: { reason: null, uid: l.uid, legacy: { href: l.href, intent_op: l.intent_op, intent_fingerprint: l.intent_fingerprint }, target: t ? { href: l.href, etag: t.etag } : null, message: 'Intento pendente: lo risolve il prossimo apply' } });
        continue;
      }
      if (l.written_at === null && l.written_etag === null) continue; // riga senza scritture: non traccia nulla
      tracked.add(l.href);
      const t = coll.objects.get(l.href);
      if (!t) {
        out.add({ level: 'V1', code: 'LEDGER_TARGET_MISSING', calendar_id: cal.id, collection_name: name, href: l.href, legacy_key: l.legacy_key, detail: { reason: null, uid: l.uid, legacy: { href: l.href, written_etag: l.written_etag }, target: null, message: 'Oggetto scritto dallo strumento e sparito da Radicale' } });
      } else if (l.written_etag === null || t.etag !== l.written_etag) {
        out.add({ level: 'V1', code: 'LEDGER_ETAG_MISMATCH', calendar_id: cal.id, collection_name: name, href: l.href, legacy_key: l.legacy_key, detail: { reason: null, uid: l.uid, legacy: { href: l.href, written_etag: l.written_etag }, target: { href: l.href, etag: t.etag }, message: l.written_etag === null ? 'Etag della scrittura non registrato' : 'Oggetto cambiato fuori dallo strumento' } });
      }
    }
    for (const t of coll.objects.values()) {
      if (tracked.has(t.href)) continue;
      out.add({ level: 'V1', code: 'TARGET_UNTRACKED', calendar_id: cal.id, collection_name: name, href: t.href, legacy_key: null, detail: { reason: null, uid: t.uid, legacy: null, target: { href: t.href, etag: t.etag, uid: t.uid }, message: 'Oggetto su Radicale non tracciato dal ledger (il piano non lo cancella mai)' } });
    }
  }

  if (!opts.orphans) return;
  // Righe vive di calendari cancellati in PG: la collezione resta su Radicale (contratto §3.4).
  const orphanCals = new Map<string, { collection_name: string; rows: number }>();
  for (const l of idx.ledger) {
    if (idx.calById.has(l.calendar_id)) continue;
    const e = orphanCals.get(l.calendar_id) ?? { collection_name: l.collection_name, rows: 0 };
    e.rows += 1;
    orphanCals.set(l.calendar_id, e);
  }
  for (const [calendarId, e] of orphanCals) {
    out.add({ level: 'V1', code: 'TARGET_UNTRACKED', calendar_id: calendarId, collection_name: e.collection_name, href: null, legacy_key: null, detail: { reason: null, legacy: null, target: { collection_name: e.collection_name, ledger_rows: e.rows }, message: 'Calendario cancellato in PG: la collezione e i suoi oggetti restano su Radicale' } });
  }
}

// ─── V2 ───────────────────────────────

/** Campi che il serializer scrive (confronto delle righe adottate o derivate). */
const PLAN_FIELDS: readonly PatchFieldName[] = ['summary', 'description', 'location', 'url', 'status', 'start', 'end', 'duration', 'rrule', 'rdates', 'exdates'];
const PROVENANCE_XPROPS: readonly string[] = [X_CALDES.SOURCE, X_CALDES.SOURCE_ID, X_CALDES.LEGACY_ID, X_CALDES.LEGACY_RRULE];

function componentFieldDiffs(a: IcsComponent, b: IcsComponent, prefix: string): string[] {
  const out: string[] = [];
  const va = readFieldValues(a, PLAN_FIELDS) as Record<string, unknown>;
  const vb = readFieldValues(b, PLAN_FIELDS) as Record<string, unknown>;
  for (const f of PLAN_FIELDS) {
    const x = va[f];
    const y = vb[f];
    if (x === undefined && y === undefined) continue;
    if (x === undefined || y === undefined || !fieldValuesEqual(f, x as never, y as never)) out.push(`${prefix}${f}`);
  }
  for (const name of PROVENANCE_XPROPS) {
    const x = getProperties(a, name).map((p) => p.value).sort().join('\n');
    const y = getProperties(b, name).map((p) => p.value).sort().join('\n');
    if (x !== y) out.push(`${prefix}${name}`);
  }
  return out;
}

/** Campi del piano diversi fra l'oggetto di Radicale e quello voluto (master, override per recurrence key, provenienza). */
export function planFieldDiffs(target: CalendarObject, wanted: CalendarObject, tz: string): string[] {
  if (!target.master || !wanted.master) return target.master === wanted.master ? [] : ['master'];
  const out = componentFieldDiffs(target.master, wanted.master, '');
  const keysOf = (obj: CalendarObject): Map<string, IcsComponent> => {
    const m = new Map<string, IcsComponent>();
    for (const c of obj.overrides) {
      try {
        m.set(componentRecurrenceKey(c, { tz, timezones: obj.timezones }), c);
      } catch {
        m.set(`?${m.size}`, c);
      }
    }
    return m;
  };
  const ta = keysOf(target);
  const tb = keysOf(wanted);
  for (const k of [...new Set([...ta.keys(), ...tb.keys()])].sort()) {
    const a = ta.get(k);
    const b = tb.get(k);
    if (!a || !b) out.push(`override[${k}]`);
    else out.push(...componentFieldDiffs(a, b, `override[${k}].`));
  }
  return out;
}

function verifyV2(idx: VerifyIndex, calendars: readonly MigrationCalendar[], out: DiffCollector): void {
  const ids = new Set(calendars.map((c) => c.id));
  for (const s of idx.serialization.objects) {
    if (!ids.has(s.calendar_id)) continue;
    const coll = idx.target.collections.get(s.calendar_id);
    if (!coll?.exists) continue; // V1 segnala la collezione mancante
    const t = coll.objects.get(s.href);
    const base = { level: 'V2' as const, calendar_id: s.calendar_id, collection_name: s.collection_name, href: s.href, legacy_key: s.legacy_key };
    if (!t || t.raw === null) {
      out.add({ ...base, code: 'PLAN_TARGET_MISSING', detail: { reason: null, uid: s.kind === 'booking' ? null : s.uid, legacy: { fingerprint: s.fingerprint, legacy_hash: s.legacy_hash }, target: null, message: 'Oggetto del piano assente su Radicale: serve un apply' } });
      continue;
    }
    const obj = parsedTarget(idx, s.calendar_id, s.href);
    if (!obj) {
      out.add({ ...base, code: 'TARGET_UNPARSABLE', detail: { reason: null, legacy: { fingerprint: s.fingerprint }, target: { href: t.href, etag: t.etag }, message: 'Testo su Radicale non leggibile' } });
      continue;
    }
    if (t.fingerprint !== null && t.fingerprint === s.fingerprint) continue;
    const wanted = parseCalendarObject(s.ics);
    const tz = s.legacy_snapshot.kind === 'archive' ? 'Europe/Rome' : s.legacy_snapshot.calendar.timezone;
    const fields = wanted.ok ? planFieldDiffs(obj, wanted.value, tz) : ['piano illeggibile'];
    const l = idx.ledgerByCalHref.get(calHref(s.calendar_id, s.href));
    // Righe adottate o derivate: solo i campi del piano (VALARM, ATTENDEE e X-* aggiunti dai device restano).
    if ((l?.adopted || l?.derived) && fields.length === 0) continue;
    out.add({ ...base, code: 'CONTENT_MISMATCH', detail: { reason: null, legacy: { fingerprint: s.fingerprint, legacy_hash: s.legacy_hash }, target: { etag: t.etag, fingerprint: t.fingerprint, fields }, message: fields.length ? `Campi diversi dal piano: ${fields.slice(0, DETAIL_LIST_MAX).join(', ')}` : 'Proprietà diverse dal piano fuori dai campi dello strumento' } });
  }
  // Oggetti scritti dallo strumento la cui sorgente non è più nel piano: cancellazione in attesa.
  for (const l of idx.ledger) {
    if (!ids.has(l.calendar_id) || l.kind === 'archive' || (l.written_at === null && l.written_etag === null)) continue;
    if (idx.sByCalHref.has(calHref(l.calendar_id, l.href))) continue;
    const t = idx.target.collections.get(l.calendar_id)?.objects.get(l.href);
    if (!t) continue;
    out.add({ level: 'V2', code: 'CONTENT_MISMATCH', calendar_id: l.calendar_id, collection_name: l.collection_name, href: l.href, legacy_key: l.legacy_key, detail: { reason: null, legacy: null, target: { etag: t.etag, fingerprint: t.fingerprint }, message: 'Oggetto senza sorgente nel piano: lo cancella il prossimo apply' } });
  }
}

// ─── Occorrenze (V3, V4) ───────────────────────────────

interface Occ {
  key: string;
  calendar_id: string;
  href: string | null;
  /** Istanza originale (secondi) per i timed, data locale per gli all-day. */
  match: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  status: 'CONFIRMED' | 'TENTATIVE';
  /** Istante usato per l'appartenenza all'intervallo verificato. */
  anchorMs: number;
}

function msOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value));
}

function secondsKey(ms: number): string {
  return String(Math.floor(ms / 1000));
}

function tzOfCal(idx: VerifyIndex, calendarId: string): string {
  return idx.calById.get(calendarId)?.timezone || 'Europe/Rome';
}

/** Oggetto e calendario di un'occorrenza legacy (gli override vanno nell'oggetto del master, gli orfani staccati nel proprio). */
function attributeLegacy(idx: VerifyIndex, occ: CalendarEventOccurrence): { key: string; calendar_id: string; detached: boolean } {
  const row = idx.rowsById.get(occ.id);
  const calendarId = String(occ.calendar_id);
  if (!row) return { key: `event:${occ.id}`, calendar_id: calendarId, detached: false };
  if (row.recurrence_master_id) {
    const master = idx.rowsById.get(row.recurrence_master_id);
    const masterCal = master?.calendar_id ?? row.calendar_id;
    const detached = `detached:${row.id}`;
    if (idx.sByKey.has(detached) || idx.skipByKey.has(detached)) return { key: detached, calendar_id: masterCal, detached: true };
    return { key: `event:${row.recurrence_master_id}`, calendar_id: masterCal, detached: false };
  }
  if (row.source === 'booking' && row.source_id) return { key: `booking:${row.source_id}`, calendar_id: row.calendar_id, detached: false };
  return { key: `event:${row.id}`, calendar_id: row.calendar_id, detached: false };
}

function legacyOcc(idx: VerifyIndex, occ: CalendarEventOccurrence): Occ {
  const a = attributeLegacy(idx, occ);
  const tz = tzOfCal(idx, a.calendar_id);
  const startMs = msOf(occ.start_time);
  const endMs = msOf(occ.end_time);
  const status = occ.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED';
  const original = !a.detached && occ.original_start !== null && occ.original_start !== undefined ? msOf(occ.original_start) : startMs;
  if (occ.all_day) {
    const range = legacyAllDayToRange(new Date(startMs), new Date(endMs), tz);
    const matchDate = !a.detached && occ.is_override && occ.original_start ? legacyAllDayPointToDate(new Date(original), tz) : range.start;
    return {
      key: a.key, calendar_id: a.calendar_id, href: null, match: `D${matchDate}`, startMs, endMs, allDay: true,
      startDate: range.start, endDate: range.end, status, anchorMs: localMidnightUtcMs(range.start, tz),
    };
  }
  return { key: a.key, calendar_id: a.calendar_id, href: null, match: secondsKey(original), startMs, endMs, allDay: false, startDate: null, endDate: null, status, anchorMs: startMs };
}

function targetOcc(key: string, calendarId: string, href: string, tz: string, o: ExpandedOccurrence): Occ | null {
  const status = (o.status ?? 'CONFIRMED').toUpperCase();
  if (status === 'CANCELLED') return null;
  const st: 'CONFIRMED' | 'TENTATIVE' = status === 'TENTATIVE' ? 'TENTATIVE' : 'CONFIRMED';
  const original = (o.kind === 'override' || o.kind === 'orphan_override') && o.originalStartUtc !== null ? o.originalStartUtc : o.startUtc;
  if (o.allDay && o.startDate && o.endDate) {
    const matchDate = original !== o.startUtc ? localDateOf(original, tz) : o.startDate;
    return { key, calendar_id: calendarId, href, match: `D${matchDate}`, startMs: o.startUtc, endMs: o.endUtc, allDay: true, startDate: o.startDate, endDate: o.endDate, status: st, anchorMs: localMidnightUtcMs(o.startDate, tz) };
  }
  return { key, calendar_id: calendarId, href, match: secondsKey(original), startMs: o.startUtc, endMs: o.endUtc, allDay: false, startDate: null, endDate: null, status: st, anchorMs: o.startUtc };
}

function occValue(o: Occ): Record<string, unknown> {
  return o.allDay
    ? { start_date: o.startDate, end_date: o.endDate, status: o.status }
    : { start: new Date(o.startMs).toISOString(), end: new Date(o.endMs).toISOString(), status: o.status };
}

function localDayOf(o: Occ, tz: string): string {
  return o.allDay ? (o.startDate as string) : localDateOf(o.startMs, tz);
}

/** Occorrenze della destinazione di una collezione nella finestra (espansione di calendar-core). */
function expandCollection(idx: VerifyIndex, cal: MigrationCalendar, from: Date, to: Date): Array<{ occ: ExpandedOccurrence; key: string; href: string; obj: CalendarObject }> {
  const coll = idx.target.collections.get(cal.id);
  if (!coll?.exists) return [];
  const tz = cal.timezone || 'Europe/Rome';
  const out: Array<{ occ: ExpandedOccurrence; key: string; href: string; obj: CalendarObject }> = [];
  for (const t of coll.objects.values()) {
    const obj = parsedTarget(idx, cal.id, t.href);
    if (!obj) continue;
    const key = targetKey(idx, cal.id, t.href);
    let res;
    try {
      res = expandObject(obj, { from: from.getTime(), to: to.getTime(), tz, computeRangeEnd: false });
    } catch (err) {
      log.warn({ calendarId: cal.id, href: t.href, err: (err as Error).message }, 'espansione della destinazione non riuscita');
      continue;
    }
    for (const occ of res.occurrences) out.push({ occ, key, href: t.href, obj });
  }
  return out;
}

async function legacyOccurrences(fromIso: string, toIso: string, blockingOnly: boolean): Promise<CalendarEventOccurrence[]> {
  return getPgLegacyStore().listOccurrences({ fromIso, toIso, blockingOnly });
}

// ─── V3 ───────────────────────────────

async function verifyV3(idx: VerifyIndex, calendars: readonly MigrationCalendar[], out: DiffCollector, ctx: { throwIfCancelled(): void; progress(p: { phase: string; done?: number; total?: number; message?: string }): Promise<void> }): Promise<void> {
  const verified = new Set(calendars.map((c) => c.id));
  const rangeFrom = new Date(idx.now.getTime() - MIGRATION_LIMITS.v3PastDays * DAY_MS);
  const rangeTo = new Date(idx.now.getTime() + MIGRATION_LIMITS.v3FutureDays * DAY_MS);
  const windows = v3Windows(rangeFrom, rangeTo, MIGRATION_LIMITS.v3WindowDays);
  const legacy = new Map<string, Map<string, Occ>>();
  const target = new Map<string, Map<string, Occ>>();
  const put = (map: Map<string, Map<string, Occ>>, o: Occ): void => {
    if (o.anchorMs < rangeFrom.getTime() || o.anchorMs >= rangeTo.getTime()) return;
    const m = map.get(o.key) ?? new Map<string, Occ>();
    if (!m.has(o.match)) m.set(o.match, o);
    map.set(o.key, m);
  };

  let w = 0;
  for (const win of windows) {
    ctx.throwIfCancelled();
    await ctx.progress({ phase: 'v3', done: w++, total: windows.length, message: 'V3: confronto delle occorrenze' });
    for (const occ of await legacyOccurrences(win.from.toISOString(), win.to.toISOString(), false)) {
      if (occ.source === 'ics_pull') continue; // iscrizioni: mai copiate
      const o = legacyOcc(idx, occ);
      const sCal = idx.sByKey.get(o.key)?.calendar_id;
      if (!verified.has(o.calendar_id) && !(sCal && verified.has(sCal))) continue;
      put(legacy, o);
    }
    for (const cal of calendars) {
      const tz = cal.timezone || 'Europe/Rome';
      for (const e of expandCollection(idx, cal, win.from, win.to)) {
        const o = targetOcc(e.key, cal.id, e.href, tz, e.occ);
        if (o) put(target, o);
      }
    }
  }

  const collectionOf = (calendarId: string): string | null => idx.calById.get(calendarId)?.collection_name ?? null;
  const emit = (code: VerifyDiffCode, o: Occ | null, t: Occ | null, key: string): void => {
    const calendarId = (code === 'OCCURRENCE_MISSING' ? o?.calendar_id : t?.calendar_id ?? o?.calendar_id) as string;
    out.add({
      level: 'V3',
      code,
      calendar_id: calendarId,
      collection_name: collectionOf(calendarId),
      href: t?.href ?? idx.sByKey.get(key)?.href ?? null,
      legacy_key: isLegacyKey(key) ? key : null,
      detail: {
        reason: reasonFor(idx, key, LEVEL_EXPECTED_REASONS.V3),
        uid: key.startsWith('booking:') ? null : idx.sByKey.get(key)?.uid ?? null,
        recurrence_key: (o ?? t)?.match ?? null,
        legacy: o ? occValue(o) : null,
        target: t ? occValue(t) : null,
      },
    });
  };

  const keys = [...new Set([...legacy.keys(), ...target.keys()])].sort();
  for (const key of keys) {
    const lm = new Map(legacy.get(key) ?? []);
    const tm = new Map(target.get(key) ?? []);
    const pairs: Array<[Occ, Occ]> = [];
    // 1. Stessa istanza originale.
    for (const [match, o] of [...lm.entries()]) {
      const t = tm.get(match);
      if (!t) continue;
      pairs.push([o, t]);
      lm.delete(match);
      tm.delete(match);
    }
    // 2. Stesso giorno locale (occorrenza spostata nella giornata, eccezione riallineata), in ordine d'inizio.
    if (lm.size && tm.size) {
      const tz = tzOfCal(idx, (lm.values().next().value as Occ).calendar_id);
      const byDay = new Map<string, Occ[]>();
      for (const t of [...tm.values()].sort((a, b) => a.startMs - b.startMs)) {
        const d = localDayOf(t, tz);
        const list = byDay.get(d) ?? [];
        list.push(t);
        byDay.set(d, list);
      }
      for (const [match, o] of [...lm.entries()].sort((a, b) => a[1].startMs - b[1].startMs)) {
        const list = byDay.get(localDayOf(o, tz));
        const t = list?.shift();
        if (!t) continue;
        pairs.push([o, t]);
        lm.delete(match);
        tm.delete(t.match);
      }
    }
    for (const [o, t] of pairs) {
      if (o.calendar_id !== t.calendar_id) {
        // Oggetto in un'altra collezione (spostamento della decisione 8): manca da una parte, in più dall'altra.
        emit('OCCURRENCE_MISSING', o, null, key);
        emit('OCCURRENCE_EXTRA', null, t, key);
        continue;
      }
      if (o.allDay !== t.allDay) emit('OCCURRENCE_ALLDAY_DIFF', o, t, key);
      else if (o.allDay ? (o.startDate !== t.startDate || o.endDate !== t.endDate) : (Math.floor(o.startMs / 1000) !== Math.floor(t.startMs / 1000) || Math.floor(o.endMs / 1000) !== Math.floor(t.endMs / 1000))) {
        emit('OCCURRENCE_TIME_DIFF', o, t, key);
      }
      if (o.status !== t.status) emit('OCCURRENCE_STATUS_DIFF', o, t, key);
    }
    for (const o of lm.values()) emit('OCCURRENCE_MISSING', o, null, key);
    for (const t of tm.values()) emit('OCCURRENCE_EXTRA', null, t, key);
  }
}

// ─── V4 ───────────────────────────────

interface Interval { start: number; end: number }
interface BusyOcc extends Interval { key: string; calendar_id: string; subscription: boolean }

/** Unione ordinata di intervalli [start, end): sovrapposti e contigui si fondono, i vuoti si scartano. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).map((i) => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

/** a − b per due unioni ordinate (mergeIntervals). */
export function subtractIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let j = 0;
  for (const seg of a) {
    let cur = seg.start;
    while (j < b.length && b[j].end <= cur) j++;
    let k = j;
    while (k < b.length && b[k].start < seg.end) {
      if (b[k].start > cur) out.push({ start: cur, end: b[k].start });
      cur = Math.max(cur, b[k].end);
      if (cur >= seg.end) break;
      k++;
    }
    if (cur < seg.end) out.push({ start: cur, end: seg.end });
  }
  return out;
}

async function verifyV4(
  idx: VerifyIndex,
  included: readonly MigrationCalendar[],
  db: Db,
  days: number,
  out: DiffCollector,
  ctx: { throwIfCancelled(): void; progress(p: { phase: string; done?: number; total?: number; message?: string }): Promise<void> },
): Promise<{ from: string; to: string; without: VerifyColor; with: VerifyColor }> {
  const from = idx.now;
  const to = new Date(idx.now.getTime() + days * DAY_MS);
  const clip = (i: Interval): Interval => ({ start: Math.max(i.start, from.getTime()), end: Math.min(i.end, to.getTime()) });
  const legacyOwn: BusyOcc[] = [];
  const legacySubs: BusyOcc[] = [];
  const targetOwn: BusyOcc[] = [];
  const seenTarget = new Set<string>();

  const windows = v3Windows(from, to, MIGRATION_LIMITS.v3WindowDays);
  let w = 0;
  for (const win of windows) {
    ctx.throwIfCancelled();
    await ctx.progress({ phase: 'v4', done: w++, total: windows.length, message: 'V4: confronto del busy' });
    // Semantica di legacy/events-pg.getBusyRanges: calendari bloccanti, confermati, timed; proiezioni escluse.
    for (const occ of await legacyOccurrences(win.from.toISOString(), win.to.toISOString(), true)) {
      if (occ.status !== 'confirmed' || occ.all_day || occ.source === 'booking') continue;
      const range = clip({ start: msOf(occ.start_time), end: msOf(occ.end_time) });
      if (range.end <= range.start) continue;
      if (occ.source === 'ics_pull') {
        legacySubs.push({ ...range, key: `subscription:${occ.calendar_id}`, calendar_id: String(occ.calendar_id), subscription: true });
        continue;
      }
      const a = attributeLegacy(idx, occ);
      legacyOwn.push({ ...range, key: a.key, calendar_id: a.calendar_id, subscription: false });
    }
    for (const cal of included) {
      if (!cal.blocks_availability) continue;
      const role = cal.role;
      for (const e of expandCollection(idx, cal, win.from, win.to)) {
        const o = e.occ;
        const kind = classifyOccurrenceKind(role, e.href, o.kind);
        if (!computeBlocks({ componentType: e.obj.componentType, status: o.status, transp: o.transp, allDay: o.allDay, kind })) continue;
        const range = clip({ start: o.startUtc, end: o.endUtc });
        if (range.end <= range.start) continue;
        const dedupe = `${cal.id}|${e.href}|${o.recurrenceKey}|${o.startUtc}`;
        if (seenTarget.has(dedupe)) continue;
        seenTarget.add(dedupe);
        targetOwn.push({ ...range, key: e.key, calendar_id: cal.id, subscription: false });
      }
    }
  }

  // Indice delle iscrizioni (sidecar), come se tutte bloccassero (variante informativa).
  const subRows = await db<Array<{ start_utc: Date; end_utc: Date; calendar_id: string; parent: string | null }>>`
    SELECT o.start_utc, o.end_utc, c.id::text AS calendar_id, c.parent_calendar_id::text AS parent
    FROM cal_occurrences o
    JOIN calendars c ON c.id = o.calendar_id
    WHERE c.role = 'subscription' AND o.blocks
      AND o.span && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')
  `;
  const targetSubs: BusyOcc[] = subRows
    .map((r) => ({ ...clip({ start: r.start_utc.getTime(), end: r.end_utc.getTime() }), key: `subscription:${r.calendar_id}`, calendar_id: r.parent ?? r.calendar_id, subscription: true }))
    .filter((r) => r.end > r.start);

  const overlapping = (list: readonly BusyOcc[], i: Interval): BusyOcc[] => list.filter((o) => o.start < i.end && o.end > i.start);
  const iso = (ms: number): string => new Date(ms).toISOString();

  const emitBusy = (code: 'BUSY_MISSING' | 'BUSY_EXTRA', interval: Interval, contributors: BusyOcc[], variant: 'without_subscriptions' | 'with_subscriptions', reason: ExpectedDiffReason | null): void => {
    const byCal = new Map<string, Set<string>>();
    for (const c of contributors) {
      const set = byCal.get(c.calendar_id) ?? new Set<string>();
      set.add(c.key);
      byCal.set(c.calendar_id, set);
    }
    for (const [calendarId, keys] of byCal) {
      const list = [...keys].sort();
      const value = { start: iso(interval.start), end: iso(interval.end), keys: list.slice(0, DETAIL_LIST_MAX) };
      out.add({
        global: true,
        level: 'V4',
        code,
        calendar_id: calendarId,
        collection_name: idx.calById.get(calendarId)?.collection_name ?? null,
        href: null,
        legacy_key: list.length === 1 && isLegacyKey(list[0]) ? list[0] : null,
        expected: variant === 'with_subscriptions' ? true : reason !== null,
        detail: {
          reason,
          variant,
          window: { from: iso(from.getTime()), to: iso(to.getTime()) },
          legacy: code === 'BUSY_MISSING' ? value : null,
          target: code === 'BUSY_EXTRA' ? value : null,
          message: variant === 'with_subscriptions' ? 'Impatto delle iscrizioni sul busy (informativo)' : null,
        },
      });
    }
  };

  const ownReason = (contributors: BusyOcc[]): ExpectedDiffReason | null => {
    for (const r of LEVEL_EXPECTED_REASONS.V4) {
      if (contributors.some((c) => reasonFor(idx, c.key, [r]) === r)) return r;
    }
    return null;
  };

  // Senza iscrizioni: entra nel colore dei calendari con oggetti sovrapposti alla differenza.
  const lOwn = mergeIntervals(legacyOwn);
  const tOwn = mergeIntervals(targetOwn);
  let withoutCount = 0;
  let withoutUnexpected = false;
  for (const i of subtractIntervals(lOwn, tOwn)) {
    const contributors = overlapping(legacyOwn, i);
    const reason = ownReason(contributors);
    withoutCount++;
    if (!reason) withoutUnexpected = true;
    emitBusy('BUSY_MISSING', i, contributors, 'without_subscriptions', reason);
  }
  for (const i of subtractIntervals(tOwn, lOwn)) {
    const contributors = overlapping(targetOwn, i);
    const reason = ownReason(contributors);
    withoutCount++;
    if (!reason) withoutUnexpected = true;
    emitBusy('BUSY_EXTRA', i, contributors, 'without_subscriptions', reason);
  }

  // Con le iscrizioni: solo le differenze dovute alle iscrizioni (le altre sono già sopra), informative.
  const lWith = mergeIntervals([...legacyOwn, ...legacySubs]);
  const tWith = mergeIntervals([...targetOwn, ...targetSubs]);
  let withCount = 0;
  for (const i of subtractIntervals(lWith, tWith)) {
    const subs = overlapping(legacySubs, i);
    if (subs.length === 0) continue;
    withCount++;
    emitBusy('BUSY_MISSING', i, subs, 'with_subscriptions', V4_SUBSCRIPTION_MISSING);
  }
  for (const i of subtractIntervals(tWith, lWith)) {
    const subs = overlapping(targetSubs, i);
    if (subs.length === 0) continue;
    withCount++;
    emitBusy('BUSY_EXTRA', i, subs, 'with_subscriptions', V4_SUBSCRIPTION_EXTRA);
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    without: withoutCount === 0 ? 'green' : withoutUnexpected ? 'red' : 'yellow',
    with: withCount === 0 ? 'green' : 'yellow',
  };
}

// ─── V5 ───────────────────────────────

interface FeedInstances { uid: string; instances: Set<string> }

/** UID pubblicati e istanze (non cancellate) nella finestra di un feed ICS. */
function feedInstances(body: string, tz: string, from: number, to: number): Map<string, FeedInstances> {
  const out = new Map<string, FeedInstances>();
  const parsed = parseIcs(body);
  if (!parsed.ok) throw new MigrationError('INTERNAL', `feed illeggibile: ${parsed.error.message}`);
  const split = splitCalendar(parsed.value, { duplicateMasters: 'keep-first' });
  for (const obj of split.objects) {
    const set = new Set<string>();
    try {
      const res = expandObject(obj, { from, to, tz, computeRangeEnd: false });
      for (const o of res.occurrences) {
        if ((o.status ?? '').toUpperCase() === 'CANCELLED') continue;
        set.add(o.allDay && o.startDate && o.endDate ? `D${o.startDate}/${o.endDate}` : `${Math.floor(o.startUtc / 1000)}/${Math.floor(o.endUtc / 1000)}`);
      }
    } catch (err) {
      log.warn({ uid: obj.uid, err: (err as Error).message }, 'oggetto del feed non espandibile');
    }
    const existing = out.get(obj.uid);
    if (existing) for (const i of set) existing.instances.add(i);
    else out.set(obj.uid, { uid: obj.uid, instances: set });
  }
  return out;
}

function instanceLabel(i: string): string {
  if (i.startsWith('D')) return i.slice(1);
  const [s, e] = i.split('/').map((x) => new Date(Number(x) * 1000).toISOString());
  return `${s}/${e}`;
}

async function verifyV5(idx: VerifyIndex, calendars: readonly MigrationCalendar[], db: Db, out: DiffCollector, ctx: { throwIfCancelled(): void }): Promise<void> {
  const uidDomain = feedUidDomain();
  const legacyStore = getPgLegacyStore();
  const windowFrom = idx.now.getTime() - FEED_PAST_DAYS * DAY_MS;
  const windowTo = idx.now.getTime() + FEED_FUTURE_DAYS * DAY_MS;
  for (const cal of calendars) {
    ctx.throwIfCancelled();
    if (!cal.ics_feed_enabled) continue;
    const coll = idx.target.collections.get(cal.id);
    if (!coll?.exists) continue;
    const calendar = await legacyStore.getCalendar(cal.id);
    if (!calendar) continue;
    const tz = cal.timezone || 'Europe/Rome';
    const legacyFeed = await legacyStore.buildCalendarFeed(calendar, { now: idx.now, uidDomain });

    // Feed della destinazione: buildFeed sugli oggetti di Radicale con il legacy_uid preassegnato.
    const idRows = await db<Array<{ href: string; legacy_uid: string | null; legacy_event_id: string | null }>>`
      SELECT href, legacy_uid, legacy_event_id::text AS legacy_event_id
      FROM cal_object_ids
      WHERE calendar_id = ${cal.id}::uuid AND recurrence_key = '' AND retired_at IS NULL
    `;
    const idByHref = new Map(idRows.map((r) => [r.href, r]));
    const bookingUids: string[] = [];
    const objects: Array<{ href: string; obj: CalendarObject; bookingUid: string | null }> = [];
    for (const t of coll.objects.values()) {
      const obj = parsedTarget(idx, cal.id, t.href);
      if (!obj) continue;
      const info = parseObjectHref(t.href);
      const bookingUid = cal.role === 'bookings' && info.kind === 'booking' ? info.bookingUid : null;
      if (bookingUid) bookingUids.push(bookingUid);
      objects.push({ href: t.href, obj, bookingUid });
    }
    const bookingData = bookingUids.length ? await readBookingProjectionData(db, bookingUids) : new Map();
    const publishedToHref = new Map<string, string>();
    const inputs: FeedObjectInput[] = objects.map(({ href, obj, bookingUid }) => {
      const ids = idByHref.get(href);
      const s = idx.sByCalHref.get(calHref(cal.id, href));
      const legacyUid = ids?.legacy_uid ?? s?.legacy_uid ?? (ids?.legacy_event_id ? obj.uid : null);
      publishedToHref.set(feedUid(obj.uid, { uidDomain, legacyUid }), href);
      return { object: obj, firstSeenAt: idx.now, legacyUid, bookingProjection: bookingUid ? { data: bookingData.get(bookingUid) ?? null } : null };
    });
    const anchor = feedWindowAnchor(idx.now).anchor;
    const targetFeed = buildFeed({ name: cal.name, description: cal.description, timezone: tz, color: cal.color }, inputs, {
      now: anchor,
      uidDomain,
      tz,
      pastDays: FEED_PAST_DAYS,
      futureDays: FEED_FUTURE_DAYS + 1,
      onObjectError: (input, error) => log.warn({ calendarId: cal.id, uid: input.object.uid, code: error.code }, 'oggetto escluso dal feed della verifica'),
    });

    const L = feedInstances(legacyFeed.body, tz, windowFrom, windowTo);
    const T = feedInstances(targetFeed.body, tz, windowFrom, windowTo);

    // UID legacy → riga (per gli override, che il feed legacy pubblica con il proprio UID).
    const suffix = `@${uidDomain}`;
    const rowsByUid = new Map<string, SourceRow>();
    for (const r of idx.source.events) if (r.calendar_id === cal.id && !rowsByUid.has(r.uid)) rowsByUid.set(r.uid, r);
    const legacyKeyOf = (published: string): { key: string; override: boolean } => {
      const local = published.endsWith(suffix) ? published.slice(0, -suffix.length) : published;
      const row = rowsByUid.get(local);
      if (!row) return { key: `feed:${published}`, override: false };
      if (row.recurrence_master_id) {
        const detached = `detached:${row.id}`;
        if (idx.sByKey.has(detached) || idx.skipByKey.has(detached)) return { key: detached, override: false };
        return { key: `event:${row.recurrence_master_id}`, override: true };
      }
      if (row.source === 'booking' && row.source_id) return { key: `booking:${row.source_id}`, override: false };
      return { key: `event:${row.id}`, override: false };
    };
    const targetKeyOf = (published: string): string => {
      const href = publishedToHref.get(published);
      return href ? targetKey(idx, cal.id, href) : `feed:${published}`;
    };

    const base = { level: 'V5' as const, calendar_id: cal.id, collection_name: cal.collection_name };
    for (const uid of [...new Set([...L.keys(), ...T.keys()])].sort()) {
      const l = L.get(uid);
      const t = T.get(uid);
      if (l && t) {
        const onlyL = [...l.instances].filter((i) => !t.instances.has(i)).sort();
        const onlyT = [...t.instances].filter((i) => !l.instances.has(i)).sort();
        if (onlyL.length === 0 && onlyT.length === 0) continue;
        const key = targetKeyOf(uid);
        out.add({
          ...base, code: 'FEED_INSTANCES_DIFF', href: publishedToHref.get(uid) ?? null, legacy_key: isLegacyKey(key) ? key : null,
          detail: {
            reason: reasonFor(idx, key, LEVEL_EXPECTED_REASONS.V5),
            published_uid: uid,
            legacy: { only: onlyL.slice(0, DETAIL_LIST_MAX).map(instanceLabel), count: onlyL.length },
            target: { only: onlyT.slice(0, DETAIL_LIST_MAX).map(instanceLabel), count: onlyT.length },
          },
        });
      } else if (l) {
        if (l.instances.size === 0) continue;
        const { key, override } = legacyKeyOf(uid);
        out.add({
          ...base, code: 'FEED_UID_MISSING', href: null, legacy_key: isLegacyKey(key) ? key : null,
          detail: { reason: reasonFor(idx, key, override ? V5_MISSING_OVERRIDE_REASONS : V5_MISSING_REASONS), published_uid: uid, legacy: { instances: l.instances.size }, target: null },
        });
      } else if (t) {
        if (t.instances.size === 0) continue;
        const key = targetKeyOf(uid);
        out.add({
          ...base, code: 'FEED_UID_EXTRA', href: publishedToHref.get(uid) ?? null, legacy_key: isLegacyKey(key) ? key : null,
          detail: { reason: reasonFor(idx, key, V5_EXTRA_REASONS), published_uid: uid, legacy: null, target: { instances: t.instances.size } },
        });
      }
    }
  }
}

// ─── Run `verify` ───────────────────────────────

function normalizeVerifyParams(params: Partial<VerifyParams> | null | undefined): { scope: MigrationScope; levels: VerifyLevel[]; v4_days: number } {
  const p = params ?? {};
  const rawIds = Array.isArray(p.scope?.calendar_ids) ? p.scope.calendar_ids : [];
  if (rawIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new MigrationError('VALIDATION_FAILED', 'Ambito: attesi id di calendario UUID');
  }
  const ids = [...new Set(rawIds.map((id) => id.toLowerCase()))].sort();
  const rawLevels = Array.isArray(p.levels) && p.levels.length ? p.levels : [...VERIFY_LEVELS];
  if (rawLevels.some((l) => !(VERIFY_LEVELS as readonly string[]).includes(l))) {
    throw new MigrationError('VALIDATION_FAILED', `Livelli ammessi: ${VERIFY_LEVELS.join(', ')}`);
  }
  const levels = VERIFY_LEVELS.filter((l) => rawLevels.includes(l));
  const days = p.v4_days ?? MIGRATION_LIMITS.v4Days;
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new MigrationError('VALIDATION_FAILED', 'v4_days: atteso un intero fra 1 e 366');
  return { scope: ids.length ? { calendar_ids: ids } : {}, levels, v4_days: days };
}

/**
 * Opzioni con cui confrontare (lo stesso piano che l'apply ha scritto):
 * quelle dell'ultimo apply riuscito, altrimenti dell'ultima anteprima
 * riuscita, altrimenti quelle di default.
 */
export async function resolveVerifyOptions(db: Db): Promise<MigrationOptions> {
  const rows = await db<Array<{ kind: string; params: { options?: Partial<MigrationOptions> } | null }>>`
    SELECT kind, params FROM cal_migration_runs
    WHERE status = 'succeeded' AND kind IN ('apply', 'plan')
    ORDER BY (kind = 'apply') DESC, finished_at DESC NULLS LAST
    LIMIT 1
  `;
  try {
    return resolveMigrationOptions(rows[0]?.params?.options ?? null);
  } catch {
    return { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] };
  }
}

/** Verifica con i conteggi in più rispetto al riassunto del contratto. */
export interface VerifyRunSummary extends VerifySummary {
  now: string;
  scope: MigrationScope;
  options: MigrationOptions;
  /** Differenze informative (V4 con le iscrizioni): fuori dal colore e dall'accettazione. */
  informative: number;
  carried_over: number;
}

type VerifyCtx = MigrationRunContext<VerifyParams>;

/** V1-V5 sui calendari dell'ambito (§8); righe 'diff' con la firma; riporto delle accettazioni. */
export async function runVerify(ctx: VerifyCtx): Promise<VerifySummary> {
  return withMigrationRunLock(ctx.db, () => verifyLocked(ctx));
}

async function verifyLocked(ctx: VerifyCtx): Promise<VerifyRunSummary> {
  const params = normalizeVerifyParams(ctx.params);
  const { client, principal } = requireRadicale();
  // Una destinazione senza identità verificata non si confronta: sarebbe un volume estraneo.
  await assertMigrationWritable({ db: ctx.db, client, principal });
  const now = new Date();
  const options = await resolveVerifyOptions(ctx.db);
  ctx.throwIfCancelled();

  await ctx.progress({ phase: 'read-legacy', message: 'Lettura dei calendari legacy' });
  const scope = await effectivePlanScope(ctx.db, params.scope, options);
  const source = await loadLegacySource(ctx.db, { now });
  const serialization = serializeLegacy(source, options, { now });
  const included = source.calendars.filter((c) => c.included && c.collection_name);
  const scopeIds = scope.calendar_ids?.length ? new Set(scope.calendar_ids) : null;
  const verified = scopeIds ? included.filter((c) => scopeIds.has(c.id)) : included;
  const ledger = await readLedger(ctx.db, {});
  ctx.throwIfCancelled();

  await ctx.progress({ phase: 'read-target', message: 'Lettura delle collezioni di Radicale' });
  // V4 è globale: con V4 si leggono tutte le collezioni incluse.
  const toRead = params.levels.includes('V4') ? included : verified;
  const needContent = params.levels.some((l) => l !== 'V1');
  const target = await readTargetSnapshot(
    client,
    principal,
    toRead.map((c) => ({ calendar_id: c.id, collection_name: c.collection_name as string })).sort((a, b) => a.collection_name.localeCompare(b.collection_name)),
    { needContent: () => needContent, signal: ctx.signal },
  );
  ctx.throwIfCancelled();

  const live = ledger.filter((l) => l.deleted_at === null);
  const idx: VerifyIndex = {
    source,
    serialization,
    calById: new Map(source.calendars.map((c) => [c.id, c])),
    rowsById: new Map(source.events.map((e) => [e.id, e])),
    sByKey: new Map(serialization.objects.map((o) => [o.legacy_key, o])),
    sByCalHref: new Map(serialization.objects.map((o) => [calHref(o.calendar_id, o.href), o])),
    skipByKey: new Map(serialization.skipped.map((s) => [s.legacy_key, s])),
    ledger: live,
    ledgerByCalHref: new Map(live.map((l) => [calHref(l.calendar_id, l.href), l])),
    target,
    parsed: new Map(),
    now,
  };

  // Calendari che ricevono righe: quelli verificati e, senza ambito, quelli cancellati con righe nel ledger (V4 è globale: le sue righe vanno ai calendari con oggetti sovrapposti).
  const rowCalendars = new Set(verified.map((c) => c.id));
  if (!scopeIds) for (const l of live) if (!idx.calById.has(l.calendar_id)) rowCalendars.add(l.calendar_id);
  const out = new DiffCollector(rowCalendars);

  if (params.levels.includes('V1')) {
    await ctx.progress({ phase: 'v1', message: 'V1: ledger contro Radicale' });
    verifyV1(idx, verified, out, { orphans: !scopeIds });
  }
  if (params.levels.includes('V2')) {
    ctx.throwIfCancelled();
    await ctx.progress({ phase: 'v2', message: 'V2: contenuto contro il piano' });
    verifyV2(idx, verified, out);
  }
  if (params.levels.includes('V3')) {
    ctx.throwIfCancelled();
    await verifyV3(idx, verified, out, ctx);
  }
  let v4: VerifySummary['v4'] = null;
  if (params.levels.includes('V4')) {
    ctx.throwIfCancelled();
    const r = await verifyV4(idx, included, ctx.db, params.v4_days, out, ctx);
    v4 = { from: r.from, to: r.to, without_subscriptions: r.without, with_subscriptions: r.with };
  }
  if (params.levels.includes('V5')) {
    ctx.throwIfCancelled();
    await ctx.progress({ phase: 'v5', message: 'V5: feed ICS pubblici' });
    await verifyV5(idx, verified, ctx.db, out, ctx);
  }
  out.finish();
  ctx.throwIfCancelled();

  // Righe del run (al più 500 per chiamata), poi il riporto delle accettazioni per firma.
  const rows: MigrationItemInput[] = out.diffs.map((d) => ({
    item_type: 'diff',
    calendar_id: d.calendar_id,
    collection_name: d.collection_name,
    href: d.href,
    legacy_key: d.legacy_key,
    code: d.code,
    level: d.level,
    expected: d.expected,
    severity: d.detail.variant === 'with_subscriptions' ? 'info' : d.expected ? 'warning' : 'error',
    detail: d.detail as unknown as Record<string, unknown>,
  }));
  await ctx.progress({ phase: 'write-items', done: 0, total: rows.length, message: 'Salvataggio delle differenze' });
  for (let i = 0; i < rows.length; i += ROWS_CHUNK) {
    await ctx.addItems(rows.slice(i, i + ROWS_CHUNK));
    await ctx.progress({ phase: 'write-items', done: Math.min(rows.length, i + ROWS_CHUNK), total: rows.length, message: 'Salvataggio delle differenze' });
  }
  const carried = rows.length ? await carryOverAcceptances(ctx.db, ctx.runId) : 0;
  const acceptedSignatures = new Set(
    (await ctx.db<Array<{ signature: string | null }>>`
      SELECT detail->>'signature' AS signature FROM cal_migration_items
      WHERE run_id = ${ctx.runId}::uuid AND item_type = 'diff' AND accepted_at IS NOT NULL
    `).map((r) => r.signature).filter((s): s is string => Boolean(s)),
  );

  const lite: DiffRowLite[] = out.diffs.map((d) => ({
    calendar_id: d.calendar_id,
    level: d.level,
    expected: d.expected,
    accepted: acceptedSignatures.has(d.detail.signature),
    variant: d.detail.variant ?? null,
  }));
  const verdictIds = new Set<string>(verified.map((c) => c.id));
  for (const d of lite) if (d.calendar_id) verdictIds.add(d.calendar_id);
  const calInfo = [...verdictIds].map((id) => {
    const c = idx.calById.get(id);
    const l = live.find((r) => r.calendar_id === id);
    return { calendar_id: id, collection_name: c?.collection_name ?? l?.collection_name ?? '', slug: c?.slug ?? '' };
  });
  const calendars = buildVerdicts(calInfo, params.levels, lite);
  const colored = lite.filter((d) => d.variant !== 'with_subscriptions');
  const overall = worstColor(calendars.map((c) => c.color));
  const summary: VerifyRunSummary = {
    generated_at: now.toISOString(),
    levels: params.levels,
    overall,
    acceptable: calendars.every((c) => c.color === 'green' || (c.color === 'yellow' && c.accepted)),
    calendars,
    v4,
    totals: {
      diffs: colored.length,
      expected: colored.filter((d) => d.expected).length,
      unexpected: colored.filter((d) => !d.expected).length,
      accepted: colored.filter((d) => d.accepted).length,
    },
    now: now.toISOString(),
    scope,
    options,
    informative: lite.length - colored.length,
    carried_over: carried,
  };
  await ctx.progress({ phase: 'done', done: rows.length, total: rows.length, message: `Verifica conclusa: ${overall === 'green' ? 'verde' : overall === 'yellow' ? 'gialla' : 'rossa'}` });
  return summary;
}
