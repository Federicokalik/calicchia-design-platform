/**
 * Control-plane dell'API verso Radicale (fase F1, piano T6): scrittura
 * atomica e lettura dei file di caldes_control, policy derivata dallo stato
 * della 162 con policyFromState(), heartbeat periodico con stop pulito,
 * NOTIFY calendar_policy_changed e identità del volume dal mount.
 *
 * Moduli: src/lib/calendar/radicale/{policy,heartbeat,identity}.ts.
 * Contratto: docs/calendar-radicale/contracts/control-plane.md §2, §4, §5, §7.
 *
 * Usa il database dei test (TEST_DATABASE_URL) con la baseline del
 * calendario. Le variazioni di stato e sidecar girano in transazioni
 * annullate; i soli UPDATE committati (per provare il NOTIFY, che parte al
 * commit) toccano calendar_backend_state, che non ha trigger di audit, e
 * vengono riportati alla baseline a fine file. I file vivono in directory
 * temporanee rimosse alla fine. Nessun Radicale: l'integrazione con il server
 * reale è in test/integration/radicale-client.test.ts.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { validateJsonSchema } from '../helpers/json-schema-lite';
import {
  CalendarControlPlane,
  type ControlPlaneTick,
  effectiveModeFromFiles,
  getCalendarControlPlane,
  readHeartbeatFile,
  requestControlPlaneSync,
  startCalendarControlPlane,
  stopCalendarControlPlane,
  writeHeartbeat,
} from '../../src/lib/calendar/radicale/heartbeat';
import {
  checkVolumeIdentity,
  fileIdentitySource,
  type IdentitySource,
  NO_IDENTITY_SOURCE,
  readVolumeMarkerFromFile,
  resolveIdentitySource,
} from '../../src/lib/calendar/radicale/identity';
import {
  CONTROL_FILE_MODE,
  controlPlaneConfigFromEnv,
  type Db,
  readControlFile,
  readPolicyFile,
  readPolicyInputs,
  resolveApiVersion,
  syncPolicyFile,
  writeControlFileAtomic,
} from '../../src/lib/calendar/radicale/policy';
import {
  CONTROL_FILE_MAX_BYTES,
  DEAD_PROP,
  DEFAULT_PRINCIPAL,
  parseHeartbeat,
  parsePolicy,
  principalPropsPath,
  serializeControlFile,
} from '../../src/lib/calendar/radicale/types';

useTestDatabase({ resetBaseline: true });
// Lo stato committato dai test del NOTIFY torna alla baseline anche se un test fallisce.
onBeforeDatabaseClose(async () => {
  await stopCalendarControlPlane();
  await resetCalendarBaseline();
});

const CONTRACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/calendar-radicale/contracts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- documenti JSON Schema
const loadJson = (name: string): any => JSON.parse(readFileSync(resolve(CONTRACTS_DIR, name), 'utf8'));
const POLICY_SCHEMA = loadJson('policy.schema.json');
const HEARTBEAT_SCHEMA = loadJson('heartbeat.schema.json');

const P = DEFAULT_PRINCIPAL;
const VOLUME = '3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60';
const OTHER_VOLUME = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

// ─── Directory temporanee ───────────────────────────────

const ROOT = mkdtempSync(join(tmpdir(), 'caldes-control-plane-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let dirCounter = 0;
/** Directory nuova sotto ROOT. */
function freshDir(label: string): string {
  const dir = join(ROOT, `${label}-${++dirCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Scrive il `.Radicale.props` del principal con il marker dato (o un contenuto grezzo). */
function writePrincipalProps(dataDir: string, content: Record<string, string> | string): void {
  const path = principalPropsPath(dataDir, P);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}

const marker = (volumeId: string, epoch: string): Record<string, string> => ({ [DEAD_PROP.volumeId]: volumeId, [DEAD_PROP.epoch]: epoch });

/** Annulla la transazione dopo `fn` (le modifiche di stato e sidecar non restano). */
const ROLLBACK = Symbol('rollback');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
async function inRolledBackTx(fn: (tx: any) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** Orologio che avanza di `stepMs` a ogni lettura (ts del heartbeat strettamente crescenti). */
function steppingClock(startIso: string, stepMs = 1_000): () => Date {
  let t = Date.parse(startIso);
  return () => new Date((t += stepMs));
}

/** Attende che `predicate` sia vero (polling), entro `timeoutMs`. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, what = 'condizione'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout in attesa di: ${what}`);
}

function controlPlane(opts: {
  dir: string;
  db?: Db;
  identitySource?: IdentitySource;
  intervalMs?: number;
  listen?: boolean;
  now?: () => Date;
  onTick?: (tick: ControlPlaneTick) => void;
  policyFile?: string;
  heartbeatFile?: string;
}): CalendarControlPlane {
  return new CalendarControlPlane({
    db: opts.db ?? sql,
    policyFile: opts.policyFile ?? join(opts.dir, 'policy.json'),
    heartbeatFile: opts.heartbeatFile ?? join(opts.dir, 'heartbeat.json'),
    principal: P,
    apiVersion: 'sha-test123',
    identitySource: opts.identitySource ?? NO_IDENTITY_SOURCE,
    intervalMs: opts.intervalMs ?? 3_600_000,
    listen: opts.listen ?? false,
    now: opts.now,
    onTick: opts.onTick,
  });
}

// ─── Scrittura atomica ───────────────────────────────

describe('scrittura atomica dei file di caldes_control (contratto §5.2)', () => {
  test('permessi 0644 anche con una umask restrittiva, nessun temporaneo residuo', async () => {
    const dir = freshDir('perm');
    const path = join(dir, 'policy.json');
    const previous = process.umask(0o077);
    try {
      await writeControlFileAtomic(path, '{"a":1}\n');
    } finally {
      process.umask(previous);
    }
    assert.equal((await stat(path)).mode & 0o777, CONTROL_FILE_MODE);
    assert.equal(await readFile(path, 'utf8'), '{"a":1}\n');
    assert.deepEqual(await readdir(dir), ['policy.json']);
  });

  test('la sostituzione è un rename: inode nuovo e contenuto completo', async () => {
    const dir = freshDir('rename');
    const path = join(dir, 'heartbeat.json');
    await writeControlFileAtomic(path, 'uno\n');
    const before = await stat(path);
    await writeControlFileAtomic(path, 'due\n');
    const afterWrite = await stat(path);
    assert.notEqual(afterWrite.ino, before.ino, 'mai scritture in place');
    assert.equal(await readFile(path, 'utf8'), 'due\n');
    assert.deepEqual(await readdir(dir), ['heartbeat.json']);
  });

  test('un lettore concorrente vede sempre un file completo (il vecchio o il nuovo)', async () => {
    const dir = freshDir('concurrent');
    const path = join(dir, 'policy.json');
    // Due contenuti grandi (~40 KiB) e diversi: una lettura a metà scrittura non sarebbe JSON valido.
    const payloads = ['a', 'b'].map((ch) => `${JSON.stringify({ fill: ch.repeat(40_000) })}\n`);
    await writeControlFileAtomic(path, payloads[0]);
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 150; i++) await writeControlFileAtomic(path, payloads[i % 2]);
      writing = false;
    })();
    let reads = 0;
    const readers = Array.from({ length: 3 }, async () => {
      while (writing) {
        const text = await readFile(path, 'utf8');
        assert.ok(payloads.includes(text), `lettura parziale o mista (${text.length} caratteri)`);
        reads++;
      }
    });
    await Promise.all([writer, ...readers]);
    assert.ok(reads > 10, `troppe poche letture concorrenti (${reads})`);
    assert.deepEqual(await readdir(dir), ['policy.json']);
  });

  test('errore di scrittura: il temporaneo viene rimosso e l\'errore arriva al chiamante', async () => {
    const dir = freshDir('fail');
    // Il percorso finale è una cartella: il rename fallisce dopo la scrittura del temporaneo.
    const target = join(dir, 'policy.json');
    mkdirSync(target);
    await assert.rejects(writeControlFileAtomic(target, '{}\n'), (err: NodeJS.ErrnoException) => typeof err.code === 'string');
    assert.deepEqual(await readdir(dir), ['policy.json']);
    // Cartella assente (volume non montato).
    await assert.rejects(writeControlFileAtomic(join(dir, 'manca', 'policy.json'), '{}\n'), { code: 'ENOENT' });
  });
});

// ─── Lettura ───────────────────────────────

describe('lettura dei file con le regole dei lettori (contratto §5.3, §5.4, §7.2)', () => {
  const validPolicy = {
    schema: 1, version: 3, generated_at: '2026-10-09T18:00:00.000Z', backend_mode: 'postgres', mode: 'shadow',
    reasons: [], principal: P, volume_id: null, epoch: 0, credential_epoch: 0, readonly: ['scadenze', 'bookings'], hidden: ['_canary'],
  };

  test('assente → missing; valido → ok normalizzato', async () => {
    const dir = freshDir('read');
    assert.deepEqual(await readPolicyFile(join(dir, 'policy.json'), P), { state: 'missing' });
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(validPolicy));
    const read = await readPolicyFile(join(dir, 'policy.json'), P);
    assert.equal(read.state, 'ok');
    assert.deepEqual(read.state === 'ok' && read.value.readonly, ['bookings', 'scadenze']);
  });

  test('invalidi: oltre 64 KiB, non UTF-8, non JSON, schema diverso, altro principal, cartella', async () => {
    const dir = freshDir('invalid');
    const cases: Array<[string, string | Buffer]> = [
      ['oversize', `${JSON.stringify({ ...validPolicy, pad: 'x'.repeat(CONTROL_FILE_MAX_BYTES) })}`],
      ['latin1', Buffer.from([0x7b, 0x22, 0xe8, 0x22, 0x7d])],
      ['notjson', '{"schema": 1,'],
      ['schema2', JSON.stringify({ ...validPolicy, schema: 2 })],
      ['principal', JSON.stringify({ ...validPolicy, principal: 'mario' })],
    ];
    for (const [name, content] of cases) {
      writeFileSync(join(dir, name), content);
      const read = await readPolicyFile(join(dir, name), P);
      assert.equal(read.state, 'invalid', name);
    }
    mkdirSync(join(dir, 'cartella'));
    assert.equal((await readControlFile(join(dir, 'cartella'), parsePolicy)).state, 'invalid');
    writeFileSync(join(dir, 'hb'), '{"schema":1,"api_version":"x y","mode":"postgres","epoch":0,"ts":"2026-10-09T18:00:00Z"}');
    assert.equal((await readHeartbeatFile(join(dir, 'hb'))).state, 'invalid', 'api_version con spazio');
  });
});

// ─── Policy dallo stato ───────────────────────────────

describe('policy derivata dallo stato della 162 (policyFromState, contratto §6)', () => {
  test('baseline: shadow, volume non inizializzato, readonly dai ruoli del sidecar, conforme allo schema', async () => {
    const dir = freshDir('baseline');
    const inputs = await readPolicyInputs(sql);
    assert.equal(inputs.state.mode, 'postgres');
    assert.equal(inputs.state.epoch, 0);
    const result = await syncPolicyFile({ ...inputs, file: join(dir, 'policy.json'), identity: 'uninitialized', principal: P, now: new Date() });
    assert.equal(result.written, true);
    assert.equal(result.previous, 'missing');
    const text = await readFile(join(dir, 'policy.json'), 'utf8');
    assert.equal(text, serializeControlFile(result.derived), 'il file è la serializzazione canonica');
    const doc = JSON.parse(text);
    assert.deepEqual(validateJsonSchema(POLICY_SCHEMA, doc), []);
    assert.equal(doc.mode, 'shadow');
    assert.equal(doc.backend_mode, 'postgres');
    assert.equal(doc.volume_id, null);
    assert.equal(doc.version, inputs.state.policy_version);
    assert.deepEqual(doc.reasons, []);
    // Calendari seminati: bookings (ruolo bookings) e scadenze (deadlines) in sola lettura.
    assert.deepEqual(doc.readonly, ['bookings', 'scadenze']);
    assert.deepEqual(doc.hidden, ['_canary']);
  });

  test('stesso contenuto: nessuna riscrittura (stesso inode e generated_at); file invalido → riscritto', async () => {
    const dir = freshDir('same');
    const file = join(dir, 'policy.json');
    const inputs = await readPolicyInputs(sql);
    const first = await syncPolicyFile({ ...inputs, file, identity: 'uninitialized', principal: P, now: new Date('2027-01-04T08:00:00Z') });
    const ino = (await stat(file)).ino;
    const second = await syncPolicyFile({ ...inputs, file, identity: 'uninitialized', principal: P, now: new Date('2027-01-04T08:05:00Z') });
    assert.equal(second.written, false);
    assert.equal(second.previous, 'same');
    assert.equal((await stat(file)).ino, ino);
    assert.equal(second.onDisk.generated_at, first.derived.generated_at);

    writeFileSync(file, '{"schema":1');
    const third = await syncPolicyFile({ ...inputs, file, identity: 'uninitialized', principal: P, now: new Date('2027-01-04T08:10:00Z') });
    assert.equal(third.written, true);
    assert.equal(third.previous, 'invalid');
    assert.ok(third.previousError);
    assert.equal((await readPolicyFile(file, P)).state, 'ok');
  });

  test('volume registrato: shadow solo con identità ok; mismatch e unverified → frozen', async () => {
    await inRolledBackTx(async (tx) => {
      const before = await readPolicyInputs(tx);
      await tx`UPDATE calendar_backend_state SET volume_id = ${VOLUME}::uuid, epoch = 1 WHERE id = true`;
      const inputs = await readPolicyInputs(tx);
      assert.equal(inputs.state.policy_version, before.state.policy_version + 1, 'policy_version dal trigger');
      const dir = freshDir('identity');
      const file = join(dir, 'policy.json');
      const now = new Date();
      const ok = await syncPolicyFile({ ...inputs, file, identity: 'ok', principal: P, now });
      assert.equal(ok.onDisk.mode, 'shadow');
      assert.equal(ok.onDisk.volume_id, VOLUME);
      assert.equal(ok.onDisk.epoch, 1);
      const mismatch = await syncPolicyFile({ ...inputs, file, identity: 'mismatch', principal: P, now });
      assert.equal(mismatch.written, true);
      assert.equal(mismatch.previous, 'changed');
      assert.equal(mismatch.onDisk.mode, 'frozen');
      assert.deepEqual(mismatch.onDisk.reasons, ['identity_mismatch']);
      // "uninitialized" con epoch ≥ 1 è un'incoerenza: vale come non verificato.
      const incoherent = await syncPolicyFile({ ...inputs, file, identity: 'uninitialized', principal: P, now });
      assert.deepEqual(incoherent.onDisk.reasons, ['identity_unverified']);
    });
  });

  test('restore_guard e rebuild_required → frozen con i motivi nell\'ordine del contratto; guardia scaduta → shadow', async () => {
    await inRolledBackTx(async (tx) => {
      await tx`
        UPDATE calendar_backend_state
        SET rebuild_required = true, restore_guard_until = now() + interval '48 hours'
        WHERE id = true
      `;
      const inputs = await readPolicyInputs(tx);
      const file = join(freshDir('guard'), 'policy.json');
      const frozen = await syncPolicyFile({ ...inputs, file, identity: 'uninitialized', principal: P, now: new Date() });
      assert.equal(frozen.onDisk.mode, 'frozen');
      assert.deepEqual(frozen.onDisk.reasons, ['restore_guard', 'rebuild_required']);
      // Fra 49 ore la guardia è scaduta: resta solo rebuild_required.
      const later = await syncPolicyFile({ ...inputs, file, identity: 'uninitialized', principal: P, now: new Date(Date.now() + 49 * 3_600_000) });
      assert.deepEqual(later.onDisk.reasons, ['rebuild_required']);
    });
  });

  test('sidecar: device_visible=false e lifecycle diverso da active → hidden; ruolo holidays → readonly', async () => {
    await inRolledBackTx(async (tx) => {
      const token = (k: string): string => `tst-cp-${k}-${Math.random().toString(36).slice(2)}`;
      await tx`INSERT INTO calendars (slug, name, ics_feed_token) VALUES ('tst-cp-festivita', 'Festività e chiusure', ${token('f')})`;
      await tx`INSERT INTO calendars (slug, name, ics_feed_token, device_visible) VALUES ('tst-cp-nascosto', 'Nascosto', ${token('n')}, false)`;
      await tx`INSERT INTO calendars (slug, name, ics_feed_token, lifecycle) VALUES ('tst-cp-creazione', 'In creazione', ${token('c')}, 'creating')`;
      await tx`UPDATE calendars SET device_visible = false WHERE slug = 'bookings'`;
      const inputs = await readPolicyInputs(tx);
      const result = await syncPolicyFile({ ...inputs, file: join(freshDir('sidecar'), 'policy.json'), identity: 'uninitialized', principal: P, now: new Date() });
      assert.deepEqual(result.onDisk.readonly, ['scadenze', 'tst-cp-festivita']);
      assert.deepEqual(result.onDisk.hidden, ['_canary', 'bookings', 'tst-cp-creazione', 'tst-cp-nascosto']);
    });
  });
});

// ─── Giro del control-plane ───────────────────────────────

describe('giro del control-plane: policy e heartbeat (contratto §2, §5.2, §7.1)', () => {
  test('primo giro: policy e heartbeat validi per gli schemi; dai file la modalità effettiva è shadow', async () => {
    const dir = freshDir('tick');
    const cp = controlPlane({ dir });
    try {
      const tick = await cp.syncNow('start');
      assert.equal(tick.ok, true, tick.error ?? '');
      assert.equal(tick.identity?.status, 'uninitialized');
      assert.equal(tick.policy?.written, true);
      const heartbeat = JSON.parse(await readFile(join(dir, 'heartbeat.json'), 'utf8'));
      assert.deepEqual(validateJsonSchema(HEARTBEAT_SCHEMA, heartbeat), []);
      assert.deepEqual(parseHeartbeat(heartbeat), heartbeat);
      assert.equal(heartbeat.api_version, 'sha-test123');
      assert.equal(heartbeat.mode, 'postgres');
      assert.equal(heartbeat.epoch, 0);
      assert.equal((await stat(join(dir, 'heartbeat.json'))).mode & 0o777, 0o644);
      const effective = await effectiveModeFromFiles({ policyFile: join(dir, 'policy.json'), heartbeatFile: join(dir, 'heartbeat.json'), principal: P });
      assert.equal(effective.mode, 'shadow');
      assert.deepEqual(effective.reasons, []);
      assert.equal(effective.volume_id, null, 'senza volume i device non hanno permessi sotto il principal');
    } finally {
      await cp.stop();
    }
  });

  test('heartbeat a ogni giro, policy riscritta solo se cambia', async () => {
    const dir = freshDir('ticks');
    const cp = controlPlane({ dir, now: steppingClock('2027-01-04T08:00:00Z') });
    try {
      const first = await cp.syncNow();
      const hb1 = await readHeartbeatFile(join(dir, 'heartbeat.json'));
      const second = await cp.syncNow();
      const hb2 = await readHeartbeatFile(join(dir, 'heartbeat.json'));
      assert.equal(first.policy?.written, true);
      assert.equal(second.policy?.written, false);
      assert.equal(second.policy?.previous, 'same');
      assert.ok(hb1.state === 'ok' && hb2.state === 'ok');
      assert.ok(Date.parse(hb2.value.ts) > Date.parse(hb1.value.ts), 'ts del heartbeat crescente');
      assert.ok(cp.status().lastHeartbeatAt);
    } finally {
      await cp.stop();
    }
  });

  test('stato illeggibile: né policy né heartbeat vengono toccati', async () => {
    const dir = freshDir('nostate');
    await writeControlFileAtomic(join(dir, 'policy.json'), 'vecchia\n');
    await writeControlFileAtomic(join(dir, 'heartbeat.json'), 'vecchio\n');
    const before = await Promise.all(['policy.json', 'heartbeat.json'].map((f) => stat(join(dir, f))));
    // Un "database" che fallisce ogni query (come con il DB giù).
    const brokenDb = (async () => { throw new Error('connessione rifiutata'); }) as unknown as Db;
    const cp = controlPlane({ dir, db: brokenDb });
    try {
      const tick = await cp.syncNow();
      assert.equal(tick.ok, false);
      assert.equal(tick.failedStage, 'state');
      assert.match(tick.error ?? '', /connessione rifiutata/);
      assert.equal(tick.heartbeat, null);
      const afterTick = await Promise.all(['policy.json', 'heartbeat.json'].map((f) => stat(join(dir, f))));
      assert.deepEqual(afterTick.map((s) => [s.ino, s.mtimeMs]), before.map((s) => [s.ino, s.mtimeMs]));
      assert.equal(await readFile(join(dir, 'heartbeat.json'), 'utf8'), 'vecchio\n');
      assert.equal(cp.status().consecutiveFailures, 1);
    } finally {
      await cp.stop();
    }
  });

  test('policy non scrivibile: il heartbeat non viene scritto (fail-closed)', async () => {
    const dir = freshDir('nopolicy');
    const cp = controlPlane({ dir, policyFile: join(dir, 'manca', 'policy.json') });
    try {
      const tick = await cp.syncNow();
      assert.equal(tick.ok, false);
      assert.equal(tick.failedStage, 'policy');
      await assert.rejects(stat(join(dir, 'heartbeat.json')), { code: 'ENOENT' });
    } finally {
      await cp.stop();
    }
  });

  test('richieste concorrenti: serializzate e fuse in un solo giro in coda', async () => {
    const dir = freshDir('coalesce');
    const ticks: ControlPlaneTick[] = [];
    const cp = controlPlane({ dir, onTick: (t) => ticks.push(t) });
    try {
      const p1 = cp.syncNow('manual');
      const p2 = cp.syncNow('notify');
      const p3 = cp.syncNow('notify');
      assert.equal(p2, p3, 'le richieste in coda si fondono');
      await Promise.all([p1, p2, p3]);
      // p1 e p2 possono già essere fusi (nessun giro in corso al momento della prima chiamata):
      // al massimo due giri, mai sovrapposti.
      assert.ok(ticks.length >= 1 && ticks.length <= 2, `giri eseguiti: ${ticks.length}`);
      for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].startedAt >= ticks[i - 1].finishedAt, 'giri non sovrapposti');
      // Una richiesta arrivata durante un giro ne produce uno nuovo dopo di esso.
      const running = cp.syncNow('manual');
      await new Promise((r) => setImmediate(r));
      const queuedAfter = cp.syncNow('notify');
      assert.notEqual(running, queuedAfter);
      await Promise.all([running, queuedAfter]);
    } finally {
      await cp.stop();
    }
  });

  test('timer periodico e stop pulito: nessuna scrittura dopo lo stop', async () => {
    const dir = freshDir('timer');
    const ticks: ControlPlaneTick[] = [];
    const cp = controlPlane({ dir, intervalMs: 30, onTick: (t) => ticks.push(t) });
    await cp.start();
    await waitFor(() => ticks.filter((t) => t.trigger === 'interval').length >= 3, 5_000, 'tre giri periodici');
    await cp.stop();
    const count = ticks.length;
    const mtime = (await stat(join(dir, 'heartbeat.json'))).mtimeMs;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(ticks.length, count, 'nessun giro dopo lo stop');
    assert.equal((await stat(join(dir, 'heartbeat.json'))).mtimeMs, mtime);
    assert.ok(ticks.every((t) => t.ok), 'tutti i giri riusciti');
    assert.equal((await cp.syncNow()).error, 'control-plane fermato');
    assert.equal(cp.status().running, false);
  });

  test('NOTIFY calendar_policy_changed: policy riscritta subito dopo il commit dello stato', async () => {
    const dir = freshDir('notify');
    const ticks: ControlPlaneTick[] = [];
    const cp = controlPlane({ dir, listen: true, onTick: (t) => ticks.push(t) });
    try {
      await cp.start();
      await waitFor(() => cp.status().listening, 5_000, 'LISTEN attivo');
      await sql`UPDATE calendar_backend_state SET rebuild_required = true WHERE id = true`;
      await waitFor(() => ticks.some((t) => t.trigger === 'notify' && t.policy?.mode === 'frozen'), 5_000, 'giro da NOTIFY con policy frozen');
      const frozen = await readPolicyFile(join(dir, 'policy.json'), P);
      assert.ok(frozen.state === 'ok');
      assert.deepEqual(frozen.value.reasons, ['rebuild_required']);
      await sql`UPDATE calendar_backend_state SET rebuild_required = false WHERE id = true`;
      await waitFor(async () => {
        const read = await readPolicyFile(join(dir, 'policy.json'), P);
        return read.state === 'ok' && read.value.mode === 'shadow';
      }, 5_000, 'policy di nuovo shadow');
    } finally {
      await cp.stop();
      await sql`UPDATE calendar_backend_state SET rebuild_required = false WHERE id = true AND rebuild_required`;
    }
  });

  test('LISTEN fallito all\'avvio: si ritenta dopo un giro riuscito', async () => {
    const dir = freshDir('relisten');
    let attempts = 0;
    // Il pool vero per le query, con un listen che fallisce la prima volta (DB giù al boot).
    const flakyDb = Object.assign(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inoltro del tag template di postgres-js
      (...args: any[]) => (sql as any)(...args),
      {
        begin: sql.begin.bind(sql),
        listen: async (channel: string, onnotify: (v: string) => void, onlisten?: () => void) => {
          attempts++;
          if (attempts === 1) throw new Error('connessione rifiutata');
          onlisten?.();
          return { state: {}, unlisten: async () => undefined, channel, onnotify };
        },
      },
    ) as unknown as Db;
    const cp = controlPlane({ dir, db: flakyDb, listen: true });
    try {
      await cp.start();
      await waitFor(() => attempts >= 1, 2_000, 'primo LISTEN');
      await cp.syncNow();
      await waitFor(() => cp.status().listening, 2_000, 'LISTEN ritentato');
      assert.equal(attempts, 2);
      await cp.syncNow();
      assert.equal(attempts, 2, 'nessun nuovo LISTEN quando è già attivo');
    } finally {
      await cp.stop();
    }
    assert.equal(cp.status().listening, false);
  });

  test('identità dal mount: ok → shadow con volume; marker diverso, assente o mount mancante → frozen', async () => {
    await inRolledBackTx(async (tx) => {
      await tx`UPDATE calendar_backend_state SET volume_id = ${VOLUME}::uuid, epoch = 1 WHERE id = true`;
      const dir = freshDir('ident-cp');
      const dataDir = freshDir('ident-data');
      writePrincipalProps(dataDir, marker(VOLUME.toUpperCase(), '1'));
      const cp = controlPlane({ dir, db: tx, identitySource: fileIdentitySource(dataDir) });
      try {
        const ok = await cp.syncNow();
        assert.equal(ok.identity?.status, 'ok', ok.identity?.detail ?? '');
        assert.equal(ok.policy?.mode, 'shadow');
        const hb = await readHeartbeatFile(join(dir, 'heartbeat.json'));
        assert.ok(hb.state === 'ok' && hb.value.epoch === 1, 'heartbeat con l\'epoch dello stato');
        const effective = await effectiveModeFromFiles({ policyFile: join(dir, 'policy.json'), heartbeatFile: join(dir, 'heartbeat.json'), principal: P });
        assert.equal(effective.mode, 'shadow');
        assert.equal(effective.volume_id, VOLUME);

        writePrincipalProps(dataDir, marker(VOLUME, '2'));
        const stale = await cp.syncNow();
        assert.equal(stale.identity?.status, 'mismatch');
        assert.deepEqual(stale.policy?.reasons, ['identity_mismatch']);

        writePrincipalProps(dataDir, marker(OTHER_VOLUME, '1'));
        assert.equal((await cp.syncNow()).identity?.status, 'mismatch');

        rmSync(principalPropsPath(dataDir, P));
        const absent = await cp.syncNow();
        assert.equal(absent.identity?.status, 'mismatch', 'volume vuoto: mai verità');

        rmSync(dataDir, { recursive: true, force: true });
        const unmounted = await cp.syncNow();
        assert.equal(unmounted.identity?.status, 'unverified');
        assert.deepEqual(unmounted.policy?.reasons, ['identity_unverified']);
        assert.equal(unmounted.ok, true, 'il heartbeat continua: la policy frozen riflette lo stato');
      } finally {
        await cp.stop();
      }
    });
  });
});

// ─── Identità ───────────────────────────────

describe('identità del volume dal file delle props (contratto §4.3)', () => {
  test('lettura del marker: assente, malformato, non JSON, valido (UUID normalizzato)', async () => {
    const missingDir = join(ROOT, 'non-esiste');
    assert.equal((await readVolumeMarkerFromFile(missingDir, P)).state, 'unreadable');
    const dataDir = freshDir('marker');
    assert.equal((await readVolumeMarkerFromFile(dataDir, P)).state, 'absent', 'principal assente');
    writePrincipalProps(dataDir, '{non json');
    assert.equal((await readVolumeMarkerFromFile(dataDir, P)).state, 'absent');
    writePrincipalProps(dataDir, marker(VOLUME, '01'));
    assert.equal((await readVolumeMarkerFromFile(dataDir, P)).state, 'absent', 'epoch con zero iniziale');
    writePrincipalProps(dataDir, { [DEAD_PROP.volumeId]: VOLUME });
    assert.equal((await readVolumeMarkerFromFile(dataDir, P)).state, 'absent', 'manca epoch');
    writePrincipalProps(dataDir, { ...marker(VOLUME.toUpperCase(), '7'), '{DAV:}displayname': 'Federico' });
    assert.deepEqual(await readVolumeMarkerFromFile(dataDir, P), { state: 'ok', marker: { volume_id: VOLUME, epoch: 7 } });
  });

  test('esito del confronto con lo stato', async () => {
    const dataDir = freshDir('check');
    writePrincipalProps(dataDir, marker(VOLUME, '1'));
    const source = fileIdentitySource(dataDir);
    const now = new Date('2027-01-04T08:00:00Z');
    assert.equal((await checkVolumeIdentity({ volume_id: null, epoch: 0 }, source, P, now)).status, 'uninitialized', 'epoch 0 in PG: qualunque volume');
    const ok = await checkVolumeIdentity({ volume_id: VOLUME, epoch: 1 }, source, P, now);
    assert.deepEqual(ok, { status: 'ok', source: 'file', marker: { volume_id: VOLUME, epoch: 1 }, detail: null, checkedAt: now.toISOString() });
    assert.equal((await checkVolumeIdentity({ volume_id: VOLUME, epoch: 2 }, source, P)).status, 'mismatch');
    assert.equal((await checkVolumeIdentity({ volume_id: OTHER_VOLUME, epoch: 1 }, source, P)).status, 'mismatch');
    assert.equal((await checkVolumeIdentity({ volume_id: VOLUME, epoch: 1 }, NO_IDENTITY_SOURCE, P)).status, 'unverified');
    const throwing: IdentitySource = { kind: 'remote', description: 'test', read: async () => { throw new Error('boom'); } };
    const failed = await checkVolumeIdentity({ volume_id: VOLUME, epoch: 1 }, throwing, P);
    assert.equal(failed.status, 'unverified');
    assert.equal(failed.detail, 'boom');
  });

  test('scelta della sorgente: file se il mount c\'è, altrimenti client, altrimenti nessuna', async () => {
    const dataDir = freshDir('source');
    assert.equal((await resolveIdentitySource('auto', dataDir, null)).kind, 'file');
    assert.equal((await resolveIdentitySource('auto', join(ROOT, 'assente'), null)).kind, 'none');
    assert.equal((await resolveIdentitySource('remote', dataDir, null)).kind, 'none');
    assert.equal((await resolveIdentitySource('file', join(ROOT, 'assente'), null)).kind, 'file');
  });
});

// ─── Configurazione e avvio dal processo API ───────────────────────────────

describe('configurazione da ambiente e avvio dal processo API (contratto §1.3)', () => {
  test('default del contratto', () => {
    const config = controlPlaneConfigFromEnv({});
    assert.deepEqual(config, {
      activation: 'auto',
      policyFile: '/run/caldes-control/policy.json',
      heartbeatFile: '/run/caldes-control/heartbeat.json',
      principal: 'federico',
      dataDir: '/radicale-data/collections',
      apiVersion: 'unversioned',
      identitySource: 'auto',
    });
  });

  test('valori invalidi rifiutati', () => {
    assert.throws(() => controlPlaneConfigFromEnv({ CALDES_CONTROL_PLANE: 'forse' }));
    assert.throws(() => controlPlaneConfigFromEnv({ RADICALE_PRINCIPAL: 'caldes-svc' }), /RADICALE_PRINCIPAL/);
    assert.throws(() => controlPlaneConfigFromEnv({ CALDES_POLICY_FILE: 'policy.json' }), /assoluto/);
    assert.throws(() => controlPlaneConfigFromEnv({ CALDES_POLICY_FILE: '/x/a.json', CALDES_HEARTBEAT_FILE: '/x/a.json' }), /coincidono/);
    assert.throws(() => controlPlaneConfigFromEnv({ CALDES_IDENTITY_SOURCE: 'dns' }));
  });

  test('api_version: esplicita ripulita, da sha di commit, altrimenti unversioned', () => {
    assert.equal(resolveApiVersion({ CALDES_API_VERSION: 'sha-1a2b3c4' }), 'sha-1a2b3c4');
    assert.equal(resolveApiVersion({ CALDES_API_VERSION: 'v 1.2' }), 'v-1.2');
    assert.equal(resolveApiVersion({ CALDES_API_VERSION: 'x'.repeat(80) }).length, 64);
    assert.equal(resolveApiVersion({ GIT_SHA: '1A2B3C4D5E6F' }), 'sha-1a2b3c4');
    assert.equal(resolveApiVersion({ SOURCE_COMMIT: 'non-uno-sha' }), 'unversioned');
  });

  test('avvio: off e auto senza volume non partono; on con il volume scrive policy e heartbeat e si ferma pulito', async () => {
    assert.equal(await startCalendarControlPlane({ CALDES_CONTROL_PLANE: 'off' }), null);
    assert.equal(await startCalendarControlPlane({ CALDES_POLICY_FILE: join(ROOT, 'assente', 'policy.json'), CALDES_HEARTBEAT_FILE: join(ROOT, 'assente', 'heartbeat.json') }), null);
    assert.equal(getCalendarControlPlane(), null);

    const dir = freshDir('process');
    const env = {
      CALDES_CONTROL_PLANE: 'auto',
      CALDES_POLICY_FILE: join(dir, 'policy.json'),
      CALDES_HEARTBEAT_FILE: join(dir, 'heartbeat.json'),
      RADICALE_DATA_DIR: join(ROOT, 'nessun-mount'),
      CALDES_API_VERSION: 'sha-proc001',
    };
    const instance = await startCalendarControlPlane(env);
    assert.ok(instance);
    assert.equal(await startCalendarControlPlane(env), instance, 'idempotente');
    try {
      const tick = await requestControlPlaneSync();
      assert.ok(tick?.ok, tick?.error ?? '');
      const hb = await readHeartbeatFile(join(dir, 'heartbeat.json'));
      assert.ok(hb.state === 'ok' && hb.value.api_version === 'sha-proc001');
      assert.equal((await readPolicyFile(join(dir, 'policy.json'), P)).state, 'ok');
      assert.match(instance.status().identitySource, /^none/);
    } finally {
      await stopCalendarControlPlane();
    }
    assert.equal(getCalendarControlPlane(), null);
    assert.equal(await requestControlPlaneSync(), null);
    assert.equal(instance.status().running, false);
  });

  test('writeHeartbeat: formato canonico del contratto', async () => {
    const dir = freshDir('hb');
    const state = (await readPolicyInputs(sql)).state;
    const hb = await writeHeartbeat(join(dir, 'heartbeat.json'), state, 'sha-abc1234', new Date('2027-01-04T08:00:30.123Z'));
    assert.equal(await readFile(join(dir, 'heartbeat.json'), 'utf8'), serializeControlFile(hb));
    assert.deepEqual(hb, { schema: 1, api_version: 'sha-abc1234', mode: 'postgres', epoch: 0, ts: '2027-01-04T08:00:30.123Z' });
  });
});
