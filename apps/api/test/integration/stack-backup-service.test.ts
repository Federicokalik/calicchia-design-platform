/**
 * Servizio `backup` dello stack (apps/backup, migrazione 173).
 *
 * - API: stato (GET /api/backup/stack) e richiesta di un run
 *   (POST /api/backup/stack/run) con servizio assente, fermo o attivo, e con
 *   un run già in coda; tabelle nel gruppo S del backup JSON.
 * - Runner (apps/backup/runner.sh, un giro con BACKUP_RUNNER_ONCE=1) contro
 *   il database dei test e uno script di backup finto: heartbeat, run
 *   pianificato al primo avvio, run chiesto dall'admin, esiti (completo con
 *   copia su S4, incompleto), run interrotti chiusi al riavvio.
 *
 * Il backup vero (pg_dump, lock di Radicale, manifest) è coperto da
 * calendar-stack-backup.test.ts; qui conta solo il collegamento fra admin,
 * coda e script. Requisiti del runner: bash, psql, timeout (GNU), mktemp.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { onBeforeDatabaseClose, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { api } from '../helpers/http';
import { backupGroup } from '../../src/routes/backup';

useTestDatabase();

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RUNNER = join(REPO_ROOT, 'apps/backup/runner.sh');
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

async function clearQueue(): Promise<void> {
  await sql`DELETE FROM stack_backup_runs`;
  await sql`DELETE FROM stack_backup_agent`;
}

async function setAgent(secondsAgo: number): Promise<void> {
  await sql`
    INSERT INTO stack_backup_agent (id, seen_at, started_at, version, interval_hours, next_run_at, s4_configured, alerts_configured)
    VALUES (true, now() - make_interval(secs => ${secondsAgo}), now() - interval '1 day', 'sha-test', 6, now() + interval '1 hour', true, false)
    ON CONFLICT (id) DO UPDATE SET seen_at = EXCLUDED.seen_at
  `;
}

onDatabaseReady(clearQueue);
onBeforeDatabaseClose(clearQueue);

describe('API del backup coordinato', () => {
  test('le tabelle del servizio sono stato (gruppo S): il ripristino da file non le tocca', () => {
    assert.equal(backupGroup('public.stack_backup_runs'), 'state');
    assert.equal(backupGroup('public.stack_backup_agent'), 'state');
  });

  test('senza login → 401', async () => {
    assert.equal((await api.get('/api/backup/stack')).status, 401);
    assert.equal((await api.post('/api/backup/stack/run')).status, 401);
  });

  test('servizio mai partito: stato senza agent, richiesta rifiutata (409 BACKUP_AGENT_OFFLINE, seen_at null)', async () => {
    await clearQueue();
    const status = await api.get('/api/backup/stack', { auth: 'admin' });
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.installed, true);
    assert.equal(status.json.agent, null);
    assert.equal(status.json.active, null);
    assert.deepEqual(status.json.runs, []);

    const run = await api.post('/api/backup/stack/run', { auth: 'admin' });
    assert.equal(run.status, 409, run.text);
    assert.equal(run.json.code, 'BACKUP_AGENT_OFFLINE');
    assert.equal(run.json.seen_at, null);
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM stack_backup_runs`;
    assert.equal(n, 0, 'nessuna richiesta lasciata in coda');
  });

  test('servizio fermo (heartbeat vecchio): agent offline, richiesta rifiutata con seen_at', async () => {
    await clearQueue();
    await setAgent(600);
    const status = await api.get('/api/backup/stack', { auth: 'admin' });
    assert.equal(status.json.agent.online, false);
    const run = await api.post('/api/backup/stack/run', { auth: 'admin' });
    assert.equal(run.status, 409, run.text);
    assert.equal(run.json.code, 'BACKUP_AGENT_OFFLINE');
    assert.ok(run.json.seen_at);
  });

  test('servizio attivo: 202 con il run in coda; una seconda richiesta → 409 BACKUP_ALREADY_ACTIVE con lo stesso run', async () => {
    await clearQueue();
    await setAgent(5);
    const first = await api.post('/api/backup/stack/run', { auth: 'admin' });
    assert.equal(first.status, 202, first.text);
    assert.equal(first.json.run.status, 'queued');
    assert.equal(first.json.run.trigger, 'admin');
    assert.match(first.json.run.requested_by, /^admin:/);

    const second = await api.post('/api/backup/stack/run', { auth: 'admin' });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.json.code, 'BACKUP_ALREADY_ACTIVE');
    assert.equal(second.json.run.id, first.json.run.id);

    const status = await api.get('/api/backup/stack', { auth: 'admin' });
    assert.equal(status.json.agent.online, true);
    assert.equal(status.json.agent.s4_configured, true);
    assert.equal(status.json.active.id, first.json.run.id);
    assert.equal(status.json.runs.length, 1);
  });
});

// ─── Runner ───────────────────────────────────────────────────

function missingPrerequisite(): string | null {
  if (process.platform === 'win32') return 'runner bash non eseguibile su Windows';
  for (const cmd of ['bash', 'psql', 'timeout', 'mktemp']) {
    if (spawnSync('sh', ['-c', `command -v ${cmd}`]).status !== 0) return `${cmd} non disponibile`;
  }
  if (!DATABASE_URL) return 'TEST_DATABASE_URL non impostata';
  return null;
}
const SKIP = missingPrerequisite();

const workRoot = mkdtempSync(join(tmpdir(), 'caldes-backup-runner-'));
onBeforeDatabaseClose(async () => {
  rmSync(workRoot, { recursive: true, force: true });
});

/** Script di backup finto: stampa righe come quello vero ed esce con il codice dato. */
function fakeScript(name: string, lines: string[], exitCode: number): string {
  const path = join(workRoot, `${name}.sh`);
  const body = lines.map((l) => `printf '%s\\n' ${JSON.stringify(l).replace(/\$/g, '\\$')}`).join('\n');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

function runOnce(script: string, extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL, BACKUP_SCRIPT: script, BACKUP_RUNNER_ONCE: '1', CALDES_BACKUP_VERSION: 'sha-test', ...extra };
  for (const key of ['S4_BUCKET', 'S4_ENDPOINT', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID']) {
    if (!(key in extra)) delete env[key];
  }
  return spawnSync('bash', [RUNNER], { env, encoding: 'utf8', timeout: 60_000 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- righe libere
async function runs(): Promise<any[]> {
  return sql`SELECT trigger, status, exit_code, backup_id, offsite, message, log_tail FROM stack_backup_runs ORDER BY requested_at`;
}

describe('runner del servizio backup', { skip: SKIP ?? false }, () => {
  const OK_LINES = [
    '2026-11-19T15:34:28Z [backup-calendar-stack] run 20261119T153428Z: database (url), volume dir:/radicale-data → /backups/calendar-stack/20261119T153428Z',
    '2026-11-19T15:34:37Z [backup-calendar-stack] copia off-site completata: s3://bucket/calendar-stack/20261119T153428Z/',
    '2026-11-19T15:34:38Z [backup-calendar-stack] fatto: /backups/calendar-stack/20261119T153428Z',
  ];

  test('primo avvio: heartbeat scritto e run pianificato eseguito subito (completo, copia su S4)', async () => {
    await clearQueue();
    const res = runOnce(fakeScript('ok', OK_LINES, 0), { S4_BUCKET: 'bucket', S4_ENDPOINT: 'https://s4.example' });
    assert.equal(res.status, 0, res.stderr + res.stdout);

    const [agent] = await sql`SELECT version, interval_hours, s4_configured, alerts_configured, next_run_at > now() AS future FROM stack_backup_agent`;
    assert.equal(agent.version, 'sha-test');
    assert.equal(agent.interval_hours, 6);
    assert.equal(agent.s4_configured, true);
    assert.equal(agent.alerts_configured, false);
    assert.equal(agent.future, true, 'dopo il run il prossimo pianificato è fra 6 ore');

    const rows = await runs();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trigger, 'schedule');
    assert.equal(rows[0].status, 'succeeded');
    assert.equal(rows[0].exit_code, 0);
    assert.equal(rows[0].backup_id, '20261119T153428Z');
    assert.equal(rows[0].offsite, true);
    assert.match(rows[0].log_tail, /fatto: \/backups/);
  });

  test('run pianificato non ancora dovuto: nessun run; richiesta dell\'admin eseguita, incompleto (exit 3) con il messaggio d\'errore', async () => {
    await sql`INSERT INTO stack_backup_runs (trigger, requested_by) VALUES ('admin', 'admin:test')`;
    const res = runOnce(fakeScript('incomplete', [
      '2026-11-19T16:00:00Z [backup-calendar-stack] run 20261119T160000Z: database (url), volume dir:/radicale-data → /backups/calendar-stack/20261119T160000Z',
      '2026-11-19T16:00:05Z [backup-calendar-stack] S4 non configurato (S4_BUCKET/S4_ENDPOINT): backup solo locale',
      '2026-11-19T16:00:05Z [backup-calendar-stack] ERRORE: run 20261119T160000Z con il solo database: volume di Radicale assente',
    ], 3));
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const rows = await runs();
    assert.equal(rows.length, 2, 'nessun nuovo run pianificato');
    const admin = rows[1];
    assert.equal(admin.trigger, 'admin');
    assert.equal(admin.status, 'incomplete');
    assert.equal(admin.exit_code, 3);
    assert.equal(admin.backup_id, '20261119T160000Z');
    assert.equal(admin.offsite, false);
    assert.match(admin.message, /ERRORE: run 20261119T160000Z con il solo database/);
  });

  test('run fallito: status failed, offsite sconosciuto; un run rimasto "running" viene chiuso al riavvio', async () => {
    await sql`INSERT INTO stack_backup_runs (trigger, requested_by, status, started_at) VALUES ('admin', 'admin:test', 'running', now())`;
    const res = runOnce(fakeScript('noop', OK_LINES, 0));
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const [closed] = await sql`SELECT status, message FROM stack_backup_runs WHERE requested_by = 'admin:test' AND trigger = 'admin' ORDER BY requested_at DESC LIMIT 1`;
    assert.equal(closed.status, 'failed');
    assert.match(closed.message, /interrotto/);

    await sql`INSERT INTO stack_backup_runs (trigger, requested_by) VALUES ('admin', 'admin:fail')`;
    const failed = runOnce(fakeScript('fail', ['2026-11-19T16:10:00Z [backup-calendar-stack] ERRORE: database non raggiungibile'], 1));
    assert.equal(failed.status, 0, failed.stderr + failed.stdout);
    const [row] = await sql`SELECT status, exit_code, offsite, message FROM stack_backup_runs WHERE requested_by = 'admin:fail'`;
    assert.equal(row.status, 'failed');
    assert.equal(row.exit_code, 1);
    assert.equal(row.offsite, null);
    assert.match(row.message, /database non raggiungibile/);
  });

  test('configurazione non valida: il runner si rifiuta di partire', () => {
    const res = runOnce(fakeScript('cfg', OK_LINES, 0), { BACKUP_INTERVAL_HOURS: '0' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BACKUP_INTERVAL_HOURS non valida/);
  });
});
