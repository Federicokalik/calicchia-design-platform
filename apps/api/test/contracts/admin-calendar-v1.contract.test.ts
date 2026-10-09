/**
 * Contratto admin v1 del calendario (F0, design §12 e §15): le route
 * /api/admin/calendar/* che l'admin usa oggi, eseguite in-process contro
 * l'app reale con un JWT admin e congelate come baseline su PgLegacyStore.
 *
 * Copre calendari (CRUD, feed e blocco, rotazione del token), eventi (elenco
 * espanso, dettaglio, creazione, modifica parziale, eliminazione, eccezione
 * su singola occorrenza, duplicazione), chiusure, schedule di default e
 * override, tipi di prenotazione con anteprima degli slot, prenotazioni
 * (elenco, dettaglio, creazione manuale, approvazione, rifiuto, annullamento,
 * marcatura, riprogrammazione) e iscrizioni ICS (CRUD e sync con un server
 * remoto simulato: `fetch` è sostituito, nessuna richiesta esce in rete).
 *
 * Ogni risposta finisce in __snapshots__/admin-calendar-v1.contract.json come
 * voce `"<gruppo>/<caso>"` (richiesta, status, header del contratto, corpo
 * normalizzato ed eventuali effetti sul database), con le regole di
 * _http-contract.ts. In F2 gli stessi casi girano su entrambi gli store; le
 * sole differenze ammesse sono quelle motivate in allowed-diffs.json.
 *
 * Isolamento: ogni test crea i propri dati con le fixture e, dopo, la
 * pulizia riporta il dominio calendario alla baseline (afterEach), così un
 * caso dipende solo dal proprio test anche nei run filtrati. Le date sono
 * fisse nel 2030 e "adesso" è fermato con freezeTime(); i filtri che usano
 * NOW() di Postgres (chiusure degli ultimi 30 giorni, statistiche delle
 * prenotazioni degli ultimi 90) restano quindi stabili fino al 2030.
 *
 * Aggiornamento dello snapshot (dopo aver verificato che il cambiamento è voluto):
 *   UPDATE_SNAPSHOTS=1 pnpm --filter @calicchia/api test test/contracts/admin-calendar-v1.contract.test.ts
 *
 * Comportamenti attuali congelati qui e da correggere solo dopo F0 (design
 * §14), ciascuno commentato nel caso relativo:
 *  - GET /closures crea il calendario "Festività e chiusure" se non esiste;
 *  - GET /events perde le occorrenze di una serie già iniziate prima di `from`;
 *  - un EXDATE con l'ora UTC del DTSTART non combacia più dopo il cambio
 *    dell'ora (firma DST_SHIFTED_EXCEPTION, design §13.4);
 *  - GET /events/:id scambia un UID con forma di UUID per un id (404);
 *  - POST /events accetta qualsiasi `source` ammessa dal CHECK, anche
 *    'ics_pull', e l'evento diventa di sola lettura;
 *  - un override sopravvive (orfano) alla rimozione della rrule e al cambio
 *    di calendario del master, e un'eccezione fuori regola viene accettata;
 *  - la duplicazione di una serie mette la copia alla data del master;
 *  - approvazione e riprogrammazione proiettano l'evento con url null;
 *  - parseIcs scarta tutti i VEVENT di un VCALENDAR valido: il sync importa
 *    zero eventi e, con eventi già presenti, scatta la protezione anti-wipe;
 *  - fetchIcs tratta il 304 come un redirect senza Location: ogni sync
 *    condizionale (ETag salvato) fallisce con un errore invece di notModified;
 *  - DELETE /calendars/:id risponde 200 anche per un calendario inesistente;
 *  - event_count conta le righe non cancellate (master e override), non le occorrenze.
 */

import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import {
  cleanupCalendarAudit,
  databaseNow,
  onBeforeDatabaseClose,
  onDatabaseReady,
  SEED_CALENDAR_SLUGS,
  sql,
} from '../helpers/db';
import { api, request, signTestToken, type TestResponse } from '../helpers/http';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { freezeTime, restoreTime } from '../helpers/clock';
import { updateCalendar } from '../../src/lib/calendar/calendars';
import type { ParsedEvent } from '../../src/lib/calendar/ics-import';
import type { Calendar } from '../../src/lib/calendar/types';
import { contractCoverageTest, httpContractStore, responseEntry, romeHour, romeHoursByDate } from './_http-contract';
import {
  AdminAliases,
  bookingRows,
  calendarEventRows,
  calendarRow,
  defaultCalendarSlugs,
  eventRows,
  icsCalendar,
  overrideRows,
  projectionRows,
  registerSeedAliases,
  RemoteIcsServer,
  restoreDefaultSchedule,
  saveDefaultSchedule,
  subscriptionEventRows,
  subscriptionRow,
  type SeedRows,
} from './_admin-v1';

const fx = useFixtures('admin-v1', { resetBaseline: true });

const CONTRACT = 'admin-calendar-v1';
const TEST_FILE = 'admin-calendar-v1.contract.test.ts';
const store = httpContractStore(
  CONTRACT,
  TEST_FILE,
  "Route /api/admin/calendar/* usate dall'admin (calendari, eventi, chiusure, schedule, tipi di prenotazione, " +
    'prenotazioni, iscrizioni ICS con server remoto simulato), normalizzate (id, uid, token, timestamp di sistema), ' +
    'con gli effetti sul database delle scritture. Baseline F0 su PgLegacyStore.',
);

/** Lunedì 7 gennaio 2030, 08:00 a Roma: "adesso" per tutto il file. */
const NOW = '2030-01-07T07:00:00.000Z';
const BASE = '/api/admin/calendar';
/** UUID valido che non esiste in nessuna tabella. */
const MISSING_UUID = '00000000-0000-4000-8000-00000000dead';
/** UID di un evento con la forma di un UUID (come quelli di alcuni client CalDAV). */
const UUID_SHAPED_UID = '7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
/** Host del server ICS simulato: IP letterale pubblico (TEST-NET-3), nessun lookup DNS. */
const REMOTE = 'https://203.0.113.10';

const aliases = new AdminAliases();
aliases.add(MISSING_UUID, 'uuid:inesistente');
aliases.add(UUID_SHAPED_UID, 'uid:forma-uuid');

/** Id dei calendari creati dai test o seminati: servono a ripulire audit_logs. */
const auditIds = new Set<string>();
let since = '';
let seed: SeedRows;

// ─── Ciclo di vita ───────────────────────────────

async function cleanupAll(): Promise<void> {
  await fx.cleanup();
  if (since) await cleanupCalendarAudit({ since, prefixes: [fx.prefix], ids: auditIds });
}

// Dentro il `before` di useTestDatabase (dopo migrazioni, baseline e
// pre-pulizia del gruppo), non con un `before` proprio: vedi la nota in
// mcp-calendar-tools.contract.test.ts sui `before` registrati tardi.
onDatabaseReady(async () => {
  since = await databaseNow();
  seed = await registerSeedAliases(aliases);
  for (const c of Object.values(seed.calendars)) auditIds.add(c.id);
  freezeTime(NOW);
});
onBeforeDatabaseClose(cleanupAll);
afterEach(cleanupAll);
after(() => {
  restoreTime();
  store.flush();
});

// ─── Esecuzione dei casi ───────────────────────────────

type AuthKind = 'admin' | 'nessuna' | 'client';

interface ContractRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Percorso relativo a /api/admin/calendar. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Default 'admin'. */
  auth?: AuthKind;
}

interface ContractOptions {
  /** Status atteso: verificato prima del confronto con lo snapshot, per un errore leggibile. */
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- corpo JSON arbitrario della risposta
  select?: (json: any) => unknown;
  /** Effetti sul database da registrare, letti dopo la risposta. */
  effects?: (res: TestResponse) => unknown | Promise<unknown>;
}

/** Esegue la richiesta, verifica lo status e confronta la voce con lo snapshot del contratto. */
async function contract(caseId: string, req: ContractRequest, opts: ContractOptions): Promise<TestResponse> {
  const authKind = req.auth ?? 'admin';
  const auth = authKind === 'admin'
    ? 'admin' as const
    : authKind === 'client' ? { bearer: await signTestToken({ role: 'client' }) } : undefined;
  const path = `${BASE}${req.path}`;
  const res = await request(req.method, path, { query: req.query, body: req.body, headers: req.headers, auth });
  assert.equal(res.status, opts.status, `${caseId}: status ${res.status} inatteso (${res.text.slice(0, 300)})`);
  const effects = opts.effects ? await opts.effects(res) : undefined;
  store.check(caseId, responseEntry(res, aliases.normalizer(), {
    request: { method: req.method, path, query: req.query, body: req.body, auth: authKind },
    select: opts.select,
    effects,
  }));
  return res;
}

// ─── Scenario ───────────────────────────────

/** Calendario del test con slug e nome prefissati; registrato per alias e pulizia dell'audit. */
async function calendar(key: string, input: Parameters<typeof fx.calendar>[0] = {}): Promise<Calendar> {
  const cal = await fx.calendar({ key, ...input });
  auditIds.add(cal.id);
  aliases.add(cal.id, `cal:${key}`);
  aliases.add(cal.ics_feed_token, `token:${key}`);
  return cal;
}

/** Evento remoto già "parsato" (forma di parseIcs), con titolo prefissato. */
function parsedEvent(remoteUid: string, summary: string, start: string, end: string, allDay = false): ParsedEvent {
  return {
    remote_uid: remoteUid,
    summary: fx.name(summary),
    description: null,
    location: null,
    url: null,
    start_time: start,
    end_time: end,
    all_day: allDay,
    rrule: null,
    exdates: [],
    recurrence_id: null,
    status: 'confirmed',
  };
}

/** Occorrenze di GET /events (campi che decidono il rendering), per gli effetti. */
async function occurrences(calendarId: string, from: string, to: string): Promise<unknown[]> {
  const res = await api.get(`${BASE}/events`, { auth: 'admin', query: { calendar_id: calendarId, from, to } });
  assert.equal(res.status, 200, `GET /events per gli effetti: ${res.text.slice(0, 200)}`);
  return res.json.events.map((o: Record<string, unknown>) => ({
    id: o.id,
    summary: o.summary,
    start_time: o.start_time,
    end_time: o.end_time,
    original_start: o.original_start,
    is_override: o.is_override,
    status: o.status,
  }));
}

/** Status del feed ICS pubblico per un token (per gli effetti di toggle e rotazione). */
async function feedStatus(token: string): Promise<number> {
  return (await api.get(`/api/calendar/feed/${token}.ics`)).status;
}

/** Stato delle prenotazioni e delle loro proiezioni, per gli effetti delle route di prenotazione. */
async function bookingLifecycle(uids: string[]): Promise<unknown> {
  return { prenotazioni: await bookingRows(uids), proiezioni: await projectionRows(uids) };
}

// ─── Autenticazione ───────────────────────────────

test('auth: le route admin del calendario richiedono un JWT con ruolo admin', async () => {
  await contract('auth/senza-token', { method: 'GET', path: '/calendars', auth: 'nessuna' }, { status: 401 });
  await contract('auth/ruolo-client', { method: 'GET', path: '/calendars', auth: 'client' }, { status: 403 });
  await contract('auth/scrittura-senza-token', {
    method: 'POST',
    path: '/events',
    auth: 'nessuna',
    body: {
      calendar_id: seed.calendars.lavoro.id,
      summary: fx.name('Non autorizzato'),
      start_time: romeIso('2030-01-08', '10:00'),
      end_time: romeIso('2030-01-08', '11:00'),
    },
  }, { status: 401, effects: async () => sql`SELECT count(*)::int AS n FROM calendar_events` });
});

// ─── Calendari ───────────────────────────────

test('calendars: elenco con event_count e URL del feed, dettaglio per id e per slug', async () => {
  const work = await calendar('agenda', {
    description: 'Calendario di lavoro dei test',
    color: '#2563eb',
    icon: 'briefcase',
    sort_order: 10,
  });
  const info = await calendar('informativo', { blocks_availability: false, sort_order: 11 });
  await updateCalendar(info.id, { ics_feed_enabled: false });

  await fx.event({ calendar: work, summary: 'Riunione', start_time: romeIso('2030-01-08', '10:00'), end_time: romeIso('2030-01-08', '11:00') });
  await fx.event({
    calendar: work, summary: 'Annullata', status: 'cancelled',
    start_time: romeIso('2030-01-08', '12:00'), end_time: romeIso('2030-01-08', '13:00'),
  });
  await fx.series({
    calendar: work, summary: 'Standup', rrule: 'FREQ=DAILY;COUNT=5',
    start_time: romeIso('2030-01-07', '09:00'), end_time: romeIso('2030-01-07', '09:15'),
    overrides: [{ originalStart: romeIso('2030-01-09', '09:00'), status: 'cancelled' }],
  });
  await fx.event({ calendar: info, summary: 'Promemoria', start_time: romeIso('2030-01-09', '18:00'), end_time: romeIso('2030-01-09', '18:30') });

  const own = new Set([work.id, info.id]);
  const seeded = new Set<string>(SEED_CALENDAR_SLUGS);
  // event_count conta le righe non cancellate: master e singoli, non le
  // occorrenze; l'override cancellato e l'evento annullato restano fuori.
  const list = await contract('calendars/list', { method: 'GET', path: '/calendars' }, {
    status: 200,
    select: (json) => ({
      calendars: json.calendars.filter((c: { id: string; slug: string }) => seeded.has(c.slug) || own.has(c.id)),
    }),
  });
  const counts = Object.fromEntries(list.json.calendars.map((c: { slug: string; event_count: number }) => [c.slug, c.event_count]));
  assert.equal(counts[work.slug], 2);
  assert.equal(counts[info.slug], 1);

  await contract('calendars/get-per-id', { method: 'GET', path: `/calendars/${work.id}` }, { status: 200 });
  await contract('calendars/get-per-slug', { method: 'GET', path: `/calendars/${info.slug}` }, { status: 200 });
  await contract('calendars/get-seminato-di-sistema', { method: 'GET', path: '/calendars/bookings' }, { status: 200 });
  await contract('calendars/get-slug-inesistente', { method: 'GET', path: `/calendars/${fx.slug('inesistente')}` }, { status: 404 });
  await contract('calendars/get-uuid-inesistente', { method: 'GET', path: `/calendars/${MISSING_UUID}` }, { status: 404 });
});

test('calendars: creazione con i default della route e validazione', async () => {
  const created = await contract('calendars/create-default', {
    method: 'POST', path: '/calendars', body: { slug: fx.slug('nuovo'), name: fx.name('Nuovo') },
  }, { status: 200, effects: (res) => calendarRow(res.json.calendar.id) });
  auditIds.add(created.json.calendar.id);

  // Lo slug arriva in maiuscolo: la route lo porta in minuscolo prima della validazione.
  const full = await contract('calendars/create-completo', {
    method: 'POST',
    path: '/calendars',
    body: {
      slug: fx.slug('completo').toUpperCase(),
      name: fx.name('Completo'),
      description: '  Descrizione con spazi  ',
      color: '#16a34a',
      icon: 'star',
      timezone: 'Europe/London',
      blocks_availability: false,
      sort_order: '7',
      is_default: false,
    },
  }, { status: 200, effects: (res) => calendarRow(res.json.calendar.id) });
  auditIds.add(full.json.calendar.id);

  const invalid = (caseId: string, body: unknown, status: number): Promise<TestResponse> =>
    contract(caseId, { method: 'POST', path: '/calendars', body }, { status });
  await invalid('calendars/create-slug-non-valido', { slug: 'non valido', name: fx.name('Slug non valido') }, 400);
  await invalid('calendars/create-nome-mancante', { slug: fx.slug('senza-nome'), name: '   ' }, 400);
  await invalid('calendars/create-timezone-non-valida', { slug: fx.slug('fuso'), name: fx.name('Fuso'), timezone: 'Europe/Rom' }, 400);
  await invalid('calendars/create-slug-duplicato', { slug: fx.slug('nuovo'), name: fx.name('Altro nome') }, 409);
  await invalid('calendars/create-nome-duplicato', { slug: fx.slug('altro-slug'), name: fx.name('NUOVO') }, 409);
  await invalid('calendars/create-slug-seminato', { slug: 'bookings', name: fx.name('Doppione') }, 409);
  await contract('calendars/create-json-non-valido', {
    method: 'POST', path: '/calendars', body: '{"slug":', headers: { 'content-type': 'application/json' },
  }, { status: 400 });
});

test('calendars: modifica parziale, toggle del feed e del blocco, slug immutabile, predefinito', async () => {
  const cal = await calendar('modifica', { description: 'Prima', icon: 'calendar' });
  const other = await calendar('secondo');
  const row = (): Promise<unknown> => calendarRow(cal.id);
  const put = (caseId: string, body: unknown, status = 200, effects: ContractOptions['effects'] = row): Promise<TestResponse> =>
    contract(caseId, { method: 'PUT', path: `/calendars/${cal.id}`, body }, { status, effects });

  // Lo slug nel corpo viene ignorato (immutabile); sort_order accetta stringhe numeriche.
  await put('calendars/update-campi', {
    name: fx.name('Modificato'),
    description: 'Dopo',
    color: '#0f766e',
    icon: 'star',
    sort_order: '12',
    slug: fx.slug('rinominato'),
  });
  await put('calendars/update-colore-non-valido', { color: 'rosso' });
  await put('calendars/feed-off', { ics_feed_enabled: false }, 200, async () => ({
    calendar: await row(),
    feed: await feedStatus(cal.ics_feed_token),
  }));
  await put('calendars/feed-on', { ics_feed_enabled: true }, 200, async () => ({
    calendar: await row(),
    feed: await feedStatus(cal.ics_feed_token),
  }));
  await put('calendars/blocks-off', { blocks_availability: false });
  await put('calendars/blocks-on', { blocks_availability: true });
  await put('calendars/update-timezone-non-valida', { timezone: 'Mars/Olympus' }, 400);
  await put('calendars/update-vuoto', {});
  await contract('calendars/update-inesistente', {
    method: 'PUT', path: `/calendars/${MISSING_UUID}`, body: { name: fx.name('Fantasma') },
  }, { status: 404 });
  // La PUT accetta solo l'id: con lo slug il cast a uuid fallisce (400 generico di app.onError).
  await contract('calendars/update-per-slug', {
    method: 'PUT', path: `/calendars/${cal.slug}`, body: { name: fx.name('Per slug') },
  }, { status: 400, effects: row });

  try {
    // is_default=true demota tutti gli altri (anche il seminato 'lavoro');
    // is_default=false sul predefinito lascia il sistema senza predefinito.
    await contract('calendars/update-predefinito', {
      method: 'PUT', path: `/calendars/${other.id}`, body: { is_default: true },
    }, { status: 200, effects: defaultCalendarSlugs });
    await contract('calendars/update-non-predefinito', {
      method: 'PUT', path: `/calendars/${other.id}`, body: { is_default: false },
    }, { status: 200, effects: defaultCalendarSlugs });
  } finally {
    await sql`UPDATE calendars SET is_default = (slug = 'lavoro') WHERE is_default IS DISTINCT FROM (slug = 'lavoro')`;
  }
});

test('calendars: rotazione del token del feed ed eliminazione', async () => {
  const cal = await calendar('rotazione');
  const doomed = await calendar('da-eliminare');
  const bySlug = await calendar('per-slug');
  await fx.event({ calendar: doomed, summary: 'Evento in cascata', start_time: romeIso('2030-01-08', '10:00'), end_time: romeIso('2030-01-08', '11:00') });

  const oldToken = cal.ics_feed_token;
  const rotated = await contract('calendars/rotate-token', { method: 'POST', path: `/calendars/${cal.id}/rotate-token` }, {
    status: 200,
    effects: async (res) => ({
      feed_vecchio_token: await feedStatus(oldToken),
      feed_nuovo_token: await feedStatus(res.json.calendar.ics_feed_token),
    }),
  });
  assert.notEqual(rotated.json.calendar.ics_feed_token, oldToken);
  assert.match(rotated.json.calendar.ics_feed_token, /^[0-9a-z]{32}$/);
  await contract('calendars/rotate-token-inesistente', { method: 'POST', path: `/calendars/${MISSING_UUID}/rotate-token` }, { status: 404 });

  await contract('calendars/delete', { method: 'DELETE', path: `/calendars/${doomed.id}` }, {
    status: 200,
    effects: async () => ({
      calendar: await calendarRow(doomed.id),
      eventi: (await sql`SELECT count(*)::int AS n FROM calendar_events WHERE calendar_id = ${doomed.id}::uuid`)[0].n,
    }),
  });
  await contract('calendars/delete-sistema', { method: 'DELETE', path: `/calendars/${seed.calendars.bookings.id}` }, {
    status: 422,
    effects: async () => ({ esiste: (await calendarRow(seed.calendars.bookings.id)) !== null }),
  });
  // Calendario inesistente: deleteCalendar non distingue e la route risponde 200.
  await contract('calendars/delete-inesistente', { method: 'DELETE', path: `/calendars/${MISSING_UUID}` }, { status: 200 });
  // Per slug il calendario viene trovato, ma la DELETE usa lo slug come uuid: 400 generico.
  await contract('calendars/delete-per-slug', { method: 'DELETE', path: `/calendars/${bySlug.slug}` }, {
    status: 400,
    effects: async () => ({ esiste: (await calendarRow(bySlug.id)) !== null }),
  });
});

// ─── Eventi: elenco ───────────────────────────────

test('events: elenco espanso con override, EXDATE, cancellati, filtro per calendario e validazione', async () => {
  const cal = await calendar('agenda');
  const other = await calendar('altro');
  aliases.event('colloquio', await fx.event({
    calendar: cal, summary: 'Colloquio', start_time: romeIso('2030-01-07', '08:30'), end_time: romeIso('2030-01-07', '10:00'),
  }));
  aliases.event('riunione', await fx.event({
    calendar: cal, summary: 'Riunione', description: 'Ordine del giorno', location: 'Sala A', url: 'https://meet.caldes.test/riunione',
    start_time: romeIso('2030-01-08', '10:00'), end_time: romeIso('2030-01-08', '11:00'),
  }));
  aliases.event('ferie', await fx.allDayEvent({ calendar: cal, summary: 'Ferie', date: '2030-01-09', days: 2 }));
  aliases.event('annullato', await fx.event({
    calendar: cal, summary: 'Annullato', status: 'cancelled',
    start_time: romeIso('2030-01-10', '15:00'), end_time: romeIso('2030-01-10', '16:00'),
  }));
  aliases.series('standup', await fx.series({
    calendar: cal, summary: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6',
    start_time: romeIso('2030-01-07', '09:00'), end_time: romeIso('2030-01-07', '09:15'),
    exdates: [romeIso('2030-01-11', '09:00')],
    overrides: [
      { originalStart: romeIso('2030-01-09', '09:00'), start: romeIso('2030-01-09', '11:30'), end: romeIso('2030-01-09', '11:45'), summary: 'Standup spostato' },
      { originalStart: romeIso('2030-01-14', '09:00'), status: 'cancelled' },
    ],
  }), ['standup-spostato', 'standup-cancellato']);
  aliases.event('altro', await fx.event({
    calendar: other, summary: 'Evento di un altro calendario', start_time: romeIso('2030-01-08', '12:00'), end_time: romeIso('2030-01-08', '13:00'),
  }));

  const range = { from: '2030-01-07T00:00:00.000Z', to: '2030-01-19T00:00:00.000Z' };
  const list = await contract('events/list-calendario', {
    method: 'GET', path: '/events', query: { calendar_id: cal.id, ...range },
  }, { status: 200 });
  // Standup: 6 occorrenze dalla regola, meno l'EXDATE del venerdì e l'override
  // cancellato del 14; quella del 9 è sostituita dall'override spostato.
  const standups = list.json.events.filter((o: { summary: string }) => o.summary.startsWith(fx.name('Standup')));
  assert.deepEqual(standups.map((o: { start_time: string }) => romeHour(o.start_time)), ['09:00', '11:30', '09:00', '09:00']);

  await contract('events/list-include-cancelled', {
    method: 'GET', path: '/events', query: { calendar_id: cal.id, ...range, include_cancelled: 'true' },
  }, { status: 200 });
  const own = new Set([cal.id, other.id]);
  await contract('events/list-tutti-i-calendari', { method: 'GET', path: '/events', query: range }, {
    status: 200,
    select: (json) => ({ events: json.events.filter((o: { calendar_id: string }) => own.has(o.calendar_id)) }),
  });
  await contract('events/list-calendario-vuoto', {
    method: 'GET', path: '/events', query: { calendar_id: seed.calendars.personale.id, ...range },
  }, { status: 200 });

  // Bug noto (design §14, "expandRRule.between perde gli eventi in corso"):
  // con `from` dentro lo Standup delle 09:00 l'occorrenza della serie manca,
  // mentre il singolo già iniziato (Colloquio) c'è.
  const inProgress = await contract('events/list-evento-in-corso', {
    method: 'GET', path: '/events', query: { calendar_id: cal.id, from: '2030-01-07T08:05:00.000Z', to: '2030-01-07T12:00:00.000Z' },
  }, { status: 200 });
  assert.deepEqual(inProgress.json.events.map((o: { summary: string }) => o.summary), [fx.name('Colloquio')]);

  await contract('events/list-parametri-mancanti', { method: 'GET', path: '/events', query: { to: range.to } }, { status: 400 });
  await contract('events/list-date-non-valide', { method: 'GET', path: '/events', query: { from: 'ieri', to: range.to } }, { status: 400 });
  await contract('events/list-range-oltre-366-giorni', {
    method: 'GET', path: '/events', query: { from: '2030-01-01T00:00:00.000Z', to: '2031-01-03T00:00:00.000Z' },
  }, { status: 400 });
  // calendar_id non uuid: il cast fallisce nella query, la route rilancia e app.onError risponde 400.
  await contract('events/list-calendar-id-non-valido', {
    method: 'GET', path: '/events', query: { calendar_id: cal.slug, ...range },
  }, { status: 400 });
});

test("events: serie a cavallo del cambio dell'ora ed EXDATE salvato con l'ora UTC del DTSTART", async () => {
  const cal = await calendar('ora-legale');
  aliases.event('corso', (await fx.series({
    calendar: cal, summary: 'Corso settimanale', rrule: 'FREQ=WEEKLY;COUNT=4',
    start_time: romeIso('2030-03-18', '09:00'), end_time: romeIso('2030-03-18', '10:00'),
  })).master);
  // EXDATE con la stessa ora UTC del DTSTART (14:00Z = 15:00 d'inverno): la
  // firma del codice precedente a d046006 (DST_SHIFTED_EXCEPTION, design
  // §13.4). Dopo il cambio dell'ora l'occorrenza del 1° aprile cade alle
  // 13:00Z, l'EXDATE non combacia più e l'occorrenza ricompare.
  aliases.event('serie-pre-fix', (await fx.series({
    calendar: cal, summary: 'Serie con EXDATE pre-fix', rrule: 'FREQ=WEEKLY;COUNT=3',
    start_time: romeIso('2030-03-25', '15:00'), end_time: romeIso('2030-03-25', '16:00'),
    exdates: ['2030-04-01T14:00:00.000Z'],
  })).master);

  const res = await contract('events/list-cambio-ora', {
    method: 'GET', path: '/events', query: { calendar_id: cal.id, from: '2030-03-18T00:00:00.000Z', to: '2030-04-15T00:00:00.000Z' },
  }, { status: 200 });
  const byTitle = (title: string): string[] => res.json.events
    .filter((o: { summary: string }) => o.summary === fx.name(title))
    .map((o: { start_time: string }) => o.start_time);
  // L'ora di Roma resta 09:00 anche dopo il 31 marzo (08:00Z → 07:00Z).
  assert.deepEqual(byTitle('Corso settimanale'), [
    '2030-03-18T08:00:00.000Z', '2030-03-25T08:00:00.000Z', '2030-04-01T07:00:00.000Z', '2030-04-08T07:00:00.000Z',
  ]);
  assert.ok(byTitle('Serie con EXDATE pre-fix').includes('2030-04-01T13:00:00.000Z'), 'occorrenza DST-shifted assente: il comportamento è cambiato');
});

// ─── Eventi: dettaglio ───────────────────────────────

test('events: dettaglio per id e per uid, override, uid con forma di UUID', async () => {
  const cal = await calendar('dettaglio');
  const series = await fx.series({
    calendar: cal, summary: 'Serie', description: 'Descrizione della serie', rrule: 'FREQ=DAILY;COUNT=3',
    start_time: romeIso('2030-01-08', '14:00'), end_time: romeIso('2030-01-08', '15:00'),
    exdates: [romeIso('2030-01-09', '14:00')],
    overrides: [{ originalStart: romeIso('2030-01-10', '14:00'), start: romeIso('2030-01-10', '16:00'), end: romeIso('2030-01-10', '17:00'), summary: 'Serie spostata' }],
  });
  aliases.series('serie', series, ['override']);
  aliases.add((await fx.event({
    calendar: cal, uid: UUID_SHAPED_UID, summary: 'UID con forma di UUID',
    start_time: romeIso('2030-01-11', '10:00'), end_time: romeIso('2030-01-11', '11:00'),
  })).id, 'ev:forma-uuid');

  // Il dettaglio restituisce la riga grezza del master (rrule ed exdates), non un'occorrenza.
  await contract('events/get-per-id', { method: 'GET', path: `/events/${series.master.id}` }, { status: 200 });
  await contract('events/get-per-uid', { method: 'GET', path: `/events/${series.master.uid}` }, { status: 200 });
  await contract('events/get-override', { method: 'GET', path: `/events/${series.overrides[0].id}` }, { status: 200 });
  // Bug noto (design §14, resolver in quattro passi): un UID con forma di
  // UUID viene cercato come id e l'evento non si trova.
  await contract('events/get-uid-forma-uuid', { method: 'GET', path: `/events/${UUID_SHAPED_UID}` }, { status: 404 });
  await contract('events/get-inesistente', { method: 'GET', path: `/events/${MISSING_UUID}` }, { status: 404 });
  await contract('events/get-uid-inesistente', { method: 'GET', path: '/events/uid-inesistente' }, { status: 404 });
});

// ─── Eventi: creazione ───────────────────────────────

test('events: creazione (singolo, ricorrente, tutto il giorno) e validazione', async () => {
  const cal = await calendar('creazione');
  const post = (caseId: string, body: Record<string, unknown>, status: number): Promise<TestResponse> =>
    contract(caseId, { method: 'POST', path: '/events', body }, {
      status,
      effects: status === 200 ? (res) => eventRows([res.json.event.id]) : undefined,
    });
  const base = {
    calendar_id: cal.id,
    start_time: romeIso('2030-01-08', '15:00'),
    end_time: romeIso('2030-01-08', '16:00'),
  };

  // Default della route: source 'admin', status 'confirmed', uid generato.
  await post('events/create-singolo', {
    ...base,
    summary: fx.name('Call cliente'),
    description: '  Ordine del giorno  ',
    location: 'Online',
    url: 'https://meet.caldes.test/call',
  }, 200);
  // La RRULE viene normalizzata da validateRRule (rrule.toString()).
  await post('events/create-ricorrente', {
    ...base,
    summary: fx.name('Ricorrente'),
    rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=3',
    exdates: [romeIso('2030-01-15', '15:00')],
  }, 200);
  await post('events/create-tutto-il-giorno', {
    calendar_id: cal.id,
    summary: fx.name('Giornata'),
    all_day: true,
    start_time: romeIso('2030-01-10'),
    end_time: romeIso('2030-01-11'),
  }, 200);
  await post('events/create-tentative', { ...base, summary: fx.name('Forse'), status: 'tentative' }, 200);

  // Bug noto (design §14, "POST con source arbitraria"): la route accetta
  // qualsiasi source ammessa dal CHECK, anche 'ics_pull', e l'evento creato
  // dall'admin diventa di sola lettura.
  const pulled = await post('events/create-source-ics-pull', {
    ...base, summary: fx.name('Finto importato'), source: 'ics_pull', source_id: 'remoto-finto',
  }, 200);
  await contract('events/update-source-ics-pull-creato-da-admin', {
    method: 'PUT', path: `/events/${pulled.json.event.id}`, body: { summary: fx.name('Rinominato') },
  }, { status: 403 });

  await post('events/create-calendar-id-mancante', { ...base, calendar_id: undefined, summary: fx.name('Senza calendario') }, 400);
  await post('events/create-titolo-mancante', { ...base, summary: '   ' }, 400);
  await post('events/create-date-non-valide', { ...base, summary: fx.name('Date'), start_time: 'domani' }, 400);
  await post('events/create-fine-prima-inizio', { ...base, summary: fx.name('Al contrario'), end_time: base.start_time }, 400);
  await post('events/create-rrule-non-valida', { ...base, summary: fx.name('Regola'), rrule: 'FREQ=MAI' }, 400);
  // Errori del database mappati da app.onError: CHECK (400), cast (400), foreign key (409).
  await post('events/create-source-non-ammessa', { ...base, summary: fx.name('Sorgente'), source: 'pippo' }, 400);
  await post('events/create-status-non-valido', { ...base, summary: fx.name('Stato'), status: 'boh' }, 400);
  await post('events/create-calendar-id-non-uuid', { ...base, calendar_id: cal.slug, summary: fx.name('Slug') }, 400);
  await post('events/create-calendario-inesistente', { ...base, calendar_id: MISSING_UUID, summary: fx.name('Fantasma') }, 409);
});

// ─── Eventi: modifica ───────────────────────────────

test('events: modifica parziale, spostamento, cambio di calendario, rrule rimossa e validazione', async () => {
  const cal = await calendar('aggiornamento');
  const target = await calendar('destinazione');
  const series = await fx.series({
    calendar: cal, summary: 'Serie', rrule: 'FREQ=DAILY;COUNT=5',
    start_time: romeIso('2030-01-14', '10:00'), end_time: romeIso('2030-01-14', '11:00'),
    overrides: [{ originalStart: romeIso('2030-01-15', '10:00'), start: romeIso('2030-01-15', '12:00'), end: romeIso('2030-01-15', '13:00') }],
  });
  aliases.series('serie', series, ['override']);
  const single = await fx.event({
    calendar: cal, summary: 'Singolo', description: 'Note', location: 'Sala B', url: 'https://meet.caldes.test/singolo',
    start_time: romeIso('2030-01-16', '15:00'), end_time: romeIso('2030-01-16', '16:00'),
  });
  aliases.event('singolo', single);
  const master = series.master;
  const put = (caseId: string, id: string, body: unknown, status: number, effects?: ContractOptions['effects']): Promise<TestResponse> =>
    contract(caseId, { method: 'PUT', path: `/events/${id}`, body }, { status, effects });

  // Semantica parziale: una rinomina non tocca rrule, exdates e date.
  await put('events/update-rinomina', master.id, { summary: fx.name('Serie rinominata') }, 200, () => eventRows([master.id]));
  await put('events/update-sposta', single.id, {
    start_time: romeIso('2030-01-16', '16:00'), end_time: romeIso('2030-01-16', '17:00'),
  }, 200, () => eventRows([single.id]));
  await put('events/update-campi-vuoti', single.id, { description: null, location: '', url: null }, 200, () => eventRows([single.id]));
  await put('events/update-vuoto', single.id, {}, 200);
  await put('events/update-fine-prima-inizio', single.id, { end_time: romeIso('2030-01-16', '15:00') }, 400);
  await put('events/update-start-non-valido', single.id, { start_time: 'presto' }, 400);
  await put('events/update-rrule-non-valida', master.id, { rrule: 'FREQ=MAI' }, 400);
  await put('events/update-stato-cancellato', single.id, { status: 'cancelled' }, 200, () => eventRows([single.id]));
  await put('events/update-inesistente', MISSING_UUID, { summary: fx.name('Fantasma') }, 404);

  // Il master cambia calendario, l'override resta nel calendario di origine
  // (anomalia OVERRIDE_CALENDAR_MISMATCH, design §13.4).
  await put('events/update-calendario', master.id, { calendar_id: target.id }, 200, async () => ({
    master: await eventRows([master.id]),
    override: await overrideRows(master.id),
  }));
  // Rimossa la rrule, l'override resta legato al master (orfano) e compare
  // come occorrenza autonoma accanto al master ormai singolo.
  await put('events/update-rrule-rimossa', master.id, { rrule: null }, 200, async () => ({
    master: await eventRows([master.id]),
    override: await overrideRows(master.id),
    occorrenze_destinazione: await occurrences(target.id, '2030-01-13T00:00:00.000Z', '2030-01-20T00:00:00.000Z'),
    occorrenze_origine: await occurrences(cal.id, '2030-01-13T00:00:00.000Z', '2030-01-20T00:00:00.000Z'),
  }));
});

// ─── Eventi: eliminazione ───────────────────────────────

test('events: eliminazione di singoli, override, master e proiezioni delle prenotazioni', async () => {
  const cal = await calendar('eliminazione');
  const single = await fx.event({
    calendar: cal, summary: 'Singolo', start_time: romeIso('2030-01-08', '09:00'), end_time: romeIso('2030-01-08', '10:00'),
  });
  aliases.event('singolo', single);
  const byUid = await fx.event({
    calendar: cal, summary: 'Per uid', start_time: romeIso('2030-01-08', '11:00'), end_time: romeIso('2030-01-08', '12:00'),
  });
  aliases.event('per-uid', byUid);
  const series = await fx.series({
    calendar: cal, summary: 'Serie', rrule: 'FREQ=DAILY;COUNT=3',
    start_time: romeIso('2030-01-14', '10:00'), end_time: romeIso('2030-01-14', '11:00'),
    overrides: [{ originalStart: romeIso('2030-01-15', '10:00'), start: romeIso('2030-01-15', '12:00'), end: romeIso('2030-01-15', '13:00') }],
  });
  aliases.series('serie', series, ['override']);
  const other = await fx.series({
    calendar: cal, summary: 'Serie da eliminare', rrule: 'FREQ=DAILY;COUNT=3',
    start_time: romeIso('2030-01-21', '10:00'), end_time: romeIso('2030-01-21', '11:00'),
    overrides: [{ originalStart: romeIso('2030-01-22', '10:00'), status: 'cancelled' }],
  });
  aliases.series('serie-2', other, ['override-2']);
  const et = await fx.eventType({ key: 'proiezione' });
  const active = await fx.booking({ eventType: et, start: romeIso('2030-01-09', '10:00') });
  aliases.booking('attiva', active);
  const cancelled = await fx.booking({ eventType: et, start: romeIso('2030-01-09', '11:00'), status: 'cancelled', project: true });
  aliases.booking('annullata', cancelled);
  const del = (caseId: string, id: string, status: number, effects?: ContractOptions['effects']): Promise<TestResponse> =>
    contract(caseId, { method: 'DELETE', path: `/events/${id}` }, { status, effects });

  await del('events/delete-singolo', single.id, 200, () => eventRows([single.id]));
  // DELETE accetta anche l'uid (getEvent risolve id o uid).
  await del('events/delete-per-uid', byUid.uid, 200, () => eventRows([byUid.id]));
  // Un override non si cancella: diventa 'cancelled' e continua a sopprimere l'occorrenza.
  await del('events/delete-override', series.overrides[0].id, 200, async () => ({
    override: await eventRows([series.overrides[0].id]),
    occorrenze: await occurrences(cal.id, '2030-01-14T00:00:00.000Z', '2030-01-17T00:00:00.000Z'),
  }));
  // Il master si cancella con gli override (ON DELETE CASCADE).
  await del('events/delete-master', other.master.id, 200, () => eventRows([other.master.id, other.overrides[0].id]));
  await del('events/delete-proiezione-attiva', active.projection!.id, 403, () => eventRows([active.projection!.id]));
  await del('events/delete-proiezione-annullata', cancelled.projection!.id, 200, () => eventRows([cancelled.projection!.id]));
  await del('events/delete-inesistente', MISSING_UUID, 404);
});

// ─── Eventi: eccezione su singola occorrenza ───────────────────────────────

test('events: eccezione su singola occorrenza (sposta, cancella, upsert, fuori regola) e validazione', async () => {
  const cal = await calendar('eccezioni');
  const series = await fx.series({
    calendar: cal, summary: 'Lezione', description: 'Aula 1', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6',
    start_time: romeIso('2030-01-07', '17:00'), end_time: romeIso('2030-01-07', '18:00'),
  });
  aliases.series('lezione', series);
  const single = await fx.event({
    calendar: cal, summary: 'Singolo', start_time: romeIso('2030-01-08', '09:00'), end_time: romeIso('2030-01-08', '10:00'),
  });
  aliases.event('singolo', single);
  const master = series.master;
  const exception = (caseId: string, id: string, body: unknown, status: number, effects?: ContractOptions['effects']): Promise<TestResponse> =>
    contract(caseId, { method: 'POST', path: `/events/${id}/exception`, body }, { status, effects });

  const moved = await exception('events/exception-sposta', master.id, {
    original_start: romeIso('2030-01-09', '17:00'),
    new_start: romeIso('2030-01-09', '18:30'),
    new_end: romeIso('2030-01-09', '19:30'),
    summary: fx.name('Lezione spostata'),
    description: 'Aula 2',
  }, 200, () => overrideRows(master.id));
  // Stessa occorrenza di nuovo: upsert sulla stessa riga. Senza new_start
  // l'override torna all'orario originale; titolo e descrizione tornano quelli del master.
  const again = await exception('events/exception-ripetuta-cancella', master.id, {
    original_start: romeIso('2030-01-09', '17:00'),
    status: 'cancelled',
  }, 200, () => overrideRows(master.id));
  assert.equal(again.json.event.id, moved.json.event.id);
  await exception('events/exception-solo-titolo', master.uid, {
    original_start: romeIso('2030-01-14', '17:00'),
    summary: fx.name('Lezione con ospite'),
  }, 200, () => overrideRows(master.id));
  // Anomalia ORPHAN_OVERRIDE_NOT_IN_RULE (design §13.4): il martedì non è
  // nella regola, l'override viene accettato e compare come occorrenza autonoma.
  await exception('events/exception-fuori-regola', master.id, {
    original_start: romeIso('2030-01-08', '17:00'),
    summary: fx.name('Lezione extra'),
  }, 200, async () => occurrences(cal.id, '2030-01-07T00:00:00.000Z', '2030-01-10T00:00:00.000Z'));

  await exception('events/exception-original-start-mancante', master.id, { new_start: romeIso('2030-01-16', '18:00') }, 400);
  await exception('events/exception-non-ricorrente', single.id, { original_start: romeIso('2030-01-08', '09:00') }, 400);
  await exception('events/exception-master-inesistente', MISSING_UUID, { original_start: romeIso('2030-01-08', '09:00') }, 400);
});

// ─── Eventi: duplicazione ───────────────────────────────

test('events: duplicazione di singoli e serie, con spostamento e titolo', async () => {
  const cal = await calendar('duplicazione');
  const single = await fx.event({
    calendar: cal, summary: 'Workshop', description: 'Programma', location: 'Sala C', url: 'https://meet.caldes.test/workshop',
    start_time: romeIso('2030-01-09', '14:00'), end_time: romeIso('2030-01-09', '16:00'),
  });
  aliases.event('workshop', single);
  const series = await fx.series({
    calendar: cal, summary: 'Ricorrente', rrule: 'FREQ=WEEKLY;COUNT=4',
    start_time: romeIso('2030-01-07', '09:00'), end_time: romeIso('2030-01-07', '10:00'),
    exdates: [romeIso('2030-01-14', '09:00')],
    overrides: [{ originalStart: romeIso('2030-01-21', '09:00'), start: romeIso('2030-01-21', '11:00'), end: romeIso('2030-01-21', '12:00') }],
  });
  aliases.series('ricorrente', series, ['override']);
  const duplicate = (caseId: string, id: string, body: unknown, status: number, withOverrides = false): Promise<TestResponse> =>
    contract(caseId, { method: 'POST', path: `/events/${id}/duplicate`, body }, {
      status,
      effects: status === 200
        ? async (res) => withOverrides
          ? { copia: await eventRows([res.json.event.id]), override_della_copia: await overrideRows(res.json.event.id) }
          : eventRows([res.json.event.id])
        : undefined,
    });

  // Default: copia singola, stessi orari, source 'admin', source_id = id dell'originale.
  await duplicate('events/duplicate-singolo', single.id, undefined, 200);
  await duplicate('events/duplicate-spostato-con-titolo', single.id, { shiftMinutes: 1440, summary: fx.name('Workshop (copia)') }, 200);
  // Bug noto (design §14): la copia di una serie senza copyRecurrence è un
  // evento singolo alla data del master, non a quella dell'occorrenza.
  await duplicate('events/duplicate-serie', series.master.id, {}, 200);
  // Con copyRecurrence copia rrule ed exdates, non gli override.
  await duplicate('events/duplicate-serie-con-ricorrenza', series.master.id, { copyRecurrence: true }, 200, true);
  await duplicate('events/duplicate-inesistente', MISSING_UUID, {}, 404);
});

// ─── Chiusure ───────────────────────────────

test('closures: GET crea il calendario "Festività e chiusure" quando non esiste', async () => {
  const before = await sql`SELECT count(*)::int AS n FROM calendars WHERE slug IN ('festivita', 'f')`;
  assert.equal(before[0].n, 0, 'la baseline non deve avere un calendario festività');
  // Bug noto (design §14, "GET /closures crea il calendario"): una lettura
  // crea il calendario di sistema con lo slug 'festivita'.
  const res = await contract('closures/get-crea-calendario', { method: 'GET', path: '/closures' }, {
    status: 200,
    effects: () => sql`
      SELECT slug, name, description, color, icon, timezone, is_default, is_system, blocks_availability, ics_feed_enabled, sort_order
      FROM calendars WHERE slug = 'festivita'
    `,
  });
  auditIds.add(res.json.calendar.id);
  fx.track('calendarIds', res.json.calendar.id);
});

test('closures: elenco, creazione ed eliminazione sul calendario di produzione "f"', async () => {
  const f = await fx.holidayCalendar();
  auditIds.add(f.id);
  aliases.add(f.id, 'cal:f');
  aliases.add(f.ics_feed_token, 'token:f');
  const [liberation] = await fx.holidays(f, { year: 2030, only: ['2030-04-25'] });
  aliases.event('festa-liberazione', liberation);
  // Chiusura del 2024: oltre i 30 giorni dall'orologio reale di Postgres, fuori dall'elenco.
  aliases.event('ferie-2024', await fx.closure(f, { from: '2024-08-12', to: '2024-08-16', summary: 'Ferie 2024' }));
  const summer = await fx.closure(f, { from: '2030-08-12', to: '2030-08-16', summary: 'Ferie estive' });
  aliases.event('ferie-estive', summer);
  const elsewhere = await calendar('non-festivita');
  const foreign = await fx.event({
    calendar: elsewhere, summary: 'Evento normale', start_time: romeIso('2030-02-01', '10:00'), end_time: romeIso('2030-02-01', '11:00'),
  });
  aliases.event('evento-normale', foreign);

  // Solo le chiusure manuali (source != 'system') e non concluse da più di 30 giorni.
  await contract('closures/list', { method: 'GET', path: '/closures' }, { status: 200 });

  const post = (caseId: string, body: unknown, status: number): Promise<TestResponse> =>
    contract(caseId, { method: 'POST', path: '/closures', body }, {
      status,
      effects: status === 200 ? (res) => eventRows([res.json.closure.id]) : undefined,
    });
  // Un giorno: evento timed 00:00→24:00 di Roma, titolo di default "Chiusura", source 'admin'.
  await post('closures/create-un-giorno', { from_date: '2030-02-15' }, 200);
  // A cavallo del cambio dell'ora: inizio 23:00Z (CET), fine 22:00Z (CEST); titolo ripulito dagli spazi.
  await post('closures/create-cambio-ora', { from_date: '2030-03-29', to_date: '2030-04-01', summary: `  ${fx.name('Ponte')}  ` }, 200);
  await post('closures/create-data-non-valida', { from_date: '15/02/2030' }, 400);
  await post('closures/create-intervallo-invertito', { from_date: '2030-02-15', to_date: '2030-02-14' }, 400);
  await post('closures/create-oltre-366-giorni', { from_date: '2030-01-01', to_date: '2031-01-02' }, 400);
  await contract('closures/list-dopo-creazione', { method: 'GET', path: '/closures' }, { status: 200 });

  const del = (caseId: string, id: string, status: number, effects?: ContractOptions['effects']): Promise<TestResponse> =>
    contract(caseId, { method: 'DELETE', path: `/closures/${id}` }, { status, effects });
  await del('closures/delete', summer.id, 200, () => eventRows([summer.id]));
  // Le festività del cron (source 'system') non si cancellano da qui.
  await del('closures/delete-festivita', liberation.id, 404, () => eventRows([liberation.id]));
  await del('closures/delete-altro-calendario', foreign.id, 404, () => eventRows([foreign.id]));
  await del('closures/delete-inesistente', MISSING_UUID, 404);
});

// ─── Schedule di default ───────────────────────────────

test('schedule: lettura e modifica dello schedule di default, slot settimanali e override di data', async () => {
  const saved = await saveDefaultSchedule();
  try {
    await contract('schedule/get', { method: 'GET', path: '/schedule' }, { status: 200 });

    const put = (caseId: string, body: unknown, status: number): Promise<TestResponse> =>
      contract(caseId, { method: 'PUT', path: '/schedule', body }, { status });
    await put('schedule/update-timezone-non-valida', { timezone: 'Mars/Olympus' }, 400);
    await put('schedule/update-vuoto', {}, 400);
    await put('schedule/update', { name: fx.name('Orario studio'), timezone: 'Europe/Rome' }, 200);

    const slots = (caseId: string, body: unknown, status: number): Promise<TestResponse> =>
      contract(caseId, { method: 'PUT', path: '/schedule/slots', body }, {
        status,
        effects: status === 200
          ? () => sql`
              SELECT day_of_week, start_time::text AS start_time, end_time::text AS end_time
              FROM calendar_availability_slots WHERE schedule_id = ${saved.id}::uuid
              ORDER BY day_of_week, start_time
            `
          : undefined,
      });
    await slots('schedule/slots-non-array', { slots: 'lunedì' }, 400);
    await slots('schedule/slots-giorno-non-valido', { slots: [{ day_of_week: 7, start_time: '09:00', end_time: '12:00' }] }, 400);
    await slots('schedule/slots-orario-non-valido', { slots: [{ day_of_week: 1, start_time: '9:00', end_time: '12:00' }] }, 400);
    await slots('schedule/slots-inizio-dopo-fine', { slots: [{ day_of_week: 1, start_time: '14:00', end_time: '13:00' }] }, 400);
    await slots('schedule/slots-vuoti', { slots: [] }, 200);
    await slots('schedule/slots-sostituisci', {
      slots: [
        { day_of_week: 1, start_time: '10:00', end_time: '12:00' },
        { day_of_week: 3, start_time: '15:00', end_time: '18:30' },
        { day_of_week: 5, start_time: '09:00:00', end_time: '13:00:00' },
      ],
    }, 200);

    const override = (caseId: string, body: unknown, status: number): Promise<TestResponse> =>
      contract(caseId, { method: 'POST', path: '/schedule/overrides', body }, { status });
    // Chiuso: gli orari passati vengono ignorati.
    await override('schedule/overrides-chiuso', {
      override_date: '2030-01-09', is_unavailable: true, start_time: '10:00', note: fx.name('Inventario'),
    }, 200);
    const reduced = await override('schedule/overrides-orario-ridotto', {
      override_date: '2030-01-10', start_time: '10:00', end_time: '12:00', note: fx.name('Mezza giornata'),
    }, 200);
    // Stessa data: upsert sulla stessa riga (ON CONFLICT).
    const replaced = await override('schedule/overrides-aggiorna', { override_date: '2030-01-10', is_unavailable: true }, 200);
    assert.equal(replaced.json.override.id, reduced.json.override.id);
    await override('schedule/overrides-data-non-valida', { override_date: '10/01/2030', is_unavailable: true }, 400);
    await override('schedule/overrides-orari-mancanti', { override_date: '2030-01-11' }, 400);
    await override('schedule/overrides-inizio-dopo-fine', { override_date: '2030-01-11', start_time: '12:00', end_time: '10:00' }, 400);

    // Override in ordine di data decrescente.
    await contract('schedule/get-dopo-modifiche', { method: 'GET', path: '/schedule' }, { status: 200 });

    await contract('schedule/overrides-elimina', { method: 'DELETE', path: `/schedule/overrides/${reduced.json.override.id}` }, {
      status: 200,
      effects: () => sql`
        SELECT override_date::text AS override_date, is_unavailable FROM calendar_availability_overrides
        WHERE schedule_id = ${saved.id}::uuid ORDER BY override_date
      `,
    });
    await contract('schedule/overrides-elimina-inesistente', { method: 'DELETE', path: `/schedule/overrides/${MISSING_UUID}` }, { status: 404 });
  } finally {
    await restoreDefaultSchedule(saved);
  }
});

// ─── Tipi di prenotazione ───────────────────────────────

test('event-types: creazione con i default della route, elenco, modifica, disattivazione e validazione', async () => {
  const sched = await fx.schedule({ name: 'Schedule dedicato', slots: [{ day: 2, start: '09:00', end: '12:00' }] });
  aliases.add(sched.schedule.id, 'schedule:dedicato');
  const own = (json: { event_types: Array<{ slug: string }> }): unknown => ({
    event_types: json.event_types.filter((et) => et.slug.startsWith(fx.prefix)),
  });

  // Default della route admin: min_notice 12 ore, max_advance 60 giorni, colore viola, pubblico e attivo.
  const created = await contract('event-types/create', {
    method: 'POST',
    path: '/event-types',
    body: {
      slug: fx.slug('consulenza'),
      title: fx.name('Consulenza'),
      duration_minutes: 45,
      location_type: 'custom_url',
      location_value: 'https://meet.caldes.test/consulenza',
    },
  }, { status: 200 });
  const id = created.json.event_type.id as string;
  aliases.add(id, 'et:consulenza');
  // Valori fuori scala ridotti nei limiti (max_advance 365, durata 480).
  const full = await contract('event-types/create-completo', {
    method: 'POST',
    path: '/event-types',
    body: {
      slug: fx.slug('sopralluogo'),
      title: fx.name('Sopralluogo'),
      description: 'Visita in sede',
      duration_minutes: 600,
      buffer_before_minutes: 15,
      buffer_after_minutes: 30,
      slot_increment_minutes: 15,
      min_notice_hours: 0,
      max_advance_days: 400,
      location_type: 'in_person',
      location_value: 'Via Roma 1, Frosinone',
      color: '#16A34A',
      is_public: false,
      requires_approval: true,
      custom_questions: [{ key: 'indirizzo', label: 'Indirizzo', type: 'text', required: true }],
      workflow_event_key: 'booking_sopralluogo',
      schedule_id: sched.schedule.id,
      sort_order: 3,
    },
  }, { status: 200 });
  aliases.add(full.json.event_type.id, 'et:sopralluogo');

  const invalid = (caseId: string, body: Record<string, unknown>, status: number): Promise<TestResponse> =>
    contract(caseId, { method: 'POST', path: '/event-types', body }, { status });
  const valid = { slug: fx.slug('altro'), title: fx.name('Altro'), duration_minutes: 30, location_type: 'phone' };
  await invalid('event-types/create-slug-non-valido', { ...valid, slug: 'A' }, 400);
  await invalid('event-types/create-titolo-mancante', { ...valid, title: '' }, 400);
  await invalid('event-types/create-durata-minima', { ...valid, duration_minutes: 4 }, 400);
  await invalid('event-types/create-location-non-valida', { ...valid, location_type: 'skype' }, 400);
  // Google Workspace dismesso: i nuovi tipi non possono nascere google_meet.
  await invalid('event-types/create-google-meet', { ...valid, location_type: 'google_meet' }, 400);
  await invalid('event-types/create-slug-duplicato', { ...valid, slug: fx.slug('consulenza') }, 409);

  await contract('event-types/list', { method: 'GET', path: '/event-types' }, { status: 200, select: own });
  await contract('event-types/get', { method: 'GET', path: `/event-types/${id}` }, { status: 200 });
  await contract('event-types/get-inesistente', { method: 'GET', path: `/event-types/${MISSING_UUID}` }, { status: 404 });
  // Il dettaglio accetta solo l'id: con lo slug il cast a uuid fallisce (400 generico).
  await contract('event-types/get-per-slug', { method: 'GET', path: `/event-types/${fx.slug('consulenza')}` }, { status: 400 });

  const put = (caseId: string, target: string, body: unknown, status: number): Promise<TestResponse> =>
    contract(caseId, { method: 'PUT', path: `/event-types/${target}`, body }, { status });
  // Colore non valido ignorato; null sui numerici ignorato; description vuota → null.
  await put('event-types/update', id, {
    title: fx.name('Consulenza estesa'), duration_minutes: 60, is_public: false, color: 'blu', buffer_before_minutes: null, description: '',
  }, 200);
  await put('event-types/update-vuoto', id, {}, 400);
  await put('event-types/update-slug-non-valido', id, { slug: 'Non Valido' }, 400);
  await put('event-types/update-location-non-valida', id, { location_type: 'skype' }, 400);
  await put('event-types/update-slug-duplicato', id, { slug: fx.slug('sopralluogo') }, 409);
  await put('event-types/update-inesistente', MISSING_UUID, { title: fx.name('Fantasma') }, 404);

  // Disattivazione "soft": is_active e is_public a false, la riga resta per le prenotazioni storiche.
  await contract('event-types/delete', { method: 'DELETE', path: `/event-types/${id}` }, {
    status: 200,
    effects: () => sql`SELECT slug, is_active, is_public FROM calendar_event_types WHERE id = ${id}::uuid`,
  });
  await contract('event-types/delete-inesistente', { method: 'DELETE', path: `/event-types/${MISSING_UUID}` }, { status: 404 });
  await contract('event-types/list-dopo-disattivazione', { method: 'GET', path: '/event-types' }, { status: 200, select: own });
});

test('event-types: schedule del tipo e anteprima degli slot con eventi bloccanti, informativi e prenotazioni', async () => {
  const sched = await fx.schedule({
    name: 'Solo lunedì mattina',
    slots: [{ day: 1, start: '09:00', end: '12:00' }],
    overrides: [{ date: '2030-01-14', unavailable: true, note: 'Chiuso' }],
  });
  aliases.add(sched.schedule.id, 'schedule:lunedi');
  // Tipo non pubblico: l'anteprima admin usa onlyPublic=false.
  const et = await fx.eventType({ key: 'anteprima', durationMinutes: 60, slotIncrementMinutes: 60, isPublic: false, schedule: sched });
  aliases.add(et.id, 'et:anteprima');
  const fallback = await fx.eventType({ key: 'senza-schedule' });
  aliases.add(fallback.id, 'et:senza-schedule');

  const blocking = await calendar('blocca');
  const informative = await calendar('non-blocca', { blocks_availability: false });
  await fx.event({ calendar: blocking, summary: 'Occupato', start_time: romeIso('2030-01-07', '10:00'), end_time: romeIso('2030-01-07', '11:00') });
  await fx.event({ calendar: blocking, summary: 'Annullato', status: 'cancelled', start_time: romeIso('2030-01-07', '11:00'), end_time: romeIso('2030-01-07', '12:00') });
  await fx.event({ calendar: informative, summary: 'Informativo', start_time: romeIso('2030-01-07', '09:00'), end_time: romeIso('2030-01-07', '10:00') });
  // Gli all-day non bloccano gli slot (getBusyRanges li esclude).
  await fx.allDayEvent({ calendar: blocking, summary: 'Giornata intera', date: '2030-01-07' });

  await contract('event-types/schedule', { method: 'GET', path: `/event-types/${et.slug}/schedule` }, { status: 200 });
  await contract('event-types/schedule-default', { method: 'GET', path: `/event-types/${fallback.id}/schedule` }, { status: 200 });
  await contract('event-types/schedule-inesistente', { method: 'GET', path: `/event-types/${fx.slug('nessuno')}/schedule` }, { status: 404 });

  const slots = (caseId: string, target: string, query: Record<string, string>, status: number): Promise<TestResponse> =>
    contract(caseId, { method: 'GET', path: `/event-types/${target}/slots`, query }, { status });
  const range = { from: '2030-01-07', to: '2030-01-14' };
  const preview = await slots('event-types/slots', et.id, range, 200);
  // 10:00 occupato dal calendario bloccante; informativo, annullato e all-day non bloccano; il 14 è chiuso.
  assert.deepEqual(romeHoursByDate(preview.json.slots_by_date)['2030-01-07'], ['09:00', '11:00']);
  assert.deepEqual(romeHoursByDate(preview.json.slots_by_date)['2030-01-14'], []);

  aliases.booking('lunedi', await fx.booking({ eventType: et, start: romeIso('2030-01-07', '09:00') }));
  const booked = await slots('event-types/slots-con-prenotazione', et.slug, range, 200);
  assert.deepEqual(romeHoursByDate(booked.json.slots_by_date)['2030-01-07'], ['11:00']);

  await slots('event-types/slots-from-mancante', et.id, { to: range.to }, 400);
  await slots('event-types/slots-to-non-valido', et.id, { from: range.from, to: '14/01/2030' }, 400);
  await slots('event-types/slots-inesistente', fx.slug('nessuno'), range, 404);
});

// ─── Prenotazioni ───────────────────────────────

test('bookings: elenco con filtri, paginazione e statistiche, dettaglio', async () => {
  const consult = await fx.eventType({ key: 'consulenza', title: 'Consulenza' });
  aliases.add(consult.id, 'et:consulenza');
  const visit = await fx.eventType({
    key: 'sopralluogo', title: 'Sopralluogo', requiresApproval: true, locationType: 'in_person', locationValue: 'Via Roma 1, Frosinone',
  });
  aliases.add(visit.id, 'et:sopralluogo');

  const confirmed = await fx.booking({
    eventType: consult,
    start: romeIso('2030-01-08', '10:00'),
    attendee: { name: 'Mario Rossi', email: fx.email('mario'), phone: '+39 333 0000001', company: 'Rossi Srl', message: 'Vorrei un preventivo' },
    customResponses: { budget: '1-5k' },
  });
  aliases.booking('confermata', confirmed);
  aliases.booking('in-attesa', await fx.booking({
    eventType: visit, start: romeIso('2030-01-09', '11:00'), status: 'pending',
    attendee: { name: 'Giulia Bianchi', email: fx.email('giulia') },
  }));
  aliases.booking('annullata', await fx.booking({
    eventType: consult, start: romeIso('2030-01-10', '14:00'), status: 'cancelled', cancelledBy: 'attendee', cancellationReason: 'Imprevisto',
    attendee: { name: 'Luca Verdi', email: fx.email('luca') },
  }));
  aliases.booking('completata', await fx.booking({
    eventType: consult, start: romeIso('2030-01-11', '09:00'), status: 'completed', source: 'admin_manual',
    attendee: { name: 'Anna Neri', email: fx.email('anna') },
  }));
  // Prenotazione del 2024: nell'elenco, ma fuori dalle statistiche (NOW() di Postgres - 90 giorni).
  aliases.booking('storica', await fx.booking({
    eventType: consult, start: romeIso('2024-06-03', '10:00'),
    attendee: { name: 'Paolo Gialli', email: fx.email('paolo') },
  }));

  const list = (caseId: string, query?: Record<string, string>): Promise<TestResponse> =>
    contract(caseId, { method: 'GET', path: '/bookings', query }, { status: 200 });
  const all = await list('bookings/list');
  assert.equal(all.json.count, 5);
  assert.deepEqual(all.json.stats, { pending: 1, confirmed: 1, cancelled: 1, completed: 1, no_show: 0 });
  await list('bookings/list-status', { status: 'pending' });
  await list('bookings/list-status-all', { status: 'all' });
  await list('bookings/list-ricerca-nome', { search: 'ROSSI' });
  await list('bookings/list-ricerca-email', { search: fx.slug('giulia') });
  await list('bookings/list-intervallo', { from: '2030-01-09', to: '2030-01-10' });
  // Date non nel formato YYYY-MM-DD: filtro ignorato in silenzio.
  await list('bookings/list-data-non-valida', { from: '09/01/2030' });
  await list('bookings/list-tipo', { event_type_id: visit.id });
  await list('bookings/list-paginazione', { limit: '2', offset: '1' });

  await contract('bookings/get', { method: 'GET', path: `/bookings/${confirmed.booking.uid}` }, { status: 200 });
  await contract('bookings/get-inesistente', { method: 'GET', path: '/bookings/nonesiste000' }, { status: 404 });
});

test('bookings: approvazione e rifiuto delle richieste in attesa', async () => {
  const et = await fx.eventType({ key: 'approvazione', title: 'Consulenza su richiesta', requiresApproval: true });
  aliases.add(et.id, 'et:approvazione');
  const pending = await fx.booking({ eventType: et, start: romeIso('2030-01-08', '10:00'), status: 'pending' });
  aliases.booking('da-approvare', pending);
  const toReject = await fx.booking({ eventType: et, start: romeIso('2030-01-08', '11:00'), status: 'pending' });
  aliases.booking('da-rifiutare', toReject);
  const toRejectSilently = await fx.booking({ eventType: et, start: romeIso('2030-01-08', '12:00'), status: 'pending' });
  aliases.booking('da-rifiutare-senza-motivo', toRejectSilently);
  const confirmed = await fx.booking({ eventType: et, start: romeIso('2030-01-08', '15:00') });
  aliases.booking('confermata', confirmed);
  const effects = (uid: string) => (): Promise<unknown> => bookingLifecycle([uid]);

  // La proiezione nasce all'approvazione. Bug noto (design §14, "meetingUrl
  // null in approvazione"): url null anche con location custom_url.
  await contract('bookings/approve', { method: 'POST', path: `/bookings/${pending.booking.uid}/approve` }, {
    status: 200, effects: effects(pending.booking.uid),
  });
  await contract('bookings/approve-non-in-attesa', { method: 'POST', path: `/bookings/${confirmed.booking.uid}/approve` }, { status: 400 });
  await contract('bookings/approve-gia-approvata', { method: 'POST', path: `/bookings/${pending.booking.uid}/approve` }, { status: 400 });
  await contract('bookings/approve-inesistente', { method: 'POST', path: '/bookings/nonesiste000/approve' }, { status: 404 });

  await contract('bookings/reject', {
    method: 'POST', path: `/bookings/${toReject.booking.uid}/reject`, body: { reason: 'Zona non coperta', notify: false },
  }, { status: 200, effects: effects(toReject.booking.uid) });
  await contract('bookings/reject-senza-motivo', { method: 'POST', path: `/bookings/${toRejectSilently.booking.uid}/reject` }, {
    status: 200, effects: effects(toRejectSilently.booking.uid),
  });
  await contract('bookings/reject-non-in-attesa', {
    method: 'POST', path: `/bookings/${confirmed.booking.uid}/reject`, body: { notify: false },
  }, { status: 400 });
  await contract('bookings/reject-inesistente', { method: 'POST', path: '/bookings/nonesiste000/reject', body: { notify: false } }, { status: 404 });
});

test('bookings: annullamento (anche idempotente) e marcatura completata o no-show', async () => {
  const et = await fx.eventType({ key: 'gestione', title: 'Consulenza' });
  aliases.add(et.id, 'et:gestione');
  const make = async (key: string, time: string, status?: 'cancelled' | 'pending'): Promise<string> => {
    const created = await fx.booking({ eventType: et, start: romeIso('2030-01-09', time), status });
    aliases.booking(key, created);
    return created.booking.uid;
  };
  const toCancel = await make('da-annullare', '09:00');
  const toCancelNoBody = await make('da-annullare-senza-corpo', '10:00');
  const alreadyCancelled = await make('gia-annullata', '11:00', 'cancelled');
  const toComplete = await make('da-completare', '12:00');
  const toNoShow = await make('assente', '14:00');
  const pending = await make('in-attesa', '15:00', 'pending');
  const effects = (uid: string) => (): Promise<unknown> => bookingLifecycle([uid]);

  // Annullamento: prenotazione cancellata e proiezione marcata 'cancelled' (non eliminata).
  await contract('bookings/cancel', {
    method: 'POST', path: `/bookings/${toCancel}/cancel`, body: { reason: 'Richiesta del cliente', notify: false },
  }, { status: 200, effects: effects(toCancel) });
  await contract('bookings/cancel-senza-corpo', { method: 'POST', path: `/bookings/${toCancelNoBody}/cancel` }, {
    status: 200, effects: effects(toCancelNoBody),
  });
  // Già annullata: 200 senza modifiche (motivo e autore restano quelli originali).
  await contract('bookings/cancel-gia-annullata', {
    method: 'POST', path: `/bookings/${alreadyCancelled}/cancel`, body: { reason: 'Di nuovo', notify: false },
  }, { status: 200, effects: effects(alreadyCancelled) });
  await contract('bookings/cancel-inesistente', { method: 'POST', path: '/bookings/nonesiste000/cancel', body: { notify: false } }, { status: 404 });

  // La marcatura cambia solo lo stato della prenotazione: la proiezione resta 'confirmed'.
  await contract('bookings/mark-completata', {
    method: 'POST', path: `/bookings/${toComplete}/mark`, body: { status: 'completed' },
  }, { status: 200, effects: effects(toComplete) });
  await contract('bookings/mark-no-show', {
    method: 'POST', path: `/bookings/${toNoShow}/mark`, body: { status: 'no_show' },
  }, { status: 200, effects: effects(toNoShow) });
  await contract('bookings/mark-status-non-valido', {
    method: 'POST', path: `/bookings/${toComplete}/mark`, body: { status: 'cancelled' },
  }, { status: 400 });
  await contract('bookings/mark-non-confermata', {
    method: 'POST', path: `/bookings/${pending}/mark`, body: { status: 'completed' },
  }, { status: 404, effects: effects(pending) });
  await contract('bookings/mark-inesistente', { method: 'POST', path: '/bookings/nonesiste000/mark', body: { status: 'no_show' } }, { status: 404 });
});

test("bookings: creazione manuale dall'admin, riprogrammazione e reinvio della conferma", async () => {
  const et = await fx.eventType({ key: 'manuale', title: 'Consulenza', durationMinutes: 60, bufferBeforeMinutes: 15 });
  aliases.add(et.id, 'et:manuale');
  const approval = await fx.eventType({ key: 'manuale-approvazione', title: 'Sopralluogo', requiresApproval: true });
  aliases.add(approval.id, 'et:manuale-approvazione');
  const notice = await fx.eventType({ key: 'preavviso', title: 'Con preavviso', minNoticeHours: 48 });
  aliases.add(notice.id, 'et:preavviso');
  const attendee = (key: string): Record<string, string> => ({
    attendee_name: `Cliente ${key}`,
    attendee_email: fx.email(key),
  });
  const post = (caseId: string, body: Record<string, unknown>, status: number, withEffects = false): Promise<TestResponse> =>
    contract(caseId, { method: 'POST', path: '/bookings', body: { send_emails: false, ...body } }, {
      status,
      effects: withEffects ? (res) => bookingLifecycle([res.json.booking.uid]) : undefined,
    });

  // Creazione manuale: confermata, source 'admin_manual', proiezione con l'url del meeting.
  const created = await post('bookings/create', {
    event_type_id: et.id,
    start: romeIso('2030-01-08', '10:00'),
    attendee_name: 'Sara Blu',
    attendee_email: fx.email('sara'),
    attendee_phone: '+39 333 0000002',
    attendee_company: 'Blu Snc',
    attendee_message: 'Nota interna',
  }, 200, true);
  const uid = created.json.booking.uid as string;
  aliases.add(uid, 'bk:manuale');
  // Su un tipo con requires_approval l'admin crea comunque una prenotazione confermata.
  const other = await post('bookings/create-per-slug-con-approvazione', {
    event_type_slug: approval.slug, start: romeIso('2030-01-08', '15:00'), ...attendee('approvazione'),
  }, 200, true);
  const otherUid = other.json.booking.uid as string;
  aliases.add(otherUid, 'bk:approvazione');
  // Stesso orario: con allow_buffer_override si salta il controllo dei buffer
  // e interviene la EXCLUDE constraint (23P01 → BookingConflictError).
  await post('bookings/create-conflitto', {
    event_type_id: et.id, start: romeIso('2030-01-08', '10:00'), allow_buffer_override: true, ...attendee('conflitto'),
  }, 409);
  // 11:00 sta dentro il buffer di 15 minuti dopo la prenotazione delle 10:00
  // (controllo dei buffer per le prenotazioni non pubbliche, prima dell'INSERT).
  await post('bookings/create-buffer', { event_type_id: et.id, start: romeIso('2030-01-08', '11:00'), ...attendee('buffer') }, 409);
  const forced = await post('bookings/create-buffer-forzato', {
    event_type_id: et.id, start: romeIso('2030-01-08', '11:00'), allow_buffer_override: true, ...attendee('forzato'),
  }, 200);
  aliases.add(forced.json.booking.uid, 'bk:forzato');
  await post('bookings/create-preavviso', { event_type_id: notice.id, start: romeIso('2030-01-08', '09:00'), ...attendee('preavviso') }, 400);
  await post('bookings/create-tipo-mancante', { start: romeIso('2030-01-08', '16:00'), ...attendee('senza-tipo') }, 400);
  await post('bookings/create-start-non-valido', { event_type_id: et.id, start: 'domani', ...attendee('start') }, 400);
  await post('bookings/create-email-non-valida', { event_type_id: et.id, start: romeIso('2030-01-08', '16:00'), attendee_name: 'Cliente', attendee_email: 'non-una-email' }, 400);
  await post('bookings/create-tipo-inesistente', { event_type_slug: fx.slug('nessuno'), start: romeIso('2030-01-08', '16:00'), ...attendee('tipo') }, 400);

  // Riprogrammazione: la vecchia diventa 'cancelled' ("Rescheduled: ..."), la
  // nuova porta rescheduled_from_uid. Bug noto (design §14): la nuova
  // proiezione ha url null.
  const moved = await contract('bookings/reschedule', {
    method: 'POST', path: `/bookings/${uid}/reschedule`, body: { start: romeIso('2030-01-09', '10:00'), notify: false },
  }, { status: 200, effects: (res) => bookingLifecycle([uid, res.json.booking.uid]) });
  const newUid = moved.json.booking.uid as string;
  const [oldRow, newRow] = await bookingRows([uid, newUid]);
  assert.equal(oldRow.status, 'cancelled');
  assert.equal(newRow.rescheduled_from_uid, uid);
  aliases.add(newUid, 'bk:riprogrammata');

  // Conflitto: rollback, l'originale resta confermata.
  await contract('bookings/reschedule-conflitto', {
    method: 'POST', path: `/bookings/${otherUid}/reschedule`, body: { start: romeIso('2030-01-09', '10:00'), notify: false },
  }, { status: 409, effects: () => bookingLifecycle([otherUid]) });
  await contract('bookings/reschedule-start-mancante', { method: 'POST', path: `/bookings/${otherUid}/reschedule`, body: {} }, { status: 400 });
  await contract('bookings/reschedule-inesistente', {
    method: 'POST', path: '/bookings/nonesiste000/reschedule', body: { start: romeIso('2030-01-10', '10:00') },
  }, { status: 404 });
  await contract('bookings/reschedule-gia-annullata', {
    method: 'POST', path: `/bookings/${uid}/reschedule`, body: { start: romeIso('2030-01-10', '10:00'), notify: false },
  }, { status: 400 });

  // Reinvio: cancella la riga di audit 'confirmation' e ritenta l'invio (senza
  // RESEND_API_KEY l'errore resta registrato sulla riga, la route risponde 200).
  await contract('bookings/resend-confirmation', { method: 'POST', path: `/bookings/${newUid}/resend-confirmation` }, {
    status: 200,
    effects: () => sql`
      SELECT r.reminder_type, r.sent_to, r.error_message
      FROM calendar_booking_reminders r JOIN calendar_bookings b ON b.id = r.booking_id
      WHERE b.uid = ${newUid}
      ORDER BY r.reminder_type
    `,
  });
  await contract('bookings/resend-confirmation-inesistente', { method: 'POST', path: '/bookings/nonesiste000/resend-confirmation' }, { status: 404 });
});

// ─── Iscrizioni ICS ───────────────────────────────

test('subscriptions: creazione con sync immediato, cache ETag, errori remoti e SSRF, modifica ed eliminazione', async () => {
  const cal = await calendar('google', { blocks_availability: false });
  const remote = new RemoteIcsServer();
  const url = (name: string): string => `${REMOTE}/${fx.prefix}/${name}.ics`;
  const feed = icsCalendar([
    ['UID:remoto-1@feed.test', 'DTSTAMP:20300101T000000Z', 'DTSTART:20300108T090000Z', 'DTEND:20300108T100000Z', 'SUMMARY:Riunione remota'],
    ['UID:remoto-2@feed.test', 'DTSTAMP:20300101T000000Z', 'DTSTART;VALUE=DATE:20300110', 'DTEND;VALUE=DATE:20300111', 'SUMMARY:Giornata remota'],
  ]);
  remote
    .route(url('valido'), (req) => req.if_none_match === '"v1"'
      ? { status: 304 }
      : {
          status: 200,
          body: feed,
          headers: { 'content-type': 'text/calendar', etag: '"v1"', 'last-modified': 'Mon, 07 Jan 2030 06:00:00 GMT' },
        })
    .route(url('errore'), { status: 500, statusText: 'Internal Server Error', body: 'errore' })
    .route(url('html'), { status: 200, body: '<html><body>Accedi</body></html>', headers: { 'content-type': 'text/html' } })
    .route(url('redirect'), { status: 302, headers: { location: 'http://10.0.0.5/feed.ics' } })
    .install();

  try {
    // Effetti di un sync: richieste ricevute dal remoto, riga dell'iscrizione ed eventi importati.
    const syncEffects = async (subscriptionId: string): Promise<unknown> => ({
      richieste_remote: remote.takeRequests(),
      iscrizione: await subscriptionRow(subscriptionId),
      eventi_importati: await subscriptionEventRows(subscriptionId),
    });
    const create = (caseId: string, name: string, icsUrl: string): Promise<TestResponse> =>
      contract(caseId, {
        method: 'POST', path: '/subscriptions', body: { calendar_id: cal.id, name: fx.name(name), ics_url: icsUrl },
      }, { status: 200, effects: (res) => syncEffects(res.json.subscription.id) });

    // Bug noto (parseIcs, design §14): il feed valido con due VEVENT importa
    // zero eventi. La prima richiesta è senza If-None-Match; ETag e
    // Last-Modified vengono salvati per la successiva.
    const created = await create('subscriptions/create', 'Google lavoro', url('valido'));
    const subId = created.json.subscription.id as string;
    aliases.add(subId, 'sub:google');
    assert.deepEqual(created.json.sync, { notModified: false, inserted: 0, removed: 0, error: null });

    const sync = (caseId: string, id: string, body: unknown, status = 200): Promise<TestResponse> =>
      contract(caseId, { method: 'POST', path: `/subscriptions/${id}/sync`, body }, {
        status,
        effects: status === 200 ? () => syncEffects(id) : undefined,
      });
    // Richiesta condizionale con ETag e Last-Modified salvati, il remoto
    // risponde 304. Bug noto (design §14, "trappola del 304"): fetchIcs
    // tratta ogni 3xx come redirect prima di guardare il 304, quindi il sync
    // fallisce con "Redirect 304 senza Location" e registra last_error invece
    // di risultare notModified. La cache ETag oggi non funziona mai.
    const conditional = await sync('subscriptions/sync-condizionale-304', subId, undefined);
    assert.deepEqual(conditional.json.sync, { notModified: false, inserted: 0, removed: 0, error: 'Redirect 304 senza Location' });
    // force: niente header condizionali, scarica di nuovo.
    await sync('subscriptions/sync-force', subId, { force: true });
    await sync('subscriptions/sync-inesistente', MISSING_UUID, {}, 404);

    // Errori remoti: l'iscrizione viene creata comunque, con last_error e sync.error.
    await create('subscriptions/create-errore-http', 'Feed in errore', url('errore'));
    await create('subscriptions/create-non-calendario', 'Pagina HTML', url('html'));
    await create('subscriptions/create-redirect-privato', 'Redirect interno', url('redirect'));
    await create('subscriptions/create-ip-privato', 'IP privato', 'http://127.0.0.1/feed.ics');
    await create('subscriptions/create-host-locale', 'Host locale', 'http://localhost/feed.ics');

    const invalid = (caseId: string, body: Record<string, unknown>, status: number): Promise<TestResponse> =>
      contract(caseId, { method: 'POST', path: '/subscriptions', body }, { status });
    await invalid('subscriptions/create-calendar-id-mancante', { name: fx.name('Senza calendario'), ics_url: url('valido') }, 400);
    await invalid('subscriptions/create-nome-mancante', { calendar_id: cal.id, name: ' ', ics_url: url('valido') }, 400);
    await invalid('subscriptions/create-url-non-http', { calendar_id: cal.id, name: fx.name('FTP'), ics_url: 'ftp://203.0.113.10/feed.ics' }, 400);
    await invalid('subscriptions/create-calendario-inesistente', { calendar_id: MISSING_UUID, name: fx.name('Fantasma'), ics_url: url('valido') }, 409);

    await contract('subscriptions/list', { method: 'GET', path: '/subscriptions' }, {
      status: 200,
      select: (json) => ({ subscriptions: json.subscriptions.filter((s: { calendar_id: string }) => s.calendar_id === cal.id) }),
    });

    const put = (caseId: string, id: string, body: unknown, status: number): Promise<TestResponse> =>
      contract(caseId, { method: 'PUT', path: `/subscriptions/${id}`, body }, {
        status,
        effects: status === 200 ? () => subscriptionRow(id) : undefined,
      });
    await put('subscriptions/update', subId, { name: fx.name('Google rinominato'), sync_enabled: false }, 200);
    // Cambio di URL: azzera ETag e Last-Modified.
    await put('subscriptions/update-url', subId, { ics_url: `${url('valido')}?v=2` }, 200);
    await put('subscriptions/update-vuoto', subId, {}, 200);
    await put('subscriptions/update-url-non-valido', subId, { ics_url: 'feed.ics' }, 400);
    await put('subscriptions/update-inesistente', MISSING_UUID, { name: fx.name('Fantasma') }, 404);

    await contract('subscriptions/delete', { method: 'DELETE', path: `/subscriptions/${subId}` }, {
      status: 200, effects: () => subscriptionRow(subId),
    });
    await contract('subscriptions/delete-inesistente', { method: 'DELETE', path: `/subscriptions/${MISSING_UUID}` }, { status: 404 });
  } finally {
    remote.restore();
  }
});

test('subscriptions: anti-wipe al sync con eventi già importati, eventi importati in sola lettura', async () => {
  const cal = await calendar('iscrizione');
  const remoteUrl = `${REMOTE}/${fx.prefix}/anti-wipe.ics`;
  const { subscription, events } = await fx.subscription({
    calendar: cal,
    name: 'Google personale',
    url: remoteUrl,
    events: [
      parsedEvent('remoto-a@feed.test', 'Riunione importata', '2030-01-08T09:00:00.000Z', '2030-01-08T10:00:00.000Z'),
      parsedEvent('remoto-b@feed.test', 'Giornata importata', '2030-01-10T00:00:00.000Z', '2030-01-11T00:00:00.000Z', true),
    ],
  });
  aliases.add(subscription.id, 'sub:personale');
  const [timed] = events;
  aliases.event('importato', timed);

  // Il remoto risponde con gli stessi due eventi in un VCALENDAR valido.
  const remote = new RemoteIcsServer().route(remoteUrl, {
    status: 200,
    headers: { etag: '"w1"' },
    body: icsCalendar([
      ['UID:remoto-a@feed.test', 'DTSTART:20300108T090000Z', 'DTEND:20300108T100000Z', 'SUMMARY:Riunione importata'],
      ['UID:remoto-b@feed.test', 'DTSTART;VALUE=DATE:20300110', 'DTEND;VALUE=DATE:20300111', 'SUMMARY:Giornata importata'],
    ]),
  }).install();

  try {
    await contract('events/list-iscrizione', {
      method: 'GET', path: '/events', query: { calendar_id: cal.id, from: '2030-01-07T00:00:00.000Z', to: '2030-01-14T00:00:00.000Z' },
    }, { status: 200 });

    // Gli eventi ics_pull sono di sola lettura (EventReadOnlyError → 403)...
    await contract('events/update-ics-pull', {
      method: 'PUT', path: `/events/${timed.id}`, body: { summary: fx.name('Rinominato') },
    }, { status: 403, effects: () => eventRows([timed.id]) });
    await contract('events/delete-ics-pull', { method: 'DELETE', path: `/events/${timed.id}` }, {
      status: 403, effects: () => eventRows([timed.id]),
    });
    await contract('events/exception-ics-pull', {
      method: 'POST', path: `/events/${timed.id}/exception`, body: { original_start: '2030-01-08T09:00:00.000Z' },
    }, { status: 403 });
    // ...ma si possono duplicare: la copia è un evento 'admin' modificabile.
    await contract('events/duplicate-ics-pull', { method: 'POST', path: `/events/${timed.id}/duplicate` }, {
      status: 200, effects: (res) => eventRows([res.json.event.id]),
    });

    const syncEffects = async (): Promise<Record<string, unknown>> => ({
      richieste_remote: remote.takeRequests(),
      iscrizione: await subscriptionRow(subscription.id),
      eventi_importati: await subscriptionEventRows(subscription.id),
    });
    // Bug noto (parseIcs, design §14) combinato con la protezione anti-wipe:
    // il feed valido viene letto come vuoto e, con due eventi già importati,
    // il sync si annulla con un errore. Gli eventi locali restano.
    const guarded = await contract('subscriptions/sync-anti-wipe', {
      method: 'POST', path: `/subscriptions/${subscription.id}/sync`,
    }, { status: 200, effects: syncEffects });
    assert.match(guarded.json.sync.error, /protezione anti-wipe/);
    assert.equal((await subscriptionEventRows(subscription.id)).length, 2);
    // Con force il feed "vuoto" svuota davvero l'iscrizione (la copia duplicata resta).
    const forced = await contract('subscriptions/sync-force-svuota', {
      method: 'POST', path: `/subscriptions/${subscription.id}/sync`, body: { force: true },
    }, {
      status: 200,
      effects: async () => ({ ...await syncEffects(), eventi_del_calendario: await calendarEventRows(cal.id) }),
    });
    assert.deepEqual(forced.json.sync, { notModified: false, inserted: 0, removed: 2, error: null });
  } finally {
    remote.restore();
  }
});

// ─── Copertura ───────────────────────────────

contractCoverageTest(store, TEST_FILE);
