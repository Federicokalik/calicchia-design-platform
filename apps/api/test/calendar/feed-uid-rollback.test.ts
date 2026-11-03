/**
 * UID del feed ICS prima e dopo un rollback (contratto F4 §13.5, "formula
 * legacy"), sul database senza Radicale: gli oggetti nati nella finestra di
 * rollback non hanno `legacy_uid`, ma il feed legacy dopo il rollback
 * pubblica `${calendar_events.uid}@dominio` della riga che la proiezione
 * inversa ha scritto. Il feed dell'indice deve quindi pubblicare quell'UID
 * fin dall'inizio, per i tre casi che la prova generale aveva trovato diversi:
 *  - prenotazione presa nella finestra (risorsa booking-<uid>.ics con UID
 *    `<uid>@caldes.it`);
 *  - oggetto di un device con UID che contiene '@';
 *  - UID già usato da un'altra riga (SANITIZED_UID: `<UID>@<collezione>`).
 *
 * Per ognuno lo stesso UID compare nel feed dell'indice prima della
 * proiezione (UID calcolato dal feed), dopo la proiezione (UID della riga),
 * nel feed legacy dopo il ritorno a postgres e, dopo la ri-baseline del
 * rollback (legacy_uid = UID della riga), in un nuovo feed dall'indice.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { buildBookingProjectionIcs } from '../../src/lib/calendar/booking-projection';
import { getCalendar } from '../../src/lib/calendar/calendars';
import { buildCalendarFeed } from '../../src/lib/calendar/events';
import { buildIndexFeed, clearIndexFeedCache } from '../../src/lib/calendar/feed-builder';
import { stopCalendarJobWorker, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { REVERSE_PROJECTION_JOB_KIND, runReverseProjection } from '../../src/lib/calendar/migration/reverse-projector';
import { applyCollectionChanges, loadCollectionContext, stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar } from '../../src/lib/calendar/types';
import { icsEvents, icsProp } from '../contracts/_http-contract';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';

const fx = useFixtures('feeduid', { resetBaseline: true });

/** Dominio degli UID dei test (host di PUBLIC_API_URL, helpers/env.ts). */
const UID_DOMAIN = 'api.caldes.test';
/** Domenica 10 gennaio 2027: gli eventi di 2027-01-12 e seguenti cadono nella finestra del feed. */
const FEED_NOW = new Date('2027-01-10T10:00:00Z');
/** Orizzonte dei change set: copre le date dei test. */
const H = Object.freeze({ start: new Date('2026-06-01T00:00:00Z'), end: new Date('2028-06-01T00:00:00Z') });
const VOLUME = '7a2c4e6f-8b1d-4c3e-9f50-a1b2c3d4e5f6';

onBeforeDatabaseClose(async () => {
  unregisterCalendarJobHandler(REVERSE_PROJECTION_JOB_KIND);
  await stopCalendarJobWorker();
  await stopIndexWorker();
  await sql`DELETE FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND}`;
  overrideCalendarStore(null);
  clearIndexFeedCache();
  await resetCalendarBaseline();
});

afterEach(async () => {
  unregisterCalendarJobHandler(REVERSE_PROJECTION_JOB_KIND);
  await sql`DELETE FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND}`;
  await setPostgres();
});

async function setRadicale(): Promise<void> {
  await sql`
    UPDATE calendar_backend_state
    SET mode = 'radicale', write_freeze = false, volume_id = ${VOLUME}::uuid, epoch = 2,
        rollback_until = ${new Date(Date.now() + 30 * 86_400_000)}, cutover_at = now() - interval '1 hour', cutover_by = 'admin:test-feed-uid'
    WHERE id
  `;
  invalidateBackendModeCache();
}

async function setPostgres(): Promise<void> {
  await sql`
    UPDATE calendar_backend_state
    SET mode = 'postgres', write_freeze = false, rollback_until = NULL, cutover_at = NULL, cutover_by = NULL
    WHERE id
  `;
  invalidateBackendModeCache();
}

function ics(...lines: string[]): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Feed UID//IT',
    'BEGIN:VEVENT', 'DTSTAMP:20261201T000000Z', ...lines, 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
}

let etagSeq = 0;

async function indexItems(calendarId: string, items: Array<{ href: string; raw: string }>, full = false): Promise<void> {
  const context = await loadCollectionContext(sql, calendarId);
  await applyCollectionChanges(
    {
      context,
      upserts: items.map((i) => ({ href: i.href, etag: `"uid-${++etagSeq}"`, raw: i.raw })),
      deletes: [],
      radicaleSkipped: [],
      pending404: [],
      full,
      horizon: { ...H },
      actor: 'test',
    },
    { syncedAt: new Date() },
  );
}

/** UID pubblicati da un feed, ordinati. */
const feedUids = (body: string): string[] => icsEvents(body).map((e) => icsProp(e, 'UID') ?? '').sort();

async function indexFeedUids(calendar: Calendar): Promise<string[]> {
  clearIndexFeedCache();
  return feedUids((await buildIndexFeed(sql, calendar, { now: FEED_NOW, uidDomain: UID_DOMAIN })).body);
}

describe('UID del feed prima e dopo un rollback', () => {
  test('prenotazione della finestra, UID del device con @ e UID sanificato restano gli stessi', async () => {
    const lavoro = await fx.calendar({ key: 'lavoro', blocks_availability: true });
    const device = await fx.calendar({ key: 'device', blocks_availability: true });
    const [bookingsRow] = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM calendars WHERE role = 'bookings' ORDER BY created_at LIMIT 1`;
    const bookings = await getCalendar(bookingsRow.id);
    assert.ok(bookings, 'calendario Prenotazioni del baseline');

    // Prima del cutover: una riunione dell'admin (UID della riga legacy) e una prenotazione senza proiezione legacy.
    const meeting = await fx.event({ calendar: lavoro, summary: 'Riunione', start_time: '2027-01-12T09:00:00.000Z', end_time: '2027-01-12T10:00:00.000Z' });
    const eventType = await fx.eventType({ key: 'consulenza', title: 'Consulenza', durationMinutes: 30 });
    const { booking } = await fx.booking({ eventType, start: '2027-01-13T10:00:00Z', project: false, attendee: { name: 'Anna Neri' } });

    // Finestra di rollback (mode radicale): le risorse sono nate in Radicale, senza legacy_uid.
    await setRadicale();
    const withAt = `finestra-${booking.uid}@iphone.test`;
    for (const cal of [lavoro, device, bookings]) await indexItems(cal.id, [], true);
    await indexItems(device.id, [
      { href: 'chiocciola.ics', raw: ics(`UID:${withAt}`, 'DTSTART:20270114T090000Z', 'DTEND:20270114T100000Z', 'SUMMARY:UID con chiocciola') },
      // L'iPhone duplica l'UID della riunione: la proiezione inversa lo sanifica con il nome della collezione.
      { href: 'duplicato.ics', raw: ics(`UID:${meeting.uid}`, 'DTSTART:20270115T140000Z', 'DTEND:20270115T150000Z', 'SUMMARY:Invito duplicato') },
    ]);
    await indexItems(bookings.id, [{
      href: `booking-${booking.uid}.ics`,
      raw: buildBookingProjectionIcs({ booking, eventTitle: 'Consulenza', meetingUrl: null, now: FEED_NOW }),
    }]);

    const expected = {
      booking: [`${booking.uid}@caldes.it@${UID_DOMAIN}`],
      device: [`${withAt}@${UID_DOMAIN}`, `${meeting.uid}@${device.slug}@${UID_DOMAIN}`].sort(),
    };
    const [deviceName] = await sql<Array<{ collection_name: string }>>`SELECT collection_name FROM calendars WHERE id = ${device.id}::uuid`;
    assert.equal(deviceName.collection_name, device.slug, 'collection_name del calendario di prova');

    // 1. Prima della proiezione inversa: l'UID lo calcola il feed con la stessa regola.
    assert.deepEqual(await indexFeedUids(bookings), expected.booking, 'prenotazione: UID <uid>@caldes.it con il dominio');
    assert.deepEqual(await indexFeedUids(device), expected.device, 'device: UID con @ e UID sanificato con il dominio');

    // 2. Dopo la proiezione inversa: l'UID è quello della riga scritta in PG.
    const summary = await runReverseProjection({ actor: 'admin:test-feed-uid', calendarIds: [lavoro.id, device.id, bookings.id] });
    assert.equal(summary.failed, 0);
    const rows = await sql<Array<{ uid: string; calendar_id: string }>>`
      SELECT uid, calendar_id::text AS calendar_id FROM calendar_events
      WHERE caldes_object_id IS NOT NULL AND calendar_id IN (${device.id}::uuid, ${bookings.id}::uuid)
    `;
    assert.deepEqual(rows.map((r) => `${r.uid}@${UID_DOMAIN}`).sort(), [...expected.booking, ...expected.device].sort(), 'righe proiettate');
    assert.deepEqual(await indexFeedUids(bookings), expected.booking);
    assert.deepEqual(await indexFeedUids(device), expected.device);

    // 3. Dopo il rollback il feed legacy pubblica `${uid della riga}@dominio`: gli stessi UID.
    await setPostgres();
    const legacy = async (calendar: Calendar): Promise<string[]> => feedUids((await buildCalendarFeed(calendar, { now: FEED_NOW, uidDomain: UID_DOMAIN })).body);
    assert.deepEqual(await legacy(bookings), expected.booking, 'feed legacy dopo il rollback: prenotazione');
    assert.deepEqual(await legacy(device), expected.device, 'feed legacy dopo il rollback: device');

    // 4. Nuovo cutover: la ri-baseline ha registrato legacy_uid = UID della riga, il feed dell'indice resta uguale.
    await sql`
      UPDATE cal_object_ids ids SET legacy_uid = ev.uid, legacy_event_id = ev.id
      FROM calendar_events ev WHERE ev.caldes_object_id = ids.id AND ids.recurrence_key = ''
    `;
    await setRadicale();
    assert.deepEqual(await indexFeedUids(bookings), expected.booking, 'secondo cutover: prenotazione');
    assert.deepEqual(await indexFeedUids(device), expected.device, 'secondo cutover: device');
  });
});
