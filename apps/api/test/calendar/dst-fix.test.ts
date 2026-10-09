/**
 * Correzione delle eccezioni DST (scripts/fix-dst-exceptions.ts), fase F0:
 * docs/calendar-radicale/piano.md (F0, attività 2 e test) e design §13.4, §14.
 *
 * I dati "di prima del fix" si creano come li creava il codice precedente a
 * d046006: override (createOccurrenceOverride) ed exdates con l'istante della
 * vecchia griglia, che ripeteva l'ora UTC del DTSTART. Una serie delle 09:00 di
 * Roma creata a settembre (07:00Z) a novembre cadeva quindi alle 07:00Z, cioè
 * alle 08:00 di Roma, mentre oggi listOccurrences la espande alle 08:00Z.
 *
 * Date fisse nel 2027 (ora legale dal 28 marzo al 31 ottobre): nulla dipende da
 * "adesso". Ogni test crea i propri calendari e tutte le chiamate allo script
 * sono limitate a quei calendari (calendarSlugs / --calendar), quindi il file
 * non vede né modifica altri dati del database.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { onBeforeDatabaseClose, sql } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';
import {
  applyDstFix,
  buildDstFixReport,
  planDstFix,
  type DstChange,
  type DstReport,
  type DstSkip,
  type MasterRow,
  type OverrideRow,
} from '../../scripts/fix-dst-exceptions';
import { createOccurrenceOverride, listOccurrences } from '../../src/lib/calendar/events';
import type { Calendar, CalendarEvent } from '../../src/lib/calendar/types';

const fx = useFixtures('dst-fix');

/** run_id degli apply: le righe di audit_logs scritte dallo script si puliscono per request_id. */
const runIds = new Set<string>();
onBeforeDatabaseClose(async () => {
  if (runIds.size) await sql`DELETE FROM audit_logs WHERE request_id = ANY(${[...runIds]}::text[])`;
});

// Serie settimanale del mercoledì alle 09:00 di Roma creata a settembre (ora legale).
const SEPT_START = romeIso('2027-09-01', '09:00');
const SEPT_END = romeIso('2027-09-01', '09:30');

// ─── Helper locali ───────────────────────────────

const iso = (value: Date | string): string => new Date(value).toISOString();

/** Occorrenze di listOccurrences nel calendario, fra due date di Roma: [titolo, inizio, override]. */
async function occurrences(cal: Calendar, from: string, to: string): Promise<Array<[string, string, boolean]>> {
  const list = await listOccurrences({ calendarId: cal.id, fromIso: romeIso(from), toIso: romeIso(to) });
  return list.map((o) => [o.summary.replace(`${fx.prefix} `, ''), o.start_time, o.is_override]);
}

interface EventState {
  recurrence_id: Date | null;
  start_time: Date;
  exdates: unknown;
  status: string;
  updated_at: Date;
}

async function state(id: string): Promise<EventState> {
  const [row] = await sql<EventState[]>`
    SELECT recurrence_id, start_time, exdates, status, updated_at FROM calendar_events WHERE id = ${id}::uuid
  `;
  assert.ok(row, `evento ${id} non trovato`);
  return row;
}

const dryRun = (...cals: Calendar[]): Promise<DstReport> => buildDstFixReport({ calendarSlugs: cals.map((c) => c.slug) });

async function apply(cals: Calendar[], expectPlan?: string): Promise<DstReport> {
  const report = await applyDstFix({ calendarSlugs: cals.map((c) => c.slug), expectPlan });
  runIds.add(report.run_id);
  return report;
}

/** Campi che identificano una modifica o una saltata (senza titoli e orari di Roma). */
function brief(item: DstChange | DstSkip): Record<string, unknown> {
  return {
    kind: item.kind,
    outcome: 'action' in item ? item.action : item.reason,
    event_id: item.event_id,
    exdate_index: item.exdate_index,
    from: item.from,
    to: item.to,
    direction: item.direction,
  };
}

async function scriptAudit(runId: string) {
  return sql<Array<{
    action: string; table_name: string; record_id: string; user_email: string; user_role: string;
    old_data: Record<string, unknown>; new_data: Record<string, unknown>; changed_fields: string[];
    metadata: Record<string, unknown>;
  }>>`
    SELECT action, table_name, record_id, user_email, user_role, old_data, new_data, changed_fields, metadata
    FROM audit_logs WHERE request_id = ${runId} ORDER BY record_id
  `;
}

/** Serie del mercoledì alle 09:00 di Roma da settembre, con override ed exdates dati. */
async function autumnSeries(key: string, opts: {
  exdates?: string[];
  overrides?: Array<{ originalStart: string; start?: string; summary?: string; status?: 'confirmed' | 'cancelled' }>;
  timezone?: string;
} = {}): Promise<{ cal: Calendar; master: CalendarEvent; overrides: CalendarEvent[] }> {
  const cal = await fx.calendar({ key, ...(opts.timezone ? { timezone: opts.timezone } : {}) });
  const { master, overrides } = await fx.series({
    calendar: cal,
    summary: 'Standup',
    start_time: SEPT_START,
    end_time: SEPT_END,
    rrule: 'FREQ=WEEKLY',
    exdates: opts.exdates,
    overrides: opts.overrides,
  });
  return { cal, master, overrides };
}

// ─── Casi ───────────────────────────────

test('legale→solare: override cancellato salvato a novembre alle 07:00Z riallineato alle 08:00Z, l\'occorrenza non risorge', async () => {
  const { cal, master, overrides: [cancelled] } = await autumnSeries('autunno', {
    overrides: [{ originalStart: '2027-11-10T07:00:00.000Z', status: 'cancelled' }],
  });
  assert.equal(iso(master.start_time), '2027-09-01T07:00:00.000Z');

  // Comportamento attuale (design §14): l'occorrenza eliminata risorge alle 08:00Z.
  assert.deepEqual(await occurrences(cal, '2027-11-08', '2027-11-13'), [['Standup', '2027-11-10T08:00:00.000Z', false]]);

  const dry = await dryRun(cal);
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.applied, null);
  assert.deepEqual(dry.changes.map(brief), [{
    kind: 'override', outcome: 'realign', event_id: cancelled.id, exdate_index: null,
    from: '2027-11-10T07:00:00.000Z', to: '2027-11-10T08:00:00.000Z', direction: 'legale→solare',
  }]);
  const [change] = dry.changes;
  assert.equal(change.reason, 'DST_SHIFTED_EXCEPTION');
  assert.equal(change.master_start_rome, '2027-09-01 09:00');
  assert.equal(change.from_rome, '2027-11-10 08:00');
  assert.equal(change.to_rome, '2027-11-10 09:00');
  assert.equal(change.note, null, 'un override cancellato non ha orari da rivedere');
  assert.deepEqual(dry.summary.to_fix, { overrides: 1, exdates: 0, total: 1 });
  assert.match(dry.plan_fingerprint, /^[0-9a-f]{16}$/);

  // Il dry-run non scrive: valore e audit invariati.
  assert.equal(iso((await state(cancelled.id)).recurrence_id!), '2027-11-10T07:00:00.000Z');
  assert.equal((await scriptAudit(dry.run_id)).length, 0);

  const applied = await apply([cal], dry.plan_fingerprint);
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.plan_fingerprint, dry.plan_fingerprint);
  assert.deepEqual(applied.applied, { updated_rows: 1, audit_rows: 1 });

  const after = await state(cancelled.id);
  assert.equal(iso(after.recurrence_id!), '2027-11-10T08:00:00.000Z');
  assert.equal(after.status, 'cancelled');
  assert.deepEqual(await occurrences(cal, '2027-11-08', '2027-11-13'), [], 'l\'occorrenza eliminata non deve ricomparire');
  // Le altre settimane restano alle 09:00 di Roma.
  assert.deepEqual(await occurrences(cal, '2027-11-15', '2027-11-20'), [['Standup', '2027-11-17T08:00:00.000Z', false]]);

  // audit_logs: una riga dello script (action ammessa dal CHECK) più quella del trigger.
  const audit = await scriptAudit(applied.run_id);
  assert.equal(audit.length, 1);
  assert.deepEqual(
    { ...audit[0], metadata: undefined },
    {
      action: 'UPDATE',
      table_name: 'calendar_events',
      record_id: cancelled.id,
      user_email: 'system@fix-dst-exceptions',
      user_role: 'system',
      old_data: { recurrence_id: '2027-11-10T07:00:00.000Z' },
      new_data: { recurrence_id: '2027-11-10T08:00:00.000Z' },
      changed_fields: ['recurrence_id'],
      metadata: undefined,
    },
  );
  const metadata = audit[0].metadata;
  assert.equal(metadata.script, 'fix-dst-exceptions');
  assert.equal(metadata.run_id, applied.run_id);
  assert.equal(metadata.reason, 'DST_SHIFTED_EXCEPTION');
  assert.equal(metadata.plan_fingerprint, dry.plan_fingerprint);
  assert.equal(metadata.master_id, master.id);
  assert.deepEqual(metadata.changes, [{
    kind: 'override', action: 'realign', exdate_index: null,
    from: '2027-11-10T07:00:00.000Z', to: '2027-11-10T08:00:00.000Z',
    from_rome: '2027-11-10 08:00', to_rome: '2027-11-10 09:00', direction: 'legale→solare',
  }]);
  assert.ok(!JSON.stringify(metadata).includes('Standup'), 'niente titoli negli audit dello script');
  const [trigger] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM audit_logs
    WHERE table_name = 'calendar_events' AND record_id = ${cancelled.id} AND action = 'UPDATE'
      AND request_id IS NULL AND 'recurrence_id' = ANY(changed_fields)
  `;
  assert.equal(trigger.n, 1, 'riga del trigger audit_calendar_events');
});

test('exdates: elemento spostato riallineato al suo posto nell\'array, gli altri invariati', async () => {
  const { cal, master } = await autumnSeries('exdates', {
    exdates: [
      '2027-11-17T07:00:00.000Z', // vecchia griglia (08:00 Roma): da riallineare
      '2027-09-15T07:00:00.000Z', // stessa ora legale del DTSTART: già allineato
      '2027-12-08T08:00:00.000Z', // creato dopo il fix (09:00 Roma): già allineato
    ],
  });
  assert.deepEqual(await occurrences(cal, '2027-11-15', '2027-11-20'), [['Standup', '2027-11-17T08:00:00.000Z', false]]);

  const dry = await dryRun(cal);
  assert.deepEqual(dry.changes.map(brief), [{
    kind: 'exdate', outcome: 'realign', event_id: master.id, exdate_index: 0,
    from: '2027-11-17T07:00:00.000Z', to: '2027-11-17T08:00:00.000Z', direction: 'legale→solare',
  }]);
  assert.equal(dry.summary.aligned, 2);

  const applied = await apply([cal], dry.plan_fingerprint);
  assert.deepEqual(applied.applied, { updated_rows: 1, audit_rows: 1 });
  assert.deepEqual((await state(master.id)).exdates, [
    '2027-11-17T08:00:00.000Z',
    '2027-09-15T07:00:00.000Z',
    '2027-12-08T08:00:00.000Z',
  ]);
  assert.deepEqual(await occurrences(cal, '2027-11-15', '2027-11-20'), []);
  assert.deepEqual(await occurrences(cal, '2027-09-13', '2027-09-18'), []);
  assert.deepEqual(await occurrences(cal, '2027-12-06', '2027-12-11'), []);

  const [audit] = await scriptAudit(applied.run_id);
  assert.equal(audit.record_id, master.id);
  assert.deepEqual(audit.changed_fields, ['exdates']);
  assert.deepEqual(audit.old_data, { exdates: ['2027-11-17T07:00:00.000Z', '2027-09-15T07:00:00.000Z', '2027-12-08T08:00:00.000Z'] });
  assert.deepEqual(audit.new_data, { exdates: ['2027-11-17T08:00:00.000Z', '2027-09-15T07:00:00.000Z', '2027-12-08T08:00:00.000Z'] });
});

test('solare→legale: serie creata a gennaio, eccezioni di aprile salvate alle 08:00Z riallineate alle 07:00Z', async () => {
  const cal = await fx.calendar({ key: 'primavera' });
  // Lunedì alle 09:00 di Roma da gennaio (08:00Z, ora solare). La vecchia
  // griglia ad aprile restava alle 08:00Z, cioè alle 10:00 di Roma.
  const { master, overrides: [cancelled] } = await fx.series({
    calendar: cal,
    summary: 'Riunione',
    start_time: romeIso('2027-01-04', '09:00'),
    end_time: romeIso('2027-01-04', '10:00'),
    rrule: 'FREQ=WEEKLY',
    exdates: ['2027-04-12T08:00:00.000Z'],
    overrides: [{ originalStart: '2027-04-05T08:00:00.000Z', status: 'cancelled' }],
  });
  assert.equal(iso(master.start_time), '2027-01-04T08:00:00.000Z');
  assert.deepEqual(await occurrences(cal, '2027-04-05', '2027-04-14'), [
    ['Riunione', '2027-04-05T07:00:00.000Z', false],
    ['Riunione', '2027-04-12T07:00:00.000Z', false],
  ]);

  const dry = await dryRun(cal);
  assert.deepEqual(dry.changes.map(brief), [
    {
      kind: 'exdate', outcome: 'realign', event_id: master.id, exdate_index: 0,
      from: '2027-04-12T08:00:00.000Z', to: '2027-04-12T07:00:00.000Z', direction: 'solare→legale',
    },
    {
      kind: 'override', outcome: 'realign', event_id: cancelled.id, exdate_index: null,
      from: '2027-04-05T08:00:00.000Z', to: '2027-04-05T07:00:00.000Z', direction: 'solare→legale',
    },
  ]);
  assert.deepEqual(dry.changes.map((c) => [c.from_rome, c.to_rome]), [
    ['2027-04-12 10:00', '2027-04-12 09:00'],
    ['2027-04-05 10:00', '2027-04-05 09:00'],
  ]);

  const applied = await apply([cal], dry.plan_fingerprint);
  assert.deepEqual(applied.applied, { updated_rows: 2, audit_rows: 2 });
  assert.equal(iso((await state(cancelled.id)).recurrence_id!), '2027-04-05T07:00:00.000Z');
  assert.deepEqual((await state(master.id)).exdates, ['2027-04-12T07:00:00.000Z']);
  assert.deepEqual(await occurrences(cal, '2027-04-05', '2027-04-14'), []);
  assert.deepEqual(await occurrences(cal, '2027-04-19', '2027-04-20'), [['Riunione', '2027-04-19T07:00:00.000Z', false]]);
});

test('idempotente: il secondo run non trova nulla e non scrive né righe né audit', async () => {
  const { cal, master, overrides: [cancelled] } = await autumnSeries('idempotenza', {
    exdates: ['2027-11-17T07:00:00.000Z'],
    overrides: [{ originalStart: '2027-11-10T07:00:00.000Z', status: 'cancelled' }],
  });
  const first = await apply([cal]);
  assert.deepEqual(first.applied, { updated_rows: 2, audit_rows: 2 });
  const masterAfter = await state(master.id);
  const overrideAfter = await state(cancelled.id);

  const dry = await dryRun(cal);
  assert.deepEqual(dry.changes, []);
  assert.deepEqual(dry.skipped, []);
  assert.equal(dry.summary.aligned, 2);
  assert.equal(dry.summary.to_fix.total, 0);

  const second = await apply([cal], dry.plan_fingerprint);
  assert.deepEqual(second.applied, { updated_rows: 0, audit_rows: 0 });
  assert.equal((await scriptAudit(second.run_id)).length, 0);
  // Nessuna UPDATE: updated_at (trigger) e valori identici.
  assert.deepEqual(await state(master.id), masterAfter);
  assert.deepEqual(await state(cancelled.id), overrideAfter);
});

test('nessun effetto sulle eccezioni create dopo il fix né su quelle già allineate', async () => {
  const { cal, master, overrides } = await autumnSeries('dopo-il-fix', {
    exdates: ['2027-12-01T08:00:00.000Z', '2027-09-22T07:00:00.000Z'],
    overrides: [
      { originalStart: '2027-11-10T08:00:00.000Z', status: 'cancelled' }, // dopo il fix: 09:00 Roma
      { originalStart: '2027-11-24T08:00:00.000Z', start: romeIso('2027-11-24', '11:00'), summary: 'Standup spostato' },
      { originalStart: '2027-09-15T07:00:00.000Z', status: 'cancelled' }, // stessa ora legale del DTSTART
    ],
  });
  const before = await Promise.all([master, ...overrides].map((e) => state(e.id)));

  const dry = await dryRun(cal);
  assert.deepEqual(dry.changes, []);
  assert.deepEqual(dry.skipped, []);
  assert.equal(dry.summary.aligned, 5);
  assert.equal(dry.summary.other_mismatch, 0);
  const applied = await apply([cal]);
  assert.deepEqual(applied.applied, { updated_rows: 0, audit_rows: 0 });
  assert.deepEqual(await Promise.all([master, ...overrides].map((e) => state(e.id))), before);

  // Flusso reale dopo il fix: l'utente elimina l'occorrenza che vede in agenda
  // (original_start da listOccurrences) e lo script non la tocca.
  const [occurrence] = await listOccurrences({ calendarId: cal.id, fromIso: romeIso('2027-12-15'), toIso: romeIso('2027-12-16') });
  assert.equal(occurrence.original_start, '2027-12-15T08:00:00.000Z');
  const fresh = await createOccurrenceOverride({ masterEventId: master.id, originalStartIso: occurrence.original_start!, status: 'cancelled' });
  fx.track('eventIds', fresh.id);
  const again = await dryRun(cal);
  assert.deepEqual(again.changes, []);
  assert.equal(again.summary.aligned, 6);
});

test('override modificato: si riallinea solo recurrence_id, l\'orario resta, il report lo segnala e sparisce il doppione', async () => {
  // Prima del fix l'admin mostrava l'occorrenza del 24 novembre alle 08:00 di
  // Roma: l'utente ha cambiato solo il titolo e l'orario è rimasto 07:00Z.
  const { cal, overrides: [edited] } = await autumnSeries('modificato', {
    overrides: [{ originalStart: '2027-11-24T07:00:00.000Z', summary: 'Standup con il cliente' }],
  });
  assert.equal(iso(edited.start_time), '2027-11-24T07:00:00.000Z');
  // Oggi: override orfano più occorrenza della serie (doppione).
  assert.deepEqual(await occurrences(cal, '2027-11-22', '2027-11-27'), [
    ['Standup con il cliente', '2027-11-24T07:00:00.000Z', true],
    ['Standup', '2027-11-24T08:00:00.000Z', false],
  ]);

  const dry = await dryRun(cal);
  assert.deepEqual(dry.changes.map(brief), [{
    kind: 'override', outcome: 'realign', event_id: edited.id, exdate_index: null,
    from: '2027-11-24T07:00:00.000Z', to: '2027-11-24T08:00:00.000Z', direction: 'legale→solare',
  }]);
  assert.equal(dry.changes[0].override_status, 'confirmed');
  assert.match(dry.changes[0].note ?? '', /ancora alle 08:00 di Roma del 2027-11-24 .*riportato alle 09:00 della serie/);

  await apply([cal], dry.plan_fingerprint);
  const after = await state(edited.id);
  assert.equal(iso(after.recurrence_id!), '2027-11-24T08:00:00.000Z');
  assert.equal(iso(after.start_time), '2027-11-24T07:00:00.000Z', 'orario dell\'override invariato');
  assert.deepEqual(await occurrences(cal, '2027-11-22', '2027-11-27'), [['Standup con il cliente', '2027-11-24T07:00:00.000Z', true]]);
});

test('saltate e segnalate: fuso diverso, iscrizione ICS, conflitto, occorrenza inesistente e valore non valido; exdate doppio rimosso', async () => {
  // Calendario con un fuso diverso da Europe/Rome: segnalato, mai modificato.
  const ny = await autumnSeries('new-york', {
    timezone: 'America/New_York',
    overrides: [{ originalStart: '2027-11-10T07:00:00.000Z', status: 'cancelled' }],
  });

  // Serie importata da un'iscrizione ICS (sola lettura, riscritta dal sync).
  const icsCal = await fx.calendar({ key: 'iscrizione', blocks_availability: false });
  const { events: [icsMaster] } = await fx.subscription({
    calendar: icsCal,
    events: [{
      remote_uid: 'serie-remota@example.test',
      summary: 'Serie esterna',
      description: null,
      location: null,
      url: null,
      start_time: SEPT_START,
      end_time: SEPT_END,
      all_day: false,
      rrule: 'FREQ=WEEKLY',
      exdates: ['2027-11-17T07:00:00.000Z'],
      recurrence_id: null,
      status: 'confirmed',
    }],
  });

  // Stesso calendario di Roma: conflitto fra override (vecchio e nuovo per la
  // stessa occorrenza), exdate doppio (vecchio + corretto), valore non valido,
  // override fuori griglia senza firma DST.
  const mixed = await autumnSeries('misto', {
    exdates: ['2027-12-01T07:00:00.000Z', '2027-12-01T08:00:00.000Z', 'non-una-data'],
    overrides: [
      { originalStart: '2027-11-10T07:00:00.000Z', status: 'cancelled' },
      { originalStart: '2027-11-10T08:00:00.000Z', status: 'cancelled' },
      { originalStart: '2027-11-03T10:15:00.000Z', status: 'cancelled' },
    ],
  });
  const [shiftedOverride, newOverride] = mixed.overrides;

  // BYDAY valutato dal codice vecchio sul giorno UTC: lunedì alle 00:30 di
  // Roma (domenica 22:30Z in ora legale). La vecchia griglia d'inverno cadeva
  // lunedì 22:30Z (23:30 di Roma): il valore "corretto" (martedì 00:30) non è
  // un'occorrenza, quindi niente correzione automatica.
  const nightCal = await fx.calendar({ key: 'notte' });
  const { master: nightMaster } = await fx.series({
    calendar: nightCal,
    summary: 'Backup notturno',
    start_time: romeIso('2027-09-06', '00:30'),
    end_time: romeIso('2027-09-06', '01:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    exdates: ['2027-11-08T22:30:00.000Z'],
  });

  // Gli all-day non sono considerati (anomalie proprie, design §13.4).
  const allDayCal = await fx.calendar({ key: 'tutto-il-giorno' });
  await fx.series({
    calendar: allDayCal,
    summary: 'Ferie a rotazione',
    start_time: romeIso('2027-09-01'),
    end_time: romeIso('2027-09-02'),
    all_day: true,
    rrule: 'FREQ=WEEKLY',
    exdates: ['2027-11-09T22:00:00.000Z'],
  });

  const cals = [ny.cal, icsCal, mixed.cal, nightCal, allDayCal];
  const before = await Promise.all([ny.overrides[0], icsMaster, ...mixed.overrides, nightMaster].map((e) => state(e.id)));
  const dry = await dryRun(...cals);

  assert.deepEqual(dry.changes.map(brief), [{
    kind: 'exdate', outcome: 'drop-duplicate', event_id: mixed.master.id, exdate_index: 0,
    from: '2027-12-01T07:00:00.000Z', to: '2027-12-01T08:00:00.000Z', direction: 'legale→solare',
  }]);
  const skipped = dry.skipped.map(brief);
  assert.deepEqual(skipped, [
    {
      kind: 'exdate', outcome: 'ICS_PULL_READ_ONLY', event_id: icsMaster.id, exdate_index: 0,
      from: '2027-11-17T07:00:00.000Z', to: '2027-11-17T08:00:00.000Z', direction: 'legale→solare',
    },
    {
      kind: 'exdate', outcome: 'INVALID_VALUE', event_id: mixed.master.id, exdate_index: 2,
      from: 'non-una-data', to: null, direction: null,
    },
    {
      kind: 'override', outcome: 'OVERRIDE_CONFLICT', event_id: shiftedOverride.id, exdate_index: null,
      from: '2027-11-10T07:00:00.000Z', to: '2027-11-10T08:00:00.000Z', direction: 'legale→solare',
    },
    {
      kind: 'override', outcome: 'NON_ROME_CALENDAR', event_id: ny.overrides[0].id, exdate_index: null,
      from: '2027-11-10T07:00:00.000Z', to: '2027-11-10T08:00:00.000Z', direction: 'legale→solare',
    },
    {
      kind: 'exdate', outcome: 'NO_MATCHING_OCCURRENCE', event_id: nightMaster.id, exdate_index: 0,
      from: '2027-11-08T22:30:00.000Z', to: null, direction: 'legale→solare',
    },
  ]);
  const conflict = dry.skipped.find((s) => s.reason === 'OVERRIDE_CONFLICT');
  assert.ok(conflict?.detail.includes(newOverride.id), 'il dettaglio indica l\'override in conflitto');
  assert.ok(dry.skipped.find((s) => s.reason === 'NON_ROME_CALENDAR')?.detail.includes('America/New_York'));
  assert.deepEqual(dry.summary.skipped, {
    ICS_PULL_READ_ONLY: 1, INVALID_VALUE: 1, OVERRIDE_CONFLICT: 1, NON_ROME_CALENDAR: 1, NO_MATCHING_OCCURRENCE: 1,
  });
  // Serie timed: new-york, iscrizione, misto, notte (l'all-day è escluso).
  assert.equal(dry.summary.masters_scanned, 4);
  // Override delle 10:15Z: fuori griglia ma senza firma DST, non toccato.
  assert.equal(dry.summary.other_mismatch, 1);

  const applied = await apply(cals, dry.plan_fingerprint);
  assert.deepEqual(applied.applied, { updated_rows: 1, audit_rows: 1 });
  assert.deepEqual((await state(mixed.master.id)).exdates, ['2027-12-01T08:00:00.000Z', 'non-una-data']);
  // Tutto il resto è intatto (nightMaster compreso: nessuna UPDATE).
  assert.deepEqual(await Promise.all([ny.overrides[0], icsMaster, ...mixed.overrides, nightMaster].map((e) => state(e.id))), before);
});

test('recurrence_id con i microsecondi (scritto via SQL): riallineato senza far fallire l\'apply', async () => {
  const { cal, overrides: [cancelled] } = await autumnSeries('microsecondi', {
    overrides: [{ originalStart: '2027-11-10T07:00:00.000Z', status: 'cancelled' }],
  });
  // Postgres conserva i microsecondi, Date di JS no: il controllo ottimistico
  // dell'UPDATE deve confrontare al millisecondo.
  await sql`UPDATE calendar_events SET recurrence_id = '2027-11-10 07:00:00.000123+00' WHERE id = ${cancelled.id}::uuid`;
  const applied = await apply([cal]);
  assert.deepEqual(applied.changes.map((c) => [c.from, c.to]), [['2027-11-10T07:00:00.000Z', '2027-11-10T08:00:00.000Z']]);
  assert.deepEqual(applied.applied, { updated_rows: 1, audit_rows: 1 });
  assert.equal(iso((await state(cancelled.id)).recurrence_id!), '2027-11-10T08:00:00.000Z');
  assert.deepEqual(await occurrences(cal, '2027-11-08', '2027-11-13'), []);
});

test('apply con un\'impronta diversa da quella del dry-run: nessuna modifica', async () => {
  const { cal, overrides: [cancelled] } = await autumnSeries('impronta', {
    overrides: [{ originalStart: '2027-11-10T07:00:00.000Z', status: 'cancelled' }],
  });
  const dry = await dryRun(cal);
  assert.equal(dry.changes.length, 1);
  await assert.rejects(
    applyDstFix({ calendarSlugs: [cal.slug], expectPlan: '0000000000000000' }),
    (err: Error & { code?: string }) => err.code === 'DST_PLAN_MISMATCH' && err.message.includes(dry.plan_fingerprint),
  );
  assert.equal(iso((await state(cancelled.id)).recurrence_id!), '2027-11-10T07:00:00.000Z');
  await assert.rejects(buildDstFixReport({ calendarSlugs: [`${fx.prefix}-inesistente`] }), /Calendari inesistenti/);
});

test('planDstFix: impronta deterministica, indipendente dall\'ordine delle righe', () => {
  const master = (id: string): MasterRow => ({
    id, uid: `uid-${id}`, summary: 'Serie', calendar_slug: 'lavoro', calendar_timezone: 'Europe/Rome',
    start_time: new Date(SEPT_START), rrule: 'FREQ=WEEKLY', exdates: ['2027-11-17T07:00:00.000Z'], source: 'manual', status: 'confirmed',
  });
  const override = (id: string, masterId: string): OverrideRow => ({
    id, recurrence_master_id: masterId, recurrence_id: new Date('2027-11-10T07:00:00.000Z'),
    start_time: new Date('2027-11-10T07:00:00.000Z'), status: 'cancelled',
  });
  const masters = [master('a'), master('b')];
  const overrides = [override('o1', 'a'), override('o2', 'b')];
  const plan = planDstFix(masters, overrides);
  assert.equal(plan.changes.length, 4);
  assert.equal(planDstFix([...masters].reverse(), [...overrides].reverse()).fingerprint, plan.fingerprint);
  assert.notEqual(planDstFix(masters.slice(0, 1), overrides.slice(0, 1)).fingerprint, plan.fingerprint);
  // RRULE non interpretabile: nessuna occorrenza, nessuna correzione.
  const invalid = planDstFix([{ ...master('c'), rrule: 'FREQ=MAI' }], []);
  assert.deepEqual([invalid.summary.masters_invalid_rrule, invalid.changes.length], [1, 0]);
});

// ─── CLI ───────────────────────────────

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/** Esegue lo script come in produzione, con il precarico dei test (DB dei test garantito). */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI, '--import', './test/helpers/preload.mjs', 'scripts/fix-dst-exceptions.ts', ...args],
      { cwd: API_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('CLI: dry-run leggibile e JSON, --expect-plan sbagliata rifiutata, apply, errori d\'uso', async () => {
  const { cal, overrides: [cancelled] } = await autumnSeries('cli', {
    overrides: [{ originalStart: '2027-11-10T07:00:00.000Z', status: 'cancelled' }],
  });
  const filter = ['--', '--calendar', cal.slug];

  const table = await runCli(filter);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /DRY-RUN: nessuna modifica scritta/);
  assert.match(table.stdout, /da correggere: 1 \(override 1, exdates 0\)/);
  assert.match(table.stdout, /2027-11-10 07:00Z \(08:00 Roma\)\s+2027-11-10 08:00Z \(09:00 Roma\)\s+riallinea \(legale→solare\)/);
  const hint = /--apply --expect-plan ([0-9a-f]{16}) --calendar (\S+)/.exec(table.stdout);
  assert.ok(hint, 'manca il comando per applicare');
  assert.equal(hint[2], cal.slug);

  const json = await runCli([...filter, '--json']);
  assert.equal(json.code, 0, json.stderr);
  const report = JSON.parse(json.stdout) as DstReport;
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.plan_fingerprint, hint[1]);
  assert.deepEqual(report.calendars, [cal.slug]);
  assert.deepEqual(report.changes.map(brief), [{
    kind: 'override', outcome: 'realign', event_id: cancelled.id, exdate_index: null,
    from: '2027-11-10T07:00:00.000Z', to: '2027-11-10T08:00:00.000Z', direction: 'legale→solare',
  }]);

  const mismatch = await runCli([...filter, '--apply', '--expect-plan', 'ffffffffffffffff']);
  assert.equal(mismatch.code, 3);
  assert.match(mismatch.stderr, /Il piano è cambiato rispetto al dry-run/);
  assert.equal(iso((await state(cancelled.id)).recurrence_id!), '2027-11-10T07:00:00.000Z');

  const applied = await runCli([...filter, '--apply', `--expect-plan=${hint[1]}`, '--json']);
  assert.equal(applied.code, 0, applied.stderr);
  const appliedReport = JSON.parse(applied.stdout) as DstReport;
  runIds.add(appliedReport.run_id);
  assert.deepEqual(appliedReport.applied, { updated_rows: 1, audit_rows: 1 });
  assert.equal(iso((await state(cancelled.id)).recurrence_id!), '2027-11-10T08:00:00.000Z');
  assert.equal((await scriptAudit(appliedReport.run_id)).length, 1);

  const usage = await Promise.all([
    runCli(['--calendar', `${fx.prefix}-inesistente`]),
    runCli(['--expect-plan', hint[1]]),
    runCli(['--sconosciuta']),
  ]);
  assert.deepEqual(usage.map((r) => r.code), [2, 2, 2]);
  assert.match(usage[0].stderr, /Calendari inesistenti/);
  assert.match(usage[1].stderr, /--expect-plan va usato insieme ad --apply/);
});
