/**
 * Manutenzione del volume di Radicale e backup registrato (fase F3 del
 * passaggio del calendario a Radicale, piano attività 6; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §12, §14.1 e §14.3):
 *
 *  - scripts/radicale-maint.sh con scripts/radicale_maint.py: stato,
 *    dimensioni, verifica strutturale, identità contro calendar_backend_state,
 *    pulizia e compattazione della cache sotto il lock di Radicale, volume
 *    della Fase 0 (ricerca, tar in sola lettura, zip per il wizard) e
 *    snapshot prima della migrazione;
 *  - scripts/backup-calendar-stack.sh: registrazione best effort di
 *    calendar_backend_state.last_stack_backup a fine run.
 *
 * Gli script girano davvero (bash, flock, tar, python3) su volumi finti in
 * cartelle temporanee con la struttura di quelli reali, come
 * integration/calendar-stack-backup.test.ts; Docker è sostituito da un
 * `docker` finto nel PATH (solo `volume inspect` e `ps`). Lo zip della Fase 0
 * si rilegge con le funzioni dell'API che lo importeranno
 * (readArchiveItems/readTarIcsEntries di migration/init.ts). Con RADICALE_BIN
 * la pulizia e la compattazione della cache si provano anche su un Radicale
 * 3.7.8 in esecuzione. Snapshot e registrazione richiedono pg_dump e psql
 * (saltati con il motivo, come il test del backup).
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { DAV_PROPS, radicaleAvailability, TEST_PRINCIPAL, useRadicale } from '../helpers/radicale';
import { readArchiveItems, readTarIcsEntries, readZipIcsEntries } from '../../src/lib/calendar/migration/init';
import { MIGRATION_LIMITS, MIGRATION_STATE_COLUMNS, normalizeMigrationState } from '../../src/lib/calendar/migration/types';

useTestDatabase({ resetBaseline: true });

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MAINT = join(REPO_ROOT, 'scripts/radicale-maint.sh');
const HELPER = join(REPO_ROOT, 'scripts/radicale_maint.py');
const STACK_TOOL = join(REPO_ROOT, 'scripts/calendar_stack.py');
const BACKUP = join(REPO_ROOT, 'scripts/backup-calendar-stack.sh');
const RESTORE = join(REPO_ROOT, 'scripts/restore-calendar-stack.sh');
const PRODUCTION_CONFIG = join(REPO_ROOT, 'apps/radicale/config/config');
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

const VOLUME_ID = '3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60';
const OTHER_VOLUME_ID = '0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a';
/** Testo che non deve mai comparire nei report (contenuto degli eventi). */
const SECRET_SUMMARY = 'Visita Mario Rossi 3331234567';

// ─── Prerequisiti ─────────────────────────────────────────────

const has = (cmd: string): boolean => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

function missingTools(): string | null {
  for (const cmd of ['bash', 'python3', 'flock', 'tar', 'gzip', 'sha256sum']) if (!has(cmd)) return `${cmd} non disponibile`;
  return null;
}

function missingDbTools(): string | null {
  const base = missingTools();
  if (base) return base;
  for (const cmd of ['pg_dump', 'psql']) if (!has(cmd)) return `${cmd} non disponibile`;
  if (!DATABASE_URL) return 'TEST_DATABASE_URL non impostata';
  const dump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  const dumpMajor = Number(/\(PostgreSQL\) (\d+)/.exec(dump.stdout ?? '')?.[1] ?? NaN);
  const server = spawnSync('psql', [DATABASE_URL, '-X', '-At', '-c', 'SHOW server_version_num'], { encoding: 'utf8' });
  const serverMajor = Math.floor(Number(server.stdout?.trim()) / 10000);
  if (!Number.isFinite(dumpMajor) || !Number.isFinite(serverMajor)) return 'versioni di pg_dump o del server non leggibili';
  if (dumpMajor < serverMajor) return `pg_dump ${dumpMajor} più vecchio del server ${serverMajor}`;
  return null;
}

const SKIP = missingTools();
const SKIP_DB = missingDbTools();

// ─── Volumi finti e invocazione ───────────────────────────────

const workRoot = mkdtempSync(join(tmpdir(), 'caldes-radicale-maint-'));
onBeforeDatabaseClose(async () => {
  await resetCalendarBaseline();
  rmSync(workRoot, { recursive: true, force: true });
});

let counter = 0;
function freshDir(label: string): string {
  const dir = join(workRoot, `${label}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ics = (uid: string, summary = 'Riunione', extra: string[] = []): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//caldes test//IT', 'BEGIN:VEVENT', `UID:${uid}`,
    'DTSTAMP:20270101T000000Z', 'DTSTART:20270104T090000Z', 'DTEND:20270104T100000Z', `SUMMARY:${summary}`,
    ...extra, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

/** Volume come quello di Radicale (/data): collections/collection-root/federico/{c,f}, cache, lock. */
function makeVolume(opts: { volumeId?: string; epoch?: number } = {}): string {
  const root = freshDir('volume');
  const principal = join(root, 'collections/collection-root/federico');
  for (const coll of ['c', 'f']) mkdirSync(join(principal, coll, '.Radicale.cache/item'), { recursive: true });
  mkdirSync(join(principal, 'c/.Radicale.cache/history'), { recursive: true });
  writeFileSync(join(root, 'collections/.Radicale.lock'), '');
  if (opts.volumeId) {
    writeFileSync(join(principal, '.Radicale.props'), JSON.stringify({
      '{urn:calicchia:caldes}epoch': String(opts.epoch ?? 1),
      '{urn:calicchia:caldes}volume-id': opts.volumeId,
    }));
  }
  writeFileSync(join(principal, 'c/.Radicale.props'), JSON.stringify({ tag: 'VCALENDAR', '{urn:calicchia:caldes}role': 'user' }));
  writeFileSync(join(principal, 'f/.Radicale.props'), JSON.stringify({ tag: 'VCALENDAR', '{urn:calicchia:caldes}role': 'holidays' }));
  writeFileSync(join(principal, 'c/pranzo.ics'), ics('pranzo@caldes.test', SECRET_SUMMARY));
  writeFileSync(join(principal, 'c/riunione.ics'), ics('riunione@caldes.test'));
  writeFileSync(join(principal, 'f/it-holiday-2027-01-06.ics'), ics('it-holiday-2027-01-06@caldes.it', 'Epifania'));
  // Cache di Radicale: voce di un item esistente, voce orfana (item cancellato), storia dei sync-token.
  writeFileSync(join(principal, 'c/.Radicale.cache/item/pranzo.ics'), `pickle ${SECRET_SUMMARY}`);
  writeFileSync(join(principal, 'c/.Radicale.cache/item/cancellato.ics'), `pickle ${SECRET_SUMMARY} vecchio`);
  writeFileSync(join(principal, 'c/.Radicale.cache/history/pranzo.ics'), '"etag"');
  writeFileSync(join(principal, 'c/.Radicale.cache/.Radicale.lock'), '');
  return root;
}

const principalDir = (root: string) => join(root, 'collections/collection-root/federico');

/** Volume della Fase 0 (vecchio radicale_data): due principal, item, cache, un file non .ics. */
function makePhase0Volume(): string {
  const root = freshDir('phase0');
  const croot = join(root, 'collections/collection-root');
  for (const p of ['federico', 'iphone']) mkdirSync(join(croot, p, 'casa/.Radicale.cache/item'), { recursive: true });
  mkdirSync(join(croot, 'federico/lavoro'), { recursive: true });
  writeFileSync(join(croot, 'federico/casa/.Radicale.props'), JSON.stringify({ tag: 'VCALENDAR' }));
  writeFileSync(join(croot, 'federico/casa/compleanno.ics'), ics('compleanno@fase0.test', 'Compleanno'));
  writeFileSync(join(croot, 'federico/casa/.Radicale.cache/item/compleanno.ics'), 'cache');
  writeFileSync(join(croot, 'federico/lavoro/riunione.ics'), ics('riunione@fase0.test', 'Riunione vecchia'));
  writeFileSync(join(croot, 'federico/lavoro/note.txt'), 'non è un item');
  // Stesso <collezione>__<item> in due principal: il secondo prende il prefisso del principal.
  writeFileSync(join(croot, 'iphone/casa/compleanno.ics'), ics('compleanno-iphone@fase0.test', 'Compleanno (iPhone)'));
  // Item non valido: finisce nello zip, l'import lo scarta con il motivo.
  writeFileSync(join(croot, 'federico/lavoro/rotto.ics'), 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:rotto\r\nEND:VCALENDAR\r\n');
  return root;
}

function baseEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Ambiente ermetico: nessuna sorgente alternativa, niente S4, niente alert.
  for (const key of ['PG_CONTAINER', 'COMPOSE_PROJECT', 'DATABASE_URL', 'RADICALE_VOLUME', 'RADICALE_VOLUME_DIR', 'RADICALE_BACKUP',
    'PHASE0_VOLUME', 'PHASE0_VOLUME_DIR', 'S4_BUCKET', 'S4_ENDPOINT', 'UPLOAD_DIR', 'LOCK_TIMEOUT', 'RETENTION_DAYS', 'BACKUP_DIR',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID', 'TMP_AGE_HOURS']) delete env[key];
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(script: string, args: string[], env: Record<string, string | undefined> = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', [script, ...args], { env: baseEnv(env), encoding: 'utf8', timeout: 120_000 });
}

function runAsync(script: string, args: string[], env: Record<string, string | undefined> = {}): Promise<{ status: number | null; stdout: string; stderr: string; endedAt: number }> {
  return new Promise((done) => {
    const child = spawn('bash', [script, ...args], { env: baseEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (status) => done({ status, stdout, stderr, endedAt: Date.now() }));
  });
}

function output(res: { status: number | null; stdout: string; stderr: string }): string {
  return `exit ${res.status}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- report JSON degli script
type Json = Record<string, any>;

function json(res: { stdout: string }): Json {
  return JSON.parse(res.stdout) as Json;
}

function python(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('python3', args, { encoding: 'utf8', timeout: 60_000 });
}

/** Inventario del volume con le regole del backup (cache escluse): uguale prima e dopo = nient'altro toccato. */
function inventory(root: string): Json {
  const res = python([STACK_TOOL, 'inventory-dir', root]);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout) as Json;
}

function cacheDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name === '.Radicale.cache') out.push(full);
      else if (entry.isDirectory()) walk(full);
    }
  };
  walk(join(root, 'collections'));
  return out.sort();
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Processo che tiene il lock di Radicale (come una richiesta in corso) finché non lo si ferma. */
async function holdLock(volume: string, mode: '-s' | '-x', seconds: number): Promise<{ released: Promise<number>; stop: () => void }> {
  const lockfile = join(volume, 'collections/.Radicale.lock');
  const child = spawn('flock', [mode, lockfile, 'sleep', String(seconds)], { stdio: 'ignore', detached: true });
  const released = new Promise<number>((done) => child.on('close', () => done(Date.now())));
  // Gruppo di processi del figlio (flock e il suo sleep): fermati insieme.
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      // già terminato
    }
  };
  // Attende che il lock sia davvero preso: un lock nel verso opposto non riesce.
  const probe = mode === '-s' ? '-x' : '-s';
  for (let i = 0; i < 100; i++) {
    if (spawnSync('flock', ['-n', probe, lockfile, 'true']).status !== 0) return { released, stop };
    await sleep(20);
  }
  stop();
  throw new Error('lock di prova non ottenuto');
}

/** `docker` finto: volume inspect (mappa nome → cartella in FAKE_DOCKER_VOLUMES) e ps. */
function fakeDocker(volumes: Record<string, string>, psNames: string[] = []): string {
  const bin = freshDir('fakebin');
  const cases = Object.entries(volumes).map(([name, dir]) => `    '${name}') printf '%s\\n' '${dir}'; exit 0 ;;`).join('\n');
  writeFileSync(join(bin, 'docker'), [
    '#!/bin/sh',
    '# docker finto per i test di radicale-maint.sh',
    'last=""; for a in "$@"; do last="$a"; done',
    'if [ "$1" = volume ] && [ "$2" = inspect ]; then',
    '  case "$last" in',
    cases,
    '  esac',
    '  echo "Error: No such volume: $last" >&2; exit 1',
    'fi',
    `if [ "$1" = ps ]; then printf '%s\\n' ${psNames.map((n) => `'${n}'`).join(' ')}; exit 0; fi`,
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'docker'), 0o755);
  return bin;
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

// ─── Sintassi, uso e limiti ───────────────────────────────────

describe('radicale-maint.sh: sintassi, uso e limiti', { skip: SKIP ?? false }, () => {
  test('bash -n degli script e compilazione degli helper Python', () => {
    for (const script of [MAINT, BACKUP]) {
      const res = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
      assert.equal(res.status, 0, `${script}: ${res.stderr}`);
    }
    const out = freshDir('pyc');
    for (const file of [HELPER, STACK_TOOL]) {
      const res = python(['-c', 'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)', file, join(out, 'x.pyc')]);
      assert.equal(res.status, 0, `${file}: ${res.stderr}`);
    }
    assert.ok(statSync(MAINT).mode & 0o100, 'radicale-maint.sh eseguibile');
  });

  test('--help elenca i sottocomandi; sottocomando o opzione sbagliati → exit 2', () => {
    const help = run(MAINT, ['--help']);
    assert.equal(help.status, 0, output(help));
    for (const cmd of ['status', 'du', 'verify', 'identity', 'snapshot', 'purge-cache', 'compact-cache', 'pinned-list', 'pinned-purge', 'phase0-detect', 'phase0-backup', 'phase0-export', 'phase0-purge']) {
      assert.match(help.stdout, new RegExp(`\\b${cmd}\\b`), cmd);
    }
    assert.equal(run(MAINT, []).status, 2);
    assert.equal(run(MAINT, ['ripara-tutto']).status, 2);
    assert.equal(run(MAINT, ['status', '--dry-run']).status, 2, '--dry-run solo per le cache');
    assert.equal(run(MAINT, ['snapshot', '--label', 'Con Spazi']).status, 2);
    assert.equal(run(MAINT, ['phase0-export', '--out']).status, 2);
  });

  test('limiti allineati a MIGRATION_LIMITS dell\'API e al config di Radicale', () => {
    const res = python([HELPER, 'limits']);
    assert.equal(res.status, 0, res.stderr);
    const limits = JSON.parse(res.stdout) as Json;
    assert.equal(limits.archive_max_bytes, MIGRATION_LIMITS.archiveMaxBytes);
    assert.equal(limits.archive_max_items, MIGRATION_LIMITS.archiveMaxItems);
    const configured = /^max_resource_size\s*=\s*(\d+)\s*$/m.exec(readFileSync(PRODUCTION_CONFIG, 'utf8'));
    assert.ok(configured, 'max_resource_size nel config di produzione');
    assert.equal(limits.max_resource_size, Number(configured[1]));
    assert.equal(limits.large_collection_items, 5000, 'soglia del design §16.5');
  });

  test('volume non configurato, senza collections/ o con il nome del volume della Fase 0 → exit 1', () => {
    assert.equal(run(MAINT, ['status']).status, 1);
    const empty = freshDir('vuota');
    const res = run(MAINT, ['status'], { RADICALE_VOLUME_DIR: empty });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /manca collections\//);
    const bin = fakeDocker({ 'tst-maint_radicale_data': makePhase0Volume() });
    const phase0 = run(MAINT, ['status'], { RADICALE_VOLUME: 'tst-maint_radicale_data', PATH: `${bin}:${process.env.PATH}` });
    assert.equal(phase0.status, 1, output(phase0));
    assert.match(phase0.stderr, /volume della Fase 0/);
    const same = makeVolume();
    const both = run(MAINT, ['status'], { RADICALE_VOLUME_DIR: same, PHASE0_VOLUME_DIR: same });
    assert.equal(both.status, 1);
    assert.match(both.stderr, /stessa cartella/);
  });
});

// ─── Stato, dimensioni e verifica ─────────────────────────────

describe('radicale-maint.sh: status, du e verify (sola lettura)', { skip: SKIP ?? false }, () => {
  test('status: marker, collezioni, item, cache e lock, senza toccare il volume', () => {
    const volume = makeVolume({ volumeId: VOLUME_ID });
    const before = inventory(volume);
    const res = run(MAINT, ['status'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(res.status, 0, output(res));
    const doc = json(res);
    assert.deepEqual(doc.marker, { state: 'ok', volume_id: VOLUME_ID, epoch: 1, detail: null });
    assert.equal(doc.lock.present, true);
    assert.deepEqual(doc.collections.map((c: Json) => [c.name, c.items, c.role]), [['federico/c', 2, 'user'], ['federico/f', 1, 'holidays']]);
    assert.equal(doc.items_total, 3);
    assert.ok(doc.cache_bytes_total > 0);
    assert.ok(typeof doc.fs_type === 'string' && doc.fs_type.length > 0);
    assert.match(res.stderr, /marker di federico: ok/);
    assert.ok(!res.stdout.includes(SECRET_SUMMARY) && !res.stderr.includes(SECRET_SUMMARY), 'mai il contenuto degli eventi');
    assert.deepEqual(inventory(volume), before);
  });

  test('du: ordine per dimensione e avviso oltre 5000 item', () => {
    const volume = makeVolume({ volumeId: VOLUME_ID });
    const big = join(principalDir(volume), 'grande');
    mkdirSync(big);
    writeFileSync(join(big, '.Radicale.props'), JSON.stringify({ tag: 'VCALENDAR' }));
    for (let i = 0; i < 5001; i++) writeFileSync(join(big, `e${i}.ics`), 'x');
    const res = run(MAINT, ['du'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(res.status, 0, output(res));
    const doc = json(res);
    assert.equal(doc.collections[0].name, 'federico/grande');
    assert.equal(doc.collections[0].items, 5001);
    assert.equal(doc.collections[0].large, true);
    assert.equal(doc.warnings.length, 1);
    assert.match(res.stderr, /federico\/grande .* ATTENZIONE: oltre 5000 item/);
  });

  test('verify: volume sano → exit 0; item rotti, UID duplicati, link e temporanei → exit 1 con i codici, senza contenuto', () => {
    const volume = makeVolume({ volumeId: VOLUME_ID });
    const ok = run(MAINT, ['verify'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(ok.status, 0, output(ok));
    assert.deepEqual(json(ok).errors, []);

    const c = join(principalDir(volume), 'c');
    writeFileSync(join(c, 'doppio.ics'), ics('riunione@caldes.test', SECRET_SUMMARY));
    writeFileSync(join(c, 'sbilanciato.ics'), 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Visita Mario Rossi 3331234567\r\nEND:VCALENDAR\r\n');
    writeFileSync(join(c, 'due-uid.ics'), ics('a@x').replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:b@x\r\nEND:VEVENT\r\nEND:VCALENDAR'));
    writeFileSync(join(c, 'latin1.ics'), Buffer.from([0x42, 0x45, 0x47, 0xe8, 0xff]));
    writeFileSync(join(c, 'senza-uid.ics'), ics('z').replace('UID:z\r\n', ''));
    symlinkSync('/etc/passwd', join(c, 'link.ics'));
    writeFileSync(join(c, '.Radicale.tmp-abc'), 'scrittura interrotta');
    const old = new Date(Date.now() - 3 * 3600_000);
    utimesSync(join(c, '.Radicale.tmp-abc'), old, old);
    const bad = run(MAINT, ['verify'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(bad.status, 1, output(bad));
    const doc = json(bad);
    const codes = (list: Json[]) => list.map((e) => `${e.code} ${String(e.path).split('/').pop()}`).sort();
    assert.deepEqual(codes(doc.errors), [
      'DUPLICATE_UID riunione.ics',
      'ITEM_MULTIPLE_UIDS due-uid.ics',
      'ITEM_NOT_UTF8 latin1.ics',
      'ITEM_NO_UID senza-uid.ics',
      'ITEM_STRUCTURE sbilanciato.ics',
      'SYMLINK link.ics',
    ].sort());
    assert.ok(codes(doc.warnings).includes('TEMP_LEFTOVER .Radicale.tmp-abc'));
    assert.ok(!bad.stdout.includes('Mario Rossi') && !bad.stderr.includes('Mario Rossi'), 'mai il contenuto degli eventi');
    assert.match(bad.stderr, /verifica non superata/);
  });

  test('verify: marker malformato → errore; principal estraneo e marker assente → avvisi', () => {
    const volume = makeVolume();
    mkdirSync(join(volume, 'collections/collection-root/iphone/vecchio'), { recursive: true });
    const res = run(MAINT, ['verify'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(res.status, 0, output(res));
    const warnings = json(res).warnings.map((w: Json) => w.code);
    assert.ok(warnings.includes('MARKER_MISSING'));
    assert.ok(warnings.includes('EXTRA_PRINCIPAL'));
    writeFileSync(join(principalDir(volume), '.Radicale.props'), JSON.stringify({ '{urn:calicchia:caldes}volume-id': 'non-uuid', '{urn:calicchia:caldes}epoch': '1' }));
    const bad = run(MAINT, ['verify'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(bad.status, 1);
    assert.deepEqual(json(bad).errors.map((e: Json) => e.code), ['MARKER_INVALID']);
  });
});

// ─── Cache sotto il lock di Radicale ──────────────────────────

describe('radicale-maint.sh: purge-cache e compact-cache sotto il lock di Radicale', { skip: SKIP ?? false }, () => {
  test('purge-cache rimuove solo le cartelle .Radicale.cache (mai link, item, proprietà, temporanei o lock); --dry-run nulla', () => {
    const volume = makeVolume({ volumeId: VOLUME_ID });
    const c = join(principalDir(volume), 'c');
    writeFileSync(join(c, '.Radicale.tmp-xyz'), 'temporaneo');
    // Un link chiamato .Radicale.cache verso una cartella fuori dal volume: mai seguito.
    const outside = freshDir('fuori');
    writeFileSync(join(outside, 'importante.txt'), 'da non cancellare');
    mkdirSync(join(principalDir(volume), 'g'));
    writeFileSync(join(principalDir(volume), 'g/.Radicale.props'), JSON.stringify({ tag: 'VCALENDAR' }));
    symlinkSync(outside, join(principalDir(volume), 'g/.Radicale.cache'));
    const before = inventory(volume);

    const dry = run(MAINT, ['purge-cache', '--dry-run'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(dry.status, 0, output(dry));
    assert.equal(json(dry).dry_run, true);
    assert.equal(json(dry).removed.length, 2);
    assert.equal(cacheDirs(volume).length, 3, 'prova a vuoto: nessuna rimozione');

    const res = run(MAINT, ['purge-cache'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(res.status, 0, output(res));
    const doc = json(res);
    assert.deepEqual(doc.removed.map((r: Json) => r.path).sort(), [
      'collections/collection-root/federico/c/.Radicale.cache',
      'collections/collection-root/federico/f/.Radicale.cache',
    ]);
    assert.deepEqual(doc.skipped.map((s: Json) => s.path), ['collections/collection-root/federico/g/.Radicale.cache']);
    assert.deepEqual(cacheDirs(volume), [join(principalDir(volume), 'g/.Radicale.cache')], 'resta solo il link, non seguito');
    assert.equal(readFileSync(join(outside, 'importante.txt'), 'utf8'), 'da non cancellare');
    assert.ok(existsSync(join(c, '.Radicale.tmp-xyz')), 'i temporanei non sono cache');
    assert.ok(lstatSync(join(volume, 'collections/.Radicale.lock')).isFile());
    assert.deepEqual(inventory(volume), before, 'item, proprietà e marker identici');
    assert.match(res.stderr, /lock esclusivo tenuto/);
    assert.ok(!res.stdout.includes(SECRET_SUMMARY));
  });

  test('purge-cache con il lock di Radicale occupato: exit 75 dopo LOCK_TIMEOUT, cache intatta', async () => {
    const volume = makeVolume({ volumeId: VOLUME_ID });
    const holder = await holdLock(volume, '-s', 5);
    const res = await runAsync(MAINT, ['purge-cache'], { RADICALE_VOLUME_DIR: volume, LOCK_TIMEOUT: '1' });
    assert.equal(res.status, 75, output(res));
    assert.match(res.stderr, /lock di Radicale non ottenuto in 1 s/);
    assert.equal(cacheDirs(volume).length, 2, 'nessuna rimozione senza lock esclusivo');
    holder.stop();
    await holder.released;
  });

  test('purge-cache attende la fine delle richieste in corso (lock condiviso) e poi pulisce', async () => {
    const volume = makeVolume({ volumeId: VOLUME_ID });
    const holder = await holdLock(volume, '-s', 1.5);
    const started = Date.now();
    const res = await runAsync(MAINT, ['purge-cache'], { RADICALE_VOLUME_DIR: volume, LOCK_TIMEOUT: '30' });
    const releasedAt = await holder.released;
    assert.equal(res.status, 0, output(res));
    assert.ok(res.endedAt >= releasedAt, 'la pulizia finisce solo dopo il rilascio del lock condiviso');
    assert.ok(res.endedAt - started >= 1000, `attesa del lock: ${res.endedAt - started} ms`);
    assert.deepEqual(cacheDirs(volume), []);
    const waited = /attesa di (\d+) ms/.exec(res.stderr);
    assert.ok(waited && Number(waited[1]) >= 900, res.stderr);
  });

  test('compact-cache rimuove solo le voci degli item cancellati: storia dei sync-token e voci vive restano', () => {
    const volume = makeVolume({ volumeId: VOLUME_ID });
    const cache = join(principalDir(volume), 'c/.Radicale.cache');
    const before = inventory(volume);
    const res = run(MAINT, ['compact-cache'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(res.status, 0, output(res));
    const doc = json(res);
    assert.equal(doc.removed, 1);
    assert.deepEqual(doc.collections, [{ path: 'collections/collection-root/federico/c', removed: 1, bytes: Buffer.byteLength(`pickle ${SECRET_SUMMARY} vecchio`) }]);
    assert.deepEqual(readdirSync(join(cache, 'item')), ['pranzo.ics']);
    assert.deepEqual(readdirSync(join(cache, 'history')), ['pranzo.ics']);
    assert.ok(existsSync(join(cache, '.Radicale.lock')));
    assert.deepEqual(inventory(volume), before);
    const again = run(MAINT, ['compact-cache'], { RADICALE_VOLUME_DIR: volume });
    assert.equal(json(again).removed, 0, 'idempotente');
  });
});

describe('radicale-maint.sh su un Radicale 3.7.8 in esecuzione', { skip: SKIP ?? radicaleAvailability().skip }, () => {
  const rad = useRadicale({ label: 'maint' });
  const P = TEST_PRINCIPAL;

  test('purge-cache con Radicale attivo: letture identiche, cache ricostruita, sync-token vecchio rifiutato e sync completa', async () => {
    const client = rad.client();
    assert.equal((await client.mkcalendar(`/${P}/maint/`)).status, 201);
    for (const n of [1, 2, 3]) assert.equal((await client.put(`/${P}/maint/e${n}.ics`, ics(`maint-${n}@caldes.test`, `Evento ${n}`), { ifNoneMatch: '*' })).status, 201);
    const first = await client.syncCollection(`/${P}/maint/`);
    const token = first.multistatus().syncToken;
    assert.ok(token);
    const bodies = await Promise.all([1, 2, 3].map(async (n) => (await client.get(`/${P}/maint/e${n}.ics`)).text));
    const volume = rad.server.rootDir;
    assert.ok(cacheDirs(volume).length > 0, 'Radicale ha scritto la cache');

    const res = await runAsync(MAINT, ['purge-cache'], { RADICALE_VOLUME_DIR: volume, LOCK_TIMEOUT: '30' });
    assert.equal(res.status, 0, output(res));
    assert.deepEqual(cacheDirs(volume), []);

    for (const n of [1, 2, 3]) assert.equal((await client.get(`/${P}/maint/e${n}.ics`)).text, bodies[n - 1], `e${n} invariato`);
    const listing = await client.propfind(`/${P}/maint/`, { depth: 1, props: [DAV_PROPS.getetag] });
    assert.equal(listing.multistatus().responses.length, 4, 'collezione e 3 item');
    // Il token di prima non è più nella storia: il client rifà una sync completa (RFC 6578 §3.2).
    const stale = await client.syncCollection(`/${P}/maint/`, { syncToken: token });
    assert.ok(stale.status === 403 || stale.status === 409, stale.describe());
    assert.match(stale.text, /valid-sync-token/);
    const full = await client.syncCollection(`/${P}/maint/`);
    assert.equal(full.multistatus().responses.length, 3);
    assert.ok(cacheDirs(volume).length > 0, 'cache ricostruita da Radicale');
    // Scrittura dopo la pulizia: tutto torna normale.
    assert.equal((await client.put(`/${P}/maint/e4.ics`, ics('maint-4@caldes.test'), { ifNoneMatch: '*' })).status, 201);
  });

  test('compact-cache con Radicale attivo: il sync-token resta valido e riporta la cancellazione', async () => {
    const client = rad.client();
    assert.equal((await client.mkcalendar(`/${P}/compatta/`)).status, 201);
    for (const n of [1, 2]) assert.equal((await client.put(`/${P}/compatta/c${n}.ics`, ics(`compatta-${n}@caldes.test`), { ifNoneMatch: '*' })).status, 201);
    for (const n of [1, 2]) await client.get(`/${P}/compatta/c${n}.ics`);
    const token = (await client.syncCollection(`/${P}/compatta/`)).multistatus().syncToken;
    assert.equal((await client.delete(`/${P}/compatta/c2.ics`)).status, 200);
    const itemCache = rad.server.fsPath(P, 'compatta', '.Radicale.cache', 'item');
    const res = await runAsync(MAINT, ['compact-cache'], { RADICALE_VOLUME_DIR: rad.server.rootDir, LOCK_TIMEOUT: '30' });
    assert.equal(res.status, 0, output(res));
    if (existsSync(itemCache)) assert.ok(!readdirSync(itemCache).includes('c2.ics'), 'voce orfana rimossa');
    const delta = await client.syncCollection(`/${P}/compatta/`, { syncToken: token });
    assert.equal(delta.status, 207, delta.describe());
    const deleted = delta.multistatus().responses.find((r) => r.path.endsWith('/c2.ics'));
    assert.equal(deleted?.status, 404, 'la cancellazione arriva ai device con il token di prima');
    assert.equal((await client.get(`/${P}/compatta/c1.ics`)).status, 200);
  });
});

// ─── Fase 0 ───────────────────────────────────────────────────

describe('radicale-maint.sh: volume della Fase 0 (decisione 7)', { skip: SKIP ?? false }, () => {
  test('phase0-detect: assente → exit 3 con present=false; presente per cartella → riepilogo, nessuna scrittura', () => {
    const absent = run(MAINT, ['phase0-detect'], { PHASE0_VOLUME_DIR: join(workRoot, 'non-esiste') });
    assert.equal(absent.status, 3, output(absent));
    assert.equal(json(absent).present, false);
    assert.match(absent.stderr, /phase0 = absent/);

    const volume = makePhase0Volume();
    const before = inventory(volume);
    const res = run(MAINT, ['phase0-detect'], { PHASE0_VOLUME_DIR: volume });
    assert.equal(res.status, 0, output(res));
    const doc = json(res);
    assert.equal(doc.present, true);
    assert.equal(doc.radicale_layout, true);
    assert.deepEqual(doc.principals, ['federico', 'iphone']);
    assert.equal(doc.items, 4, 'compleanno, riunione, rotto e il compleanno di iphone (cache e .txt esclusi)');
    assert.deepEqual(inventory(volume), before);
  });

  test('phase0-detect con Docker: <progetto>_radicale_data, contenitori che lo montano, mai il volume nuovo', () => {
    const p0 = makePhase0Volume();
    const current = makeVolume({ volumeId: VOLUME_ID });
    const bin = fakeDocker({ 'tst-maint_radicale_data': p0, 'tst-maint_radicale_collections': current }, ['vecchio-radicale-1']);
    const env = { COMPOSE_PROJECT: 'tst-maint', PATH: `${bin}:${process.env.PATH}` };
    const res = run(MAINT, ['phase0-detect'], env);
    assert.equal(res.status, 0, output(res));
    assert.equal(json(res).source, 'volume:tst-maint_radicale_data');
    assert.deepEqual(json(res).mounted_by, ['vecchio-radicale-1']);
    assert.match(res.stderr, /Non va mai montato in Radicale/);

    const none = run(MAINT, ['phase0-detect'], { COMPOSE_PROJECT: 'altro', PATH: `${bin}:${process.env.PATH}` });
    assert.equal(none.status, 3, output(none));
    assert.match(json(none).detail, /altro_radicale_data radicale_data/);

    // Un volume della Fase 0 che è in realtà il volume corrente di Radicale: rifiutato.
    const clash = fakeDocker({ 'tst-maint_radicale_data': current, 'tst-maint_radicale_collections': current });
    const refused = run(MAINT, ['phase0-detect'], { COMPOSE_PROJECT: 'tst-maint', PATH: `${clash}:${process.env.PATH}` });
    assert.equal(refused.status, 1, output(refused));
    assert.match(refused.stderr, /coincide con il volume di Radicale/);
  });

  test('phase0-backup: tar.gz in sola lettura con sha256 e manifest; il volume resta identico', () => {
    const volume = makePhase0Volume();
    const before = inventory(volume);
    const backups = freshDir('backups');
    const res = run(MAINT, ['phase0-backup'], { PHASE0_VOLUME_DIR: volume, BACKUP_DIR: backups });
    assert.equal(res.status, 0, output(res));
    const doc = json(res);
    const dir = join(backups, 'phase0');
    assert.equal(dirname(doc.archive), dir);
    assert.match(doc.archive, /radicale_data-fase0-\d{8}T\d{6}Z\.tar\.gz$/);
    const archive = readFileSync(doc.archive);
    assert.equal(doc.sha256, sha256(archive));
    assert.equal(readFileSync(`${doc.archive}.sha256`, 'utf8').split(/\s+/)[0], doc.sha256);
    const manifest = JSON.parse(readFileSync(doc.manifest, 'utf8')) as Json;
    assert.equal(manifest.kind, 'caldes-phase0-backup');
    assert.equal(manifest.archive.sha256, doc.sha256);
    assert.equal(manifest.items, 4);
    for (const file of [doc.archive, doc.manifest, `${doc.archive}.sha256`]) assert.equal(statSync(file).mode & 0o777, 0o600, file);
    assert.ok(readdirSync(dir).every((name) => !name.startsWith('.partial')), 'nessun parziale');
    // Copia integrale (cache compresa): è l'archivio della decisione 7.
    const listing = spawnSync('tar', ['-tzf', doc.archive], { encoding: 'utf8' }).stdout;
    assert.match(listing, /federico\/casa\/\.Radicale\.cache\/item\/compleanno\.ics/);
    assert.match(listing, /federico\/lavoro\/note\.txt/);
    assert.deepEqual(inventory(volume), before);
  });

  test('phase0-export: zip con i nomi di readTarIcsEntries(), riletto da readArchiveItems() come lo importerà il wizard', async () => {
    const volume = makePhase0Volume();
    const before = inventory(volume);
    const backups = freshDir('backups');
    const tar = json(run(MAINT, ['phase0-backup'], { PHASE0_VOLUME_DIR: volume, BACKUP_DIR: backups }));
    const res = run(MAINT, ['phase0-export'], { PHASE0_VOLUME_DIR: volume, BACKUP_DIR: backups });
    assert.equal(res.status, 0, output(res));
    const doc = json(res);
    const zipPath = join(backups, 'phase0/archivio-fase0.zip');
    assert.equal(doc.zip, zipPath);
    assert.equal(statSync(zipPath).mode & 0o777, 0o600);
    const zip = readFileSync(zipPath);
    assert.equal(doc.sha256, sha256(zip));
    assert.ok(zip.length <= MIGRATION_LIMITS.archiveMaxBytes);

    // Stessi nomi che l'API dà agli item del tar di phase0-backup: stessa chiave del ledger.
    const fromZip = readZipIcsEntries(zip).entries.map((e) => e.name);
    const fromTar = readTarIcsEntries(gunzipSync(readFileSync(tar.archive))).entries.map((e) => e.name);
    assert.deepEqual(fromZip, ['casa__compleanno.ics', 'lavoro__riunione.ics', 'lavoro__rotto.ics', 'iphone__casa__compleanno.ics']);
    assert.deepEqual([...fromZip].sort(), [...fromTar].sort());

    const imported = await readArchiveItems(zip, 'archivio-fase0.zip', new Date('2026-10-10T00:00:00Z'));
    assert.deepEqual(imported.items.map((i) => [i.source_name, i.uid]).sort(), [
      ['casa__compleanno.ics', 'compleanno@fase0.test'],
      ['iphone__casa__compleanno.ics', 'compleanno-iphone@fase0.test'],
      ['lavoro__riunione.ics', 'riunione@fase0.test'],
    ]);
    assert.deepEqual(imported.rejected.map((r) => [r.source_name, r.reason]), [['lavoro__rotto.ics', 'invalid']]);
    const zipEntries = readZipIcsEntries(zip).entries;
    for (const item of imported.items) {
      const entry = zipEntries.find((e) => e.name === item.source_name);
      assert.ok(entry && sha256(entry.data) === item.sha256, `${item.source_name}: contenuto identico all'originale`);
    }
    // manifest.json nello zip (ignorato dall'import), con lo sha256 di ogni item.
    const manifestEntry = spawnSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' });
    if (manifestEntry.status === 0) {
      const manifest = JSON.parse(manifestEntry.stdout) as Json;
      assert.equal(manifest.kind, 'caldes-phase0-export');
      assert.equal(manifest.items, 4);
      assert.equal(manifest.entries.find((e: Json) => e.name === 'lavoro__riunione.ics').sha256,
        sha256(readFileSync(join(volume, 'collections/collection-root/federico/lavoro/riunione.ics'))));
    }
    assert.deepEqual(inventory(volume), before, 'il volume della Fase 0 non si tocca');

    // --from: stesso zip (stessi item, stesso contenuto) dal tar invece che dal volume.
    const fromBackup = join(backups, 'dal-tar.zip');
    const res2 = run(MAINT, ['phase0-export', '--from', tar.archive, '--out', fromBackup], {});
    assert.equal(res2.status, 0, output(res2));
    const a = readZipIcsEntries(zip).entries.map((e) => [e.name, sha256(e.data)]);
    const b = readZipIcsEntries(readFileSync(fromBackup)).entries.map((e) => [e.name, sha256(e.data)]);
    assert.deepEqual(b, a);
  });

  test('phase0-export: tar alterato (sha256 diverso) e limiti del wizard superati → exit 1 senza file', () => {
    const volume = makePhase0Volume();
    const backups = freshDir('backups');
    const tar = json(run(MAINT, ['phase0-backup'], { PHASE0_VOLUME_DIR: volume, BACKUP_DIR: backups }));
    writeFileSync(`${tar.archive}.sha256`, `${'0'.repeat(64)}  x.tar.gz\n`);
    const out = join(backups, 'alterato.zip');
    const res = run(MAINT, ['phase0-export', '--from', tar.archive, '--out', out]);
    assert.equal(res.status, 1, output(res));
    assert.match(res.stderr, /alterato o incompleto/);
    assert.equal(existsSync(out), false);

    for (const [flag, value, message] of [['--max-items', '2', /oltre 2 item/], ['--max-bytes', '200', /oltre il limite del wizard/]] as const) {
      const target = join(backups, `limite${flag}.zip`);
      const helper = python([HELPER, 'phase0-export', '--out', target, '--dir', volume, flag, value]);
      assert.equal(helper.status, 1, helper.stderr);
      assert.match(helper.stderr, message);
      assert.equal(existsSync(target), false);
      assert.deepEqual(readdirSync(backups).filter((n) => n.includes('.partial')), [], 'nessun parziale');
    }
  });
});

// ─── Database: identità, registrazione del backup, snapshot ───

async function readMigrationState() {
  const [row] = await sql.unsafe(`SELECT ${MIGRATION_STATE_COLUMNS.join(', ')} FROM calendar_backend_state WHERE id`);
  return normalizeMigrationState(row as Record<string, unknown>);
}

async function setIdentity(volumeId: string | null, epoch: number): Promise<void> {
  await sql`UPDATE calendar_backend_state SET volume_id = ${volumeId}::uuid, epoch = ${epoch} WHERE id`;
}

describe('radicale-maint.sh: copie senza retention (snapshot conservati e file della Fase 0)', { skip: SKIP ?? false }, () => {
  /** BACKUP_DIR con due snapshot conservati (uno vecchio con etichetta, uno di oggi), un parziale e i file della Fase 0. */
  function makeBackupDir(): { dir: string; old: string; recent: string } {
    const dir = freshDir('backups');
    const pinned = join(dir, 'calendar-stack/pinned');
    const old = '20200101T000000Z-pre-migrazione';
    const recent = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
    for (const name of [old, recent]) {
      mkdirSync(join(pinned, name, 'radicale'), { recursive: true });
      writeFileSync(join(pinned, name, 'database.sql.gz'), `dump ${SECRET_SUMMARY}`);
      writeFileSync(join(pinned, name, 'manifest.json'), '{}');
    }
    mkdirSync(join(pinned, '.partial-20990101T000000Z'), { recursive: true });
    // Run ordinario (gestito dalla retention del backup): mai toccato.
    mkdirSync(join(dir, 'calendar-stack/20260101T000000Z'), { recursive: true });
    const phase0 = join(dir, 'phase0');
    mkdirSync(phase0, { recursive: true });
    for (const f of ['radicale_data-fase0-20260101T000000Z.tar.gz', 'radicale_data-fase0-20260101T000000Z.tar.gz.sha256',
      'radicale_data-fase0-20260101T000000Z.manifest.json', 'archivio-fase0.zip']) writeFileSync(join(phase0, f), 'x');
    writeFileSync(join(phase0, '.gitignore'), '*\n');
    writeFileSync(join(phase0, 'note-operatore.txt'), 'non toccare');
    return { dir, old, recent };
  }

  test('pinned-list: elenco in sola lettura con byte e data, parziali esclusi', () => {
    const { dir, old, recent } = makeBackupDir();
    const res = run(MAINT, ['pinned-list'], { BACKUP_DIR: dir });
    assert.equal(res.status, 0, output(res));
    const report = json(res);
    assert.deepEqual(report.entries.map((e: Json) => e.name), [old, recent].sort());
    assert.ok(report.bytes > 0);
    assert.ok(!res.stdout.includes(SECRET_SUMMARY), 'nessun contenuto nel report');
    assert.ok(existsSync(join(dir, 'calendar-stack/pinned', old)));
  });

  test('pinned-purge: senza --yes rifiuta; --dry-run elenca; --older-than e --yes cancellano solo gli snapshot conservati', () => {
    const { dir, old, recent } = makeBackupDir();
    const pinned = join(dir, 'calendar-stack/pinned');
    assert.equal(run(MAINT, ['pinned-purge'], { BACKUP_DIR: dir }).status, 2, 'serve una conferma esplicita');
    assert.equal(run(MAINT, ['pinned-purge', '--older-than', 'tanti', '--yes'], { BACKUP_DIR: dir }).status, 2);
    assert.equal(run(MAINT, ['status', '--yes'], { BACKUP_DIR: dir }).status, 2);
    const dry = run(MAINT, ['pinned-purge', '--dry-run'], { BACKUP_DIR: dir });
    assert.equal(dry.status, 0, output(dry));
    assert.equal(json(dry).count, 2);
    assert.ok(existsSync(join(pinned, old)) && existsSync(join(pinned, recent)), 'la prova a vuoto non cancella');
    const older = run(MAINT, ['pinned-purge', '--older-than', '30', '--yes'], { BACKUP_DIR: dir });
    assert.equal(older.status, 0, output(older));
    assert.deepEqual(json(older).entries.map((e: Json) => e.name), [old]);
    assert.ok(!existsSync(join(pinned, old)));
    assert.ok(existsSync(join(pinned, recent)));
    const all = run(MAINT, ['pinned-purge', '--yes'], { BACKUP_DIR: dir });
    assert.equal(all.status, 0, output(all));
    assert.deepEqual(readdirSync(pinned).sort(), ['.partial-20990101T000000Z'], 'il parziale di uno snapshot in corso resta');
    assert.ok(existsSync(join(dir, 'calendar-stack/20260101T000000Z')), 'i run ordinari restano alla retention del backup');
  });

  test('phase0-purge: solo i file di phase0-backup e phase0-export; .gitignore e altri file restano; mai il volume', () => {
    const { dir } = makeBackupDir();
    const phase0Volume = makePhase0Volume();
    const before = inventory(phase0Volume);
    assert.equal(run(MAINT, ['phase0-purge'], { BACKUP_DIR: dir }).status, 2);
    const dry = run(MAINT, ['phase0-purge', '--dry-run'], { BACKUP_DIR: dir, PHASE0_VOLUME_DIR: phase0Volume });
    assert.equal(dry.status, 0, output(dry));
    assert.equal(json(dry).count, 4);
    const res = run(MAINT, ['phase0-purge', '--yes'], { BACKUP_DIR: dir, PHASE0_VOLUME_DIR: phase0Volume });
    assert.equal(res.status, 0, output(res));
    assert.deepEqual(readdirSync(join(dir, 'phase0')).sort(), ['.gitignore', 'note-operatore.txt']);
    assert.deepEqual(inventory(phase0Volume), before, 'il volume della Fase 0 non si tocca (decisione 7)');
    const empty = run(MAINT, ['phase0-purge', '--yes'], { BACKUP_DIR: freshDir('vuota') });
    assert.equal(empty.status, 0, output(empty));
    assert.equal(json(empty).count, 0);
  });
});

describe('radicale-maint.sh identity e backup coordinato registrato', { skip: SKIP_DB ?? false }, () => {
  test('identity: da inizializzare, marker senza stato, ok, mismatch', async () => {
    const env = (volume: string) => ({ RADICALE_VOLUME_DIR: volume, DATABASE_URL });
    try {
      await setIdentity(null, 0);
      const fresh = run(MAINT, ['identity'], env(makeVolume()));
      assert.equal(fresh.status, 0, output(fresh));
      assert.deepEqual([json(fresh).status, json(fresh).usable], ['uninitialized', true]);

      const marked = makeVolume({ volumeId: VOLUME_ID });
      const stray = run(MAINT, ['identity'], env(marked));
      assert.equal(stray.status, 1, output(stray));
      assert.match(json(stray).detail, /ha già un marker/);

      await setIdentity(VOLUME_ID, 1);
      const ok = run(MAINT, ['identity'], env(marked));
      assert.equal(ok.status, 0, output(ok));
      assert.equal(json(ok).status, 'ok');

      const other = run(MAINT, ['identity'], env(makeVolume({ volumeId: OTHER_VOLUME_ID })));
      assert.equal(other.status, 1, output(other));
      assert.equal(json(other).status, 'mismatch');
      assert.match(other.stderr, /riassegnazione confermata/);
    } finally {
      await setIdentity(null, 0);
    }
  });

  test('backup coordinato → last_stack_backup {id, at, complete, volume_id, epoch, manifest_sha256} senza toccare la policy', async () => {
    await setIdentity(VOLUME_ID, 1);
    try {
      const before = await readMigrationState();
      const backups = freshDir('backups');
      const volume = makeVolume({ volumeId: VOLUME_ID });
      const res = run(BACKUP, ['--no-upload'], { BACKUP_DIR: backups, RADICALE_VOLUME_DIR: volume, DATABASE_URL });
      assert.equal(res.status, 0, output(res));
      const runDir = join(backups, 'calendar-stack/latest');
      const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as Json;
      const state = await readMigrationState();
      assert.deepEqual(state.last_stack_backup, {
        id: manifest.id,
        at: manifest.created_at,
        complete: true,
        volume_id: VOLUME_ID,
        epoch: 1,
        manifest_sha256: sha256(readFileSync(join(runDir, 'manifest.json'))),
      });
      assert.equal(state.policy_version, before.policy_version, 'last_stack_backup non entra nella policy');
      assert.match(res.stdout, /registrato in calendar_backend_state\.last_stack_backup/);

      // Solo database: registrato come non coordinato (il preflight non lo conta).
      const dbOnly = run(BACKUP, ['--db-only', '--no-upload'], { BACKUP_DIR: backups, DATABASE_URL });
      assert.equal(dbOnly.status, 0, output(dbOnly));
      const after = (await readMigrationState()).last_stack_backup;
      assert.equal(after?.complete, false);
      assert.equal(after?.volume_id, null);
      assert.equal(after?.epoch, null);
      assert.notEqual(after?.id, manifest.id);
    } finally {
      await sql`UPDATE calendar_backend_state SET last_stack_backup = NULL WHERE id`;
      await setIdentity(null, 0);
    }
  });

  test('registrazione in best effort: un UPDATE che fallisce non cambia l\'exit del backup', async () => {
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION tst_maint_block_last_backup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.last_stack_backup IS DISTINCT FROM OLD.last_stack_backup THEN
          RAISE EXCEPTION 'registrazione bloccata dal test';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS tst_maint_block_last_backup ON calendar_backend_state;
      CREATE TRIGGER tst_maint_block_last_backup BEFORE UPDATE ON calendar_backend_state
        FOR EACH ROW EXECUTE FUNCTION tst_maint_block_last_backup();
    `);
    try {
      const backups = freshDir('backups');
      const res = run(BACKUP, ['--no-upload'], { BACKUP_DIR: backups, RADICALE_VOLUME_DIR: makeVolume(), DATABASE_URL });
      assert.equal(res.status, 0, output(res));
      assert.match(res.stderr, /last_stack_backup non registrato: UPDATE di calendar_backend_state fallito/);
      assert.ok(existsSync(join(backups, 'calendar-stack/latest/manifest.json')), 'il backup c\'è comunque');
      assert.equal((await readMigrationState()).last_stack_backup, null);
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS tst_maint_block_last_backup ON calendar_backend_state; DROP FUNCTION IF EXISTS tst_maint_block_last_backup()');
    }
  });

  test('snapshot prima della migrazione: backup completo, copia conservata fuori dalla retention e verificabile dal ripristino', async () => {
    await setIdentity(VOLUME_ID, 1);
    try {
      const backups = freshDir('backups');
      const volume = makeVolume({ volumeId: VOLUME_ID });
      const res = run(MAINT, ['snapshot', '--label', 'pre-migrazione', '--no-upload'], { BACKUP_DIR: backups, RADICALE_VOLUME_DIR: volume, DATABASE_URL });
      assert.equal(res.status, 0, output(res));
      const doc = json(res);
      const root = join(backups, 'calendar-stack');
      assert.equal(doc.pinned_dir, join(root, 'pinned', `${doc.id}-pre-migrazione`));
      assert.equal(doc.identity, 'ok');
      assert.deepEqual(readdirSync(doc.pinned_dir).sort(), ['caldes-db.sql.gz', 'manifest.json', 'radicale-collections.tar.gz']);
      // Stesso run registrato per il preflight (BACKUP_RECENT).
      const state = await readMigrationState();
      assert.equal(state.last_stack_backup?.id, doc.id);
      assert.equal(state.last_stack_backup?.complete, true);
      assert.equal(state.last_stack_backup?.manifest_sha256, doc.manifest_sha256);
      // Fuori dalla retention: la cartella pinned non ha il formato degli id dei run.
      assert.ok(!/^\d{8}T\d{6}Z$/.test('pinned'));
      const verify = run(RESTORE, ['--verify-only', doc.pinned_dir], { BACKUP_DIR: backups, RADICALE_VOLUME_DIR: volume, DATABASE_URL });
      assert.equal(verify.status, 0, output(verify));

      // Senza volume il backup è incompleto: nessuno snapshot conservato.
      const incomplete = run(MAINT, ['snapshot', '--no-upload'], { BACKUP_DIR: backups, RADICALE_VOLUME_DIR: freshDir('senza-volume'), DATABASE_URL });
      assert.equal(incomplete.status, 1, output(incomplete));
      assert.match(incomplete.stderr, /INCOMPLETO/);
      assert.deepEqual(readdirSync(join(root, 'pinned')), [`${doc.id}-pre-migrazione`]);
    } finally {
      await sql`UPDATE calendar_backend_state SET last_stack_backup = NULL WHERE id`;
      await setIdentity(null, 0);
    }
  });
});
