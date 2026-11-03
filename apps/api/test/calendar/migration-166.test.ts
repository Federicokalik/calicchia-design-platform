/**
 * Migrazione 166 (guardia di calendar_events guidata dallo stato, journal
 * delle transizioni, stato della proiezione inversa) della fase F4 del
 * passaggio a Radicale. Riferimenti: design §4 (166), §13.9-§13.13, §16.2;
 * contratto docs/calendar-radicale/contracts/f4-modules.md §1 e §2.
 *
 * Cosa si verifica:
 *  - colonne caldes_object_id e caldes_derived con i default, vincolo e
 *    indice; il codice legacy non le vede (DTO di PgLegacyStore invariati);
 *  - guardia inerte in mode postgres (INSERT, UPDATE, DELETE, TRUNCATE
 *    passano come prima);
 *  - in mode cutover, radicale, rollback e finalized ogni scrittura diretta
 *    fallisce con SQLSTATE CD166 e non tocca nulla; con il GUC
 *    caldes.reverse_sync passa; uno statement senza righe non fallisce;
 *  - la delete di un calendario completa le cascate (eventi, override,
 *    righe delle iscrizioni), con e senza GUC; la delete di un'iscrizione
 *    completa le proprie; la delete diretta di un master o di un override con
 *    il padre presente no;
 *  - barriera delle transizioni: l'UPDATE del mode attende le transazioni che
 *    hanno già scritto calendar_events; una scrittura successiva fallisce; in
 *    REPEATABLE READ una scrittura con una fotografia precedente al cambio
 *    fallisce con 40001;
 *  - journal: una sola transizione attiva, vincoli dei passi, cascata;
 *    stato della proiezione inversa con i vincoli e le cascate; tabelle nel
 *    gruppo S; idempotenza del file.
 *
 * Gli scenari senza concorrenza girano in transazioni sempre annullate.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { getPgLegacyStore } from '../../src/lib/calendar/store';
import { NODE_TYPES, validateReadOnlyQuery } from '../../src/lib/workflow/nodes';
import { isCalendarEventsGuardError } from '../../src/lib/calendar/migration/transition';
import {
  CALENDAR_EVENTS_GUARD_SQLSTATE,
  DEGRADATION_CLASSES,
  JOURNAL_STEP_STATUSES,
  REVERSE_STATE_STATUSES,
  TRANSITION_KINDS,
  TRANSITION_STATUSES,
} from '../../src/lib/calendar/migration/types';
import { backupGroup } from '../../src/routes/backup';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../database/migrations');
const MIGRATION_166 = readFileSync(resolve(MIGRATIONS_DIR, '166_calendar_events_guard.sql'), 'utf8');

const F4_TABLES = ['cal_migration_transitions', 'cal_migration_journal', 'cal_migration_reverse_state'];
const NON_POSTGRES_MODES = ['cutover', 'radicale', 'rollback', 'finalized'] as const;

const fx = useFixtures('migration-166', { resetBaseline: true });
onBeforeDatabaseClose(async () => {
  await resetCalendarBaseline();
});

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

/** Errore di `fn` eseguita in un savepoint (null se non fallisce). */
async function errorOf(tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<{ code?: string; message?: string } | null> {
  try {
    await tx.savepoint(async (sp: Tx) => { await fn(sp); });
    return null;
  } catch (err) {
    return err as { code?: string; message?: string };
  }
}

async function expectGuard(tx: Tx, fn: (sp: Tx) => Promise<unknown>, what: string): Promise<void> {
  const err = await errorOf(tx, fn);
  assert.ok(err, `${what}: atteso il rifiuto della guardia 166`);
  assert.equal(err.code, CALENDAR_EVENTS_GUARD_SQLSTATE, `${what}: ${err.message}`);
  assert.ok(isCalendarEventsGuardError(err), `${what}: riconosciuto da isCalendarEventsGuardError`);
}

async function insertCalendar(tx: Tx, slug: string): Promise<string> {
  const [{ id }] = await tx`
    INSERT INTO calendars ${tx({ slug, name: slug, ics_feed_token: `${slug.replace(/[^a-z0-9]/g, '')}${'0'.repeat(32)}`.slice(0, 32) })}
    RETURNING id
  `;
  return id as string;
}

interface EventSpec {
  calendarId: string;
  uid: string;
  start?: string;
  end?: string;
  rrule?: string | null;
  masterId?: string | null;
  recurrenceId?: string | null;
  subscriptionId?: string | null;
  source?: string;
}

async function insertEvent(tx: Tx, e: EventSpec): Promise<string> {
  const [{ id }] = await tx`
    INSERT INTO calendar_events ${tx({
      calendar_id: e.calendarId,
      uid: e.uid,
      summary: e.uid,
      start_time: e.start ?? '2027-03-01T09:00:00Z',
      end_time: e.end ?? '2027-03-01T10:00:00Z',
      rrule: e.rrule ?? null,
      recurrence_master_id: e.masterId ?? null,
      recurrence_id: e.recurrenceId ?? null,
      subscription_id: e.subscriptionId ?? null,
      source: e.source ?? 'admin',
    })}
    RETURNING id
  `;
  return id as string;
}

async function setMode(db: Tx, mode: string): Promise<void> {
  if (mode === 'postgres') {
    await db`UPDATE calendar_backend_state SET mode = 'postgres', write_freeze = false, volume_id = NULL, epoch = 0 WHERE id`;
  } else {
    await db`UPDATE calendar_backend_state SET mode = ${mode}, volume_id = ${randomUUID()}::uuid, epoch = 1 WHERE id`;
  }
}

async function countEvents(db: Tx, ids: string[]): Promise<number> {
  const [{ n }] = await db`SELECT count(*)::int AS n FROM calendar_events WHERE id = ANY(${ids}::uuid[])`;
  return n as number;
}

/** UID di test con il prefisso del file (pulito da cleanupTestData). */
function uidOf(suffix: string): string {
  return `${fx.prefix}-${suffix}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Promessa che si risolve con 'pending' se `p` non si è conclusa entro `ms`. */
async function settledWithin<T>(p: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
  return Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), sleep(ms).then(() => 'pending' as const)]);
}

describe('migrazione 166: colonne e catalogo', () => {
  test('caldes_object_id e caldes_derived: default, vincolo, indice; ignorate dai DTO legacy', async () => {
    const cols = await sql<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'calendar_events' AND column_name LIKE 'caldes\\_%'
      ORDER BY column_name
    `;
    assert.deepEqual(Array.from(cols, (c) => ({ ...c })), [
      { column_name: 'caldes_derived', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      { column_name: 'caldes_object_id', data_type: 'uuid', is_nullable: 'YES', column_default: null },
    ]);
    const [idx] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'calendar_events_caldes_object_idx'`;
    assert.match(String(idx?.indexdef), /WHERE \(caldes_object_id IS NOT NULL\)/);

    await inRollback(async (tx) => {
      const [lavoro] = await tx`SELECT id FROM calendars WHERE slug = 'lavoro'`;
      const err = await errorOf(tx, (sp) => sp`
        INSERT INTO calendar_events (calendar_id, uid, summary, start_time, end_time, caldes_derived)
        VALUES (${lavoro.id}, 'tst-166-derived-senza-oggetto', 'x', '2027-01-01T09:00:00Z', '2027-01-01T10:00:00Z', true)
      `);
      assert.match(String(err?.message), /calendar_events_caldes_derived_check/);
    });

    // PgLegacyStore seleziona colonne esplicite: le colonne nuove non entrano nei DTO.
    const cal = await fx.calendar({ key: 'dto' });
    const ev = await fx.event({ calendar: cal, summary: 'dto', start_time: '2027-02-01T09:00:00Z', end_time: '2027-02-01T10:00:00Z' });
    const read = await getPgLegacyStore().getEvent(ev.id);
    assert.ok(read);
    assert.ok(!Object.keys(read).some((k) => k.startsWith('caldes')), `chiavi del DTO: ${Object.keys(read).join(', ')}`);
  });

  test('trigger della guardia prima degli altri BEFORE, anche su TRUNCATE', async () => {
    const triggers = await sql<Array<{ tgname: string; timing: string; level: string; events: string }>>`
      SELECT trigger_name AS tgname, action_timing AS timing, action_orientation AS level,
             string_agg(event_manipulation, ',' ORDER BY event_manipulation) AS events
      FROM information_schema.triggers
      WHERE event_object_table = 'calendar_events' AND trigger_name LIKE 'calendar_events_guard%'
      GROUP BY trigger_name, action_timing, action_orientation
      ORDER BY trigger_name
    `;
    assert.deepEqual(Array.from(triggers, (t) => ({ ...t })), [
      { tgname: 'calendar_events_guard', timing: 'BEFORE', level: 'ROW', events: 'DELETE,INSERT,UPDATE' },
    ]);
    const [truncate] = await sql<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'calendar_events'::regclass AND tgname = 'calendar_events_guard_truncate' AND NOT tgisinternal
    `;
    assert.ok(truncate, 'guardia del TRUNCATE presente');
    const before = await sql<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'calendar_events'::regclass AND NOT tgisinternal
        AND (tgtype & 2) = 2 AND (tgtype & 1) = 1
      ORDER BY tgname
    `;
    assert.equal(before[0]?.tgname, 'calendar_events_guard', 'i trigger BEFORE di riga girano in ordine alfabetico');
  });

  test('tabelle nuove nel gruppo S, CHECK allineati alle costanti, nessuna FK verso calendar_events', async () => {
    for (const table of F4_TABLES) assert.equal(backupGroup(`public.${table}`), 'state', table);
    const def = async (table: string, constraint: string): Promise<string> => {
      const [row] = await sql<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = ${table}::regclass AND conname = ${constraint}
      `;
      assert.ok(row, `${constraint} assente`);
      return row.def;
    };
    const values = (d: string): string[] => [...d.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(values(await def('cal_migration_transitions', 'cal_migration_transitions_kind_check')), [...TRANSITION_KINDS]);
    assert.deepEqual(values(await def('cal_migration_transitions', 'cal_migration_transitions_status_check')), [...TRANSITION_STATUSES]);
    assert.deepEqual(values(await def('cal_migration_journal', 'cal_migration_journal_status_check')), [...JOURNAL_STEP_STATUSES]);
    assert.deepEqual(values(await def('cal_migration_reverse_state', 'cal_migration_reverse_state_status_check')), [...REVERSE_STATE_STATUSES]);
    // Le classi dei degradi stanno nel codice delle righe (pattern dei codici): verificate sul formato.
    for (const cls of DEGRADATION_CLASSES) assert.match(cls, /^[A-Z][A-Z0-9_]{0,63}$/);
    const fks = await sql<Array<{ rel: string; ref: string }>>`
      SELECT conrelid::regclass::text AS rel, confrelid::regclass::text AS ref FROM pg_constraint
      WHERE contype = 'f' AND conrelid IN ('cal_migration_transitions'::regclass, 'cal_migration_journal'::regclass, 'cal_migration_reverse_state'::regclass)
      ORDER BY 1, 2
    `;
    assert.deepEqual(Array.from(fks, (f) => `${f.rel}→${f.ref}`), [
      'cal_migration_journal→cal_migration_transitions',
      'cal_migration_reverse_state→calendars',
    ]);
  });

  test('idempotente: rieseguita su uno schema già migrato non fallisce e non cambia il catalogo', async () => {
    const catalog = async (tx: Tx) => ({
      columns: Array.from(await tx`
        SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND (table_name LIKE 'cal\\_migration%' OR (table_name = 'calendar_events' AND column_name LIKE 'caldes\\_%'))
        ORDER BY table_name, column_name
      `, (r: Record<string, unknown>) => ({ ...r })),
      constraints: Array.from(await tx`
        SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid IN ('calendar_events'::regclass, 'cal_migration_transitions'::regclass, 'cal_migration_journal'::regclass, 'cal_migration_reverse_state'::regclass)
        ORDER BY 1, 2
      `, (r: Record<string, unknown>) => ({ ...r })),
      triggers: Array.from(await tx`
        SELECT tgrelid::regclass::text AS rel, tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid IN ('calendar_events'::regclass, 'cal_migration_transitions'::regclass, 'cal_migration_journal'::regclass, 'cal_migration_reverse_state'::regclass)
        ORDER BY 1, 2
      `, (r: Record<string, unknown>) => ({ ...r })),
      indexes: Array.from(await tx`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND (tablename LIKE 'cal\\_migration%' OR indexname LIKE 'calendar\\_events\\_caldes%')
        ORDER BY indexname
      `, (r: Record<string, unknown>) => ({ ...r })),
    });
    await inRollback(async (tx) => {
      const before = await catalog(tx);
      await tx.unsafe(MIGRATION_166);
      assert.deepEqual(await catalog(tx), before);
    });
  });
});

describe('migrazione 166: guardia guidata dallo stato', () => {
  test('mode postgres: guardia inerte, INSERT, UPDATE, DELETE e TRUNCATE passano', async () => {
    await inRollback(async (tx) => {
      await setMode(tx, 'postgres');
      const cal = await insertCalendar(tx, 'tst-166-pg');
      const id = await insertEvent(tx, { calendarId: cal, uid: 'tst-166-pg-1' });
      await tx`UPDATE calendar_events SET summary = 'modificato' WHERE id = ${id}`;
      await tx`DELETE FROM calendar_events WHERE id = ${id}`;
      await insertEvent(tx, { calendarId: cal, uid: 'tst-166-pg-2' });
      // TRUNCATE nella transazione annullata: CASCADE non serve (nessuna FK verso calendar_events dalle tabelle nuove).
      await tx`TRUNCATE calendar_events`;
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM calendar_events`;
      assert.equal(n, 0);
    });
  });

  for (const mode of NON_POSTGRES_MODES) {
    test(`mode ${mode}: INSERT, UPDATE, DELETE e TRUNCATE diretti rifiutati con CD166, nulla cambia`, async () => {
      await inRollback(async (tx) => {
        await setMode(tx, 'postgres');
        const cal = await insertCalendar(tx, `tst-166-${mode}`);
        const master = await insertEvent(tx, { calendarId: cal, uid: `tst-166-${mode}-m`, rrule: 'FREQ=WEEKLY;COUNT=4' });
        const override = await insertEvent(tx, {
          calendarId: cal, uid: `tst-166-${mode}-o`, masterId: master, recurrenceId: '2027-03-08T09:00:00Z',
          start: '2027-03-08T10:00:00Z', end: '2027-03-08T11:00:00Z',
        });
        await setMode(tx, mode);

        await expectGuard(tx, (sp) => insertEvent(sp, { calendarId: cal, uid: `tst-166-${mode}-nuovo` }), 'INSERT');
        await expectGuard(tx, (sp) => sp`UPDATE calendar_events SET summary = 'x' WHERE id = ${master}`, 'UPDATE');
        await expectGuard(tx, (sp) => sp`DELETE FROM calendar_events WHERE id = ${override}`, 'DELETE dell\'override con il master presente');
        await expectGuard(tx, (sp) => sp`DELETE FROM calendar_events WHERE id = ${master}`, 'DELETE del master (e quindi della cascata)');
        await expectGuard(tx, (sp) => sp`TRUNCATE calendar_events`, 'TRUNCATE');
        const err = await errorOf(tx, (sp) => sp`UPDATE calendar_events SET summary = 'x' WHERE id = ${master}`);
        assert.match(String(err?.message), new RegExp(`sola lettura con mode ${mode}`));

        // Uno statement senza righe non scrive nulla e non fallisce (guardia di riga).
        await tx`UPDATE calendar_events SET summary = 'x' WHERE id = ${randomUUID()}`;
        await tx`DELETE FROM calendar_events WHERE id = ${randomUUID()}`;

        assert.equal(await countEvents(tx, [master, override]), 2);
        const [row] = await tx`SELECT summary FROM calendar_events WHERE id = ${master}`;
        assert.equal(row.summary, `tst-166-${mode}-m`);
      });
    });
  }

  test('con caldes.reverse_sync = on le scritture passano anche in mode radicale (solo nella transazione)', async () => {
    await inRollback(async (tx) => {
      await setMode(tx, 'postgres');
      const cal = await insertCalendar(tx, 'tst-166-guc');
      const id = await insertEvent(tx, { calendarId: cal, uid: 'tst-166-guc-1' });
      await setMode(tx, 'radicale');
      await tx`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;
      const objectId = randomUUID();
      const derived = await tx`
        INSERT INTO calendar_events (calendar_id, uid, summary, start_time, end_time, caldes_object_id, caldes_derived)
        VALUES (${cal}, 'tst-166-guc-derivata', 'derivata', '2027-04-01T09:00:00Z', '2027-04-01T10:00:00Z', ${objectId}, true)
        RETURNING id
      `;
      await tx`UPDATE calendar_events SET summary = 'dalla proiezione inversa', caldes_object_id = ${objectId} WHERE id = ${id}`;
      await tx`DELETE FROM calendar_events WHERE id = ${derived[0].id}`;
      await tx`SELECT set_config('caldes.reverse_sync', 'off', true)`;
      await expectGuard(tx, (sp) => sp`UPDATE calendar_events SET summary = 'y' WHERE id = ${id}`, 'GUC spento di nuovo');
      const [row] = await tx`SELECT summary, caldes_object_id FROM calendar_events WHERE id = ${id}`;
      assert.deepEqual({ ...row }, { summary: 'dalla proiezione inversa', caldes_object_id: objectId });
    });
  });

  test('la delete di un calendario completa le cascate (eventi, override, righe delle iscrizioni), con e senza GUC', async () => {
    for (const withGuc of [false, true]) {
      await inRollback(async (tx) => {
        await setMode(tx, 'postgres');
        const cal = await insertCalendar(tx, `tst-166-del-${withGuc}`);
        const master = await insertEvent(tx, { calendarId: cal, uid: `tst-166-del-${withGuc}-m`, rrule: 'FREQ=DAILY;COUNT=3' });
        const override = await insertEvent(tx, {
          calendarId: cal, uid: `tst-166-del-${withGuc}-o`, masterId: master, recurrenceId: '2027-03-02T09:00:00Z',
          start: '2027-03-02T11:00:00Z', end: '2027-03-02T12:00:00Z',
        });
        const [sub] = await tx`
          INSERT INTO calendar_subscriptions (calendar_id, name, ics_url) VALUES (${cal}, ${`tst-166-sub-${withGuc}`}, 'https://example.invalid/feed.ics')
          RETURNING id
        `;
        const pulled = await insertEvent(tx, { calendarId: cal, uid: `tst-166-del-${withGuc}-p`, subscriptionId: sub.id, source: 'ics_pull' });
        await setMode(tx, 'radicale');
        if (withGuc) await tx`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;
        await tx`DELETE FROM calendars WHERE id = ${cal}`;
        assert.equal(await countEvents(tx, [master, override, pulled]), 0, withGuc ? 'con il GUC' : 'senza GUC: le cascate passano la guardia');
      });
    }
  });

  test('la delete di un\'iscrizione completa la cascata delle sue righe; la delete diretta di una riga no', async () => {
    await inRollback(async (tx) => {
      await setMode(tx, 'postgres');
      const cal = await insertCalendar(tx, 'tst-166-subdel');
      const [sub] = await tx`
        INSERT INTO calendar_subscriptions (calendar_id, name, ics_url) VALUES (${cal}, 'tst-166-subdel', 'https://example.invalid/a.ics')
        RETURNING id
      `;
      const a = await insertEvent(tx, { calendarId: cal, uid: 'tst-166-subdel-a', subscriptionId: sub.id, source: 'ics_pull' });
      const b = await insertEvent(tx, { calendarId: cal, uid: 'tst-166-subdel-b', subscriptionId: sub.id, source: 'ics_pull' });
      await setMode(tx, 'radicale');
      await expectGuard(tx, (sp) => sp`DELETE FROM calendar_events WHERE id = ${a}`, 'DELETE diretta di una riga dell\'iscrizione');
      await tx`DELETE FROM calendar_subscriptions WHERE id = ${sub.id}`;
      assert.equal(await countEvents(tx, [a, b]), 0);
    });
  });

  test('cascata dal master solo se la delete del master è ammessa (GUC): gli override seguono', async () => {
    await inRollback(async (tx) => {
      await setMode(tx, 'postgres');
      const cal = await insertCalendar(tx, 'tst-166-master');
      const master = await insertEvent(tx, { calendarId: cal, uid: 'tst-166-master-m', rrule: 'FREQ=DAILY;COUNT=3' });
      const override = await insertEvent(tx, {
        calendarId: cal, uid: 'tst-166-master-o', masterId: master, recurrenceId: '2027-03-02T09:00:00Z',
        start: '2027-03-02T11:00:00Z', end: '2027-03-02T12:00:00Z',
      });
      await setMode(tx, 'radicale');
      await expectGuard(tx, (sp) => sp`DELETE FROM calendar_events WHERE id = ${master}`, 'master senza GUC');
      assert.equal(await countEvents(tx, [master, override]), 2);
      await tx.savepoint(async (sp: Tx) => {
        await sp`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;
        await sp`DELETE FROM calendar_events WHERE id = ${master}`;
        await sp`SELECT set_config('caldes.reverse_sync', 'off', true)`;
      });
      assert.equal(await countEvents(tx, [master, override]), 0);
    });
  });

  test('i percorsi legacy ricevono l\'errore della guardia (PgLegacyStore fuori da mode postgres)', async () => {
    const cal = await fx.calendar({ key: 'legacy-path' });
    const ev = await fx.event({ calendar: cal, summary: 'legacy', start_time: '2027-05-03T09:00:00Z', end_time: '2027-05-03T10:00:00Z' });
    await setMode(sql, 'radicale');
    invalidateBackendModeCache();
    try {
      const legacy = getPgLegacyStore();
      await assert.rejects(
        legacy.createEvent({ calendar_id: cal.id, summary: fx.name('rifiutato'), start_time: '2027-05-04T09:00:00Z', end_time: '2027-05-04T10:00:00Z' }),
        (err: unknown) => isCalendarEventsGuardError(err),
      );
      await assert.rejects(legacy.updateEvent(ev.id, { summary: fx.name('modificato') }), (err: unknown) => isCalendarEventsGuardError(err));
      await assert.rejects(legacy.deleteEvent(ev.id), (err: unknown) => isCalendarEventsGuardError(err));
      const [row] = await sql`SELECT summary FROM calendar_events WHERE id = ${ev.id}`;
      assert.equal(row.summary, ev.summary);
    } finally {
      await setMode(sql, 'postgres');
      invalidateBackendModeCache();
    }
  });

  test('F4R-TR-4: create, update e delete di calendari e iscrizioni legacy fuori da mode postgres → CalendarUnavailableError, nulla cambia', async () => {
    const cal = await fx.calendar({ key: 'tr4-barrier' });
    const legacy = getPgLegacyStore();
    await setMode(sql, 'cutover');
    invalidateBackendModeCache();
    try {
      await assert.rejects(legacy.deleteCalendar(cal.id), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'store_not_available');
      const [still] = await sql`SELECT id FROM calendars WHERE id = ${cal.id}::uuid`;
      assert.ok(still, 'il calendario è ancora presente');
      await assert.rejects(legacy.updateCalendar(cal.id, { name: fx.name('rinominato') }), (err: unknown) => err instanceof CalendarUnavailableError);
      await assert.rejects(
        legacy.createCalendar({ slug: `tst-tr4-${randomUUID().slice(0, 8)}`, name: fx.name('nuovo') }),
        (err: unknown) => err instanceof CalendarUnavailableError,
      );
      await assert.rejects(
        legacy.createSubscription({ calendar_id: cal.id, name: fx.name('iscrizione'), ics_url: 'https://example.invalid/tr4.ics' }),
        (err: unknown) => err instanceof CalendarUnavailableError,
      );
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM calendar_subscriptions WHERE calendar_id = ${cal.id}::uuid`;
      assert.equal(n, 0);
    } finally {
      await setMode(sql, 'postgres');
      invalidateBackendModeCache();
    }
    // Di nuovo in mode postgres la scrittura legacy passa.
    await legacy.deleteCalendar(cal.id);
    assert.equal((await sql`SELECT id FROM calendars WHERE id = ${cal.id}::uuid`).length, 0);
  });

  test('F4R-TR-3: un GUC "on" o di sessione non passa la guardia, solo l\'id della transazione corrente', async () => {
    await inRollback(async (tx) => {
      await setMode(tx, 'postgres');
      const cal = await insertCalendar(tx, 'tst-166-tr3');
      const id = await insertEvent(tx, { calendarId: cal, uid: 'tst-166-tr3-1' });
      await setMode(tx, 'radicale');
      // Come farebbe il nodo SQL dei workflow: set_config a livello di sessione (is_local = false).
      await tx`SELECT set_config('caldes.reverse_sync', 'on', false)`;
      await expectGuard(tx, (sp) => sp`UPDATE calendar_events SET summary = 'x' WHERE id = ${id}`, 'GUC di sessione "on"');
      await tx`SELECT set_config('caldes.reverse_sync', '4242424242', false)`;
      await expectGuard(tx, (sp) => sp`UPDATE calendar_events SET summary = 'x' WHERE id = ${id}`, 'GUC con un txid altrui');
      await tx`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;
      await tx`UPDATE calendar_events SET summary = 'dalla proiezione inversa' WHERE id = ${id}`;
    });
  });

  test('F4R-TR-3: il nodo SQL dei workflow rifiuta set_config, current_setting e txid_*, e gira in sola lettura', async () => {
    const blocked = 'Query bloccata: funzioni di sistema non permesse';
    assert.equal(validateReadOnlyQuery("SELECT set_config('caldes.reverse_sync','on',false)"), blocked);
    assert.equal(validateReadOnlyQuery("SELECT current_setting('caldes.reverse_sync', true)"), blocked);
    assert.equal(validateReadOnlyQuery('SELECT txid_current()'), blocked);
    assert.equal(validateReadOnlyQuery('SELECT id FROM leads LIMIT 1'), null);
    const out = await NODE_TYPES.tool_db_query.execute({ query: "SELECT set_config('caldes.reverse_sync','on',false)", params: [] }, {});
    assert.equal((out as { error?: string }).error, blocked);
    // La query valida gira in una transazione di sola lettura.
    const ok = await NODE_TYPES.tool_db_query.execute({ query: 'SELECT count(*)::int AS n FROM leads', params: [] }, {});
    assert.equal((ok as { error?: string }).error, undefined);
  });

  for (const mode of ['cutover', 'rollback'] as const) {
    test(`F4R-TR-4: in mode ${mode} la delete di un calendario senza GUC fallisce con CD166 (le cascate non sono esenti)`, async () => {
      await inRollback(async (tx) => {
        await setMode(tx, 'postgres');
        const cal = await insertCalendar(tx, `tst-166-tr4-${mode}`);
        const ev = await insertEvent(tx, { calendarId: cal, uid: `tst-166-tr4-${mode}-e` });
        await setMode(tx, mode);
        await expectGuard(tx, (sp) => sp`DELETE FROM calendars WHERE id = ${cal}`, 'DELETE del calendario senza GUC');
        assert.equal(await countEvents(tx, [ev]), 1);
        await tx`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;
        await tx`DELETE FROM calendars WHERE id = ${cal}`;
        assert.equal(await countEvents(tx, [ev]), 0, 'con il GUC lo scrittore privilegiato cancella');
      });
    });
  }
});

describe('migrazione 166: barriera delle transizioni', () => {
  test('l\'UPDATE del mode attende chi ha già scritto; dopo il cambio la scrittura fallisce', async () => {
    const cal = await fx.calendar({ key: 'barriera' });
    let releaseWriter!: () => void;
    const writerMayCommit = new Promise<void>((r) => { releaseWriter = r; });
    let writerWrote!: () => void;
    const wrote = new Promise<void>((r) => { writerWrote = r; });
    try {
      // Transazione A (mode postgres): scrive e resta aperta.
      const writer = sql.begin(async (tx: Tx) => {
        await insertEvent(tx, { calendarId: cal.id, uid: uidOf('barriera-a') });
        writerWrote();
        await writerMayCommit;
      });
      await wrote;
      // Transizione: l'UPDATE dello stato attende la fine di A.
      const transition = setMode(sql, 'cutover');
      assert.equal(await settledWithin(transition, 400), 'pending', 'la transizione attende la transazione che ha già scritto');
      releaseWriter();
      await writer;
      await transition;
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM calendar_events WHERE uid = ${uidOf('barriera-a')}`;
      assert.equal(n, 1, 'la scrittura committata prima del cambio resta (entra nella fotografia del delta)');
      // Dopo il cambio: la scrittura successiva fallisce.
      await assert.rejects(
        sql.begin(async (tx: Tx) => insertEvent(tx, { calendarId: cal.id, uid: uidOf('barriera-c') })),
        (err: unknown) => isCalendarEventsGuardError(err),
      );
    } finally {
      releaseWriter();
      await setMode(sql, 'postgres');
    }
  });

  test('una scrittura che attende la transizione legge il mode nuovo e fallisce (READ COMMITTED)', async () => {
    const cal = await fx.calendar({ key: 'barriera-attesa' });
    let releaseTransition!: () => void;
    const transitionMayCommit = new Promise<void>((r) => { releaseTransition = r; });
    let updated!: () => void;
    const didUpdate = new Promise<void>((r) => { updated = r; });
    try {
      await sql`UPDATE calendar_backend_state SET volume_id = ${randomUUID()}::uuid, epoch = 1 WHERE id`;
      const transition = sql.begin(async (tx: Tx) => {
        await tx`UPDATE calendar_backend_state SET mode = 'rollback' WHERE id`;
        updated();
        await transitionMayCommit;
      });
      await didUpdate;
      const write = sql.begin(async (tx: Tx) => insertEvent(tx, { calendarId: cal.id, uid: uidOf('barriera-attesa') }));
      assert.equal(await settledWithin(write, 400), 'pending', 'la scrittura attende la transazione dello stato');
      releaseTransition();
      await transition;
      await assert.rejects(write, (err: unknown) => isCalendarEventsGuardError(err));
    } finally {
      releaseTransition();
      await setMode(sql, 'postgres');
    }
  });

  test('REPEATABLE READ: una scrittura con la fotografia precedente al cambio fallisce (40001)', async () => {
    const cal = await fx.calendar({ key: 'barriera-rr' });
    let proceed!: () => void;
    const mayWrite = new Promise<void>((r) => { proceed = r; });
    let snapped!: () => void;
    const didSnapshot = new Promise<void>((r) => { snapped = r; });
    try {
      const writer = sql.begin('isolation level repeatable read', async (tx: Tx) => {
        await tx`SELECT mode FROM calendar_backend_state WHERE id`;
        snapped();
        await mayWrite;
        await insertEvent(tx, { calendarId: cal.id, uid: uidOf('barriera-rr') });
      });
      await didSnapshot;
      await setMode(sql, 'cutover');
      proceed();
      await assert.rejects(writer, (err: unknown) => (err as { code?: string }).code === '40001' || isCalendarEventsGuardError(err));
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM calendar_events WHERE uid = ${uidOf('barriera-rr')}`;
      assert.equal(n, 0);
    } finally {
      proceed();
      await setMode(sql, 'postgres');
    }
  });
});

describe('migrazione 166: journal e stato della proiezione inversa', () => {
  test('una sola transizione attiva; chiusura coerente; passi con i vincoli; cascata del journal', async () => {
    await inRollback(async (tx) => {
      const insert = (sp: Tx, kind: string, from: string, to: string) => sp`
        INSERT INTO cal_migration_transitions (kind, from_mode, target_mode, epoch_before, started_by)
        VALUES (${kind}, ${from}, ${to}, 1, 'admin:test') RETURNING id
      `;
      const [t] = await insert(tx, 'cutover', 'postgres', 'radicale');
      const second = await errorOf(tx, (sp) => insert(sp, 'rollback', 'radicale', 'postgres'));
      assert.match(String(second?.message), /cal_migration_transitions_single_active/);
      const badEpoch = await errorOf(tx, (sp) => sp`UPDATE cal_migration_transitions SET epoch_after = 3 WHERE id = ${t.id}`);
      assert.match(String(badEpoch?.message), /cal_migration_transitions_epoch_check/);
      const notClosed = await errorOf(tx, (sp) => sp`UPDATE cal_migration_transitions SET status = 'completed' WHERE id = ${t.id}`);
      assert.match(String(notClosed?.message), /cal_migration_transitions_finished_check/);
      const sameMode = await errorOf(tx, (sp) => insert(sp, 'finalize', 'radicale', 'radicale'));
      assert.match(String(sameMode?.message), /cal_migration_transitions_mode_check|single_active/);

      await tx`INSERT INTO cal_migration_journal (transition_id, step, seq) VALUES (${t.id}, 'freeze', 0)`;
      const dup = await errorOf(tx, (sp) => sp`INSERT INTO cal_migration_journal (transition_id, step, seq) VALUES (${t.id}, 'freeze', 1)`);
      assert.match(String(dup?.message), /cal_migration_journal_pkey/);
      const badStep = await errorOf(tx, (sp) => sp`INSERT INTO cal_migration_journal (transition_id, step, seq) VALUES (${t.id}, 'Freeze!', 1)`);
      assert.match(String(badStep?.message), /cal_migration_journal_step_check/);
      const doneWithoutEnd = await errorOf(tx, (sp) => sp`UPDATE cal_migration_journal SET status = 'done' WHERE transition_id = ${t.id}`);
      assert.match(String(doneWithoutEnd?.message), /cal_migration_journal_finished_check/);
      const errorNotFailed = await errorOf(tx, (sp) => sp`UPDATE cal_migration_journal SET error_code = 'X', error = 'y' WHERE transition_id = ${t.id}`);
      assert.match(String(errorNotFailed?.message), /cal_migration_journal_error_check/);
      await tx`UPDATE cal_migration_journal SET status = 'done', finished_at = now() WHERE transition_id = ${t.id}`;
      await tx`UPDATE cal_migration_transitions SET status = 'completed', finished_at = now(), epoch_after = 2 WHERE id = ${t.id}`;
      // Conclusa: se ne può aprire un'altra.
      await insert(tx, 'rollback', 'radicale', 'postgres');
      await tx`DELETE FROM cal_migration_transitions WHERE id = ${t.id}`;
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM cal_migration_journal WHERE transition_id = ${t.id}`;
      assert.equal(n, 0, 'il journal segue la transizione');
    });
  });

  test('stato della proiezione inversa: vincoli e cascata dal calendario (nessuna FK verso l\'indice F2)', async () => {
    await inRollback(async (tx) => {
      const cal = await insertCalendar(tx, 'tst-166-reverse');
      const [obj] = await tx`INSERT INTO cal_object_ids (calendar_id, href) VALUES (${cal}, 'serie.ics') RETURNING id`;
      await tx`
        INSERT INTO cal_migration_reverse_state (object_id, calendar_id, href, status, rows, degradations)
        VALUES (${obj.id}, ${cal}, 'serie.ics', 'degraded',
                ${tx.json([{ id: randomUUID(), recurrence_key: '', role: 'master' }] as never)},
                ${tx.json([{ class: 'REPR_LOSS_VALARM' }] as never)})
      `;
      const failedWithoutCode = await errorOf(tx, (sp) => sp`UPDATE cal_migration_reverse_state SET status = 'failed' WHERE object_id = ${obj.id}`);
      assert.match(String(failedWithoutCode?.message), /cal_migration_reverse_state_error_check/);
      await tx`UPDATE cal_migration_reverse_state SET status = 'failed', error_code = 'REVERSE_FAILED', error = 'upsert non riuscito' WHERE object_id = ${obj.id}`;
      const badRows = await errorOf(tx, (sp) => sp`UPDATE cal_migration_reverse_state SET rows = '{}'::jsonb WHERE object_id = ${obj.id}`);
      assert.match(String(badRows?.message), /cal_migration_reverse_state_json_check/);
      // L'id ritirato dall'indice non trascina via lo stato: lo chiude il proiettore.
      await tx`DELETE FROM cal_object_ids WHERE id = ${obj.id}`;
      const [{ n: kept }] = await tx`SELECT count(*)::int AS n FROM cal_migration_reverse_state WHERE object_id = ${obj.id}`;
      assert.equal(kept, 1, 'nessuna FK verso cal_object_ids');
      await tx`DELETE FROM calendars WHERE id = ${cal}`;
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM cal_migration_reverse_state WHERE object_id = ${obj.id}`;
      assert.equal(n, 0, 'segue calendars');
    });
  });
});
