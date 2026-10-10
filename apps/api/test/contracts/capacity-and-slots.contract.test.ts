/**
 * Contratto della capacità settimanale (F0, design §9 e §15):
 *  - GET /api/dashboard/capacity-week (admin): ore pianificate della settimana
 *    ISO di Roma = time_entries + prenotazioni confermate/pending + eventi
 *    bloccanti confermati e timed, esclusi source 'booking'/'system' e il
 *    calendario "Festività e chiusure"; stato light/optimal/overbooked;
 *  - effetto della capacità sugli slot pubblici (filterSlotsByWeeklyCapacity)
 *    e sulle prenotazioni (hasWeeklyCapacityForBooking nella sezione critica).
 *
 * In F2 la capacity diventa una SQL sull'indice con le stesse esclusioni di
 * oggi (design §9): questi snapshot (__snapshots__/capacity-and-slots.contract.json)
 * devono restare identici su entrambi gli store.
 *
 * Dati fuori dal dominio calendario, gestiti qui e ripuliti a fine file:
 *  - le time_entries richiedono un cliente e un progetto (nome con il prefisso);
 *  - la capacità settimanale si legge da site_settings 'freelancer.studio':
 *    il file la fissa a 40 ore (il default) e ripristina il valore originale.
 *
 * Comportamenti attuali congelati qui e da valutare dopo F0, commentati nei casi:
 *  - week_start e week_end sono la data UTC della mezzanotte di Roma: escono
 *    domenica e sabato invece di lunedì e domenica;
 *  - nella settimana del cambio dell'ora le settimane si spostano di un'ora
 *    (generate_series a passi di 7 giorni in UTC): un evento del lunedì tra
 *    00:00 e 01:00 viene contato in due settimane;
 *  - un timer in corso (end_time NULL) conta fino alla fine della settimana:
 *    la settimana risulta piena e gli slot pubblici spariscono.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { onBeforeDatabaseClose, onDatabaseReady, sql } from '../helpers/db';
import { api, ensureTestAdmin, signTestToken, TEST_ADMIN, type TestResponse } from '../helpers/http';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { isRadicaleBackend, useCalendarBackend } from '../helpers/calendar-backend';
import { createNormalizer } from '../helpers/normalize';
import { freezeTime, restoreTime } from '../helpers/clock';
import { BookingConflictError } from '../../src/lib/calendar/booking';
import type { Calendar, EventType } from '../../src/lib/calendar/types';
import {
  contractCoverageTest,
  type HttpContractRequest,
  httpContractStore,
  responseEntry,
  romeHoursByDate,
} from './_http-contract';

const fx = useFixtures('contratto-capacita', { resetBaseline: true });
useCalendarBackend();

const store = httpContractStore(
  'capacity-and-slots',
  'capacity-and-slots.contract.test.ts',
  'Capacità settimanale GET /api/dashboard/capacity-week e suo effetto su slot pubblici e prenotazioni, ' +
    'sullo scenario di test/contracts/capacity-and-slots.contract.test.ts (capacità fissata a 40 ore). ' +
    'Baseline F0 su PgLegacyStore.',
);

/** "Adesso" per slot e prenotazioni: mercoledì 5 maggio 2027, 10:00 a Roma. */
const NOW = '2027-05-05T08:00:00.000Z';

/** Chiave di site_settings con weekly_capacity_hours (lib/calendar/capacity.ts). */
const STUDIO_SETTINGS_KEY = 'freelancer.studio';

/** Ore settimanali usate dal file (uguali al default di getWeeklyCapacityHours). */
const WEEKLY_HOURS = 40;

interface Scenario {
  work: Calendar;
  notes: Calendar;
  holidays: Calendar;
  session: EventType;
  short: EventType;
}

let s: Scenario;

// ─── Ore lavorate (time_entries) ───────────────────────────────

/** Cliente e progetto a cui appoggiare le time_entries dello scenario. */
let timeProject: { customerId: string; projectId: string } | null = null;

/** Rimuove clienti, progetti e time_entries del prefisso, con le righe di audit e webhook. */
async function cleanupTimeData(): Promise<void> {
  const like = `${fx.prefix}%`;
  const customers = (await sql<Array<{ id: string }>>`
    SELECT id FROM customers WHERE contact_name LIKE ${like}
  `).map((r) => r.id);
  const projects = (await sql<Array<{ id: string }>>`
    SELECT id FROM client_projects WHERE name LIKE ${like} OR customer_id = ANY(${customers}::uuid[])
  `).map((r) => r.id);
  if (!customers.length && !projects.length) return;
  await sql`DELETE FROM time_entries WHERE project_id = ANY(${projects}::uuid[])`;
  await sql`DELETE FROM client_projects WHERE id = ANY(${projects}::uuid[])`;
  await sql`DELETE FROM customers WHERE id = ANY(${customers}::uuid[])`;
  // Trigger di audit (customers, client_projects) e webhook (customers).
  await sql`DELETE FROM audit_logs WHERE record_id = ANY(${[...customers, ...projects]}::text[])`;
  await sql`DELETE FROM webhook_events WHERE entity_id = ANY(${customers}::uuid[])`;
}

async function ensureTimeProject(): Promise<{ customerId: string; projectId: string }> {
  if (timeProject) return timeProject;
  await ensureTestAdmin();
  const [customer] = await sql<Array<{ id: string }>>`
    INSERT INTO customers (contact_name) VALUES (${fx.name('Cliente capacità')}) RETURNING id
  `;
  const [project] = await sql<Array<{ id: string }>>`
    INSERT INTO client_projects (customer_id, name) VALUES (${customer.id}::uuid, ${fx.name('Progetto capacità')}) RETURNING id
  `;
  timeProject = { customerId: customer.id, projectId: project.id };
  return timeProject;
}

/** Ore lavorate dall'admin dei test; `end` null = timer in corso. */
async function timeEntry(input: { start: string; end: string | null; billable: boolean; description: string }): Promise<void> {
  const { projectId } = await ensureTimeProject();
  await sql`
    INSERT INTO time_entries (project_id, user_id, start_time, end_time, is_billable, description)
    VALUES (${projectId}::uuid, ${TEST_ADMIN.id}::uuid, ${input.start}, ${input.end}, ${input.billable}, ${fx.name(input.description)})
  `;
}

// ─── Impostazione della capacità ───────────────────────────────

/**
 * Valore originale (JSON testuale) di site_settings 'freelancer.studio':
 * null = riga assente, undefined = non ancora letto o già ripristinato.
 */
let originalStudioSettings: string | null | undefined;

async function setWeeklyCapacityHours(hours: number): Promise<void> {
  await sql`
    INSERT INTO site_settings (key, value)
    VALUES (${STUDIO_SETTINGS_KEY}, ${sql.json({ weekly_capacity_hours: hours })})
    ON CONFLICT (key) DO UPDATE SET value = site_settings.value || EXCLUDED.value
  `;
}

async function restoreStudioSettings(): Promise<void> {
  if (originalStudioSettings === undefined) return;
  if (originalStudioSettings === null) {
    await sql`DELETE FROM site_settings WHERE key = ${STUDIO_SETTINGS_KEY}`;
  } else {
    // ::text prima di ::jsonb: con un parametro di tipo jsonb postgres-js farebbe
    // JSON.stringify della stringa e salverebbe una stringa JSON.
    await sql`UPDATE site_settings SET value = ${originalStudioSettings}::text::jsonb WHERE key = ${STUDIO_SETTINGS_KEY}`;
  }
  originalStudioSettings = undefined;
}

// ─── Scenario ───────────────────────────────

async function buildScenario(): Promise<Scenario> {
  const work = await fx.calendar({ key: 'lavoro', name: 'Lavoro', blocks_availability: true });
  const notes = await fx.calendar({ key: 'note', name: 'Note', blocks_availability: false });
  const holidays = await fx.holidayCalendar();
  const session = await fx.eventType({ key: 'sessione', title: 'Sessione', durationMinutes: 60, slotIncrementMinutes: 60 });
  const short = await fx.eventType({ key: 'breve', title: 'Breve', durationMinutes: 30, slotIncrementMinutes: 30 });

  // Settimana A (3-9 maggio): un po' di tutto, 11 ore pianificate.
  await timeEntry({ start: romeIso('2027-05-03', '09:00'), end: romeIso('2027-05-03', '11:00'), billable: true, description: 'Sviluppo' });
  await timeEntry({ start: romeIso('2027-05-04', '14:00'), end: romeIso('2027-05-04', '15:00'), billable: false, description: 'Formazione' });
  await timeEntry({ start: romeIso('2027-05-02', '23:00'), end: romeIso('2027-05-03', '01:00'), billable: true, description: 'Notturno a cavallo' });
  await fx.event({ calendar: work, summary: 'Riunione lunga', start_time: romeIso('2027-05-03', '14:00'), end_time: romeIso('2027-05-03', '16:00') });
  await fx.event({ calendar: work, summary: 'Riunione da admin', source: 'admin', start_time: romeIso('2027-05-04', '10:00'), end_time: romeIso('2027-05-04', '11:00') });
  await fx.event({ calendar: work, summary: "Creato dall'assistente", source: 'mcp', start_time: romeIso('2027-05-05', '16:00'), end_time: romeIso('2027-05-05', '16:30') });
  await fx.allDayEvent({ calendar: work, summary: 'Fiera', date: '2027-05-06' });
  await fx.event({ calendar: work, summary: 'Forse', status: 'tentative', start_time: romeIso('2027-05-06', '11:00'), end_time: romeIso('2027-05-06', '12:00') });
  await fx.event({ calendar: work, summary: 'Annullato', status: 'cancelled', start_time: romeIso('2027-05-06', '14:00'), end_time: romeIso('2027-05-06', '15:00') });
  // Con lo store Radicale la provenienza 'system' esiste solo per le festività
  // del cron nel calendario festività (design §5: la decidono collezione e href,
  // RadicaleStore rifiuta source 'system' altrove), quindi l'evento non è
  // rappresentabile. Escluso dalla capacity, e nel giorno della chiusura del 7
  // maggio: con lo store legacy non cambia né le ore né gli slot.
  if (!isRadicaleBackend()) {
    await fx.event({ calendar: work, summary: 'Scadenza di sistema', source: 'system', start_time: romeIso('2027-05-07', '09:00'), end_time: romeIso('2027-05-07', '10:00') });
  }
  await fx.event({ calendar: work, summary: 'A cavallo della settimana', start_time: romeIso('2027-05-09', '23:00'), end_time: romeIso('2027-05-10', '01:00') });
  await fx.series({
    calendar: work, summary: 'Standup',
    start_time: romeIso('2027-05-03', '08:45'), end_time: romeIso('2027-05-03', '09:00'),
    rrule: 'FREQ=DAILY;COUNT=5',
    overrides: [{ originalStart: romeIso('2027-05-05', '08:45'), status: 'cancelled' }],
  });
  await fx.event({ calendar: notes, summary: 'Promemoria lungo', start_time: romeIso('2027-05-04', '09:00'), end_time: romeIso('2027-05-04', '12:00') });
  await fx.closure(holidays, { from: '2027-05-07' });
  await fx.booking({ eventType: session, start: romeIso('2027-05-06', '10:00') });
  await fx.booking({ eventType: short, start: romeIso('2027-05-06', '15:00'), status: 'pending' });
  await fx.booking({ eventType: session, start: romeIso('2027-05-07', '15:00'), status: 'cancelled' });

  // Settimana B (10-16 maggio): 35 ore (1 dall'evento a cavallo + 34 di sprint).
  await fx.event({ calendar: work, summary: 'Sprint', start_time: romeIso('2027-05-11', '00:00'), end_time: romeIso('2027-05-12', '10:00') });
  // Settimana C (17-23 maggio): 45 ore.
  await fx.event({ calendar: work, summary: 'Trasferta lunga', start_time: romeIso('2027-05-17', '00:00'), end_time: romeIso('2027-05-18', '21:00') });
  // Settimana D (24-30 maggio): 39,5 ore nel fine settimana, giorni feriali liberi.
  await fx.event({ calendar: work, summary: 'Weekend di lavoro', start_time: romeIso('2027-05-29', '00:00'), end_time: romeIso('2027-05-30', '15:30') });
  // Settimana E (31 maggio-6 giugno): festività del 2 e chiusura 3-4 nel calendario 'f'.
  await fx.holidays(holidays, { year: 2027, only: ['2027-06-02'] });
  await fx.closure(holidays, { from: '2027-06-03', to: '2027-06-04', summary: 'Ponte' });
  // Settimana F (7-13 giugno): timer avviato martedì alle 09:00 e mai fermato.
  await timeEntry({ start: romeIso('2027-06-08', '09:00'), end: null, billable: true, description: 'Timer dimenticato' });
  // Settimana G (14-20 giugno): 39,5 ore nel fine settimana, per le prenotazioni.
  await fx.event({ calendar: work, summary: 'Weekend pieno', start_time: romeIso('2027-06-19', '00:00'), end_time: romeIso('2027-06-20', '15:30') });
  // Cambio dell'ora: lunedì 29 marzo 00:15-00:45 (CEST) = 28 marzo 22:15Z.
  await fx.event({ calendar: work, summary: 'Notturno di lunedì', start_time: romeIso('2027-03-29', '00:15'), end_time: romeIso('2027-03-29', '00:45') });

  return { work, notes, holidays, session, short };
}

// Scenario dopo migrazioni, baseline e pre-pulizia (onDatabaseReady): i
// before() di primo livello su Node 22 partono in parallelo.
onDatabaseReady(async () => {
  await cleanupTimeData();
  const [row] = await sql<Array<{ value: string }>>`SELECT value::text AS value FROM site_settings WHERE key = ${STUDIO_SETTINGS_KEY}`;
  originalStudioSettings = row ? row.value : null;
  await setWeeklyCapacityHours(WEEKLY_HOURS);
  freezeTime(NOW);
  s = await buildScenario();
});

onBeforeDatabaseClose(async () => {
  await restoreStudioSettings();
  await cleanupTimeData();
});

after(() => {
  restoreTime();
  store.flush();
});

// ─── Utilità ───────────────────────────────

function record(caseId: string, res: TestResponse, request: HttpContractRequest): void {
  const n = createNormalizer({ prefixes: [fx.prefix] });
  store.check(caseId, responseEntry(res, n, { request }));
}

/** capacity-week con "adesso" all'istante indicato (poi l'orologio torna a NOW). */
async function capacityWeekAt(nowIso: string): Promise<TestResponse> {
  freezeTime(nowIso);
  try {
    return await api.get('/api/dashboard/capacity-week', { auth: 'admin' });
  } finally {
    freezeTime(NOW);
  }
}

function getSlots(eventType: EventType, from: string, to: string): Promise<TestResponse> {
  return api.get(`/api/calendar/event-types/${eventType.slug}/slots`, { query: { from, to } });
}

/** Slot per data come ore di Roma. */
async function slotHours(eventType: EventType, from: string, to: string): Promise<Record<string, string[]>> {
  const res = await getSlots(eventType, from, to);
  assert.equal(res.status, 200, res.text);
  return romeHoursByDate(res.json.slots_by_date);
}

const FULL_DAY_60 = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'];
const FULL_DAY_30 = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
];

// ─── capacity-week ───────────────────────────────

test('capacity-week: richiede un admin (401 senza token, 403 per altri ruoli)', async () => {
  const anonymous = await api.get('/api/dashboard/capacity-week');
  assert.equal(anonymous.status, 401);
  const client = await api.get('/api/dashboard/capacity-week', { auth: { bearer: await signTestToken({ role: 'client' }) } });
  assert.equal(client.status, 403);
});

test('capacity-week: ore, conteggi ed esclusioni di una settimana mista (light)', async () => {
  const res = await capacityWeekAt(romeIso('2027-05-05', '10:00'));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.json), [
    'week_start', 'week_end', 'hours_planned', 'hours_available', 'ratio', 'status',
    'billable_hours', 'running_timers', 'breakdown',
  ]);
  // BUG ATTUALE: settimana ISO 3-9 maggio, ma le date sono la data UTC della
  // mezzanotte di Roma (2 maggio 22:00Z) e della mezzanotte finale meno 24 ore.
  assert.equal(res.json.week_start, '2027-05-02');
  assert.equal(res.json.week_end, '2027-05-08');

  assert.deepEqual(res.json.breakdown, [
    // 2 h fatturabili + 1 h non fatturabile + 1 h della voce a cavallo della domenica.
    { source: 'time_entries', hours: 4, count: 3 },
    // Confermata 1 h + pending 30 min; l'annullata no.
    { source: 'calendar:booking', hours: 1.5, count: 2 },
    // Riunione 2 h + 1 h dell'evento a cavallo (dentro la settimana) + 4
    // standup da 15 min (il quinto è cancellato con override). Esclusi:
    // all-day, tentative, cancellati, source 'system', calendario non
    // bloccante, chiusura in 'f' e proiezione della prenotazione.
    { source: 'calendar:manual', hours: 4, count: 6 },
    { source: 'calendar:admin', hours: 1, count: 1 },
    { source: 'calendar:mcp', hours: 0.5, count: 1 },
  ]);
  assert.equal(res.json.hours_planned, 11);
  assert.equal(res.json.hours_available, WEEKLY_HOURS);
  assert.equal(res.json.ratio, 0.28);
  assert.equal(res.json.status, 'light');
  assert.equal(res.json.billable_hours, 3);
  assert.equal(res.json.running_timers, 0);
  record('capacity-week/settimana-mista', res, { method: 'GET', path: '/api/dashboard/capacity-week', auth: 'admin' });
});

test('capacity-week: soglie optimal (≤ 100%) e overbooked (> 100%)', async () => {
  // Settimana B: 1 h dell'evento a cavallo + 34 h di sprint = 35 h su 40.
  const optimal = await capacityWeekAt(romeIso('2027-05-12', '10:00'));
  assert.equal(optimal.json.hours_planned, 35);
  assert.equal(optimal.json.ratio, 0.88);
  assert.equal(optimal.json.status, 'optimal');
  assert.deepEqual(optimal.json.breakdown.map((b: { source: string }) => b.source), ['time_entries', 'calendar:booking', 'calendar:manual']);
  record('capacity-week/optimal', optimal, { method: 'GET', path: '/api/dashboard/capacity-week', auth: 'admin' });

  // Settimana C: 45 h su 40.
  const overbooked = await capacityWeekAt(romeIso('2027-05-19', '10:00'));
  assert.equal(overbooked.json.hours_planned, 45);
  assert.equal(overbooked.json.ratio, 1.13);
  assert.equal(overbooked.json.status, 'overbooked');
  record('capacity-week/overbooked', overbooked, { method: 'GET', path: '/api/dashboard/capacity-week', auth: 'admin' });
});

test("capacity-week: festività e chiusure del calendario 'f' non consumano capacità", async () => {
  const res = await capacityWeekAt(romeIso('2027-05-31', '10:00'));
  assert.equal(res.status, 200);
  assert.equal(res.json.hours_planned, 0);
  assert.equal(res.json.status, 'light');
  assert.deepEqual(res.json.breakdown, [
    { source: 'time_entries', hours: 0, count: 0 },
    { source: 'calendar:booking', hours: 0, count: 0 },
  ]);
  record('capacity-week/festivita-esclusa', res, { method: 'GET', path: '/api/dashboard/capacity-week', auth: 'admin' });
});

test('capacity-week: weekly_capacity_hours da site_settings (rapporto 1,0 → optimal)', async () => {
  await setWeeklyCapacityHours(11);
  try {
    const res = await capacityWeekAt(romeIso('2027-05-05', '10:00'));
    assert.equal(res.json.hours_available, 11);
    assert.equal(res.json.hours_planned, 11);
    assert.equal(res.json.ratio, 1);
    assert.equal(res.json.status, 'optimal');
    record('capacity-week/capacita-11-ore', res, { method: 'GET', path: '/api/dashboard/capacity-week', auth: 'admin' });

    // Con la settimana esattamente piena spariscono anche gli slot pubblici.
    assert.deepEqual(await slotHours(s.short, '2027-05-06', '2027-05-07'), { '2027-05-06': [], '2027-05-07': [] });
  } finally {
    await setWeeklyCapacityHours(WEEKLY_HOURS);
  }
  const restored = await slotHours(s.short, '2027-05-06', '2027-05-06');
  assert.ok(restored['2027-05-06'].length > 0, 'con 40 ore gli slot del 6 maggio tornano');
});

test('capacity-week: un timer in corso conta fino alla fine della settimana', async () => {
  // Timer avviato martedì 8 giugno alle 09:00 e mai fermato; "adesso" alle 10:00.
  const res = await capacityWeekAt(romeIso('2027-06-08', '10:00'));
  assert.equal(res.status, 200);
  assert.equal(res.json.running_timers, 1);
  // COMPORTAMENTO ATTUALE (da valutare): LEAST(end_time, fine settimana)
  // ignora il NULL, quindi il timer vale da martedì 09:00 a lunedì 00:00
  // (135 h) e non fino ad "adesso" (1 h). Le voci concluse sono 0.
  assert.deepEqual(res.json.breakdown[0], { source: 'time_entries', hours: 135, count: 0 });
  assert.equal(res.json.billable_hours, 0, 'il timer in corso non è fatturabile finché non si ferma');
  assert.equal(res.json.status, 'overbooked');
  record('capacity-week/timer-in-corso', res, { method: 'GET', path: '/api/dashboard/capacity-week', auth: 'admin' });
});

test("capacity-week: settimane attorno al cambio dell'ora (bug: confini spostati di un'ora)", async () => {
  // Settimana del 22 marzo (CET): inizio 21 marzo 23:00Z, fine +7 giorni in
  // UTC = 28 marzo 23:00Z, cioè lunedì 29 alle 01:00 CEST invece che alle 00:00.
  const beforeChange = await capacityWeekAt(romeIso('2027-03-26', '10:00'));
  assert.equal(beforeChange.json.week_start, '2027-03-21');
  assert.equal(beforeChange.json.week_end, '2027-03-27');
  // BUG ATTUALE: il "Notturno di lunedì" (29 marzo 00:15-00:45) è contato nella
  // settimana precedente...
  assert.deepEqual(beforeChange.json.breakdown.slice(2), [{ source: 'calendar:manual', hours: 0.5, count: 1 }]);
  record('capacity-week/cambio-ora-settimana-prima', beforeChange, { method: 'GET', path: '/api/dashboard/capacity-week', auth: 'admin' });

  // ...e anche nella sua (inizio 28 marzo 22:00Z).
  const afterChange = await capacityWeekAt(romeIso('2027-03-30', '10:00'));
  assert.equal(afterChange.json.week_start, '2027-03-28');
  assert.deepEqual(afterChange.json.breakdown.slice(2), [{ source: 'calendar:manual', hours: 0.5, count: 1 }]);
  record('capacity-week/cambio-ora-settimana-dopo', afterChange, { method: 'GET', path: '/api/dashboard/capacity-week', auth: 'admin' });
});

// ─── Capacità e slot pubblici ───────────────────────────────

test('slots: una settimana oltre la capacità non ha slot, anche nei giorni liberi', async () => {
  // Settimana C (45 h): lunedì e martedì occupati dall'evento, mercoledì-venerdì
  // liberi in calendario ma filtrati dalla capacità.
  const res = await getSlots(s.session, '2027-05-17', '2027-05-21');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(romeHoursByDate(res.json.slots_by_date), {
    '2027-05-17': [], '2027-05-18': [], '2027-05-19': [], '2027-05-20': [], '2027-05-21': [],
  });
  assert.deepEqual(res.json.slots, []);
  record('slots/settimana-oltre-capacita', res, {
    method: 'GET', path: `/api/calendar/event-types/${s.session.slug}/slots`, query: { from: '2027-05-17', to: '2027-05-21' },
  });
});

test('slots: con 30 minuti di capacità residua restano gli slot da 30 e spariscono quelli da 60', async () => {
  // Settimana D: 39,5 h nel fine settimana. Il filtro vale per singolo slot:
  // ogni slot da 30 minuti entra (39,5 + 0,5 = 40), quelli da 60 no.
  const query = { from: '2027-05-24', to: '2027-05-28' };
  const session = await getSlots(s.session, query.from, query.to);
  assert.deepEqual(romeHoursByDate(session.json.slots_by_date), {
    '2027-05-24': [], '2027-05-25': [], '2027-05-26': [], '2027-05-27': [], '2027-05-28': [],
  });
  record('slots/residuo-30-minuti-sessione-60', session, {
    method: 'GET', path: `/api/calendar/event-types/${s.session.slug}/slots`, query,
  });

  const short = await getSlots(s.short, query.from, query.to);
  assert.deepEqual(romeHoursByDate(short.json.slots_by_date), {
    '2027-05-24': FULL_DAY_30, '2027-05-25': FULL_DAY_30, '2027-05-26': FULL_DAY_30,
    '2027-05-27': FULL_DAY_30, '2027-05-28': FULL_DAY_30,
  });
  record('slots/residuo-30-minuti-breve-30', short, {
    method: 'GET', path: `/api/calendar/event-types/${s.short.slug}/slots`, query,
  });
});

test("slots: festività e chiusure tolgono i loro giorni ma non la capacità degli altri", async () => {
  const query = { from: '2027-05-31', to: '2027-06-04' };
  const res = await getSlots(s.session, query.from, query.to);
  assert.deepEqual(romeHoursByDate(res.json.slots_by_date), {
    '2027-05-31': FULL_DAY_60,
    '2027-06-01': FULL_DAY_60,
    '2027-06-02': [],
    '2027-06-03': [],
    '2027-06-04': [],
  });
  record('slots/festivita-e-chiusure', res, {
    method: 'GET', path: `/api/calendar/event-types/${s.session.slug}/slots`, query,
  });
});

test('slots: un timer in corso svuota gli slot del resto della settimana', async () => {
  // COMPORTAMENTO ATTUALE (vedi capacity-week/timer-in-corso): il timer di
  // martedì 8 giugno vale 135 h, quindi tutta la settimana risulta piena.
  const query = { from: '2027-06-07', to: '2027-06-11' };
  const res = await getSlots(s.short, query.from, query.to);
  assert.deepEqual(romeHoursByDate(res.json.slots_by_date), {
    '2027-06-07': [], '2027-06-08': [], '2027-06-09': [], '2027-06-10': [], '2027-06-11': [],
  });
  record('slots/timer-in-corso', res, {
    method: 'GET', path: `/api/calendar/event-types/${s.short.slug}/slots`, query,
  });
});

// ─── Capacità e prenotazioni ───────────────────────────────

test('prenotazioni: la capacità residua si consuma e poi rifiuta (admin) o 409 (sito)', async () => {
  // Settimana G: 39,5 h nel fine settimana. Una prenotazione da 30 minuti
  // riempie la settimana (40 h esatte).
  const first = await fx.bookingViaLib({ eventType: s.short, start: romeIso('2027-06-16', '10:00'), source: 'admin_manual' });
  assert.equal(first.booking.status, 'confirmed');

  // Percorso admin/MCP (senza require_available_slot): errore di capacità.
  await assert.rejects(
    fx.bookingViaLib({ eventType: s.short, start: romeIso('2027-06-16', '11:00'), source: 'admin_manual' }),
    (err: unknown) => err instanceof BookingConflictError && err.message === 'Capacita settimanale esaurita: scegli un altro slot',
  );

  // Percorso pubblico: lo slot non è più tra quelli proposti → 409.
  const body = {
    event_type_slug: s.short.slug,
    start: romeIso('2027-06-17', '10:00'),
    attendee: { name: 'Cliente dal sito', email: fx.email('sito'), timezone: 'Europe/Rome' },
    gdpr_consent: true,
  };
  const res = await api.post('/api/calendar/bookings', { body });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'Orario non più disponibile: scegli uno degli slot proposti', code: 'BOOKING_CONFLICT' });
  record('bookings/409-capacita-esaurita', res, { method: 'POST', path: '/api/calendar/bookings', body });

  const week = await capacityWeekAt(romeIso('2027-06-16', '12:00'));
  assert.equal(week.json.hours_planned, 40);
  assert.equal(week.json.ratio, 1);
  assert.equal(week.json.status, 'optimal');
  assert.deepEqual(week.json.breakdown.slice(0, 2), [
    { source: 'time_entries', hours: 0, count: 0 },
    { source: 'calendar:booking', hours: 0.5, count: 1 },
  ]);
  record('capacity-week/settimana-piena-con-prenotazione', week, { method: 'GET', path: '/api/dashboard/capacity-week', auth: 'admin' });
});

test.todo('capacity-week: week_start e week_end come date di Roma (lunedì e domenica)');
test.todo("capacity: confini delle settimane in ora di Roma anche dopo il cambio dell'ora");
test.todo('capacity: un timer in corso conta fino ad "adesso", non fino alla fine della settimana');

// ─── Copertura ───────────────────────────────

// Dopo tutti i casi: fallisce se nello snapshot restano casi non più eseguiti.
contractCoverageTest(store, 'capacity-and-slots.contract.test.ts');
