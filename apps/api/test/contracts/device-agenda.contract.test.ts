/**
 * Contratto dell'agenda del device ePaper (F0, design §12 "Agenda device" e §15;
 * corretto in F2): GET /api/device/agenda?date=YYYY-MM-DD con Bearer dvt_<32 hex>.
 *
 * Si congelano: autenticazione propria del device (token dvt_ attivo, non
 * revocato, non scaduto; JWT admin e token MCP rifiutati), contatore d'uso,
 * forma della risposta ({date, events, next_event, last_event_end,
 * pending_tasks, pending_notes}) e contenuto: eventi di tutti i calendari
 * (bloccanti e no, proiezioni delle prenotazioni, iscrizioni ICS, festività),
 * esclusi i cancellati, ordinati per inizio; next_event e last_event_end sui
 * soli eventi timed. Pairing dall'admin (POST /api/device/admin/pair) per il
 * percorso con cui i token nascono.
 *
 * pending_tasks e pending_notes contano righe di tabelle globali (project_tasks,
 * device_notes): negli snapshot diventano '<conteggio>', e un test dedicato ne
 * verifica i filtri sullo stato come differenza da una base letta dall'agenda
 * stessa, con righe del prefisso (cliente, progetto, task e note) ripulite a
 * fine file.
 *
 * Gli snapshot sono in __snapshots__/device-agenda.contract.json e restano la
 * baseline F0 (PgLegacyStore con il codice di prima). Dalla F2 l'agenda passa a
 * store.listOccurrences sulla finestra del giorno di Roma, con la stessa forma
 * JSON, su entrambi gli store (design §12 "Agenda device", §14 "Agenda device
 * senza espansione e con giorno UTC"): le differenze rispetto alla baseline sono
 * le voci "agenda-device-*" di allowed-diffs.json. Correzioni verificate qui:
 *  - le serie sono espanse: ogni giorno mostra la propria occorrenza, e un
 *    override spostato sostituisce l'occorrenza del master;
 *  - il giorno è quello di Roma (mezzanotte-mezzanotte, DST compreso): un evento
 *    alle 00:15 di Roma sta nel suo giorno, un all-day e una festività timed
 *    00:00→24:00 non compaiono più nel giorno precedente, e la data di default
 *    è quella di Roma.
 * Resta com'è (decisione 5, da rivedere quando esisterà il flag per singola
 * iscrizione): le iscrizioni ICS compaiono sempre.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { onBeforeDatabaseClose, onDatabaseReady, sql } from '../helpers/db';
import { api, signTestToken, type TestResponse } from '../helpers/http';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { createNormalizer, type SnapshotNormalizer } from '../helpers/normalize';
import { freezeTime, restoreTime } from '../helpers/clock';
import { useCalendarBackend } from '../helpers/calendar-backend';
import type { Calendar } from '../../src/lib/calendar/types';
import {
  contractCoverageTest,
  type HttpContractRequest,
  httpContractStore,
  responseEntry,
  type ResponseEntryOptions,
  romeHour,
} from './_http-contract';

const fx = useFixtures('contratto-agenda', { resetBaseline: true });
useCalendarBackend();

const store = httpContractStore(
  'device-agenda',
  'device-agenda.contract.test.ts',
  "Agenda del device GET /api/device/agenda (e ping/pairing per l'autenticazione) sullo scenario di " +
    'test/contracts/device-agenda.contract.test.ts: richiesta, status, header e corpo normalizzati; ' +
    "pending_tasks e pending_notes dipendono da tabelle globali e sono sostituiti da '<conteggio>' " +
    '(i filtri sullo stato sono verificati nel test come differenza da una base). Baseline F0 su PgLegacyStore.',
);

/** "Adesso": mercoledì 10 marzo 2027, 10:30 a Roma (09:30Z). */
const NOW = '2027-03-10T09:30:00.000Z';

interface Scenario {
  work: Calendar;
  personal: Calendar;
  external: Calendar;
  holidays: Calendar;
  device: { token: string; id: string };
}

let s: Scenario;

// ─── Scenario ───────────────────────────────

async function buildScenario(): Promise<Scenario> {
  const work = await fx.calendar({ key: 'lavoro', name: 'Lavoro', blocks_availability: true });
  const personal = await fx.calendar({ key: 'personale', name: 'Personale', blocks_availability: false });
  const external = await fx.calendar({ key: 'esterno', name: 'Google esterno', blocks_availability: false });
  const holidays = await fx.holidayCalendar();

  // Mercoledì 10 marzo (ore di Roma).
  await fx.event({ calendar: work, summary: 'Colazione di lavoro', start_time: romeIso('2027-03-10', '08:00'), end_time: romeIso('2027-03-10', '09:00') });
  await fx.event({ calendar: work, summary: 'Call con il cliente', start_time: romeIso('2027-03-10', '11:00'), end_time: romeIso('2027-03-10', '12:00') });
  await fx.event({ calendar: personal, summary: 'Dentista', start_time: romeIso('2027-03-10', '15:00'), end_time: romeIso('2027-03-10', '16:00') });
  await fx.event({ calendar: work, summary: 'Forse aperitivo', status: 'tentative', start_time: romeIso('2027-03-10', '18:30'), end_time: romeIso('2027-03-10', '19:00') });
  await fx.event({ calendar: work, summary: 'Annullato', status: 'cancelled', start_time: romeIso('2027-03-10', '17:00'), end_time: romeIso('2027-03-10', '18:00') });
  await fx.allDayEvent({ calendar: work, summary: 'Trasferta Milano', date: '2027-03-10' });
  // Giovedì 11 alle 00:15 di Roma = mercoledì 10 alle 23:15Z.
  await fx.event({ calendar: work, summary: 'Notturno', start_time: romeIso('2027-03-11', '00:15'), end_time: romeIso('2027-03-11', '00:45') });
  await fx.event({ calendar: work, summary: 'Revisione del giovedì', start_time: romeIso('2027-03-11', '10:00'), end_time: romeIso('2027-03-11', '11:00') });
  // Serie giornaliera dal 9 marzo, 09:15-09:30, con l'occorrenza del 12 spostata.
  await fx.series({
    calendar: work, summary: 'Standup',
    start_time: romeIso('2027-03-09', '09:15'), end_time: romeIso('2027-03-09', '09:30'),
    rrule: 'FREQ=DAILY;COUNT=5',
    overrides: [{ originalStart: romeIso('2027-03-12', '09:15'), start: romeIso('2027-03-12', '10:00'), end: romeIso('2027-03-12', '10:15') }],
  });
  // Proiezione di una prenotazione nel calendario 'bookings'.
  const eventType = await fx.eventType({ key: 'consulenza', title: 'Consulenza', durationMinutes: 60 });
  await fx.booking({ eventType, start: romeIso('2027-03-10', '14:00'), attendee: { name: 'Mario Rossi' } });
  // Evento di un'iscrizione ICS.
  await fx.subscription({
    calendar: external,
    events: [{
      remote_uid: 'pranzo@example.test', summary: 'Pranzo (Google)',
      description: null, location: null, url: null,
      start_time: romeIso('2027-03-10', '12:30'), end_time: romeIso('2027-03-10', '13:00'),
      all_day: false, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed',
    }],
  });
  // Festività del 2 giugno nel calendario 'f' (timed 00:00→24:00 di Roma).
  await fx.holidays(holidays, { year: 2027, only: ['2027-06-02'] });

  const device = await fx.deviceToken();
  return { work, personal, external, holidays, device };
}

// Scenario dopo migrazioni, baseline e pre-pulizia (onDatabaseReady): i
// before() di primo livello su Node 22 partono in parallelo.
onDatabaseReady(async () => {
  freezeTime(NOW);
  s = await buildScenario();
});

after(() => {
  restoreTime();
  store.flush();
});

// ─── Task e note per i contatori ───────────────────────────────

/**
 * Rimuove cliente, progetto, task e note del prefisso, con le righe di audit
 * (customers, client_projects) e webhook (customers) scritte dai trigger. Le
 * note seguono comunque il token del device (ON DELETE CASCADE nella pulizia
 * delle fixture); qui si cancellano prima per non dipendere dall'ordine.
 */
async function cleanupCounterData(): Promise<void> {
  const like = `${fx.prefix}%`;
  await sql`
    DELETE FROM device_notes
    WHERE token_id IN (SELECT id FROM device_tokens WHERE label LIKE ${like})
  `;
  const customers = (await sql<Array<{ id: string }>>`
    SELECT id FROM customers WHERE contact_name LIKE ${like}
  `).map((r) => r.id);
  const projects = (await sql<Array<{ id: string }>>`
    SELECT id FROM client_projects WHERE name LIKE ${like} OR customer_id = ANY(${customers}::uuid[])
  `).map((r) => r.id);
  if (!customers.length && !projects.length) return;
  await sql`DELETE FROM project_tasks WHERE project_id = ANY(${projects}::uuid[])`;
  await sql`DELETE FROM client_projects WHERE id = ANY(${projects}::uuid[])`;
  await sql`DELETE FROM customers WHERE id = ANY(${customers}::uuid[])`;
  await sql`DELETE FROM audit_logs WHERE record_id = ANY(${[...customers, ...projects]}::text[])`;
  await sql`DELETE FROM webhook_events WHERE entity_id = ANY(${customers}::uuid[])`;
}

// Pre-pulizia (righe rimaste da un run interrotto) e pulizia a fine file,
// prima di quella delle fixture (i task di chiusura girano in ordine inverso).
onDatabaseReady(cleanupCounterData);
onBeforeDatabaseClose(cleanupCounterData);

/** Task di progetto con gli stati indicati, sotto un cliente e un progetto del prefisso. */
async function insertTasks(statuses: string[]): Promise<void> {
  const [customer] = await sql<Array<{ id: string }>>`
    INSERT INTO customers (contact_name) VALUES (${fx.name('Cliente agenda')}) RETURNING id
  `;
  const [project] = await sql<Array<{ id: string }>>`
    INSERT INTO client_projects (customer_id, name) VALUES (${customer.id}::uuid, ${fx.name('Progetto agenda')}) RETURNING id
  `;
  for (const [i, status] of statuses.entries()) {
    await sql`
      INSERT INTO project_tasks (project_id, title, status)
      VALUES (${project.id}::uuid, ${fx.name(`Task ${i + 1} ${status}`)}, ${status}::task_status)
    `;
  }
}

/** Note vocali del device con gli stati indicati (nessun file audio: il contatore legge solo lo stato). */
async function insertNotes(tokenId: string, statuses: string[]): Promise<void> {
  for (const [i, status] of statuses.entries()) {
    await sql`
      INSERT INTO device_notes (token_id, audio_path, audio_bytes, duration_ms, tag, status)
      VALUES (${tokenId}::uuid, ${`${fx.prefix}/nota-${i + 1}.wav`}, 0, 1000, 'note', ${status})
    `;
  }
}

// ─── Utilità ───────────────────────────────

function normalizer(): SnapshotNormalizer {
  return createNormalizer({ prefixes: [fx.prefix] }).alias(s.device.token, 'token:device');
}

function record(
  caseId: string,
  res: TestResponse,
  request: HttpContractRequest,
  opts: Omit<ResponseEntryOptions, 'request'> = {},
): void {
  store.check(caseId, responseEntry(res, normalizer(), { request, ...opts }));
}

/** Corpo dell'agenda per lo snapshot, con i conteggi globali sostituiti. */
function agendaBody(json: Record<string, unknown>): unknown {
  return { ...json, pending_tasks: '<conteggio>', pending_notes: '<conteggio>' };
}

/** GET dell'agenda con il token del device dello scenario. */
async function agenda(date?: string): Promise<TestResponse> {
  return api.get('/api/device/agenda', { auth: { bearer: s.device.token }, query: { date } });
}

/** Eventi come [ora di Roma, titolo senza prefisso, all_day, source, status]. */
function eventsSummary(json: { events: Array<{ summary: string; start_time: string; all_day: boolean; source: string; status: string }> }): unknown[] {
  return json.events.map((e) => [romeHour(e.start_time), e.summary.replace(`${fx.prefix} `, ''), e.all_day, e.source, e.status]);
}

// ─── Autenticazione ───────────────────────────────

test('auth: solo token device attivi; JWT admin, token MCP, sconosciuti, revocati e scaduti → 401', async () => {
  const path = '/api/device/agenda';
  const query = { date: '2027-03-10' };
  const required = { error: 'Device token richiesto' };
  const invalid = { error: 'Device token non valido' };

  const anonymous = await api.get(path, { query });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.json, required);
  record('auth/401-senza-token', anonymous, { method: 'GET', path, query, auth: 'nessuna' });

  const admin = await api.get(path, { query, auth: 'admin' });
  assert.equal(admin.status, 401, 'il JWT admin non vale come token device');
  assert.deepEqual(admin.json, required);
  record('auth/401-jwt-admin', admin, { method: 'GET', path, query, auth: 'admin' });

  const mcp = await fx.mcpToken({ scope: 'admin' });
  const mcpRes = await api.get(path, { query, auth: { bearer: mcp.token } });
  assert.equal(mcpRes.status, 401);
  assert.deepEqual(mcpRes.json, required);

  const unknown = await api.get(path, { query, auth: { bearer: `dvt_${'0'.repeat(32)}` } });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.json, invalid);
  record('auth/401-token-sconosciuto', unknown, { method: 'GET', path, query, auth: 'device sconosciuto' });

  // Revoca dall'admin (DELETE /api/device/admin/tokens/:id).
  const revoked = await fx.deviceToken();
  assert.equal((await api.get(path, { query, auth: { bearer: revoked.token } })).status, 200);
  const revoke = await api.delete(`/api/device/admin/tokens/${revoked.id}`, { auth: 'admin' });
  assert.equal(revoke.status, 200, revoke.text);
  assert.deepEqual(revoke.json, { success: true });
  const afterRevoke = await api.get(path, { query, auth: { bearer: revoked.token } });
  assert.equal(afterRevoke.status, 401);
  assert.deepEqual(afterRevoke.json, invalid);
  record('auth/401-token-revocato', afterRevoke, { method: 'GET', path, query, auth: 'device revocato' });

  // Scadenza confrontata con "adesso" (orologio fermo al 10 marzo 2027).
  const expired = await fx.deviceToken();
  await sql`UPDATE device_tokens SET expires_at = '2027-03-01T00:00:00Z' WHERE id = ${expired.id}::uuid`;
  const expiredRes = await api.get(path, { query, auth: { bearer: expired.token } });
  assert.equal(expiredRes.status, 401);
  assert.deepEqual(expiredRes.json, { error: 'Device token scaduto' });
  record('auth/401-token-scaduto', expiredRes, { method: 'GET', path, query, auth: 'device scaduto' });

  // Anche ping usa la stessa autenticazione.
  assert.equal((await api.get('/api/device/ping')).status, 401);
  const ping = await api.get('/api/device/ping', { auth: { bearer: s.device.token } });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json, { ok: true, now: NOW });
  record('auth/ping', ping, { method: 'GET', path: '/api/device/ping', auth: 'device' });
});

test('auth: ogni richiesta autenticata incrementa usage_count e aggiorna last_used_at', async () => {
  const device = await fx.deviceToken();
  for (let i = 0; i < 2; i++) {
    assert.equal((await api.get('/api/device/agenda', { auth: { bearer: device.token }, query: { date: '2027-03-10' } })).status, 200);
  }
  const [row] = await sql<Array<{ usage_count: number; last_used_at: Date | null }>>`
    SELECT usage_count, last_used_at FROM device_tokens WHERE id = ${device.id}::uuid
  `;
  assert.equal(row.usage_count, 2);
  assert.ok(row.last_used_at, 'last_used_at valorizzato (NOW() del database)');
});

test("pairing: POST /api/device/admin/pair richiede l'admin e restituisce il token una volta sola", async () => {
  const body = { label: fx.name('ePaper scrivania'), expires_days: 30 };
  assert.equal((await api.post('/api/device/admin/pair', { body })).status, 401);
  assert.equal((await api.post('/api/device/admin/pair', { body, auth: { bearer: s.device.token } })).status, 401,
    'un token device non può creare altri token');
  const client = await api.post('/api/device/admin/pair', { body, auth: { bearer: await signTestToken({ role: 'client' }) } });
  assert.equal(client.status, 403);

  const res = await api.post('/api/device/admin/pair', { body, auth: 'admin' });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(Object.keys(res.json), ['device_token', 'id', 'token_prefix', 'label', 'expires_at', 'created_at']);
  assert.match(res.json.device_token, /^dvt_[0-9a-f]{32}$/);
  assert.equal(res.json.token_prefix, res.json.device_token.slice(0, 12));
  // Scadenza: 30 giorni da "adesso".
  assert.equal(new Date(res.json.expires_at).toISOString(), '2027-04-09T09:30:00.000Z');
  fx.track('deviceTokenIds', res.json.id);
  // device_token e token_prefix diventano <token:N> (chiavi di token del normalizzatore).
  record('pairing/201', res, { method: 'POST', path: '/api/device/admin/pair', body, auth: 'admin' });

  const paired = await api.get('/api/device/agenda', { auth: { bearer: res.json.device_token }, query: { date: '2027-03-10' } });
  assert.equal(paired.status, 200);
});

// ─── Agenda ───────────────────────────────

test('agenda: giorno con eventi di tutti i calendari, next_event e last_event_end', async () => {
  const res = await agenda('2027-03-10');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.json), ['date', 'events', 'next_event', 'last_event_end', 'pending_tasks', 'pending_notes']);
  assert.equal(res.json.date, '2027-03-10');
  for (const e of res.json.events) {
    assert.deepEqual(Object.keys(e), ['summary', 'start_time', 'end_time', 'all_day', 'source', 'status']);
  }

  assert.deepEqual(eventsSummary(res.json), [
    // All-day del 10 (dalla mezzanotte di Roma = 23:00Z del 9).
    ['00:00', 'Trasferta Milano', true, 'manual', 'confirmed'],
    ['08:00', 'Colazione di lavoro', false, 'manual', 'confirmed'],
    // Serie espansa (F2): l'occorrenza del 10 dello Standup.
    ['09:15', 'Standup', false, 'manual', 'confirmed'],
    ['11:00', 'Call con il cliente', false, 'manual', 'confirmed'],
    // Iscrizione ICS: compare sempre, anche se il calendario non blocca.
    ['12:30', 'Pranzo (Google)', false, 'ics_pull', 'confirmed'],
    // Proiezione della prenotazione nel calendario 'bookings'.
    ['14:00', 'Consulenza – Mario Rossi', false, 'booking', 'confirmed'],
    ['15:00', 'Dentista', false, 'manual', 'confirmed'],
    ['18:30', 'Forse aperitivo', false, 'manual', 'tentative'],
  ]);
  // Giorno di Roma (F2): il "Notturno" di giovedì 11 alle 00:15 di Roma (23:15Z
  // del 10) non è più in questo giorno, e "Annullato" resta escluso.
  assert.ok(!res.json.events.some((e: { summary: string }) => e.summary.endsWith('Notturno') || e.summary.endsWith('Annullato')));

  // next_event: primo evento timed non ancora finito alle 10:30 (lo Standup
  // 09:15-09:30 è già finito); gli all-day non contano. last_event_end: fine
  // dell'ultimo timed della lista.
  assert.deepEqual(res.json.next_event, {
    summary: `${fx.prefix} Call con il cliente`,
    start_time: romeIso('2027-03-10', '11:00'),
    end_time: romeIso('2027-03-10', '12:00'),
  });
  assert.equal(res.json.last_event_end, romeIso('2027-03-10', '19:00'));
  // I valori dipendono da tabelle globali: qui solo il tipo, i filtri nel test dedicato.
  assert.ok(Number.isInteger(res.json.pending_tasks) && res.json.pending_tasks >= 0);
  assert.ok(Number.isInteger(res.json.pending_notes) && res.json.pending_notes >= 0);

  record('agenda/2027-03-10', res, { method: 'GET', path: '/api/device/agenda', query: { date: '2027-03-10' }, auth: 'device' }, {
    select: agendaBody,
  });
});

test('agenda: giorni adiacenti con le serie espanse e il giorno di Roma (design §12, §14)', async () => {
  // Martedì 9: la prima occorrenza dello Standup. L'all-day del 10, che in UTC
  // inizia alle 23:00 del 9, non compare più (giorno di Roma).
  const tuesday = await agenda('2027-03-09');
  assert.equal(tuesday.status, 200);
  assert.deepEqual(eventsSummary(tuesday.json), [
    ['09:15', 'Standup', false, 'manual', 'confirmed'],
  ]);
  // Il device è "a fine giornata": nessun evento timed ancora da iniziare.
  assert.equal(tuesday.json.next_event, null);
  record('agenda/2027-03-09', tuesday, { method: 'GET', path: '/api/device/agenda', query: { date: '2027-03-09' }, auth: 'device' }, {
    select: agendaBody,
  });

  // Giovedì 11: il "Notturno" delle 00:15 di Roma sta nel suo giorno e lo
  // Standup compare con la sua occorrenza.
  const thursday = await agenda('2027-03-11');
  assert.deepEqual(eventsSummary(thursday.json), [
    ['00:15', 'Notturno', false, 'manual', 'confirmed'],
    ['09:15', 'Standup', false, 'manual', 'confirmed'],
    ['10:00', 'Revisione del giovedì', false, 'manual', 'confirmed'],
  ]);
  record('agenda/2027-03-11', thursday, { method: 'GET', path: '/api/device/agenda', query: { date: '2027-03-11' }, auth: 'device' }, {
    select: agendaBody,
  });

  // Venerdì 12: l'override spostato alle 10:00 sostituisce l'occorrenza delle 09:15.
  const friday = await agenda('2027-03-12');
  assert.deepEqual(eventsSummary(friday.json), [
    ['10:00', 'Standup', false, 'manual', 'confirmed'],
  ]);
  record('agenda/2027-03-12', friday, { method: 'GET', path: '/api/device/agenda', query: { date: '2027-03-12' }, auth: 'device' }, {
    select: agendaBody,
  });
});

test("agenda: festività nel calendario 'f' come evento timed solo nel suo giorno di Roma", async () => {
  // 2 giugno 00:00→24:00 di Roma = 1 giugno 22:00Z → 2 giugno 22:00Z: con il
  // giorno di Roma (F2) il 1° giugno non la mostra più.
  const before = await agenda('2027-06-01');
  assert.equal(before.status, 200);
  assert.deepEqual(before.json.events, []);
  assert.equal(before.json.next_event, null);
  assert.equal(before.json.last_event_end, null);
  record('agenda/festivita-2027-06-01', before, { method: 'GET', path: '/api/device/agenda', query: { date: '2027-06-01' }, auth: 'device' }, {
    select: agendaBody,
  });

  const res = await agenda('2027-06-02');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.events.map((e: { summary: string; start_time: string; end_time: string; all_day: boolean; source: string }) =>
    [e.summary, e.start_time, e.end_time, e.all_day, e.source]), [
    ['Festa della Repubblica', '2027-06-01T22:00:00.000Z', '2027-06-02T22:00:00.000Z', false, 'system'],
  ]);
  // La festività è timed: è next_event e last_event_end del giorno.
  assert.equal(res.json.next_event?.summary, 'Festa della Repubblica');
  assert.equal(res.json.last_event_end, '2027-06-02T22:00:00.000Z');
  record('agenda/festivita-2027-06-02', res, { method: 'GET', path: '/api/device/agenda', query: { date: '2027-06-02' }, auth: 'device' }, {
    select: agendaBody,
  });
});

test("agenda: pending_tasks conta i task 'todo', pending_notes le note 'pending' e 'transcribing'", async () => {
  // Base letta dall'agenda stessa (non con una copia della query di
  // device.ts), poi righe del prefisso in tutti gli stati: i valori attesi
  // sono scritti a mano come differenza dalla base.
  const before = await agenda('2027-03-10');
  assert.equal(before.status, 200, before.text);

  // Due 'todo' (uno è un sotto-task: conta anche lui) e uno per ogni altro stato.
  await insertTasks(['todo', 'in_progress', 'review', 'done', 'blocked']);
  const [parent] = await sql<Array<{ id: string; project_id: string }>>`
    SELECT id, project_id FROM project_tasks WHERE title = ${fx.name('Task 1 todo')}
  `;
  await sql`
    INSERT INTO project_tasks (project_id, parent_task_id, title, status)
    VALUES (${parent.project_id}::uuid, ${parent.id}::uuid, ${fx.name('Sotto-task todo')}, 'todo')
  `;
  // Note di un device del gruppo (anche di un altro device: il conteggio è globale).
  const other = await fx.deviceToken();
  await insertNotes(s.device.id, ['pending', 'transcribing', 'done', 'failed']);
  await insertNotes(other.id, ['pending']);

  const res = await agenda('2027-03-10');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.pending_tasks - before.json.pending_tasks, 2, "task 'todo' (compreso il sotto-task)");
  assert.equal(res.json.pending_notes - before.json.pending_notes, 3, "note 'pending' e 'transcribing' di tutti i device");
  // Il resto della risposta non cambia.
  assert.deepEqual(
    { ...res.json, pending_tasks: 0, pending_notes: 0 },
    { ...before.json, pending_tasks: 0, pending_notes: 0 },
  );
});

test('agenda: data di default = oggi a Roma; 400 per una data non valida', async () => {
  // Giovedì 11 alle 00:30 di Roma è ancora il 10 in UTC: senza `date`
  // l'agenda mostra l'11, il giorno di Roma (F2; prima era il 10 UTC).
  freezeTime('2027-03-10T23:30:00.000Z');
  try {
    const res = await agenda();
    assert.equal(res.status, 200);
    assert.equal(res.json.date, '2027-03-11');
    assert.deepEqual(eventsSummary(res.json).map((e) => (e as unknown[])[1]), ['Notturno', 'Standup', 'Revisione del giovedì']);
    // Alle 00:30 di Roma il "Notturno" (00:15-00:45) è in corso: è next_event.
    assert.equal(res.json.next_event?.summary, `${fx.prefix} Notturno`);
    record('agenda/data-di-default', res, { method: 'GET', path: '/api/device/agenda', auth: 'device' }, { select: agendaBody });
  } finally {
    freezeTime(NOW);
  }

  // Una data con il formato giusto ma inesistente non è più un errore del database.
  const impossible = await agenda('2027-02-30');
  assert.equal(impossible.status, 400);
  assert.deepEqual(impossible.json, { error: 'date non valida (YYYY-MM-DD)' });

  for (const [name, date] of [['formato', '10/03/2027'], ['testo', 'oggi']] as const) {
    const res = await agenda(date);
    assert.equal(res.status, 400, name);
    assert.deepEqual(res.json, { error: 'date non valida (YYYY-MM-DD)' });
    record(`agenda/400-${name}`, res, { method: 'GET', path: '/api/device/agenda', query: { date }, auth: 'device' });
  }
});

test("agenda: giorno del cambio d'ora (23 ore) con la serie espansa all'ora di Roma", async () => {
  // Domenica 28 marzo 2027: le 02:00 diventano 03:00, il giorno di Roma dura 23
  // ore (27 marzo 23:00Z → 28 marzo 22:00Z). Una serie giornaliera alle 01:30 e
  // alle 23:30 di Roma resta nel giorno giusto prima e dopo il cambio.
  const cal = await fx.calendar({ key: 'agenda-dst', name: 'Agenda DST', blocks_availability: false });
  await fx.series({
    calendar: cal, summary: 'Notturna DST',
    start_time: romeIso('2027-03-27', '01:30'), end_time: romeIso('2027-03-27', '01:45'),
    rrule: 'FREQ=DAILY;COUNT=3',
  });
  await fx.event({ calendar: cal, summary: 'Tarda sera DST', start_time: romeIso('2027-03-28', '23:30'), end_time: romeIso('2027-03-28', '23:45') });
  const res = await agenda('2027-03-28');
  assert.equal(res.status, 200, res.text);
  const mine = res.json.events.filter((e: { summary: string }) => e.summary.includes('DST'));
  assert.deepEqual(mine.map((e: { summary: string; start_time: string }) => [e.summary.replace(`${fx.prefix} `, ''), e.start_time]), [
    ['Notturna DST', romeIso('2027-03-28', '01:30')],
    ['Tarda sera DST', romeIso('2027-03-28', '23:30')],
  ]);
  assert.equal(romeIso('2027-03-28', '01:30'), '2027-03-28T00:30:00.000Z', 'prima del cambio: UTC+1');
  assert.equal(romeIso('2027-03-28', '23:30'), '2027-03-28T21:30:00.000Z', 'dopo il cambio: UTC+2');
});

test.todo('agenda: iscrizioni ICS solo se "visibili sui device" (decisione 5)');

// ─── Copertura ───────────────────────────────

// Dopo tutti i casi: fallisce se nello snapshot restano casi non più eseguiti.
contractCoverageTest(store, 'device-agenda.contract.test.ts');
