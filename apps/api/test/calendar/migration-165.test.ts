/**
 * Migrazione 165 (strumento di migrazione, ledger a tre vie, coda dello shadow
 * mirror) della fase F3 del passaggio a Radicale. Riferimenti: design §4
 * (165), §13.1-§13.8, §16.2, §16.4, §16.6; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §3-§6 e i tipi condivisi
 * apps/api/src/lib/calendar/migration/types.ts.
 *
 * Cosa si verifica:
 *  - calendar_backend_state: colonne della 165 con i default, nessuna colonna
 *    globale dell'orizzonte (è per collezione nella 163), shadow fuori dalla
 *    policy (policy_version invariata), vincoli e lettura con
 *    normalizeMigrationState();
 *  - CHECK allineati alle costanti TS, nessuna FK verso il dominio o il
 *    business (il backup JSON svuota quelle tabelle senza CASCADE), tutte le
 *    tabelle nel gruppo S, nessuna colonna nuova in calendar_events e
 *    calendar_bookings, idempotenza del file;
 *  - run: un solo run attivo, chiave d'idempotenza unica, chiusura coerente,
 *    cascata delle righe, regole delle righe (azione solo per gli oggetti,
 *    livello solo per le differenze, accettazione solo delle differenze
 *    attese);
 *  - ledger con dati di forma produttiva (c con la serie infinita
 *    lun-mar-gio-ven, f con 91 festività e la chiusura "Ferie", proiezione in
 *    bookings, override staccato), unicità per href, per chiave viva e per
 *    UID vivo nella collezione, riga d'intento coerente, sopravvivenza alla
 *    cancellazione del calendario e rivalidazione dopo un import;
 *  - trigger dello shadow mirror: inerti con lo shadow spento, fuori da mode
 *    postgres, senza volume o con caldes.reverse_sync; con lo shadow attivo una
 *    sola chiave per oggetto (event:<master>, booking:<uid>), mai per le
 *    iscrizioni, coalescenza solo sui pending, cascate, colonne di
 *    calendar_bookings che contano.
 *
 * Gli scenari girano in transazioni sempre annullate.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { backupGroup } from '../../src/routes/backup';
import {
  APPLY_OUTCOMES,
  ITEM_SEVERITIES,
  LEDGER_INTENT_OPS,
  LEDGER_KINDS,
  MIGRATION_ITEM_TYPES,
  MIGRATION_RUN_KINDS,
  MIGRATION_RUN_STATUSES,
  MIGRATION_RUN_TRIGGERS,
  MIGRATION_STATE_COLUMNS,
  PLAN_ACTIONS,
  SHADOW_MIRROR_JOB_KIND,
  VERIFY_LEVELS,
  legacyKey,
  normalizeMigrationState,
  parseLegacyKey,
} from '../../src/lib/calendar/migration/types';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../database/migrations');
const MIGRATION_165 = readFileSync(resolve(MIGRATIONS_DIR, '165_calendar_migration.sql'), 'utf8');

const F3_TABLES = ['cal_migration_runs', 'cal_migration_items', 'cal_migration_ledger'];

useFixtures('migration-165', { resetBaseline: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tipo tx di postgres-js (stesso pattern di src/)
type Tx = any;

class Rollback extends Error {}

/** Esegue `fn` in una transazione e la annulla sempre. */
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx: Tx) => {
      await fn(tx);
      throw new Rollback('rollback voluto');
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

/** Esegue `fn` in un savepoint e verifica che fallisca con un errore che corrisponde a `pattern`. */
async function expectSqlError(tx: Tx, fn: (sp: Tx) => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown = null;
  try {
    await tx.savepoint(async (sp: Tx) => { await fn(sp); });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `atteso un errore che corrisponda a ${pattern}`);
  const e = caught as { message?: string; constraint_name?: string };
  assert.match(`${e.constraint_name ?? ''} ${e.message ?? ''}`, pattern);
}

/** Valori di `<colonna> = ANY (ARRAY[...])` dentro un CHECK letto dal catalogo. */
async function checkValues(table: string, constraint: string, column: string): Promise<string[]> {
  const [row] = await sql<Array<{ def: string }>>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = ${table}::regclass AND conname = ${constraint}
  `;
  assert.ok(row, `vincolo ${constraint} assente`);
  const m = new RegExp(`\\b${column} = ANY \\(ARRAY\\[([^\\]]+)\\]`).exec(row.def);
  assert.ok(m, `${constraint}: nessun elenco di valori per ${column} in ${row.def}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Calendario minimale con le sole colonne legacy (il trigger della 162 completa il sidecar). */
async function insertCalendar(tx: Tx, slug: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const [{ id }] = await tx`
    INSERT INTO calendars ${tx({ slug, name, ics_feed_token: `${slug}${'0'.repeat(32)}`.slice(0, 32), ...extra })}
    RETURNING id
  `;
  return id as string;
}

interface EventSpec {
  calendarId: string;
  uid: string;
  summary?: string;
  start: string;
  end: string;
  source?: string;
  sourceId?: string | null;
  rrule?: string | null;
  masterId?: string | null;
  recurrenceId?: string | null;
  status?: string;
  allDay?: boolean;
}

/** Riga legacy di calendar_events scritta come il codice di oggi (colonne esplicite). */
async function insertEvent(tx: Tx, e: EventSpec): Promise<string> {
  const [{ id }] = await tx`
    INSERT INTO calendar_events ${tx({
      calendar_id: e.calendarId,
      uid: e.uid,
      summary: e.summary ?? e.uid,
      start_time: e.start,
      end_time: e.end,
      all_day: e.allDay ?? false,
      rrule: e.rrule ?? null,
      recurrence_master_id: e.masterId ?? null,
      recurrence_id: e.recurrenceId ?? null,
      source: e.source ?? 'admin',
      source_id: e.sourceId ?? null,
      status: e.status ?? 'confirmed',
    })}
    RETURNING id
  `;
  return id as string;
}

/** Stato con il volume registrato e, a scelta, lo shadow acceso. */
async function setState(tx: Tx, opts: { shadow: boolean; mode?: string; volume?: boolean }): Promise<void> {
  const volume = opts.volume ?? true;
  await tx`
    UPDATE calendar_backend_state
    SET volume_id = ${volume ? randomUUID() : null}::uuid,
        epoch = ${volume ? 1 : 0},
        mode = ${opts.mode ?? 'postgres'},
        shadow_enabled = ${opts.shadow},
        shadow_since = ${opts.shadow ? new Date() : null}
    WHERE id
  `;
}

async function shadowJobs(tx: Tx, status: 'pending' | 'any' = 'pending'): Promise<Array<{ key: string; payload: Record<string, unknown>; source_version: string; status: string }>> {
  const rows = await tx`
    SELECT key, payload, source_version, status FROM cal_jobs
    WHERE kind = ${SHADOW_MIRROR_JOB_KIND} ${status === 'pending' ? tx`AND status = 'pending'` : tx``}
    ORDER BY key, id
  `;
  return Array.from(rows, (r: Record<string, unknown>) => ({ ...r }) as never);
}

async function shadowKeys(tx: Tx): Promise<string[]> {
  return (await shadowJobs(tx)).map((j) => j.key);
}

/** Chiude come 'done' i job shadow pending (simula il worker che li ha eseguiti). */
async function drainShadowJobs(tx: Tx): Promise<void> {
  await tx`
    UPDATE cal_jobs SET status = 'done', finished_at = now()
    WHERE kind = ${SHADOW_MIRROR_JOB_KIND} AND status = 'pending'
  `;
}

const HASH = `s1:${'a'.repeat(64)}`;
const FP = `v1:${'b'.repeat(64)}`;

interface LedgerSpec {
  calendarId: string;
  collection: string;
  href: string;
  kind?: string;
  key: string;
  uid?: string | null;
  written?: boolean;
  deleted?: boolean;
  extra?: Record<string, unknown>;
}

async function insertLedger(tx: Tx, l: LedgerSpec): Promise<string> {
  const written = l.written ?? !l.deleted;
  const [{ id }] = await tx`
    INSERT INTO cal_migration_ledger ${tx({
      calendar_id: l.calendarId,
      collection_name: l.collection,
      href: l.href,
      kind: l.kind ?? 'event',
      legacy_key: l.key,
      uid: l.uid === undefined ? l.href.replace(/\.ics$/, '') : l.uid,
      legacy_snapshot: written ? tx.json({ v: 1, kind: l.kind ?? 'event' }) : null,
      legacy_hash: written ? HASH : null,
      written_etag: written ? `"${l.href}-1"` : null,
      written_fingerprint: written ? FP : null,
      written_at: written ? new Date() : null,
      deleted_at: l.deleted ? new Date() : null,
      ...(l.extra ?? {}),
    })}
    RETURNING id
  `;
  return String(id);
}

// ─── Stato del backend ──────────────────────────────────────

describe('165: calendar_backend_state', () => {
  test('colonne della 165 con i default; nessuna colonna globale dell\'orizzonte', async () => {
    const cols = await sql<Array<{ column_name: string; column_default: string | null; is_nullable: string; data_type: string }>>`
      SELECT column_name, column_default, is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'calendar_backend_state'
    `;
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    for (const name of MIGRATION_STATE_COLUMNS) assert.ok(byName.has(name), `colonna ${name} assente`);
    assert.equal(byName.get('shadow_enabled')?.is_nullable, 'NO');
    assert.equal(byName.get('api_min_version')?.data_type, 'integer');
    assert.equal(byName.get('migration_declarations')?.data_type, 'jsonb');
    // L'orizzonte è per collezione (cal_collection_state, 163; f2-modules §13.1).
    assert.ok(!byName.has('horizon_start') && !byName.has('horizon_end'), 'horizon_start/end non vanno in calendar_backend_state');

    const [row] = await sql.unsafe(`SELECT ${MIGRATION_STATE_COLUMNS.join(', ')} FROM calendar_backend_state WHERE id`);
    const state = normalizeMigrationState(row);
    assert.equal(state.mode, 'postgres');
    assert.equal(state.shadow_enabled, false);
    assert.equal(state.shadow_since, null);
    assert.equal(state.cutover_at, null);
    assert.equal(state.rollback_until, null);
    assert.equal(state.finalized_at, null);
    assert.equal(state.api_min_version, 0);
    assert.equal(state.last_stack_backup, null);
    assert.deepEqual(state.migration_declarations, {});
  });

  test('lo shadow non entra nella policy: policy_version invariata; vincoli delle colonne nuove', async () => {
    await inRollback(async (tx) => {
      const [{ policy_version: before }] = await tx`SELECT policy_version FROM calendar_backend_state`;
      await setState(tx, { shadow: false });
      const [{ policy_version: withVolume }] = await tx`SELECT policy_version FROM calendar_backend_state`;
      assert.ok(withVolume > before, 'volume_id ed epoch cambiano la policy');
      await tx`
        UPDATE calendar_backend_state
        SET shadow_enabled = true, shadow_since = now(), api_min_version = 3,
            last_stack_backup = ${tx.json({ id: 'run-1', at: new Date().toISOString(), complete: true, volume_id: null, epoch: null, manifest_sha256: null })},
            migration_declarations = ${tx.json({ phase0: { value: { status: 'absent' }, at: new Date().toISOString(), by: 'admin:x' } })}
      `;
      const [{ policy_version: after }] = await tx`SELECT policy_version FROM calendar_backend_state`;
      assert.equal(after, withVolume, 'shadow, versione minima, backup e dichiarazioni non cambiano policy_version');

      await expectSqlError(tx, (sp) => sp`UPDATE calendar_backend_state SET shadow_since = NULL`, /calendar_backend_state_shadow_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE calendar_backend_state SET shadow_enabled = false`, /calendar_backend_state_shadow_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE calendar_backend_state SET api_min_version = -1`, /calendar_backend_state_api_min_version_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE calendar_backend_state SET migration_declarations = '[]'::jsonb`, /calendar_backend_state_declarations_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE calendar_backend_state SET last_stack_backup = '"x"'::jsonb`, /calendar_backend_state_last_backup_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE calendar_backend_state SET cutover_at = now()`, /calendar_backend_state_cutover_check/);
      await tx`UPDATE calendar_backend_state SET cutover_at = now(), cutover_by = 'admin:x'`;

      const [row] = await tx.unsafe(`SELECT ${MIGRATION_STATE_COLUMNS.join(', ')} FROM calendar_backend_state WHERE id`);
      const state = normalizeMigrationState(row);
      assert.equal(state.shadow_enabled, true);
      assert.ok(state.shadow_since instanceof Date);
      assert.equal(state.api_min_version, 3);
      assert.equal(state.last_stack_backup?.complete, true);
      assert.equal(state.migration_declarations.phase0?.value.status, 'absent');
      assert.equal(state.cutover_by, 'admin:x');
    });
  });
});

// ─── Schema ─────────────────────────────────────────────────

describe('165: vincoli allineati al contratto', () => {
  test('i CHECK hanno gli stessi valori delle costanti di migration/types.ts', async () => {
    assert.deepEqual(await checkValues('cal_migration_runs', 'cal_migration_runs_kind_check', 'kind'), [...MIGRATION_RUN_KINDS]);
    assert.deepEqual(await checkValues('cal_migration_runs', 'cal_migration_runs_status_check', 'status'), [...MIGRATION_RUN_STATUSES]);
    assert.deepEqual(await checkValues('cal_migration_runs', 'cal_migration_runs_trigger_check', 'trigger'), [...MIGRATION_RUN_TRIGGERS]);
    assert.deepEqual(await checkValues('cal_migration_items', 'cal_migration_items_type_check', 'item_type'), [...MIGRATION_ITEM_TYPES]);
    assert.deepEqual(await checkValues('cal_migration_items', 'cal_migration_items_action_check', 'action'), [...PLAN_ACTIONS]);
    assert.deepEqual(await checkValues('cal_migration_items', 'cal_migration_items_outcome_check', 'outcome'), [...APPLY_OUTCOMES]);
    assert.deepEqual(await checkValues('cal_migration_items', 'cal_migration_items_level_check', 'level'), [...VERIFY_LEVELS]);
    assert.deepEqual(await checkValues('cal_migration_items', 'cal_migration_items_severity_check', 'severity'), [...ITEM_SEVERITIES]);
    assert.deepEqual(await checkValues('cal_migration_ledger', 'cal_migration_ledger_kind_check', 'kind'), [...LEDGER_KINDS]);
    assert.deepEqual(await checkValues('cal_migration_ledger', 'cal_migration_ledger_intent_check', 'intent_op'), [...LEDGER_INTENT_OPS]);
  });

  test('nessuna FK verso il dominio o il business: solo item → run e run → run', async () => {
    const fks = await sql<Array<{ child: string; parent: string; name: string }>>`
      SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent, c.conname AS name
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(${F3_TABLES}::text[])
      ORDER BY 1, 2, 3
    `;
    assert.deepEqual(Array.from(fks, (r) => `${r.child}→${r.parent}`), [
      'cal_migration_items→cal_migration_runs',
      'cal_migration_runs→cal_migration_runs',
    ]);
    const incoming = await sql<Array<{ child: string }>>`
      SELECT c.conrelid::regclass::text AS child FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid::regclass::text = ANY(${F3_TABLES}::text[])
        AND NOT (c.conrelid::regclass::text = ANY(${F3_TABLES}::text[]))
    `;
    assert.deepEqual([...incoming], []);
  });

  test('tutte le tabelle della 165 sono nel gruppo S del backup JSON', () => {
    for (const table of F3_TABLES) assert.equal(backupGroup(`public.${table}`), 'state', table);
  });

  test('calendar_events e calendar_bookings: nessuna colonna nuova, solo i trigger dello shadow', async () => {
    const cols = await sql<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('calendar_events', 'calendar_bookings')
        AND (column_name LIKE 'caldes\\_%' OR column_name LIKE '%shadow%' OR column_name LIKE 'migration%')
    `;
    // Le sole colonne caldes_* sono quelle della guardia 166 (F4) su
    // calendar_events, ignorate dal codice legacy (colonne esplicite): la 165
    // non tocca le colonne delle tabelle legacy.
    assert.deepEqual(
      Array.from(cols, (c) => `${c.table_name}.${c.column_name}`).sort(),
      ['calendar_events.caldes_derived', 'calendar_events.caldes_object_id'],
      'la 165 non tocca le colonne delle tabelle legacy (i SELECT * del codice di oggi non cambiano forma)',
    );
    const triggers = await sql<Array<{ tgname: string; table: string }>>`
      SELECT tgname, tgrelid::regclass::text AS table FROM pg_trigger
      WHERE tgrelid IN ('calendar_events'::regclass, 'calendar_bookings'::regclass)
        AND NOT tgisinternal AND tgname LIKE '%shadow%'
      ORDER BY tgname
    `;
    assert.deepEqual(Array.from(triggers, (t) => `${t.table}.${t.tgname}`), [
      'calendar_bookings.calendar_bookings_shadow_enqueue',
      'calendar_events.calendar_events_shadow_enqueue',
      'calendar_events.calendar_events_shadow_enqueue_delete',
    ]);
  });

  test('idempotente: rieseguita su uno schema già migrato non fallisce e non cambia il catalogo', async () => {
    const catalog = async (tx: Tx) => ({
      relations: Array.from(await tx`
        SELECT c.relname, c.relkind, count(a.attname)::int AS columns
        FROM pg_class c
        LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relnamespace = 'public'::regnamespace AND (c.relname LIKE 'cal\\_migration%' OR c.relname = 'calendar_backend_state')
        GROUP BY c.relname, c.relkind ORDER BY c.relname
      `, (r: Record<string, unknown>) => ({ ...r })),
      constraints: Array.from(await tx`
        SELECT conrelid::regclass::text AS rel, conname FROM pg_constraint
        WHERE conrelid IN ('calendar_backend_state'::regclass, 'cal_migration_runs'::regclass,
                           'cal_migration_items'::regclass, 'cal_migration_ledger'::regclass)
        ORDER BY 1, 2
      `, (r: Record<string, unknown>) => ({ ...r })),
      triggers: Array.from(await tx`
        SELECT tgrelid::regclass::text AS rel, tgname FROM pg_trigger
        WHERE NOT tgisinternal AND (tgname LIKE '%shadow%' OR tgname LIKE 'cal\\_migration%')
        ORDER BY 1, 2
      `, (r: Record<string, unknown>) => ({ ...r })),
    });
    await inRollback(async (tx) => {
      const before = await catalog(tx);
      await tx.unsafe(MIGRATION_165);
      await tx.unsafe(MIGRATION_165);
      assert.deepEqual(await catalog(tx), before);
    });
  });
});

// ─── Run e righe ────────────────────────────────────────────

describe('165: cal_migration_runs e cal_migration_items', () => {
  test('un solo run attivo; chiave d\'idempotenza unica; chiusura coerente con lo stato', async () => {
    await inRollback(async (tx) => {
      const [first] = await tx`
        INSERT INTO cal_migration_runs (kind, requested_by, idempotency_key, request_hash)
        VALUES ('preflight', 'admin:test', 'chiave-0001', ${'c'.repeat(64)})
        RETURNING id
      `;
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by) VALUES ('plan', 'admin:test')`, /cal_migration_runs_single_active/);
      await tx`UPDATE cal_migration_runs SET status = 'running', started_at = now() WHERE id = ${first.id}`;
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by, status, started_at) VALUES ('plan', 'admin:test', 'running', now())`, /cal_migration_runs_single_active/);
      await expectSqlError(tx, (sp) => sp`UPDATE cal_migration_runs SET status = 'succeeded' WHERE id = ${first.id}`, /cal_migration_runs_finished_check/);
      await tx`UPDATE cal_migration_runs SET status = 'succeeded', finished_at = now(), summary = '{}'::jsonb WHERE id = ${first.id}`;

      // Concluso il primo, il successivo parte; la stessa chiave no.
      const [plan] = await tx`INSERT INTO cal_migration_runs (kind, requested_by) VALUES ('plan', 'admin:test') RETURNING id`;
      await tx`UPDATE cal_migration_runs SET status = 'cancelled', finished_at = now() WHERE id = ${plan.id}`;
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by, idempotency_key) VALUES ('inventory', 'admin:test', 'chiave-0001')`, /cal_migration_runs_idempotency_key/);

      // Valori fuori contratto.
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by) VALUES ('migra', 'admin:test')`, /cal_migration_runs_kind_check/);
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by, trigger) VALUES ('plan', 'admin:test', 'cron')`, /cal_migration_runs_trigger_check/);
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by, idempotency_key) VALUES ('plan', 'admin:test', 'corta')`, /cal_migration_runs_idempotency_key_check/);
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by, plan_hash) VALUES ('plan', 'admin:test', 'xyz')`, /cal_migration_runs_plan_hash_check/);
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by, error_code) VALUES ('plan', 'admin:test', 'minuscolo')`, /cal_migration_runs_error_code_check/);
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by, params) VALUES ('plan', 'admin:test', '[]'::jsonb)`, /cal_migration_runs_json_check/);
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_migration_runs (kind, requested_by, status) VALUES ('plan', 'admin:test', 'running')`, /cal_migration_runs_started_check/);
    });
  });

  test('apply legato all\'anteprima (SET NULL), righe in cascata, regole delle righe', async () => {
    await inRollback(async (tx) => {
      const [plan] = await tx`
        INSERT INTO cal_migration_runs (kind, requested_by, status, started_at, finished_at, plan_hash)
        VALUES ('plan', 'admin:test', 'succeeded', now(), now(), ${'d'.repeat(64)}) RETURNING id
      `;
      const [apply] = await tx`
        INSERT INTO cal_migration_runs (kind, requested_by, status, started_at, finished_at, plan_run_id, plan_hash)
        VALUES ('apply', 'admin:test', 'succeeded', now(), now(), ${plan.id}, ${'d'.repeat(64)}) RETURNING id
      `;
      const item = (sp: Tx, values: Record<string, unknown>) => sp`INSERT INTO cal_migration_items ${sp({ run_id: plan.id, seq: 0, ...values })}`;
      await item(tx, { seq: 0, item_type: 'object', calendar_id: randomUUID(), collection_name: 'c', href: 'a.ics', legacy_key: 'event:x', action: 'create' });
      await item(tx, { seq: 1, item_type: 'anomaly', code: 'DST_SHIFTED_EXCEPTION', severity: 'warning' });
      await item(tx, { seq: 2, item_type: 'diff', level: 'V3', expected: true, code: 'OCCURRENCE_TIME_DIFF', severity: 'warning', accepted_at: new Date(), accepted_by: 'admin:test' });
      await item(tx, { seq: 3, item_type: 'check', code: 'IDENTITY', severity: 'info' });

      await expectSqlError(tx, (sp) => item(sp, { seq: 0, item_type: 'check' }), /cal_migration_items_run_seq_key/);
      await expectSqlError(tx, (sp) => item(sp, { seq: 10, item_type: 'anomaly', action: 'create' }), /cal_migration_items_action_check/);
      await expectSqlError(tx, (sp) => item(sp, { seq: 10, item_type: 'object', action: 'migra' }), /cal_migration_items_action_check/);
      await expectSqlError(tx, (sp) => item(sp, { seq: 10, item_type: 'diff', expected: true }), /cal_migration_items_level_check/);
      await expectSqlError(tx, (sp) => item(sp, { seq: 10, item_type: 'anomaly', level: 'V1' }), /cal_migration_items_level_check/);
      await expectSqlError(tx, (sp) => item(sp, { seq: 10, item_type: 'diff', level: 'V1' }), /cal_migration_items_expected_check/);
      await expectSqlError(tx, (sp) => item(sp, { seq: 10, item_type: 'diff', level: 'V1', expected: false, accepted_at: new Date(), accepted_by: 'admin:test' }), /cal_migration_items_accepted_check/);
      await expectSqlError(tx, (sp) => item(sp, { seq: 10, item_type: 'anomaly', code: 'minuscolo' }), /cal_migration_items_code_check/);
      await expectSqlError(tx, (sp) => item(sp, { seq: 10, item_type: 'object', href: 'a/b.ics' }), /cal_migration_items_href_check/);
      await expectSqlError(tx, (sp) => item(sp, { seq: 10, item_type: 'anomaly', forced: true }), /cal_migration_items_forced_check/);

      await tx`DELETE FROM cal_migration_runs WHERE id = ${plan.id}`;
      const [{ items }] = await tx`SELECT count(*)::int AS items FROM cal_migration_items WHERE run_id = ${plan.id}`;
      assert.equal(items, 0, 'le righe seguono il run');
      const [after] = await tx`SELECT plan_run_id FROM cal_migration_runs WHERE id = ${apply.id}`;
      assert.equal(after.plan_run_id, null, 'l\'apply resta, senza il riferimento all\'anteprima cancellata dalla retention');
    });
  });
});

// ─── Ledger ─────────────────────────────────────────────────

describe('165: cal_migration_ledger', () => {
  test('dati di produzione: serie in c, 91 festività e la chiusura in f, proiezione in bookings, override staccato', async () => {
    await inRollback(async (tx) => {
      const c = await insertCalendar(tx, 'c', 'Creattivamente SRL');
      const f = await insertCalendar(tx, 'f', 'Festività e chiusure', { is_system: false });
      const [bookings] = await tx`SELECT id FROM calendars WHERE slug = 'bookings'`;
      const [sidecar] = await tx`SELECT collection_name, role FROM calendars WHERE id = ${f}`;
      assert.deepEqual({ ...sidecar }, { collection_name: 'f', role: 'holidays' });

      const series = randomUUID();
      await insertLedger(tx, { calendarId: c, collection: 'c', href: '2wsjr1bwyux7g3h1.ics', key: legacyKey('event', series) });
      // Override orfano della serie conclusa, staccato con UID proprio (Radicale: un UID per risorsa).
      const orphan = randomUUID();
      await insertLedger(tx, { calendarId: c, collection: 'c', href: 'wid8cx7g125ygr1v-det-1749538800.ics', kind: 'detached', key: legacyKey('detached', orphan) });
      for (let i = 0; i < 91; i++) {
        const date = new Date(Date.UTC(2026, 0, 1) + i * 4 * 86_400_000).toISOString().slice(0, 10);
        await insertLedger(tx, { calendarId: f, collection: 'f', href: `it-holiday-${date}.ics`, key: legacyKey('event', randomUUID()), uid: `holiday-${i}` });
      }
      await insertLedger(tx, { calendarId: f, collection: 'f', href: `closure-${randomUUID()}.ics`, key: legacyKey('event', randomUUID()), uid: 'ferie-2026' });
      const bookingUid = 'b4k9q2x7';
      await insertLedger(tx, {
        calendarId: bookings.id, collection: 'bookings', href: `booking-${bookingUid}.ics`, kind: 'booking',
        key: legacyKey('booking', bookingUid), uid: `${bookingUid}@caldes.it`, extra: { legacy_event_id: randomUUID() },
      });
      const counts = await tx`
        SELECT collection_name, kind, count(*)::int AS n FROM cal_migration_ledger
        WHERE deleted_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2
      `;
      assert.deepEqual(Array.from(counts, (r: Record<string, unknown>) => ({ ...r })), [
        { collection_name: 'bookings', kind: 'booking', n: 1 },
        { collection_name: 'c', kind: 'detached', n: 1 },
        { collection_name: 'c', kind: 'event', n: 1 },
        { collection_name: 'f', kind: 'event', n: 92 },
      ]);

      // Il ledger sopravvive alla cancellazione del calendario (nessuna FK):
      // la collezione resta in Radicale e la verifica la segnala.
      await tx`DELETE FROM calendars WHERE id = ${c}`;
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM cal_migration_ledger WHERE calendar_id = ${c}`;
      assert.equal(n, 2);
    });
  });

  test('un href per collezione, una chiave e un UID vivi per collezione; le righe ritirate li liberano', async () => {
    await inRollback(async (tx) => {
      const a = await insertCalendar(tx, 'tst-mig-a', 'A');
      const b = await insertCalendar(tx, 'tst-mig-b', 'B');
      const key = legacyKey('event', randomUUID());
      await insertLedger(tx, { calendarId: a, collection: 'tst-mig-a', href: 'x.ics', key });
      await expectSqlError(tx, (sp) => insertLedger(sp, { calendarId: a, collection: 'tst-mig-a', href: 'x.ics', key: legacyKey('event', randomUUID()), uid: 'altro' }), /cal_migration_ledger_href_key/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { calendarId: a, collection: 'tst-mig-a', href: 'y.ics', key, uid: 'y' }), /cal_migration_ledger_live_key/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { calendarId: a, collection: 'tst-mig-a', href: 'z.ics', key: legacyKey('event', randomUUID()), uid: 'x' }), /cal_migration_ledger_live_uid/);
      // Spostamento fra calendari: per un attimo la chiave vive in due collezioni.
      await insertLedger(tx, { calendarId: b, collection: 'tst-mig-b', href: 'x.ics', key });
      // Dopo la DELETE nella vecchia collezione la riga si ritira e libera chiave e UID.
      await tx`
        UPDATE cal_migration_ledger
        SET deleted_at = now(), written_etag = NULL, written_fingerprint = NULL, written_at = NULL,
            legacy_hash = NULL, legacy_snapshot = NULL
        WHERE calendar_id = ${a} AND href = 'x.ics'
      `;
      await insertLedger(tx, { calendarId: a, collection: 'tst-mig-a', href: 'w.ics', key, uid: 'x' });
    });
  });

  test('formato di chiave, hash e riga d\'intento coerente', async () => {
    await inRollback(async (tx) => {
      const a = await insertCalendar(tx, 'tst-mig-c', 'C');
      const base = { calendarId: a, collection: 'tst-mig-c' };
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, href: '1.ics', kind: 'event', key: `booking:${randomUUID()}` }), /cal_migration_ledger_legacy_key_check/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, href: '1.ics', kind: 'event', key: 'event:' }), /cal_migration_ledger_legacy_key_check/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, href: '1.ics', kind: 'evento', key: 'evento:1' }), /cal_migration_ledger_kind_check/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, href: 'a/b.ics', key: legacyKey('event', randomUUID()) }), /cal_migration_ledger_href_check/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, collection: '_canary', href: '1.ics', key: legacyKey('event', randomUUID()) }), /cal_migration_ledger_collection_check/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, href: '1.ics', key: legacyKey('event', randomUUID()), extra: { legacy_hash: 'sha:123' } }), /cal_migration_ledger_hash_check/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, href: '1.ics', key: legacyKey('event', randomUUID()), extra: { written_fingerprint: null } }), /cal_migration_ledger_written_check/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, href: '1.ics', key: legacyKey('event', randomUUID()), extra: { derived: true }, kind: 'booking' }), /cal_migration_ledger_legacy_key_check|cal_migration_ledger_derived_check/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, href: '1.ics', kind: 'booking', key: 'booking:u1', extra: { derived: true } }), /cal_migration_ledger_derived_check/);
      await expectSqlError(tx, (sp) => insertLedger(sp, { ...base, href: '1.ics', key: legacyKey('event', randomUUID()), deleted: true, written: true }), /cal_migration_ledger_deleted_check/);

      // Riga d'intento: prima della PUT di una creazione.
      const id = await insertLedger(tx, { ...base, href: 'nuovo.ics', key: legacyKey('event', randomUUID()), written: false });
      const run = randomUUID();
      await tx`
        UPDATE cal_migration_ledger
        SET intent_op = 'create', intent_fingerprint = ${FP}, intent_legacy_hash = ${HASH},
            intent_snapshot = ${tx.json({ v: 1, kind: 'event' })}, intent_at = now(), intent_run_id = ${run}
        WHERE id = ${id}
      `;
      await expectSqlError(tx, (sp) => sp`UPDATE cal_migration_ledger SET intent_at = NULL WHERE id = ${id}`, /cal_migration_ledger_intent_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE cal_migration_ledger SET intent_fingerprint = NULL WHERE id = ${id}`, /cal_migration_ledger_intent_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE cal_migration_ledger SET intent_op = 'replace' WHERE id = ${id}`, /cal_migration_ledger_intent_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE cal_migration_ledger SET intent_op = NULL, intent_at = NULL WHERE id = ${id}`, /cal_migration_ledger_intent_check/);
      // Esito della PUT: written_* aggiornati e intento azzerato nella stessa UPDATE.
      await tx`
        UPDATE cal_migration_ledger
        SET written_etag = '"nuovo-1"', written_fingerprint = intent_fingerprint, written_at = now(),
            legacy_hash = intent_legacy_hash, legacy_snapshot = intent_snapshot,
            intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL,
            intent_etag = NULL, intent_at = NULL, intent_run_id = NULL
        WHERE id = ${id}
      `;
      // Un intento di cancellazione non ha bisogno di fingerprint.
      await tx`UPDATE cal_migration_ledger SET intent_op = 'delete', intent_etag = '"nuovo-1"', intent_at = now() WHERE id = ${id}`;
      const [row] = await tx`SELECT intent_op, written_etag FROM cal_migration_ledger WHERE id = ${id}`;
      assert.deepEqual({ ...row }, { intent_op: 'delete', written_etag: '"nuovo-1"' });
    });
  });

  test('rivalidazione dopo un import: solo le righe vive, idempotente, motivo nel formato', async () => {
    await inRollback(async (tx) => {
      const a = await insertCalendar(tx, 'tst-mig-d', 'D');
      await insertLedger(tx, { calendarId: a, collection: 'tst-mig-d', href: 'vivo.ics', key: legacyKey('event', randomUUID()) });
      await insertLedger(tx, { calendarId: a, collection: 'tst-mig-d', href: 'ritirato.ics', key: legacyKey('event', randomUUID()), deleted: true });
      const [{ n: first }] = await tx`SELECT cal_migration_ledger_require_revalidation('backup-import') AS n`;
      assert.equal(first, 1);
      const [{ n: second }] = await tx`SELECT cal_migration_ledger_require_revalidation('identity-reassign') AS n`;
      assert.equal(second, 0, 'una riga già da rivalidare conserva il primo motivo');
      const rows = await tx`
        SELECT href, revalidate_reason, revalidate_since IS NOT NULL AS since
        FROM cal_migration_ledger WHERE calendar_id = ${a} ORDER BY href
      `;
      assert.deepEqual(Array.from(rows, (r: Record<string, unknown>) => ({ ...r })), [
        { href: 'ritirato.ics', revalidate_reason: null, since: false },
        { href: 'vivo.ics', revalidate_reason: 'backup-import', since: true },
      ]);
      await expectSqlError(tx, (sp) => sp`SELECT cal_migration_ledger_require_revalidation('Motivo Non Valido')`, /motivo di rivalidazione non valido/);
      await expectSqlError(tx, (sp) => sp`UPDATE cal_migration_ledger SET revalidate_since = NULL WHERE calendar_id = ${a}`, /cal_migration_ledger_revalidate_check/);
    });
  });

  test('chiavi legacy: costruzione e parsing di migration/types.ts', () => {
    assert.equal(legacyKey('event', 'abc'), 'event:abc');
    assert.deepEqual(parseLegacyKey('archive:collezione/evento:1.ics'), { kind: 'archive', id: 'collezione/evento:1.ics' });
    assert.equal(parseLegacyKey('evento:1'), null);
    assert.equal(parseLegacyKey('event:'), null);
    assert.throws(() => legacyKey('booking', ''), /vuoto/);
  });
});

// ─── Shadow mirror ──────────────────────────────────────────

describe('165: trigger dello shadow mirror', () => {
  test('chiave dell\'oggetto: proiezioni per uid, override col master, iscrizioni mai', async () => {
    const master = randomUUID();
    const own = randomUUID();
    const [row] = await sql`
      SELECT cal_shadow_event_key(${own}::uuid, NULL, 'admin', NULL) AS single,
             cal_shadow_event_key(${own}::uuid, ${master}::uuid, 'manual', NULL) AS override,
             cal_shadow_event_key(${own}::uuid, NULL, 'booking', ' b4k9 ') AS projection,
             cal_shadow_event_key(${own}::uuid, NULL, 'booking', NULL) AS projection_without_uid,
             cal_shadow_event_key(${own}::uuid, NULL, 'ics_pull', 'remoto') AS subscription,
             cal_shadow_event_key(${own}::uuid, NULL, 'system', 'it-holiday-2026-12-25') AS holiday
    `;
    assert.deepEqual({ ...row }, {
      single: `event:${own}`,
      override: `event:${master}`,
      projection: 'booking:b4k9',
      projection_without_uid: `event:${own}`,
      subscription: null,
      holiday: `event:${own}`,
    });
  });

  test('inerti con lo shadow spento, fuori da mode postgres, senza volume e con caldes.reverse_sync', async () => {
    await inRollback(async (tx) => {
      const [lavoro] = await tx`SELECT id FROM calendars WHERE slug = 'lavoro'`;
      const ev = (uid: string) => insertEvent(tx, { calendarId: lavoro.id, uid, start: '2027-03-01T09:00:00Z', end: '2027-03-01T10:00:00Z' });

      await setState(tx, { shadow: false });
      const id = await ev('tst-shadow-spento');
      await tx`UPDATE calendar_events SET summary = 'x' WHERE id = ${id}`;
      await tx`DELETE FROM calendar_events WHERE id = ${id}`;
      assert.deepEqual(await shadowKeys(tx), [], 'shadow spento');

      // Mode radicale: la guardia 166 (F4) rifiuta le scritture dirette; la
      // cascata della delete di un calendario passa e non accoda nulla (lo
      // shadow non esiste, c'è la proiezione inversa).
      const tmp = await insertCalendar(tx, 'tst-shadow-radicale', 'Shadow in radicale');
      await insertEvent(tx, { calendarId: tmp, uid: 'tst-shadow-radicale-ev', start: '2027-03-01T09:00:00Z', end: '2027-03-01T10:00:00Z' });
      await setState(tx, { shadow: true, mode: 'radicale' });
      await expectSqlError(tx, (sp) => insertEvent(sp, { calendarId: lavoro.id, uid: 'tst-shadow-radicale', start: '2027-03-01T09:00:00Z', end: '2027-03-01T10:00:00Z' }), /sola lettura/);
      await tx`DELETE FROM calendars WHERE id = ${tmp}`;
      assert.deepEqual(await shadowKeys(tx), [], 'mode radicale: lo shadow non esiste, c\'è la proiezione inversa (F4)');

      await setState(tx, { shadow: true, volume: false });
      await ev('tst-shadow-senza-volume');
      assert.deepEqual(await shadowKeys(tx), [], 'volume non registrato');

      await setState(tx, { shadow: true });
      await tx`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;
      await ev('tst-shadow-reverse');
      assert.deepEqual(await shadowKeys(tx), [], 'scritture della proiezione inversa');
      await tx`SELECT set_config('caldes.reverse_sync', 'off', true)`;
      await ev('tst-shadow-acceso');
      assert.equal((await shadowKeys(tx)).length, 1);
    });
  });

  test('shadow acceso: una chiave per oggetto, iscrizioni escluse, coalescenza solo sui pending, cascate', async () => {
    await inRollback(async (tx) => {
      await setState(tx, { shadow: true });
      const c = await insertCalendar(tx, 'tst-mig-shadow', 'Creattivamente SRL');
      const [bookings] = await tx`SELECT id FROM calendars WHERE slug = 'bookings'`;

      // Serie infinita lun-mar-gio-ven alle 09:00 Roma con un override.
      const master = await insertEvent(tx, {
        calendarId: c, uid: 'tst-2wsjr1bwyux7g3h1', summary: 'Gestione Creattivamente',
        start: '2026-08-10T07:00:00Z', end: '2026-08-10T08:00:00Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR',
      });
      await insertEvent(tx, {
        calendarId: c, uid: 'tst-2wsjr1bwyux7g3h1-ovr', start: '2026-08-11T08:00:00Z', end: '2026-08-11T09:00:00Z',
        masterId: master, recurrenceId: '2026-08-11T07:00:00Z',
      });
      // Iscrizione: mai nello shadow (la fonte è il feed remoto).
      await insertEvent(tx, { calendarId: c, uid: 'tst-remoto@example.test', start: '2026-08-12T07:00:00Z', end: '2026-08-12T08:00:00Z', source: 'ics_pull' });
      // Proiezione legacy di una prenotazione.
      const projection = await insertEvent(tx, {
        calendarId: bookings.id, uid: 'tst-proiezione', start: '2026-08-10T12:00:00Z', end: '2026-08-10T12:30:00Z',
        source: 'booking', sourceId: 'tstb4k9q2x7',
      });

      const jobs = await shadowJobs(tx);
      assert.deepEqual(jobs.map((j) => j.key), ['booking:tstb4k9q2x7', `event:${master}`]);
      const masterJob = jobs.find((j) => j.key === `event:${master}`)!;
      assert.deepEqual(masterJob.payload, { legacy_key: `event:${master}`, table: 'calendar_events', op: 'INSERT' });
      assert.match(masterJob.source_version, /^[0-9]+$/);
      const [timing] = await tx`
        SELECT run_after - now() AS delay, priority FROM cal_jobs WHERE kind = ${SHADOW_MIRROR_JOB_KIND} AND key = ${`event:${master}`}
      `;
      assert.equal(timing.priority, 100);
      assert.ok(String(timing.delay).startsWith('00:00:02'), `debounce di 2 s: ${String(timing.delay)}`);

      // Un job in esecuzione non assorbe la modifica: nasce un pending nuovo.
      await tx`
        UPDATE cal_jobs SET status = 'running', lease_token = gen_random_uuid(), locked_until = now() + interval '1 minute',
               attempts = 1, started_at = now()
        WHERE kind = ${SHADOW_MIRROR_JOB_KIND} AND key = ${`event:${master}`}
      `;
      await tx`UPDATE calendar_events SET summary = 'Gestione' WHERE id = ${master}`;
      const all = await shadowJobs(tx, 'any');
      assert.deepEqual(all.filter((j) => j.key === `event:${master}`).map((j) => j.status).sort(), ['pending', 'running']);

      // Cancellazione del master: la cascata sugli override resta una sola chiave pending.
      await tx`DELETE FROM calendar_events WHERE id = ${master}`;
      const afterDelete = (await shadowJobs(tx)).filter((j) => j.key === `event:${master}`);
      assert.equal(afterDelete.length, 1);
      assert.equal(afterDelete[0].payload.op, 'DELETE');

      // Spostamento della proiezione e cancellazione del calendario: chiavi giuste.
      await drainShadowJobs(tx);
      await tx`UPDATE calendar_events SET start_time = '2026-08-10T13:00:00Z', end_time = '2026-08-10T13:30:00Z' WHERE id = ${projection}`;
      assert.deepEqual(await shadowKeys(tx), ['booking:tstb4k9q2x7']);
      await drainShadowJobs(tx);
      const single = await insertEvent(tx, { calendarId: c, uid: 'tst-singolo', start: '2026-06-01T07:00:00Z', end: '2026-06-01T08:00:00Z' });
      await drainShadowJobs(tx);
      await tx`DELETE FROM calendars WHERE id = ${c}`;
      assert.deepEqual(await shadowKeys(tx), [`event:${single}`], 'la riga dell\'iscrizione cancellata in cascata non accoda nulla');
    });
  });

  test('calendar_bookings: accoda booking:<uid> solo per le colonne della proiezione', async () => {
    await inRollback(async (tx) => {
      await setState(tx, { shadow: true });
      const [type] = await tx`SELECT id FROM calendar_event_types ORDER BY created_at LIMIT 1`;
      assert.ok(type, 'nessun tipo di prenotazione seminato');
      const [booking] = await tx`
        INSERT INTO calendar_bookings (uid, event_type_id, status, attendee_name, attendee_email, start_time, end_time, location_type)
        VALUES ('tstbook165', ${type.id}, 'confirmed', 'Mario Rossi', 'mario@example.test',
                '2027-04-01T08:00:00Z', '2027-04-01T08:30:00Z', 'google_meet')
        RETURNING id
      `;
      assert.deepEqual(await shadowKeys(tx), ['booking:tstbook165']);
      await drainShadowJobs(tx);

      // Colonne che non cambiano la proiezione (motivo dell'annullamento, metadati): nulla.
      await tx`UPDATE calendar_bookings SET cancellation_reason = 'nota', source_metadata = '{"x": 1}'::jsonb WHERE id = ${booking.id}`;
      assert.deepEqual(await shadowKeys(tx), []);
      // Stato, orari, nome e telefono sì.
      const updates: Array<() => Promise<unknown>> = [
        () => tx`UPDATE calendar_bookings SET status = 'cancelled' WHERE id = ${booking.id}`,
        () => tx`UPDATE calendar_bookings SET attendee_phone = '+39 333 0000000' WHERE id = ${booking.id}`,
      ];
      for (const update of updates) {
        await update();
        assert.deepEqual(await shadowKeys(tx), ['booking:tstbook165']);
        await drainShadowJobs(tx);
      }
      await tx`DELETE FROM calendar_bookings WHERE id = ${booking.id}`;
      const [job] = await shadowJobs(tx);
      assert.equal(job.key, 'booking:tstbook165');
      assert.equal(job.payload.op, 'DELETE');
      assert.equal(job.payload.table, 'calendar_bookings');
    });
  });
});
