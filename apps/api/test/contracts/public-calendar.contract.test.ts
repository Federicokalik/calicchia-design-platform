/**
 * Contratto pubblico del calendario (F0, design §12 e §15): le route che il
 * sito usa per prenotare (apps/sito-v3/src/lib/booking-api.ts) e lo slot
 * picker del form contatti.
 *
 *  - GET  /api/calendar/event-types, /event-types/:slug, /event-types/:slug/slots
 *  - POST /api/calendar/bookings                       200, 400, 403, 404, 409
 *  - GET  /api/calendar/bookings/:uid?token            dettaglio self-service
 *  - POST /api/calendar/bookings/:uid/cancel|reschedule
 *  - GET  /api/calendar/bookings/:uid/ics
 *  - GET  /api/contacts/cal-slots?date                 form contatti (200, 400, 503)
 *
 * Gli snapshot (__snapshots__/public-calendar.contract.json) registrano per
 * ogni caso richiesta, status, header e corpo normalizzati, più gli effetti sul
 * database delle scritture. In F2 gli stessi casi girano su RadicaleStore: cambia
 * solo la sorgente del busy (design §12), quindi ogni differenza è una
 * regressione salvo le voci motivate di allowed-diffs.json.
 *
 * Scenario (date fisse nel 2027, "adesso" fermo a venerdì 5 marzo 08:00 Roma):
 *  - settimana 8-14 marzo: eventi bloccanti e no, tentative e cancellati,
 *    serie con EXDATE e override (cancellato e spostato), all-day,
 *    iscrizione ICS in un calendario bloccante, prenotazioni (confermata con
 *    buffer, pending, cancellata) e una chiusura nel calendario 'f';
 *  - 28-31 marzo: cambio dell'ora, Pasquetta nel calendario 'f' e uno
 *    schedule con override di data;
 *  - dal 12 aprile: le scritture (POST, cancel, reschedule), un giorno o un
 *    orario per test, così nessun test toglie slot a un altro;
 *  - 27 aprile: un tipo con buffer asimmetrici (15 prima, 45 dopo) e una sua
 *    prenotazione, per il verso dei buffer negli slot e nelle POST.
 *
 * Captcha: con NODE_ENV=test e nessun provider configurato la verifica è
 * saltata come in sviluppo (lib/turnstile.ts); il 403 si ottiene con
 * NODE_ENV=production (withEnv), dove un provider non configurato rifiuta.
 *
 * Comportamenti attuali congelati qui e da correggere dopo F0, ciascuno
 * commentato nel caso relativo (design §14):
 *  - la riprogrammazione su uno slot sovrapposto all'originale viene rifiutata
 *    (409): computeAvailableSlots legge fuori dalla transazione e vede ancora
 *    la prenotazione originale e la sua proiezione;
 *  - la proiezione della prenotazione riprogrammata ha url null (meetingUrl
 *    non ricalcolato);
 *  - gli eventi delle iscrizioni ICS bloccano gli slot se il calendario di
 *    destinazione blocca (decisione 5: dal passaggio a Radicale servirà anche
 *    il flag dell'iscrizione).
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { withEnv } from '../helpers/env';
import { onDatabaseReady, sql } from '../helpers/db';
import {
  api,
  bookingManagePath,
  bookingManageToken,
  bookingManageTokenWithSecret,
  expiredBookingManageToken,
  type TestResponse,
} from '../helpers/http';
import { OFFICE_HOURS, romeIso, useFixtures } from '../helpers/fixtures';
import { isRadicaleBackend, useCalendarBackend } from '../helpers/calendar-backend';
import { storeProjectionRows } from '../helpers/calendar-rows';
import { createNormalizer, type SnapshotNormalizer } from '../helpers/normalize';
import { freezeTime, restoreTime } from '../helpers/clock';
import type { Calendar, EventType } from '../../src/lib/calendar/types';
import {
  contractCoverageTest,
  type HttpContractRequest,
  httpContractStore,
  icsEvents,
  icsProp,
  responseEntry,
  type ResponseEntryOptions,
  romeHour,
  romeHoursByDate,
} from './_http-contract';

const fx = useFixtures('contratto-sito', { resetBaseline: true });
useCalendarBackend();

const store = httpContractStore(
  'public-calendar',
  'public-calendar.contract.test.ts',
  'API pubblica del calendario (/api/calendar/* e /api/contacts/cal-slots) sullo scenario di ' +
    'test/contracts/public-calendar.contract.test.ts: richiesta, status, header e corpo normalizzati ' +
    '(id, uid, token, timestamp di sistema, prefisso dei dati), con gli effetti sul database delle scritture. ' +
    'Baseline F0 su PgLegacyStore.',
);

/** "Adesso": venerdì 5 marzo 2027, 08:00 a Roma (prima di tutte le date dello scenario). */
const NOW = '2027-03-05T07:00:00.000Z';

/** Slug del tipo usato da /api/contacts/cal-slots (CONTACT_FORM_EVENT_TYPE, seme della migrazione 067). */
const CONTACT_FORM_EVENT_TYPE = 'consulenza-gratuita-30min';

/** Chiavi della forma pubblica di un tipo di prenotazione (publicEventType in routes/calendar/public.ts). */
const PUBLIC_EVENT_TYPE_KEYS = [
  'id', 'slug', 'title', 'description', 'duration_minutes', 'location_type', 'location_value',
  'color', 'custom_questions', 'min_notice_hours', 'max_advance_days',
];

interface Scenario {
  holidays: Calendar;
  blocking: Calendar;
  free: Calendar;
  external: Calendar;
  types: {
    main: EventType;
    approval: EventType;
    inPerson: EventType;
    custom: EventType;
    notice: EventType;
    advance: EventType;
    hidden: EventType;
    inactive: EventType;
    asymmetric: EventType;
  };
}

let s: Scenario;

// ─── Scenario ───────────────────────────────

async function buildScenario(): Promise<Scenario> {
  const holidays = await fx.holidayCalendar();
  const blocking = await fx.calendar({ key: 'bloccante', name: 'Impegni', blocks_availability: true });
  const free = await fx.calendar({ key: 'libero', name: 'Promemoria', blocks_availability: false });
  const external = await fx.calendar({ key: 'esterno', name: 'Google esterno', blocks_availability: true });

  const customSchedule = await fx.schedule({
    name: 'orari speciali',
    slots: OFFICE_HOURS,
    overrides: [
      { date: '2027-03-30', unavailable: true, note: 'Ferie' },
      { date: '2027-03-31', start: '15:00', end: '17:00', note: 'Solo pomeriggio' },
    ],
  });

  const types: Scenario['types'] = {
    // Schedule di default (lun-ven 09-13 e 14-18), buffer 30/30, incremento 30.
    main: await fx.eventType({
      key: 'consulenza', title: 'Consulenza di prova', description: 'Videochiamata conoscitiva.',
      durationMinutes: 60, bufferBeforeMinutes: 30, bufferAfterMinutes: 30, slotIncrementMinutes: 30, sortOrder: 1,
    }),
    approval: await fx.eventType({
      key: 'approvazione', title: 'Su approvazione', durationMinutes: 60, slotIncrementMinutes: 60,
      requiresApproval: true, locationType: 'phone', locationValue: null, sortOrder: 2,
    }),
    inPerson: await fx.eventType({
      key: 'sopralluogo', title: 'Sopralluogo di prova', description: 'Incontro presso la sede del cliente.',
      durationMinutes: 60, slotIncrementMinutes: 60, locationType: 'in_person', locationValue: 'Via del Corso 1, Roma',
      color: '#0ea5e9', sortOrder: 3,
      customQuestions: [
        { key: 'azienda', label: 'Nome azienda', type: 'text', required: true },
        { key: 'budget', label: 'Budget', type: 'select', options: ['fino a 1.000 €', 'oltre 1.000 €'], required: false },
      ],
    }),
    custom: await fx.eventType({
      key: 'orari-speciali', title: 'Orari speciali', durationMinutes: 60, slotIncrementMinutes: 60,
      schedule: customSchedule, sortOrder: 4,
    }),
    // Stesso sort_order: l'ordine secondario è il titolo ("Anticipo..." prima di "Preavviso...").
    notice: await fx.eventType({
      key: 'preavviso', title: 'Preavviso lungo', durationMinutes: 60, slotIncrementMinutes: 60,
      minNoticeHours: 98, sortOrder: 5,
    }),
    advance: await fx.eventType({
      key: 'anticipo', title: 'Anticipo breve', durationMinutes: 60, slotIncrementMinutes: 60,
      maxAdvanceDays: 4, sortOrder: 5,
    }),
    hidden: await fx.eventType({ key: 'riservato', title: 'Riservato', isPublic: false }),
    inactive: await fx.eventType({ key: 'disattivato', title: 'Disattivato', isActive: false }),
    // Buffer diversi prima e dopo: con buffer simmetrici un'inversione dei due
    // in slots.ts non si vedrebbe.
    asymmetric: await fx.eventType({
      key: 'buffer-asimmetrici', title: 'Buffer asimmetrici', durationMinutes: 30, slotIncrementMinutes: 15,
      bufferBeforeMinutes: 15, bufferAfterMinutes: 45, sortOrder: 6,
    }),
  };

  // Lunedì 8: evento bloccante 10:00-11:30; nel calendario non bloccante,
  // tentative e cancellato nessun effetto.
  await fx.event({ calendar: blocking, summary: 'Riunione cliente', start_time: romeIso('2027-03-08', '10:00'), end_time: romeIso('2027-03-08', '11:30') });
  await fx.event({ calendar: free, summary: 'Pranzo', start_time: romeIso('2027-03-08', '12:00'), end_time: romeIso('2027-03-08', '13:00') });
  await fx.event({ calendar: blocking, summary: 'Da confermare', status: 'tentative', start_time: romeIso('2027-03-08', '14:00'), end_time: romeIso('2027-03-08', '15:00') });
  await fx.event({ calendar: blocking, summary: 'Annullato', status: 'cancelled', start_time: romeIso('2027-03-08', '15:00'), end_time: romeIso('2027-03-08', '16:00') });
  // Serie 17:00-18:00 lun-ven: martedì escluso con EXDATE, mercoledì
  // cancellato con override, venerdì spostato alle 15:00.
  await fx.series({
    calendar: blocking,
    summary: 'Riunione serale',
    start_time: romeIso('2027-03-08', '17:00'),
    end_time: romeIso('2027-03-08', '18:00'),
    rrule: 'FREQ=DAILY;COUNT=5',
    exdates: [romeIso('2027-03-09', '17:00')],
    overrides: [
      { originalStart: romeIso('2027-03-10', '17:00'), status: 'cancelled' },
      { originalStart: romeIso('2027-03-12', '17:00'), start: romeIso('2027-03-12', '15:00'), end: romeIso('2027-03-12', '16:00') },
    ],
  });

  // Martedì 9: all-day (non blocca) e iscrizione ICS in un calendario
  // bloccante, con un evento timed 09:00-10:00 (blocca) e un all-day UTC.
  await fx.allDayEvent({ calendar: blocking, summary: 'Trasferta', date: '2027-03-09' });
  await fx.subscription({
    calendar: external,
    events: [
      {
        remote_uid: 'evento-esterno@example.test', summary: 'Call dal calendario esterno',
        description: null, location: null, url: null,
        start_time: romeIso('2027-03-09', '09:00'), end_time: romeIso('2027-03-09', '10:00'),
        all_day: false, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed',
      },
      {
        remote_uid: 'giornata-esterna@example.test', summary: 'Giornata esterna',
        description: null, location: null, url: null,
        start_time: '2027-03-09T00:00:00.000Z', end_time: '2027-03-10T00:00:00.000Z',
        all_day: true, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed',
      },
    ],
  });

  // Mercoledì 10: prenotazione confermata 11:00-12:00 (con i buffer 30/30 del
  // tipo richiesto blocca 10:30-12:30), proiettata nel calendario 'bookings'.
  await fx.booking({ eventType: types.main, start: romeIso('2027-03-10', '11:00') });
  // Giovedì 11: chiusura di un giorno nel calendario 'f'.
  await fx.closure(holidays, { from: '2027-03-11', summary: 'Ponte' });
  // Venerdì 12: pending 09:00-10:00 (blocca, con buffer) e cancellata 14:00 (no).
  await fx.booking({ eventType: types.approval, start: romeIso('2027-03-12', '09:00'), status: 'pending' });
  await fx.booking({ eventType: types.main, start: romeIso('2027-03-12', '14:00'), status: 'cancelled' });

  // Lunedì 29 marzo: Pasquetta nel calendario 'f', come la crea il cron.
  await fx.holidays(holidays, { year: 2027, only: ['2027-03-29'] });

  // Martedì 27 aprile: prenotazione 11:00-11:30 del tipo con buffer
  // asimmetrici, in una settimana senza altre prenotazioni.
  await fx.booking({ eventType: types.asymmetric, start: romeIso('2027-04-27', '11:00'), attendee: { name: 'Prenotazione con buffer' } });

  return { holidays, blocking, free, external, types };
}

// Lo scenario si costruisce con onDatabaseReady e non con un before() di primo
// livello: su Node 22 i before() di primo livello partono in parallelo, e lo
// scenario finirebbe in gara con migrazioni, baseline e pre-pulizia.
onDatabaseReady(async () => {
  freezeTime(NOW);
  s = await buildScenario();
});

after(() => {
  restoreTime();
  store.flush();
});

// ─── Utilità ───────────────────────────────

/** Normalizzatore del caso: prefisso dei dati e alias leggibili dei tipi di prenotazione. */
function normalizer(): SnapshotNormalizer {
  const n = createNormalizer({ prefixes: [fx.prefix] });
  for (const [key, et] of Object.entries(s.types)) n.alias(et.id, `event-type:${key}`);
  return n;
}

/** Registra il caso nello snapshot del contratto. */
function record(
  caseId: string,
  res: TestResponse,
  n: SnapshotNormalizer,
  request: HttpContractRequest,
  opts: Omit<ResponseEntryOptions, 'request'> = {},
): void {
  store.check(caseId, responseEntry(res, n, { request, ...opts }));
}

/** GET degli slot con il percorso pubblico. */
function getSlots(slug: string, query: Record<string, string | undefined>): Promise<TestResponse> {
  return api.get(`/api/calendar/event-types/${slug}/slots`, { query });
}

/** Corpo di POST /bookings come lo invia il sito. */
function bookingBody(eventType: EventType, start: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_type_slug: eventType.slug,
    start,
    attendee: {
      name: 'Cliente dal sito',
      email: fx.email('sito'),
      phone: '+39 351 000 0000',
      company: 'Officina Rossi',
      timezone: 'Europe/Rome',
      message: 'Vorrei parlare del nuovo sito.',
    },
    gdpr_consent: true,
    turnstile_token: 'token-captcha-di-prova',
    source_page: '/prenota/consulenza',
    ...extra,
  };
}

/**
 * Stato delle proiezioni di una prenotazione annullata: con lo store legacy la
 * riga resta con status 'cancelled'; con lo store Radicale la risorsa
 * booking-<uid>.ics viene tolta (design §9, stato desiderato "assente").
 */
const CANCELLED_PROJECTION_STATUSES: string[] = isRadicaleBackend() ? [] : ['cancelled'];

/** Colonne delle proiezioni registrate negli effetti. */
const PROJECTION_COLUMNS = ['calendar', 'summary', 'description', 'location', 'url', 'start_time', 'end_time', 'all_day', 'source', 'status'] as const;

/** Stato di una prenotazione nel database: riga, proiezioni nel calendario 'bookings' e lead. */
async function bookingState(uid: string): Promise<Record<string, unknown>> {
  const [booking] = await sql`
    SELECT uid, status, source, attendee_name, attendee_email, attendee_phone, attendee_company,
           attendee_timezone, attendee_message, custom_responses, start_time, end_time,
           location_type, location_value, cancelled_by, cancellation_reason, cancelled_at,
           rescheduled_from_uid, source_metadata,
           (lead_id IS NOT NULL) AS has_lead,
           (consent_ip IS NOT NULL) AS has_consent_ip
    FROM calendar_bookings WHERE uid = ${uid}
  `;
  // Store Radicale: la risorsa booking-<uid>.ics letta dalla facade (helpers/calendar-rows.ts).
  const projections = isRadicaleBackend()
    ? await storeProjectionRows([uid], PROJECTION_COLUMNS)
    : await sql`
      SELECT c.slug AS calendar, e.summary, e.description, e.location, e.url,
             e.start_time, e.end_time, e.all_day, e.source, e.status
      FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
      WHERE e.source = 'booking' AND e.source_id = ${uid}
      ORDER BY e.created_at
    `;
  const leads = await sql`
    SELECT name, email, phone, company, source, status, notes
    FROM leads WHERE source_id = ${uid}
  `;
  return { booking: booking ?? null, projections: [...projections], leads: [...leads] };
}

// ─── Tipi di prenotazione ───────────────────────────────

test('event-types: tipi pubblici e attivi, forma pubblica, ordine per sort_order e titolo', async () => {
  const res = await api.get('/api/calendar/event-types');
  assert.equal(res.status, 200);
  const all: Array<Record<string, unknown>> = res.json.event_types;
  const mine = all.filter((et) => String(et.slug).startsWith(`${fx.prefix}-`));

  assert.deepEqual(mine.map((et) => et.slug), [
    s.types.main.slug, s.types.approval.slug, s.types.inPerson.slug, s.types.custom.slug,
    s.types.advance.slug, s.types.notice.slug, s.types.asymmetric.slug,
  ], 'esclusi i non pubblici e gli inattivi; ordine sort_order, poi titolo');
  for (const et of all) assert.deepEqual(Object.keys(et), PUBLIC_EVENT_TYPE_KEYS);
  // L'indirizzo esce solo per in_person; l'URL della riunione resta privato.
  assert.equal(mine.find((et) => et.slug === s.types.inPerson.slug)?.location_value, 'Via del Corso 1, Roma');
  assert.equal(mine.find((et) => et.slug === s.types.main.slug)?.location_value, null);
  // I tipi seminati dalla migrazione 067 restano nella lista (non nello snapshot).
  assert.ok(all.some((et) => et.slug === CONTACT_FORM_EVENT_TYPE), `${CONTACT_FORM_EVENT_TYPE} assente`);

  record('event-types/lista', res, normalizer(), { method: 'GET', path: '/api/calendar/event-types' }, {
    select: (json) => ({ event_types: json.event_types.filter((et: { slug: string }) => et.slug.startsWith(`${fx.prefix}-`)) }),
  });
});

test('event-types/:slug: dettaglio pubblico; 404 per inesistente, non pubblico e inattivo', async () => {
  const n = normalizer();
  const detail = await api.get(`/api/calendar/event-types/${s.types.inPerson.slug}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(Object.keys(detail.json.event_type), PUBLIC_EVENT_TYPE_KEYS);
  record('event-types/dettaglio', detail, n, { method: 'GET', path: `/api/calendar/event-types/${s.types.inPerson.slug}` });

  for (const [name, slug] of [
    ['inesistente', fx.slug('inesistente')],
    ['non-pubblico', s.types.hidden.slug],
    ['inattivo', s.types.inactive.slug],
  ] as const) {
    const res = await api.get(`/api/calendar/event-types/${slug}`);
    assert.equal(res.status, 404, name);
    assert.deepEqual(res.json, { error: 'Tipologia di prenotazione non trovata' });
    record(`event-types/dettaglio-404-${name}`, res, normalizer(), { method: 'GET', path: `/api/calendar/event-types/${slug}` });
  }
});

// ─── Slot ───────────────────────────────

test('slots: validazione dei parametri (400) e tipo inesistente, non pubblico o inattivo (404)', async () => {
  const slug = s.types.main.slug;
  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    ['from-mancante', { to: '2027-03-12' }, 'Parametro from richiesto (YYYY-MM-DD)'],
    ['from-non-valido', { from: '8/3/2027', to: '2027-03-12' }, 'Parametro from richiesto (YYYY-MM-DD)'],
    ['to-mancante', { from: '2027-03-08' }, 'Parametro to richiesto (YYYY-MM-DD)'],
    ['range-oltre-60-giorni', { from: '2027-03-08', to: '2027-05-08' }, 'Range massimo 60 giorni'],
    ['to-prima-di-from', { from: '2027-03-12', to: '2027-03-08' }, 'to deve essere >= from'],
  ];
  for (const [name, query, error] of cases) {
    const res = await getSlots(slug, query);
    assert.equal(res.status, 400, name);
    assert.deepEqual(res.json, { error }, name);
    record(`slots/400-${name}`, res, normalizer(), { method: 'GET', path: `/api/calendar/event-types/${slug}/slots`, query });
  }

  // 60 giorni esatti sono ammessi.
  const edge = await getSlots(slug, { from: '2027-03-08', to: '2027-05-07' });
  assert.equal(edge.status, 200);
  assert.equal(Object.keys(edge.json.slots_by_date).length, 61);

  for (const [name, target] of [
    ['inesistente', fx.slug('inesistente')],
    ['non-pubblico', s.types.hidden.slug],
    ['inattivo', s.types.inactive.slug],
  ] as const) {
    const query = { from: '2027-03-08', to: '2027-03-12' };
    const res = await getSlots(target, query);
    assert.equal(res.status, 404, name);
    assert.deepEqual(res.json, { error: 'Tipologia di prenotazione non trovata' });
    record(`slots/404-${name}`, res, normalizer(), { method: 'GET', path: `/api/calendar/event-types/${target}/slots`, query });
  }
});

test('slots: settimana con eventi bloccanti, serie, iscrizione, prenotazioni con buffer e chiusura', async () => {
  const query = { from: '2027-03-08', to: '2027-03-14' };
  const res = await getSlots(s.types.main.slug, query);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.json), ['timezone', 'duration_minutes', 'slots_by_date', 'slots']);
  assert.equal(res.json.timezone, 'Europe/Rome');
  assert.equal(res.json.duration_minutes, 60);

  assert.deepEqual(romeHoursByDate(res.json.slots_by_date), {
    // 10:00-11:30 bloccante e serie alle 17; pranzo (non bloccante),
    // tentative e cancellato non tolgono nulla.
    '2027-03-08': ['09:00', '11:30', '12:00', '14:00', '14:30', '15:00', '15:30', '16:00'],
    // Iscrizione 09:00-10:00 nel calendario bloccante: blocca. All-day (anche
    // quello dell'iscrizione) no; la serie è esclusa con EXDATE.
    '2027-03-09': ['10:00', '10:30', '11:00', '11:30', '12:00', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'],
    // Prenotazione 11:00-12:00 con buffer 30/30 → occupato 10:30-12:30;
    // occorrenza delle 17 cancellata con override → libera.
    '2027-03-10': ['09:00', '09:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'],
    // Chiusura nel calendario 'f'.
    '2027-03-11': [],
    // Pending 09:00-10:00 con buffer → libero dalle 10:30; la cancellata delle
    // 14 non blocca; override della serie spostato alle 15:00.
    '2027-03-12': ['10:30', '11:00', '11:30', '12:00', '14:00', '16:00', '16:30', '17:00'],
    // Fine settimana: date presenti con elenco vuoto.
    '2027-03-13': [],
    '2027-03-14': [],
  });
  // `slots` è l'elenco piatto, ordinato, degli stessi slot.
  assert.deepEqual(res.json.slots, Object.values(res.json.slots_by_date).flat());

  // Il parametro `tz` è accettato ma ignorato: le date sono quelle dello schedule.
  const withTz = await getSlots(s.types.main.slug, { ...query, tz: 'America/New_York' });
  assert.deepEqual(withTz.json, res.json);

  record('slots/settimana-scenario', res, normalizer(), {
    method: 'GET', path: `/api/calendar/event-types/${s.types.main.slug}/slots`, query,
  });
});

test('slots: un intervallo senza finestre di disponibilità restituisce slots_by_date vuoto, senza le date', async () => {
  // Comportamento attuale (computeAvailableSlots): se nell'intervallo non c'è
  // nessuna finestra dello schedule (qui sabato e domenica) la risposta esce
  // prima del raggruppamento e slots_by_date è {}; con almeno una finestra,
  // invece, compaiono tutte le date, anche quelle vuote (caso precedente).
  // Il sito tratta le date assenti come giorni senza slot.
  const query = { from: '2027-03-13', to: '2027-03-14' };
  const res = await getSlots(s.types.main.slug, query);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { timezone: 'Europe/Rome', duration_minutes: 60, slots_by_date: {}, slots: [] });
  record('slots/fine-settimana-senza-finestre', res, normalizer(), {
    method: 'GET', path: `/api/calendar/event-types/${s.types.main.slug}/slots`, query,
  });
});

test("slots: cambio dell'ora, festività nel calendario 'f' e schedule con override di data", async () => {
  // 28 marzo: domenica del cambio dell'ora; 29: Pasquetta (timed 00-24 Roma
  // in 'f'); 30: primo giorno feriale in CEST (09:00 Roma = 07:00Z).
  const query = { from: '2027-03-28', to: '2027-03-30' };
  const res = await getSlots(s.types.main.slug, query);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(romeHoursByDate(res.json.slots_by_date), {
    '2027-03-28': [],
    '2027-03-29': [],
    '2027-03-30': ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'],
  });
  assert.equal(res.json.slots_by_date['2027-03-30'][0].start, '2027-03-30T07:00:00.000Z');
  record('slots/cambio-ora-e-festivita', res, normalizer(), {
    method: 'GET', path: `/api/calendar/event-types/${s.types.main.slug}/slots`, query,
  });

  // Schedule dedicato: il 30 non disponibile, il 31 solo 15:00-17:00.
  const customQuery = { from: '2027-03-29', to: '2027-03-31' };
  const custom = await getSlots(s.types.custom.slug, customQuery);
  assert.equal(custom.status, 200, custom.text);
  assert.deepEqual(romeHoursByDate(custom.json.slots_by_date), {
    '2027-03-29': [],
    '2027-03-30': [],
    '2027-03-31': ['15:00', '16:00'],
  });
  record('slots/schedule-con-override', custom, normalizer(), {
    method: 'GET', path: `/api/calendar/event-types/${s.types.custom.slug}/slots`, query: customQuery,
  });
});

test('slots: min_notice_hours e max_advance_days rispetto ad adesso', async () => {
  const query = { from: '2027-03-08', to: '2027-03-09' };

  // 98 ore da venerdì 5 alle 08:00 → martedì 9 alle 10:00 (l'iscrizione
  // occupa comunque 09:00-10:00).
  const notice = await getSlots(s.types.notice.slug, query);
  assert.equal(notice.status, 200, notice.text);
  assert.deepEqual(romeHoursByDate(notice.json.slots_by_date), {
    '2027-03-08': [],
    '2027-03-09': ['10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'],
  });
  record('slots/min-notice', notice, normalizer(), {
    method: 'GET', path: `/api/calendar/event-types/${s.types.notice.slug}/slots`, query,
  });

  // 4 giorni → fino a martedì 9 alle 08:00. Lunedì la finestra libera
  // 11:30-13:00 produce lo slot delle 12:00: gli slot si riallineano alla
  // griglia dell'incremento (60 minuti) e non partono dalle 11:30.
  const advance = await getSlots(s.types.advance.slug, query);
  assert.equal(advance.status, 200, advance.text);
  assert.deepEqual(romeHoursByDate(advance.json.slots_by_date), {
    '2027-03-08': ['09:00', '12:00', '14:00', '15:00', '16:00'],
    '2027-03-09': [],
  });
  record('slots/max-advance', advance, normalizer(), {
    method: 'GET', path: `/api/calendar/event-types/${s.types.advance.slug}/slots`, query,
  });
});

// ─── POST /bookings ───────────────────────────────

test('POST /bookings: 200 confermata, con lead e proiezione nel calendario bookings', async () => {
  const body = bookingBody(s.types.main, romeIso('2027-04-12', '10:00'));
  const res = await api.post('/api/calendar/bookings', { body });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.json), ['success', 'booking']);
  assert.deepEqual(Object.keys(res.json.booking), ['uid', 'status', 'start_time', 'end_time', 'location_type', 'location_value']);
  assert.equal(res.json.booking.status, 'confirmed');
  assert.equal(res.json.booking.end_time, romeIso('2027-04-12', '11:00'));

  const uid: string = res.json.booking.uid;
  const state = await bookingState(uid);
  const projections = state.projections as Array<{ calendar: string; url: string | null }>;
  assert.equal(projections.length, 1);
  assert.equal(projections[0].calendar, 'bookings');
  assert.equal(projections[0].url, s.types.main.location_value);
  assert.equal((state.leads as unknown[]).length, 1);

  const n = normalizer().alias(uid, 'booking:nuova');
  record('bookings/200-confermata', res, n, { method: 'POST', path: '/api/calendar/bookings', body }, { effects: state });

  // Lo slot preso sparisce dagli slot pubblici, con i buffer 30/30 del tipo
  // (occupato 09:30-11:30): la mattina restano 11:30 e 12:00.
  const slots = await getSlots(s.types.main.slug, { from: '2027-04-12', to: '2027-04-12' });
  assert.deepEqual(romeHoursByDate(slots.json.slots_by_date)['2027-04-12'].slice(0, 2), ['11:30', '12:00']);
});

test('POST /bookings: 200 pending con requires_approval, senza proiezione', async () => {
  const body = bookingBody(s.types.approval, romeIso('2027-04-13', '10:00'));
  const res = await api.post('/api/calendar/bookings', { body });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.booking.status, 'pending');
  const uid: string = res.json.booking.uid;
  const state = await bookingState(uid);
  assert.deepEqual(state.projections, [], 'le pending non vengono proiettate');
  record('bookings/200-pending', res, normalizer().alias(uid, 'booking:pending'), {
    method: 'POST', path: '/api/calendar/bookings', body,
  }, { effects: state });
});

test('POST /bookings: 200 con risposte alle domande e indirizzo in presenza', async () => {
  const body = bookingBody(s.types.inPerson, romeIso('2027-04-13', '15:00'), {
    custom_responses: { azienda: '  Officina Rossi  ', budget: 'oltre 1.000 €', ignota: 'scartata' },
  });
  const res = await api.post('/api/calendar/bookings', { body });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.booking.location_value, 'Via del Corso 1, Roma');
  const uid: string = res.json.booking.uid;
  const state = await bookingState(uid);
  // Risposte ripulite: trim e chiavi sconosciute scartate.
  assert.deepEqual((state.booking as { custom_responses: unknown }).custom_responses, { azienda: 'Officina Rossi', budget: 'oltre 1.000 €' });
  record('bookings/200-domande-in-presenza', res, normalizer().alias(uid, 'booking:sopralluogo'), {
    method: 'POST', path: '/api/calendar/bookings', body,
  }, { effects: state });
});

test('POST /bookings: 400 per corpo, schema, domande obbligatorie e vincoli temporali', async () => {
  const main = s.types.main;
  const start = romeIso('2027-04-14', '10:00');
  const valid = bookingBody(main, start);
  const attendee = valid.attendee as Record<string, unknown>;
  const cases: Array<[string, unknown, Record<string, unknown>]> = [
    ['corpo-non-json', 'non è json', { error: 'Body JSON richiesto' }],
    ['corpo-vuoto', {}, { error: 'Required' }],
    ['consenso-mancante', { ...valid, gdpr_consent: undefined }, { error: 'Consenso GDPR richiesto' }],
    ['email-non-valida', { ...valid, attendee: { ...attendee, email: 'non-una-email' } }, { error: 'Email non valida' }],
    ['nome-corto', { ...valid, attendee: { ...attendee, name: 'A' } }, { error: 'Nome richiesto (min 2 caratteri)' }],
    ['telefono-non-valido', { ...valid, attendee: { ...attendee, phone: 'abc' } }, { error: 'Numero di telefono non valido' }],
    ['start-non-iso', { ...valid, start: 'lunedì prossimo' }, { error: 'start ISO richiesto' }],
    ['domanda-obbligatoria', bookingBody(s.types.inPerson, romeIso('2027-04-14', '15:00')),
      { error: 'Risposta obbligatoria mancante: Nome azienda', code: 'BOOKING_VALIDATION' }],
    ['opzione-non-valida', bookingBody(s.types.inPerson, romeIso('2027-04-14', '15:00'), { custom_responses: { azienda: 'Rossi', budget: 'gratis' } }),
      { error: 'Valore non valido per: Budget', code: 'BOOKING_VALIDATION' }],
    ['nel-passato', bookingBody(main, '2027-03-04T09:00:00.000Z'),
      { error: 'Devi prenotare con almeno 0 ore di anticipo', code: 'BOOKING_VALIDATION' }],
    ['oltre-max-advance', bookingBody(s.types.advance, romeIso('2027-03-12', '10:00')),
      { error: 'Puoi prenotare al massimo 4 giorni in anticipo', code: 'BOOKING_VALIDATION' }],
  ];
  for (const [name, body, expected] of cases) {
    const res = await api.post('/api/calendar/bookings', {
      body: typeof body === 'string' ? body : JSON.parse(JSON.stringify(body)),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 400, `${name}: ${res.text}`);
    assert.deepEqual(res.json, expected, name);
    record(`bookings/400-${name}`, res, normalizer(), { method: 'POST', path: '/api/calendar/bookings', body });
  }
  const [{ n }] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM calendar_bookings WHERE start_time = ${start}::timestamptz
  `;
  assert.equal(n, 0, 'nessuna prenotazione creata dai casi 400');
});

test('POST /bookings: 403 se il captcha rifiuta (provider non configurato in produzione)', async () => {
  const body = bookingBody(s.types.main, romeIso('2027-04-14', '11:00'));
  const res = await withEnv({ NODE_ENV: 'production' }, () => api.post('/api/calendar/bookings', { body }));
  assert.equal(res.status, 403, res.text);
  assert.deepEqual(res.json, { error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' });
  record('bookings/403-captcha', res, normalizer(), { method: 'POST', path: '/api/calendar/bookings', body });

  // Il captcha viene prima della validazione dello schema; il controllo del
  // corpo JSON viene prima del captcha.
  const invalid = await withEnv({ NODE_ENV: 'production' }, () =>
    api.post('/api/calendar/bookings', { body: { ...body, gdpr_consent: false } }));
  assert.equal(invalid.status, 403);
  const notJson = await withEnv({ NODE_ENV: 'production' }, () =>
    api.post('/api/calendar/bookings', { body: 'x', headers: { 'content-type': 'application/json' } }));
  assert.equal(notJson.status, 400);
});

test('POST /bookings: 404 per tipo inesistente, non pubblico o inattivo', async () => {
  for (const [name, slug] of [
    ['inesistente', fx.slug('inesistente')],
    ['non-pubblico', s.types.hidden.slug],
    ['inattivo', s.types.inactive.slug],
  ] as const) {
    const body = { ...bookingBody(s.types.main, romeIso('2027-04-14', '12:00')), event_type_slug: slug };
    const res = await api.post('/api/calendar/bookings', { body });
    assert.equal(res.status, 404, name);
    assert.deepEqual(res.json, { error: 'Tipologia di prenotazione non disponibile' });
    record(`bookings/404-${name}`, res, normalizer(), { method: 'POST', path: '/api/calendar/bookings', body });
  }
});

test('POST /bookings: 409 per slot già preso, fuori griglia, in chiusura o sopra un evento', async () => {
  await fx.booking({ eventType: s.types.main, start: romeIso('2027-04-12', '15:00'), attendee: { name: 'Prenotato prima' } });
  const conflict = { error: 'Orario non più disponibile: scegli uno degli slot proposti', code: 'BOOKING_CONFLICT' };
  for (const [name, start] of [
    ['slot-preso', romeIso('2027-04-12', '15:00')],
    ['nel-buffer', romeIso('2027-04-12', '16:00')],
    ['fuori-griglia', romeIso('2027-04-12', '17:15')],
    ['fuori-orario', romeIso('2027-04-12', '19:00')],
    ['chiusura', romeIso('2027-03-11', '10:00')],
    ['festivita', romeIso('2027-03-29', '10:00')],
    ['evento-bloccante', romeIso('2027-03-08', '10:00')],
  ] as const) {
    const body = bookingBody(s.types.main, start);
    const res = await api.post('/api/calendar/bookings', { body });
    assert.equal(res.status, 409, `${name}: ${res.text}`);
    assert.deepEqual(res.json, conflict, name);
    record(`bookings/409-${name}`, res, normalizer(), { method: 'POST', path: '/api/calendar/bookings', body });
  }
  const [{ n }] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM calendar_bookings WHERE attendee_email = ${fx.email('sito')}
      AND start_time IN (${romeIso('2027-04-12', '15:00')}::timestamptz, ${romeIso('2027-04-12', '16:00')}::timestamptz)
  `;
  assert.equal(n, 0, 'nessuna prenotazione creata dai casi 409');
});

test('slots e POST /bookings: verso dei buffer asimmetrici attorno a una prenotazione esistente', async () => {
  // Una prenotazione esistente blocca [inizio - buffer_after, fine +
  // buffer_before] del nuovo slot (slots.ts): con 15 prima e 45 dopo, la
  // prenotazione 11:00-11:30 toglie 10:15-11:45. Con i buffer invertiti
  // sarebbero 10:45-12:15. Le POST dal sito (require_available_slot) passano
  // dallo stesso calcolo: nessun altro controllo dei buffer per public_page.
  const type = s.types.asymmetric;
  const query = { from: '2027-04-27', to: '2027-04-27' };
  const slots = await getSlots(type.slug, query);
  assert.equal(slots.status, 200, slots.text);
  assert.deepEqual(romeHoursByDate(slots.json.slots_by_date), {
    '2027-04-27': [
      // Ultimo slot prima: 09:45-10:15 finisce dove inizia il buffer dopo.
      '09:00', '09:15', '09:30', '09:45',
      // Primo slot dopo: 11:45, fine della prenotazione più il buffer prima.
      '11:45', '12:00', '12:15', '12:30',
      '14:00', '14:15', '14:30', '14:45', '15:00', '15:15', '15:30', '15:45',
      '16:00', '16:15', '16:30', '16:45', '17:00', '17:15', '17:30',
    ],
  });
  record('slots/buffer-asimmetrici', slots, normalizer(), {
    method: 'GET', path: `/api/calendar/event-types/${type.slug}/slots`, query,
  });

  // Ai bordi: 10:00-10:30 non tocca la prenotazione ma lascia 30 minuti prima
  // del suo inizio (meno dei 45 del buffer dopo); 11:30-12:00 parte quando
  // finisce (meno dei 15 del buffer prima).
  const conflict = { error: 'Orario non più disponibile: scegli uno degli slot proposti', code: 'BOOKING_CONFLICT' };
  for (const [name, time] of [['nel-buffer-dopo', '10:00'], ['nel-buffer-prima', '11:30']] as const) {
    const body = bookingBody(type, romeIso('2027-04-27', time));
    const res = await api.post('/api/calendar/bookings', { body });
    assert.equal(res.status, 409, `${name}: ${res.text}`);
    assert.deepEqual(res.json, conflict, name);
    record(`bookings/409-buffer-asimmetrici-${name}`, res, normalizer(), { method: 'POST', path: '/api/calendar/bookings', body });
  }

  // Subito oltre il buffer prima (11:30 + 15 minuti): accettata.
  const body = bookingBody(type, romeIso('2027-04-27', '11:45'));
  const res = await api.post('/api/calendar/bookings', { body });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.booking.start_time, romeIso('2027-04-27', '11:45'));
  assert.equal(res.json.booking.end_time, romeIso('2027-04-27', '12:15'));
  const uid: string = res.json.booking.uid;
  record('bookings/200-buffer-asimmetrici-oltre-buffer-prima', res, normalizer().alias(uid, 'booking:oltre-buffer'), {
    method: 'POST', path: '/api/calendar/bookings', body,
  }, { effects: await bookingState(uid) });
});

// ─── Gestione self-service con token ───────────────────────────────

test('GET /bookings/:uid: dettaglio con token; 401 senza token, scaduto, contraffatto o di un altro uid; 404', async () => {
  const { booking } = await fx.booking({
    eventType: s.types.main, start: romeIso('2027-04-14', '09:00'),
    attendee: { name: 'Cliente gestione', phone: '+39 06 0000000' },
  });
  const token = bookingManageToken(booking.uid);
  const path = bookingManagePath(booking.uid, token);
  const res = await api.get(path);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.json), ['booking', 'event_type']);
  assert.deepEqual(Object.keys(res.json.booking), [
    'uid', 'status', 'attendee_name', 'attendee_email', 'attendee_timezone', 'start_time', 'end_time',
    'location_type', 'location_value', 'cancelled_at',
  ]);
  assert.deepEqual(Object.keys(res.json.event_type), PUBLIC_EVENT_TYPE_KEYS);
  const n = () => normalizer().alias(booking.uid, 'booking:gestione').alias(token, 'token:gestione');
  record('manage/dettaglio', res, n(), { method: 'GET', path });

  const unauthorized = { error: 'Token mancante o scaduto' };
  for (const [name, badToken] of [
    ['senza-token', ''],
    ['scaduto', expiredBookingManageToken(booking.uid)],
    ['contraffatto', bookingManageTokenWithSecret(booking.uid, 'un-altro-secret-di-almeno-trentadue-caratteri')],
    ['altro-uid', bookingManageToken('altrouid0000')],
  ] as const) {
    const badPath = badToken ? bookingManagePath(booking.uid, badToken) : `/api/calendar/bookings/${booking.uid}`;
    const bad = await api.get(badPath);
    assert.equal(bad.status, 401, name);
    assert.deepEqual(bad.json, unauthorized);
    const nBad = n();
    if (badToken) nBad.alias(badToken, 'token:non-valido');
    record(`manage/dettaglio-401-${name}`, bad, nBad, { method: 'GET', path: badPath });
  }

  // Token valido per un uid che non esiste.
  const ghostToken = bookingManageToken('inesistente1');
  const ghost = await api.get(bookingManagePath('inesistente1', ghostToken));
  assert.equal(ghost.status, 404);
  assert.deepEqual(ghost.json, { error: 'Prenotazione non trovata' });
  record('manage/dettaglio-404', ghost, normalizer().alias(ghostToken, 'token:inesistente'), {
    method: 'GET', path: bookingManagePath('inesistente1', ghostToken),
  });
});

test('GET /bookings/:uid/ics: invito REQUEST, CANCEL se annullata; 401 e 404', async () => {
  const confirmed = await fx.booking({
    eventType: s.types.main, start: romeIso('2027-04-14', '14:00'),
    attendee: { name: 'Cliente, ICS; prova', message: 'Riga uno\nRiga due' },
  });
  const token = bookingManageToken(confirmed.booking.uid);
  const path = bookingManagePath(confirmed.booking.uid, token, 'ics');
  const res = await api.get(path);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="prenotazione-${confirmed.booking.uid}.ics"`);
  const [vevent] = icsEvents(res.text);
  assert.equal(icsProp(vevent, 'UID'), `${confirmed.booking.uid}@caldes.it`);
  assert.equal(icsProp(vevent, 'DTSTART'), '20270414T120000Z');
  assert.equal(icsProp(vevent, 'STATUS'), 'CONFIRMED');
  // Le righe oltre 75 ottetti vanno a capo (RFC 5545 §3.1).
  for (const line of res.text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `riga troppo lunga: ${line}`);
  record('manage/ics-request', res, normalizer().alias(confirmed.booking.uid, 'booking:ics').alias(token, 'token:ics'), {
    method: 'GET', path,
  });

  const cancelled = await fx.booking({ eventType: s.types.main, start: romeIso('2027-04-14', '16:00'), status: 'cancelled' });
  const cancelToken = bookingManageToken(cancelled.booking.uid);
  const cancelPath = bookingManagePath(cancelled.booking.uid, cancelToken, 'ics');
  const cancelRes = await api.get(cancelPath);
  assert.equal(cancelRes.status, 200, cancelRes.text);
  assert.match(cancelRes.text, /\r\nMETHOD:CANCEL\r\n/);
  assert.match(cancelRes.text, /\r\nSTATUS:CANCELLED\r\n/);
  assert.doesNotMatch(cancelRes.text, /BEGIN:VALARM/);
  record('manage/ics-cancel', cancelRes, normalizer().alias(cancelled.booking.uid, 'booking:ics-annullata').alias(cancelToken, 'token:ics'), {
    method: 'GET', path: cancelPath,
  });

  const noToken = await api.get(`/api/calendar/bookings/${confirmed.booking.uid}/ics`);
  assert.equal(noToken.status, 401);
  assert.deepEqual(noToken.json, { error: 'Token mancante o scaduto' });
  const ghostToken = bookingManageToken('inesistente2');
  const ghost = await api.get(bookingManagePath('inesistente2', ghostToken, 'ics'));
  assert.equal(ghost.status, 404);
  assert.deepEqual(ghost.json, { error: 'Prenotazione non trovata' });
});

test('POST /bookings/:uid/cancel: annulla con motivo, idempotente, libera lo slot; 401 e 404', async () => {
  const { booking } = await fx.booking({ eventType: s.types.main, start: romeIso('2027-04-15', '09:00') });
  const booked = await getSlots(s.types.main.slug, { from: '2027-04-15', to: '2027-04-15' });
  assert.equal(romeHoursByDate(booked.json.slots_by_date)['2027-04-15'][0], '10:30', 'prenotazione 09:00 con buffer');

  const token = bookingManageToken(booking.uid);
  const path = bookingManagePath(booking.uid, token, 'cancel');
  const n = () => normalizer().alias(booking.uid, 'booking:da-annullare').alias(token, 'token:gestione');

  const noToken = await api.post(`/api/calendar/bookings/${booking.uid}/cancel`, { body: {} });
  assert.equal(noToken.status, 401);
  assert.deepEqual(noToken.json, { error: 'Token mancante o scaduto' });

  const body = { reason: 'Imprevisto di lavoro' };
  const res = await api.post(path, { body });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { success: true });
  const state = await bookingState(booking.uid);
  const row = state.booking as { status: string; cancelled_by: string; cancellation_reason: string };
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancelled_by, 'attendee');
  assert.equal(row.cancellation_reason, 'Imprevisto di lavoro');
  assert.deepEqual((state.projections as Array<{ status: string }>).map((p) => p.status), CANCELLED_PROJECTION_STATUSES);
  record('manage/cancel', res, n(), { method: 'POST', path, body }, { effects: state });

  // Seconda richiesta: 200 e nessuna modifica (motivo e autore restano).
  const again = await api.post(path, { body: { reason: 'Altro motivo' } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, { success: true });
  const [unchanged] = await sql<Array<{ cancellation_reason: string }>>`
    SELECT cancellation_reason FROM calendar_bookings WHERE uid = ${booking.uid}
  `;
  assert.equal(unchanged.cancellation_reason, 'Imprevisto di lavoro');

  // Lo slot delle 09:00 torna disponibile.
  const freed = await getSlots(s.types.main.slug, { from: '2027-04-15', to: '2027-04-15' });
  assert.equal(romeHoursByDate(freed.json.slots_by_date)['2027-04-15'][0], '09:00');

  const ghostToken = bookingManageToken('inesistente3');
  const ghost = await api.post(bookingManagePath('inesistente3', ghostToken, 'cancel'), { body: {} });
  assert.equal(ghost.status, 404);
  assert.deepEqual(ghost.json, { error: 'Prenotazione non trovata' });
  record('manage/cancel-404', ghost, normalizer().alias(ghostToken, 'token:inesistente'), {
    method: 'POST', path: bookingManagePath('inesistente3', ghostToken, 'cancel'), body: {},
  });
});

test("POST /bookings/:uid/reschedule: nuova prenotazione, originale annullata, proiezioni aggiornate", async () => {
  const original = await fx.booking({ eventType: s.types.main, start: romeIso('2027-04-16', '09:00') });
  assert.equal(original.projection?.url, s.types.main.location_value);
  const token = bookingManageToken(original.booking.uid);
  const path = bookingManagePath(original.booking.uid, token, 'reschedule');
  const body = { start: romeIso('2027-04-16', '15:00') };
  const res = await api.post(path, { body });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.json), ['success', 'booking']);
  assert.deepEqual(Object.keys(res.json.booking), ['uid', 'start_time', 'end_time']);
  const newUid: string = res.json.booking.uid;
  assert.notEqual(newUid, original.booking.uid, 'la riprogrammazione crea una prenotazione con un nuovo uid');

  const oldState = await bookingState(original.booking.uid);
  const newState = await bookingState(newUid);
  const oldRow = oldState.booking as { status: string; cancelled_by: string; cancellation_reason: string };
  assert.equal(oldRow.status, 'cancelled');
  assert.equal(oldRow.cancelled_by, 'attendee');
  assert.equal(oldRow.cancellation_reason, 'Rescheduled: Riprogrammata dal partecipante');
  const newRow = newState.booking as { status: string; rescheduled_from_uid: string; location_value: string };
  assert.equal(newRow.status, 'confirmed');
  assert.equal(newRow.rescheduled_from_uid, original.booking.uid);
  assert.equal(newRow.location_value, s.types.main.location_value);
  assert.deepEqual((oldState.projections as Array<{ status: string }>).map((p) => p.status), CANCELLED_PROJECTION_STATUSES);
  const newProjections = newState.projections as Array<{ status: string; url: string | null; location: string | null }>;
  assert.deepEqual(newProjections.map((p) => p.status), ['confirmed']);
  // BUG ATTUALE dello store legacy (design §14, "meetingUrl null in
  // riprogrammazione"): la nuova proiezione perde il link della riunione (url
  // null) anche se la location della prenotazione lo contiene ancora. Con lo
  // store Radicale il job project_booking lo ricalcola sempre
  // (resolveLocationForBooking): differenza ammessa per quello store.
  assert.equal(newProjections[0].url, isRadicaleBackend() ? s.types.main.location_value : null);
  assert.equal(newProjections[0].location, s.types.main.location_value);

  const n = normalizer()
    .alias(original.booking.uid, 'booking:originale')
    .alias(newUid, 'booking:riprogrammata')
    .alias(token, 'token:gestione');
  record('manage/reschedule', res, n, { method: 'POST', path, body }, {
    effects: { originale: oldState, riprogrammata: newState },
  });
});

test('POST /bookings/:uid/reschedule: 400, 401, 403 (captcha), 404 e 409 con originale intatta', async () => {
  const original = await fx.booking({ eventType: s.types.main, start: romeIso('2027-04-19', '09:00') });
  await fx.booking({ eventType: s.types.main, start: romeIso('2027-04-19', '15:00'), attendee: { name: 'Già prenotato' } });
  const token = bookingManageToken(original.booking.uid);
  const path = bookingManagePath(original.booking.uid, token, 'reschedule');
  const n = () => normalizer().alias(original.booking.uid, 'booking:originale').alias(token, 'token:gestione');

  const noToken = await api.post(`/api/calendar/bookings/${original.booking.uid}/reschedule`, { body: { start: romeIso('2027-04-19', '11:00') } });
  assert.equal(noToken.status, 401);
  assert.deepEqual(noToken.json, { error: 'Token mancante o scaduto' });

  for (const [name, body] of [
    ['start-mancante', {}],
    ['start-non-valido', { start: 'domani' }],
  ] as const) {
    const res = await api.post(path, { body });
    assert.equal(res.status, 400, name);
    assert.deepEqual(res.json, { error: 'start ISO richiesto' });
    record(`manage/reschedule-400-${name}`, res, n(), { method: 'POST', path, body });
  }

  // Captcha: verificato solo se il client invia turnstile_token.
  const captchaBody = { start: romeIso('2027-04-19', '11:00'), turnstile_token: 'token-captcha-di-prova' };
  const captcha = await withEnv({ NODE_ENV: 'production' }, () => api.post(path, { body: captchaBody }));
  assert.equal(captcha.status, 403, captcha.text);
  assert.deepEqual(captcha.json, { error: 'Verifica anti-bot fallita. Riprova.' });
  record('manage/reschedule-403-captcha', captcha, n(), { method: 'POST', path, body: captchaBody });

  // Slot occupato da un'altra prenotazione: 409 e rollback (l'originale resta confermata).
  const takenBody = { start: romeIso('2027-04-19', '15:00') };
  const taken = await api.post(path, { body: takenBody });
  assert.equal(taken.status, 409, taken.text);
  assert.deepEqual(taken.json, { error: 'Orario non più disponibile: scegli uno degli slot proposti', code: 'BOOKING_CONFLICT' });
  const state = await bookingState(original.booking.uid);
  assert.equal((state.booking as { status: string }).status, 'confirmed');
  assert.deepEqual((state.projections as Array<{ status: string }>).map((p) => p.status), ['confirmed']);
  record('manage/reschedule-409-slot-occupato', taken, n(), { method: 'POST', path, body: takenBody }, { effects: state });

  const ghostToken = bookingManageToken('inesistente4');
  const ghostPath = bookingManagePath('inesistente4', ghostToken, 'reschedule');
  const ghost = await api.post(ghostPath, { body: { start: romeIso('2027-04-19', '11:00') } });
  assert.equal(ghost.status, 404);
  assert.deepEqual(ghost.json, { error: 'Prenotazione non trovata' });
  record('manage/reschedule-404', ghost, normalizer().alias(ghostToken, 'token:inesistente'), {
    method: 'POST', path: ghostPath, body: { start: romeIso('2027-04-19', '11:00') },
  });

  // Prenotazione già annullata: 400 BOOKING_VALIDATION.
  const cancelled = await fx.booking({ eventType: s.types.main, start: romeIso('2027-04-19', '12:00'), status: 'cancelled' });
  const cancelledToken = bookingManageToken(cancelled.booking.uid);
  const cancelledPath = bookingManagePath(cancelled.booking.uid, cancelledToken, 'reschedule');
  const already = await api.post(cancelledPath, { body: { start: romeIso('2027-04-19', '16:30') } });
  assert.equal(already.status, 400, already.text);
  assert.deepEqual(already.json, { error: 'Prenotazione già cancellata', code: 'BOOKING_VALIDATION' });
  record('manage/reschedule-400-gia-annullata', already, normalizer().alias(cancelled.booking.uid, 'booking:annullata').alias(cancelledToken, 'token:gestione'), {
    method: 'POST', path: cancelledPath, body: { start: romeIso('2027-04-19', '16:30') },
  });
});

test('POST /bookings/:uid/reschedule: senza turnstile_token il captcha non viene verificato (anche in produzione)', async () => {
  // Comportamento attuale: il token HMAC lega la richiesta alla prenotazione e
  // il captcha è solo difesa in profondità, verificato se il client lo invia.
  const original = await fx.booking({ eventType: s.types.main, start: romeIso('2027-04-21', '09:00') });
  const token = bookingManageToken(original.booking.uid);
  const path = bookingManagePath(original.booking.uid, token, 'reschedule');
  const res = await withEnv({ NODE_ENV: 'production' }, () => api.post(path, { body: { start: romeIso('2027-04-21', '14:00') } }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.booking.start_time, romeIso('2027-04-21', '14:00'));
});

test("POST /bookings/:uid/reschedule: 409 su uno slot sovrapposto all'originale (bug design §14)", async () => {
  const original = await fx.booking({ eventType: s.types.main, start: romeIso('2027-04-20', '10:00') });
  const token = bookingManageToken(original.booking.uid);
  const path = bookingManagePath(original.booking.uid, token, 'reschedule');
  const body = { start: romeIso('2027-04-20', '10:30') };
  const res = await api.post(path, { body });
  if (isRadicaleBackend()) {
    // Store Radicale (design §9 "Proiezioni fuori dal busy", §14, piano F2
    // "Prenotazioni"): la decisione legge con `db: tx` (l'originale è già
    // annullata nella transazione) e le proiezioni booking-* non bloccano,
    // quindi la riprogrammazione sovrapposta all'originale è accettata.
    assert.equal(res.status, 200, res.text);
    const newUid: string = res.json.booking.uid;
    assert.equal(res.json.booking.start_time, romeIso('2027-04-20', '10:30'));
    const oldState = await bookingState(original.booking.uid);
    const newState = await bookingState(newUid);
    assert.equal((oldState.booking as { status: string }).status, 'cancelled');
    assert.deepEqual(oldState.projections, [], 'la proiezione dell\'originale è tolta');
    assert.equal((newState.booking as { status: string }).status, 'confirmed');
    assert.deepEqual((newState.projections as Array<{ status: string }>).map((p) => p.status), ['confirmed']);
    record('manage/reschedule-409-sovrapposta-originale', res,
      normalizer().alias(original.booking.uid, 'booking:originale').alias(newUid, 'booking:riprogrammata').alias(token, 'token:gestione'),
      { method: 'POST', path, body }, { effects: oldState });
    return;
  }
  // BUG ATTUALE (design §14, "riprogrammazione che legge fuori dalla
  // transazione e resta bloccata dalla vecchia proiezione"): la transazione
  // annulla l'originale, ma computeAvailableSlots legge dal pool globale e
  // vede ancora la prenotazione (con i buffer) e la sua proiezione → 409.
  // Atteso dopo F2: 200, con la nuova prenotazione alle 10:30.
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'Orario non più disponibile: scegli uno degli slot proposti', code: 'BOOKING_CONFLICT' });
  const state = await bookingState(original.booking.uid);
  assert.equal((state.booking as { status: string }).status, 'confirmed', 'rollback: originale intatta');
  record('manage/reschedule-409-sovrapposta-originale', res,
    normalizer().alias(original.booking.uid, 'booking:originale').alias(token, 'token:gestione'),
    { method: 'POST', path, body }, { effects: state });
});

// Correzioni della F2 attive solo con lo store Radicale (design §12 "Parità
// prima": con lo store legacy restano i comportamenti di oggi), verificate nel
// caso 'manage/reschedule-409-sovrapposta-originale' e in 'manage/reschedule'.
if (!isRadicaleBackend()) {
  test.todo("reschedule: uno slot sovrapposto all'originale va accettato (design §14 e §15, F2)");
  test.todo('reschedule: la proiezione della nuova prenotazione conserva il link della riunione (design §14)');
}

// ─── Form contatti ───────────────────────────────

test('contacts/cal-slots: slot del tipo del form contatti per una data; 400 senza data valida', async () => {
  const [seed] = await sql<Array<{ slug: string }>>`
    SELECT slug FROM calendar_event_types WHERE slug = ${CONTACT_FORM_EVENT_TYPE} AND is_active AND is_public
  `;
  assert.ok(seed, `Tipo ${CONTACT_FORM_EVENT_TYPE} (migrazione 067) assente o non pubblico nel database dei test`);

  for (const date of ['2027-03-08', '2027-03-09', '2027-03-13']) {
    const res = await api.get('/api/contacts/cal-slots', { query: { date } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.json), ['slots']);
    // Stessa disponibilità dell'API pubblica, ridotta a { time: start }.
    const slots = await getSlots(CONTACT_FORM_EVENT_TYPE, { from: date, to: date });
    const bySlotsApi = Object.entries(slots.json.slots_by_date as Record<string, Array<{ start: string }>>)
      .map(([day, list]) => [day, list.map((slot) => ({ time: slot.start }))]);
    assert.deepEqual(res.json.slots, Object.fromEntries(bySlotsApi));
    record(`cal-slots/${date}`, res, normalizer(), { method: 'GET', path: '/api/contacts/cal-slots', query: { date } });
  }

  // Sabato: nessuna finestra di disponibilità → oggetto vuoto, senza la data
  // (vedi il caso 'slots/fine-settimana-senza-finestre').
  const saturday = await api.get('/api/contacts/cal-slots', { query: { date: '2027-03-13' } });
  assert.deepEqual(saturday.json, { slots: {} });

  // Martedì 9: 30 minuti, incremento 30, buffer dopo 15 (seme): l'iscrizione
  // 09:00-10:00 blocca, il resto della giornata è libero.
  const tuesday = await api.get('/api/contacts/cal-slots', { query: { date: '2027-03-09' } });
  assert.deepEqual(
    tuesday.json.slots['2027-03-09'].map((slot: { time: string }) => romeHour(slot.time)),
    ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30'],
  );

  for (const [name, query] of [
    ['data-mancante', {}],
    ['data-non-valida', { date: '09-03-2027' }],
  ] as const) {
    const res = await api.get('/api/contacts/cal-slots', { query });
    assert.equal(res.status, 400, name);
    assert.deepEqual(res.json, { error: 'Parametro date richiesto (YYYY-MM-DD)' });
    record(`cal-slots/400-${name}`, res, normalizer(), { method: 'GET', path: '/api/contacts/cal-slots', query });
  }
});

test('contacts/cal-slots: 503 se il tipo del form contatti non è pubblico (o manca, o è inattivo)', async () => {
  // computeAvailableSlots con onlyPublic restituisce null per un tipo assente,
  // non pubblico o inattivo: il form contatti riceve 503. Il tipo seminato
  // viene reso non pubblico per il solo caso e ripristinato subito.
  const [seed] = await sql<Array<{ is_public: boolean }>>`
    SELECT is_public FROM calendar_event_types WHERE slug = ${CONTACT_FORM_EVENT_TYPE}
  `;
  assert.ok(seed, `Tipo ${CONTACT_FORM_EVENT_TYPE} (migrazione 067) assente nel database dei test`);
  const query = { date: '2027-03-08' };
  let res: TestResponse;
  try {
    await sql`UPDATE calendar_event_types SET is_public = false WHERE slug = ${CONTACT_FORM_EVENT_TYPE}`;
    res = await api.get('/api/contacts/cal-slots', { query });
  } finally {
    await sql`UPDATE calendar_event_types SET is_public = ${seed.is_public} WHERE slug = ${CONTACT_FORM_EVENT_TYPE}`;
  }
  assert.equal(res.status, 503, res.text);
  assert.deepEqual(res.json, { error: 'Tipologia di prenotazione non disponibile' });
  record('cal-slots/503-tipo-non-disponibile', res, normalizer(), { method: 'GET', path: '/api/contacts/cal-slots', query });

  // Ripristinato: di nuovo 200.
  assert.equal((await api.get('/api/contacts/cal-slots', { query })).status, 200);
});

// ─── Copertura ───────────────────────────────

// Dopo tutti i casi: fallisce se nello snapshot restano casi non più eseguiti.
contractCoverageTest(store, 'public-calendar.contract.test.ts');
