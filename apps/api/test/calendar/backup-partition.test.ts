/**
 * Backup JSON dell'admin con la partizione S/D/B (fase F1 del passaggio a
 * Radicale, piano T8; design §16.2; contratto control-plane §2-§3).
 *
 * - Piano del ripristino (funzione pura): gruppi delle tabelle, chiusura
 *   rispetto alle FK senza CASCADE, tabelle protette.
 * - Import di un backup v1 precedente alla 162 in mode postgres: ruoli e
 *   sidecar preservati, calendars in UPSERT (mai TRUNCATE né DELETE), righe
 *   assenti dal backup mantenute e segnalate, conflitti di slug risolti come
 *   nel ripristino su un database nuovo, stato e tabelle del gruppo S mai
 *   toccati, riconciliazione e guardia post-ripristino.
 * - Backup con il gruppo S alterato: mai ripristinato.
 * - Mode diverso da postgres: dominio calendario saltato (ripristino
 *   limitato), gruppo B ripristinato.
 * - Tabella protetta che referenzia una tabella da svuotare: 409, nulla cambia.
 * - Round-trip export → import → export identico.
 *
 * Come la verifica manuale fatta su una copia del database, qui l'import gira
 * sul database dei test (già una copia dedicata): ogni import riscrive tutto
 * il gruppo B con il contenuto appena esportato, quindi l'effetto netto è solo
 * quello delle modifiche fatte al file. Le "trappole" sono trigger ENABLE
 * ALWAYS, che scattano anche con session_replication_role = 'replica': provano
 * che le tabelle protette non ricevono TRUNCATE né DML durante il ripristino.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { databaseNow, onBeforeDatabaseClose, onDatabaseReady, sql } from '../helpers/db';
import { TEST_ENV } from '../helpers/env';
import { useFixtures } from '../helpers/fixtures';
import { api, type TestResponse } from '../helpers/http';
import type { Calendar, EventType } from '../../src/lib/calendar/types';
import {
  backupGroup,
  listForeignKeys,
  MISSING_IN_BACKUP,
  planRestore,
  RESTORE_GUARD_HOURS,
} from '../../src/routes/backup';

const fx = useFixtures('backup-partition', { resetBaseline: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- righe generiche dei backup
type Row = Record<string, any>;

interface BackupFile {
  version: number;
  generated_at: string;
  generator: string;
  tables: Record<string, Row[]>;
}

const CONFIRM = 'RIPRISTINA-DATABASE';

/** Tabella "di stato" creata dal test: prefisso cal_migration_ → gruppo S. */
const PROBE = 'public.cal_migration_tst_probe';
/** Tabella di stato che referenzia una tabella di business (caso 409). */
const BLOCKER = 'public.cal_migration_tst_block';
const TRIPWIRE = 'tst_backup_tripwire';
const TRIPWIRE_TABLES = [
  'public.calendars',
  'public.calendar_events',
  'public.calendar_subscriptions',
  'public.calendar_backend_state',
  PROBE,
];

/** Colonne aggiunte dalla 162: un backup precedente non le ha. */
const SIDECAR_162_COLUMNS = [
  'collection_name', 'role', 'origin', 'lifecycle', 'parent_calendar_id', 'device_visible',
  'components', 'dav_props', 'missing_since', 'needs_review', 'review_reason',
];
const SUBSCRIPTION_162_COLUMNS = ['collection_calendar_id', 'blocks_availability', 'device_visible'];

// ─── Scenario ────────────────────────────────────────────────

interface Scenario {
  holiday: Calendar;
  work: Calendar;
  tasks: Calendar;
  moved: Calendar;
  later: Calendar;
  bookingsId: string;
  eventType: EventType;
  workEventIds: string[];
}

let scenario!: Scenario;
let startedAt = '';
const preRestoreFiles = new Set<string>();

async function dropArtifacts(): Promise<void> {
  for (const table of TRIPWIRE_TABLES) {
    const [{ exists }] = await sql<Array<{ exists: boolean }>>`SELECT to_regclass(${table}) IS NOT NULL AS exists`;
    if (exists) await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIPWIRE} ON ${table}`);
  }
  await sql.unsafe(`DROP TABLE IF EXISTS ${BLOCKER}`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${PROBE}`);
  await sql.unsafe(`DROP FUNCTION IF EXISTS public.${TRIPWIRE}()`);
}

/** Stato del backend ai default di un database appena migrato (credential_epoch e policy_version restano: sono monotoni). */
async function resetBackendState(): Promise<void> {
  await sql`
    UPDATE calendar_backend_state
    SET mode = 'postgres', write_freeze = false, volume_id = NULL, epoch = 0,
        restore_guard_until = NULL, rebuild_required = false
    WHERE (mode, write_freeze, volume_id, epoch, restore_guard_until, rebuild_required)
          IS DISTINCT FROM ('postgres', false, NULL::uuid, 0, NULL::timestamptz, false)
  `;
  // Il rebuild richiesto dall'import precedente (nessun worker nei test).
  await sql`DELETE FROM cal_jobs WHERE kind = 'index_rebuild'`;
}

onDatabaseReady(async () => {
  startedAt = await databaseNow();
  await dropArtifacts();
  await resetBackendState();

  const holiday = await fx.holidayCalendar();
  await fx.holidays(holiday, { year: 2027, only: ['2027-01-01', '2027-12-25'] });

  const work = await fx.calendar({ key: 'lavoro-cliente', name: 'Lavoro cliente' });
  const workEvents = [
    await fx.event({ calendar: work, summary: 'Riunione', start_time: '2027-03-01T09:00:00.000Z', end_time: '2027-03-01T10:00:00.000Z' }),
    await fx.event({ calendar: work, summary: 'Sopralluogo', start_time: '2027-03-02T09:00:00.000Z', end_time: '2027-03-02T10:00:00.000Z' }),
  ];
  await fx.subscription({
    calendar: work,
    events: [{
      remote_uid: 'remoto-backup@example.test',
      summary: 'Evento esterno',
      description: null,
      location: null,
      url: null,
      start_time: '2027-03-03T10:00:00.000Z',
      end_time: '2027-03-03T11:00:00.000Z',
      all_day: false,
      rrule: null,
      exdates: [],
      recurrence_id: null,
      status: 'confirmed',
    }],
  });

  // Ruolo che le regole storiche non possono ricavare: con un TRUNCATE e un
  // reinserimento da un backup precedente alla 162 tornerebbe 'user'.
  const tasks = await fx.calendar({ key: 'attivita', name: 'Attività' });
  await sql`
    UPDATE calendars
    SET role = 'tasks', components = '{VTODO}', device_visible = false,
        dav_props = ${sql.json({ '{urn:calicchia:caldes}role': 'tasks', '{urn:calicchia:caldes}calendar-id': tasks.id })}
    WHERE id = ${tasks.id}::uuid
  `;

  const moved = await fx.calendar({ key: 'spostato', name: 'Spostato' });
  await fx.event({ calendar: moved, summary: 'Evento spostato', start_time: '2027-03-04T09:00:00.000Z', end_time: '2027-03-04T10:00:00.000Z' });
  const later = await fx.calendar({ key: 'dopo-backup', name: 'Dopo il backup' });
  await fx.event({ calendar: later, summary: 'Evento nuovo', start_time: '2027-03-05T09:00:00.000Z', end_time: '2027-03-05T10:00:00.000Z' });

  const [{ id: bookingsId }] = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM calendars WHERE slug = 'bookings'`;
  const eventType = await fx.eventType({ key: 'consulenza', title: 'Consulenza' });

  // Tabella del gruppo S con FK verso calendars ON DELETE CASCADE: un TRUNCATE
  // CASCADE di calendars (o un DELETE con i trigger accesi) la svuoterebbe.
  await sql.unsafe(`
    CREATE TABLE ${PROBE} (
      id SERIAL PRIMARY KEY,
      calendar_id UUID NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
      note TEXT NOT NULL
    )
  `);
  for (const id of [holiday.id, work.id, tasks.id, bookingsId]) {
    await sql.unsafe(`INSERT INTO ${PROBE} (calendar_id, note) VALUES ($1, 'sonda')`, [id]);
  }

  scenario = { holiday, work, tasks, moved, later, bookingsId, eventType, workEventIds: workEvents.map((e) => e.id) };
});

onBeforeDatabaseClose(async () => {
  await dropArtifacts();
  await resetBackendState();
  await sql`DELETE FROM audit_logs WHERE table_name = 'backup' AND created_at >= ${startedAt}::timestamptz`;
  for (const name of preRestoreFiles) rmSync(join(TEST_ENV.UPLOAD_DIR, 'backups', name), { force: true });
});

// ─── Utilità ─────────────────────────────────────────────────

async function exportBackup(): Promise<BackupFile> {
  const res = await api.get<BackupFile>('/api/backup/export', { auth: 'admin' });
  assert.equal(res.status, 200, res.text.slice(0, 500));
  assert.equal(res.json.version, 1);
  return res.json;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- risposta JSON della route
async function importBackup(file: unknown): Promise<TestResponse<any>> {
  const fd = new FormData();
  fd.append('file', new Blob([JSON.stringify(file)], { type: 'application/json' }), 'backup.json');
  fd.append('confirm', CONFIRM);
  const res = await api.post('/api/backup/import', { auth: 'admin', body: fd });
  if (res.json?.preRestoreBackup) preRestoreFiles.add(res.json.preRestoreBackup);
  return res;
}

/**
 * Trigger ENABLE ALWAYS (scattano anche in replica) che fanno fallire il
 * ripristino se tocca le tabelle indicate con gli eventi indicati. Rimossi
 * sempre alla fine.
 */
async function withTripwires<T>(specs: Array<{ table: string; events: string }>, fn: () => Promise<T>): Promise<T> {
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION public.${TRIPWIRE}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'trappola del test: % su %.% durante il ripristino', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END $$
  `);
  try {
    for (const { table, events } of specs) {
      await sql.unsafe(`CREATE TRIGGER ${TRIPWIRE} BEFORE ${events} ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION public.${TRIPWIRE}()`);
      await sql.unsafe(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${TRIPWIRE}`);
    }
    return await fn();
  } finally {
    for (const { table } of specs) await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIPWIRE} ON ${table}`);
  }
}

/**
 * Tabelle del gruppo S nate con l'indice e la coda dei lavori della F2
 * (migrazioni 163 e 164): esportate, mai ripristinate né toccate dall'import.
 */
const F2_STATE_TABLES = [
  'public.cal_booking_conflicts',
  'public.cal_collection_state',
  'public.cal_components',
  'public.cal_jobs',
  'public.cal_object_ids',
  'public.cal_object_versions',
  'public.cal_objects',
  'public.cal_occurrences',
];

/**
 * Unica scrittura ammessa sulle tabelle F2 del gruppo S: la richiesta di
 * rebuild dell'indice nella transazione dell'import (requestIndexRebuild,
 * contratto f2-modules §5.3): sync_token e dir_mtime_ns azzerati in
 * cal_collection_state (UPDATE) e il job index_rebuild accodato (INSERT, o
 * UPDATE del pending con la stessa chiave). Nessuna riga del backup entra mai.
 */
const F2_REBUILD_REQUEST_EVENTS: Readonly<Record<string, string>> = {
  'public.cal_collection_state': 'TRUNCATE OR INSERT OR DELETE',
  'public.cal_jobs': 'TRUNCATE OR DELETE',
};

/** Trappole del gruppo S e di calendars, valide in ogni modalità. */
const PROTECTED_ALWAYS = [
  { table: 'public.calendars', events: 'TRUNCATE OR DELETE' },
  { table: 'public.calendar_backend_state', events: 'TRUNCATE OR INSERT OR DELETE' },
  { table: PROBE, events: 'TRUNCATE OR INSERT OR UPDATE OR DELETE' },
  ...F2_STATE_TABLES.map((table) => ({ table, events: F2_REBUILD_REQUEST_EVENTS[table] ?? 'TRUNCATE OR INSERT OR UPDATE OR DELETE' })),
];

/** Job index_rebuild accodati dagli import (requestIndexRebuild). */
async function rebuildJobs(): Promise<Array<{ status: string; payload: Row }>> {
  return Array.from(await sql<Array<{ status: string; payload: Row }>>`
    SELECT status, payload FROM cal_jobs WHERE kind = 'index_rebuild' AND key = 'all' ORDER BY id
  `, (r) => ({ ...r }));
}

interface StateRow {
  mode: string;
  write_freeze: boolean;
  volume_id: string | null;
  epoch: number;
  credential_epoch: number;
  policy_version: number;
  restore_guard_until: Date | null;
  rebuild_required: boolean;
}

async function readState(): Promise<StateRow> {
  const [row] = await sql<StateRow[]>`
    SELECT mode, write_freeze, volume_id::text AS volume_id, epoch, credential_epoch, policy_version,
           restore_guard_until, rebuild_required
    FROM calendar_backend_state
  `;
  return { ...row };
}

/** Guardia attiva fino a circa now() + 48 h (orologio del database). */
async function assertRestoreGuard(state: StateRow): Promise<void> {
  assert.equal(state.rebuild_required, true);
  assert.ok(state.restore_guard_until, 'restore_guard_until non impostato');
  const [{ expected }] = await sql<Array<{ expected: Date }>>`
    SELECT now() + make_interval(hours => ${RESTORE_GUARD_HOURS}) AS expected
  `;
  const drift = Math.abs(state.restore_guard_until.getTime() - expected.getTime());
  assert.ok(drift < 5 * 60_000, `restore_guard_until fuori tolleranza: ${state.restore_guard_until.toISOString()}`);
}

/** Lo stato non è mai ripristinato: solo la guardia (e quindi policy_version) cambia. */
function assertStateUntouched(before: StateRow, after: StateRow): void {
  const { restore_guard_until: _g1, rebuild_required: _r1, policy_version: v1, ...restBefore } = before;
  const { restore_guard_until: _g2, rebuild_required: _r2, policy_version: v2, ...restAfter } = after;
  assert.deepEqual(restAfter, restBefore);
  assert.ok(v2 > v1, `policy_version non incrementata (${v1} → ${v2})`);
}

async function probeRows(): Promise<Row[]> {
  return Array.from(await sql.unsafe(`SELECT id, calendar_id::text AS calendar_id, note FROM ${PROBE} ORDER BY id`), (r) => ({ ...r }));
}

async function probeSequence(): Promise<Row> {
  const [row] = await sql.unsafe(`SELECT last_value::text AS last_value, is_called FROM public.cal_migration_tst_probe_id_seq`);
  return { ...row };
}

interface SidecarRow {
  id: string;
  slug: string;
  name: string;
  ics_feed_token: string;
  collection_name: string | null;
  role: string;
  origin: string;
  lifecycle: string;
  device_visible: boolean;
  components: string[];
  dav_props: Record<string, string>;
  needs_review: boolean;
  review_reason: string | null;
}

async function calendarsById(): Promise<Map<string, SidecarRow>> {
  const rows = await sql<SidecarRow[]>`
    SELECT id::text AS id, slug, name, ics_feed_token, collection_name, role, origin, lifecycle,
           device_visible, components, dav_props, needs_review, review_reason
    FROM calendars
  `;
  return new Map(rows.map((r) => [r.id, { ...r, components: [...r.components] }]));
}

async function eventCount(calendarId: string): Promise<number> {
  const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_events WHERE calendar_id = ${calendarId}::uuid`;
  return n;
}

/** Contenuto completo delle tabelle del dominio calendario, per confronti esatti. */
async function calendarDomainDump(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of ['calendars', 'calendar_events', 'calendar_subscriptions']) {
    const rows = await sql.unsafe(`SELECT to_jsonb(t)::text AS j FROM ${table} t ORDER BY id`);
    out[table] = rows.map((r) => r.j as string);
  }
  return out;
}

/** JSON con le chiavi ordinate: confronto delle righe indipendente dall'ordine delle chiavi. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Row)[k]]))
      : v,
  );
}

function multiset(rows: Row[]): string[] {
  return rows.map(canonical).sort();
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ─── Gruppi e piano (funzioni pure) ──────────────────────────

describe('partizione S/D/B', () => {
  test('gruppi: stato e derivati, dominio calendario, business', () => {
    for (const key of [
      'public.calendar_backend_state', 'public.schema_migrations', 'public.cal_jobs', 'public.cal_collection_state',
      'public.cal_objects', 'public.cal_components', 'public.cal_occurrences', 'public.cal_booking_conflicts',
      'public.cal_object_ids', 'public.cal_object_versions', 'public.cal_migration_runs',
      'public.cal_migration_ledger', 'public.cal_migration_items',
    ]) {
      assert.equal(backupGroup(key), 'state', key);
    }
    for (const key of ['public.calendars', 'public.calendar_events', 'public.calendar_events_legacy', 'public.calendar_subscriptions']) {
      assert.equal(backupGroup(key), 'calendar', key);
    }
    // Integrazione Cal.com (migrazione 023): prefisso cal_ ma dati di business.
    for (const key of [
      'public.cal_bookings', 'public.cal_sync_log', 'public.cal_webhook_logs', 'public.calendar_bookings',
      'public.calendar_event_types', 'public.caldav_app_passwords', 'public.audit_logs', 'auth.users',
    ]) {
      assert.equal(backupGroup(key), 'business', key);
    }
  });

  const live = [
    'public.calendars', 'public.calendar_events', 'public.calendar_subscriptions', 'public.calendar_backend_state',
    'public.schema_migrations', 'public.calendar_event_types', 'public.calendar_bookings',
    'public.calendar_booking_reminders', 'public.leads',
  ];
  const fks = [
    { name: 'events_calendar', child: 'public.calendar_events', parent: 'public.calendars' },
    { name: 'events_subscription', child: 'public.calendar_events', parent: 'public.calendar_subscriptions' },
    { name: 'events_master', child: 'public.calendar_events', parent: 'public.calendar_events' },
    { name: 'subscriptions_calendar', child: 'public.calendar_subscriptions', parent: 'public.calendars' },
    { name: 'calendars_parent', child: 'public.calendars', parent: 'public.calendars' },
    { name: 'bookings_type', child: 'public.calendar_bookings', parent: 'public.calendar_event_types' },
    { name: 'reminders_booking', child: 'public.calendar_booking_reminders', parent: 'public.calendar_bookings' },
    { name: 'bookings_lead', child: 'public.calendar_bookings', parent: 'public.leads' },
  ];

  test('mode postgres: calendars in UPSERT, eventi e iscrizioni con TRUNCATE senza CASCADE, S saltato', () => {
    const plan = planRestore({ liveTables: live, backupTables: live, restoreCalendar: true, foreignKeys: fks });
    assert.equal(plan.upsertCalendars, true);
    assert.ok(!plan.truncate.includes('public.calendars'));
    assert.ok(plan.truncate.includes('public.calendar_events'));
    assert.ok(plan.truncate.includes('public.calendar_subscriptions'));
    assert.deepEqual(plan.skippedState, ['public.calendar_backend_state', 'public.schema_migrations']);
    assert.deepEqual(plan.skippedCalendar, []);
    assert.deepEqual(plan.emptied, []);
    assert.deepEqual(plan.blocked, []);
  });

  test('mode diverso da postgres: il dominio calendario resta fuori dal TRUNCATE', () => {
    const plan = planRestore({ liveTables: live, backupTables: live, restoreCalendar: false, foreignKeys: fks });
    assert.equal(plan.upsertCalendars, false);
    assert.deepEqual(plan.skippedCalendar, ['public.calendar_events', 'public.calendar_subscriptions', 'public.calendars']);
    for (const key of plan.truncate) assert.equal(backupGroup(key), 'business', key);
    assert.ok(plan.truncate.includes('public.calendar_bookings'));
    assert.deepEqual(plan.blocked, []);
  });

  test('chiusura FK: chi referenzia una tabella svuotata viene svuotato, come faceva il CASCADE', () => {
    const plan = planRestore({
      liveTables: live,
      backupTables: ['public.calendar_event_types', 'public.calendar_subscriptions'],
      restoreCalendar: true,
      foreignKeys: fks,
    });
    assert.deepEqual(plan.insert, ['public.calendar_event_types', 'public.calendar_subscriptions']);
    assert.deepEqual(plan.emptied, ['public.calendar_booking_reminders', 'public.calendar_bookings', 'public.calendar_events']);
    assert.deepEqual(plan.truncate, [
      'public.calendar_booking_reminders', 'public.calendar_bookings', 'public.calendar_event_types',
      'public.calendar_events', 'public.calendar_subscriptions',
    ]);
  });

  test('tabelle protette che referenziano una tabella da svuotare: piano bloccato', () => {
    const extraFks = [
      ...fks,
      { name: 'conflicts_booking', child: 'public.cal_booking_conflicts', parent: 'public.calendar_bookings' },
      { name: 'events_booking', child: 'public.calendar_events', parent: 'public.calendar_bookings' },
      { name: 'external_type', child: 'storage.objects', parent: 'public.calendar_event_types' },
    ];
    const tables = [...live, 'public.cal_booking_conflicts'];
    const plan = planRestore({ liveTables: tables, backupTables: tables, restoreCalendar: false, foreignKeys: extraFks });
    assert.deepEqual(
      plan.blocked.map((b) => `${b.referencedBy}→${b.table}`).sort(),
      ['public.cal_booking_conflicts→public.calendar_bookings', 'public.calendar_events→public.calendar_bookings', 'storage.objects→public.calendar_event_types'],
    );
    // In mode postgres calendar_events si ripristina: non blocca più.
    const pg = planRestore({ liveTables: tables, backupTables: tables, restoreCalendar: true, foreignKeys: extraFks });
    assert.deepEqual(pg.blocked.map((b) => b.referencedBy).sort(), ['public.cal_booking_conflicts', 'storage.objects']);
  });

  test('tabelle sconosciute e gruppo S non presente nel database', () => {
    const plan = planRestore({
      liveTables: live,
      backupTables: ['public.tabella_futura', 'public.cal_objects', 'public.calendar_event_types'],
      restoreCalendar: true,
      foreignKeys: fks,
    });
    assert.deepEqual(plan.unknown, ['public.tabella_futura']);
    assert.deepEqual(plan.skippedState, ['public.cal_objects']);
  });

  test('schema reale: nessuna tabella protetta referenzia una tabella di business, D chiuso rispetto alle FK', async () => {
    const tables = (await sql<Array<{ key: string }>>`
      SELECT n.nspname || '.' || c.relname AS key
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    `).map((r) => r.key);
    const foreignKeys = await listForeignKeys();
    for (const restoreCalendar of [true, false]) {
      const plan = planRestore({ liveTables: tables, backupTables: tables, restoreCalendar, foreignKeys });
      assert.deepEqual(plan.blocked, [], `mode ${restoreCalendar ? 'postgres' : 'radicale'}`);
      assert.deepEqual(plan.unknown, []);
      assert.ok(!plan.truncate.includes('public.calendars'));
      for (const key of plan.truncate) assert.notEqual(backupGroup(key), 'state', key);
      if (!restoreCalendar) for (const key of plan.truncate) assert.equal(backupGroup(key), 'business', key);
    }
    // Le tabelle Cal.com con prefisso cal_ esistono e restano nel gruppo B.
    for (const key of ['public.cal_bookings', 'public.cal_sync_log', 'public.cal_webhook_logs']) {
      if (tables.includes(key)) assert.equal(backupGroup(key), 'business', key);
    }
  });
});

// ─── Import end-to-end ───────────────────────────────────────

describe('import del backup JSON', () => {
  test('backup v1 precedente alla 162 in mode postgres: ruoli preservati, nessun TRUNCATE su calendars, S intatto', async () => {
    await resetBackendState();
    // Il calendario creato dopo il backup è anche quello di default: il
    // backup assegna di nuovo il default a 'lavoro' e la riga mantenuta lo cede.
    // (L'indice UNIQUE sul default si controlla riga per riga: due UPDATE.)
    const setDefault = async (where: 'later' | 'lavoro') => {
      await sql`UPDATE calendars SET is_default = false WHERE is_default`;
      if (where === 'later') await sql`UPDATE calendars SET is_default = true WHERE id = ${scenario.later.id}::uuid`;
      else await sql`UPDATE calendars SET is_default = true WHERE slug = 'lavoro'`;
    };
    await setDefault('later');
    try {
      await importPre162Backup();
    } finally {
      const [{ ok }] = await sql<Array<{ ok: boolean }>>`
        SELECT coalesce(bool_and(slug = 'lavoro'), false) AS ok FROM calendars WHERE is_default
      `;
      if (!ok) await setDefault('lavoro');
    }
  });

  async function importPre162Backup(): Promise<void> {
    const exported = await exportBackup();

    // Backup "come prima della 162": niente colonne del sidecar, nessuna
    // tabella di stato, ledger senza la 162.
    const file = clone(exported);
    for (const key of Object.keys(file.tables)) {
      if (backupGroup(key) === 'state' && key !== 'public.schema_migrations') delete file.tables[key];
    }
    file.tables['public.schema_migrations'] = file.tables['public.schema_migrations']
      .filter((r) => r.version !== '162_calendar_sidecar.sql');
    for (const row of file.tables['public.calendars']) for (const col of SIDECAR_162_COLUMNS) delete row[col];
    for (const row of file.tables['public.calendar_subscriptions']) for (const col of SUBSCRIPTION_162_COLUMNS) delete row[col];

    const { work, moved, later, tasks, holiday, bookingsId } = scenario;
    // Contenuto del backup diverso dal database: nome cambiato, un evento in
    // meno, un calendario creato dopo il backup, uno ricreato con un altro id
    // (stesso slug e stesso token: come i calendari seminati di un database nuovo).
    file.tables['public.calendars'].find((r) => r.id === work.id)!.name = fx.name('Lavoro cliente (backup)');
    file.tables['public.calendar_events'] = file.tables['public.calendar_events']
      .filter((r) => r.id !== scenario.workEventIds[1] && r.calendar_id !== later.id);
    file.tables['public.calendars'] = file.tables['public.calendars'].filter((r) => r.id !== later.id);
    for (const row of file.tables['public.calendars']) row.is_default = row.slug === 'lavoro';
    const movedNewId = '00000000-0000-4000-8000-00000000b162';
    file.tables['public.calendars'].find((r) => r.id === moved.id)!.id = movedNewId;
    for (const ev of file.tables['public.calendar_events']) if (ev.calendar_id === moved.id) ev.calendar_id = movedNewId;

    const before = await calendarsById();
    const stateBefore = await readState();
    const probeBefore = await probeRows();
    const seqBefore = await probeSequence();

    const res = await withTripwires(PROTECTED_ALWAYS, () => importBackup(file));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.skipped, { state: ['public.schema_migrations'], calendar: [] });
    assert.equal(res.json.calendar.mode, 'postgres');
    assert.equal(res.json.calendar.restored, true);
    assert.equal(res.json.calendar.updated, file.tables['public.calendars'].length - 1);
    assert.equal(res.json.calendar.inserted, 1);

    const after = await calendarsById();

    // Ruoli e sidecar delle righe del backup: invariati (UPSERT sulle sole
    // colonne del backup). Con TRUNCATE + reinserimento 'attivita' tornerebbe
    // user, visibile, VEVENT e senza dead prop.
    for (const id of [holiday.id, work.id, tasks.id, bookingsId]) {
      const b = before.get(id)!;
      const a = after.get(id)!;
      for (const col of ['collection_name', 'role', 'origin', 'lifecycle', 'device_visible', 'components', 'dav_props', 'needs_review', 'review_reason'] as const) {
        assert.deepEqual(a[col], b[col], `${b.slug}.${col}`);
      }
    }
    assert.equal(after.get(holiday.id)!.role, 'holidays');
    assert.equal(after.get(bookingsId)!.role, 'bookings');
    assert.equal(after.get(tasks.id)!.role, 'tasks');
    assert.deepEqual(after.get(tasks.id)!.components, ['VTODO']);
    assert.equal(after.get(tasks.id)!.device_visible, false);
    assert.equal(after.get(tasks.id)!.dav_props['{urn:calicchia:caldes}role'], 'tasks');
    // Colonne presenti nel backup: ripristinate.
    assert.equal(after.get(work.id)!.name, fx.name('Lavoro cliente (backup)'));

    // Calendario creato dopo il backup: mantenuto, segnalato, eventi sostituiti.
    const keptLater = after.get(later.id)!;
    assert.ok(keptLater, 'calendario assente dal backup cancellato');
    assert.equal(keptLater.slug, later.slug);
    assert.equal(keptLater.collection_name, later.slug);
    assert.equal(keptLater.needs_review, true);
    assert.equal(keptLater.review_reason, MISSING_IN_BACKUP);
    assert.equal(await eventCount(later.id), 0);

    // Stesso calendario con un altro id nel backup: la riga del backup prende
    // slug, token e nome di collezione; quella vecchia cede tutto e resta.
    const oldMoved = after.get(moved.id)!;
    const newMoved = after.get(movedNewId)!;
    assert.ok(newMoved, 'calendario del backup con id nuovo non inserito');
    assert.equal(newMoved.slug, moved.slug);
    assert.equal(newMoved.ics_feed_token, moved.ics_feed_token);
    assert.equal(newMoved.collection_name, moved.slug);
    assert.equal(newMoved.role, 'user');
    assert.equal(newMoved.origin, 'admin');
    assert.equal(newMoved.needs_review, false);
    assert.equal(await eventCount(movedNewId), 1);
    const id8 = moved.id.replace(/-/g, '').slice(0, 8);
    assert.equal(oldMoved.slug, `${moved.slug}-${id8}`);
    assert.equal(oldMoved.collection_name, oldMoved.slug);
    assert.notEqual(oldMoved.ics_feed_token, moved.ics_feed_token);
    assert.match(oldMoved.ics_feed_token, /^[0-9a-z]{32}$/);
    assert.equal(oldMoved.needs_review, true);
    assert.equal(oldMoved.review_reason, MISSING_IN_BACKUP);
    assert.equal(await eventCount(moved.id), 0);

    const kept = [...res.json.calendar.kept].sort((a: Row, b: Row) => a.slug.localeCompare(b.slug));
    assert.deepEqual(kept, [
      { id: later.id, slug: later.slug },
      {
        id: moved.id,
        slug: `${moved.slug}-${id8}`,
        previous_slug: moved.slug,
        feed_token_regenerated: true,
        released_collection_name: moved.slug,
      },
    ].sort((a, b) => a.slug.localeCompare(b.slug)));
    assert.deepEqual(
      [...res.json.calendar.reconciled].map((r: Row) => `${r.calendar_id}:${r.field}:${r.new_value}`).sort(),
      [`${movedNewId}:collection_name:${moved.slug}`, `${moved.id}:collection_name:${moved.slug}-${id8}`].sort(),
    );
    assert.equal(res.json.warnings.length, 1);
    assert.match(res.json.warnings[0], /2 calendari assenti dal backup sono stati mantenuti e segnalati da rivedere: restano vuoti/);

    // Un solo default: quello del backup.
    const defaults = await sql<Array<{ slug: string }>>`SELECT slug FROM calendars WHERE is_default`;
    assert.deepEqual(defaults.map((r) => r.slug), ['lavoro']);

    // Eventi e iscrizioni: esattamente quelli del backup.
    // 'lavoro-cliente': la riunione e l'evento dell'iscrizione; il sopralluogo non è nel backup.
    assert.equal(await eventCount(work.id), 2);
    const [{ n: removed }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM calendar_events WHERE id = ${scenario.workEventIds[1]}::uuid
    `;
    assert.equal(removed, 0);
    const [{ n: totalEvents }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_events`;
    assert.equal(totalEvents, file.tables['public.calendar_events'].length);
    const subs = await sql`SELECT calendar_id::text AS calendar_id, blocks_availability, device_visible, collection_calendar_id FROM calendar_subscriptions`;
    assert.deepEqual(Array.from(subs, (r) => ({ ...r })), [
      { calendar_id: work.id, blocks_availability: false, device_visible: false, collection_calendar_id: null },
    ]);

    // Gruppo S: stato, sonda e ledger mai toccati.
    const stateAfter = await readState();
    assertStateUntouched(stateBefore, stateAfter);
    await assertRestoreGuard(stateAfter);
    assert.equal(res.json.calendar.rebuild_required, true);
    assert.equal(res.json.calendar.restore_guard_until, stateAfter.restore_guard_until!.toISOString());
    // Rebuild richiesto nella stessa transazione (contratto f2-modules §5.3), non solo il flag per l'auditor delle 4.
    assert.deepEqual((await rebuildJobs()).map((j) => [j.status, j.payload.reason]), [['pending', 'backup-import']]);
    assert.deepEqual(await probeRows(), probeBefore);
    assert.deepEqual(await probeSequence(), seqBefore);
    const [{ n: ledger162 }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM schema_migrations WHERE version = '162_calendar_sidecar.sql'
    `;
    assert.equal(ledger162, 1);

    // Audit dell'import con il riassunto del calendario.
    const [audit] = await sql<Array<{ metadata: Row }>>`
      SELECT metadata FROM audit_logs WHERE table_name = 'backup' AND action = 'IMPORT'
      ORDER BY created_at DESC LIMIT 1
    `;
    assert.equal(audit.metadata.calendar.restored, true);
    assert.equal(audit.metadata.calendar.kept.length, 2);
    assert.deepEqual(audit.metadata.skipped, { state: ['public.schema_migrations'], calendar: [] });
  }

  test('gruppo S presente e alterato nel backup: mai ripristinato', async () => {
    await resetBackendState();
    const file = clone(await exportBackup());
    const [stateRow] = file.tables['public.calendar_backend_state'];
    Object.assign(stateRow, {
      mode: 'radicale',
      volume_id: '11111111-2222-4333-8444-555555555555',
      epoch: 9,
      credential_epoch: 0,
      policy_version: 1,
      write_freeze: true,
    });
    file.tables[PROBE] = [
      ...file.tables[PROBE].map((r) => ({ ...r, note: 'alterata' })),
      { id: 999, calendar_id: scenario.work.id, note: 'in più' },
    ];
    file.tables['public.schema_migrations'] = file.tables['public.schema_migrations'].slice(0, 3);
    // Backup successivo alla 162: le colonne del sidecar presenti si ripristinano.
    file.tables['public.calendars'].find((r) => r.id === scenario.work.id)!.dav_props = {
      '{http://apple.com/ns/ical/}calendar-color': '#112233FF',
    };

    const stateBefore = await readState();
    const probeBefore = await probeRows();
    const [{ n: ledgerBefore }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM schema_migrations`;

    const res = await withTripwires(PROTECTED_ALWAYS, () => importBackup(file));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.skipped.state, ['public.calendar_backend_state', PROBE, 'public.schema_migrations', ...F2_STATE_TABLES].sort());
    assert.deepEqual(res.json.calendar.kept, []);

    const stateAfter = await readState();
    assertStateUntouched(stateBefore, stateAfter);
    assert.equal(stateAfter.mode, 'postgres');
    assert.equal(stateAfter.epoch, 0);
    await assertRestoreGuard(stateAfter);
    assert.deepEqual(await probeRows(), probeBefore);
    const [{ n: ledgerAfter }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM schema_migrations`;
    assert.equal(ledgerAfter, ledgerBefore);
    const after = await calendarsById();
    assert.deepEqual(after.get(scenario.work.id)!.dav_props, { '{http://apple.com/ns/ical/}calendar-color': '#112233FF' });
  });

  test('mode diverso da postgres: dominio calendario saltato con avviso, business ripristinato', async () => {
    await resetBackendState();
    await sql`
      UPDATE calendar_backend_state
      SET mode = 'radicale', volume_id = '7b2f4c1e-9d3a-4e8b-a6f0-1c2d3e4f5a6b', epoch = 1
    `;
    try {
      const file = clone(await exportBackup());
      file.tables['public.calendars'].find((r) => r.id === scenario.work.id)!.name = fx.name('Nome dal backup');
      file.tables['public.calendar_events'] = file.tables['public.calendar_events'].slice(1);
      file.tables['public.calendar_subscriptions'] = [];
      file.tables['public.calendar_event_types'].find((r) => r.id === scenario.eventType.id)!.title = fx.name('Consulenza dal backup');

      const domainBefore = await calendarDomainDump();
      const stateBefore = await readState();
      const res = await withTripwires(
        [
          ...PROTECTED_ALWAYS.filter((s) => s.table !== 'public.calendars'),
          { table: 'public.calendars', events: 'TRUNCATE OR INSERT OR UPDATE OR DELETE' },
          { table: 'public.calendar_events', events: 'TRUNCATE OR INSERT OR UPDATE OR DELETE' },
          { table: 'public.calendar_subscriptions', events: 'TRUNCATE OR INSERT OR UPDATE OR DELETE' },
        ],
        () => importBackup(file),
      );
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.skipped.calendar, ['public.calendar_events', 'public.calendar_subscriptions', 'public.calendars']);
      assert.equal(res.json.calendar.mode, 'radicale');
      assert.equal(res.json.calendar.restorable, false);
      assert.equal(res.json.calendar.restored, false);
      assert.equal(res.json.warnings.length, 1);
      assert.match(res.json.warnings[0], /NON sono stati ripristinati/);
      assert.match(res.json.warnings[0], /radicale/);
      assert.match(res.json.warnings[0], /ripristino coordinato/);

      assert.deepEqual(await calendarDomainDump(), domainBefore);
      const [type] = await sql<Array<{ title: string }>>`SELECT title FROM calendar_event_types WHERE id = ${scenario.eventType.id}::uuid`;
      assert.equal(type.title, fx.name('Consulenza dal backup'));

      const stateAfter = await readState();
      assertStateUntouched(stateBefore, stateAfter);
      assert.equal(stateAfter.mode, 'radicale');
      await assertRestoreGuard(stateAfter);

      const info = await api.get('/api/backup/info', { auth: 'admin' });
      assert.equal(info.status, 200);
      assert.equal(info.json.calendar.mode, 'radicale');
      assert.equal(info.json.calendar.restorable, false);
      assert.equal(info.json.calendar.rebuild_required, true);
      assert.equal(info.json.tables.find((t: Row) => t.table === 'calendar_backend_state').group, 'state');
      assert.equal(info.json.tables.find((t: Row) => t.table === 'calendars').group, 'calendar');
    } finally {
      await resetBackendState();
    }
  });

  test('tabella di stato che referenzia una tabella da svuotare: 409 e database invariato', async () => {
    await resetBackendState();
    await sql.unsafe(`
      CREATE TABLE ${BLOCKER} (
        id SERIAL PRIMARY KEY,
        event_type_id UUID REFERENCES public.calendar_event_types(id)
      )
    `);
    try {
      const file = clone(await exportBackup());
      file.tables['public.calendar_event_types'].find((r) => r.id === scenario.eventType.id)!.title = 'mai applicato';
      const stateBefore = await readState();
      const res = await importBackup(file);
      assert.equal(res.status, 409, res.text);
      assert.deepEqual(res.json.blocked.map((b: Row) => `${b.referencedBy}→${b.table}`), [`${BLOCKER}→public.calendar_event_types`]);
      assert.match(res.json.error, /NON è stato modificato/);
      const [type] = await sql<Array<{ title: string }>>`SELECT title FROM calendar_event_types WHERE id = ${scenario.eventType.id}::uuid`;
      assert.notEqual(type.title, 'mai applicato');
      assert.deepEqual(await readState(), stateBefore);
    } finally {
      await sql.unsafe(`DROP TABLE IF EXISTS ${BLOCKER}`);
    }
  });

  test('app-password: una revoca successiva al backup resta, le password tolte invalidano le cache (credential_epoch + 1)', async () => {
    await resetBackendState();
    const verify = (username: string, password: string) =>
      api.post('/api/caldav-backend/verify-credentials', { auth: { caldavService: true }, body: { username, password } });

    const stolen = await fx.appPassword({ username: 'iphone', device: 'iPhone rubato' });
    assert.equal((await verify('iphone', stolen.password)).status, 200);
    const file = await exportBackup();

    // Dopo l'export: revoca del telefono rubato (epoch + 1) e un device nuovo.
    const revoke = await api.delete(`/api/caldav-tokens/${stolen.row.id}`, { auth: 'admin' });
    assert.equal(revoke.status, 200, revoke.text);
    assert.equal((await verify('iphone', stolen.password)).status, 401);
    const [{ revoked_at: revokedAt }] = await sql<Array<{ revoked_at: Date }>>`
      SELECT revoked_at FROM caldav_app_passwords WHERE id = ${stolen.row.id}::uuid
    `;
    const fresh = await fx.appPassword({ username: 'federico', device: 'Mac nuovo' });
    assert.equal((await verify('federico', fresh.password)).status, 200);
    const stateBefore = await readState();

    const res = await withTripwires(PROTECTED_ALWAYS, () => importBackup(file));
    assert.equal(res.status, 200, res.text);

    // La revoca resta, con data e motivo originali: il backup non la annulla.
    const [row] = await sql<Array<{ is_active: boolean; revoked_at: Date | null; revoked_reason: string | null }>>`
      SELECT is_active, revoked_at, revoked_reason FROM caldav_app_passwords WHERE id = ${stolen.row.id}::uuid
    `;
    assert.equal(row.is_active, false);
    assert.equal(row.revoked_at?.toISOString(), revokedAt.toISOString());
    assert.equal(row.revoked_reason, 'revoked from admin');
    assert.equal((await verify('iphone', stolen.password)).status, 401);

    // La password creata dopo il backup non esiste più: epoch + 1, così
    // caldes_auth svuota anche la cache persistita.
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM caldav_app_passwords WHERE id = ${fresh.row.id}::uuid
    `;
    assert.equal(n, 0);
    assert.equal((await verify('federico', fresh.password)).status, 401);
    const stateAfter = await readState();
    assert.equal(stateAfter.credential_epoch, stateBefore.credential_epoch + 1);
    assert.ok(stateAfter.policy_version > stateBefore.policy_version);
    await assertRestoreGuard(stateAfter);

    assert.deepEqual(res.json.appPasswords, { revocations_kept: 1, removed: 1, credential_epoch_bumped: true });
    assert.equal(res.json.warnings.length, 1);
    assert.match(res.json.warnings[0], /^App-password CalDAV: un'app-password valida prima del ripristino non esiste più/);
    assert.match(res.json.warnings[0], /revocata dopo il backup resta revocata/);
    assert.match(res.json.warnings[0], /credential_epoch incrementato/);
    const [audit] = await sql<Array<{ metadata: Row }>>`
      SELECT metadata FROM audit_logs WHERE table_name = 'backup' AND action = 'IMPORT'
      ORDER BY created_at DESC LIMIT 1
    `;
    assert.deepEqual(audit.metadata.appPasswords, { revocations_kept: 1, removed: 1, credential_epoch_bumped: true });

    // Un secondo import dello stesso backup non toglie più nulla: epoch invariato.
    const again = await importBackup(file);
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.json.appPasswords, { revocations_kept: 1, removed: 0, credential_epoch_bumped: false });
    assert.equal((await readState()).credential_epoch, stateAfter.credential_epoch);
    assert.equal((await verify('iphone', stolen.password)).status, 401);
    await resetBackendState();
  });

  test('round-trip export → import → export: dati identici, cambia solo la guardia dello stato', async () => {
    await resetBackendState();
    const first = await exportBackup();
    const res = await withTripwires(PROTECTED_ALWAYS, () => importBackup(first));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.calendar.kept, []);
    assert.deepEqual(res.json.calendar.reconciled, []);
    assert.deepEqual(res.json.skipped.calendar, []);
    assert.deepEqual(res.json.emptied, []);
    assert.deepEqual(res.json.warnings, []);
    const second = await exportBackup();

    assert.deepEqual(Object.keys(second.tables).sort(), Object.keys(first.tables).sort());
    for (const key of Object.keys(first.tables)) {
      const a = first.tables[key];
      const b = second.tables[key];
      if (key === 'public.audit_logs') {
        // L'import riporta audit_logs al contenuto del file e aggiunge la sua riga IMPORT.
        const before = multiset(a);
        const added = b.filter((row) => !before.includes(canonical(row)));
        assert.equal(added.length, 1, 'righe di audit_logs diverse da quella dell\'import');
        assert.equal(added[0].action, 'IMPORT');
        assert.equal(added[0].table_name, 'backup');
        assert.deepEqual(multiset(b.filter((row) => row !== added[0])), before);
        continue;
      }
      if (key === 'public.cal_jobs') {
        // L'import accoda il rebuild dell'indice (requestIndexRebuild): l'unica riga nuova.
        const added = b.filter((row) => !multiset(a).includes(canonical(row)));
        assert.deepEqual(added.map((row) => [row.kind, row.key, row.status]), [['index_rebuild', 'all', 'pending']]);
        assert.deepEqual(multiset(b.filter((row) => !added.includes(row))), multiset(a));
        continue;
      }
      if (key === 'public.calendar_backend_state') {
        const strip = ({ restore_guard_until: _g, rebuild_required: _r, policy_version: _v, updated_at: _u, ...rest }: Row) => rest;
        assert.deepEqual(b.map(strip), a.map(strip));
        assert.equal(b[0].rebuild_required, true);
        assert.ok(b[0].restore_guard_until);
        assert.equal(b[0].policy_version, a[0].policy_version + 1);
        continue;
      }
      assert.deepEqual(multiset(b), multiset(a), key);
    }
    await resetBackendState();
  });
});
