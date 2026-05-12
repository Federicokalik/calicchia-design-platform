/**
 * Verifica post-migration:
 * - tabelle nuove esistono
 * - seed calendari + event types caricato
 * - constraint EXCLUDE attivo
 * - tabelle Google droppate/rinominate
 */
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const _dir = dirname(fileURLToPath(import.meta.url));
void _dir;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}
const sql = postgres(DATABASE_URL, { onnotice: () => {} });

async function check(label: string, fn: () => Promise<string | null>) {
  try {
    const result = await fn();
    if (result === null) {
      console.log(`  ✓ ${label}`);
    } else {
      console.log(`  ✓ ${label} → ${result}`);
    }
  } catch (err: any) {
    console.log(`  ✗ ${label} — ${err.message}`);
  }
}

async function main() {
  console.log('🔍 Verifica schema Caldes Calendar\n');

  console.log('📋 Tabelle nuove:');
  await check('calendars', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendars`;
    return `${r[0].n} righe`;
  });
  await check('calendar_events', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_events`;
    return `${r[0].n} righe`;
  });
  await check('calendar_event_types', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_event_types`;
    return `${r[0].n} righe`;
  });
  await check('calendar_bookings', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_bookings`;
    return `${r[0].n} righe`;
  });
  await check('calendar_availability_schedules', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_availability_schedules`;
    return `${r[0].n} righe`;
  });
  await check('calendar_availability_slots', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_availability_slots`;
    return `${r[0].n} righe`;
  });

  console.log('\n🌱 Seed calendari (atteso 4):');
  const cals = await sql`SELECT slug, name, color, is_default, is_system, ics_feed_token FROM calendars ORDER BY sort_order`;
  for (const c of cals) {
    console.log(`  - ${c.slug.padEnd(12)} "${c.name}" ${c.color} ${c.is_default ? '[default]' : ''}${c.is_system ? '[system]' : ''} token=${(c.ics_feed_token as string).slice(0, 8)}...`);
  }

  console.log('\n🌱 Seed event types (atteso 2):');
  const ets = await sql`SELECT slug, title, duration_minutes, location_type FROM calendar_event_types ORDER BY sort_order`;
  for (const e of ets) {
    console.log(`  - ${e.slug.padEnd(35)} "${e.title}" ${e.duration_minutes}min ${e.location_type}`);
  }

  console.log('\n🌱 Schedule default (atteso lun-ven 09-13 + 14-18):');
  const schedSlots = await sql`
    SELECT s.day_of_week, to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time
    FROM calendar_availability_slots s
    JOIN calendar_availability_schedules sch ON sch.id = s.schedule_id
    WHERE sch.is_default = true
    ORDER BY s.day_of_week, s.start_time
  `;
  const days = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  for (const r of schedSlots) {
    console.log(`  - ${days[r.day_of_week as number]} ${r.start_time}-${r.end_time}`);
  }

  console.log('\n🔒 Constraint EXCLUDE su calendar_bookings:');
  const constraints = await sql`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'calendar_bookings'::regclass
      AND conname = 'calendar_bookings_no_overlap'
  `;
  if (constraints.length > 0) {
    console.log(`  ✓ ${constraints[0].conname}`);
  } else {
    console.log(`  ✗ MANCANTE`);
  }

  console.log('\n🗑️  Cleanup Google:');
  const gToks = await sql`SELECT to_regclass('public.google_oauth_tokens') AS t`;
  console.log(`  - google_oauth_tokens: ${gToks[0].t === null ? '✓ droppata' : '✗ ANCORA PRESENTE'}`);
  const gLegacy = await sql`SELECT to_regclass('public.legacy_google_calendar_events') AS t`;
  console.log(`  - legacy_google_calendar_events: ${gLegacy[0].t !== null ? '✓ rinominata' : '~ non presente (mai esistita)'}`);

  console.log('\n📡 ICS Feed URLs:');
  for (const c of cals) {
    const url = `http://localhost:3001/api/calendar/feed/${c.ics_feed_token}.ics`;
    console.log(`  ${c.slug.padEnd(12)} → ${url}`);
  }

  await sql.end();
  console.log('\n✅ Verifica completata');
}

main().catch((err) => {
  console.error('\n❌ Errore:', err.message);
  process.exit(1);
});
