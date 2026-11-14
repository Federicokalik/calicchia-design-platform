/**
 * Vista a occorrenze dell'API admin v2 (F6 tranche C, passo C3; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.6).
 *
 *  - `GET /occurrences?from&to&calendar_id` (ripetibile): tutte le occorrenze
 *    che intersecano [from, to), senza troncamento per conteggio. Senza
 *    `calendar_id`: tutti i calendari attivi tranne festività e iscrizioni
 *    (vanno in `/overlays`); con `calendar_id`: esattamente quelli (l'archivio
 *    incluso, in sola lettura).
 *  - `GET /overlays?from&to`: festività, chiusure e iscrizioni della finestra,
 *    in sola lettura.
 *  - Finestra: `from < to` e `to − from ≤ CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS`
 *    giorni, altrimenti 400.
 *
 * Le occorrenze vengono da `cal_occurrences` (indice) e, per la parte della
 * finestra che l'orizzonte della collezione non copre (o oltre
 * `materialized_until` di una serie più lunga del tetto per oggetto), si
 * espandono al volo dal testo dell'oggetto con `expandIndexedObject`: la
 * stessa espansione dell'indicizzatore, quindi la risposta è completa per
 * qualsiasi finestra valida. Badge: `orphan` (override senza serie),
 * `quarantined` (oggetto non `ok` o occorrenza `stale`), `hold` (collezione
 * in hold), `conservative` (blocco conservativo), `new_from_device` (calendario
 * con `needs_review`). `blocks` è l'effetto sul busy: la regola
 * dell'occorrenza E il flag di disponibilità del calendario (per
 * un'iscrizione anche quello del calendario di destinazione).
 *
 * Sola lettura: nessuna chiamata a Radicale e nessun testo di evento nei log.
 */

import { getTextValue, parseCalendarObject, parseObjectHref } from '@calicchia/calendar-core';
import {
  CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS,
  type CalV2Occurrence,
  type CalV2OccurrenceBadge,
  type CalV2OccurrenceKind,
  type CalV2OccurrenceList,
  type CalV2OverlayItem,
  type CalV2OverlayList,
  type CalV2ReadonlyReason,
} from '@calicchia/shared';
import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { CollectionNotFoundError, expandIndexedObject, loadCollectionContext } from '../radicale/indexer';
import { type CollectionContext } from '../radicale/indexer';
import { listCollectionHealth } from '../radicale/health';
import type { Db } from '../radicale/policy';
import { safeTz } from '../radicale/store';
import { assertV2ObjectsAvailable, readCalendarV2Capabilities } from './capabilities';
import { invalidValue } from './errors';
import { UUID_RE } from './objects';
import { resolveTargetComponent } from './view';

const log: Logger = rootLogger.child({ scope: 'calendar-admin-v2-occurrences' });

const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS * DAY_MS;
/** Calendari filtrabili in una sola richiesta. */
const MAX_CALENDAR_IDS = 500;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Chiave dell'occorrenza che copre l'intera finestra di un oggetto illeggibile. */
const CONSERVATIVE_KEY = 'conservative';
/** Righe `COLOR:` all'inizio di una riga logica (le righe piegate iniziano con spazio). */
const COLOR_LINE_RE = '(^|\\n)COLOR[:;]';

// ═══════════════════════════════════════════════════════════════════
// Richiesta
// ═══════════════════════════════════════════════════════════════════

function parseInstant(value: string | undefined, name: 'from' | 'to'): Date {
  const text = (value ?? '').trim();
  if (!text) throw invalidValue(`Manca il parametro ${name}`, name);
  const ms = ISO_RE.test(text) ? Date.parse(text.includes(' ') ? text.replace(' ', 'T') : text) : Number.NaN;
  if (!Number.isFinite(ms)) throw invalidValue(`Il parametro ${name} non è una data ISO valida`, name);
  return new Date(ms);
}

/** Finestra `[from, to)`: `from < to` e al più 100 giorni, altrimenti 400 VALIDATION_FAILED. */
export function parseOccurrenceWindow(fromRaw: string | undefined, toRaw: string | undefined): { from: Date; to: Date } {
  const from = parseInstant(fromRaw, 'from');
  const to = parseInstant(toRaw, 'to');
  if (from.getTime() >= to.getTime()) throw invalidValue('La finestra non è valida: from deve precedere to', 'to');
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw invalidValue(`La finestra è troppo ampia: al più ${CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS} giorni`, 'to');
  }
  return { from, to };
}

/** `calendar_id` ripetibile: UUID distinti; un valore non valido è un 400. */
export function parseCalendarIds(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const id = v.trim().toLowerCase();
    if (!UUID_RE.test(id)) throw invalidValue('calendar_id non valido', 'calendar_id');
    out.add(id);
  }
  if (out.size > MAX_CALENDAR_IDS) throw invalidValue(`Troppi calendari: al più ${MAX_CALENDAR_IDS}`, 'calendar_id');
  return [...out];
}

// ═══════════════════════════════════════════════════════════════════
// Calendari della richiesta
// ═══════════════════════════════════════════════════════════════════

interface ScopeCalendar {
  id: string;
  /** Calendario mostrato: per il sidecar di un'iscrizione quello di destinazione. */
  displayId: string;
  role: string;
  origin: string;
  timezone: string;
  needsReview: boolean;
  /** Conta nel busy (flag del calendario; per un'iscrizione anche quello della destinazione). */
  blocking: boolean;
  horizonStart: Date | null;
  horizonEnd: Date | null;
}

type ScopeFilter = { ids: string[] } | { overlays: true } | { defaults: true };

async function loadScope(filter: ScopeFilter): Promise<ScopeCalendar[]> {
  const where =
    'ids' in filter
      ? sql`c.id = ANY(${filter.ids}::uuid[])`
      : 'overlays' in filter
        ? sql`c.role IN ('holidays', 'subscription')`
        : sql`c.role NOT IN ('holidays', 'subscription')`;
  const rows = await sql<
    Array<{
      id: string;
      display_id: string;
      role: string;
      origin: string;
      timezone: string;
      needs_review: boolean;
      blocking: boolean;
      horizon_start: Date | null;
      horizon_end: Date | null;
    }>
  >`
    SELECT c.id, c.role, c.origin, c.timezone, c.needs_review,
           CASE WHEN c.role = 'subscription' THEN COALESCE(s.calendar_id, c.parent_calendar_id, c.id) ELSE c.id END AS display_id,
           CASE WHEN c.role = 'subscription'
                THEN COALESCE(s.blocks_availability, false) AND COALESCE(p.blocks_availability, false)
                ELSE c.blocks_availability END AS blocking,
           st.horizon_start, st.horizon_end
    FROM calendars c
    LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
    LEFT JOIN calendars p ON p.id = c.parent_calendar_id
    LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
    WHERE c.lifecycle = 'active' AND ${where}
    ORDER BY c.sort_order, c.id
  `;
  return rows.map((r) => ({
    id: r.id,
    displayId: r.display_id,
    role: r.role,
    origin: r.origin,
    timezone: r.timezone,
    needsReview: r.needs_review,
    blocking: r.blocking,
    horizonStart: r.horizon_start,
    horizonEnd: r.horizon_end,
  }));
}

// ═══════════════════════════════════════════════════════════════════
// Raccolta delle occorrenze
// ═══════════════════════════════════════════════════════════════════

/** Occorrenza grezza (indice o espansione al volo) prima della trasformazione in DTO. */
interface RawOccurrence {
  objectId: string;
  componentId: string | null;
  recurrenceKey: string;
  calendarId: string;
  start: Date;
  end: Date;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  transp: 'OPAQUE' | 'TRANSPARENT';
  kind: CalV2OccurrenceKind;
  blocks: boolean;
  stale: boolean;
  summary: string | null;
  location: string | null;
  href: string;
  objectHealth: string;
  objectComponent: string;
  isRecurring: boolean;
}

interface IndexedRow {
  object_id: string;
  recurrence_key: string;
  component_id: string | null;
  calendar_id: string;
  start_utc: Date;
  end_utc: Date;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  status: RawOccurrence['status'];
  transp: RawOccurrence['transp'];
  kind: CalV2OccurrenceKind;
  blocks: boolean;
  stale: boolean;
  href: string;
  object_health: string;
  object_component: string;
  is_recurring: boolean;
  summary: string | null;
  location: string | null;
}

/** Sovrapposizione con [from, to): intervallo non vuoto che interseca, o istante (durata nulla) dentro la finestra. */
function overlaps(start: number, end: number, from: number, to: number): boolean {
  if (end > start) return start < to && end > from;
  return start >= from && start < to;
}

/** Occorrenze dell'indice che intersecano la finestra. */
async function indexedOccurrences(ids: readonly string[], from: Date, to: Date): Promise<RawOccurrence[]> {
  const rows = await sql<IndexedRow[]>`
    SELECT o.object_id, o.recurrence_key, o.component_id, o.calendar_id, o.start_utc, o.end_utc, o.all_day,
           o.start_date::text AS start_date, o.end_date::text AS end_date, o.status, o.transp, o.kind, o.blocks, o.stale,
           ob.href, ob.health AS object_health, ob.component AS object_component, ob.is_recurring,
           cc.summary, cc.location
    FROM cal_occurrences o
    JOIN cal_objects ob ON ob.id = o.object_id
    LEFT JOIN cal_components cc ON cc.id = o.component_id
    WHERE o.calendar_id = ANY(${[...ids]}::uuid[])
      AND ob.health <> 'pending_404'
      AND (
        o.span && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')
        OR (o.start_utc = o.end_utc AND o.start_utc >= ${from}::timestamptz AND o.start_utc < ${to}::timestamptz)
      )
    ORDER BY o.start_utc, o.end_utc, o.object_id, o.recurrence_key
  `;
  return rows.map((r) => ({
    objectId: r.object_id,
    componentId: r.component_id,
    recurrenceKey: r.recurrence_key,
    calendarId: r.calendar_id,
    start: r.start_utc,
    end: r.end_utc,
    allDay: r.all_day,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    transp: r.transp,
    kind: r.kind,
    blocks: r.blocks,
    stale: r.stale,
    summary: r.summary,
    location: r.location,
    href: r.href,
    objectHealth: r.object_health,
    objectComponent: r.object_component,
    isRecurring: r.is_recurring,
  }));
}

interface OnTheFlyRow {
  id: string;
  calendar_id: string;
  href: string;
  health: string;
  raw_ics: string | null;
  component: string;
  is_recurring: boolean;
  materialized_until: Date | null;
}

/** Parti di [from, to) non coperte dalle occorrenze materializzate: orizzonte della collezione e, per l'oggetto, `materialized_until`. */
function uncoveredWindows(cal: ScopeCalendar, row: OnTheFlyRow, from: number, to: number): Array<[number, number]> {
  const coverStart = cal.horizonStart ? cal.horizonStart.getTime() : Number.POSITIVE_INFINITY;
  const horizonEnd = cal.horizonEnd ? cal.horizonEnd.getTime() : Number.NEGATIVE_INFINITY;
  const materialized = row.materialized_until ? row.materialized_until.getTime() : Number.POSITIVE_INFINITY;
  const coverEnd = Math.min(horizonEnd, materialized);
  if (!(coverStart < coverEnd)) return [[from, to]];
  const out: Array<[number, number]> = [];
  if (from < coverStart) out.push([from, Math.min(to, coverStart)]);
  if (to > coverEnd) out.push([Math.max(from, coverEnd), to]);
  return out.filter(([a, b]) => a < b);
}

/** Data locale (YYYY-MM-DD) di un istante nel fuso del calendario. */
function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** Occorrenze all-day oltre l'orizzonte: date di inizio e fine (esclusiva) nel fuso del calendario. */
function allDayDates(startMs: number, endMs: number, tz: string): { startDate: string; endDate: string } {
  const startDate = localDate(startMs, tz);
  let endDate = localDate(endMs, tz);
  if (endDate <= startDate) endDate = localDate(Date.parse(`${startDate}T12:00:00Z`) + DAY_MS, 'UTC');
  return { startDate, endDate };
}

/**
 * Espansione al volo (design §6.9) degli oggetti la cui parte di [from, to) non è
 * materializzata: oltre l'orizzonte della collezione o oltre `materialized_until`.
 * Titolo, luogo, STATUS e TRANSP sono quelli del componente indicizzato (`cal_components`).
 */
async function onTheFlyOccurrences(scope: readonly ScopeCalendar[], from: Date, to: Date, seen: ReadonlySet<string>): Promise<RawOccurrence[]> {
  const f = from.getTime();
  const t = to.getTime();
  const gapIds = scope
    .filter((c) => !c.horizonStart || !c.horizonEnd || c.horizonStart.getTime() > f || c.horizonEnd.getTime() < t)
    .map((c) => c.id);
  const rows = await sql<OnTheFlyRow[]>`
    SELECT ob.id, ob.calendar_id, ob.href, ob.health, ob.raw_ics, ob.component, ob.is_recurring, ob.materialized_until
    FROM cal_objects ob
    WHERE ob.calendar_id = ANY(${scope.map((c) => c.id)}::uuid[])
      AND ob.health <> 'pending_404'
      AND ob.range_start IS NOT NULL
      AND ob.range_start < ${to}::timestamptz
      AND (ob.range_end IS NULL OR ob.range_end > ${from}::timestamptz)
      AND (
        ob.calendar_id = ANY(${gapIds}::uuid[])
        OR (ob.materialized_until IS NOT NULL AND ob.materialized_until < ${to}::timestamptz)
      )
  `;
  if (rows.length === 0) return [];

  const comps = await sql<
    Array<{ id: string; object_id: string; recurrence_key: string; summary: string | null; location: string | null; status: RawOccurrence['status']; transp: string | null }>
  >`
    SELECT id, object_id, recurrence_key, summary, location, status, transp
    FROM cal_components WHERE object_id = ANY(${rows.map((r) => r.id)}::uuid[])
  `;
  const byObject = new Map<string, Map<string, (typeof comps)[number]>>();
  for (const c of comps) {
    const m = byObject.get(c.object_id) ?? new Map();
    m.set(c.recurrence_key, c);
    byObject.set(c.object_id, m);
  }

  const calById = new Map(scope.map((c) => [c.id, c]));
  const contexts = new Map<string, CollectionContext | null>();
  const out: RawOccurrence[] = [];
  const conservative = new Map<string, RawOccurrence>();

  for (const row of rows) {
    const cal = calById.get(row.calendar_id);
    if (!cal) continue;
    let context = contexts.get(row.calendar_id);
    if (context === undefined) {
      try {
        context = await loadCollectionContext(sql as unknown as Db, row.calendar_id);
      } catch (err) {
        // Calendario cancellato nel frattempo: le sue righe spariscono in cascata.
        if (!(err instanceof CollectionNotFoundError)) throw err;
        context = null;
      }
      contexts.set(row.calendar_id, context);
    }
    if (!context) continue;
    const tz = safeTz(cal.timezone);
    const compMap = byObject.get(row.id);

    for (const [w0, w1] of uncoveredWindows(cal, row, f, t)) {
      const expanded = expandIndexedObject(
        { id: row.id, calendar_id: row.calendar_id, href: row.href, raw_ics: row.raw_ics, health: row.health as 'ok' },
        context,
        { from: new Date(w0), to: new Date(w1) },
      );
      if (expanded.conservative) log.warn({ objectId: row.id, calendarId: row.calendar_id }, 'espansione al volo non riuscita o troncata: blocco conservativo');
      for (const occ of expanded.occurrences) {
        const start = occ.start.getTime();
        const end = Math.max(occ.end.getTime(), start);
        if (!overlaps(start, end, f, t)) continue;
        const isConservative = occ.recurrenceKey === CONSERVATIVE_KEY;
        if (isConservative) {
          // Un blocco per oggetto: se le finestre scoperte sono due si uniscono.
          const known = conservative.get(row.id);
          if (known) {
            known.start = new Date(Math.min(known.start.getTime(), start));
            known.end = new Date(Math.max(known.end.getTime(), end));
            continue;
          }
        } else if (seen.has(`${row.id}|${occ.recurrenceKey}`)) {
          continue;
        }
        const comp = isConservative ? undefined : compMap?.get(occ.recurrenceKey) ?? compMap?.get('');
        const dates = occ.allDay ? allDayDates(start, end, tz) : null;
        const raw: RawOccurrence = {
          objectId: row.id,
          componentId: comp?.id ?? null,
          recurrenceKey: occ.recurrenceKey,
          calendarId: row.calendar_id,
          start: new Date(start),
          end: new Date(end),
          allDay: occ.allDay,
          startDate: dates?.startDate ?? null,
          endDate: dates?.endDate ?? null,
          status: comp?.status ?? 'confirmed',
          transp: comp?.transp === 'TRANSPARENT' ? 'TRANSPARENT' : 'OPAQUE',
          kind: occ.kind as CalV2OccurrenceKind,
          blocks: occ.blocks,
          stale: row.health === 'quarantined',
          summary: comp?.summary ?? null,
          location: comp?.location ?? null,
          href: row.href,
          objectHealth: row.health,
          objectComponent: row.component,
          isRecurring: row.is_recurring,
        };
        if (isConservative) conservative.set(row.id, raw);
        out.push(raw);
      }
    }
  }
  return out;
}

/** Tutte le occorrenze dei calendari indicati che intersecano la finestra: indice più espansione al volo, ordinate. */
async function collectOccurrences(scope: readonly ScopeCalendar[], from: Date, to: Date): Promise<RawOccurrence[]> {
  if (scope.length === 0) return [];
  const ids = scope.map((c) => c.id);
  const indexed = await indexedOccurrences(ids, from, to);
  const seen = new Set(indexed.map((o) => `${o.objectId}|${o.recurrenceKey}`));
  const extra = await onTheFlyOccurrences(scope, from, to, seen);
  const all = extra.length === 0 ? indexed : [...indexed, ...extra];
  all.sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() ||
      a.end.getTime() - b.end.getTime() ||
      (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0) ||
      (a.recurrenceKey < b.recurrenceKey ? -1 : a.recurrenceKey > b.recurrenceKey ? 1 : 0),
  );
  return all;
}

// ═══════════════════════════════════════════════════════════════════
// Colore e prenotazioni
// ═══════════════════════════════════════════════════════════════════

/**
 * COLOR dell'evento per ogni (oggetto, chiave): solo gli oggetti che hanno una
 * riga COLOR si leggono e si interpretano; per gli altri vale il colore del
 * calendario (null).
 */
async function eventColors(occurrences: readonly RawOccurrence[], tzOf: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(occurrences.filter((o) => o.recurrenceKey !== CONSERVATIVE_KEY).map((o) => o.objectId))];
  if (ids.length === 0) return out;
  const rows = await sql<Array<{ id: string; calendar_id: string; raw_ics: string }>>`
    SELECT id, calendar_id, raw_ics FROM cal_objects
    WHERE id = ANY(${ids}::uuid[]) AND raw_ics IS NOT NULL AND raw_ics ~ ${COLOR_LINE_RE}
  `;
  const now = new Date();
  const byObject = new Map<string, RawOccurrence[]>();
  for (const o of occurrences) {
    const list = byObject.get(o.objectId) ?? [];
    list.push(o);
    byObject.set(o.objectId, list);
  }
  for (const row of rows) {
    const parsed = parseCalendarObject(row.raw_ics);
    if (!parsed.ok) continue;
    const tz = tzOf.get(row.calendar_id) ?? 'Europe/Rome';
    for (const occ of byObject.get(row.id) ?? []) {
      const key = occ.recurrenceKey;
      let color: string | null = null;
      try {
        const found = resolveTargetComponent(parsed.value, key, { tz, now });
        color = found ? (getTextValue(found.component, 'COLOR') ?? '').trim() || null : null;
      } catch {
        color = null;
      }
      if (color) out.set(`${row.id}|${key}`, color);
    }
  }
  return out;
}

/** UID di prenotazione dell'href di una proiezione → id della prenotazione. */
async function bookingIds(occurrences: readonly RawOccurrence[]): Promise<Map<string, string>> {
  const uids = new Set<string>();
  for (const o of occurrences) {
    if (o.kind !== 'booking_projection') continue;
    const uid = parseObjectHref(o.href).bookingUid;
    if (uid) uids.add(uid);
  }
  if (uids.size === 0) return new Map();
  const rows = await sql<Array<{ uid: string; id: string }>>`SELECT uid, id FROM calendar_bookings WHERE uid = ANY(${[...uids]}::text[])`;
  return new Map(rows.map((r) => [r.uid, r.id]));
}

// ═══════════════════════════════════════════════════════════════════
// Route
// ═══════════════════════════════════════════════════════════════════

/** Motivo di sola lettura dell'occorrenza (§3.9), nello stesso ordine di precedenza degli oggetti. */
function readonlyReasonOf(o: RawOccurrence, cal: ScopeCalendar, writable: boolean): CalV2ReadonlyReason | null {
  if (cal.role === 'subscription') return 'subscription';
  if (cal.origin === 'migration') return 'archive';
  if (o.recurrenceKey === CONSERVATIVE_KEY || o.objectHealth === 'quarantined') return 'unreadable';
  if (o.objectComponent !== 'VEVENT') return 'component_unsupported';
  return writable ? null : 'writes_suspended';
}

/** `GET /occurrences`: tutte le occorrenze della finestra, con badge. */
export async function listOccurrencesV2(q: { from: Date; to: Date; calendarIds: readonly string[] }): Promise<CalV2OccurrenceList> {
  await assertV2ObjectsAvailable();
  const scope = await loadScope(q.calendarIds.length > 0 ? { ids: [...q.calendarIds] } : { defaults: true });
  const [raw, health, caps] = await Promise.all([
    collectOccurrences(scope, q.from, q.to),
    listCollectionHealth(sql as unknown as Db, { calendarIds: scope.map((c) => c.id) }),
    readCalendarV2Capabilities(),
  ]);
  const calById = new Map(scope.map((c) => [c.id, c]));
  const healthById = new Map(health.map((h) => [h.calendarId, h.health]));
  const tzOf = new Map(scope.map((c) => [c.id, safeTz(c.timezone)]));
  const [colors, bookings] = await Promise.all([eventColors(raw, tzOf), bookingIds(raw)]);
  const writable = caps.objects.write;

  const occurrences: CalV2Occurrence[] = raw.map((o) => {
    const cal = calById.get(o.calendarId) as ScopeCalendar;
    const badges: CalV2OccurrenceBadge[] = [];
    if (o.kind === 'orphan_override') badges.push('orphan');
    if (o.objectHealth !== 'ok' || o.stale) badges.push('quarantined');
    if (healthById.get(o.calendarId) === 'hold') badges.push('hold');
    if (o.kind === 'conservative') badges.push('conservative');
    if (cal.needsReview) badges.push('new_from_device');
    const bookingUid = o.kind === 'booking_projection' ? parseObjectHref(o.href).bookingUid : null;
    return {
      object_id: o.objectId,
      component_id: o.recurrenceKey === CONSERVATIVE_KEY ? null : o.componentId,
      recurrence_key: o.recurrenceKey,
      calendar_id: cal.displayId,
      start_utc: o.start.toISOString(),
      end_utc: o.end.toISOString(),
      all_day: o.allDay,
      start_date: o.allDay ? o.startDate : null,
      end_date: o.allDay ? o.endDate : null,
      summary: o.recurrenceKey === CONSERVATIVE_KEY ? null : o.summary,
      location: o.location,
      color: colors.get(`${o.objectId}|${o.recurrenceKey}`) ?? null,
      status: o.status,
      transp: o.transp,
      blocks: o.blocks && cal.blocking,
      kind: o.kind,
      recurring: o.isRecurring,
      stale: o.stale,
      readonly_reason: readonlyReasonOf(o, cal, writable),
      booking_id: bookingUid ? bookings.get(bookingUid) ?? null : null,
      badges,
    };
  });

  const stale = [...new Set(health.filter((h) => h.health !== 'healthy').map((h) => calById.get(h.calendarId)?.displayId ?? h.calendarId))];
  return { from: q.from.toISOString(), to: q.to.toISOString(), occurrences, stale_calendar_ids: stale };
}

/** `GET /overlays`: festività, chiusure e iscrizioni della finestra (annullate escluse). */
export async function listOverlaysV2(q: { from: Date; to: Date }): Promise<CalV2OverlayList> {
  await assertV2ObjectsAvailable();
  const scope = await loadScope({ overlays: true });
  const raw = (await collectOccurrences(scope, q.from, q.to)).filter((o) => o.status !== 'cancelled' && o.recurrenceKey !== CONSERVATIVE_KEY);
  const calById = new Map(scope.map((c) => [c.id, c]));
  const tzOf = new Map(scope.map((c) => [c.id, safeTz(c.timezone)]));
  const colors = await eventColors(raw, tzOf);
  const items: CalV2OverlayItem[] = raw.map((o) => {
    const cal = calById.get(o.calendarId) as ScopeCalendar;
    const source: CalV2OverlayItem['source'] = cal.role === 'subscription' ? 'subscription' : o.kind === 'closure' ? 'closure' : 'holiday';
    return {
      source,
      calendar_id: cal.displayId,
      object_id: o.objectId,
      recurrence_key: o.recurrenceKey,
      start_utc: o.start.toISOString(),
      end_utc: o.end.toISOString(),
      all_day: o.allDay,
      start_date: o.allDay ? o.startDate : null,
      end_date: o.allDay ? o.endDate : null,
      summary: o.summary,
      color: colors.get(`${o.objectId}|${o.recurrenceKey}`) ?? null,
      blocks: o.blocks && cal.blocking,
    };
  });
  return { from: q.from.toISOString(), to: q.to.toISOString(), items };
}
