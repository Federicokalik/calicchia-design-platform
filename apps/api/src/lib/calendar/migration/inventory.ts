/**
 * Inventario dei dati legacy prima della migrazione (fase F3 del passaggio del
 * calendario a Radicale; design §13.4; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §6.1 e §7.1).
 *
 * In sola lettura. Per ogni calendario: conteggi (singoli timed e all-day,
 * serie, override modificati, override cancellati che diventeranno EXDATE,
 * exdates, proiezioni, festività di sistema, chiusure, eventi non-proiezione
 * nel calendario Prenotazioni) e anomalie, con lo stesso codice dell'anteprima:
 *  - le anomalie del serializer (override orfani o in un altro calendario,
 *    UNTIL e all-day, RRULE non valide, master cancellati, eccezioni DST
 *    spostate, BYDAY misto, festività duplicate, eventi non-proiezione in
 *    Prenotazioni, oggetti non validi) vengono da serializeLegacy() in sola
 *    analisi: una sola implementazione per inventario e anteprima;
 *  - i controlli che il serializer non vede sono qui: BOOKING_DRIFT
 *    (prenotazioni senza proiezione, proiezioni orfane, orari divergenti),
 *    POSSIBLE_DUPLICATE (copie fatte con "Duplica", eventi identici, singoli
 *    uguali a un'occorrenza di una serie), app-password non canoniche e
 *    riservate, impatto delle iscrizioni sugli slot (decisione 5),
 *    validatori del pull da azzerare (ICS_PULL_REFETCH), calendari esclusi.
 *
 * I calendari delle festività si riconoscono anche con is_system = false
 * (produzione: `f` "Festività e chiusure"), per ruolo, nome o slug, come la
 * classificazione della 162.
 *
 * Nessun dato personale nelle righe: id, uid delle prenotazioni (mai email,
 * telefoni o nomi), date, conteggi, titoli dei soli eventi non di prenotazione.
 */

import { logger as rootLogger } from '../../logger';
import { buildAvailabilityWindows, getEventType, loadScheduleForEventType } from '../availability';
import { PROJECTED_BOOKING_STATUSES } from '../booking-projection';
import { getPgLegacyStore } from '../store';
import type { CalendarEventOccurrence } from '../types';
import type { Db } from '../radicale/policy';
import { radicaleRuntime } from '../radicale/sync';
import {
  CALENDAR_LIFECYCLES,
  CALENDAR_ORIGINS,
  CALENDAR_ROLES,
  type CalendarLifecycle,
  type CalendarOrigin,
  type CalendarRole,
  DEFAULT_PRINCIPAL,
  isReservedUsername,
  isValidCollectionName,
} from '../radicale/types';
import { ARCHIVE_COLLECTION_NAME } from './init';
import { loadLegacySource, serializeLegacy } from './serialize';
import {
  ANOMALY_DEFINITIONS,
  type AnomalyCode,
  type AnomalyRecord,
  type CalendarExclusion,
  type CalendarInventory,
  emptyInventoryCounts,
  type InventoryCounts,
  type InventoryParams,
  type InventorySummary,
  MIGRATION_LIMITS,
  type MigrationCalendar,
  type MigrationItemInput,
  type MigrationRunContext,
  type MigrationScope,
  resolveMigrationOptions,
  type SubscriptionImpact,
} from './types';

const log = rootLogger.child({ scope: 'calendar-migration-inventory' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Settimane di default dell'impatto delle iscrizioni (design §13.4). */
export const SUBSCRIPTION_IMPACT_WEEKS = 4;

// ─── Calendari ───────────────────────────────

/**
 * Calendari visti dallo strumento con l'esclusione dal piano: sidecar d'iscrizione (subscription_sidecar), archivio
 * (archive), collection_name nullo o non valido (collection_name_invalid), lifecycle ≠ active (not_active).
 * Usata da serialize, plan, verify, preflight e init.
 */
export async function loadMigrationCalendars(db: Db, scope?: MigrationScope): Promise<MigrationCalendar[]> {
  const ids = (scope?.calendar_ids ?? []).filter((id) => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase());
  const rows: Array<{
    id: string; slug: string; name: string; description: string | null; color: string | null; timezone: string | null;
    sort_order: number | null; is_default: boolean; is_system: boolean; blocks_availability: boolean; ics_feed_enabled: boolean;
    collection_name: string | null; role: string; origin: string; lifecycle: string; device_visible: boolean;
  }> = await db`
    SELECT id, slug, name, description, color, timezone, sort_order, is_default, is_system, blocks_availability,
           ics_feed_enabled, collection_name, role, origin, lifecycle, device_visible
    FROM calendars
    ${ids.length > 0 ? db`WHERE id = ANY(${ids}::uuid[])` : db``}
    ORDER BY sort_order NULLS LAST, coalesce(collection_name, slug), id
  `;
  return rows.map((r) => {
    const role = (CALENDAR_ROLES as readonly string[]).includes(r.role) ? (r.role as CalendarRole) : 'user';
    const origin = (CALENDAR_ORIGINS as readonly string[]).includes(r.origin) ? (r.origin as CalendarOrigin) : 'admin';
    const lifecycle = (CALENDAR_LIFECYCLES as readonly string[]).includes(r.lifecycle) ? (r.lifecycle as CalendarLifecycle) : 'active';
    let excluded: CalendarExclusion | null = null;
    if (role === 'subscription') excluded = 'subscription_sidecar';
    else if (origin === 'migration' || r.collection_name === ARCHIVE_COLLECTION_NAME) excluded = 'archive';
    else if (!isValidCollectionName(r.collection_name)) excluded = 'collection_name_invalid';
    else if (lifecycle !== 'active') excluded = 'not_active';
    return {
      id: String(r.id).toLowerCase(),
      slug: r.slug,
      name: r.name,
      description: r.description,
      color: r.color || '#7c3aed',
      timezone: r.timezone || 'Europe/Rome',
      sort_order: r.sort_order ?? 0,
      is_default: r.is_default,
      is_system: r.is_system,
      blocks_availability: r.blocks_availability,
      ics_feed_enabled: r.ics_feed_enabled,
      collection_name: r.collection_name,
      role,
      origin,
      lifecycle,
      device_visible: r.device_visible,
      included: excluded === null,
      excluded_reason: excluded,
    };
  });
}

/** Come si riconosce un calendario delle festività (anche con is_system = false). */
export type HolidayRecognition = 'role' | 'name' | 'slug' | null;

/**
 * Stesse regole di calendar_sidecar_classify() della 162 (nome storico
 * esatto, oppure is_system con slug f/festivita o nome "festivit…"), più lo
 * slug e il nome anche senza is_system (in produzione `f` è is_system = false).
 */
export function recognizeHolidayCalendar(c: Pick<MigrationCalendar, 'role' | 'slug' | 'name' | 'is_system'>): HolidayRecognition {
  if (c.role === 'holidays') return 'role';
  const name = (c.name ?? '').trim().toLowerCase();
  if (name === 'festività' || name === 'festività e chiusure' || /^festivit/.test(name)) return 'name';
  if (c.slug === 'f' || c.slug === 'festivita') return 'slug';
  return null;
}

// ─── App-password ───────────────────────────────

/** App-password attive: totale, username diversi dal principal (informativo), username riservati (bloccante). */
export async function inventoryAppPasswords(db: Db, principal: string): Promise<{ active: number; non_canonical: Array<{ id: string; username: string }>; reserved: Array<{ id: string; username: string }> }> {
  const rows: Array<{ id: string; username: string }> = await db`
    SELECT id, username FROM caldav_app_passwords
    WHERE coalesce(is_active, true) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at, id
  `;
  const canonical = (principal || DEFAULT_PRINCIPAL).toLowerCase();
  const reserved: Array<{ id: string; username: string }> = [];
  const nonCanonical: Array<{ id: string; username: string }> = [];
  for (const r of rows) {
    const entry = { id: String(r.id), username: String(r.username).slice(0, 64) };
    if (isReservedUsername(r.username)) reserved.push(entry);
    else if (r.username.toLowerCase() !== canonical) nonCanonical.push(entry);
  }
  return { active: rows.length, non_canonical: nonCanonical, reserved };
}

/**
 * Username di un'app-password da mostrare nelle righe del run: gli username
 * nuovi non possono contenere '@' (caldav-passwords.ts), ma una riga storica
 * potrebbe essere un indirizzo email, che non entra mai nelle righe
 * (contratto §1.4 regola 5): l'id basta a ritrovarla nell'admin.
 */
export function safeUsername(username: string): string {
  return username.includes('@') ? '[username con @ nascosto]' : username.slice(0, 64);
}

// ─── Impatto delle iscrizioni (decisione 5) ───────────────────────────────

interface Range { start: number; end: number }

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function subtract(windows: Range[], busy: Range[]): Range[] {
  const merged = mergeRanges(busy);
  const out: Range[] = [];
  for (const w of windows) {
    let cursor = w.start;
    for (const b of merged) {
      if (b.end <= cursor || b.start >= w.end) continue;
      if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, w.end) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= w.end) break;
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end });
  }
  return out.filter((r) => r.end > r.start);
}

function overlapsAny(slot: Range, busy: readonly Range[]): boolean {
  return busy.some((b) => b.end > slot.start && b.start < slot.end);
}

function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/**
 * Slot candidati di un tipo di prenotazione nella finestra, con lo stesso
 * algoritmo di slots.ts (finestre dello schedule meno prenotazioni con i
 * buffer e busy del calendario, preavviso e anticipo massimo, passo
 * dell'incremento) ma con il busy indicato. Senza il filtro della capacità
 * settimanale: è una stima per il wizard.
 */
async function slotCandidates(eventTypeId: string, from: number, to: number, baseBusy: readonly Range[], bookings: ReadonlyArray<{ start: number; end: number }>, now: number): Promise<Range[]> {
  const eventType = await getEventType(eventTypeId, { includeInactive: false });
  if (!eventType) return [];
  const sched = await loadScheduleForEventType(eventType);
  if (!sched) return [];
  const tz = sched.schedule.timezone || 'Europe/Rome';
  const windows = buildAvailabilityWindows({
    schedule: sched.schedule,
    slots: sched.slots,
    overrides: sched.overrides,
    fromDateLocal: localDate(from, tz),
    toDateLocal: localDate(to, tz),
  }).map((w) => ({ start: new Date(w.startUtc).getTime(), end: new Date(w.endUtc).getTime() }))
    .map((w) => ({ start: Math.max(w.start, from), end: Math.min(w.end, to) }))
    .filter((w) => w.end > w.start);
  const bufBefore = eventType.buffer_before_minutes * 60_000;
  const bufAfter = eventType.buffer_after_minutes * 60_000;
  const busy: Range[] = [...bookings.map((b) => ({ start: b.start - bufAfter, end: b.end + bufBefore })), ...baseBusy];
  const free = subtract(windows, busy);
  const minStart = now + eventType.min_notice_hours * HOUR_MS;
  const maxStart = now + eventType.max_advance_days * DAY_MS;
  const duration = eventType.duration_minutes * 60_000;
  const increment = Math.max(1, eventType.slot_increment_minutes) * 60_000;
  const out: Range[] = [];
  const seen = new Set<number>();
  for (const r of free) {
    const s = Math.max(r.start, minStart);
    const e = Math.min(r.end, maxStart);
    if (e <= s) continue;
    for (let t = s; t + duration <= e; t += increment) {
      const aligned = t % increment === 0 ? t : t + (increment - (t % increment));
      if (aligned + duration > e || seen.has(aligned)) continue;
      seen.add(aligned);
      out.push({ start: aligned, end: aligned + duration });
    }
  }
  return out;
}

/** SUBSCRIPTION_BLOCKING_IMPACT: ore occupate e slot pubblici persi a settimana sulle prossime `weeks` (default 4). */
export async function computeSubscriptionImpacts(db: Db, opts: { now: Date; weeks?: number }): Promise<SubscriptionImpact[]> {
  const weeks = Math.max(1, Math.min(52, Math.floor(opts.weeks ?? SUBSCRIPTION_IMPACT_WEEKS)));
  const subs: Array<{
    id: string; name: string; calendar_id: string; sync_enabled: boolean; blocks_availability: boolean; device_visible: boolean;
    collection_calendar_id: string | null; collection_name: string | null; last_synced_at: Date | null;
  }> = await db`
    SELECT s.id, s.name, s.calendar_id, s.sync_enabled, s.blocks_availability, s.device_visible,
           s.collection_calendar_id, c.collection_name, cs.last_synced_at
    FROM calendar_subscriptions s
    LEFT JOIN calendars c ON c.id = s.collection_calendar_id
    LEFT JOIN cal_collection_state cs ON cs.calendar_id = s.collection_calendar_id
    ORDER BY s.created_at, s.id
  `;
  if (subs.length === 0) return [];

  const legacyRows: Array<{ id: string; subscription_id: string }> = await db`
    SELECT id, subscription_id FROM calendar_events WHERE subscription_id IS NOT NULL
  `;
  const rowsBySub = new Map<string, Set<string>>();
  for (const r of legacyRows) {
    const key = String(r.subscription_id);
    if (!rowsBySub.has(key)) rowsBySub.set(key, new Set());
    rowsBySub.get(key)!.add(String(r.id));
  }
  const sidecars = subs.map((s) => s.collection_calendar_id).filter((v): v is string => Boolean(v));
  const indexCounts = new Map<string, number>();
  if (sidecars.length > 0) {
    const rows: Array<{ calendar_id: string; n: number }> = await db`
      SELECT calendar_id, count(*)::int AS n FROM cal_components
      WHERE calendar_id = ANY(${sidecars}::uuid[]) AND component = 'VEVENT'
      GROUP BY calendar_id
    `;
    for (const r of rows) indexCounts.set(String(r.calendar_id), r.n);
  }

  const now = opts.now.getTime();
  const from = now;
  const to = now + weeks * 7 * DAY_MS;
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();

  // Occorrenze legacy della finestra con il codice congelato (PgLegacyStore).
  const occurrences: CalendarEventOccurrence[] = await getPgLegacyStore().listOccurrences({ fromIso, toIso });
  const blocking = new Set<string>((await db<Array<{ id: string }>>`SELECT id FROM calendars WHERE blocks_availability`).map((r) => String(r.id)));
  const toRange = (o: CalendarEventOccurrence): Range => ({
    start: Math.max(from, new Date(o.start_time).getTime()),
    end: Math.min(to, new Date(o.end_time).getTime()),
  });
  // Busy di base come in Radicale con le iscrizioni non bloccanti (default della decisione 5).
  const baseBusy = mergeRanges(occurrences
    .filter((o) => o.status === 'confirmed' && !o.all_day && o.source !== 'ics_pull' && blocking.has(String(o.calendar_id)))
    .map(toRange));
  const bookingRows: Array<{ start_time: Date; end_time: Date }> = await db`
    SELECT start_time, end_time FROM calendar_bookings
    WHERE status IN ('confirmed', 'pending') AND end_time > ${fromIso} AND start_time < ${toIso}
  `;
  const bookings = bookingRows.map((b) => ({ start: new Date(b.start_time).getTime(), end: new Date(b.end_time).getTime() }));
  const eventTypes: Array<{ id: string; slug: string }> = await db`
    SELECT id, slug FROM calendar_event_types WHERE is_active AND is_public ORDER BY sort_order, slug
  `;
  const candidatesByType = new Map<string, Range[]>();
  for (const et of eventTypes) {
    try {
      candidatesByType.set(et.slug, await slotCandidates(String(et.id), from, to, baseBusy, bookings, now));
    } catch (err) {
      log.warn({ err, eventType: et.slug }, 'slot candidati non calcolati per l\'impatto delle iscrizioni');
    }
  }

  return subs.map((s) => {
    const ids = rowsBySub.get(String(s.id)) ?? new Set<string>();
    const busy = mergeRanges(occurrences.filter((o) => ids.has(String(o.id)) && o.status === 'confirmed' && !o.all_day).map(toRange));
    const busyMs = busy.reduce((acc, r) => acc + (r.end - r.start), 0);
    const slotsLost: Record<string, number> = {};
    for (const [slug, candidates] of candidatesByType) {
      const lost = candidates.filter((c) => overlapsAny(c, busy)).length;
      slotsLost[slug] = Math.round((lost / weeks) * 10) / 10;
    }
    return {
      subscription_id: String(s.id),
      name: String(s.name ?? '').slice(0, 200),
      target_calendar_id: String(s.calendar_id),
      enabled: s.sync_enabled,
      blocks_availability: s.blocks_availability,
      device_visible: s.device_visible,
      sidecar_calendar_id: s.collection_calendar_id ? String(s.collection_calendar_id) : null,
      collection_name: s.collection_name ?? null,
      collection_exists: null,
      events_legacy: ids.size,
      events_index: s.collection_calendar_id ? indexCounts.get(String(s.collection_calendar_id)) ?? 0 : null,
      last_index_pull_at: s.last_synced_at ? new Date(s.last_synced_at).toISOString() : null,
      impact: {
        weeks,
        busy_hours_per_week: Math.round((busyMs / HOUR_MS / weeks) * 10) / 10,
        slots_lost_per_week: slotsLost,
      },
    };
  });
}

// ─── Conteggi e controlli propri dell'inventario ───────────────────────────────

interface CountRow {
  calendar_id: string;
  rows: number;
  singles_timed: number;
  singles_all_day: number;
  series: number;
  overrides_modified: number;
  overrides_cancelled: number;
  exdates: number;
  projections: number;
  holidays_system: number;
  other_masters: number;
  non_booking_masters: number;
  ics_pull: number;
}

async function countByCalendar(db: Db): Promise<Map<string, CountRow>> {
  const rows: CountRow[] = await db`
    SELECT e.calendar_id,
      count(*) FILTER (WHERE e.source <> 'ics_pull')::int AS rows,
      count(*) FILTER (WHERE e.source <> 'ics_pull' AND e.recurrence_master_id IS NULL AND coalesce(e.rrule, '') = ''
                         AND NOT e.all_day AND e.status <> 'cancelled')::int AS singles_timed,
      count(*) FILTER (WHERE e.source <> 'ics_pull' AND e.recurrence_master_id IS NULL AND coalesce(e.rrule, '') = ''
                         AND e.all_day AND e.status <> 'cancelled')::int AS singles_all_day,
      count(*) FILTER (WHERE e.source <> 'ics_pull' AND e.recurrence_master_id IS NULL AND coalesce(e.rrule, '') <> ''
                         AND e.status <> 'cancelled')::int AS series,
      count(*) FILTER (WHERE e.source <> 'ics_pull' AND e.recurrence_master_id IS NOT NULL AND e.status <> 'cancelled')::int AS overrides_modified,
      count(*) FILTER (WHERE e.source <> 'ics_pull' AND e.recurrence_master_id IS NOT NULL AND e.status = 'cancelled')::int AS overrides_cancelled,
      coalesce(sum(CASE WHEN jsonb_typeof(e.exdates) = 'array' THEN jsonb_array_length(e.exdates) ELSE 0 END)
               FILTER (WHERE e.source <> 'ics_pull' AND e.recurrence_master_id IS NULL AND coalesce(e.rrule, '') <> ''), 0)::int AS exdates,
      count(*) FILTER (WHERE e.source = 'booking')::int AS projections,
      count(*) FILTER (WHERE e.source = 'system')::int AS holidays_system,
      count(*) FILTER (WHERE e.source NOT IN ('system', 'booking', 'ics_pull') AND e.recurrence_master_id IS NULL
                         AND e.status <> 'cancelled')::int AS other_masters,
      count(*) FILTER (WHERE e.source NOT IN ('booking', 'ics_pull') AND e.recurrence_master_id IS NULL
                         AND e.status <> 'cancelled')::int AS non_booking_masters,
      count(*) FILTER (WHERE e.source = 'ics_pull')::int AS ics_pull
    FROM calendar_events e
    GROUP BY e.calendar_id
  `;
  return new Map(rows.map((r) => [String(r.calendar_id), r]));
}

function anomaly(code: AnomalyCode, calendarId: string | null, key: string | null, detail: Record<string, unknown>): AnomalyRecord {
  return { code, calendar_id: calendarId, legacy_key: key, severity: ANOMALY_DEFINITIONS[code].severity, detail };
}

/** BOOKING_DRIFT: prenotazioni proiettabili senza proiezione, proiezioni orfane, orari divergenti. */
async function bookingDrift(db: Db, calendars: readonly MigrationCalendar[]): Promise<AnomalyRecord[]> {
  const statuses = [...PROJECTED_BOOKING_STATUSES];
  const bookingsCal = calendars.find((c) => c.role === 'bookings' && c.lifecycle === 'active')?.id ?? null;
  const out: AnomalyRecord[] = [];
  const missing: Array<{ uid: string; status: string; start_time: Date; end_time: Date }> = await db`
    SELECT b.uid, b.status, b.start_time, b.end_time
    FROM calendar_bookings b
    WHERE b.status = ANY(${statuses}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM calendar_events e WHERE e.source = 'booking' AND e.source_id = b.uid AND e.status <> 'cancelled'
      )
    ORDER BY b.start_time, b.uid
  `;
  for (const b of missing) {
    out.push(anomaly('BOOKING_DRIFT', bookingsCal, `booking:${b.uid}`, {
      kind: 'missing_projection', booking_uid: b.uid, booking_status: b.status,
      start: new Date(b.start_time).toISOString(), end: new Date(b.end_time).toISOString(),
    }));
  }
  const projections: Array<{ id: string; calendar_id: string; source_id: string | null; status: string; start_time: Date; end_time: Date; b_uid: string | null; b_status: string | null; b_start: Date | null; b_end: Date | null }> = await db`
    SELECT e.id, e.calendar_id, e.source_id, e.status, e.start_time, e.end_time,
           b.uid AS b_uid, b.status AS b_status, b.start_time AS b_start, b.end_time AS b_end
    FROM calendar_events e
    LEFT JOIN calendar_bookings b ON b.uid = e.source_id
    WHERE e.source = 'booking' AND e.recurrence_master_id IS NULL AND e.status <> 'cancelled'
    ORDER BY e.start_time, e.id
  `;
  for (const p of projections) {
    const key = p.source_id ? `booking:${p.source_id}` : null;
    if (!p.b_uid || !PROJECTED_BOOKING_STATUSES.has(p.b_status as never)) {
      out.push(anomaly('BOOKING_DRIFT', String(p.calendar_id), key, {
        kind: 'orphan_projection', legacy_event_id: String(p.id), booking_uid: p.source_id, booking_status: p.b_status ?? null,
        start: new Date(p.start_time).toISOString(), end: new Date(p.end_time).toISOString(),
      }));
    } else if (new Date(p.start_time).getTime() !== new Date(p.b_start as Date).getTime() || new Date(p.end_time).getTime() !== new Date(p.b_end as Date).getTime()) {
      out.push(anomaly('BOOKING_DRIFT', String(p.calendar_id), key, {
        kind: 'time_mismatch', legacy_event_id: String(p.id), booking_uid: p.source_id,
        projection: { start: new Date(p.start_time).toISOString(), end: new Date(p.end_time).toISOString() },
        booking: { start: new Date(p.b_start as Date).toISOString(), end: new Date(p.b_end as Date).toISOString() },
      }));
    }
  }
  return out;
}

/**
 * POSSIBLE_DUPLICATE: copie fatte con "Duplica" (source admin, source_id =
 * id dell'originale), eventi identici nello stesso calendario, singoli uguali
 * a un'occorrenza di una serie dello stesso calendario. Informativa: si
 * migrano così come sono.
 */
async function possibleDuplicates(db: Db, included: ReadonlySet<string>): Promise<AnomalyRecord[]> {
  const out: AnomalyRecord[] = [];
  const flagged = new Set<string>();
  const copies: Array<{ id: string; calendar_id: string; summary: string; original_id: string; identical: boolean; same_calendar: boolean }> = await db`
    SELECT c.id, c.calendar_id, c.summary, o.id AS original_id,
           (c.calendar_id = o.calendar_id AND lower(btrim(c.summary)) = lower(btrim(o.summary))
            AND c.start_time = o.start_time AND c.end_time = o.end_time AND c.all_day = o.all_day
            AND coalesce(c.rrule, '') = coalesce(o.rrule, '')) AS identical,
           c.calendar_id = o.calendar_id AS same_calendar
    FROM calendar_events c
    JOIN calendar_events o ON o.id::text = c.source_id
    WHERE c.source = 'admin' AND c.recurrence_master_id IS NULL AND c.status <> 'cancelled'
      AND c.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ORDER BY c.created_at, c.id
  `;
  for (const c of copies) {
    if (!included.has(String(c.calendar_id))) continue;
    flagged.add(String(c.id));
    out.push(anomaly('POSSIBLE_DUPLICATE', String(c.calendar_id), `event:${c.id}`, {
      kind: 'duplicate_copy', legacy_event_id: String(c.id), original_id: String(c.original_id), identical: c.identical, same_calendar: c.same_calendar, summary: c.summary,
    }));
  }
  const identical: Array<{ ids: string[]; calendar_id: string; summary: string; start_time: Date }> = await db`
    SELECT array_agg(id ORDER BY created_at, id)::text[] AS ids, calendar_id, min(summary) AS summary, start_time
    FROM calendar_events
    WHERE recurrence_master_id IS NULL AND status <> 'cancelled' AND source NOT IN ('ics_pull', 'booking', 'system')
    GROUP BY calendar_id, lower(btrim(summary)), start_time, end_time, all_day, coalesce(rrule, '')
    HAVING count(*) > 1
  `;
  for (const g of identical) {
    if (!included.has(String(g.calendar_id))) continue;
    const [first, ...others] = g.ids;
    for (const id of others) {
      if (flagged.has(id)) continue;
      flagged.add(id);
      out.push(anomaly('POSSIBLE_DUPLICATE', String(g.calendar_id), `event:${id}`, {
        kind: 'identical', legacy_event_id: id, same_as: first, summary: g.summary, start: new Date(g.start_time).toISOString(),
      }));
    }
  }
  // Singoli uguali a un'occorrenza di una serie dello stesso calendario (stesso titolo, inizio e fine).
  const singles: Array<{ id: string; calendar_id: string; summary: string; start_time: Date; end_time: Date }> = await db`
    SELECT s.id, s.calendar_id, s.summary, s.start_time, s.end_time
    FROM calendar_events s
    WHERE s.recurrence_master_id IS NULL AND coalesce(s.rrule, '') = '' AND s.status <> 'cancelled' AND NOT s.all_day
      AND s.source NOT IN ('ics_pull', 'booking', 'system')
      AND EXISTS (
        SELECT 1 FROM calendar_events m
        WHERE m.calendar_id = s.calendar_id AND m.recurrence_master_id IS NULL AND coalesce(m.rrule, '') <> ''
          AND m.status <> 'cancelled' AND lower(btrim(m.summary)) = lower(btrim(s.summary)) AND m.start_time <= s.start_time
      )
    ORDER BY s.start_time, s.id
    LIMIT 500
  `;
  const store = getPgLegacyStore();
  for (const s of singles) {
    if (!included.has(String(s.calendar_id)) || flagged.has(String(s.id))) continue;
    const start = new Date(s.start_time).getTime();
    const end = new Date(s.end_time).getTime();
    const occ = await store.listOccurrences({
      calendarId: String(s.calendar_id),
      fromIso: new Date(start).toISOString(),
      toIso: new Date(start + 1000).toISOString(),
    });
    const match = occ.find((o) => String(o.id) !== String(s.id) && o.original_start !== null && !o.is_override
      && new Date(o.start_time).getTime() === start && new Date(o.end_time).getTime() === end
      && (o.summary ?? '').trim().toLowerCase() === (s.summary ?? '').trim().toLowerCase());
    if (match) {
      flagged.add(String(s.id));
      out.push(anomaly('POSSIBLE_DUPLICATE', String(s.calendar_id), `event:${s.id}`, {
        kind: 'equals_series_occurrence', legacy_event_id: String(s.id), series_id: String(match.id), summary: s.summary, start: new Date(start).toISOString(),
      }));
    }
  }
  return out;
}

/** NON_PROJECTION_IN_BOOKINGS se il serializer non l'ha già riportata (eventi manual/admin/mcp nel calendario Prenotazioni). */
async function nonProjectionInBookings(db: Db, calendars: readonly MigrationCalendar[], moveIds: ReadonlySet<string>): Promise<AnomalyRecord[]> {
  const ids = calendars.filter((c) => c.role === 'bookings' && c.included).map((c) => c.id);
  if (ids.length === 0) return [];
  const rows: Array<{ id: string; calendar_id: string; summary: string; source: string; start_time: Date; rrule: string | null }> = await db`
    SELECT id, calendar_id, summary, source, start_time, rrule FROM calendar_events
    WHERE calendar_id = ANY(${ids}::uuid[]) AND recurrence_master_id IS NULL AND source NOT IN ('booking', 'ics_pull')
    ORDER BY start_time, id
  `;
  return rows.map((r) => anomaly('NON_PROJECTION_IN_BOOKINGS', String(r.calendar_id), `event:${r.id}`, {
    legacy_event_id: String(r.id), source: r.source, summary: r.summary, start: new Date(r.start_time).toISOString(),
    recurring: Boolean(r.rrule), move: moveIds.has(String(r.id).toLowerCase()),
  }));
}

/**
 * Chiave di deduplica di un'anomalia: codice, calendario e oggetto (chiave
 * legacy) o, per le anomalie senza oggetto, l'iscrizione o l'app-password; le
 * anomalie di calendario (COLLECTION_NAME_INVALID, EVENTS_IN_EXCLUDED_CALENDAR)
 * sono una per calendario. Serializer e controlli propri possono riportare la
 * stessa anomalia (POSSIBLE_DUPLICATE, BOOKING_DRIFT) con dettagli diversi:
 * resta una riga con i dettagli uniti.
 */
function anomalyKey(a: AnomalyRecord): string {
  const d = a.detail ?? {};
  const discriminator = a.legacy_key ?? String(d.subscription_id ?? d.app_password_id ?? '');
  return `${a.code}|${a.calendar_id ?? ''}|${discriminator}`;
}

/** Anomalie uniche nell'ordine di prima apparizione, con i dettagli dei doppioni uniti (vince il primo). */
export function dedupeAnomalies(anomalies: readonly AnomalyRecord[]): AnomalyRecord[] {
  const unique = new Map<string, AnomalyRecord>();
  for (const a of anomalies) {
    const k = anomalyKey(a);
    const prev = unique.get(k);
    if (prev) prev.detail = { ...a.detail, ...prev.detail };
    else unique.set(k, { ...a, detail: { ...a.detail } });
  }
  return [...unique.values()];
}

// ─── Run ───────────────────────────────

/** Conteggi e anomalie per calendario (design §13.4), impatto delle iscrizioni, app-password, stima della durata. */
export async function runInventory(ctx: MigrationRunContext<InventoryParams>): Promise<InventorySummary> {
  const started = Date.now();
  const now = new Date();
  const scope: MigrationScope = ctx.params?.scope ?? {};
  ctx.throwIfCancelled();
  await ctx.progress({ phase: 'read-legacy', message: 'Lettura dei calendari e degli eventi legacy' });

  const calendars = await loadMigrationCalendars(ctx.db, scope);
  const inScope = new Set(calendars.map((c) => c.id));
  const included = new Set(calendars.filter((c) => c.included).map((c) => c.id));
  const counts = await countByCalendar(ctx.db);

  // Anomalie del serializer in sola analisi (opzioni di default: le stesse dell'anteprima senza scelte).
  await ctx.progress({ phase: 'analyze', message: 'Analisi con il serializer' });
  const options = resolveMigrationOptions({});
  const source = await loadLegacySource(ctx.db, { scope, now });
  const serialization = serializeLegacy(source, options, { now });
  ctx.throwIfCancelled();

  const anomalies: AnomalyRecord[] = [...serialization.anomalies];
  await ctx.progress({ phase: 'checks', message: 'Prenotazioni, duplicati, iscrizioni e app-password' });
  anomalies.push(...(await bookingDrift(ctx.db, calendars)).filter((a) => !a.calendar_id || inScope.has(a.calendar_id)));
  anomalies.push(...(await possibleDuplicates(ctx.db, included)));
  if (!anomalies.some((a) => a.code === 'NON_PROJECTION_IN_BOOKINGS')) {
    anomalies.push(...(await nonProjectionInBookings(ctx.db, calendars, new Set(options.bookings_move_event_ids))));
  }

  const principal = radicaleRuntime().principal;
  const apps = await inventoryAppPasswords(ctx.db, principal);
  for (const r of apps.reserved) anomalies.push(anomaly('RESERVED_APP_PASSWORD', null, null, { app_password_id: r.id, username: safeUsername(r.username) }));
  for (const r of apps.non_canonical) anomalies.push(anomaly('NON_CANONICAL_APP_PASSWORD', null, null, { app_password_id: r.id, username: safeUsername(r.username), principal }));

  const subscriptions = await computeSubscriptionImpacts(ctx.db, { now, weeks: SUBSCRIPTION_IMPACT_WEEKS });
  const refetch: Array<{ id: string; has_validators: boolean }> = await ctx.db`
    SELECT id, (etag IS NOT NULL OR last_modified IS NOT NULL) AS has_validators FROM calendar_subscriptions
  `;
  const validators = new Map(refetch.map((r) => [String(r.id), r.has_validators]));
  for (const s of subscriptions) {
    if (scope.calendar_ids?.length && !inScope.has(s.target_calendar_id)) continue;
    anomalies.push(anomaly('SUBSCRIPTION_BLOCKING_IMPACT', s.target_calendar_id, null, {
      subscription_id: s.subscription_id, name: s.name, blocks_availability: s.blocks_availability, impact: s.impact,
    }));
    anomalies.push(anomaly('ICS_PULL_REFETCH', s.target_calendar_id, null, {
      subscription_id: s.subscription_id, events_legacy: s.events_legacy, has_validators: validators.get(s.subscription_id) ?? false,
    }));
  }

  for (const c of calendars) {
    if (c.excluded_reason === 'collection_name_invalid') {
      anomalies.push(anomaly('COLLECTION_NAME_INVALID', c.id, null, { slug: c.slug, collection_name: c.collection_name }));
    }
    const rows = counts.get(c.id)?.rows ?? 0;
    if (!c.included && rows > 0) {
      anomalies.push(anomaly('EVENTS_IN_EXCLUDED_CALENDAR', c.id, null, { slug: c.slug, excluded_reason: c.excluded_reason, rows }));
    }
  }

  // Deduplica (un controllo proprio non ripete un'anomalia del serializer: ne completa il dettaglio).
  const unique = dedupeAnomalies(anomalies);

  // Inventario per calendario.
  const perCalendar: CalendarInventory[] = calendars.map((c) => {
    const row = counts.get(c.id);
    const holiday = recognizeHolidayCalendar(c);
    const inv: InventoryCounts = emptyInventoryCounts();
    if (row) {
      inv.rows = row.rows;
      inv.singles_timed = row.singles_timed;
      inv.singles_all_day = row.singles_all_day;
      inv.series = row.series;
      inv.overrides_modified = row.overrides_modified;
      inv.overrides_cancelled = row.overrides_cancelled;
      inv.exdates = row.exdates;
      inv.projections = row.projections;
      inv.holidays_system = row.holidays_system;
      inv.closures = holiday ? row.other_masters : 0;
      inv.non_projection_in_bookings = c.role === 'bookings' ? row.non_booking_masters : 0;
    }
    const byCode: Partial<Record<AnomalyCode, number>> = {};
    for (const a of unique) if (a.calendar_id === c.id) byCode[a.code] = (byCode[a.code] ?? 0) + 1;
    const detail: CalendarInventory & { holidays: { recognized_by: HolidayRecognition; role_mismatch: boolean; system_rows_outside_holidays: boolean }; ics_pull_rows: number; ics_feed_enabled: boolean } = {
      calendar_id: c.id,
      slug: c.slug,
      name: c.name,
      collection_name: c.collection_name,
      role: c.role,
      origin: c.origin,
      is_system: c.is_system,
      blocks_availability: c.blocks_availability,
      included: c.included,
      excluded_reason: c.excluded_reason,
      counts: inv,
      anomalies: byCode,
      holidays: {
        recognized_by: holiday,
        role_mismatch: holiday !== null && holiday !== 'role',
        system_rows_outside_holidays: holiday === null && (row?.holidays_system ?? 0) > 0,
      },
      ics_pull_rows: row?.ics_pull ?? 0,
      ics_feed_enabled: c.ics_feed_enabled,
    };
    return detail;
  });

  const totals = emptyInventoryCounts();
  for (const c of perCalendar) {
    for (const k of Object.keys(totals) as Array<keyof InventoryCounts>) totals[k] += c.counts[k];
  }
  const byCode: Partial<Record<AnomalyCode, number>> = {};
  for (const a of unique) byCode[a.code] = (byCode[a.code] ?? 0) + 1;

  // Stima dell'apply: oggetti da scrivere (al più tutti) e cancellazioni possibili, al ritmo massimo delle PUT.
  const liveKeys: Array<{ legacy_key: string }> = await ctx.db`
    SELECT legacy_key FROM cal_migration_ledger WHERE deleted_at IS NULL AND kind <> 'archive'
  `;
  const wanted = new Set(serialization.objects.map((o) => o.legacy_key));
  const deletions = liveKeys.filter((r) => !wanted.has(r.legacy_key as never)).length;
  const writes = serialization.objects.length + deletions;
  const readSeconds = Math.ceil((Date.now() - started) / 1000);
  const estimate = {
    objects: serialization.objects.length,
    writes_upper_bound: writes,
    seconds: Math.ceil(writes / MIGRATION_LIMITS.maxPutsPerSecond) + 1 + readSeconds,
  };

  const items: MigrationItemInput[] = unique.map((a) => ({
    item_type: 'anomaly' as const,
    calendar_id: a.calendar_id,
    collection_name: a.calendar_id ? calendars.find((c) => c.id === a.calendar_id)?.collection_name ?? null : null,
    legacy_key: a.legacy_key,
    code: a.code,
    severity: a.severity,
    detail: { ...a.detail, blocking: ANOMALY_DEFINITIONS[a.code].blocking },
  }));
  for (let i = 0; i < items.length; i += 500) {
    ctx.throwIfCancelled();
    await ctx.addItems(items.slice(i, i + 500));
  }

  const summary: InventorySummary = {
    generated_at: now.toISOString(),
    calendars: perCalendar,
    totals,
    anomalies: byCode,
    subscriptions,
    app_passwords: { active: apps.active, non_canonical: apps.non_canonical.length, reserved: apps.reserved.length },
    estimate,
  };
  await ctx.progress({ phase: 'done', done: perCalendar.length, total: perCalendar.length, message: `Inventario di ${perCalendar.length} calendari` });
  ctx.log.info({ calendars: perCalendar.length, anomalies: unique.length, objects: estimate.objects }, 'inventario della migrazione concluso');
  return summary;
}
