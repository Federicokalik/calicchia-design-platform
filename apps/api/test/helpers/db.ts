/**
 * Database dei test: migrazioni, prefissi dei dati, pulizia e chiusura del pool.
 *
 * Il pool è lo stesso di src/db/index.ts (un solo pool per processo, come in
 * produzione); `./env` va importato per primo perché quel modulo crea il pool
 * all'import leggendo DATABASE_URL.
 *
 * Modello di isolamento:
 * - ogni file di test chiama `useTestDatabase()` (migrazioni prima, chiusura
 *   del pool dopo);
 * - ogni gruppo di dati nasce sotto un prefisso (`testPrefix()`), usato in slug,
 *   nomi, titoli, email e label: `cleanupTestData(prefix)` cancella tutto ciò
 *   che lo porta, più le righe registrate per id (calendario 'f', proiezioni
 *   nel calendario 'bookings', festività...);
 * - `resetCalendarBaseline()` riporta il dominio calendario allo stato di un
 *   database appena migrato (utile per i contratti, che non devono vedere
 *   righe di altri run o del template del database).
 *
 * I test girano con --test-concurrency=1: i file sono sequenziali sullo stesso
 * database, quindi un prefisso è univoco se è univoco dentro il processo.
 */

import './env';
import { after, before } from 'node:test';
import { sql } from '../../src/db';
import { runPendingMigrations } from '../../src/lib/db-migrate';
import { TEST_DATABASE } from './env';

export { sql };

/** Radice comune a tutti i prefissi dei dati di test. */
export const TEST_DATA_ROOT = 'tst';

// ─── Verifica della connessione ───────────────────────────────

let verified: Promise<void> | null = null;

/**
 * Seconda barriera dopo quella sull'URL (helpers/env.ts): il database a cui il
 * pool è davvero connesso deve essere quello di TEST_DATABASE_URL. Le funzioni
 * distruttive di questo modulo la richiamano prima di scrivere.
 */
export function assertConnectedToTestDatabase(): Promise<void> {
  verified ??= (async () => {
    const [row] = await sql<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (row?.db !== TEST_DATABASE.database) {
      throw new Error(
        `Connessione al database "${row?.db}" invece di "${TEST_DATABASE.database}": test interrotti.`,
      );
    }
  })();
  return verified;
}

// ─── Migrazioni e ciclo di vita ───────────────────────────────

let migrated: Promise<void> | null = null;

/**
 * Applica le migrazioni pendenti con lo stesso runner del boot dell'API
 * (ledger schema_migrations e advisory lock). Una volta per processo; nei run
 * successivi al primo è un no-op veloce.
 */
export function migrateTestDatabase(): Promise<void> {
  migrated ??= (async () => {
    await assertConnectedToTestDatabase();
    await runPendingMigrations();
  })();
  return migrated;
}

let closed = false;

/** Chiude il pool attendendo le query in corso (anche quelle fire-and-forget). */
export async function closeTestDatabase(): Promise<void> {
  if (closed) return;
  closed = true;
  await sql.end({ timeout: 5 });
}

type Task = () => Promise<unknown>;
const readyTasks: Task[] = [];
const teardownTasks: Task[] = [];
let hooksRegistered = false;
let resetRequested = false;

/** Registra un'operazione da eseguire dopo le migrazioni, prima del primo test del file. */
export function onDatabaseReady(task: Task): void {
  readyTasks.push(task);
}

/** Registra un'operazione da eseguire dopo l'ultimo test, prima della chiusura del pool. */
export function onBeforeDatabaseClose(task: Task): void {
  teardownTasks.push(task);
}

/**
 * Da chiamare in cima a ogni file di test che usa il database (idempotente):
 * prima del primo test applica le migrazioni, poi (se richiesto) riporta il
 * calendario alla baseline e infine esegue i task di `onDatabaseReady` (es. la
 * pre-pulizia delle fixture); dopo l'ultimo test esegue i task di
 * `onBeforeDatabaseClose` in ordine inverso e chiude il pool. Senza la
 * chiusura il processo del file resterebbe vivo fino all'idle timeout.
 *
 * Un solo `before` e un solo `after` garantiscono l'ordine fra migrazioni,
 * fixture e chiusura qualunque sia l'ordine delle chiamate nel file.
 */
export function useTestDatabase(opts: { resetBaseline?: boolean } = {}): void {
  if (opts.resetBaseline) resetRequested = true;
  if (hooksRegistered) return;
  hooksRegistered = true;

  before(async () => {
    await migrateTestDatabase();
    if (resetRequested) await resetCalendarBaseline();
    for (const task of readyTasks) await task();
  });
  after(async () => {
    try {
      for (const task of [...teardownTasks].reverse()) await task();
    } finally {
      await closeTestDatabase();
    }
  });
}

// ─── Prefissi ───────────────────────────────

const usedPrefixes = new Set<string>();

/** Riduce un'etichetta libera all'alfabeto ammesso negli slug (a-z, 0-9, -). */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Prefisso univoco nel processo per i dati di un gruppo di test, nella forma
 * `tst-<etichetta>` (deterministico, quindi stabile negli snapshot) oppure
 * `tst-<etichetta>-<6 caratteri casuali>` con `random: true`.
 *
 * Rifiuta un prefisso già usato o che sia prefisso di (o abbia come prefisso)
 * uno già usato: la pulizia per prefisso cancellerebbe anche i dati dell'altro.
 */
export function testPrefix(label: string, opts: { random?: boolean } = {}): string {
  const slug = slugify(label).slice(0, 40).replace(/-+$/, '');
  if (!slug) throw new Error(`Etichetta di test non valida: "${label}"`);
  const suffix = opts.random ? `-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}` : '';
  const prefix = `${TEST_DATA_ROOT}-${slug}${suffix}`;
  for (const used of usedPrefixes) {
    if (used.startsWith(prefix) || prefix.startsWith(used)) {
      throw new Error(`Prefisso di test "${prefix}" in conflitto con "${used}" già usato in questo processo`);
    }
  }
  usedPrefixes.add(prefix);
  return prefix;
}

/** Escape dei caratteri speciali di LIKE (il prefisso non li contiene, ma per sicurezza). */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// ─── Pulizia ───────────────────────────────

/** Righe create per id e non riconoscibili dal prefisso (slug fissi, uid generati). */
export interface TrackedRows {
  calendarIds?: Iterable<string>;
  eventIds?: Iterable<string>;
  bookingIds?: Iterable<string>;
  eventTypeIds?: Iterable<string>;
  scheduleIds?: Iterable<string>;
  subscriptionIds?: Iterable<string>;
  appPasswordIds?: Iterable<string>;
  mcpTokenIds?: Iterable<string>;
  deviceTokenIds?: Iterable<string>;
  leadIds?: Iterable<string>;
}

/** Conteggio delle righe cancellate per tabella (eventi e audit compresi). */
export type CleanupReport = Record<string, number>;

const toArray = (values?: Iterable<string>): string[] => (values ? [...values] : []);

/**
 * Cancella tutti i dati che portano il prefisso o sono registrati per id, in
 * ordine compatibile con le foreign key:
 *  1. prenotazioni (email con il prefisso, tipo con lo slug del prefisso o id
 *     registrati) con le loro proiezioni nel calendario 'bookings' e i lead
 *     creati dalla POST pubblica (source_id = uid della prenotazione);
 *  2. tipi di prenotazione e schedule;
 *  3. calendari (le cascate rimuovono eventi, override e iscrizioni);
 *  4. eventi rimasti (uid o titolo con il prefisso, id registrati);
 *  5. iscrizioni, app-password CalDAV, token MCP e device;
 *  6. righe di audit_logs scritte dai trigger sulle tabelle del calendario.
 */
export async function cleanupTestData(prefix: string, tracked: TrackedRows = {}): Promise<CleanupReport> {
  if (!prefix.startsWith(`${TEST_DATA_ROOT}-`)) {
    throw new Error(`Pulizia rifiutata: "${prefix}" non è un prefisso di test (atteso "${TEST_DATA_ROOT}-...")`);
  }
  await assertConnectedToTestDatabase();
  const like = likePrefix(prefix);
  const report: CleanupReport = {};
  const audited: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tipo tx di postgres-js (stesso pattern di src/)
  await sql.begin(async (tx: any) => {
    const count = (table: string, rows: Array<{ id: string }>): void => {
      report[table] = (report[table] ?? 0) + rows.length;
    };

    // 1. Prenotazioni, proiezioni e lead.
    const bookings: Array<{ id: string; uid: string; lead_id: string | null }> = await tx`
      SELECT b.id, b.uid, b.lead_id
      FROM calendar_bookings b
      LEFT JOIN calendar_event_types et ON et.id = b.event_type_id
      WHERE b.attendee_email LIKE ${like}
         OR et.slug LIKE ${like}
         OR b.id = ANY(${toArray(tracked.bookingIds)}::uuid[])
         OR b.event_type_id = ANY(${toArray(tracked.eventTypeIds)}::uuid[])
    `;
    const bookingUids = bookings.map((b) => b.uid);
    const projections = await tx`
      DELETE FROM calendar_events
      WHERE source = 'booking' AND source_id = ANY(${bookingUids}::text[])
      RETURNING id
    `;
    count('calendar_events', projections);
    audited.push(...projections.map((r: { id: string }) => r.id));
    count('calendar_bookings', await tx`
      DELETE FROM calendar_bookings WHERE id = ANY(${bookings.map((b) => b.id)}::uuid[]) RETURNING id
    `);
    const leadIds = [
      ...bookings.map((b) => b.lead_id).filter((id): id is string => !!id),
      ...toArray(tracked.leadIds),
    ];
    count('leads', await tx`
      DELETE FROM leads
      WHERE id = ANY(${leadIds}::uuid[])
         OR (source LIKE 'booking\\_%' AND source_id = ANY(${bookingUids}::text[]))
         OR email LIKE ${like}
      RETURNING id
    `);

    // 2. Tipi di prenotazione e schedule.
    count('calendar_event_types', await tx`
      DELETE FROM calendar_event_types
      WHERE slug LIKE ${like} OR id = ANY(${toArray(tracked.eventTypeIds)}::uuid[])
      RETURNING id
    `);
    count('calendar_availability_schedules', await tx`
      DELETE FROM calendar_availability_schedules
      WHERE name LIKE ${like} OR id = ANY(${toArray(tracked.scheduleIds)}::uuid[])
      RETURNING id
    `);

    // 3. Calendari: raccoglie prima gli id di eventi e iscrizioni che le
    //    cascate rimuoveranno, per pulirne poi le righe di audit.
    const calendars: Array<{ id: string }> = await tx`
      SELECT id FROM calendars
      WHERE slug LIKE ${like} OR id = ANY(${toArray(tracked.calendarIds)}::uuid[])
    `;
    const calendarIds = calendars.map((c) => c.id);
    if (calendarIds.length) {
      const cascaded = await tx`
        SELECT id FROM calendar_events WHERE calendar_id = ANY(${calendarIds}::uuid[])
        UNION ALL
        SELECT id FROM calendar_subscriptions WHERE calendar_id = ANY(${calendarIds}::uuid[])
      `;
      audited.push(...cascaded.map((r: { id: string }) => r.id));
      report.cascaded_rows = cascaded.length;
    }
    count('calendars', await tx`DELETE FROM calendars WHERE id = ANY(${calendarIds}::uuid[]) RETURNING id`);
    audited.push(...calendarIds);

    // 4. Eventi rimasti in calendari non di test (es. 'bookings', seed).
    const events = await tx`
      DELETE FROM calendar_events
      WHERE uid LIKE ${like}
         OR summary LIKE ${like}
         OR id = ANY(${toArray(tracked.eventIds)}::uuid[])
      RETURNING id
    `;
    count('calendar_events', events);
    audited.push(...events.map((r: { id: string }) => r.id));

    // 5. Iscrizioni, credenziali dei device e token.
    const subscriptions = await tx`
      DELETE FROM calendar_subscriptions
      WHERE name LIKE ${like} OR id = ANY(${toArray(tracked.subscriptionIds)}::uuid[])
      RETURNING id
    `;
    count('calendar_subscriptions', subscriptions);
    audited.push(...subscriptions.map((r: { id: string }) => r.id));
    count('caldav_app_passwords', await tx`
      DELETE FROM caldav_app_passwords
      WHERE device_name LIKE ${like} OR id = ANY(${toArray(tracked.appPasswordIds)}::uuid[])
      RETURNING id
    `);
    count('mcp_tokens', await tx`
      DELETE FROM mcp_tokens
      WHERE label LIKE ${like} OR id = ANY(${toArray(tracked.mcpTokenIds)}::uuid[])
      RETURNING id
    `);
    count('device_tokens', await tx`
      DELETE FROM device_tokens
      WHERE label LIKE ${like} OR id = ANY(${toArray(tracked.deviceTokenIds)}::uuid[])
      RETURNING id
    `);

    // 6. Audit scritto dai trigger audit_trigger_function sulle tabelle calendario.
    count('audit_logs', await tx`
      DELETE FROM audit_logs
      WHERE table_name IN ('calendars', 'calendar_events', 'calendar_subscriptions')
        AND record_id = ANY(${audited}::text[])
      RETURNING id
    `);
  });

  return report;
}

// ─── Audit dei trigger ───────────────────────────────

/** Istante corrente del server Postgres (gli audit_logs usano NOW() del server, non l'orologio fermo). */
export async function databaseNow(): Promise<string> {
  const [row] = await sql<Array<{ now: Date }>>`SELECT now() AS now`;
  return row.now.toISOString();
}

/**
 * Cancella le righe di audit_logs scritte dai trigger sulle tabelle del
 * calendario dopo `since` (da `databaseNow()` all'avvio del file) che
 * riguardano i dati dei test: testo con uno dei prefissi, oppure record o
 * calendar_id fra gli id indicati (calendari dei test, calendari seminati
 * toccati dai test). Copre ciò che `cleanupTestData` non può riconoscere:
 * eventi cancellati dalle route (DELETE, sync delle iscrizioni) e
 * aggiornamenti dei calendari seminati (es. is_default).
 */
export async function cleanupCalendarAudit(opts: {
  since: string;
  prefixes: string[];
  ids: Iterable<string>;
}): Promise<number> {
  await assertConnectedToTestDatabase();
  const likes = opts.prefixes.map((p) => `%${likePrefix(p)}`);
  const ids = [...opts.ids];
  const rows = await sql`
    DELETE FROM audit_logs
    WHERE table_name IN ('calendars', 'calendar_events', 'calendar_subscriptions')
      AND created_at >= ${opts.since}::timestamptz
      AND (
        old_data::text LIKE ANY(${likes}::text[])
        OR new_data::text LIKE ANY(${likes}::text[])
        OR record_id = ANY(${ids}::text[])
        OR old_data->>'calendar_id' = ANY(${ids}::text[])
        OR new_data->>'calendar_id' = ANY(${ids}::text[])
      )
    RETURNING id
  `;
  return rows.length;
}

// ─── Baseline del dominio calendario ───────────────────────────────

/** Calendari seminati dalla migrazione 071 (gli unici di un database appena migrato). */
export const SEED_CALENDAR_SLUGS = ['lavoro', 'personale', 'bookings', 'scadenze'] as const;

/** Tipi di prenotazione seminati dalla migrazione 067. */
export const SEED_EVENT_TYPE_SLUGS = ['consulenza-gratuita-30min', 'sopralluogo-in-presenza'] as const;

/**
 * Riporta il dominio calendario allo stato di un database appena migrato:
 * - cancella tutte le prenotazioni (con promemoria e lead collegati) e i
 *   tipi di prenotazione non seminati;
 * - cancella i calendari non seminati (anche 'festivita' o 'f' rimasti da
 *   altri run o dal template del database) con eventi e iscrizioni, poi gli
 *   eventi rimasti nei calendari seminati;
 * - cancella app-password CalDAV, schedule non di default e override;
 * - ripristina gli slot dello schedule di default (lun-ven 09-13 e 14-18,
 *   migrazione 068) e 'lavoro' come calendario di default.
 *
 * Non tocca le righe seminate di calendari e tipi di prenotazione (i test non
 * devono modificarle: si creano le proprie con le fixture) né le altre aree
 * dell'applicazione. Distruttiva: ammessa solo sul database dei test.
 */
export async function resetCalendarBaseline(): Promise<void> {
  await assertConnectedToTestDatabase();
  const seedCalendars = [...SEED_CALENDAR_SLUGS];
  const seedEventTypes = [...SEED_EVENT_TYPE_SLUGS];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tipo tx di postgres-js (stesso pattern di src/)
  await sql.begin(async (tx: any) => {
    const leads = await tx`DELETE FROM calendar_bookings RETURNING lead_id, uid`;
    await tx`
      DELETE FROM leads
      WHERE id = ANY(${leads.map((r: { lead_id: string | null }) => r.lead_id).filter(Boolean)}::uuid[])
         OR (source LIKE 'booking\\_%' AND source_id = ANY(${leads.map((r: { uid: string }) => r.uid)}::text[]))
    `;
    await tx`DELETE FROM calendar_event_types WHERE slug <> ALL(${seedEventTypes}::text[])`;

    await tx`DELETE FROM calendars WHERE slug <> ALL(${seedCalendars}::text[])`;
    await tx`DELETE FROM calendar_events`;
    await tx`DELETE FROM calendar_subscriptions`;
    await tx`DELETE FROM caldav_app_passwords`;
    await tx`
      UPDATE calendars SET is_default = (slug = 'lavoro')
      WHERE is_default IS DISTINCT FROM (slug = 'lavoro')
    `;

    const [defaultSchedule]: Array<{ id: string }> = await tx`
      SELECT id FROM calendar_availability_schedules
      WHERE is_default = true ORDER BY created_at ASC LIMIT 1
    `;
    if (defaultSchedule) {
      await tx`DELETE FROM calendar_availability_schedules WHERE id <> ${defaultSchedule.id}::uuid`;
      await tx`DELETE FROM calendar_availability_overrides WHERE schedule_id = ${defaultSchedule.id}::uuid`;
      await tx`DELETE FROM calendar_availability_slots WHERE schedule_id = ${defaultSchedule.id}::uuid`;
      await tx`
        INSERT INTO calendar_availability_slots (schedule_id, day_of_week, start_time, end_time)
        SELECT ${defaultSchedule.id}::uuid, dow, t.start_time, t.end_time
        FROM generate_series(1, 5) AS dow,
             (VALUES ('09:00'::time, '13:00'::time), ('14:00'::time, '18:00'::time)) AS t(start_time, end_time)
      `;
      await tx`
        UPDATE calendar_event_types SET schedule_id = ${defaultSchedule.id}::uuid
        WHERE slug = ANY(${seedEventTypes}::text[]) AND schedule_id IS DISTINCT FROM ${defaultSchedule.id}::uuid
      `;
    }

    await tx`DELETE FROM mcp_tokens WHERE label LIKE ${likePrefix(`${TEST_DATA_ROOT}-`)}`;
    await tx`DELETE FROM device_tokens WHERE label LIKE ${likePrefix(`${TEST_DATA_ROOT}-`)}`;
  });
}
