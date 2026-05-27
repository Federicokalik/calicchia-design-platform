import { sql } from '../../db';
import { listOccurrences } from './events';
import type { Slot } from './types';

export interface CapacityWeekUsage {
  weekStartIso: string;
  weekEndIso: string;
  hoursAvailable: number;
  minutesUsed: number;
  minutesRemaining: number;
  timeEntryMinutes: number;
  timeEntryCount: number;
  bookingMinutes: number;
  bookingCount: number;
  calendarMinutes: number;
  calendarBySource: Record<string, { minutes: number; count: number }>;
  runningTimers: number;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function overlapMinutes(startIso: string, endIso: string, fromIso: string, toIsoValue: string): number {
  const start = Math.max(new Date(startIso).getTime(), new Date(fromIso).getTime());
  const end = Math.min(new Date(endIso).getTime(), new Date(toIsoValue).getTime());
  return Math.max(0, Math.round((end - start) / 60_000));
}

export async function getWeeklyCapacityHours(): Promise<number> {
  const rows = await sql<Array<{ hours: number | string | null }>>`
    SELECT (value->>'weekly_capacity_hours')::int AS hours
    FROM site_settings WHERE key = 'freelancer.studio' LIMIT 1
  `;
  const hours = Number(rows[0]?.hours ?? 40);
  return Number.isFinite(hours) && hours >= 0 ? hours : 40;
}

async function getWeekBounds(fromIso: string, toIsoValue: string): Promise<Array<{ start: string; end: string }>> {
  const rows = await sql<Array<{ week_start: string | Date; week_end: string | Date }>>`
    SELECT
      gs AS week_start,
      gs + INTERVAL '7 days' AS week_end
    FROM generate_series(
      date_trunc('week', ${fromIso}::timestamptz AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome',
      date_trunc('week', ${toIsoValue}::timestamptz AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome',
      INTERVAL '7 days'
    ) AS gs
  `;
  return rows.map((row) => ({ start: toIso(row.week_start), end: toIso(row.week_end) }));
}

export async function getCapacityWeeks(fromIso: string, toIsoValue: string): Promise<CapacityWeekUsage[]> {
  const hoursAvailable = await getWeeklyCapacityHours();
  const weeks = await getWeekBounds(fromIso, toIsoValue);

  const results: CapacityWeekUsage[] = [];
  for (const week of weeks) {
    const [timeRows, bookingRows, occurrences] = await Promise.all([
      sql<Array<{ minutes: number | string; entries_count: number | string; running_count: number | string }>>`
        SELECT
          COALESCE(SUM(EXTRACT(EPOCH FROM (
            LEAST(end_time, ${week.end}::timestamptz) - GREATEST(start_time, ${week.start}::timestamptz)
          )) / 60), 0)::int AS minutes,
          COUNT(*) FILTER (WHERE end_time IS NOT NULL)::int AS entries_count,
          COUNT(*) FILTER (WHERE end_time IS NULL)::int AS running_count
        FROM time_entries
        WHERE start_time < ${week.end}::timestamptz
          AND COALESCE(end_time, start_time) > ${week.start}::timestamptz
      `,
      sql<Array<{ minutes: number | string; count: number | string }>>`
        SELECT
          COALESCE(SUM(EXTRACT(EPOCH FROM (
            LEAST(end_time, ${week.end}::timestamptz) - GREATEST(start_time, ${week.start}::timestamptz)
          )) / 60), 0)::int AS minutes,
          COUNT(*)::int AS count
        FROM calendar_bookings
        WHERE status = 'confirmed'
          AND start_time < ${week.end}::timestamptz
          AND end_time > ${week.start}::timestamptz
      `,
      listOccurrences({ fromIso: week.start, toIso: week.end, blockingOnly: true }),
    ]);

    const calendarBySource: Record<string, { minutes: number; count: number }> = {};
    let calendarMinutes = 0;
    for (const occurrence of occurrences) {
      if (occurrence.status !== 'confirmed' || occurrence.all_day || occurrence.source === 'booking') continue;
      const minutes = overlapMinutes(occurrence.start_time, occurrence.end_time, week.start, week.end);
      if (minutes <= 0) continue;
      calendarMinutes += minutes;
      const bucket = calendarBySource[occurrence.source] ?? { minutes: 0, count: 0 };
      bucket.minutes += minutes;
      bucket.count += 1;
      calendarBySource[occurrence.source] = bucket;
    }

    const timeEntryMinutes = Number(timeRows[0]?.minutes ?? 0);
    const bookingMinutes = Number(bookingRows[0]?.minutes ?? 0);
    const minutesUsed = timeEntryMinutes + bookingMinutes + calendarMinutes;
    const capacityMinutes = hoursAvailable * 60;

    results.push({
      weekStartIso: week.start,
      weekEndIso: week.end,
      hoursAvailable,
      minutesUsed,
      minutesRemaining: Math.max(0, capacityMinutes - minutesUsed),
      timeEntryMinutes,
      timeEntryCount: Number(timeRows[0]?.entries_count ?? 0),
      bookingMinutes,
      bookingCount: Number(bookingRows[0]?.count ?? 0),
      calendarMinutes,
      calendarBySource,
      runningTimers: Number(timeRows[0]?.running_count ?? 0),
    });
  }

  return results;
}

export async function hasWeeklyCapacityForBooking(startIso: string, durationMinutes: number): Promise<boolean> {
  const startMs = new Date(startIso).getTime();
  if (isNaN(startMs)) return false;
  const endIso = new Date(startMs + durationMinutes * 60_000).toISOString();
  const weeks = await getCapacityWeeks(startIso, endIso);
  return weeks.every((week) => {
    const minutesInWeek = overlapMinutes(startIso, endIso, week.weekStartIso, week.weekEndIso);
    return week.minutesUsed + minutesInWeek <= week.hoursAvailable * 60;
  });
}

export async function filterSlotsByWeeklyCapacity(slots: Slot[], _durationMinutes: number): Promise<Slot[]> {
  if (slots.length === 0) return slots;
  const fromIso = slots[0].start;
  const toIsoValue = slots[slots.length - 1].end;
  const weeks = await getCapacityWeeks(fromIso, toIsoValue);
  return slots.filter((slot) => {
    return weeks.every((week) => {
      const minutesInWeek = overlapMinutes(slot.start, slot.end, week.weekStartIso, week.weekEndIso);
      if (minutesInWeek <= 0) return true;
      return week.minutesUsed + minutesInWeek <= week.hoursAvailable * 60;
    });
  });
}
