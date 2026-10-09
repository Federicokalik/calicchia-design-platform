/**
 * Inventario del calendario (scripts/calendar-inventory.ts e
 * scripts/sql/calendar-inventory.sql): fase F0, attività 1 del piano.
 *
 * Verifica che:
 *  - il file SQL del repository sia valido, di sola lettura e copra le
 *    anomalie del design §13.4 che si possono contare in SQL;
 *  - il parser rifiuti istruzioni che scrivono, bloccano o sono multiple;
 *  - su dati noti (fixture con prefisso, baseline del calendario) i conteggi
 *    delle anomalie siano esatti, a partire dalle eccezioni DST (timed e
 *    all-day), e che exdates sporchi non facciano fallire le query;
 *  - il report non contenga testo libero (titoli, nomi) né credenziali o
 *    token degli URL delle iscrizioni;
 *  - la sola lettura sia garantita dal database (una funzione che scrive
 *    fallisce nel suo savepoint, le altre query proseguono) e nulla cambi;
 *  - la CLI scriva JSON e Markdown con permessi 0600 e usi gli exit code
 *    documentati.
 * Gira contro TEST_DATABASE_URL come gli altri test (lo script apre una
 * connessione propria, in sola lettura). Le date sono fisse nel 2027 e nessuna
 * asserzione dipende da now() (le query 06, 13 e 14 lo usano per le colonne
 * "da oltre 5 anni", "future" e "prossimi 180 giorni", che qui non si asseriscono).
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  assertReadOnlySelect,
  DEFAULT_SQL_PATH,
  InventorySqlError,
  main,
  parseInventorySql,
  renderInventoryMarkdown,
  REPORT_FILES,
  REPORT_SCHEMA,
  runCalendarInventory,
  type InventoryReport,
} from '../../scripts/calendar-inventory';
import { TEST_DATABASE } from '../helpers/env';
import { sql } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';

const fx = useFixtures('inventario-calendario', { resetBaseline: true });

/** Directory temporanea del file (SQL di prova e report), rimossa a fine file. */
const WORK_DIR = mkdtempSync(join(tmpdir(), 'caldes-inventory-test-'));
after(() => rmSync(WORK_DIR, { recursive: true, force: true }));

/** Codici del design §13.4 contati dall'inventario SQL. */
const EXPECTED_ANOMALY_CODES = [
  'ALLDAY_AMBIGUOUS',
  'ALLDAY_UNTIL_DATETIME',
  'BOOKING_DRIFT',
  'DST_SHIFTED_EXCEPTION',
  'DUPLICATE_HOLIDAY',
  'ICS_PULL_REFETCH',
  'INVALID_RRULE',
  'NON_CANONICAL_APP_PASSWORD',
  'NON_PROJECTION_IN_BOOKINGS',
  'NON_ROME_SERIES',
  'ORPHAN_OVERRIDE_NOT_IN_RULE',
  'OVERRIDE_CALENDAR_MISMATCH',
  'RADICALE_RRULE_LIMIT',
  'SUBSCRIPTION_BLOCKING_IMPACT',
  'UNTIL_ADMIN_PATTERN',
  'UNTIL_BEFORE_DTSTART',
];

/** SQL di prova nel formato dell'inventario, scritto nella directory temporanea. */
function writeSql(name: string, body: string): string {
  const path = join(WORK_DIR, name);
  writeFileSync(path, body);
  return path;
}

const SESSION_QUERY = `-- @query 00_sessione | Sessione
SELECT current_database() AS database, current_setting('transaction_read_only') AS transaction_read_only;
`;

test('il file SQL del repository è valido, di sola lettura e copre le anomalie del design §13.4', () => {
  const queries = parseInventorySql(readFileSync(DEFAULT_SQL_PATH, 'utf8'));
  assert.equal(queries[0].key, '00_sessione');
  assert.equal(new Set(queries.map((q) => q.key)).size, queries.length);
  assert.ok(queries.length >= 30, `${queries.length} query`);
  for (const q of queries) {
    assert.ok(q.title.length > 0, q.key);
    assert.doesNotThrow(() => assertReadOnlySelect(q.key, q.sql));
  }
  const codes = [...new Set(queries.flatMap((q) => q.anomalies.map((a) => a.code)))].sort();
  assert.deepEqual(codes, EXPECTED_ANOMALY_CODES);
  // La query delle eccezioni DST è la stessa della 19 di docs/ (base di fix-dst-exceptions.ts).
  assert.ok(queries.find((q) => q.key === '19b_eccezioni_dst')?.anomalies.some((a) => a.code === 'DST_SHIFTED_EXCEPTION'));
});

test('il parser rifiuta istruzioni che scrivono, bloccano o sono multiple', () => {
  const wrap = (query: string): string => `${SESSION_QUERY}-- @query 01_prova | Prova\n${query}\n-- @end\n`;
  const rejected: Array<[string, RegExp]> = [
    ['UPDATE calendars SET name = name;', /deve iniziare con SELECT o WITH/],
    ['WITH x AS (DELETE FROM calendars RETURNING id) SELECT * FROM x;', /parola non ammessa "DELETE"/],
    ['SELECT * INTO copia FROM calendars;', /parola non ammessa "INTO"/],
    ['SELECT * FROM calendars FOR UPDATE;', /parola non ammessa "UPDATE"/],
    ['SELECT * FROM calendars FOR SHARE;', /clausole di lock non ammesse/],
    ['SELECT 1; SELECT 2;', /una sola istruzione/],
    ['SELECT $$x$$;', /Dollar quoting non ammesso/],
    ["SELECT 'non chiusa;", /Stringa ' non chiusa/],
  ];
  for (const [query, reason] of rejected) {
    assert.throws(() => parseInventorySql(wrap(query)), (err: Error) => err instanceof InventorySqlError && reason.test(err.message), query);
  }
  // Le stesse parole dentro stringhe, identificatori quotati e commenti sono ammesse.
  const ok = parseInventorySql(wrap(`SELECT 'DELETE; UPDATE' AS "INSERT", 1 AS uno -- DROP TABLE\nFROM calendars;`));
  assert.equal(ok[1].sql.startsWith('SELECT'), true);

  assert.throws(() => parseInventorySql(`${SESSION_QUERY}`), /Manca il marcatore finale/);
  assert.throws(() => parseInventorySql('-- @query 01_x | X\nSELECT 1;\n-- @end\n'), /Manca la query 00_sessione/);
  assert.throws(() => parseInventorySql(wrap('-- @anomalia X\nSELECT 1;')), /Annotazione sconosciuta/);
  assert.throws(() => parseInventorySql(wrap('-- @anomaly X when=\nSELECT 1;')), /Annotazione @anomaly non valida/);
  assert.throws(() => parseInventorySql(`${SESSION_QUERY}${SESSION_QUERY}-- @end\n`), /Chiave di query duplicata/);
});

let report: InventoryReport;

test('report su dati noti: sessione in sola lettura e conteggi esatti delle anomalie', async () => {
  const lavoro = await fx.calendar({ key: 'lavoro' });
  const [bookings] = await sql<Array<{ id: string }>>`SELECT id FROM calendars WHERE slug = 'bookings'`;

  // Serie creata a settembre alle 09:00 di Roma (07:00Z, ora legale): EXDATE
  // e override cancellato salvati a novembre alle 07:00Z come faceva il codice
  // prima di d046006 (DST_SHIFTED_EXCEPTION), più un EXDATE e un override
  // allineati che non vanno contati.
  const dst = await fx.series({
    calendar: lavoro,
    summary: 'Serie DST',
    start_time: romeIso('2027-09-06', '09:00'),
    end_time: romeIso('2027-09-06', '10:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=12',
    exdates: ['2027-09-13T07:00:00.000Z', '2027-11-08T07:00:00.000Z'],
    overrides: [
      { originalStart: '2027-09-20T07:00:00.000Z', status: 'cancelled' },
      { originalStart: '2027-11-15T07:00:00.000Z', status: 'cancelled' },
    ],
  });
  // Serie all-day (mezzanotte di Roma del mercoledì, 22:00Z in ora legale):
  // EXDATE e override cancellato alle 22:00Z di novembre, la vecchia griglia.
  // Stessa firma delle timed: contati anche loro.
  const allDay = await fx.series({
    calendar: lavoro,
    summary: 'Serie all-day DST',
    start_time: romeIso('2027-09-01'),
    end_time: romeIso('2027-09-02'),
    all_day: true,
    rrule: 'FREQ=WEEKLY;COUNT=20',
    exdates: ['2027-11-09T22:00:00.000Z'],
    overrides: [{ originalStart: '2027-11-16T22:00:00.000Z', status: 'cancelled' }],
  });
  // Exdates sporchi (createEvent non li valida): un elemento non interpretabile
  // non deve far fallire la 19b né nascondere l'eccezione DST valida accanto.
  const dirty = await fx.series({
    calendar: lavoro,
    summary: 'Exdates sporchi',
    start_time: romeIso('2027-09-01', '09:00'),
    end_time: romeIso('2027-09-01', '10:00'),
    rrule: 'FREQ=WEEKLY;COUNT=12',
    exdates: ['2027-11-17T07:00:00.000Z', 'non-una-data', '2027-02-30T07:00:00.000Z'],
  });
  // exdates che non è un array JSON (dato legacy scritto via SQL): né la 02 né la 19b falliscono.
  const notArray = await fx.series({
    calendar: lavoro,
    summary: 'Exdates oggetto',
    start_time: romeIso('2027-03-01', '09:00'),
    end_time: romeIso('2027-03-01', '10:00'),
    rrule: 'FREQ=DAILY;COUNT=3',
  });
  await sql`UPDATE calendar_events SET exdates = '{"data":"2027-03-02"}'::jsonb WHERE id = ${notArray.master.id}::uuid`;
  // "fino al" dell'editor: UNTIL a mezzanotte UTC.
  await fx.series({
    calendar: lavoro,
    summary: 'Fino al',
    start_time: romeIso('2027-01-04', '09:00'),
    end_time: romeIso('2027-01-04', '09:30'),
    rrule: 'FREQ=DAILY;UNTIL=20270110T000000Z',
  });
  // Stima di Radicale oltre 50000: HOURLY per sei anni (UNTIL non a
  // mezzanotte, per non contarla anche come "fino al").
  await fx.series({
    calendar: lavoro,
    summary: 'Oraria',
    start_time: '2027-01-04T08:00:00.000Z',
    end_time: '2027-01-04T08:15:00.000Z',
    rrule: 'FREQ=HOURLY;UNTIL=20330101T120000Z',
  });
  // RRULE con un carattere non ammesso in BYDAY: createEvent la rifiuterebbe,
  // quindi la si scrive direttamente come farebbe un dato legacy.
  const broken = await fx.series({
    calendar: lavoro,
    summary: 'Regola rotta',
    start_time: romeIso('2027-02-01', '09:00'),
    end_time: romeIso('2027-02-01', '10:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
  });
  await sql`UPDATE calendar_events SET rrule = 'FREQ=WEEKLY;BYDAY=MO WE;COUNT=3' WHERE id = ${broken.master.id}::uuid`;
  // Evento manuale nel calendario bookings (decisione 8) e una prenotazione con la sua proiezione.
  await fx.event({ calendar: bookings.id, summary: 'Manuale in bookings', source: 'admin', start_time: romeIso('2027-01-05', '15:00'), end_time: romeIso('2027-01-05', '16:00') });
  const eventType = await fx.eventType({ key: 'consulenza' });
  const booked = await fx.booking({ eventType, start: romeIso('2027-01-05', '10:00') });
  assert.ok(booked.projection);
  // App-password canonica e non canonica.
  await fx.appPassword();
  await fx.appPassword({ username: 'iphone', device: 'iPhone di prova' });
  // Iscrizione con etag salvato e nessuna riga (parseIcs scarta i VEVENT: bug
  // noto) → trappola del 304.
  const { subscription } = await fx.subscription({ calendar: lavoro, ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' });
  await sql`UPDATE calendar_subscriptions SET etag = '"tst-etag"' WHERE id = ${subscription.id}::uuid`;
  // URL con credenziali (createSubscription controlla solo lo schema) e con un
  // token nella query string senza percorso: nel report deve finire solo l'host.
  await fx.subscription({ calendar: lavoro, name: 'Nextcloud', url: 'https://federico:app-secret-123@Cloud.Example.com:8443/remote.php/dav/calendars/federico/personal?export' });
  await fx.subscription({ calendar: lavoro, name: 'Con token', url: 'https://calendar.example.com?token=s3cr3t' });

  const [before] = await sql<Array<{ audit: number; events: number }>>`
    SELECT (SELECT count(*)::int FROM audit_logs) AS audit, (SELECT count(*)::int FROM calendar_events) AS events
  `;

  report = await runCalendarInventory({ databaseUrl: TEST_DATABASE.url });

  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.sql_file, 'scripts/sql/calendar-inventory.sql');
  assert.match(report.sql_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.failed_queries, []);
  assert.equal(report.session.database, TEST_DATABASE.database);
  assert.equal(report.session.transaction_read_only, 'on');
  assert.equal(report.session.default_transaction_read_only, 'on');
  assert.equal(report.session.isolamento, 'repeatable read');
  assert.equal(report.session.fuso, 'UTC');
  assert.match(String(report.session.ultima_migrazione), /^\d{3}_/);

  const anomalies = Object.fromEntries(report.anomalies.map((a) => [a.code, a.count]));
  assert.deepEqual(anomalies, {
    // L'override cancellato dell'all-day è una riga all-day che inizia alle
    // 22:00Z di novembre (23:00 di Roma): né mezzanotte UTC né di Roma.
    ALLDAY_AMBIGUOUS: 1,
    ALLDAY_UNTIL_DATETIME: 0,
    BOOKING_DRIFT: 0,
    DST_SHIFTED_EXCEPTION: 5,
    DUPLICATE_HOLIDAY: 0,
    ICS_PULL_REFETCH: 1,
    INVALID_RRULE: 1,
    NON_CANONICAL_APP_PASSWORD: 1,
    NON_PROJECTION_IN_BOOKINGS: 1,
    NON_ROME_SERIES: 0,
    ORPHAN_OVERRIDE_NOT_IN_RULE: 0,
    OVERRIDE_CALENDAR_MISMATCH: 0,
    RADICALE_RRULE_LIMIT: 1,
    SUBSCRIPTION_BLOCKING_IMPACT: 0,
    UNTIL_ADMIN_PATTERN: 1,
    UNTIL_BEFORE_DTSTART: 0,
  });

  // Le eccezioni DST, con i valori salvati e il DTSTART della serie: le due
  // della serie timed, le due dell'all-day e quella valida degli exdates sporchi.
  const dstRows = report.queries.find((q) => q.key === '19b_eccezioni_dst')?.rows ?? [];
  const byMaster = (r: { master_id: unknown; tipo: unknown; valore: unknown }): string => `${r.master_id}|${r.tipo}|${r.valore}`;
  assert.deepEqual(
    dstRows.map((r) => [r.tipo, r.master_id, r.valore, r.dtstart]).sort((a, b) => byMaster({ tipo: a[0], master_id: a[1], valore: a[2] }).localeCompare(byMaster({ tipo: b[0], master_id: b[1], valore: b[2] }))),
    [
      ['exdate', dst.master.id, '2027-11-08T07:00:00.000Z', '2027-09-06T07:00:00.000Z'],
      ['override', dst.master.id, '2027-11-15T07:00:00.000Z', '2027-09-06T07:00:00.000Z'],
      ['exdate', allDay.master.id, '2027-11-09T22:00:00.000Z', '2027-08-31T22:00:00.000Z'],
      ['override', allDay.master.id, '2027-11-16T22:00:00.000Z', '2027-08-31T22:00:00.000Z'],
      ['exdate', dirty.master.id, '2027-11-17T07:00:00.000Z', '2027-09-01T07:00:00.000Z'],
    ].sort((a, b) => byMaster({ tipo: a[0], master_id: a[1], valore: a[2] }).localeCompare(byMaster({ tipo: b[0], master_id: b[1], valore: b[2] }))),
  );
  // Gli exdates non interpretabili sono elencati a parte (19c), con l'indice nell'array.
  const invalid = report.queries.find((q) => q.key === '19c_exdates_non_validi')?.rows ?? [];
  assert.deepEqual(
    invalid.map((r) => [r.master_id, r.problema, r.tipo_json, r.indice, r.valore])
      .sort((a, b) => `${a[0]}|${a[3]}`.localeCompare(`${b[0]}|${b[3]}`)),
    [
      [dirty.master.id, 'elemento non valido', 'string', 1, 'non-una-data'],
      [dirty.master.id, 'elemento non valido', 'string', 2, '2027-02-30T07:00:00.000Z'],
      [notArray.master.id, 'exdates non array', 'object', null, '{"data": "2027-03-02"}'],
    ].sort((a, b) => `${a[0]}|${a[3]}`.localeCompare(`${b[0]}|${b[3]}`)),
  );
  const perCalendar = report.queries.find((q) => q.key === '02_eventi_per_calendario')?.rows ?? [];
  assert.equal(perCalendar.reduce((acc, r) => acc + Number(r.exdates_non_array), 0), 1);

  // Iscrizioni: solo l'host (minuscolo), mai credenziali, porta, percorso o query string.
  const hosts = (report.queries.find((q) => q.key === '14_iscrizioni')?.rows ?? []).map((r) => r.host);
  assert.deepEqual(hosts, ['feeds.caldes.test', 'cloud.example.com', 'calendar.example.com']);
  // Nessun testo libero: titoli, nomi di calendari, iscrizioni e device delle
  // fixture iniziano tutti con "<prefisso> " (gli slug con "<prefisso>-").
  const serialized = JSON.stringify(report);
  for (const secret of ['app-secret-123', 's3cr3t', `${fx.prefix} `]) {
    assert.ok(!serialized.includes(secret), `il report contiene "${secret}"`);
  }

  // Riepilogo: 4 calendari seminati più quello della fixture; numeri come numeri JSON.
  assert.deepEqual(report.summary, {
    calendari: 5,
    eventi: 12,
    eventi_singoli: 2,
    serie: 7,
    override: 3,
    prenotazioni_future: report.summary.prenotazioni_future, // dipende da now(): non asserito
    iscrizioni: 3,
    app_password_attive: 2,
  });
  const radicaleLimit = report.queries.find((q) => q.key === '06_rrule_limite_radicale')?.rows[0];
  assert.equal(radicaleLimit?.freq, 'HOURLY');
  assert.equal(typeof radicaleLimit?.stima_occorrenze, 'number');
  assert.ok((radicaleLimit?.stima_occorrenze as number) > 50_000);
  const appPasswords = report.queries.find((q) => q.key === '15_app_password')?.rows ?? [];
  assert.ok(appPasswords.every((r) => !('token_hash' in r) && !('last_used_ip' in r)), 'mai hash né IP in chiaro');

  // Nessuna scrittura: audit e righe invariati.
  const [afterRun] = await sql<Array<{ audit: number; events: number }>>`
    SELECT (SELECT count(*)::int FROM audit_logs) AS audit, (SELECT count(*)::int FROM calendar_events) AS events
  `;
  assert.deepEqual(afterRun, before);
});

test('sola lettura garantita dal database: una funzione che scrive fallisce nel suo savepoint, le altre query proseguono', async () => {
  const path = writeSql('scrittura.sql', `${SESSION_QUERY}
-- @query 01_scrittura | Funzione con effetti collaterali
SELECT lo_create(0) AS oid;
-- @query 02_dopo | Query successiva
SELECT 1 AS uno;
-- @end
`);
  const result = await runCalendarInventory({ databaseUrl: TEST_DATABASE.url, sqlPath: path });
  assert.deepEqual(result.failed_queries, ['01_scrittura']);
  assert.match(result.queries[1].error ?? '', /read-only transaction/);
  assert.deepEqual(result.queries[2].rows, [{ uno: 1 }]);
  const [{ objects }] = await sql<Array<{ objects: number }>>`SELECT count(*)::int AS objects FROM pg_largeobject_metadata`;
  assert.equal(objects, 0);

  // Un'annotazione che punta a una colonna inesistente è un errore del file SQL.
  const badColumn = writeSql('colonna.sql', `${SESSION_QUERY}-- @query 01_x | X\n-- @anomaly PROVA sum=assente\nSELECT 1 AS presente;\n-- @end\n`);
  await assert.rejects(runCalendarInventory({ databaseUrl: TEST_DATABASE.url, sqlPath: badColumn }), /colonna "assente"/);
});

test('CLI: JSON e Markdown con permessi 0600, exit code documentati', async (t) => {
  assert.ok(report, 'richiede il report del test precedente');
  const logs: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));

  const out = join(WORK_DIR, 'report');
  // Un report precedente con permessi più larghi torna a 0600.
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, REPORT_FILES.json), '{}');
  chmodSync(join(out, REPORT_FILES.json), 0o644);
  assert.equal(await main(['--out', out, '--max-md-rows', '5']), 0);
  for (const file of Object.values(REPORT_FILES)) {
    assert.equal(statSync(join(out, file)).mode & 0o777, 0o600, file);
  }
  const json = JSON.parse(readFileSync(join(out, REPORT_FILES.json), 'utf8')) as InventoryReport;
  assert.equal(json.schema, REPORT_SCHEMA);
  assert.deepEqual(json.anomalies, report.anomalies);
  const md = readFileSync(join(out, REPORT_FILES.markdown), 'utf8');
  assert.match(md, /^# Inventario del calendario\n/);
  assert.match(md, /\| DST_SHIFTED_EXCEPTION \| 5 \| 19b_eccezioni_dst \|/);
  assert.match(md, /### 19b_eccezioni_dst: Eccezioni salvate prima del fix DST/);
  assert.match(md, /Nessun testo libero/);
  assert.ok(!md.includes(`${fx.prefix} `), 'nessun titolo o nome nel Markdown');
  assert.ok(logs.some((l) => l.includes('DST_SHIFTED_EXCEPTION=5')));

  // Troncamento delle tabelle Markdown: l'elenco completo resta nel JSON.
  const truncated = renderInventoryMarkdown(report, { maxRows: 1 });
  assert.match(truncated, /_Prime 1 righe di 5: l'elenco completo è nel JSON\._/);

  // `pnpm calendar:inventory -- --out <dir>`: pnpm inoltra anche il separatore.
  assert.equal(await main(['--', '--out', join(WORK_DIR, 'via-pnpm')]), 0);
  assert.ok(statSync(join(WORK_DIR, 'via-pnpm', REPORT_FILES.json)).isFile());

  assert.equal(await main([]), 2, '--out obbligatorio');
  assert.equal(await main(['--out', out, '--max-md-rows', '0']), 2);
  assert.equal(await main(['--out', out, '--sconosciuta']), 2);
  assert.equal(await main(['--out', out, '--sql', writeSql('non-valido.sql', `${SESSION_QUERY}-- @query 01_x | X\nDELETE FROM calendars;\n-- @end\n`)]), 2);
  assert.equal(await main(['--out', join(WORK_DIR, 'parziale'), '--sql', join(WORK_DIR, 'scrittura.sql')]), 3);
});
