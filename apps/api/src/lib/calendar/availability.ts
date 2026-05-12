/**
 * Availability resolver.
 *
 * Espande lo schedule settimanale + override su un range di date e produce
 * intervalli "busy/available" in UTC, pronti per essere intersecati con
 * bookings esistenti e busy times Google nello slot calculator.
 */

import { fromZonedTime } from 'date-fns-tz';
import { sql } from '../../db';
import type {
  AvailabilityOverride,
  AvailabilitySchedule,
  AvailabilitySlot,
  EventType,
} from './types';

export interface DayWindow {
  /** Data locale nello schedule.timezone (YYYY-MM-DD) */
  dateLocal: string;
  /** ISO UTC inizio finestra */
  startUtc: string;
  /** ISO UTC fine finestra */
  endUtc: string;
}

/**
 * Restituisce l'event type completo per id o slug.
 * Lancia 404 se non esiste / non attivo.
 */
export async function getEventType(idOrSlug: string, opts?: { onlyPublic?: boolean }): Promise<EventType | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const onlyPublic = opts?.onlyPublic === true;

  const rows = await sql<EventType[]>`
    SELECT id, slug, title, description, duration_minutes,
           buffer_before_minutes, buffer_after_minutes, slot_increment_minutes,
           min_notice_hours, max_advance_days,
           location_type, location_value, color,
           is_active, is_public, requires_approval,
           custom_questions, workflow_event_key, schedule_id, sort_order
    FROM calendar_event_types
    WHERE ${isUuid ? sql`id = ${idOrSlug}::uuid` : sql`slug = ${idOrSlug}`}
    LIMIT 1
  `;

  const et = rows[0];
  if (!et) return null;
  if (!et.is_active) return null;
  if (onlyPublic && !et.is_public) return null;
  return et;
}

/**
 * Carica schedule + slots ricorrenti + overrides su un range di date.
 * Se l'event type non ha schedule_id usa quello marcato is_default=true.
 */
export async function loadScheduleForEventType(eventType: EventType): Promise<{
  schedule: AvailabilitySchedule;
  slots: AvailabilitySlot[];
  overrides: AvailabilityOverride[];
} | null> {
  const scheduleRows = eventType.schedule_id
    ? await sql<AvailabilitySchedule[]>`
        SELECT id, name, timezone, is_default
        FROM calendar_availability_schedules
        WHERE id = ${eventType.schedule_id}::uuid
        LIMIT 1
      `
    : await sql<AvailabilitySchedule[]>`
        SELECT id, name, timezone, is_default
        FROM calendar_availability_schedules
        WHERE is_default = true
        ORDER BY created_at ASC
        LIMIT 1
      `;

  const schedule = scheduleRows[0];
  if (!schedule) return null;

  const [slots, overrides] = await Promise.all([
    sql<AvailabilitySlot[]>`
      SELECT id, schedule_id, day_of_week,
             to_char(start_time, 'HH24:MI:SS') AS start_time,
             to_char(end_time,   'HH24:MI:SS') AS end_time
      FROM calendar_availability_slots
      WHERE schedule_id = ${schedule.id}::uuid
      ORDER BY day_of_week, start_time
    `,
    sql<AvailabilityOverride[]>`
      SELECT id, schedule_id, override_date::text AS override_date,
             is_unavailable,
             to_char(start_time, 'HH24:MI:SS') AS start_time,
             to_char(end_time,   'HH24:MI:SS') AS end_time,
             note
      FROM calendar_availability_overrides
      WHERE schedule_id = ${schedule.id}::uuid
    `,
  ]);

  return { schedule, slots, overrides };
}

/**
 * Genera la sequenza di YYYY-MM-DD locali (timezone) tra fromDate e toDate inclusi.
 * Le date sono interpretate come "wall date" nel timezone — niente shift UTC implicito.
 */
export function enumerateDates(fromDateLocal: string, toDateLocal: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = fromDateLocal.split('-').map(Number);
  const [ty, tm, td] = toDateLocal.split('-').map(Number);
  const start = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cursor.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${d}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Ritorna il day_of_week (0=domenica) per una data locale "YYYY-MM-DD" senza shift TZ.
 */
export function dayOfWeekFromDateLocal(dateLocal: string): number {
  const [y, m, d] = dateLocal.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Espande in finestre UTC tutti i blocchi di disponibilità per una data range.
 * - applica overrides (is_unavailable=true → niente finestre per quella data)
 * - se override ha start/end li usa al posto dei recurring slots
 * - rispetta DST tramite date-fns-tz fromZonedTime
 */
export function buildAvailabilityWindows(opts: {
  schedule: AvailabilitySchedule;
  slots: AvailabilitySlot[];
  overrides: AvailabilityOverride[];
  fromDateLocal: string;
  toDateLocal: string;
}): DayWindow[] {
  const overrideMap = new Map<string, AvailabilityOverride>();
  for (const ov of opts.overrides) overrideMap.set(ov.override_date, ov);

  const windows: DayWindow[] = [];

  for (const dateLocal of enumerateDates(opts.fromDateLocal, opts.toDateLocal)) {
    const ov = overrideMap.get(dateLocal);

    if (ov && ov.is_unavailable) continue;

    if (ov && ov.start_time && ov.end_time) {
      windows.push({
        dateLocal,
        startUtc: fromZonedTime(`${dateLocal}T${ov.start_time}`, opts.schedule.timezone).toISOString(),
        endUtc:   fromZonedTime(`${dateLocal}T${ov.end_time}`,   opts.schedule.timezone).toISOString(),
      });
      continue;
    }

    const dow = dayOfWeekFromDateLocal(dateLocal);
    const daySlots = opts.slots.filter((s) => s.day_of_week === dow);
    for (const s of daySlots) {
      windows.push({
        dateLocal,
        startUtc: fromZonedTime(`${dateLocal}T${s.start_time}`, opts.schedule.timezone).toISOString(),
        endUtc:   fromZonedTime(`${dateLocal}T${s.end_time}`,   opts.schedule.timezone).toISOString(),
      });
    }
  }

  return windows;
}
