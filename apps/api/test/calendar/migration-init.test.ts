/**
 * Gruppo INIT della F3 senza Radicale (apps/api/src/lib/calendar/migration/
 * {preflight,init,inventory}.ts; design §13.2-§13.4; decisione 7; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §1.4, §6.1, §7.1 e §12).
 *
 * Casi:
 *  - MKCOL e MKCALENDAR solo nell'inizializzazione (ricerca nei sorgenti);
 *  - lettura dello zip, del tar (anche gzip, anche quello vero di `tar -czf`)
 *    e degli item dell'archivio della Fase 0 (stored, deflate, CRC rotto, voci
 *    non .ics, file nascosti del volume, UID duplicati, oggetti non validi, .ics
 *    singolo con più UID, nomi delle risorse sicuri, stessa chiave dal tar e
 *    dallo zip);
 *  - calendari visti dallo strumento con le esclusioni dal piano, collezioni
 *    del piano (slug di produzione `c` e `f` compresi, sub-* delle iscrizioni
 *    visibili, archivio, _canary), festività riconosciute anche con
 *    is_system = false;
 *  - app-password: riservate, non canoniche (username con '@' mai nelle righe),
 *    revocate escluse;
 *  - impatto delle iscrizioni sugli slot (decisione 5);
 *  - inventario sui dati di forma produttiva (inventario del 2026-10-09):
 *    conteggi per calendario, copie di "Duplica", eventi non-proiezione in
 *    Prenotazioni, eccezioni DST spostate, BOOKING_DRIFT, impatto delle
 *    iscrizioni, nessun dato personale nelle righe, anomalie senza doppioni;
 *  - preflight senza Radicale: RADICALE_CONFIGURED fallito, controlli di
 *    database, dichiarazioni (Fase 0, backup verificato 24 ore), backup
 *    coordinato registrato.
 * Con Radicale reale: test/integration/migration-init.test.ts.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { CalendarEvent } from '../../src/lib/calendar/types';
import {
  acceptedUploadDirs,
  ARCHIVE_COLLECTION_NAME,
  migrationUploadDir,
  plannedCollections,
  readArchiveItems,
  readTarIcsEntries,
  readZipIcsEntries,
  runInit,
  uploadPathFor,
} from '../../src/lib/calendar/migration/init';
import {
  computeSubscriptionImpacts,
  dedupeAnomalies,
  inventoryAppPasswords,
  loadMigrationCalendars,
  recognizeHolidayCalendar,
  runInventory,
  safeUsername,
} from '../../src/lib/calendar/migration/inventory';
import { collectPreflight, preflightWithoutRadicale, runPreflightWith, type PreflightDeps } from '../../src/lib/calendar/migration/preflight';
import {
  type AnomalyRecord,
  type CalendarInventory,
  type InitParams,
  type InventorySummary,
  MigrationError,
  PREFLIGHT_CHECK_CODES,
  type PreflightCheck,
  type PreflightSummary,
} from '../../src/lib/calendar/migration/types';
import { enableSubscriptionIndex } from '../../src/lib/calendar/subscriptions/pull';
import { CANARY_COLLECTION } from '../../src/lib/calendar/radicale/types';
import { CAL_LOCKS } from '../../src/lib/calendar/index-model';
import { createEvent } from '../../src/lib/calendar/events';
import { resetCalendarBaseline, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { buildProductionShape, buildTar, buildZip, eventIcs, rome, testRun, uid } from './_migration-init-shared';

const fx = useFixtures('mig-init', { resetBaseline: true });

const API_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

// ─── Utilità ───────────────────────────────

async function listTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...(await listTs(p)));
    } else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function checkOf(summary: PreflightSummary, code: PreflightCheck['code']): PreflightCheck {
  const found = summary.checks.find((c) => c.code === code);
  assert.ok(found, `controllo ${code} presente`);
  return found;
}

async function setState(fields: { declarations?: object; backup?: object | null }): Promise<void> {
  if (fields.declarations !== undefined) {
    await sql`UPDATE calendar_backend_state SET migration_declarations = ${sql.json(fields.declarations as never)} WHERE id = true`;
  }
  if (fields.backup !== undefined) {
    await sql`UPDATE calendar_backend_state SET last_stack_backup = ${fields.backup === null ? null : sql.json(fields.backup as never)} WHERE id = true`;
  }
}

/** Dipendenze del preflight senza Radicale (come preflightWithoutRadicale) con l'orologio dato. */
function offlineDeps(now: Date): PreflightDeps {
  return {
    client: null,
    unavailableReason: 'RADICALE_URL non impostata',
    principal: 'federico',
    probeClient: null,
    publicUrl: null,
    publicClient: () => null,
    watch: () => ({ mode: 'off', reason: 'test' }),
    canary: () => null,
    controlPlane: () => ({ status: null, sync: async () => null }),
    now: () => now,
  };
}

// ─── MKCOL e MKCALENDAR solo nell'inizializzazione ───────────────────────────────

test('MKCOL e MKCALENDAR compaiono solo in migration/init.ts, radicale/identity.ts, radicale/store.ts e nel client', async () => {
  const files = [...(await listTs(join(API_ROOT, 'src'))), ...(await listTs(join(API_ROOT, 'scripts')))];
  const pattern = /\.(mkcol|mkcalendar)\s*\(|method:\s*['"](MKCOL|MKCALENDAR)['"]/;
  const offenders: string[] = [];
  const found = new Set<string>();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (!pattern.test(code)) return;
      const rel = relative(API_ROOT, file).split('\\').join('/');
      found.add(rel);
      if (![
        'src/lib/calendar/migration/init.ts',
        'src/lib/calendar/radicale/identity.ts',
        'src/lib/calendar/radicale/store.ts',
        'src/lib/calendar/radicale/client.ts',
      ].includes(rel)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'nessun MKCOL o MKCALENDAR fuori dall\'inizializzazione');
  assert.ok(found.has('src/lib/calendar/migration/init.ts'), 'l\'inizializzazione della F3 è in migration/init.ts');
  // Nello strumento di migrazione solo init.ts: apply, shadow, archivio e piano non creano collezioni.
  assert.deepEqual([...found].filter((f) => f.startsWith('src/lib/calendar/migration/')), ['src/lib/calendar/migration/init.ts']);
});

// ─── Archivio della Fase 0: lettura ───────────────────────────────

test('zip dell\'archivio: entry .ics stored e deflate, cartelle, file nascosti, manifest e CRC rotti esclusi', () => {
  const zip = buildZip([
    { name: 'lavoro__a.ics', data: eventIcs('a@fase0') },
    { name: 'lavoro__b.ics', data: eventIcs('b@fase0'), method: 'deflate' },
    { name: 'cartella/', data: '' },
    { name: '.nascosto.ics', data: eventIcs('h@fase0') },
    { name: '__MACOSX/lavoro__a.ics', data: eventIcs('mac@fase0') },
    { name: 'manifest.json', data: '{}' },
    { name: 'note.txt', data: 'ciao' },
    { name: 'lavoro__rotto.ics', data: eventIcs('c@fase0'), corruptCrc: true },
  ]);
  const { entries, skipped } = readZipIcsEntries(zip);
  assert.deepEqual(entries.map((e) => e.name), ['lavoro__a.ics', 'lavoro__b.ics']);
  assert.match(entries[1].data.toString('utf8'), /UID:b@fase0/);
  assert.deepEqual(skipped.map((s) => s.name).sort(), ['lavoro__rotto.ics', 'note.txt']);
  assert.match(skipped.find((s) => s.name === 'lavoro__rotto.ics')!.reason, /CRC/);
  assert.throws(() => readZipIcsEntries(Buffer.from('non è uno zip, è testo semplice abbastanza lungo')), /zip non valido/);
  assert.throws(() => readZipIcsEntries(buildZip([{ name: 'a.ics', data: eventIcs('x') }, { name: 'b.ics', data: eventIcs('y') }]), { maxEntries: 1 }), /oltre 1 item/);
});

test('item dell\'archivio: validi in ordine di nome, non validi e UID duplicati scartati, nomi delle risorse sicuri', () => {
  const now = new Date('2026-10-10T08:00:00Z');
  const zip = buildZip([
    { name: 'personale__z.ics', data: eventIcs('dup@fase0', { summary: 'Secondo con lo stesso UID' }) },
    { name: 'personale__a.ics', data: eventIcs('dup@fase0', { summary: 'Primo' }) },
    { name: 'lavoro__nome con spazi.ics', data: eventIcs('spazi@fase0') },
    { name: 'lavoro__rotto.ics', data: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' },
    { name: 'lavoro__senza-dtstart.ics', data: eventIcs('nodt@fase0').replace(/DTSTART:[^\r]*\r\n/, '') },
    { name: 'lavoro__todo.ics', data: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//IT\r\nBEGIN:VTODO\r\nUID:todo@fase0\r\nDTSTAMP:20250101T080000Z\r\nSUMMARY:Da fare\r\nEND:VTODO\r\nEND:VCALENDAR\r\n' },
  ]);
  const { items, rejected } = readArchiveItems(zip, 'archivio-fase0.zip', now);
  assert.deepEqual(items.map((i) => i.source_name), ['lavoro__nome con spazi.ics', 'lavoro__todo.ics', 'personale__a.ics']);
  const first = items.find((i) => i.source_name === 'personale__a.ics')!;
  assert.equal(first.uid, 'dup@fase0');
  assert.match(first.ics, /SUMMARY:Primo/);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$|^sha256:|.+/);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  // Nome con spazi → nome deterministico sicuro; gli altri restano quelli originali.
  const spaced = items.find((i) => i.source_name === 'lavoro__nome con spazi.ics')!;
  assert.match(spaced.href, /^item-[0-9a-f]{32}\.ics$/);
  assert.equal(first.href, 'personale__a.ics');
  assert.equal(new Set(items.map((i) => i.href)).size, items.length);

  const reasons = Object.fromEntries(rejected.map((r) => [r.source_name, r.reason]));
  assert.equal(reasons['personale__z.ics'], 'duplicate');
  assert.equal(reasons['lavoro__rotto.ics'], 'invalid');
  assert.equal(reasons['lavoro__senza-dtstart.ics'], 'invalid');
  assert.ok(rejected.every((r) => r.code === 'INVALID_OBJECT' || r.code === 'POSSIBLE_DUPLICATE'));
});

test('item dell\'archivio da un .ics singolo: un item per UID, nome del file per un solo oggetto', () => {
  const now = new Date('2026-10-10T08:00:00Z');
  const two = Buffer.from([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//IT',
    'BEGIN:VEVENT', 'UID:uno@fase0', 'DTSTAMP:20250101T080000Z', 'DTSTART:20250301T090000Z', 'DTEND:20250301T100000Z', 'SUMMARY:Uno', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:due@fase0', 'DTSTAMP:20250101T080000Z', 'DTSTART:20250302T090000Z', 'DTEND:20250302T100000Z', 'SUMMARY:Due', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n'));
  const many = readArchiveItems(two, 'export.ics', now);
  assert.deepEqual(many.items.map((i) => i.source_name).sort(), ['export.ics#due@fase0', 'export.ics#uno@fase0']);
  assert.ok(many.items.every((i) => /^export-[0-9a-f]{12}\.ics$/.test(i.href)), 'href deterministico per ogni UID');
  assert.equal(new Set(many.items.map((i) => i.href)).size, 2);

  const single = readArchiveItems(Buffer.from(eventIcs('solo@fase0')), 'lavoro__solo.ics', now);
  assert.deepEqual(single.items.map((i) => [i.source_name, i.href]), [['lavoro__solo.ics', 'lavoro__solo.ics']]);
  assert.throws(() => readArchiveItems(Buffer.from('testo qualsiasi'), 'x.ics', now), /né zip né iCalendar/);
});

test('tar del volume della Fase 0: item delle collezioni con il nome dello zip, file nascosti e voci fuori dal layout esclusi', () => {
  const now = new Date('2026-10-10T08:00:00Z');
  const longItem = `${'x'.repeat(110)}.ics`;
  const tar = buildTar([
    { name: 'collection-root', dir: true },
    { name: 'collection-root/federico', dir: true },
    { name: 'collection-root/federico/.Radicale.props', data: '{}' },
    { name: 'collection-root/federico/lavoro/.Radicale.props', data: '{"tag": "VCALENDAR"}' },
    { name: 'collection-root/federico/lavoro/.Radicale.cache/item/a.ics', data: 'cache' },
    { name: 'collection-root/federico/lavoro/a.ics', data: eventIcs('tar-a@fase0') },
    { name: `collection-root/federico/lavoro/${longItem}`, data: eventIcs('tar-long@fase0') },
    { name: 'personale/b.ics', prefix: 'collection-root/federico', data: eventIcs('tar-b@fase0') },
    // Stessa collezione e stesso item sotto un altro principal: il nome prende anche il principal.
    { name: 'collection-root/altro/lavoro/a.ics', data: eventIcs('tar-altro@fase0') },
    { name: 'sciolto.ics', data: eventIcs('tar-sciolto@fase0') },
  ]);
  const { entries, skipped } = readTarIcsEntries(tar);
  assert.deepEqual(entries.map((e) => e.name), ['lavoro__a.ics', `lavoro__${longItem}`, 'personale__b.ics', 'altro__lavoro__a.ics']);
  assert.deepEqual(skipped, [{ name: 'sciolto.ics', reason: 'fuori dal layout delle collezioni' }]);

  // Stesso item dal tar o dallo zip di phase0-export: stessa chiave del ledger (source_name) e stesso href.
  const fromTar = readArchiveItems(tar, 'radicale_data.tar', now).items.find((i) => i.uid === 'tar-a@fase0')!;
  const fromZip = readArchiveItems(buildZip([{ name: 'lavoro__a.ics', data: eventIcs('tar-a@fase0') }]), 'archivio-fase0.zip', now).items[0];
  assert.deepEqual([fromTar.source_name, fromTar.href, fromTar.fingerprint], [fromZip.source_name, fromZip.href, fromZip.fingerprint]);
  // tar.gz.
  const gz = readArchiveItems(gzipSync(tar), 'radicale_data.tar.gz', now);
  assert.equal(gz.items.length, 4);
  // Intestazione rovinata, gzip senza tar.
  const broken = Buffer.from(tar);
  broken[600] ^= 0xff;
  assert.throws(() => readTarIcsEntries(broken), /somma di controllo/);
  assert.throws(() => readArchiveItems(gzipSync(Buffer.from('non un tar')), 'x.tar.gz', now), /non contiene un tar/);
});

test('tar reale del volume (tar -czf di un layout di Radicale) letto come lo produce phase0-backup', { skip: spawnSync('tar', ['--version']).status === 0 ? false : 'tar non disponibile' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'caldes-f3-tar-'));
  try {
    const col = join(dir, 'collection-root', 'federico', 'lavoro');
    await mkdir(join(col, '.Radicale.cache', 'item'), { recursive: true });
    await writeFile(join(col, '.Radicale.props'), '{"tag": "VCALENDAR"}');
    await writeFile(join(col, '.Radicale.cache', 'item', 'riunione.ics'), 'cache');
    await writeFile(join(col, 'riunione.ics'), eventIcs('reale@fase0'));
    await writeFile(join(col, `${'n'.repeat(120)}.ics`), eventIcs('reale-lungo@fase0'));
    const out = join(dir, 'radicale_data.tar.gz');
    const res = spawnSync('tar', ['-czf', out, '-C', dir, 'collection-root']);
    assert.equal(res.status, 0, String(res.stderr));
    const { items, rejected } = readArchiveItems(await readFile(out), 'radicale_data.tar.gz', new Date('2026-10-10T08:00:00Z'));
    assert.deepEqual(items.map((i) => i.source_name).sort(), [`lavoro__${'n'.repeat(120)}.ics`, 'lavoro__riunione.ics']);
    assert.deepEqual(rejected, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cartella dei caricamenti dell\'archivio: CAL_MIGRATION_UPLOAD_DIR o il default sotto UPLOAD_DIR, nomi sicuri', () => {
  assert.equal(migrationUploadDir({ CAL_MIGRATION_UPLOAD_DIR: '/srv/mig' }), '/srv/mig');
  assert.deepEqual(acceptedUploadDirs({ CAL_MIGRATION_UPLOAD_DIR: '/srv/mig' }), ['/srv/mig']);
  const dirs = acceptedUploadDirs({ PRIVATE_UPLOAD_DIR: '/srv/private', UPLOAD_DIR: '/srv/uploads' });
  assert.deepEqual(dirs, ['/srv/private/calendar-migration', '/srv/uploads/private/calendar-migration']);
  assert.equal(uploadPathFor('archivio-1.zip', { CAL_MIGRATION_UPLOAD_DIR: '/srv/mig' }), '/srv/mig/archivio-1.zip');
  assert.throws(() => uploadPathFor('../fuori.zip', { CAL_MIGRATION_UPLOAD_DIR: '/srv/mig' }), /non valido/);
});

// ─── Calendari e collezioni del piano ───────────────────────────────

test('calendari dello strumento: esclusi sidecar d\'iscrizione, archivio, nome di collezione nullo e non attivi; festività riconosciute con is_system = false', async () => {
  await resetCalendarBaseline();
  const shape = await buildProductionShape(fx, { holidayYears: [2026] });
  const dest = await fx.calendar({ key: 'dest-iscr' });
  const visible = await fx.subscription({ calendar: dest, name: 'visibile', url: 'https://feeds.caldes.test/vis.ics' });
  const hidden = await fx.subscription({ calendar: dest, name: 'nascosta', url: 'https://feeds.caldes.test/hid.ics' });
  await sql`UPDATE calendar_subscriptions SET device_visible = true WHERE id = ${visible.subscription.id}`;
  const visibleSidecar = await enableSubscriptionIndex(visible.subscription.id, { allowPostgresMode: true });
  const hiddenSidecar = await enableSubscriptionIndex(hidden.subscription.id, { allowPostgresMode: true });
  fx.track('calendarIds', visibleSidecar);
  fx.track('calendarIds', hiddenSidecar);
  const noName = await fx.calendar({ key: 'senza-nome' });
  await sql`UPDATE calendars SET collection_name = NULL WHERE id = ${noName.id}`;
  const deleting = await fx.calendar({ key: 'in-cancellazione' });
  await sql`UPDATE calendars SET lifecycle = 'deleting' WHERE id = ${deleting.id}`;
  const [archive] = await sql<Array<{ id: string }>>`
    INSERT INTO calendars (slug, name, color, timezone, is_default, is_system, blocks_availability, ics_feed_token, ics_feed_enabled, sort_order, collection_name, role, origin)
    VALUES (${ARCHIVE_COLLECTION_NAME}, 'Archivio Fase 0', '#64748b', 'Europe/Rome', false, false, false, ${`tok-${uid('arch')}`.slice(0, 40)}, false, 1000, ${ARCHIVE_COLLECTION_NAME}, 'user', 'migration')
    RETURNING id
  `;
  fx.track('calendarIds', archive.id);

  const calendars = await loadMigrationCalendars(sql);
  const by = new Map(calendars.map((c) => [c.id, c]));
  assert.equal(by.get(visibleSidecar)?.excluded_reason, 'subscription_sidecar');
  assert.equal(by.get(hiddenSidecar)?.excluded_reason, 'subscription_sidecar');
  assert.equal(by.get(String(archive.id))?.excluded_reason, 'archive');
  assert.equal(by.get(noName.id)?.excluded_reason, 'collection_name_invalid');
  assert.equal(by.get(deleting.id)?.excluded_reason, 'not_active');
  for (const c of [shape.c, shape.f, shape.bookings, shape.lavoro]) {
    assert.equal(by.get(c.id)?.included, true, `${c.slug} incluso`);
  }
  // Collezioni con il nome esatto dello slug di oggi (endpoint di condivisione invariati).
  assert.equal(by.get(shape.c.id)?.collection_name, 'c');
  assert.equal(by.get(shape.f.id)?.collection_name, 'f');

  const f = by.get(shape.f.id)!;
  assert.equal(f.is_system, false);
  assert.notEqual(recognizeHolidayCalendar(f), null, 'f riconosciuto come festività anche con is_system = false');
  assert.equal(recognizeHolidayCalendar({ role: 'user', slug: 'f', name: 'Qualcosa', is_system: false }), 'slug');
  assert.equal(recognizeHolidayCalendar({ role: 'user', slug: 'x', name: 'Festività e chiusure', is_system: false }), 'name');
  assert.equal(recognizeHolidayCalendar({ role: 'holidays', slug: 'x', name: 'x', is_system: false }), 'role');
  assert.equal(recognizeHolidayCalendar({ role: 'user', slug: 'c', name: 'Creattivamente SRL', is_system: false }), null);

  // Ambito: solo i calendari indicati.
  const scoped = await loadMigrationCalendars(sql, { calendar_ids: [shape.c.id.toUpperCase()] });
  assert.deepEqual(scoped.map((c) => c.id), [shape.c.id]);

  const planned = await plannedCollections(sql);
  const names = planned.map((p) => p.collection_name);
  for (const slug of ['c', 'f', 'lavoro', 'personale', 'bookings', 'scadenze']) assert.ok(names.includes(slug), `collezione ${slug} nel piano`);
  const [visibleRow] = await sql<Array<{ collection_name: string }>>`SELECT collection_name FROM calendars WHERE id = ${visibleSidecar}`;
  const [hiddenRow] = await sql<Array<{ collection_name: string }>>`SELECT collection_name FROM calendars WHERE id = ${hiddenSidecar}`;
  assert.deepEqual(planned.filter((p) => p.kind === 'subscription').map((p) => p.collection_name), [visibleRow.collection_name]);
  assert.ok(!names.includes(hiddenRow.collection_name), 'iscrizione non visibile: nessuna collezione sub-*');
  assert.deepEqual(planned.filter((p) => p.kind === 'archive').map((p) => [p.collection_name, p.calendar_id]), [[ARCHIVE_COLLECTION_NAME, String(archive.id)]]);
  assert.deepEqual(planned.filter((p) => p.kind === 'system').map((p) => p.collection_name), [CANARY_COLLECTION]);
  assert.equal(planned[planned.length - 1].collection_name, CANARY_COLLECTION, '_canary per ultima');
  assert.ok(!names.includes('senza-nome') && !planned.some((p) => p.calendar_id === deleting.id));
  const roles = Object.fromEntries(planned.filter((p) => p.kind === 'calendar').map((p) => [p.collection_name, p.role]));
  assert.equal(roles.bookings, 'bookings');
});

// ─── App-password ───────────────────────────────

test('app-password: riservate bloccanti, non canoniche informative, revocate e scadute escluse', async () => {
  await resetCalendarBaseline();
  const canonical = await fx.appPassword({ username: 'federico', device: 'Mac' });
  const iphone = await fx.appPassword({ username: 'iphone', device: 'iPhone' });
  const legacyEmail = await fx.appPassword({ username: 'storico', device: 'Vecchio' });
  const reserved = await fx.appPassword({ username: 'riservata', device: 'Servizio' });
  const revoked = await fx.appPassword({ username: 'revocata', device: 'Revocata' });
  const expired = await fx.appPassword({ username: 'scaduta', device: 'Scaduta' });
  // Righe storiche precedenti alle regole di oggi (username con '@' o con il prefisso riservato).
  await sql`UPDATE caldav_app_passwords SET username = 'federico@example.invalid' WHERE id = ${legacyEmail.row.id}`;
  await sql`UPDATE caldav_app_passwords SET username = 'caldes-legacy' WHERE id = ${reserved.row.id}`;
  await sql`UPDATE caldav_app_passwords SET revoked_at = now() WHERE id = ${revoked.row.id}`;
  await sql`UPDATE caldav_app_passwords SET expires_at = now() - interval '1 day' WHERE id = ${expired.row.id}`;

  const apps = await inventoryAppPasswords(sql, 'federico');
  assert.equal(apps.active, 4);
  assert.deepEqual(apps.reserved.map((r) => r.id), [reserved.row.id]);
  assert.deepEqual(apps.non_canonical.map((r) => r.id).sort(), [iphone.row.id, legacyEmail.row.id].sort());
  assert.ok(!apps.non_canonical.some((r) => r.id === canonical.row.id));
  assert.equal(safeUsername('federico@example.invalid'), '[username con @ nascosto]');
  assert.equal(safeUsername('iphone'), 'iphone');

  const summary = await collectPreflight(sql, offlineDeps(new Date()));
  const reservedCheck = checkOf(summary, 'RESERVED_APP_PASSWORDS');
  assert.equal(reservedCheck.status, 'fail');
  assert.deepEqual(reservedCheck.detail, { ids: [reserved.row.id] });
  const nonCanonical = checkOf(summary, 'NON_CANONICAL_APP_PASSWORDS');
  assert.equal(nonCanonical.status, 'pass', 'informativo');
  assert.deepEqual(nonCanonical.detail, { active: 4, non_canonical: 2 });
  assert.ok(summary.blocking.includes('RESERVED_APP_PASSWORDS'));

  // Nelle righe dell'inventario mai l'username con '@'.
  const run = await testRun('inventory', { scope: {} });
  const inv = await runInventory(run.ctx);
  assert.deepEqual(inv.app_passwords, { active: 4, non_canonical: 2, reserved: 1 });
  const text = JSON.stringify(run.items);
  assert.ok(!text.includes('federico@example.invalid'), 'nessun username email nelle righe');
  const reservedItem = run.items.find((i) => i.code === 'RESERVED_APP_PASSWORD');
  assert.equal(reservedItem?.severity, 'error');
  assert.equal((reservedItem?.detail as { blocking?: boolean }).blocking, true);
  assert.equal(run.items.filter((i) => i.code === 'NON_CANONICAL_APP_PASSWORD').length, 2);
});

test('preflight: un pull delle iscrizioni in corso (lock cal-sync del sidecar) è un avviso', async () => {
  await resetCalendarBaseline();
  const dest = await fx.calendar({ key: 'dest-pull' });
  const { subscription } = await fx.subscription({ calendar: dest, name: 'in-pull', url: 'https://feeds.caldes.test/pull.ics' });
  const sidecar = await enableSubscriptionIndex(subscription.id, { allowPostgresMode: true });
  fx.track('calendarIds', sidecar);
  const conn = await sql.reserve();
  try {
    await conn`SELECT pg_advisory_lock(hashtext(${CAL_LOCKS.collection(sidecar)}))`;
    const busy = await collectPreflight(sql, offlineDeps(new Date()));
    const check = checkOf(busy, 'SUBSCRIPTION_SYNC_IDLE');
    assert.equal(check.status, 'warn');
    assert.deepEqual(check.detail, { pulls: 1, mirror_jobs: 0 });
    assert.ok(!busy.blocking.includes('SUBSCRIPTION_SYNC_IDLE'));
    await conn`SELECT pg_advisory_unlock(hashtext(${CAL_LOCKS.collection(sidecar)}))`;
  } finally {
    conn.release();
  }
  const idle = await collectPreflight(sql, offlineDeps(new Date()));
  assert.equal(checkOf(idle, 'SUBSCRIPTION_SYNC_IDLE').status, 'pass');
});

// ─── Impatto delle iscrizioni (decisione 5) ───────────────────────────────

test('impatto delle iscrizioni: ore occupate e slot pubblici persi a settimana sulle prossime 4 settimane', async () => {
  await resetCalendarBaseline();
  const eventType = await fx.eventType({ key: 'impatto', durationMinutes: 30, slotIncrementMinutes: 30, maxAdvanceDays: 365 });
  const dest = await fx.calendar({ key: 'dest-impatto', blocks_availability: true });
  // Due mattine occupate (10:00-12:00 di Roma) in orario d'ufficio: 4 slot da 30 minuti ciascuna.
  const { subscription } = await fx.subscription({
    calendar: dest,
    name: 'remoto',
    events: [
      { remote_uid: 'imp-1@remoto', summary: 'Impegno', description: null, location: null, url: null, start_time: rome('2027-01-05', '10:00'), end_time: rome('2027-01-05', '12:00'), all_day: false, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed' },
      { remote_uid: 'imp-2@remoto', summary: 'Impegno', description: null, location: null, url: null, start_time: rome('2027-01-13', '10:00'), end_time: rome('2027-01-13', '12:00'), all_day: false, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed' },
      { remote_uid: 'imp-3@remoto', summary: 'Tutto il giorno', description: null, location: null, url: null, start_time: '2027-01-07T00:00:00.000Z', end_time: '2027-01-08T00:00:00.000Z', all_day: true, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed' },
    ],
  });
  const impacts = await computeSubscriptionImpacts(sql, { now: new Date('2027-01-04T00:00:00Z'), weeks: 4 });
  const mine = impacts.find((i) => i.subscription_id === subscription.id);
  assert.ok(mine, 'impatto dell\'iscrizione calcolato');
  assert.equal(mine.events_legacy, 3);
  assert.equal(mine.blocks_availability, false, 'default della decisione 5: non bloccante');
  assert.equal(mine.device_visible, false);
  assert.equal(mine.sidecar_calendar_id, null);
  assert.equal(mine.impact?.weeks, 4);
  assert.equal(mine.impact?.busy_hours_per_week, 1, '4 ore timed su 4 settimane (gli all-day non bloccano)');
  assert.equal(mine.impact?.slots_lost_per_week[eventType.slug], 2, '8 slot persi su 4 settimane');
});

// ─── Inventario sui dati di forma produttiva ───────────────────────────────

interface InventoryScenario {
  summary: InventorySummary;
  items: Array<{ code?: string | null; calendar_id?: string | null; legacy_key?: string | null; severity?: string; detail?: Record<string, unknown> }>;
  shape: Awaited<ReturnType<typeof buildProductionShape>>;
  manualInBookings: CalendarEvent;
  dstSeries: CalendarEvent;
  orphanProjection: CalendarEvent;
  missingBookingUid: string;
  attendeeEmail: string;
}

let scenario: InventoryScenario | null = null;

async function inventoryScenario(): Promise<InventoryScenario> {
  if (scenario) return scenario;
  await resetCalendarBaseline();
  const shape = await buildProductionShape(fx);
  // Evento manuale nel calendario Prenotazioni (decisione 8).
  const manualInBookings = await createEvent({
    calendar_id: shape.bookings.id, summary: 'Blocco manuale', start_time: rome('2026-11-03', '15:00'), end_time: rome('2026-11-03', '16:00'),
    all_day: false, source: 'admin', status: 'confirmed',
  });
  fx.track('eventIds', manualInBookings.id);
  // Serie con un EXDATE salvato con l'ora UTC del DTSTART prima del fix DST (07:00Z a novembre = 08:00 di Roma).
  const dstSeries = await createEvent({
    calendar_id: shape.lavoro.id, summary: 'Standup', start_time: '2027-09-01T07:00:00.000Z', end_time: '2027-09-01T07:30:00.000Z',
    all_day: false, rrule: 'FREQ=WEEKLY', exdates: ['2027-11-17T07:00:00.000Z'], source: 'admin', status: 'confirmed',
  });
  fx.track('eventIds', dstSeries.id);
  // Proiezione orfana (prenotazione inesistente) e prenotazione confermata senza proiezione.
  const orphanProjection = await createEvent({
    calendar_id: shape.bookings.id, summary: 'Prenotazione orfana', start_time: rome('2026-11-05', '10:00'), end_time: rome('2026-11-05', '10:30'),
    all_day: false, source: 'booking', source_id: 'orfana-uid-inesistente', status: 'confirmed',
  });
  fx.track('eventIds', orphanProjection.id);
  const missing = await fx.booking({ eventType: shape.eventType, start: rome('2026-11-06', '11:00'), status: 'confirmed', project: false });
  // Iscrizione con un impegno nelle prossime settimane (orario d'ufficio di domani + 7 giorni).
  const day = new Date(Date.now() + 8 * 86_400_000);
  const date = day.toISOString().slice(0, 10);
  await fx.subscription({
    calendar: shape.lavoro,
    name: 'google',
    events: [{ remote_uid: 'inv-1@remoto', summary: 'Impegno', description: null, location: null, url: null, start_time: rome(date, '10:00'), end_time: rome(date, '11:00'), all_day: false, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed' }],
  });
  const [attendee] = await sql<Array<{ attendee_email: string }>>`SELECT attendee_email FROM calendar_bookings WHERE uid = ${shape.confirmedBookingUid}`;

  const run = await testRun('inventory', { scope: {} });
  const summary = await runInventory(run.ctx);
  scenario = {
    summary,
    items: run.items,
    shape,
    manualInBookings,
    dstSeries,
    orphanProjection,
    missingBookingUid: missing.booking.uid,
    attendeeEmail: attendee.attendee_email,
  };
  return scenario;
}

function calendarInv(summary: InventorySummary, id: string): CalendarInventory {
  const found = summary.calendars.find((c) => c.calendar_id === id);
  assert.ok(found, `inventario del calendario ${id}`);
  return found;
}

test('inventario: conteggi per calendario sui dati di forma produttiva (c, f con 91 festività e Ferie, Prenotazioni)', async () => {
  const { summary, shape } = await inventoryScenario();
  assert.equal(shape.holidays, 91, 'le festività della fixture sono 91 come in produzione');

  const c = calendarInv(summary, shape.c.id);
  assert.equal(c.collection_name, 'c');
  assert.equal(c.included, true);
  assert.equal(c.counts.series, 2, 'serie infinita lun-mar-gio-ven e serie conclusa');
  assert.equal(c.counts.singles_timed, 5, 'tre singoli, la copia di "Duplica" e il doppione dell\'occorrenza');
  assert.equal(c.counts.rows, 7);
  assert.equal(c.counts.projections, 0);

  const f = calendarInv(summary, shape.f.id);
  assert.equal(f.is_system, false);
  assert.equal(f.counts.holidays_system, 91);
  assert.equal(f.counts.closures, 1, 'la chiusura "Ferie"');
  assert.equal(f.counts.rows, 92);
  const fDetail = f as CalendarInventory & { holidays: { recognized_by: string | null; role_mismatch: boolean } };
  assert.notEqual(fDetail.holidays.recognized_by, null, 'festività riconosciute per nome o slug con is_system = false');

  const bookings = calendarInv(summary, shape.bookings.id);
  assert.equal(bookings.role, 'bookings');
  assert.equal(bookings.counts.projections, 2, 'proiezione confermata e proiezione orfana');
  assert.equal(bookings.counts.non_projection_in_bookings, 1);

  assert.equal(summary.totals.holidays_system, 91);
  assert.ok(summary.totals.rows >= 7 + 92 + 3);
  assert.ok(summary.estimate.objects > 0);
  assert.ok(summary.estimate.writes_upper_bound >= summary.estimate.objects);
  assert.ok(summary.estimate.seconds >= Math.ceil(summary.estimate.objects / 20) + 1);
  assert.match(summary.generated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('inventario: copie di "Duplica", evento uguale a un\'occorrenza, eventi non-proiezione in Prenotazioni, eccezioni DST spostate', async () => {
  const { summary, items, shape, manualInBookings, dstSeries } = await inventoryScenario();
  const dup = items.filter((i) => i.code === 'POSSIBLE_DUPLICATE');
  const copy = dup.find((i) => i.legacy_key === `event:${shape.duplicateCopy.id}`);
  assert.ok(copy, 'copia fatta con "Duplica" segnalata');
  assert.equal(copy.detail?.kind, 'duplicate_copy');
  assert.equal(copy.detail?.original_id, shape.singles[2].id);
  assert.equal(copy.severity, 'info');
  const occ = dup.find((i) => i.legacy_key === `event:${shape.occurrenceDuplicate.id}`);
  assert.ok(occ, 'singolo uguale all\'occorrenza della serie di giugno segnalato');
  assert.ok(!dup.some((i) => i.legacy_key === `event:${shape.singles[2].id}`), 'l\'originale non è un doppione');
  // Una riga per oggetto anche se serializer e inventario la segnalano entrambi.
  assert.equal(new Set(dup.map((i) => i.legacy_key)).size, dup.length);

  const npb = items.filter((i) => i.code === 'NON_PROJECTION_IN_BOOKINGS');
  assert.deepEqual(npb.map((i) => i.legacy_key), [`event:${manualInBookings.id}`]);
  assert.equal(npb[0].calendar_id, shape.bookings.id);

  const dst = items.filter((i) => i.code === 'DST_SHIFTED_EXCEPTION');
  assert.deepEqual(dst.map((i) => i.legacy_key), [`event:${dstSeries.id}`]);
  assert.equal(dst[0].severity, 'warning');
  assert.equal((dst[0].detail as { blocking?: boolean }).blocking, false);
  assert.equal(calendarInv(summary, shape.lavoro.id).anomalies.DST_SHIFTED_EXCEPTION, 1);
  assert.equal(summary.anomalies.DST_SHIFTED_EXCEPTION, 1);
  // La serie infinita di produzione non è un'anomalia.
  assert.ok(!items.some((i) => i.legacy_key === `event:${shape.infiniteSeries.id}` && i.code !== 'POSSIBLE_DUPLICATE'));
});

test('inventario: BOOKING_DRIFT (proiezione orfana, prenotazione senza proiezione), impatto delle iscrizioni, nessun dato personale', async () => {
  const { summary, items, shape, orphanProjection, missingBookingUid, attendeeEmail } = await inventoryScenario();
  const drift = items.filter((i) => i.code === 'BOOKING_DRIFT');
  const orphan = drift.find((i) => i.legacy_key === 'booking:orfana-uid-inesistente');
  assert.ok(orphan, 'proiezione orfana');
  assert.equal(orphan.detail?.kind, 'orphan_projection');
  assert.equal(orphan.detail?.legacy_event_id, orphanProjection.id);
  const missing = drift.find((i) => i.legacy_key === `booking:${missingBookingUid}`);
  assert.ok(missing, 'prenotazione confermata senza proiezione');
  assert.equal(missing.detail?.kind, 'missing_projection');
  assert.ok(!drift.some((i) => i.legacy_key === `booking:${shape.confirmedBookingUid}`), 'la proiezione confermata è allineata');
  assert.ok(!drift.some((i) => i.legacy_key === `booking:${shape.cancelledBookingUid}`), 'la prenotazione annullata non ha proiezione e non è una deriva');
  assert.equal(new Set(drift.map((i) => i.legacy_key)).size, drift.length, 'nessun doppione fra serializer e inventario');

  const impact = items.filter((i) => i.code === 'SUBSCRIPTION_BLOCKING_IMPACT');
  assert.equal(impact.length, 1);
  assert.equal(impact[0].calendar_id, shape.lavoro.id);
  assert.equal(summary.subscriptions.length, 1);
  assert.equal(summary.subscriptions[0].impact?.busy_hours_per_week, 0.3, '1 ora in 4 settimane');
  assert.equal(items.filter((i) => i.code === 'ICS_PULL_REFETCH').length, 1);

  // Nessun dato personale nelle righe: né email né telefono né nome dell'invitato.
  const text = JSON.stringify(items);
  assert.ok(!text.includes(attendeeEmail), 'nessuna email');
  assert.ok(!text.includes('333 0000000') && !text.includes('+39 333'), 'nessun telefono');
  assert.ok(!text.includes('Cliente Prova'), 'nessun nome dell\'invitato');
  // Le righe hanno codici del contratto e il flag blocking.
  for (const item of items) {
    assert.match(String(item.code), /^[A-Z][A-Z0-9_]{0,63}$/);
    assert.equal(typeof (item.detail as { blocking?: unknown }).blocking, 'boolean');
  }
  // Un'anomalia per (codice, calendario, oggetto).
  const keys = items.map((i) => `${i.code}|${i.calendar_id ?? ''}|${i.legacy_key ?? JSON.stringify(i.detail?.subscription_id ?? i.detail?.app_password_id ?? '')}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('deduplica delle anomalie: una riga per codice, calendario e oggetto con i dettagli uniti', () => {
  const a = (code: AnomalyRecord['code'], key: string | null, detail: Record<string, unknown>, cal = 'cal-1'): AnomalyRecord => ({ code, calendar_id: cal, legacy_key: key, severity: 'info', detail });
  const out = dedupeAnomalies([
    a('POSSIBLE_DUPLICATE', 'event:1', { duplicate_of: '0' }),
    a('POSSIBLE_DUPLICATE', 'event:1', { kind: 'duplicate_copy', duplicate_of: 'ignorato' }),
    a('POSSIBLE_DUPLICATE', 'event:2', {}),
    a('EVENTS_IN_EXCLUDED_CALENDAR', null, { rows: 3, slug: 'x' }),
    a('EVENTS_IN_EXCLUDED_CALENDAR', null, { rows: 3 }),
    a('SUBSCRIPTION_BLOCKING_IMPACT', null, { subscription_id: 's1' }),
    a('SUBSCRIPTION_BLOCKING_IMPACT', null, { subscription_id: 's2' }),
  ]);
  assert.equal(out.length, 5);
  assert.deepEqual(out[0].detail, { duplicate_of: '0', kind: 'duplicate_copy' });
});

// ─── Preflight senza Radicale ───────────────────────────────

test('preflight senza Radicale: RADICALE_CONFIGURED fallito, controlli di Radicale saltati, controlli di database eseguiti', async () => {
  await resetCalendarBaseline();
  const summary = await preflightWithoutRadicale(sql);
  assert.deepEqual(summary.checks.map((c) => c.code), [...PREFLIGHT_CHECK_CODES], 'tutti i controlli, nell\'ordine del contratto');
  assert.equal(checkOf(summary, 'MODE_POSTGRES').status, 'pass');
  assert.equal(checkOf(summary, 'RESTORE_GUARD').status, 'pass');
  assert.equal(checkOf(summary, 'RADICALE_CONFIGURED').status, 'fail');
  for (const code of ['RADICALE_REACHABLE', 'RADICALE_VERSION', 'SERVICE_LOGIN', 'IDENTITY', 'COLLECTIONS', 'CANARY_COLLECTION', 'PROBE_READONLY', 'PROBE_CANARY_FORBIDDEN', 'VOLUME_WATCH', 'CONTROL_PLANE', 'SERVICE_PUBLIC_401'] as const) {
    assert.equal(checkOf(summary, code).status, 'skip', `${code} saltato senza Radicale`);
  }
  assert.equal(checkOf(summary, 'RESERVED_APP_PASSWORDS').status, 'pass');
  assert.equal(checkOf(summary, 'SUBSCRIPTION_SYNC_IDLE').status, 'pass');
  assert.equal(checkOf(summary, 'PHASE0_VOLUME').status, 'confirm');
  assert.equal(checkOf(summary, 'PHASE0_VOLUME').declaration, 'phase0');
  assert.equal(checkOf(summary, 'BACKUP_RECENT').status, 'confirm');
  assert.equal(checkOf(summary, 'DST_EXCEPTIONS').status, 'pass');
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.blocking, ['RADICALE_CONFIGURED', 'BACKUP_RECENT', 'PHASE0_VOLUME']);
  assert.equal(summary.identity, 'uninitialized');
  assert.equal(summary.radicale.configured, false);

  // Senza Radicale anche i run che scrivono rifiutano subito.
  const run = await testRun<InitParams>('init', { action: 'create_missing' });
  await assert.rejects(runInit(run.ctx), (err: unknown) => err instanceof MigrationError && err.code === 'RADICALE_NOT_CONFIGURED');
});

test('preflight: dichiarazioni della Fase 0 e del backup verificato (24 ore), backup coordinato registrato, eccezioni DST', async () => {
  await resetCalendarBaseline();
  const now = new Date('2026-10-10T10:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

  await setState({ declarations: { phase0: { value: { status: 'absent' }, at: hoursAgo(500), by: 'admin:test' } } });
  let summary = await collectPreflight(sql, offlineDeps(now));
  const phase0 = checkOf(summary, 'PHASE0_VOLUME');
  assert.equal(phase0.status, 'pass', 'la dichiarazione della Fase 0 non scade');
  assert.equal(phase0.declared, true);
  assert.match(phase0.message, /absent/);

  // Backup coordinato completo di un'ora fa, volume non ancora inizializzato.
  await setState({ backup: { id: 'b1', at: hoursAgo(1), complete: true, volume_id: null, epoch: null, manifest_sha256: null } });
  summary = await collectPreflight(sql, offlineDeps(now));
  assert.equal(checkOf(summary, 'BACKUP_RECENT').status, 'pass');
  assert.equal(checkOf(summary, 'BACKUP_RECENT').declared, undefined);

  // Più vecchio di 24 ore, o incompleto: serve la dichiarazione.
  await setState({ backup: { id: 'b2', at: hoursAgo(25), complete: false, volume_id: null, epoch: null, manifest_sha256: null } });
  summary = await collectPreflight(sql, offlineDeps(now));
  const stale = checkOf(summary, 'BACKUP_RECENT');
  assert.equal(stale.status, 'confirm');
  assert.deepEqual((stale.detail as { problems?: string[] }).problems, ['incompleto', 'più vecchio di 24 ore']);
  assert.match(String(stale.remedy), /backup-calendar-stack\.sh/);

  // Dichiarazione "backup verificato": valida 24 ore.
  await setState({ declarations: { phase0: { value: { status: 'absent' }, at: hoursAgo(1), by: 'admin:test' }, backup_verified: { value: { note: 'verificato' }, at: hoursAgo(2), by: 'admin:test' } } });
  summary = await collectPreflight(sql, offlineDeps(now));
  assert.equal(checkOf(summary, 'BACKUP_RECENT').status, 'pass');
  assert.equal(checkOf(summary, 'BACKUP_RECENT').declared, true);
  await setState({ declarations: { phase0: { value: { status: 'absent' }, at: hoursAgo(1), by: 'admin:test' }, backup_verified: { value: {}, at: hoursAgo(25), by: 'admin:test' } } });
  summary = await collectPreflight(sql, offlineDeps(now));
  assert.equal(checkOf(summary, 'BACKUP_RECENT').status, 'confirm', 'dichiarazione scaduta');

  // Backup di un altro volume con lo stato inizializzato: non vale.
  await sql`UPDATE calendar_backend_state SET volume_id = '11111111-1111-4111-8111-111111111111', epoch = 1 WHERE id = true`;
  await setState({ declarations: {}, backup: { id: 'b3', at: hoursAgo(1), complete: true, volume_id: '22222222-2222-4222-8222-222222222222', epoch: 1, manifest_sha256: null } });
  summary = await collectPreflight(sql, offlineDeps(now));
  assert.deepEqual((checkOf(summary, 'BACKUP_RECENT').detail as { problems?: string[] }).problems, ['identità del volume diversa']);
  assert.equal(summary.identity, 'unverified');
  await sql`UPDATE calendar_backend_state SET volume_id = NULL, epoch = 0 WHERE id = true`;
  await setState({ declarations: {}, backup: null });

  // Guardia post-ripristino: avviso, non blocco.
  await sql`UPDATE calendar_backend_state SET restore_guard_until = ${new Date(now.getTime() + 3_600_000)} WHERE id = true`;
  summary = await collectPreflight(sql, offlineDeps(now));
  assert.equal(checkOf(summary, 'RESTORE_GUARD').status, 'warn');
  assert.ok(!summary.blocking.includes('RESTORE_GUARD'));
  await sql`UPDATE calendar_backend_state SET restore_guard_until = NULL WHERE id = true`;

  // Eccezioni DST ancora in PG: avviso con il numero di eccezioni e di serie.
  const cal = await fx.calendar({ key: 'dst-preflight' });
  await fx.event({
    calendar: cal, summary: 'Standup', start_time: '2027-09-01T07:00:00.000Z', end_time: '2027-09-01T07:30:00.000Z',
    rrule: 'FREQ=WEEKLY', exdates: ['2027-11-17T07:00:00.000Z', '2027-11-24T07:00:00.000Z'],
  });
  summary = await collectPreflight(sql, offlineDeps(now));
  const dst = checkOf(summary, 'DST_EXCEPTIONS');
  assert.equal(dst.status, 'warn');
  assert.deepEqual(dst.detail, { exceptions: 2, series: 1 });
  assert.match(String(dst.remedy), /calendar:fix-dst/);
});

test('run di preflight: una riga check per controllo con esito, messaggio e dichiarazione, nessun dato personale', async () => {
  await resetCalendarBaseline();
  const run = await testRun('preflight', { probe_public_url: false });
  const summary = await runPreflightWith(run.ctx, offlineDeps(new Date()));
  assert.equal(run.items.length, PREFLIGHT_CHECK_CODES.length);
  assert.deepEqual(run.items.map((i) => i.code), [...PREFLIGHT_CHECK_CODES]);
  assert.ok(run.items.every((i) => i.item_type === 'check'));
  const configured = run.items.find((i) => i.code === 'RADICALE_CONFIGURED')!;
  assert.equal(configured.severity, 'error');
  assert.equal(configured.detail?.status, 'fail');
  const phase0 = run.items.find((i) => i.code === 'PHASE0_VOLUME')!;
  assert.equal(phase0.severity, 'warning');
  assert.equal(phase0.detail?.declaration, 'phase0');
  assert.equal(phase0.detail?.declared, false);
  assert.equal(summary.ready, false);
  assert.ok(run.progress.length >= 2);
});
