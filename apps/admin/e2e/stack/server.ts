/**
 * Stack degli e2e dell'admin (contratto F6 §9.3): un solo processo con
 *  - l'API vera (src/app.ts) su una porta fissa, servita con @hono/node-server;
 *  - un Radicale 3.7.8 reale (harness dei test dell'API, storage in una
 *    directory temporanea) con il solo caldes-svc e la matrice dei diritti del
 *    contratto control-plane §8;
 *  - il database dei test (TEST_DATABASE_URL: localhost, nome con 'test' o
 *    'caldes_f<N>', come per i test dell'API) riportato alla baseline;
 *  - i componenti di processo del calendario (worker dei job, campanello,
 *    canary), gli stessi del boot di produzione;
 *  - un piccolo server di controllo (solo loopback) con cui gli e2e leggono le
 *    informazioni dello stack, ottengono la sessione admin, cambiano il modo
 *    del backend (radicale | postgres), forzano una sincronizzazione e fanno
 *    scoprire le collezioni create da un dispositivo.
 *
 * Si avvia da apps/api (vedi playwright.config.ts) con tsx e il precarico
 * dell'ambiente di test:
 *   tsx --import ./test/helpers/preload.mjs ../admin/e2e/stack/server.ts
 *
 * Variabili: TEST_DATABASE_URL (obbligatoria), RADICALE_BIN (binario di
 * Radicale 3.7.8), E2E_API_PORT (default 3001: è la destinazione del proxy
 * /api di vite preview, ereditata da server.proxy), E2E_CONTROL_PORT
 * (default 3002), E2E_STATE_DIR (default <tmp>/caldes-e2e: stack.json).
 */

import '../../../api/test/helpers/env';
import './origins';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, ensureTestAdmin, signTestToken } from '../../../api/test/helpers/http';
import { resetCalendarBaseline } from '../../../api/test/helpers/db';
import { radicaleAvailability, startRadicale, TEST_PRINCIPAL, type RadicaleServer } from '../../../api/test/helpers/radicale';
import { sql } from '../../../api/src/db';
import { runPendingMigrations } from '../../../api/src/lib/db-migrate';
import { invalidateBackendModeCache } from '../../../api/src/lib/calendar/backend-mode';
import { createCalendar } from '../../../api/src/lib/calendar/calendars';
import { RadicaleClient } from '../../../api/src/lib/calendar/radicale/client';
import { initializeVolume } from '../../../api/src/lib/calendar/radicale/identity';
import { discoverCollections } from '../../../api/src/lib/calendar/radicale/discovery';
import { configureRadicaleRuntime, syncAllCollections, syncCollection, updateWatchMode } from '../../../api/src/lib/calendar/radicale/sync';
import { startCalendarBackground, stopCalendarBackground } from '../../../api/src/cron/calendar-radicale';

const API_PORT = Number(process.env.E2E_API_PORT || 3001);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT || 3002);
const STATE_DIR = process.env.E2E_STATE_DIR || join(tmpdir(), 'caldes-e2e');

/** Password di caldes-svc del Radicale degli e2e (mai usata fuori da questo stack). */
const SVC_PASSWORD = 'e2e-only-svc-password-admin-calendar';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${TEST_PRINCIPAL}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${TEST_PRINCIPAL}/[^/]+`, 'permissions: rwD', '',
].join('\n');

/** Calendari creati per gli scenari (oltre a quelli seminati dalle migrazioni). */
const E2E_CALENDARS = [
  { slug: 'e2e-lavoro', name: 'E2E Lavoro', color: '#2563eb' },
  { slug: 'e2e-personale', name: 'E2E Personale', color: '#16a34a' },
  { slug: 'e2e-archivio', name: 'E2E Archivio', color: '#d97706' },
] as const;

type Mode = 'radicale' | 'postgres';

async function main(): Promise<void> {
  const availability = radicaleAvailability();
  if (!availability.available) {
    throw new Error(`Radicale 3.7.8 non disponibile (RADICALE_BIN): ${availability.reason ?? 'sconosciuto'}`);
  }

  await runPendingMigrations();
  await resetCalendarBaseline();
  await ensureTestAdmin();

  const radicale: RadicaleServer = await startRadicale({
    label: 'e2e-admin',
    auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
    rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
  });
  const client = new RadicaleClient({ baseUrl: radicale.url, password: SVC_PASSWORD, retries: 0 });

  // I calendari nascono nello store legacy (modo postgres della baseline); il
  // volume li porta poi su Radicale, una collezione ciascuno.
  for (const cal of E2E_CALENDARS) {
    await createCalendar({ slug: cal.slug, name: cal.name, color: cal.color, timezone: 'Europe/Rome', blocks_availability: true });
  }
  const init = await initializeVolume({ db: sql, client, principal: TEST_PRINCIPAL });
  if (!init.collections.every((c) => c.status === 'created')) {
    throw new Error(`Inizializzazione del volume incompleta: ${JSON.stringify(init.collections)}`);
  }
  configureRadicaleRuntime({ client, dataDir: radicale.storageDir, principal: TEST_PRINCIPAL, watch: 'auto', identitySource: 'auto' });
  updateWatchMode('mount', null);

  // Fasce da mezz'ora (08:00-22:30) assegnate in sequenza agli eventi degli scenari: due eventi
  // della stessa giornata non si sovrappongono e il clic sul chip non è intercettato da un altro.
  // Le fasce prima delle 08:00 restano agli scenari che le chiedono esplicitamente.
  let nextSlot = 0;

  const setMode = async (mode: Mode): Promise<void> => {
    await sql`UPDATE calendar_backend_state SET mode = ${mode}, write_freeze = false WHERE id`;
    invalidateBackendModeCache();
  };
  await setMode('radicale');
  // Prima indicizzazione delle collezioni (vuote) e orizzonte.
  await syncAllCollections({ reason: 'manual' });
  await startCalendarBackground();

  // ─── API ───
  const requireFromApi = createRequire(new URL('../../../api/package.json', import.meta.url));
  // @hono/node-server è una dipendenza dell'API: lo si risolve dal suo package.json, non da quello dell'admin.
  const { serve } = (await import(pathToFileURL(requireFromApi.resolve('@hono/node-server')).href)) as {
    serve: (opts: { fetch: (req: Request) => Response | Promise<Response>; hostname: string; port: number }) => { close: () => void };
  };
  const apiServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: API_PORT });

  // ─── Controllo ───
  const calendars = async () => sql<Array<{ id: string; slug: string; name: string; collection_name: string | null }>>`
    SELECT id::text AS id, slug, name, collection_name FROM calendars WHERE lifecycle <> 'deleting' ORDER BY sort_order, created_at
  `;
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  const control = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      try {
        if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
        if (req.method === 'GET' && path === '/stack') {
          return send(res, 200, {
            radicale: { url: radicale.url, user: 'caldes-svc', password: SVC_PASSWORD, principal: TEST_PRINCIPAL },
            calendars: await calendars(),
          });
        }
        if (req.method === 'POST' && path === '/slot') {
          const n = nextSlot++ % 30;
          return send(res, 200, { hour: 8 + Math.floor(n / 2), minute: (n % 2) * 30 });
        }
        if (req.method === 'POST' && path === '/session') {
          return send(res, 200, { token: await signTestToken() });
        }
        if (req.method === 'POST' && path === '/mode') {
          const { mode } = await readJson(req);
          if (mode !== 'radicale' && mode !== 'postgres') return send(res, 400, { error: 'mode atteso: radicale | postgres' });
          await setMode(mode);
          return send(res, 200, { mode });
        }
        if (req.method === 'POST' && path === '/sync') {
          const { calendar_id: calendarId } = await readJson(req);
          if (typeof calendarId === 'string') await syncCollection(calendarId, { reason: 'manual' });
          else await syncAllCollections({ reason: 'manual' });
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && path === '/discover') {
          await discoverCollections();
          await syncAllCollections({ reason: 'manual' });
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'non trovato' });
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    })();
  });
  await new Promise<void>((resolve) => control.listen(CONTROL_PORT, '127.0.0.1', resolve));

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    join(STATE_DIR, 'stack.json'),
    JSON.stringify({ api: `http://127.0.0.1:${API_PORT}`, control: `http://127.0.0.1:${CONTROL_PORT}` }),
  );
  console.log(`Stack e2e pronto: API :${API_PORT}, controllo :${CONTROL_PORT}, Radicale ${radicale.url}`);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    control.close();
    apiServer.close();
    await stopCalendarBackground().catch(() => undefined);
    configureRadicaleRuntime(null);
    client.close();
    await radicale.stop().catch(() => undefined);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

main().catch((err) => {
  console.error(`Stack e2e non avviato: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
