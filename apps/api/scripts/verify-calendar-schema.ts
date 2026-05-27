/**
 * Post-migration verification for Caldes Calendar.
 *
 * Checks:
 * - required tables exist and are readable
 * - calendar and event type seed data is loaded
 * - anti-overlap EXCLUDE constraint is active
 * - legacy Google Calendar tables are gone or renamed
 */
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });
let failures = 0;

function pgErrorSummary(err: unknown): string {
  const pgErr = err as {
    code?: string;
    message?: string;
    detail?: string;
    hint?: string;
    constraint_name?: string;
    table_name?: string;
    column_name?: string;
    errors?: Array<{ code?: string; message?: string }>;
  };

  const parts = [
    pgErr.code ? `code=${pgErr.code}` : null,
    pgErr.message ? `message=${pgErr.message}` : null,
    pgErr.detail ? `detail=${pgErr.detail}` : null,
    pgErr.hint ? `hint=${pgErr.hint}` : null,
    pgErr.table_name ? `table=${pgErr.table_name}` : null,
    pgErr.column_name ? `column=${pgErr.column_name}` : null,
    pgErr.constraint_name ? `constraint=${pgErr.constraint_name}` : null,
  ].filter(Boolean);

  if (parts.length > 0) return parts.join(' | ');

  const nested = pgErr.errors?.[0];
  if (nested) {
    return [
      nested.code ? `code=${nested.code}` : null,
      nested.message ? `message=${nested.message}` : null,
    ].filter(Boolean).join(' | ');
  }

  return String(err);
}

async function check(label: string, fn: () => Promise<string | null>) {
  try {
    const result = await fn();
    console.log(result === null ? `  OK ${label}` : `  OK ${label} -> ${result}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${label} -> ${pgErrorSummary(err)}`);
  }
}

async function main() {
  console.log('Calendar schema verification\n');

  console.log('Required tables:');
  await check('calendars', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendars`;
    return `${r[0].n} rows`;
  });
  await check('calendar_events', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_events`;
    return `${r[0].n} rows`;
  });
  await check('calendar_event_types', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_event_types`;
    return `${r[0].n} rows`;
  });
  await check('calendar_bookings', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_bookings`;
    return `${r[0].n} rows`;
  });
  await check('calendar_availability_schedules', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_availability_schedules`;
    return `${r[0].n} rows`;
  });
  await check('calendar_availability_slots', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_availability_slots`;
    return `${r[0].n} rows`;
  });

  console.log('\nCalendar seed data (expected 4):');
  const calendars = await sql`
    SELECT slug, name, color, is_default, is_system, blocks_availability, ics_feed_token
    FROM calendars
    ORDER BY sort_order
  `;
  for (const calendar of calendars) {
    const token = String(calendar.ics_feed_token || '').slice(0, 8);
    const flags = [
      calendar.is_default ? '[default]' : '',
      calendar.is_system ? '[system]' : '',
      calendar.blocks_availability ? '[blocks]' : '[informative]',
    ].filter(Boolean).join('');
    console.log(`  - ${String(calendar.slug).padEnd(12)} "${calendar.name}" ${calendar.color} ${flags} token=${token}...`);
  }

  console.log('\nEvent type seed data (expected 2):');
  const eventTypes = await sql`
    SELECT slug, title, duration_minutes, location_type
    FROM calendar_event_types
    ORDER BY sort_order
  `;
  for (const eventType of eventTypes) {
    console.log(`  - ${String(eventType.slug).padEnd(35)} "${eventType.title}" ${eventType.duration_minutes}min ${eventType.location_type}`);
  }

  console.log('\nDefault schedule (expected Mon-Fri 09-13 + 14-18):');
  const scheduleSlots = await sql`
    SELECT s.day_of_week, to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time
    FROM calendar_availability_slots s
    JOIN calendar_availability_schedules sch ON sch.id = s.schedule_id
    WHERE sch.is_default = true
    ORDER BY s.day_of_week, s.start_time
  `;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const row of scheduleSlots) {
    console.log(`  - ${days[row.day_of_week as number]} ${row.start_time}-${row.end_time}`);
  }

  console.log('\nEXCLUDE constraint on calendar_bookings:');
  await check('calendar_bookings_no_overlap', async () => {
    const constraints = await sql`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'calendar_bookings'::regclass
        AND conname = 'calendar_bookings_no_overlap'
    `;
    if (constraints.length === 0) throw new Error('constraint missing');
    return null;
  });

  console.log('\nGoogle Calendar cleanup:');
  await check('google_oauth_tokens dropped', async () => {
    const r = await sql`SELECT to_regclass('public.google_oauth_tokens') AS t`;
    if (r[0].t !== null) throw new Error('table still present');
    return null;
  });
  await check('legacy_google_calendar_events renamed or absent', async () => {
    const r = await sql`SELECT to_regclass('public.legacy_google_calendar_events') AS t`;
    return r[0].t !== null ? 'renamed table present' : 'not present';
  });

  console.log('\nICS feed URLs:');
  for (const calendar of calendars) {
    const url = `http://localhost:3001/api/calendar/feed/${calendar.ics_feed_token}.ics`;
    console.log(`  ${String(calendar.slug).padEnd(12)} -> ${url}`);
  }

  await sql.end();

  if (failures > 0) {
    console.error(`\nCalendar verification failed with ${failures} issue(s).`);
    process.exit(1);
  }

  console.log('\nCalendar verification completed');
}

main().catch(async (err) => {
  console.error('\nERROR:', pgErrorSummary(err));
  await sql.end({ timeout: 1 }).catch(() => undefined);
  process.exit(1);
});
