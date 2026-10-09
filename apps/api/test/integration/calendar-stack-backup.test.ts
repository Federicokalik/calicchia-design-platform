/**
 * Backup e ripristino coordinati dello stack del calendario (fase F1 del
 * passaggio a Radicale, piano attività 9; design §16.1 e §16.3):
 * scripts/backup-calendar-stack.sh, scripts/restore-calendar-stack.sh,
 * scripts/backup-db.sh (delega) e scripts/calendar_stack.py.
 *
 * Gli script girano davvero (bash, flock, tar, pg_dump, python3) sul database
 * dei test e su un volume di Radicale finto in una cartella temporanea, con la
 * stessa struttura di quello reale (collections/collection-root/<principal>/,
 * .Radicale.props con il marker d'identità, .Radicale.cache, temporanei e
 * lock). Il drill con un Radicale 3.7.8 vero in esecuzione (scritture bloccate
 * dal lock condiviso, snapshot servito da un nuovo processo) è documentato in
 * apps/radicale/README.md.
 *
 * Il ripristino del database (DROP DATABASE) non si prova qui: cancellerebbe
 * il database condiviso dalle altre suite. Si prova il ripristino del solo
 * volume, che aggiorna calendar_backend_state (restore_guard, rebuild): lo
 * stato torna alla baseline a fine file.
 *
 * Requisiti: bash, python3, flock, tar, gzip, sha256sum, pg_dump e psql con
 * pg_dump almeno della versione del server. Se mancano la suite viene saltata
 * con il motivo (per esempio in CI, dove il runner ha pg_dump 16 e il servizio
 * Postgres 17).
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';

useTestDatabase({ resetBaseline: true });

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BACKUP_SCRIPT = join(REPO_ROOT, 'scripts/backup-calendar-stack.sh');
const RESTORE_SCRIPT = join(REPO_ROOT, 'scripts/restore-calendar-stack.sh');
const BACKUP_DB_SCRIPT = join(REPO_ROOT, 'scripts/backup-db.sh');
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

const VOLUME_ID = '3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60';
const OTHER_VOLUME_ID = '0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a';

// ─── Prerequisiti ─────────────────────────────────────────────

function missingPrerequisite(): string | null {
  for (const cmd of ['bash', 'python3', 'flock', 'tar', 'gzip', 'sha256sum', 'pg_dump', 'psql']) {
    if (spawnSync('sh', ['-c', `command -v ${cmd}`]).status !== 0) return `${cmd} non disponibile`;
  }
  if (!DATABASE_URL) return 'TEST_DATABASE_URL non impostata';
  const dump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  const dumpMajor = Number(/\(PostgreSQL\) (\d+)/.exec(dump.stdout ?? '')?.[1] ?? NaN);
  const server = spawnSync('psql', [DATABASE_URL, '-X', '-At', '-c', 'SHOW server_version_num'], { encoding: 'utf8' });
  const serverMajor = Math.floor(Number(server.stdout?.trim()) / 10000);
  if (!Number.isFinite(dumpMajor) || !Number.isFinite(serverMajor)) return 'versioni di pg_dump o del server non leggibili';
  if (dumpMajor < serverMajor) return `pg_dump ${dumpMajor} più vecchio del server ${serverMajor}`;
  return null;
}

const SKIP = missingPrerequisite();

// ─── Volume finto e invocazione degli script ──────────────────

const workRoot = mkdtempSync(join(tmpdir(), 'caldes-stack-backup-'));
onBeforeDatabaseClose(async () => {
  // Stato del backend alla baseline (il ripristino del volume imposta guardia e rebuild).
  await resetCalendarBaseline();
  rmSync(workRoot, { recursive: true, force: true });
});

let counter = 0;
function freshDir(label: string): string {
  const dir = join(workRoot, `${label}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ICS = (uid: string, summary: string): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//caldes test//IT', 'BEGIN:VEVENT', `UID:${uid}`,
    'DTSTAMP:20270101T000000Z', 'DTSTART:20270104T090000Z', 'DTEND:20270104T100000Z', `SUMMARY:${summary}`,
    'X-FOO:a,b,c', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

/** Volume come quello di Radicale (/data): collections/collection-root/federico/{c,f}. */
function makeVolume(opts: { volumeId?: string; epoch?: number; extraItem?: string } = {}): string {
  const root = freshDir('volume');
  const principal = join(root, 'collections/collection-root/federico');
  for (const coll of ['c', 'f']) mkdirSync(join(principal, coll, '.Radicale.cache/item'), { recursive: true });
  writeFileSync(join(root, 'collections/.Radicale.lock'), '');
  if (opts.volumeId) {
    writeFileSync(join(principal, '.Radicale.props'), JSON.stringify({
      '{urn:calicchia:caldes}epoch': String(opts.epoch ?? 1),
      '{urn:calicchia:caldes}volume-id': opts.volumeId,
    }));
  }
  writeFileSync(join(principal, 'c/.Radicale.props'), JSON.stringify({
    tag: 'VCALENDAR', '{urn:calicchia:caldes}calendar-id': '11111111-2222-3333-4444-555555555555', '{urn:calicchia:caldes}role': 'user',
  }));
  writeFileSync(join(principal, 'f/.Radicale.props'), JSON.stringify({ tag: 'VCALENDAR', '{urn:calicchia:caldes}role': 'holidays' }));
  writeFileSync(join(principal, 'c/pranzo.ics'), ICS('pranzo@caldes.test', 'Pranzo\\, cena'));
  writeFileSync(join(principal, 'c/riunione.ics'), ICS('riunione@caldes.test', 'Riunione'));
  writeFileSync(join(principal, 'f/it-holiday-2027-01-06.ics'), ICS('it-holiday-2027-01-06@caldes.it', 'Epifania'));
  if (opts.extraItem) writeFileSync(join(principal, 'c', opts.extraItem), ICS(`${opts.extraItem}@caldes.test`, 'In più'));
  // Da escludere: cache degli item, temporaneo di una scrittura interrotta.
  writeFileSync(join(principal, 'c/.Radicale.cache/item/pranzo.ics'), 'cache');
  mkdirSync(join(principal, 'c/.Radicale.tmp-abc123'));
  writeFileSync(join(principal, 'c/.Radicale.tmp-abc123/x'), 'tmp');
  return root;
}

function scriptEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL };
  // Ambiente ermetico: nessuna sorgente alternativa, niente S4, niente upload.
  for (const key of ['PG_CONTAINER', 'COMPOSE_PROJECT', 'RADICALE_VOLUME', 'RADICALE_VOLUME_DIR', 'RADICALE_BACKUP',
    'S4_BUCKET', 'S4_ENDPOINT', 'UPLOAD_DIR', 'LOCK_TIMEOUT', 'RETENTION_DAYS']) delete env[key];
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(script: string, args: string[], env: Record<string, string | undefined>): SpawnSyncReturns<string> {
  return spawnSync('bash', [script, ...args], { env: scriptEnv(env), encoding: 'utf8', timeout: 120_000 });
}

function output(res: SpawnSyncReturns<string>): string {
  return `exit ${res.status}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- manifest JSON
type Manifest = Record<string, any>;

function latestRun(backupDir: string): { dir: string; manifest: Manifest } {
  const dir = join(backupDir, 'calendar-stack', 'latest');
  return { dir, manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function setBackendIdentity(volumeId: string | null, epoch: number): Promise<void> {
  await sql`UPDATE calendar_backend_state SET volume_id = ${volumeId}::uuid, epoch = ${epoch} WHERE id`;
}

// ─── Test ─────────────────────────────────────────────────────

describe('backup-calendar-stack.sh', { skip: SKIP ?? false }, () => {
  test('dump e snapshot del volume con un solo manifest: checksum, esclusioni, inventario e identità', () => {
    const backupDir = freshDir('backups');
    const volume = makeVolume({ volumeId: VOLUME_ID.toUpperCase(), epoch: 1 });
    const res = run(BACKUP_SCRIPT, [], { BACKUP_DIR: backupDir, RADICALE_VOLUME_DIR: volume });
    assert.equal(res.status, 0, output(res));

    const { dir, manifest } = latestRun(backupDir);
    assert.equal(manifest.kind, 'caldes-calendar-stack-backup');
    assert.equal(manifest.schema, 1);
    assert.match(manifest.id, /^\d{8}T\d{6}Z$/);
    assert.deepEqual(readdirSync(dir).sort(), ['caldes-db.sql.gz', 'manifest.json', 'radicale-collections.tar.gz']);
    for (const section of ['database', 'radicale']) {
      assert.equal(manifest[section].sha256, sha256(join(dir, manifest[section].file)), section);
    }
    // Ordine: il dump finisce prima che inizi lo snapshot del volume.
    assert.ok(manifest.database.finished_at <= manifest.radicale.started_at);
    assert.equal(manifest.radicale.lock, 'shared');

    // Stato del backend alla baseline: volume non inizializzato in PG.
    assert.equal(manifest.database.backend_state.mode, 'postgres');
    assert.equal(manifest.database.backend_state.epoch, 0);
    assert.match(manifest.database.last_migration, /^\d{3}_.+\.sql$/);
    assert.equal(manifest.consistency.identity, 'uninitialized');

    // Il dump è SQL plain compresso (come il vecchio backup-db.sh) con lo stato del backend.
    const sqlText = spawnSync('gzip', ['-dc', join(dir, 'caldes-db.sql.gz')], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout;
    assert.match(sqlText, /CREATE TABLE public\.calendar_backend_state/);

    // Nel tar niente cache, temporanei né lock; le collezioni e il marker sì.
    const members = spawnSync('tar', ['-tzf', join(dir, 'radicale-collections.tar.gz')], { encoding: 'utf8' }).stdout.split('\n');
    assert.ok(members.includes('collections/collection-root/federico/.Radicale.props'));
    assert.ok(members.includes('collections/collection-root/federico/c/pranzo.ics'));
    assert.ok(!members.some((m) => m.includes('.Radicale.cache') || m.includes('.Radicale.tmp-') || m.endsWith('.Radicale.lock')), members.join('\n'));

    const inv = manifest.radicale.inventory;
    assert.equal(inv.items_total, 3);
    assert.deepEqual(inv.collections.map((c: Manifest) => [c.name, c.items, c.role]), [['federico/c', 2, 'user'], ['federico/f', 1, 'holidays']]);
    assert.deepEqual(inv.marker, { state: 'ok', volume_id: VOLUME_ID, epoch: 1, detail: null });
  });

  test('attende il lock esclusivo di Radicale; al timeout fallisce senza lasciare run parziali', async () => {
    const backupDir = freshDir('backups');
    const volume = makeVolume({ volumeId: VOLUME_ID });
    const lockFile = join(volume, 'collections/.Radicale.lock');
    const ready = join(workRoot, `ready-${++counter}`);

    // Una "scrittura" di Radicale: lock esclusivo tenuto per 4 s.
    const holder = spawn('flock', ['-x', lockFile, 'sh', '-c', `touch '${ready}'; sleep 4`], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(existsSync(ready), 'il processo che tiene il lock non è partito');
      const res = run(BACKUP_SCRIPT, [], { BACKUP_DIR: backupDir, RADICALE_VOLUME_DIR: volume, LOCK_TIMEOUT: '1' });
      assert.equal(res.status, 1, output(res));
      assert.match(res.stderr, /lock di Radicale non ottenuto in 1 s/);
      const entries = readdirSync(join(backupDir, 'calendar-stack'));
      assert.ok(!entries.some((e) => e.startsWith('.partial-') || /^\d{8}T/.test(e)), entries.join(', '));
    } finally {
      holder.kill();
    }

    // Lock tenuto per ~1,5 s e timeout ampio: il backup attende e riesce.
    const ready2 = join(workRoot, `ready-${++counter}`);
    const holder2 = spawn('flock', ['-x', lockFile, 'sh', '-c', `touch '${ready2}'; sleep 1.5`], { stdio: 'ignore' });
    for (let i = 0; i < 100 && !existsSync(ready2); i++) await new Promise((r) => setTimeout(r, 20));
    const res = await new Promise<{ status: number | null; out: string }>((resolveRun) => {
      const child = spawn('bash', [BACKUP_SCRIPT], { env: scriptEnv({ BACKUP_DIR: backupDir, RADICALE_VOLUME_DIR: volume, LOCK_TIMEOUT: '30' }) });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { out += String(d); });
      child.on('close', (status) => resolveRun({ status, out }));
    });
    holder2.kill();
    assert.equal(res.status, 0, res.out);
    const { manifest } = latestRun(backupDir);
    assert.ok(manifest.radicale.lock_waited_ms >= 300, `attesa del lock ${manifest.radicale.lock_waited_ms} ms`);
  });

  test('senza volume configurato fallisce; backup-db.sh ripiega sul solo database', () => {
    const backupDir = freshDir('backups');
    const res = run(BACKUP_SCRIPT, [], { BACKUP_DIR: backupDir });
    assert.equal(res.status, 1, output(res));
    assert.match(res.stderr, /volume di Radicale non configurato/);

    const legacy = run(BACKUP_DB_SCRIPT, [], { BACKUP_DIR: backupDir, RETENTION_DAYS: '30' });
    assert.equal(legacy.status, 0, output(legacy));
    assert.match(legacy.stderr, /backup SOLO del database/);
    const { dir, manifest } = latestRun(backupDir);
    assert.equal(manifest.radicale, null);
    assert.equal(manifest.consistency.identity, 'not_captured');
    assert.deepEqual(readdirSync(dir).sort(), ['caldes-db.sql.gz', 'manifest.json']);
  });
});

describe('restore-calendar-stack.sh', { skip: SKIP ?? false }, () => {
  test('verify-only: un run integro passa, un archivio manomesso viene rifiutato', () => {
    const backupDir = freshDir('backups');
    const volume = makeVolume({ volumeId: VOLUME_ID });
    assert.equal(run(BACKUP_SCRIPT, [], { BACKUP_DIR: backupDir, RADICALE_VOLUME_DIR: volume }).status, 0);
    const ok = run(RESTORE_SCRIPT, ['--verify-only', 'latest'], { BACKUP_DIR: backupDir, RADICALE_VOLUME_DIR: volume });
    assert.equal(ok.status, 0, output(ok));
    assert.match(ok.stdout, /identità dopo:\s+uninitialized/);

    const tampered = freshDir('tampered');
    cpSync(latestRun(backupDir).dir, tampered, { recursive: true, dereference: true });
    const archive = join(tampered, 'radicale-collections.tar.gz');
    const bytes = readFileSync(archive);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(archive, bytes);
    const bad = run(RESTORE_SCRIPT, ['--verify-only', tampered], { BACKUP_DIR: backupDir, RADICALE_VOLUME_DIR: volume });
    assert.equal(bad.status, 1, output(bad));
    assert.match(bad.stderr, /sha256 diverso/);
  });

  test('ripristino del volume: conferma esplicita, identità verificata, copia di sicurezza, inventario e guardia', async () => {
    const backupDir = freshDir('backups');
    const source = makeVolume({ volumeId: VOLUME_ID, epoch: 1 });
    assert.equal(run(BACKUP_SCRIPT, [], { BACKUP_DIR: backupDir, RADICALE_VOLUME_DIR: source }).status, 0);
    const { manifest } = latestRun(backupDir);
    const phrase = `RIPRISTINA ${manifest.id}`;

    // Volume di destinazione con un contenuto diverso (oggetto creato dopo il backup).
    const target = makeVolume({ volumeId: VOLUME_ID, epoch: 1, extraItem: 'dopo-il-backup.ics' });
    const env = { BACKUP_DIR: backupDir, RADICALE_VOLUME_DIR: target };

    // Conferma sbagliata: annullato, nulla cambia.
    const wrong = run(RESTORE_SCRIPT, ['--only', 'volume', '--confirm', 'RIPRISTINA', 'latest'], env);
    assert.equal(wrong.status, 3, output(wrong));
    assert.ok(existsSync(join(target, 'collections/collection-root/federico/c/dopo-il-backup.ics')));

    // PG registra un altro volume: identità risultante mismatch → rifiutato.
    await setBackendIdentity(OTHER_VOLUME_ID, 1);
    const mismatch = run(RESTORE_SCRIPT, ['--only', 'volume', '--confirm', phrase, 'latest'], env);
    assert.equal(mismatch.status, 1, output(mismatch));
    assert.match(mismatch.stderr, /identità risultante mismatch/);

    // Snapshot con epoch più vecchio di quello in PG: regressione segnalata e rifiutata.
    await setBackendIdentity(VOLUME_ID, 2);
    const older = run(RESTORE_SCRIPT, ['--only', 'volume', '--confirm', phrase, 'latest'], env);
    assert.equal(older.status, 1, output(older));
    assert.match(older.stdout, /REGRESSIONE/);

    // Identità coincidente: ripristino eseguito.
    await setBackendIdentity(VOLUME_ID, 1);
    const [before] = await sql<Array<{ credential_epoch: number }>>`SELECT credential_epoch FROM calendar_backend_state WHERE id`;
    const res = run(RESTORE_SCRIPT, ['--only', 'volume', '--confirm', phrase, 'latest'], env);
    assert.equal(res.status, 0, output(res));
    assert.match(res.stdout, /identità dopo il ripristino: ok/);

    // Contenuto identico al backup, la collezione precedente messa da parte (mai cancellata).
    assert.ok(!existsSync(join(target, 'collections/collection-root/federico/c/dopo-il-backup.ics')));
    assert.equal(
      readFileSync(join(target, 'collections/collection-root/federico/c/pranzo.ics'), 'utf8'),
      readFileSync(join(source, 'collections/collection-root/federico/c/pranzo.ics'), 'utf8'),
    );
    const aside = readdirSync(target).filter((e) => e.startsWith('collections.pre-restore-'));
    assert.equal(aside.length, 1, readdirSync(target).join(', '));
    assert.ok(existsSync(join(target, aside[0], 'collection-root/federico/c/dopo-il-backup.ics')));
    assert.ok(!existsSync(join(target, 'collections/collection-root/federico/c/.Radicale.cache')));

    // Policy frozen dopo il ripristino; credential_epoch invariato (credenziali non toccate).
    const [state] = await sql<Array<{ guard: boolean; rebuild_required: boolean; credential_epoch: number }>>`
      SELECT restore_guard_until > now() + interval '47 hours' AS guard, rebuild_required, credential_epoch
      FROM calendar_backend_state WHERE id
    `;
    assert.deepEqual(state, { guard: true, rebuild_required: true, credential_epoch: before.credential_epoch });
  });
});
