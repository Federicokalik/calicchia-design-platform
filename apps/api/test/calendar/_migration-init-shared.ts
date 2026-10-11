/**
 * Utilità condivise dai test del gruppo INIT della F3 (preflight,
 * inizializzazione, inventario e archivio della Fase 0):
 *  - contesto di un run (MigrationRunContext) con una riga reale in
 *    cal_migration_runs, righe e avanzamento raccolti in memoria;
 *  - dati di forma produttiva (inventario del 2026-10-09): `c` con la serie
 *    infinita lun-mar-gio-ven alle 09:00 di Roma, la serie conclusa di giugno,
 *    singoli e copie fatte con "Duplica"; `f` "Festività e chiusure" con
 *    is_system = false, 91 festività di sistema e la chiusura "Ferie";
 *    Prenotazioni con una proiezione confermata (email e telefono nella
 *    DESCRIPTION) e una prenotazione annullata;
 *  - zip minimale (stored o deflate) per l'archivio della Fase 0.
 * Il nome inizia con "_": il runner esegue solo i file *.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import Holidays from 'date-holidays';
import { sql } from '../helpers/db';
import type { Fixtures } from '../helpers/fixtures';
import { logger } from '../../src/lib/logger';
import { createCalendar, getCalendar } from '../../src/lib/calendar/calendars';
import { createEvent } from '../../src/lib/calendar/events';
import type { Calendar, CalendarEvent, EventType } from '../../src/lib/calendar/types';
import {
  MigrationError,
  type MigrationItemInput,
  type MigrationProgress,
  type MigrationRunContext,
  type MigrationRunKind,
} from '../../src/lib/calendar/migration/types';

// ─── Run ───────────────────────────────

/** Chiude come riusciti i run attivi lasciati da un test (un solo run attivo alla volta). */
export async function finishActiveRuns(): Promise<void> {
  await sql`
    UPDATE cal_migration_runs SET status = 'succeeded', finished_at = now(), started_at = coalesce(started_at, now())
    WHERE status IN ('queued', 'running')
  `;
}

/** Riga di run 'running' come la lascia l'esecutore (runs.ts) prima di chiamare il modulo. */
export async function insertRun(kind: MigrationRunKind, params: object): Promise<string> {
  await finishActiveRuns();
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, started_at, attempts)
    VALUES (${kind}, 'running', 'admin', 'admin:test-init', ${sql.json(params as never)}, now(), 1)
    RETURNING id
  `;
  return row.id;
}

export interface TestRun<P> {
  ctx: MigrationRunContext<P>;
  items: MigrationItemInput[];
  progress: MigrationProgress[];
  cancel(): void;
}

/** Contesto di un run con la riga in cal_migration_runs (params riletti dal database, come l'esecutore). */
export async function testRun<P extends object>(kind: MigrationRunKind, params: P, opts: { runId?: string; attempt?: number } = {}): Promise<TestRun<P>> {
  const runId = opts.runId ?? (await insertRun(kind, params));
  const [row] = await sql<Array<{ params: P }>>`SELECT params FROM cal_migration_runs WHERE id = ${runId}::uuid`;
  const items: MigrationItemInput[] = [];
  const progress: MigrationProgress[] = [];
  const controller = new AbortController();
  const ctx: MigrationRunContext<P> = {
    runId,
    kind,
    trigger: 'admin',
    actor: 'admin:test-init',
    params: row?.params ?? params,
    planRunId: null,
    planHash: null,
    attempt: opts.attempt ?? 1,
    signal: controller.signal,
    log: logger.child({ scope: 'test-migration-init' }),
    db: sql,
    async progress(update) {
      progress.push(update);
    },
    async addItems(rows) {
      const ids = rows.map((_, i) => String(items.length + i + 1));
      items.push(...rows);
      return ids;
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw new MigrationError('CANCELLED', 'Run annullato');
    },
  };
  return { ctx, items, progress, cancel: () => controller.abort() };
}

// ─── Date ───────────────────────────────

/** Istante UTC di un'ora da muro di Roma (YYYY-MM-DD, HH:MM). */
export function rome(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  // Offset di Roma per quel giorno: +2 in ora legale, +1 in solare.
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' })
    .formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1';
  const hours = Number(offset.replace('GMT', '') || '0');
  return new Date(Date.UTC(y, m - 1, d, hh - hours, mm)).toISOString();
}

// ─── Dati di forma produttiva ───────────────────────────────

export interface ProductionShape {
  c: Calendar;
  f: Calendar;
  bookings: Calendar;
  lavoro: Calendar;
  infiniteSeries: CalendarEvent;
  juneSeries: CalendarEvent;
  singles: CalendarEvent[];
  duplicateCopy: CalendarEvent;
  occurrenceDuplicate: CalendarEvent;
  holidays: number;
  ferie: CalendarEvent;
  confirmedProjection: CalendarEvent | null;
  confirmedBookingUid: string;
  cancelledBookingUid: string;
  eventType: EventType;
}

/**
 * Calendari ed eventi come in produzione (inventario 2026-10-09). Richiede la
 * baseline (lavoro, personale, bookings, scadenze seminati). Gli slug `c` e
 * `f` sono quelli di produzione: le collezioni devono nascere con lo stesso nome.
 */
export async function buildProductionShape(fx: Fixtures, opts: { holidayYears?: number[] } = {}): Promise<ProductionShape> {
  const c = await createCalendar({ slug: 'c', name: 'Creattivamente SRL', timezone: 'Europe/Rome', blocks_availability: true });
  fx.track('calendarIds', c.id);
  const f = await fx.holidayCalendar({ slug: 'f' });
  // In produzione `f` è is_system = false (la 158 non era ancora applicata) e origin admin.
  await sql`UPDATE calendars SET is_system = false, origin = 'admin' WHERE id = ${f.id}`;
  const bookings = (await getCalendar('bookings')) as Calendar;
  const lavoro = (await getCalendar('lavoro')) as Calendar;

  const infiniteSeries = await createEvent({
    calendar_id: c.id, summary: 'Gestione Creattivamente', location: 'Sede del cliente',
    start_time: rome('2026-08-10', '09:00'), end_time: rome('2026-08-10', '10:00'), all_day: false,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', source: 'admin', status: 'confirmed',
  });
  const juneSeries = await createEvent({
    calendar_id: c.id, summary: 'Gestione',
    start_time: rome('2026-06-04', '09:00'), end_time: rome('2026-06-04', '10:00'), all_day: false,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260616T000000Z', source: 'admin', status: 'confirmed',
  });
  const singles: CalendarEvent[] = [];
  for (const [date, source] of [['2026-06-01', 'admin'], ['2026-06-03', 'mcp'], ['2026-06-19', 'admin']] as const) {
    singles.push(await createEvent({
      calendar_id: c.id, summary: 'Gestione', start_time: rome(date, '09:00'), end_time: rome(date, '10:00'), all_day: false, source, status: 'confirmed',
    }));
  }
  // Copia fatta con "Duplica" del singolo del 19/06 (source admin, source_id = id dell'originale).
  const duplicateCopy = await createEvent({
    calendar_id: c.id, summary: 'Gestione', start_time: rome('2026-06-19', '09:00'), end_time: rome('2026-06-19', '10:00'),
    all_day: false, source: 'admin', source_id: singles[2].id, status: 'confirmed',
  });
  // Duplicato esatto della prima occorrenza della serie di giugno.
  const occurrenceDuplicate = await createEvent({
    calendar_id: c.id, summary: 'Gestione', start_time: rome('2026-06-04', '09:00'), end_time: rome('2026-06-04', '10:00'),
    all_day: false, source: 'admin', status: 'confirmed',
  });
  for (const e of [infiniteSeries, juneSeries, ...singles, duplicateCopy, occurrenceDuplicate]) fx.track('eventIds', e.id);

  // 91 festività di sistema (come il cron, più anni) e la chiusura "Ferie".
  const years = opts.holidayYears ?? [2026, 2027, 2028, 2029, 2030, 2031, 2032];
  let holidays = 0;
  const hd = new Holidays('IT');
  for (const year of years) {
    for (const h of hd.getHolidays(year).filter((x) => x.type === 'public')) {
      const event = await createEvent({
        calendar_id: f.id, summary: h.name, start_time: new Date(h.start).toISOString(), end_time: new Date(h.end).toISOString(),
        all_day: false, source: 'system', source_id: `it-holiday-${h.date.slice(0, 10)}`, status: 'confirmed',
      });
      fx.track('eventIds', event.id);
      holidays++;
    }
  }
  const ferie = await createEvent({
    calendar_id: f.id, summary: 'Ferie', start_time: rome('2026-07-27', '00:00'), end_time: rome('2026-08-10', '00:00'),
    all_day: false, source: 'admin', status: 'confirmed',
  });
  fx.track('eventIds', ferie.id);

  const eventType = await fx.eventType({ key: 'consulenza', durationMinutes: 30, slotIncrementMinutes: 30, maxAdvanceDays: 365 });
  const confirmed = await fx.booking({
    eventType, start: rome('2026-08-10', '15:00'), status: 'confirmed',
    attendee: { name: fx.name('Cliente Prova'), email: fx.email('cliente-conf'), phone: '+39 333 0000000' },
  });
  const cancelled = await fx.booking({ eventType, start: rome('2026-06-01', '15:00'), status: 'cancelled', project: false });
  return {
    c, f, bookings, lavoro, infiniteSeries, juneSeries, singles, duplicateCopy, occurrenceDuplicate, holidays, ferie,
    confirmedProjection: confirmed.projection, confirmedBookingUid: confirmed.booking.uid, cancelledBookingUid: cancelled.booking.uid, eventType,
  };
}

// ─── Zip ───────────────────────────────

/** Zip minimale (directory centrale, stored o deflate) come lo produce radicale-maint.sh phase0-export. */
export function buildZip(entries: Array<{ name: string; data: string | Buffer; method?: 'stored' | 'deflate'; corruptCrc?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method === 'deflate' ? 8 : 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = (crc32(data) ^ (e.corruptCrc ? 0xffffffff : 0)) >>> 0;
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Intestazione ustar di 512 byte con la somma di controllo. */
function tarHeader(name: string, size: number, type: '0' | '5' | 'L', prefix = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write(`${Math.floor(Date.UTC(2025, 0, 1) / 1000).toString(8).padStart(11, '0')}\0`, 136, 'latin1');
  h.write(type, 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  if (prefix) h.write(prefix.slice(0, 155), 345, 'utf8');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/**
 * Tar ustar minimale (file e cartelle; nomi oltre 100 caratteri con
 * l'intestazione GNU 'L'), come il tar del volume di phase0-backup.
 */
export function buildTar(entries: Array<{ name: string; data?: string | Buffer; dir?: boolean; prefix?: string }>): Buffer {
  const blocks: Buffer[] = [];
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const e of entries) {
    if (e.dir) {
      blocks.push(tarHeader(e.name.endsWith('/') ? e.name : `${e.name}/`, 0, '5', e.prefix));
      continue;
    }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    if (Buffer.byteLength(e.name) > 100) {
      const long = Buffer.from(`${e.name}\0`, 'utf8');
      blocks.push(tarHeader('././@LongLink', long.length, 'L'), pad(long));
    }
    blocks.push(tarHeader(e.name, data.length, '0', e.prefix), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** VEVENT minimale in un VCALENDAR (CRLF). */
export function eventIcs(uid: string, opts: { start?: string; end?: string; summary?: string; extra?: string[] } = {}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Radicale Fase 0//IT',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20250101T080000Z',
    `DTSTART:${opts.start ?? '20250301T090000Z'}`,
    `DTEND:${opts.end ?? '20250301T100000Z'}`,
    `SUMMARY:${opts.summary ?? 'Evento della Fase 0'}`,
    ...(opts.extra ?? []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Uid casuale per i test. */
export function uid(label: string): string {
  return `tst-init-${label}-${randomUUID().slice(0, 8)}@fase0.test`;
}
