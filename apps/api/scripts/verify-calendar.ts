/**
 * Calendar smoke test — exercises the booking engine end-to-end against the
 * local database by calling the lib functions directly (no HTTP server, no
 * emails: senders live in the routes, Google push is stubbed).
 *
 * Covers: event types, slot computation, booking lifecycle (create / conflict
 * / reschedule / cancel), approval flow (pending → approve / reject),
 * custom-responses validation, SSRF guard, ICS build, HMAC tokens, CalDAV
 * app-passwords, data hygiene.
 *
 * Run: pnpm --filter @calicchia/api run verify:calendar:smoke
 * (wraps: tsx --env-file=../../.env scripts/verify-calendar.ts)
 *
 * All test rows are tagged with TEST_EMAIL / TEST_SLUG_* and removed in the
 * final cleanup even when a check fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { sql } from '../src/db';
import { getEventType } from '../src/lib/calendar/availability';
import { computeAvailableSlots } from '../src/lib/calendar/slots';
import {
  createBooking,
  cancelBooking,
  rescheduleBooking,
  approveBooking,
  rejectBooking,
  validateCustomResponses,
  BookingConflictError,
  BookingValidationError,
} from '../src/lib/calendar/booking';
import { getEventBySource } from '../src/lib/calendar/events';
import { buildIcs } from '../src/lib/calendar/ics';
import { buildIcsFeed } from '../src/lib/calendar/ics-feed';
import { getDefaultCalendar } from '../src/lib/calendar/calendars';
import { signBookingToken, verifyBookingToken, isTokenSecretConfigured } from '../src/lib/calendar/token';
import { assertPublicUrl } from '../src/lib/calendar/ics-import';
import { createAppPassword, verifyCredentials, revokeAppPassword } from '../src/lib/calendar/caldav-passwords';
import type { Slot } from '../src/lib/calendar/types';

const TEST_EMAIL = 'verify-calendar@test.invalid';
const TEST_SLUG = 'verify-smoke-test';
const TEST_SLUG_APPROVAL = 'verify-smoke-approval';

let failures = 0;

function pgErrorSummary(err: unknown): string {
  const e = err as { code?: string; message?: string; detail?: string; constraint_name?: string };
  const parts = [
    e.code ? `code=${e.code}` : null,
    e.message ? `message=${e.message}` : null,
    e.detail ? `detail=${e.detail}` : null,
    e.constraint_name ? `constraint=${e.constraint_name}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : String(err);
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

/** Today's date (YYYY-MM-DD) in Europe/Rome, plus N days. */
function romeDatePlus(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);
}

async function seedEventType(slug: string, opts: { requiresApproval: boolean; customQuestions?: unknown }) {
  await sql`
    INSERT INTO calendar_event_types (
      slug, title, description, duration_minutes, slot_increment_minutes,
      buffer_before_minutes, buffer_after_minutes, min_notice_hours, max_advance_days,
      location_type, is_active, is_public, requires_approval, custom_questions, sort_order
    ) VALUES (
      ${slug}, 'Smoke test', 'created by verify-calendar.ts', 30, 30,
      0, 0, 0, 60,
      'phone', true, false, ${opts.requiresApproval}, ${JSON.stringify(opts.customQuestions ?? [])}::jsonb, 999
    )
    ON CONFLICT (slug) DO UPDATE SET
      is_active = true, requires_approval = ${opts.requiresApproval},
      custom_questions = ${JSON.stringify(opts.customQuestions ?? [])}::jsonb
  `;
}

async function firstFreeSlots(slug: string, count: number): Promise<Slot[]> {
  const result = await computeAvailableSlots({
    eventTypeIdOrSlug: slug,
    fromDateLocal: romeDatePlus(0),
    toDateLocal: romeDatePlus(14),
  });
  if (!result || result.slots.length < count) {
    throw new Error(`servono ${count} slot liberi nei prossimi 14 giorni, trovati ${result?.slots.length ?? 0}`);
  }
  return result.slots.slice(0, count);
}

async function cleanup() {
  // Bookings first (calendar_events by source_id, then rows, then event types).
  const uids = await sql<{ uid: string }[]>`
    SELECT uid FROM calendar_bookings WHERE attendee_email = ${TEST_EMAIL}
  `;
  if (uids.length) {
    await sql`
      DELETE FROM calendar_events
      WHERE source = 'booking' AND source_id IN ${sql(uids.map((r) => r.uid))}
    `;
  }
  await sql`DELETE FROM calendar_bookings WHERE attendee_email = ${TEST_EMAIL}`;
  await sql`DELETE FROM calendar_event_types WHERE slug IN (${TEST_SLUG}, ${TEST_SLUG_APPROVAL})`;
  await sql`DELETE FROM caldav_app_passwords WHERE device_name = 'verify-calendar-smoke'`;
}

async function main() {
  console.log('Calendar smoke verification\n');

  // ---------- Pure checks (no DB) ----------
  console.log('Hardening — validateCustomResponses:');
  const questions = [
    { key: 'budget', label: 'Budget', type: 'select', required: true, options: ['<1k', '1-5k', '>5k'] },
    { key: 'note', label: 'Note', type: 'text', required: false },
  ];
  await check('required mancante -> rifiutato', async () => {
    try { validateCustomResponses(questions as never, {}); } catch (e) {
      if (e instanceof BookingValidationError) return null;
      throw e;
    }
    throw new Error('accettato payload senza required');
  });
  await check('select fuori opzioni -> rifiutato', async () => {
    try { validateCustomResponses(questions as never, { budget: 'tutto' }); } catch (e) {
      if (e instanceof BookingValidationError) return null;
      throw e;
    }
    throw new Error('accettata opzione non valida');
  });
  await check('payload valido -> chiavi sconosciute scartate', async () => {
    const out = validateCustomResponses(questions as never, { budget: '1-5k', extra: 'x' });
    if (out.budget !== '1-5k') throw new Error('risposta persa');
    if ('extra' in out) throw new Error('chiave sconosciuta non scartata');
    return null;
  });

  console.log('\nHardening — assertPublicUrl (SSRF):');
  for (const bad of ['http://127.0.0.1/cal.ics', 'http://169.254.169.254/latest', 'http://10.0.0.5/x', 'http://localhost/feed']) {
    await check(`blocca ${bad}`, async () => {
      try { await assertPublicUrl(bad); } catch { return null; }
      throw new Error('URL privato accettato');
    });
  }
  await check('accetta IP pubblico', async () => {
    await assertPublicUrl('https://93.184.216.34/calendar.ics');
    return null;
  });

  console.log('\nToken HMAC:');
  if (isTokenSecretConfigured()) {
    await check('sign/verify round-trip', async () => {
      const token = signBookingToken('smoketest12ab');
      const payload = verifyBookingToken(token, 'smoketest12ab');
      if (!payload) throw new Error('verifica fallita');
      const tampered = verifyBookingToken(token, 'altro-uid0000');
      if (tampered) throw new Error('uid mismatch accettato');
      return null;
    });
  } else {
    console.log('  SKIP (BOOKING_TOKEN_SECRET/JWT_SECRET non configurati)');
  }

  console.log('\nStatic — nessun tool agent su cal_bookings:');
  await check('tools.ts senza query su cal_bookings', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, '../src/lib/agent/tools.ts'), 'utf8');
    if (/(FROM|INSERT\s+INTO|UPDATE)\s+cal_bookings\b/i.test(src)) {
      throw new Error('query su cal_bookings ancora presente');
    }
    return null;
  });

  // ---------- DB-backed checks ----------
  console.log('\nEvent types:');
  await check('lista pubblica >= 1 attivo', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_event_types WHERE is_active AND is_public`;
    if (r[0].n < 1) throw new Error('nessun event type pubblico attivo');
    return `${r[0].n} attivi`;
  });
  await check('consulenza-gratuita-30min esiste', async () => {
    const et = await getEventType('consulenza-gratuita-30min');
    if (!et) throw new Error('slug seed mancante');
    return null;
  });

  await cleanup(); // remove leftovers from earlier aborted runs
  await seedEventType(TEST_SLUG, { requiresApproval: false });
  await seedEventType(TEST_SLUG_APPROVAL, { requiresApproval: true });

  console.log('\nSlot computation:');
  let slots: Slot[] = [];
  await check('slots 14 giorni, tz Europe/Rome, allineamento 30min', async () => {
    const result = await computeAvailableSlots({
      eventTypeIdOrSlug: TEST_SLUG,
      fromDateLocal: romeDatePlus(0),
      toDateLocal: romeDatePlus(14),
    });
    if (!result) throw new Error('event type non trovato');
    if (result.timezone !== 'Europe/Rome') throw new Error(`timezone=${result.timezone}`);
    if (!result.slots.length) throw new Error('nessuno slot disponibile');
    const now = Date.now();
    for (const s of result.slots) {
      const start = new Date(s.start).getTime();
      if (start < now) throw new Error(`slot nel passato: ${s.start}`);
      if (new Date(s.start).getUTCMinutes() % 30 !== 0) throw new Error(`slot non allineato: ${s.start}`);
    }
    slots = result.slots;
    return `${result.slots.length} slot`;
  });

  console.log('\nCiclo prenotazione (motore live):');
  let bookingUid: string | null = null;
  await check('create -> confirmed + calendar_event linkato', async () => {
    const [slot] = await firstFreeSlots(TEST_SLUG, 1);
    const { booking } = await createBooking({
      event_type_slug: TEST_SLUG,
      start: slot.start,
      attendee: { name: 'Smoke Test', email: TEST_EMAIL },
      source: 'admin_manual',
      source_metadata: { verify_script: true },
    });
    bookingUid = booking.uid;
    if (booking.status !== 'confirmed') throw new Error(`status=${booking.status}`);
    const linked = await getEventBySource('booking', booking.uid);
    if (!linked) throw new Error('calendar_event mancante');
    return `uid=${booking.uid}`;
  });

  await check('doppio create stesso slot -> BookingConflictError', async () => {
    if (!bookingUid) throw new Error('booking precedente mancante');
    const b = await sql<{ start_time: string }[]>`SELECT start_time FROM calendar_bookings WHERE uid = ${bookingUid}`;
    try {
      await createBooking({
        event_type_slug: TEST_SLUG,
        start: new Date(b[0].start_time).toISOString(),
        attendee: { name: 'Smoke Dup', email: TEST_EMAIL },
        source: 'admin_manual',
      });
    } catch (e) {
      if (e instanceof BookingConflictError) return null;
      throw e;
    }
    throw new Error('double-booking accettato');
  });

  let rescheduledUid: string | null = null;
  await check('reschedule -> vecchia cancelled + rescheduled_from_uid', async () => {
    if (!bookingUid) throw new Error('booking precedente mancante');
    const [next] = await firstFreeSlots(TEST_SLUG, 1);
    const { booking } = await rescheduleBooking(bookingUid, next.start, { by: 'admin' });
    rescheduledUid = booking.uid;
    if (booking.rescheduled_from_uid !== bookingUid) throw new Error('link al precedente mancante');
    const old = await sql<{ status: string }[]>`SELECT status FROM calendar_bookings WHERE uid = ${bookingUid}`;
    if (old[0].status !== 'cancelled') throw new Error(`vecchia status=${old[0].status}`);
    const oldEvent = await getEventBySource('booking', bookingUid);
    if (oldEvent && oldEvent.status !== 'cancelled') throw new Error('vecchio evento non cancellato');
    return null;
  });

  await check('cancel -> booking + evento cancellati', async () => {
    if (!rescheduledUid) throw new Error('booking precedente mancante');
    const result = await cancelBooking(rescheduledUid, { cancelled_by: 'admin', reason: 'smoke test' });
    if (!result || result.booking.status !== 'cancelled') throw new Error('cancel fallito');
    const linked = await getEventBySource('booking', rescheduledUid);
    if (linked && linked.status !== 'cancelled') throw new Error('evento non cancellato');
    return null;
  });

  console.log('\nFlusso approvazione:');
  let pendingUid: string | null = null;
  await check('create public su requires_approval -> pending, nessun evento', async () => {
    const [slot] = await firstFreeSlots(TEST_SLUG_APPROVAL, 1);
    const { booking } = await createBooking({
      event_type_slug: TEST_SLUG_APPROVAL,
      start: slot.start,
      attendee: { name: 'Smoke Pending', email: TEST_EMAIL },
      source: 'public_page',
    });
    pendingUid = booking.uid;
    if (booking.status !== 'pending') throw new Error(`status=${booking.status}`);
    const linked = await getEventBySource('booking', booking.uid);
    if (linked) throw new Error('calendar_event creato prima dell\'approvazione');
    return `uid=${booking.uid}`;
  });

  await check('pending blocca lo slot (conflict)', async () => {
    if (!pendingUid) throw new Error('pending mancante');
    const b = await sql<{ start_time: string }[]>`SELECT start_time FROM calendar_bookings WHERE uid = ${pendingUid}`;
    try {
      await createBooking({
        event_type_slug: TEST_SLUG_APPROVAL,
        start: new Date(b[0].start_time).toISOString(),
        attendee: { name: 'Smoke Dup2', email: TEST_EMAIL },
        source: 'public_page',
      });
    } catch (e) {
      if (e instanceof BookingConflictError) return null;
      throw e;
    }
    throw new Error('slot pending prenotabile da altri');
  });

  await check('approve -> confirmed + approved_at + evento creato', async () => {
    if (!pendingUid) throw new Error('pending mancante');
    const result = await approveBooking(pendingUid);
    if (!result || result.booking.status !== 'confirmed') throw new Error('approve fallito');
    if (!result.booking.approved_at) throw new Error('approved_at mancante');
    const linked = await getEventBySource('booking', pendingUid);
    if (!linked) throw new Error('calendar_event mancante dopo approve');
    return null;
  });

  await check('reject su pending -> cancelled con reason', async () => {
    const [slot] = await firstFreeSlots(TEST_SLUG_APPROVAL, 1);
    const { booking } = await createBooking({
      event_type_slug: TEST_SLUG_APPROVAL,
      start: slot.start,
      attendee: { name: 'Smoke Reject', email: TEST_EMAIL },
      source: 'public_page',
    });
    const result = await rejectBooking(booking.uid, 'smoke reject');
    if (!result || result.booking.status !== 'cancelled') throw new Error('reject fallito');
    if (!result.booking.cancellation_reason?.includes('smoke reject')) throw new Error('reason mancante');
    return null;
  });

  await check('admin_manual su requires_approval -> resta confirmed', async () => {
    const [slot] = await firstFreeSlots(TEST_SLUG_APPROVAL, 1);
    const { booking } = await createBooking({
      event_type_slug: TEST_SLUG_APPROVAL,
      start: slot.start,
      attendee: { name: 'Smoke Admin', email: TEST_EMAIL },
      source: 'admin_manual',
    });
    if (booking.status !== 'confirmed') throw new Error(`status=${booking.status}`);
    return null;
  });

  console.log('\nICS:');
  await check('buildIcs: VEVENT, UID, DTSTART UTC, no VTIMEZONE', async () => {
    if (!pendingUid) throw new Error('booking mancante');
    const rows = await sql`SELECT * FROM calendar_bookings WHERE uid = ${pendingUid}`;
    const et = await getEventType(TEST_SLUG_APPROVAL);
    const ics = buildIcs({
      booking: rows[0] as never,
      eventType: et!,
      organizerName: 'Smoke Test',
      organizerEmail: 'smoke@test.invalid',
    });
    if (!ics.includes('BEGIN:VEVENT')) throw new Error('VEVENT mancante');
    if (!ics.includes(`UID:`)) throw new Error('UID mancante');
    if (!/DTSTART:\d{8}T\d{6}Z/.test(ics)) throw new Error('DTSTART non UTC');
    if (ics.includes('BEGIN:VTIMEZONE')) throw new Error('VTIMEZONE morto ancora presente');
    return null;
  });
  await check('buildIcsFeed produce un feed valido', async () => {
    const cal = await getDefaultCalendar();
    if (!cal) throw new Error('calendario default mancante');
    const feed = buildIcsFeed({ calendar: cal, events: [] });
    if (!feed.includes('BEGIN:VCALENDAR') || !feed.includes('END:VCALENDAR')) throw new Error('feed non valido');
    if (feed.includes('BEGIN:VTIMEZONE')) throw new Error('VTIMEZONE morto ancora presente nel feed');
    return null;
  });

  console.log('\nCalDAV app-password:');
  await check('create/verify/revoke round-trip', async () => {
    const { password, row } = await createAppPassword({
      username: 'verify-smoke',
      deviceName: 'verify-calendar-smoke',
      createdBy: null,
    });
    const ok = await verifyCredentials('verify-smoke', password);
    if (!ok.ok) throw new Error('verifica credenziali fallita');
    const wrong = await verifyCredentials('verify-smoke', 'password-sbagliata');
    if (wrong.ok) throw new Error('password errata accettata');
    const revoked = await revokeAppPassword(row.id);
    if (!revoked) throw new Error('revoca fallita');
    const afterRevoke = await verifyCredentials('verify-smoke', password);
    if (afterRevoke.ok) throw new Error('password revocata ancora valida');
    return null;
  });

  console.log('\nIgiene dati:');
  await check("0 bookings con status='rescheduled'", async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_bookings WHERE status = 'rescheduled'`;
    if (r[0].n > 0) throw new Error(`${r[0].n} righe legacy`);
    return null;
  });
  await check('nessun booking con end <= start', async () => {
    const r = await sql`SELECT COUNT(*)::int AS n FROM calendar_bookings WHERE end_time <= start_time`;
    if (r[0].n > 0) throw new Error(`${r[0].n} righe incoerenti`);
    return null;
  });
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nERROR:', pgErrorSummary(err));
  })
  .finally(async () => {
    try {
      await cleanup();
      console.log('\nCleanup completato');
    } catch (err) {
      console.error('Cleanup FALLITO:', pgErrorSummary(err));
      failures += 1;
    }
    await sql.end({ timeout: 2 }).catch(() => undefined);
    if (failures > 0) {
      console.error(`\nSmoke verification failed with ${failures} issue(s).`);
      process.exit(1);
    }
    console.log('\nSmoke verification completed');
    process.exit(0);
  });
