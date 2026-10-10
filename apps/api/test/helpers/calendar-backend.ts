/**
 * Store del calendario sotto test: la matrice CALENDAR_BACKEND=postgres|radicale
 * del design §15 (piano F2, "Test": contratti di F0 su entrambi gli store).
 *
 * - `postgres` (default): nessun cambiamento. La facade sceglie lo store dal
 *   modo di calendar_backend_state, che la baseline lascia a 'postgres':
 *   PgLegacyStore, cioè il codice di prima della F2.
 * - `radicale`: per ogni file che chiama `useCalendarBackend()` parte un
 *   Radicale 3.7.8 reale (storage multifilesystem in una directory temporanea,
 *   htpasswd con il solo caldes-svc e la matrice di caldes-svc del contratto
 *   control-plane §8). Il volume si inizializza come in F1 (initializeVolume:
 *   principal, marker volume-id/epoch, collezioni del sidecar e _canary), il
 *   runtime della sync punta allo storage come al mount di produzione, il
 *   campanello gira davvero (stat delle directory) e la facade è forzata su
 *   RadicaleStore con overrideCalendarStore('radicale'). Fixture e route
 *   scrivono quindi oggetti iCalendar su Radicale attraverso RadicaleStore, e
 *   le letture passano da sync e indice reali.
 *
 * I job del calendario (proiezioni delle prenotazioni, controllo delle
 * sovrapposizioni, saghe) in produzione li esegue il worker pochi millisecondi
 * dopo la COMMIT. Nei test vengono eseguiti subito, dopo ogni richiesta HTTP
 * (hook di helpers/http.ts) e da `settleCalendar()`, così gli effetti
 * registrati negli snapshot sono deterministici.
 *
 * Con CALENDAR_BACKEND=radicale e Radicale non disponibile il file fallisce:
 * la matrice non deve passare "a vuoto" saltando i test.
 */

import './env';
import assert from 'node:assert/strict';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { registerBookingJobs } from '../../src/lib/calendar/booking';
import { clearIndexFeedCache } from '../../src/lib/calendar/feed-builder';
import { runCalendarJobsOnce } from '../../src/lib/calendar/jobs';
import { collectionPath, objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { listRadicaleCollections } from '../../src/lib/calendar/radicale/discovery';
import { isRadicaleError } from '../../src/lib/calendar/radicale/errors';
import { CANARY_COLLECTION } from '../../src/lib/calendar/radicale/types';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { ensureHorizon } from '../../src/lib/calendar/radicale/horizon';
import { registerIndexRebuildJob } from '../../src/lib/calendar/radicale/rebuild';
import { registerStoreJobs } from '../../src/lib/calendar/radicale/store';
import {
  applyHeldDeletions,
  CollectionSyncError,
  configureRadicaleRuntime,
  drainSyncs,
  syncAllCollections,
  syncCollection,
  updateWatchMode,
} from '../../src/lib/calendar/radicale/sync';
import { startCalendarWatcher, stopCalendarWatcher, watcherAlive } from '../../src/lib/calendar/radicale/watcher';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import { registerSubscriptionMirrorJob } from '../../src/lib/calendar/subscriptions/mirror';
import { resetSubscriptionPullCache } from '../../src/lib/calendar/subscriptions/pull';
import { onDatabaseClosing, onDatabaseReady, sql } from './db';
import { onClockChange } from './clock';
import { onAfterRequest, onBeforeRequest } from './http';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from './radicale';

/** Store selezionabile con CALENDAR_BACKEND. */
export type CalendarBackend = 'postgres' | 'radicale';

const BACKENDS: readonly CalendarBackend[] = ['postgres', 'radicale'];

/** Store del run (CALENDAR_BACKEND, default 'postgres'); un valore sconosciuto è un errore. */
export function calendarBackend(): CalendarBackend {
  const raw = (process.env.CALENDAR_BACKEND || 'postgres').trim().toLowerCase();
  if (!(BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(`CALENDAR_BACKEND="${process.env.CALENDAR_BACKEND}" non valido: atteso ${BACKENDS.join(' | ')}`);
  }
  return raw as CalendarBackend;
}

/** True se il run gira sullo store Radicale. */
export function isRadicaleBackend(): boolean {
  return calendarBackend() === 'radicale';
}

/** Password di caldes-svc del Radicale dei test (mai usata fuori dal harness). */
const SVC_PASSWORD = 'test-only-svc-password-contract-matrix';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${TEST_PRINCIPAL}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${TEST_PRINCIPAL}/[^/]+`, 'permissions: rwD', '',
].join('\n');

/** Intervallo del campanello nei test: stretto, così una modifica fuori dall'API si vede subito. */
const WATCHER_INTERVAL_MS = 100;

interface RadicaleBackendState {
  server: RadicaleServer;
  client: RadicaleClient;
  removeHooks: Array<() => void>;
}

let active: RadicaleBackendState | null = null;
let registered = false;
/** Giorno (UTC) più avanti per cui l'orizzonte è già allineato. */
let horizonDay: string | null = null;
/** L'orologio fermo è cambiato: il campanello deve fare un giro con il nuovo "adesso". */
let clockMoved = false;

/** Radicale e client di servizio del file (solo con lo store Radicale avviato). */
export function radicaleBackend(): { server: RadicaleServer; client: RadicaleClient; principal: string } | null {
  return active ? { server: active.server, client: active.client, principal: TEST_PRINCIPAL } : null;
}

/**
 * Orizzonte dell'indice allineato all'orologio dei test: in produzione il
 * cron giornaliero (ensureHorizon) lo fa avanzare con i giorni, nei test
 * l'orologio fermo salta di anni (freezeTime nel 2027 o nel 2030) e le
 * collezioni indicizzate prima resterebbero con l'orizzonte di allora (le
 * decisioni risponderebbero 503 horizon_insufficient). Si esegue prima di
 * ogni richiesta e prima dei tool, solo quando il giorno è cambiato.
 */
export async function alignCalendarHorizon(): Promise<void> {
  if (!active) return;
  if (clockMoved) await waitForWatcherTick();
  const day = new Date().toISOString().slice(0, 10);
  // Tornando indietro nel tempo l'orizzonte già esteso copre ancora "oggi"
  // + max_advance_days; le date prima del suo inizio si espandono al volo.
  if (horizonDay !== null && day <= horizonDay) return;
  const { failed } = await ensureHorizon({ now: new Date() });
  assert.equal(failed.length, 0, `orizzonte dell'indice non esteso per ${failed.length} collezioni`);
  horizonDay = day;
}

/**
 * Dopo un salto dell'orologio fermo il campanello risulta fermo finché non
 * fa un giro con il nuovo "adesso" (watcherAlive confronta l'ultimo giro con
 * Date.now()): in produzione il tempo scorre e il problema non esiste. Qui si
 * attende il giro successivo prima della richiesta, al più 15 s: un giro può
 * attendere una sync in corso, e sulla macchina condivisa dei test qualche
 * secondo di ritardo non deve diventare un 503 watcher_down.
 */
async function waitForWatcherTick(): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!watcherAlive() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  clockMoved = false;
}

/**
 * Esegue i job del calendario pronti (proiezioni delle prenotazioni, saghe,
 * specchi), finché la coda non ne ha più, e attende le sync in corso. No-op
 * con lo store Postgres.
 */
export async function settleCalendar(): Promise<void> {
  if (!active) return;
  for (let round = 0; round < 50; round++) {
    const summary = await runCalendarJobsOnce({ limit: 50, workerId: 'test-matrix' });
    if (summary.claimed === 0) break;
  }
  await drainSyncs(5_000).catch(() => undefined);
  await reportUnsyncableCollections();
}

/** Collezioni già segnalate come non sincronizzabili (una riga per episodio). */
const reportedUnsyncable = new Set<string>();

/**
 * Diagnostica della matrice: una collezione bloccante 'unsyncable' fa
 * rispondere 503 alle decisioni e, con l'orologio fermo lontano dall'ora del
 * database, anche al livello display (la tolleranza di 10 minuti risulta già
 * scaduta). Il test che ne segue fallisce con un errore generico (per esempio
 * "Errore esecuzione tool"): qui si stampa su stderr la causa registrata dalla
 * sync, una volta per episodio, senza cambiare il comportamento.
 */
async function reportUnsyncableCollections(): Promise<void> {
  const rows = await sql<Array<{ calendar_id: string; collection_name: string | null; last_error: string | null; consecutive_failures: number }>>`
    SELECT s.calendar_id::text AS calendar_id, c.collection_name, s.last_error, s.consecutive_failures
    FROM cal_collection_state s JOIN calendars c ON c.id = s.calendar_id
    WHERE s.origin_store = 'radicale' AND s.health = 'unsyncable'
  `;
  const current = new Set(rows.map((r) => r.calendar_id));
  for (const id of [...reportedUnsyncable]) if (!current.has(id)) reportedUnsyncable.delete(id);
  for (const r of rows) {
    if (reportedUnsyncable.has(r.calendar_id)) continue;
    reportedUnsyncable.add(r.calendar_id);
    console.warn(`[matrice radicale] collezione ${r.collection_name ?? r.calendar_id} non sincronizzabile (${r.consecutive_failures} fallimenti): ${r.last_error ?? 'motivo non registrato'}`);
  }
}

/**
 * Pulizia lato Radicale dei dati di un gruppo di fixture, dopo quella in SQL
 * (cleanupTestData), così lo stato di Radicale segue quello di PG come con lo
 * store legacy. No-op con lo store Postgres.
 *  - oggetti del gruppo nei calendari che restano (seminati come
 *    'bookings'): id registrati, UID o titolo con il prefisso, e proiezioni
 *    booking-<uid>.ics di prenotazioni che non esistono più;
 *  - collezioni senza più una riga attiva in `calendars` (tranne _canary): la
 *    pulizia cancella i calendari in SQL, e una collezione rimasta farebbe
 *    rispondere "Slug gia usato" alla creazione di un calendario con lo
 *    stesso slug nel test successivo. Indice e id spariscono con la riga
 *    (cascade).
 */
export async function pruneRadicaleData(prefix: string, trackedEventIds: Iterable<string>): Promise<void> {
  if (!active) return;
  const { client } = active;
  const like = `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const objects = await sql<Array<{ calendar_id: string; collection_name: string; href: string }>>`
    SELECT DISTINCT o.calendar_id::text AS calendar_id, c.collection_name, o.href
    FROM cal_objects o
    JOIN calendars c ON c.id = o.calendar_id
    LEFT JOIN cal_components comp ON comp.object_id = o.id AND comp.recurrence_key = ''
    WHERE c.role <> 'subscription' AND c.collection_name IS NOT NULL
      AND (
        o.id = ANY(${[...trackedEventIds]}::uuid[])
        OR o.uid LIKE ${like}
        OR comp.summary LIKE ${like}
        OR (o.href LIKE 'booking-%' AND NOT EXISTS (
          SELECT 1 FROM calendar_bookings b WHERE o.href = 'booking-' || b.uid || '.ics'
        ))
      )
  `;
  const touched = new Set<string>();
  for (const o of objects) {
    try {
      await client.delete(objectPath(TEST_PRINCIPAL, o.collection_name, o.href), { ifMatch: '*' });
    } catch (err) {
      if (!isRadicaleError(err, 'not_found')) throw err;
    }
    touched.add(o.calendar_id);
  }
  for (const calendarId of touched) {
    await syncCollection(calendarId, { reason: 'manual', actor: 'test-cleanup' });
    // La pulizia può svuotare una collezione (per esempio tutte le proiezioni
    // di 'bookings'): l'interruttore anti-cancellazione la mette in hold, come
    // deve. Qui la cancellazione è voluta: si applica come farebbe l'admin con
    // "applica cancellazioni" (design §6.2).
    await applyHeldDeletions(calendarId, { actor: 'test-cleanup' });
  }

  const listed = await listRadicaleCollections(client, TEST_PRINCIPAL);
  const rows = await sql<Array<{ collection_name: string }>>`
    SELECT collection_name FROM calendars WHERE collection_name IS NOT NULL AND lifecycle <> 'deleting'
  `;
  const keep = new Set([...rows.map((r) => r.collection_name), CANARY_COLLECTION]);
  const stale = listed.filter((c) => !keep.has(c.name));
  for (const c of stale) {
    try {
      await client.delete(collectionPath(TEST_PRINCIPAL, c.name), { ifMatch: '*' });
    } catch (err) {
      if (!isRadicaleError(err, 'not_found')) throw err;
    }
  }
  if (stale.length) await drainSyncs(5_000).catch(() => undefined);
}

/**
 * Prepara lo store del calendario per il file (testa del modulo). Va chiamata
 * dopo `useFixtures()` (o `useTestDatabase()`) e prima di registrare lo
 * scenario con `onDatabaseReady`: l'avvio di Radicale deve seguire baseline e
 * pre-pulizia, e precedere i dati del file. Idempotente; no-op con lo store
 * Postgres.
 */
export function useCalendarBackend(): CalendarBackend {
  const backend = calendarBackend();
  if (backend === 'postgres' || registered) return backend;
  registered = true;

  const availability = radicaleAvailability();
  onDatabaseReady(async () => {
    assert.ok(
      availability.available,
      `CALENDAR_BACKEND=radicale richiede Radicale 3.7.8 (RADICALE_BIN): ${availability.reason ?? 'non disponibile'}`,
    );
    await startRadicaleBackend();
  });
  onDatabaseClosing(stopRadicaleBackend);
  return backend;
}

/**
 * Guardia sulla tabella dello store legacy, come il trigger 166 del design
 * (§4) ma per i test: con lo store Radicale nessun percorso deve scrivere
 * calendar_events, quindi un INSERT o un UPDATE fa fallire il test che lo
 * provoca. Le DELETE restano ammesse (pulizia delle fixture). La funzione si
 * spegne da sola dopo un'ora, nel caso un run interrotto la lasci nel
 * database; la tolgono comunque l'arresto della matrice e resetCalendarBaseline().
 */
async function installLegacyWriteGuard(): Promise<void> {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION caldes_test_matrix_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
    BEGIN
      IF clock_timestamp() < '${expiresAt}'::timestamptz THEN
        RAISE EXCEPTION 'matrice CALENDAR_BACKEND=radicale: % su calendar_events con lo store Radicale', TG_OP;
      END IF;
      RETURN NEW;
    END
    $guard$
  `);
  await sql`DROP TRIGGER IF EXISTS caldes_test_matrix_guard ON calendar_events`;
  await sql`
    CREATE TRIGGER caldes_test_matrix_guard BEFORE INSERT OR UPDATE ON calendar_events
    FOR EACH ROW EXECUTE FUNCTION caldes_test_matrix_guard()
  `;
}

async function removeLegacyWriteGuard(): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS caldes_test_matrix_guard ON calendar_events`;
  await sql`DROP FUNCTION IF EXISTS caldes_test_matrix_guard()`;
}

async function startRadicaleBackend(): Promise<void> {
  const server = await startRadicale({
    label: 'matrice-contratti',
    auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
    rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
  });
  const client = new RadicaleClient({ baseUrl: server.url, password: SVC_PASSWORD, retries: 0 });
  try {
    // Inizializzazione esplicita come in F1 (unico punto che crea collezioni):
    // principal, marker volume-id/epoch, una collezione per ogni calendario
    // del sidecar (i seminati) e _canary.
    const init = await initializeVolume({ db: sql, client, principal: TEST_PRINCIPAL });
    assert.ok(
      init.collections.every((c) => c.status === 'created'),
      `inizializzazione del volume incompleta: ${JSON.stringify(init.collections)}`,
    );
    configureRadicaleRuntime({ client, dataDir: server.storageDir, principal: TEST_PRINCIPAL, watch: 'auto', identitySource: 'auto' });
    updateWatchMode('mount', null);
    registerBookingJobs();
    registerSubscriptionMirrorJob();
    registerIndexRebuildJob();
    registerStoreJobs();
    overrideCalendarStore('radicale');
    invalidateBackendModeCache();
    await installLegacyWriteGuard();
    clearIndexFeedCache();
    resetSubscriptionPullCache();
    // Prima indicizzazione (collezioni vuote, orizzonte), poi il campanello.
    const results = await syncAllCollections({ reason: 'manual' });
    const failed = results.filter((r): r is CollectionSyncError => r instanceof CollectionSyncError);
    assert.equal(failed.length, 0, `prima sync delle collezioni non riuscita: ${failed.map((e) => `${e.calendarId} ${e.code}: ${e.message}`).join('; ')}`);
    await startCalendarWatcher({ intervalMs: WATCHER_INTERVAL_MS });
    horizonDay = new Date().toISOString().slice(0, 10);
    active = {
      server,
      client,
      removeHooks: [
        onBeforeRequest(alignCalendarHorizon),
        onAfterRequest(settleCalendar),
        onClockChange(() => { clockMoved = true; }),
      ],
    };
  } catch (err) {
    await removeLegacyWriteGuard().catch(() => undefined);
    client.close();
    await server.stop();
    throw err;
  }
}

async function stopRadicaleBackend(): Promise<void> {
  const current = active;
  if (!current) return;
  active = null;
  for (const remove of current.removeHooks) remove();
  await stopCalendarWatcher();
  await drainSyncs(5_000).catch(() => undefined);
  await stopIndexWorker();
  overrideCalendarStore(null);
  configureRadicaleRuntime(null);
  updateWatchMode('off', 'test concluso');
  invalidateBackendModeCache();
  await removeLegacyWriteGuard();
  current.client.close();
  await current.server.stop();
}
