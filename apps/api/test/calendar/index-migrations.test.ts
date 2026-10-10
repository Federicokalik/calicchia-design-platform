/**
 * Migrazioni 163 (indice derivato con salute per oggetto, id persistenti,
 * versioni, orizzonte) e 164 (coda dei lavori, conflitti delle prenotazioni)
 * della fase F2 del passaggio a Radicale. Riferimenti: design §4, §5, §6, §7,
 * §9, §16.2; contratto docs/calendar-radicale/contracts/f2-modules.md §2-§3.
 *
 * Cosa si verifica:
 *  - CHECK allineati alle costanti TS (index-model.ts, jobs.ts);
 *  - nessuna FK verso calendar_events, calendar_subscriptions o
 *    calendar_bookings (il backup JSON le svuota senza CASCADE) e tutte le
 *    tabelle nel gruppo S del backup;
 *  - idempotenza: i due file rieseguiti su uno schema già migrato non
 *    falliscono e non cambiano nulla;
 *  - dati di forma produttiva (slug c e f, serie infinita lun-mar-gio-ven alle
 *    09:00 Roma, proiezione della prenotazione, festività di sistema,
 *    iscrizione) e la query di busy del design §7 con l'indice GiST parziale;
 *  - vincoli, cascate, persistenza di id e versioni oltre il rebuild e la
 *    notifica calendar_index_changed.
 *
 * Gli scenari girano in transazioni sempre annullate; il test del NOTIFY ha
 * bisogno di commit veri su un calendario del gruppo (ripulito dalle fixture,
 * le righe dell'indice spariscono in cascata).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';
import {
  COLLECTION_HEALTH_STATES,
  CONFLICT_DETECTORS,
  EVENT_SOURCES,
  OBJECT_COMPONENTS,
  OBJECT_HEALTH_STATES,
  OCCURRENCE_KINDS,
  ORIGIN_STORES,
  VERSION_CHANGE_KINDS,
  recurrenceKeyForDate,
  recurrenceKeyForInstant,
} from '../../src/lib/calendar/index-model';
import { backupGroup } from '../../src/routes/backup';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../database/migrations');
const MIGRATION_163 = readFileSync(resolve(MIGRATIONS_DIR, '163_calendar_index.sql'), 'utf8');
const MIGRATION_164 = readFileSync(resolve(MIGRATIONS_DIR, '164_calendar_jobs.sql'), 'utf8');

const INDEX_TABLES = ['cal_object_ids', 'cal_object_versions', 'cal_collection_state', 'cal_objects', 'cal_components', 'cal_occurrences'];
const JOB_TABLES = ['cal_jobs', 'cal_booking_conflicts'];
const F2_TABLES = [...INDEX_TABLES, ...JOB_TABLES];

const fx = useFixtures('index-163', { resetBaseline: true });

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

/** Esegue `fn` in un savepoint e restituisce l'errore SQL (o fallisce se non arriva). */
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

/** Valori fra apici di un CHECK ... IN (...) letto dal catalogo. */
async function checkValues(table: string, constraint: string): Promise<string[]> {
  const [row] = await sql<Array<{ def: string }>>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = ${table}::regclass AND conname = ${constraint}
  `;
  assert.ok(row, `vincolo ${constraint} assente`);
  return [...row.def.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Riga in cal_collection_state per un calendario. */
async function collectionState(tx: Tx, calendarId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await tx`INSERT INTO cal_collection_state ${tx({ calendar_id: calendarId, ...extra })}`;
}

interface ObjectSpec {
  calendarId: string;
  href: string;
  uid: string;
  source?: string;
  sourceId?: string | null;
  originStore?: 'radicale' | 'remote';
  isRecurring?: boolean;
  raw?: string;
}

/** id persistente + oggetto (+ componente master). Restituisce l'id dell'oggetto. */
async function insertObject(tx: Tx, spec: ObjectSpec): Promise<string> {
  const [{ id }] = await tx`
    INSERT INTO cal_object_ids (calendar_id, href, recurrence_key, uid)
    VALUES (${spec.calendarId}, ${spec.href}, '', ${spec.uid})
    RETURNING id
  `;
  const originStore = spec.originStore ?? 'radicale';
  await tx`
    INSERT INTO cal_objects ${tx({
      id,
      calendar_id: spec.calendarId,
      href: spec.href,
      uid: spec.uid,
      etag: originStore === 'radicale' ? `"${spec.href}-1"` : null,
      raw_ics: spec.raw ?? `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${spec.uid}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
      origin_store: originStore,
      is_recurring: spec.isRecurring ?? false,
      source: spec.source ?? 'manual',
      source_id: spec.sourceId ?? null,
    })}
  `;
  await tx`
    INSERT INTO cal_components ${tx({ id, object_id: id, calendar_id: spec.calendarId, recurrence_key: '', uid: spec.uid, summary: spec.href })}
  `;
  return id as string;
}

interface OccurrenceSpec {
  objectId: string;
  calendarId: string;
  key: string;
  start: string;
  end: string;
  kind?: string;
  blocks?: boolean;
  allDay?: boolean;
  startDate?: string | null;
  endDate?: string | null;
  componentId?: string | null;
}

async function insertOccurrence(tx: Tx, o: OccurrenceSpec): Promise<void> {
  await tx`
    INSERT INTO cal_occurrences ${tx({
      object_id: o.objectId,
      recurrence_key: o.key,
      component_id: o.componentId === undefined ? o.objectId : o.componentId,
      calendar_id: o.calendarId,
      start_utc: o.start,
      end_utc: o.end,
      all_day: o.allDay ?? false,
      start_date: o.startDate ?? null,
      end_date: o.endDate ?? null,
      kind: o.kind ?? 'event',
      blocks: o.blocks ?? true,
    })}
  `;
}

/** Calendario minimale con le sole colonne legacy (il trigger della 162 completa il sidecar). */
async function insertCalendar(tx: Tx, slug: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const [{ id }] = await tx`
    INSERT INTO calendars ${tx({ slug, name, ics_feed_token: `${slug}${'0'.repeat(32)}`.slice(0, 32), ...extra })}
    RETURNING id
  `;
  return id as string;
}

/** Query di busy del design §7. */
async function busy(tx: Tx, fromIso: string, toIso: string): Promise<Array<{ start: string; end: string }>> {
  const rows = await tx`
    SELECT o.start_utc, o.end_utc FROM cal_occurrences o
    JOIN calendars c ON c.id = o.calendar_id
    LEFT JOIN calendars p ON p.id = c.parent_calendar_id
    LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
    WHERE o.blocks
      AND CASE WHEN c.role = 'subscription'
               THEN COALESCE(s.blocks_availability, false) AND p.blocks_availability
               ELSE c.blocks_availability END
      AND o.span && tstzrange(${fromIso}::timestamptz, ${toIso}::timestamptz, '[)')
    ORDER BY o.start_utc
  `;
  return rows.map((r: { start_utc: Date; end_utc: Date }) => ({ start: r.start_utc.toISOString(), end: r.end_utc.toISOString() }));
}

// ─── Schema ────────────────────────────────────────────────

describe('163-164: vincoli allineati al contratto', () => {
  test('i CHECK hanno gli stessi valori delle costanti TS', async () => {
    assert.deepEqual(await checkValues('cal_occurrences', 'cal_occurrences_kind_check'), [...OCCURRENCE_KINDS]);
    assert.deepEqual(await checkValues('cal_objects', 'cal_objects_health_check'), [...OBJECT_HEALTH_STATES]);
    assert.deepEqual(await checkValues('cal_collection_state', 'cal_collection_state_health_check'), [...COLLECTION_HEALTH_STATES]);
    assert.deepEqual(await checkValues('cal_objects', 'cal_objects_origin_store_check'), [...ORIGIN_STORES]);
    assert.deepEqual(await checkValues('cal_collection_state', 'cal_collection_state_origin_store_check'), [...ORIGIN_STORES]);
    assert.deepEqual(await checkValues('cal_objects', 'cal_objects_component_check'), [...OBJECT_COMPONENTS]);
    assert.deepEqual(await checkValues('cal_object_versions', 'cal_object_versions_change_kind_check'), [...VERSION_CHANGE_KINDS]);
    assert.deepEqual(await checkValues('cal_objects', 'cal_objects_source_check'), [...EVENT_SOURCES]);
    assert.deepEqual(await checkValues('cal_booking_conflicts', 'cal_booking_conflicts_detected_by_check'), [...CONFLICT_DETECTORS]);
    assert.deepEqual(await checkValues('cal_jobs', 'cal_jobs_status_check'), ['pending', 'running', 'done', 'dead', 'superseded']);
  });

  test('nessuna FK verso calendar_events, calendar_subscriptions o tabelle di business; solo calendars e cal_*', async () => {
    const fks = await sql<Array<{ child: string; parent: string; name: string }>>`
      SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent, c.conname AS name
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(${F2_TABLES}::text[])
      ORDER BY 1, 2, 3
    `;
    for (const fk of fks) {
      assert.ok(
        fk.parent === 'calendars' || F2_TABLES.includes(fk.parent),
        `${fk.child} → ${fk.parent} (${fk.name}): solo calendars e tabelle dell'indice sono ammesse`,
      );
    }
    // Le tabelle dei lavori non referenziano nulla: sopravvivono a qualsiasi import.
    assert.deepEqual([...fks].filter((fk) => JOB_TABLES.includes(fk.child)), []);
    // E nessuna tabella F2 è referenziata da tabelle esistenti (calendar_events resta com'era).
    const incoming = await sql<Array<{ child: string }>>`
      SELECT c.conrelid::regclass::text AS child FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid::regclass::text = ANY(${F2_TABLES}::text[])
        AND NOT (c.conrelid::regclass::text = ANY(${F2_TABLES}::text[]))
    `;
    assert.deepEqual([...incoming], []);
  });

  test('tutte le tabelle 163-164 sono nel gruppo S del backup JSON', () => {
    for (const table of F2_TABLES) assert.equal(backupGroup(`public.${table}`), 'state', table);
  });

  test('calendar_events non ha trigger né colonne della F2', async () => {
    const triggers = await sql<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'calendar_events'::regclass AND NOT tgisinternal AND tgname LIKE 'cal\\_%'
    `;
    assert.deepEqual([...triggers], []);
    const cols = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'calendar_events' AND column_name LIKE 'caldes\\_%'
    `;
    assert.deepEqual([...cols], [], 'le colonne caldes_* nascono con la 166 (F4), non qui');
  });

  test('idempotenti: rieseguite su uno schema già migrato non falliscono e non cambiano il catalogo', async () => {
    const catalog = async (tx: Tx) => Array.from(await tx`
      SELECT c.relname, c.relkind, count(a.attname)::int AS columns
      FROM pg_class c
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'cal\\_%'
      GROUP BY c.relname, c.relkind ORDER BY c.relname
    `, (r: Record<string, unknown>) => ({ ...r }));
    await inRollback(async (tx) => {
      const before = await catalog(tx);
      await tx.unsafe(MIGRATION_163);
      await tx.unsafe(MIGRATION_164);
      await tx.unsafe(MIGRATION_163);
      assert.deepEqual(await catalog(tx), before);
    });
  });

  test('indice GiST parziale su span WHERE blocks e span generata', async () => {
    const [idx] = await sql<Array<{ def: string }>>`
      SELECT pg_get_indexdef('cal_occurrences_blocks_span_idx'::regclass) AS def
    `;
    assert.match(idx.def, /USING gist \(span\) WHERE blocks/);
    const [col] = await sql<Array<{ generated: string; expr: string }>>`
      SELECT a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS expr
      FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'cal_occurrences'::regclass AND a.attname = 'span'
    `;
    assert.equal(col.generated, 's');
    assert.match(col.expr, /tstzrange\(start_utc, end_utc, '\[\)'::text\)/);
  });
});

// ─── Dati di forma produttiva e query di busy ───────────────

describe('163: indice con i dati di produzione e busy del design §7', () => {
  test('serie infinita lun-mar-gio-ven in c, festività e chiusura in f, proiezione in bookings, iscrizione', async () => {
    await inRollback(async (tx) => {
      const c = await insertCalendar(tx, 'tst-index-163-c', 'tst-index-163 Creattivamente');
      const f = await insertCalendar(tx, 'tst-index-163-f', 'Festività e chiusure', { is_system: false });
      const [{ id: bookings }] = await tx`SELECT id FROM calendars WHERE slug = 'bookings'`;
      const [{ role: fRole }] = await tx`SELECT role FROM calendars WHERE id = ${f}`;
      assert.equal(fRole, 'holidays', 'la 162 riconosce le festività per nome anche con is_system=false');

      for (const id of [c, f, bookings]) {
        await collectionState(tx, id, {
          health: 'healthy',
          sync_token: 'http://radicale.org/ns/sync/1',
          dir_mtime_ns: '1760000000123456789',
          horizon_start: '2025-09-04T00:00:00Z',
          horizon_end: '2028-12-18T00:00:00Z',
        });
      }

      // Serie infinita "Gestione Creattivamente": lun-mar-gio-ven 09:00 Roma.
      const series = await insertObject(tx, { calendarId: c, href: '2wsjr1bwyux7g3h1.ics', uid: '2wsjr1bwyux7g3h1', isRecurring: true });
      await tx`UPDATE cal_components SET rrule = 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', tzid = 'Europe/Rome' WHERE id = ${series}`;
      // Settimana del cambio d'ora (25/10/2026): 09:00 Roma = 07:00Z prima, 08:00Z dopo.
      for (const [date, startZ] of [
        ['2026-10-22', '2026-10-22T07:00:00Z'], ['2026-10-23', '2026-10-23T07:00:00Z'],
        ['2026-10-26', '2026-10-26T08:00:00Z'], ['2026-10-27', '2026-10-27T08:00:00Z'],
      ] as const) {
        assert.equal(romeIso(date, '09:00'), new Date(startZ).toISOString());
        await insertOccurrence(tx, {
          objectId: series, calendarId: c, key: recurrenceKeyForInstant(new Date(startZ)),
          start: startZ, end: new Date(new Date(startZ).getTime() + 3_600_000).toISOString(),
        });
      }

      // Festività di sistema (timed 00:00→24:00 Roma) e chiusura manuale in f.
      const holiday = await insertObject(tx, { calendarId: f, href: 'it-holiday-2026-11-01.ics', uid: 'it-holiday-2026-11-01@caldes.it', source: 'system', sourceId: 'it-holiday-2026-11-01' });
      await insertOccurrence(tx, { objectId: holiday, calendarId: f, key: '', kind: 'holiday_system', start: romeIso('2026-11-01'), end: romeIso('2026-11-02') });
      const closure = await insertObject(tx, { calendarId: f, href: 'closure-ferie.ics', uid: 'ferie-2026', source: 'admin' });
      await insertOccurrence(tx, { objectId: closure, calendarId: f, key: '', kind: 'closure', start: romeIso('2026-10-28'), end: romeIso('2026-10-29') });

      // Proiezione di una prenotazione: mai nel busy (design §9).
      const projection = await insertObject(tx, { calendarId: bookings, href: 'booking-abc123def456.ics', uid: 'abc123def456@caldes.it', source: 'booking', sourceId: 'abc123def456' });
      await insertOccurrence(tx, { objectId: projection, calendarId: bookings, key: '', kind: 'booking_projection', blocks: false, start: '2026-10-22T13:00:00Z', end: '2026-10-22T13:30:00Z' });

      // Iscrizione: sidecar role=subscription con padre c; blocca solo con entrambi i flag.
      const sub = await insertCalendar(tx, 'tst-index-163-sub', 'tst-index-163 Iscrizione', { role: 'subscription', parent_calendar_id: c, origin: 'admin' });
      await tx`
        INSERT INTO calendar_subscriptions ${tx({ calendar_id: c, collection_calendar_id: sub, name: 'tst-index-163 feed', ics_url: 'https://example.test/feed.ics' })}
      `;
      await collectionState(tx, sub, { origin_store: 'remote', health: 'healthy' });
      const remote = await insertObject(tx, { calendarId: sub, href: 'r-aaaaaaaaaaaaaaaaaaaaaaaaaa.ics', uid: 'remote-1@google.com', source: 'ics_pull', sourceId: 'remote-1@google.com', originStore: 'remote' });
      await insertOccurrence(tx, { objectId: remote, calendarId: sub, key: '', start: '2026-10-23T14:00:00Z', end: '2026-10-23T15:00:00Z' });

      const from = '2026-10-19T00:00:00Z';
      const to = '2026-11-02T00:00:00Z';
      const expectedBase = [
        { start: '2026-10-22T07:00:00.000Z', end: '2026-10-22T08:00:00.000Z' },
        { start: '2026-10-23T07:00:00.000Z', end: '2026-10-23T08:00:00.000Z' },
        { start: '2026-10-26T08:00:00.000Z', end: '2026-10-26T09:00:00.000Z' },
        { start: '2026-10-27T08:00:00.000Z', end: '2026-10-27T09:00:00.000Z' },
        { start: '2026-10-27T23:00:00.000Z', end: '2026-10-28T23:00:00.000Z' },
        { start: '2026-10-31T23:00:00.000Z', end: '2026-11-01T23:00:00.000Z' },
      ];
      assert.deepEqual(await busy(tx, from, to), expectedBase, 'iscrizione non bloccante di default, proiezione esclusa');

      await tx`UPDATE calendar_subscriptions SET blocks_availability = true WHERE collection_calendar_id = ${sub}`;
      const withSub = await busy(tx, from, to);
      assert.equal(withSub.length, expectedBase.length + 1);
      assert.ok(withSub.some((r) => r.start === '2026-10-23T14:00:00.000Z'), 'iscrizione bloccante con entrambi i flag');

      await tx`UPDATE calendars SET blocks_availability = false WHERE id = ${c}`;
      const parentOff = await busy(tx, from, to);
      assert.ok(!parentOff.some((r) => r.start === '2026-10-23T14:00:00.000Z'), 'il padre non bloccante spegne anche l\'iscrizione');
      assert.ok(!parentOff.some((r) => r.start === '2026-10-22T07:00:00.000Z'), 'calendario non bloccante: la serie non blocca');

      // Sovrapposizione, non contenimento: un evento iniziato prima della finestra blocca.
      assert.deepEqual(await busy(tx, '2026-10-28T12:00:00Z', '2026-10-28T13:00:00Z'), [
        { start: '2026-10-27T23:00:00.000Z', end: '2026-10-28T23:00:00.000Z' },
      ]);

      // Il piano usa l'indice parziale (con le scansioni sequenziali disattivate:
      // con pochi dati il planner le preferirebbe comunque).
      await tx`SET LOCAL enable_seqscan = off`;
      const plan = (await tx`
        EXPLAIN SELECT 1 FROM cal_occurrences o
        WHERE o.blocks AND o.span && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')
      `).map((r: Record<string, string>) => Object.values(r)[0]).join('\n');
      assert.match(plan, /cal_occurrences_blocks_span_idx/);
    });
  });

  test('all-day: date obbligatorie e ordinate; chiave YYYYMMDD', async () => {
    await inRollback(async (tx) => {
      const cal = await insertCalendar(tx, 'tst-index-163-ad', 'tst-index-163 All-day');
      const obj = await insertObject(tx, { calendarId: cal, href: 'compleanno.ics', uid: 'compleanno', isRecurring: true });
      const key = recurrenceKeyForDate('2026-12-25');
      assert.equal(key, '20261225');
      await insertOccurrence(tx, {
        objectId: obj, calendarId: cal, key, allDay: true, blocks: false,
        start: romeIso('2026-12-25'), end: romeIso('2026-12-26'), startDate: '2026-12-25', endDate: '2026-12-26',
      });
      await expectSqlError(tx, (sp) => insertOccurrence(sp, {
        objectId: obj, calendarId: cal, key: '20261226', allDay: true, blocks: false,
        start: romeIso('2026-12-26'), end: romeIso('2026-12-27'),
      }), /cal_occurrences_allday_check/);
      await expectSqlError(tx, (sp) => insertOccurrence(sp, {
        objectId: obj, calendarId: cal, key: '20261227', allDay: true, blocks: false,
        start: romeIso('2026-12-27'), end: romeIso('2026-12-28'), startDate: '2026-12-28', endDate: '2026-12-27',
      }), /cal_occurrences_allday_check/);
    });
  });
});

// ─── Vincoli ───────────────────────────────────────────────

describe('163: vincoli di indice, salute e id', () => {
  test('recurrence_key: formato canonico, conservative solo per il blocco conservativo', async () => {
    await inRollback(async (tx) => {
      const cal = await insertCalendar(tx, 'tst-index-163-rk', 'tst-index-163 Chiavi');
      const obj = await insertObject(tx, { calendarId: cal, href: 'serie.ics', uid: 'serie', isRecurring: true });
      for (const bad of ['2026-10-22T07:00:00Z', '20261022t070000z', '20261022T0700Z', 'x']) {
        await expectSqlError(tx, (sp) => sp`
          INSERT INTO cal_object_ids (calendar_id, href, recurrence_key) VALUES (${cal}, 'serie.ics', ${bad})
        `, /cal_object_ids_recurrence_key_check/);
      }
      await expectSqlError(tx, (sp) => sp`
        INSERT INTO cal_object_ids (calendar_id, href, recurrence_key) VALUES (${cal}, 'serie.ics', 'conservative')
      `, /cal_object_ids_recurrence_key_check/);
      // Chiave floating (ora da muro, come recurrenceKeyOf di calendar-core) ammessa.
      await tx`INSERT INTO cal_object_ids (calendar_id, href, recurrence_key) VALUES (${cal}, 'serie.ics', '20261022T090000')`;
      // Blocco conservativo di un oggetto illeggibile: chiave 'conservative' senza componente.
      await insertOccurrence(tx, { objectId: obj, calendarId: cal, key: 'conservative', kind: 'conservative', componentId: null, start: '2026-10-01T00:00:00Z', end: '2027-10-01T00:00:00Z' });
      await expectSqlError(tx, (sp) => sp`UPDATE cal_occurrences SET component_id = ${obj} WHERE object_id = ${obj} AND recurrence_key = 'conservative'`, /cal_occurrences_conservative_key_check/);
      // Budget di espansione esaurito: kind conservative con la chiave dell'espansione.
      await insertOccurrence(tx, { objectId: obj, calendarId: cal, key: '', kind: 'conservative', start: '2026-10-01T07:00:00Z', end: '2027-10-01T08:00:00Z' });
      await expectSqlError(tx, (sp) => insertOccurrence(sp, { objectId: obj, calendarId: cal, key: '20261001T070000Z', kind: 'booking_projection', blocks: true, start: '2026-10-01T07:00:00Z', end: '2026-10-01T08:00:00Z' }), /cal_occurrences_projection_check/);
      await expectSqlError(tx, (sp) => insertOccurrence(sp, { objectId: obj, calendarId: cal, key: '20261001T080000Z', kind: 'nuovo', start: '2026-10-01T08:00:00Z', end: '2026-10-01T09:00:00Z' }), /cal_occurrences_kind_check/);
      await expectSqlError(tx, (sp) => insertOccurrence(sp, { objectId: obj, calendarId: cal, key: '20261001T090000Z', start: '2026-10-01T10:00:00Z', end: '2026-10-01T09:00:00Z' }), /cal_occurrences_range_check|range lower bound must be less than or equal/);
    });
  });

  test('salute: health_since coerente, motivo nel formato, hold con hold_since, remote senza token né etag', async () => {
    await inRollback(async (tx) => {
      const cal = await insertCalendar(tx, 'tst-index-163-h', 'tst-index-163 Salute');
      const obj = await insertObject(tx, { calendarId: cal, href: 'rotto.ics', uid: 'rotto' });
      await tx`UPDATE cal_objects SET health = 'quarantined', health_reason = 'radicale-skip', health_since = now() WHERE id = ${obj}`;
      await expectSqlError(tx, (sp) => sp`UPDATE cal_objects SET health = 'quarantined', health_since = NULL WHERE id = ${obj}`, /cal_objects_health_ok_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE cal_objects SET health_reason = 'Parse Error' WHERE id = ${obj}`, /cal_objects_health_reason_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE cal_objects SET source = 'google' WHERE id = ${obj}`, /cal_objects_source_check/);
      await tx`UPDATE cal_objects SET health = 'ok', health_reason = NULL, health_since = NULL WHERE id = ${obj}`;

      await collectionState(tx, cal);
      const [state] = await tx`SELECT health, index_version, pending_deletions, consecutive_failures FROM cal_collection_state WHERE calendar_id = ${cal}`;
      assert.deepEqual({ ...state }, { health: 'stale', index_version: '0', pending_deletions: [], consecutive_failures: 0 });
      await expectSqlError(tx, (sp) => sp`UPDATE cal_collection_state SET health = 'hold' WHERE calendar_id = ${cal}`, /cal_collection_state_hold_check/);
      await tx`
        UPDATE cal_collection_state
        SET health = 'hold', hold_since = now(), hold_reason = 'mass_delete', pending_deletions = ARRAY['a.ics', 'b.ics']
        WHERE calendar_id = ${cal}
      `;
      await expectSqlError(tx, (sp) => sp`UPDATE cal_collection_state SET horizon_start = '2026-01-01Z' WHERE calendar_id = ${cal}`, /cal_collection_state_horizon_check/);

      const sub = await insertCalendar(tx, 'tst-index-163-hr', 'tst-index-163 Remota');
      await expectSqlError(tx, (sp) => collectionState(sp, sub, { origin_store: 'remote', sync_token: 'x' }), /cal_collection_state_remote_check/);
      await expectSqlError(tx, (sp) => insertObject(sp, { calendarId: sub, href: 'r-x.ics', uid: 'x', originStore: 'remote', raw: 'BEGIN:VCALENDAR' }).then(() => sp`UPDATE cal_objects SET etag = '"1"' WHERE href = 'r-x.ics'`), /cal_objects_remote_etag_check/);
    });
  });

  test('cal_objects: un href per collezione; componenti: una chiave per oggetto, override con RECURRENCE-ID', async () => {
    await inRollback(async (tx) => {
      const cal = await insertCalendar(tx, 'tst-index-163-u', 'tst-index-163 Unicità');
      const obj = await insertObject(tx, { calendarId: cal, href: 'doppio.ics', uid: 'doppio', isRecurring: true });
      await expectSqlError(tx, (sp) => sp`
        INSERT INTO cal_object_ids (calendar_id, href, recurrence_key) VALUES (${cal}, 'doppio.ics', '')
      `, /cal_object_ids_key/);
      const [{ id: ovId }] = await tx`
        INSERT INTO cal_object_ids (calendar_id, href, recurrence_key, uid) VALUES (${cal}, 'doppio.ics', '20261022T070000Z', 'doppio') RETURNING id
      `;
      await expectSqlError(tx, (sp) => sp`
        INSERT INTO cal_components ${sp({ id: ovId, object_id: obj, calendar_id: cal, recurrence_key: '20261022T070000Z' })}
      `, /cal_components_override_check/);
      await tx`
        INSERT INTO cal_components ${tx({ id: ovId, object_id: obj, calendar_id: cal, recurrence_key: '20261022T070000Z', recurrence_id_utc: '2026-10-22T07:00:00Z', orphan: true })}
      `;
      await expectSqlError(tx, (sp) => sp`UPDATE cal_components SET orphan = true WHERE id = ${obj}`, /cal_components_orphan_check/);
    });
  });
});

// ─── Cascate e persistenza ─────────────────────────────────

describe('163: cascate, id e versioni persistenti', () => {
  test('rebuild di una collezione: oggetti, componenti e occorrenze spariscono, id e versioni restano', async () => {
    await inRollback(async (tx) => {
      const cal = await insertCalendar(tx, 'tst-index-163-rb', 'tst-index-163 Rebuild');
      await collectionState(tx, cal, { health: 'healthy', index_version: 3 });
      const obj = await insertObject(tx, { calendarId: cal, href: 'evento.ics', uid: 'evento' });
      await insertOccurrence(tx, { objectId: obj, calendarId: cal, key: '', start: '2026-10-22T07:00:00Z', end: '2026-10-22T08:00:00Z' });
      const [{ id: version }] = await tx`
        INSERT INTO cal_object_versions (object_id, calendar_id, href, etag, raw_ics, change_kind, valid, actor)
        VALUES (${obj}, ${cal}, 'evento.ics', '"evento.ics-1"', 'BEGIN:VCALENDAR', 'create', true, 'sync')
        RETURNING id
      `;
      await tx`UPDATE cal_objects SET last_good_version_id = ${version} WHERE id = ${obj}`;

      // Rebuild atomico della collezione (design §6.7): delete e reinsert in una tx.
      await tx`DELETE FROM cal_objects WHERE calendar_id = ${cal}`;
      const [counts] = await tx`
        SELECT (SELECT count(*)::int FROM cal_components WHERE calendar_id = ${cal}) AS components,
               (SELECT count(*)::int FROM cal_occurrences WHERE calendar_id = ${cal}) AS occurrences,
               (SELECT count(*)::int FROM cal_object_ids WHERE calendar_id = ${cal}) AS ids,
               (SELECT count(*)::int FROM cal_object_versions WHERE calendar_id = ${cal}) AS versions
      `;
      assert.deepEqual({ ...counts }, { components: 0, occurrences: 0, ids: 1, versions: 1 });
      // Lo stesso href ritrova lo stesso id.
      const [{ id: again }] = await tx`SELECT id FROM cal_object_ids WHERE calendar_id = ${cal} AND href = 'evento.ics' AND recurrence_key = ''`;
      assert.equal(again, obj);
    });
  });

  test('versioni: la purge azzera last_good_version_id; testo obbligatorio salvo per le cancellazioni', async () => {
    await inRollback(async (tx) => {
      const cal = await insertCalendar(tx, 'tst-index-163-v', 'tst-index-163 Versioni');
      const obj = await insertObject(tx, { calendarId: cal, href: 'v.ics', uid: 'v' });
      const [{ id: version }] = await tx`
        INSERT INTO cal_object_versions (object_id, calendar_id, href, raw_ics, change_kind, valid)
        VALUES (${obj}, ${cal}, 'v.ics', 'BEGIN:VCALENDAR', 'update', true) RETURNING id
      `;
      await tx`UPDATE cal_objects SET last_good_version_id = ${version} WHERE id = ${obj}`;
      await tx`DELETE FROM cal_object_versions WHERE id = ${version}`;
      const [{ last_good_version_id: lg }] = await tx`SELECT last_good_version_id FROM cal_objects WHERE id = ${obj}`;
      assert.equal(lg, null);
      await tx`
        INSERT INTO cal_object_versions (object_id, calendar_id, href, raw_ics, change_kind, valid)
        VALUES (${obj}, ${cal}, 'v.ics', NULL, 'delete', false)
      `;
      await expectSqlError(tx, (sp) => sp`
        INSERT INTO cal_object_versions (object_id, calendar_id, href, raw_ics, change_kind, valid)
        VALUES (${obj}, ${cal}, 'v.ics', NULL, 'update', false)
      `, /cal_object_versions_raw_check/);
      await expectSqlError(tx, (sp) => sp`
        INSERT INTO cal_object_versions (object_id, calendar_id, href, raw_ics, content_sha256, change_kind, valid)
        VALUES (${obj}, ${cal}, 'v.ics', 'x', 'ABC', 'update', true)
      `, /cal_object_versions_sha_check/);
    });
  });

  test('delete del calendario: tutto l\'indice della collezione sparisce in cascata, legacy_event_id senza FK', async () => {
    await inRollback(async (tx) => {
      const cal = await insertCalendar(tx, 'tst-index-163-del', 'tst-index-163 Cancellato');
      await collectionState(tx, cal);
      const obj = await insertObject(tx, { calendarId: cal, href: 'e.ics', uid: 'e' });
      // legacy_event_id che non esiste in calendar_events: ammesso (nessuna FK).
      await tx`UPDATE cal_object_ids SET legacy_event_id = gen_random_uuid(), legacy_uid = 'legacy-e' WHERE id = ${obj}`;
      await insertOccurrence(tx, { objectId: obj, calendarId: cal, key: '', start: '2026-10-22T07:00:00Z', end: '2026-10-22T08:00:00Z' });
      await tx`INSERT INTO cal_object_versions (object_id, calendar_id, href, raw_ics, change_kind, valid) VALUES (${obj}, ${cal}, 'e.ics', 'x', 'create', true)`;
      await tx`DELETE FROM calendars WHERE id = ${cal}`;
      const [left] = await tx`
        SELECT (SELECT count(*)::int FROM cal_object_ids WHERE id = ${obj}) +
               (SELECT count(*)::int FROM cal_objects WHERE id = ${obj}) +
               (SELECT count(*)::int FROM cal_occurrences WHERE object_id = ${obj}) +
               (SELECT count(*)::int FROM cal_object_versions WHERE object_id = ${obj}) +
               (SELECT count(*)::int FROM cal_collection_state WHERE calendar_id = ${cal}) AS n
      `;
      assert.equal(left.n, 0);
    });
  });
});

// ─── Coda dei lavori e conflitti (164) ─────────────────────

describe('164: cal_jobs e cal_booking_conflicts', () => {
  test('coalescenza solo sui pending: due pending con la stessa chiave no, running + pending sì', async () => {
    await inRollback(async (tx) => {
      await tx`INSERT INTO cal_jobs (kind, key) VALUES ('project_booking', 'abc')`;
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_jobs (kind, key) VALUES ('project_booking', 'abc')`, /cal_jobs_pending_key/);
      await tx`
        UPDATE cal_jobs SET status = 'running', lease_token = gen_random_uuid(), locked_until = now() + interval '1 minute', attempts = 1
        WHERE kind = 'project_booking' AND key = 'abc'
      `;
      await tx`INSERT INTO cal_jobs (kind, key) VALUES ('project_booking', 'abc')`;
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM cal_jobs WHERE kind = 'project_booking' AND key = 'abc'`;
      assert.equal(n, 2);
    });
  });

  test('lease e chiusura coerenti con lo stato; tipo e chiave nel formato', async () => {
    await inRollback(async (tx) => {
      const [{ id }] = await tx`INSERT INTO cal_jobs (kind, key, payload) VALUES ('index_rebuild', 'all', '{"reason":"test"}') RETURNING id`;
      await expectSqlError(tx, (sp) => sp`UPDATE cal_jobs SET status = 'running' WHERE id = ${id}`, /cal_jobs_lease_check/);
      await expectSqlError(tx, (sp) => sp`UPDATE cal_jobs SET status = 'done' WHERE id = ${id}`, /cal_jobs_finished_check/);
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_jobs (kind, key) VALUES ('Project-Booking', 'x')`, /cal_jobs_kind_check/);
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_jobs (kind, key) VALUES ('ok', '')`, /cal_jobs_key_check/);
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_jobs (kind, key, payload) VALUES ('ok', 'k', '[]')`, /cal_jobs_payload_check/);
      await tx`UPDATE cal_jobs SET status = 'dead', finished_at = now(), last_error = 'x' WHERE id = ${id}`;
    });
  });

  test('conflitti: uno aperto per (prenotazione, oggetto, istanza); risoluzione con esito', async () => {
    await inRollback(async (tx) => {
      const row = {
        booking_id: '7b2f4c1e-9d3a-4e8b-a6f0-1c2d3e4f5a6b', booking_uid: 'abc123def456',
        calendar_id: '8c3f5d2e-0e4b-4f9c-b7a1-2d3e4f5a6b7c', object_id: '9d4a6e3f-1f5c-4a0d-88b2-3e4f5a6b7c8d',
        recurrence_key: '20261022T070000Z',
        booking_start: '2026-10-22T07:00:00Z', booking_end: '2026-10-22T07:30:00Z',
        event_start: '2026-10-22T07:00:00Z', event_end: '2026-10-22T08:00:00Z', detected_by: 'post_commit',
      };
      await tx`INSERT INTO cal_booking_conflicts ${tx(row)}`;
      await expectSqlError(tx, (sp) => sp`INSERT INTO cal_booking_conflicts ${sp(row)}`, /cal_booking_conflicts_open_key/);
      await expectSqlError(tx, (sp) => sp`UPDATE cal_booking_conflicts SET resolved_at = now() WHERE booking_uid = 'abc123def456'`, /cal_booking_conflicts_resolution_check/);
      await tx`UPDATE cal_booking_conflicts SET resolved_at = now(), resolved_by = 'admin', resolution = 'evento spostato' WHERE booking_uid = 'abc123def456'`;
      await tx`INSERT INTO cal_booking_conflicts ${tx({ ...row, detected_by: 'auditor' })}`;
    });
  });
});

// ─── NOTIFY ────────────────────────────────────────────────

describe('163: NOTIFY calendar_index_changed', () => {
  test('al commit di un index_version più alto; non per gli altri aggiornamenti', async () => {
    const cal = await fx.calendar({ key: 'notify', name: fx.name('Notify') });
    const received: Array<{ calendar_id: string; index_version: number }> = [];
    const sub = await sql.listen('calendar_index_changed', (payload) => {
      const parsed = JSON.parse(payload) as { calendar_id: string; index_version: number };
      if (parsed.calendar_id === cal.id) received.push(parsed);
    });
    try {
      const waitFor = async (n: number) => {
        for (let i = 0; i < 100 && received.length < n; i++) await new Promise((r) => setTimeout(r, 20));
      };
      await sql`INSERT INTO cal_collection_state (calendar_id) VALUES (${cal.id})`;
      await sql`UPDATE cal_collection_state SET index_version = index_version + 1 WHERE calendar_id = ${cal.id}`;
      await waitFor(1);
      await sql`UPDATE cal_collection_state SET health = 'healthy', last_synced_at = now() WHERE calendar_id = ${cal.id}`;
      await sql`UPDATE cal_collection_state SET index_version = index_version + 1 WHERE calendar_id = ${cal.id}`;
      await waitFor(2);
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(received, [
        { calendar_id: cal.id, index_version: 1 },
        { calendar_id: cal.id, index_version: 2 },
      ]);
    } finally {
      await sub.unlisten();
    }
    // updated_at gestito dal trigger.
    const [{ fresh }] = await sql<Array<{ fresh: boolean }>>`
      SELECT updated_at > now() - interval '1 minute' AS fresh FROM cal_collection_state WHERE calendar_id = ${cal.id}
    `;
    assert.equal(fresh, true);
  });
});
