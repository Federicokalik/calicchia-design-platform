/**
 * Casi di parità fra l'espansione legacy (apps/api/src/lib/calendar/legacy/
 * rrule-legacy.ts, libreria rrule.js, già corretta per il DST in d046006) e
 * expandObject, presi dai casi di apps/api/test/calendar/legacy-cases.test.ts
 * e dagli scenari dei contratti F0 (admin-calendar-v1, _mcp-scenario), più i
 * fatti di produzione (serie infinita lun-mar-gio-ven 09:00 nel calendario
 * "c").
 *
 * Il "modello legacy" replica i passi 2 e 3 di listOccurrences (events-pg.ts)
 * per un master e i suoi override: espansione con expandRRule (finestra
 * inclusiva, EXDATE per istante esatto, tetto di 500), override abbinati al
 * secondo, cancellati esclusi, override nella finestra per sovrapposizione.
 * Il lato calendar-core costruisce l'oggetto come farà la migrazione
 * (buildEventFromLegacy) e lo espande con expandObject.
 *
 * I casi con `diff` documentano le differenze volute: valori attesi espliciti
 * per entrambi i lati.
 */

import {
  buildEventFromLegacy,
  createCalendarObject,
  expandObject,
  getProperty,
  type LegacyEventInput,
  readTimeProperty,
} from '../src/index';
import { localOf, ROME, wallMs } from './ical-builders';

export interface LegacyRowLike {
  start_time: string;
  end_time: string;
  all_day?: boolean;
  rrule?: string | null;
  exdates?: string[];
  recurrence_id?: string | null;
  status?: 'confirmed' | 'tentative' | 'cancelled';
}

export interface ParityCase {
  name: string;
  /** Origine del caso (test o contratto F0, produzione). */
  origin: string;
  master: LegacyRowLike;
  overrides?: LegacyRowLike[];
  from: string;
  to: string;
  /** Differenza voluta: motivo e valori attesi (ora di Roma "YYYY-MM-DD HH:MM", con "→ fine" se `ends`). */
  diff?: { reason: string; legacy: string[]; ours: string[]; ends?: boolean };
}

export type ExpandRRuleFn = (opts: { rrule: string; masterStartIso: string; fromIso: string; toIso: string; exdates?: string[] }) => string[];

/** Occorrenza confrontabile: "inizio ISO|fine ISO|master|override". */
export type ParityOccurrence = string;

const r = (date: string, time = '00:00'): string => new Date(wallMs(date, time)).toISOString();

export const PARITY_CASES: ParityCase[] = [
  {
    name: 'serie giornaliera con override cancellato e millisecondi non allineati',
    origin: 'legacy-cases.test.ts › occorrenze cancellate (override)',
    master: { start_time: '2027-01-05T09:00:00.123Z', end_time: '2027-01-05T10:00:00.123Z', rrule: 'FREQ=DAILY' },
    overrides: [{ start_time: '2027-01-07T09:00:00.123Z', end_time: '2027-01-07T10:00:00.123Z', recurrence_id: '2027-01-07T09:00:00.123Z', status: 'cancelled' }],
    from: '2027-01-05T08:00:00.123Z',
    to: '2027-01-10T09:00:00.123Z',
  },
  {
    name: 'Standup lun-mer-ven COUNT=6 con EXDATE, override spostato e override cancellato',
    origin: 'admin-calendar-v1.contract.test.ts › events: elenco espanso',
    master: { start_time: r('2030-01-07', '09:00'), end_time: r('2030-01-07', '09:15'), rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6', exdates: [r('2030-01-11', '09:00')] },
    overrides: [
      { recurrence_id: r('2030-01-09', '09:00'), start_time: r('2030-01-09', '11:30'), end_time: r('2030-01-09', '11:45') },
      { recurrence_id: r('2030-01-14', '09:00'), start_time: r('2030-01-14', '09:00'), end_time: r('2030-01-14', '09:15'), status: 'cancelled' },
    ],
    from: '2030-01-07T00:00:00.000Z',
    to: '2030-01-19T00:00:00.000Z',
  },
  {
    name: 'serie settimanale a cavallo del passaggio all\'ora legale (31/03/2030)',
    origin: 'admin-calendar-v1.contract.test.ts › serie a cavallo del cambio dell\'ora',
    master: { start_time: r('2030-03-18', '09:00'), end_time: r('2030-03-18', '10:00'), rrule: 'FREQ=WEEKLY;COUNT=4' },
    from: '2030-03-18T00:00:00.000Z',
    to: '2030-04-15T00:00:00.000Z',
  },
  {
    name: 'EXDATE salvato con l\'ora UTC del DTSTART (DST_SHIFTED): non combacia in nessuno dei due',
    origin: 'admin-calendar-v1.contract.test.ts › EXDATE pre-fix',
    master: { start_time: r('2030-03-25', '15:00'), end_time: r('2030-03-25', '16:00'), rrule: 'FREQ=WEEKLY;COUNT=3', exdates: ['2030-04-01T14:00:00.000Z'] },
    from: '2030-03-18T00:00:00.000Z',
    to: '2030-04-15T00:00:00.000Z',
  },
  {
    name: 'Standup lun-ven COUNT=10 dal 22/03/2027 con EXDATE, override, cancellato ed eccezioni DST_SHIFTED',
    origin: '_mcp-scenario.ts › Standup',
    master: {
      start_time: r('2027-03-22', '09:00'),
      end_time: r('2027-03-22', '09:15'),
      rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=10',
      exdates: [r('2027-03-24', '09:00'), '2027-04-01T08:00:00.000Z'],
    },
    overrides: [
      { recurrence_id: r('2027-03-30', '09:00'), start_time: r('2027-03-30', '09:30'), end_time: r('2027-03-30', '09:45') },
      { recurrence_id: r('2027-03-31', '09:00'), start_time: r('2027-03-31', '09:00'), end_time: r('2027-03-31', '09:15'), status: 'cancelled' },
      // Firma pre-fix: 08:00Z = 10:00 dopo il cambio d'ora, nessuna istanza → orfano che resta visibile.
      { recurrence_id: '2027-03-29T08:00:00.000Z', start_time: r('2027-03-29', '12:00'), end_time: r('2027-03-29', '12:15') },
    ],
    from: r('2027-03-22'),
    to: r('2027-04-05'),
  },
  {
    name: 'Palestra mar-gio COUNT=6',
    origin: '_mcp-scenario.ts › Palestra',
    master: { start_time: r('2027-03-23', '18:00'), end_time: r('2027-03-23', '19:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6' },
    from: r('2027-03-22'),
    to: r('2027-04-19'),
  },
  {
    name: 'Corso serale con override spostato al giorno dopo',
    origin: '_mcp-scenario.ts › Corso serale',
    master: { start_time: r('2027-07-05', '18:00'), end_time: r('2027-07-05', '19:30'), rrule: 'FREQ=WEEKLY;COUNT=3' },
    overrides: [{ recurrence_id: r('2027-07-12', '18:00'), start_time: r('2027-07-13', '18:00'), end_time: r('2027-07-13', '19:30') }],
    from: r('2027-07-01'),
    to: r('2027-08-01'),
  },
  {
    name: 'serie infinita lun-mar-gio-ven 09:00 sul ritorno all\'ora solare (25/10/2026)',
    origin: 'produzione, calendario c (inventario 2026-10-09)',
    master: { start_time: r('2025-09-01', '09:00'), end_time: r('2025-09-01', '10:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR' },
    from: r('2026-10-19'),
    to: r('2026-11-02'),
  },
  {
    name: 'serie infinita lun-mar-gio-ven 09:00 sul passaggio all\'ora legale (28/03/2027)',
    origin: 'produzione, calendario c (inventario 2026-10-09)',
    master: { start_time: r('2025-09-01', '09:00'), end_time: r('2025-09-01', '10:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR' },
    from: r('2027-03-22'),
    to: r('2027-04-05'),
  },
  {
    name: 'all-day settimanale COUNT=4 con EXDATE',
    origin: 'all-day legacy (mezzanotte di Roma, all_day=true)',
    master: { start_time: r('2026-11-02'), end_time: r('2026-11-03'), all_day: true, rrule: 'FREQ=WEEKLY;COUNT=4', exdates: [r('2026-11-09')] },
    from: r('2026-11-01'),
    to: r('2026-12-01'),
  },
  {
    name: 'UNTIL come istante: inclusivo in entrambi',
    origin: 'RRULE del form admin (buildRRule)',
    master: { start_time: r('2026-10-05', '09:00'), end_time: r('2026-10-05', '10:00'), rrule: 'FREQ=DAILY;UNTIL=20261009T070000Z' },
    from: r('2026-10-01'),
    to: r('2026-10-20'),
  },
  {
    name: 'UNTIL di sola data su un evento con orario: mezzanotte, il giorno resta escluso (parità fino alla correzione dopo il cutover)',
    origin: 'design §14, "UNTIL di \'fino al\' esclude l\'ultimo giorno"',
    master: { start_time: r('2026-10-05', '09:00'), end_time: r('2026-10-05', '10:00'), rrule: 'FREQ=DAILY;UNTIL=20261009' },
    from: r('2026-10-01'),
    to: r('2026-10-20'),
  },
  {
    name: 'mensile il 31: salta i mesi corti',
    origin: 'RRULE raw dell\'admin',
    master: { start_time: r('2026-01-31', '10:00'), end_time: r('2026-01-31', '11:00'), rrule: 'FREQ=MONTHLY;BYMONTHDAY=31' },
    from: r('2026-01-01'),
    to: r('2026-12-31'),
  },
  {
    name: 'annuale il 29 febbraio',
    origin: 'RRULE raw dell\'admin',
    master: { start_time: r('2024-02-29', '08:00'), end_time: r('2024-02-29', '09:00'), rrule: 'FREQ=YEARLY' },
    from: r('2024-01-01'),
    to: r('2029-01-01'),
  },
  {
    name: 'ultimo venerdì del mese, COUNT=5 e INTERVAL=2',
    origin: 'RRULE raw dell\'admin',
    master: { start_time: r('2026-09-25', '17:00'), end_time: r('2026-09-25', '18:00'), rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=5' },
    from: r('2026-09-01'),
    to: r('2027-09-01'),
  },
  {
    name: 'evento singolo',
    origin: 'legacy-cases.test.ts',
    master: { start_time: r('2026-10-12', '14:00'), end_time: r('2026-10-12', '15:30') },
    from: r('2026-10-12'),
    to: r('2026-10-13'),
  },
  // ─── Differenze volute ───────────────────────────────
  {
    name: 'DTSTART fuori regola',
    origin: 'RFC 5545 §3.8.5.3',
    master: { start_time: r('2026-10-07', '09:00'), end_time: r('2026-10-07', '10:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' },
    from: r('2026-10-01'),
    to: r('2026-12-01'),
    diff: {
      reason: 'DTSTART è sempre la prima istanza e conta per COUNT (RFC 5545, come i device e Radicale nel feed); rrule.js la scarta e conta 3 lunedì',
      legacy: ['2026-10-12 09:00', '2026-10-19 09:00', '2026-10-26 09:00'],
      ours: ['2026-10-07 09:00', '2026-10-12 09:00', '2026-10-19 09:00'],
    },
  },
  {
    name: 'occorrenza della serie già iniziata all\'inizio della finestra',
    origin: 'admin-calendar-v1.contract.test.ts › list-evento-in-corso; design §14',
    master: { start_time: r('2030-01-07', '09:00'), end_time: r('2030-01-07', '09:15'), rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6' },
    from: '2030-01-07T08:05:00.000Z',
    to: '2030-01-07T12:00:00.000Z',
    diff: {
      reason: 'query per sovrapposizione (design §14, "expandRRule.between perde gli eventi in corso")',
      legacy: [],
      ours: ['2030-01-07 09:00'],
    },
  },
  {
    name: 'serie oraria da 600 occorrenze in una sola finestra',
    origin: '_mcp-scenario.ts › Promemoria orario',
    master: { start_time: r('2027-06-07', '00:00'), end_time: r('2027-06-07', '00:05'), rrule: 'FREQ=HOURLY;COUNT=600' },
    from: r('2027-06-06'),
    to: r('2027-07-06'),
    diff: {
      reason: 'il legacy tronca a 500 occorrenze per serie e per query; il tetto nuovo è 5000 nell\'orizzonte con materializedUntil (design §6.4)',
      legacy: ['500 occorrenze'],
      ours: ['600 occorrenze'],
    },
  },
  {
    name: 'BYDAY misto in una regola mensile',
    origin: 'RFC 5545 §3.3.10',
    master: { start_time: r('2026-10-02', '09:00'), end_time: r('2026-10-02', '10:00'), rrule: 'FREQ=MONTHLY;BYDAY=MO,1FR' },
    from: r('2026-10-01'),
    to: r('2026-11-01'),
    diff: {
      reason: 'unione di RFC 5545 (come i device); rrule.js e dateutil richiedono entrambe le forme e non producono istanze',
      legacy: [],
      ours: ['2026-10-02 09:00', '2026-10-05 09:00', '2026-10-12 09:00', '2026-10-19 09:00', '2026-10-26 09:00'],
    },
  },
  {
    name: 'all-day nel giorno del ritorno all\'ora solare',
    origin: 'all-day legacy (fine = inizio + durata in ms)',
    master: { start_time: r('2026-10-24'), end_time: r('2026-10-25'), all_day: true, rrule: 'FREQ=DAILY;COUNT=3' },
    from: r('2026-10-20'),
    to: r('2026-11-01'),
    diff: {
      reason: 'il legacy calcola la fine come inizio + 24 h, quindi il 25/10 (25 ore) finisce alle 23:00; calendar-core usa le date (fine alla mezzanotte del giorno dopo)',
      ends: true,
      legacy: ['2026-10-24 00:00 → 2026-10-25 00:00', '2026-10-25 00:00 → 2026-10-25 23:00', '2026-10-26 00:00 → 2026-10-27 00:00'],
      ours: ['2026-10-24 00:00 → 2026-10-25 00:00', '2026-10-25 00:00 → 2026-10-26 00:00', '2026-10-26 00:00 → 2026-10-27 00:00'],
    },
  },
  {
    name: 'istanza che inizia esattamente alla fine della finestra',
    origin: 'events-pg.ts listOccurrences (between inclusivo)',
    master: { start_time: r('2026-10-05', '09:00'), end_time: r('2026-10-05', '10:00'), rrule: 'FREQ=DAILY;COUNT=5' },
    from: r('2026-10-05'),
    to: r('2026-10-07', '09:00'),
    diff: {
      reason: 'finestra semiaperta [from, to) per sovrapposizione; il legacy include anche l\'istanza che inizia esattamente a `to`',
      legacy: ['2026-10-05 09:00', '2026-10-06 09:00', '2026-10-07 09:00'],
      ours: ['2026-10-05 09:00', '2026-10-06 09:00'],
    },
  },
];

const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const canon = (iso: string): string => new Date(Date.parse(iso)).toISOString();

/** Occorrenze secondo il modello legacy (passi 2 e 3 di listOccurrences, includeCancelled=false). */
export function legacyOccurrences(expandRRule: ExpandRRuleFn, c: ParityCase): ParityOccurrence[] {
  const out: Array<{ start: string; end: string; kind: string }> = [];
  const m = c.master;
  const overrides = c.overrides ?? [];
  const overlaps = (s: string, e: string): boolean => Date.parse(s) < Date.parse(c.to) && Date.parse(e) > Date.parse(c.from);
  const replaced = new Set(overrides.filter((o) => o.recurrence_id).map((o) => sec(o.recurrence_id as string)));
  if (m.rrule) {
    const duration = Date.parse(m.end_time) - Date.parse(m.start_time);
    const starts = expandRRule({ rrule: m.rrule, masterStartIso: m.start_time, fromIso: c.from, toIso: c.to, exdates: m.exdates ?? [] });
    for (const s of starts) {
      if (replaced.has(sec(s))) continue;
      out.push({ start: canon(s), end: new Date(Date.parse(s) + duration).toISOString(), kind: 'master' });
    }
  } else if (overlaps(m.start_time, m.end_time) && m.status !== 'cancelled') {
    out.push({ start: canon(m.start_time), end: canon(m.end_time), kind: 'master' });
  }
  for (const ov of overrides) {
    if (ov.status === 'cancelled') continue;
    if (overlaps(ov.start_time, ov.end_time)) out.push({ start: canon(ov.start_time), end: canon(ov.end_time), kind: 'override' });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)).map((o) => `${o.start}|${o.end}|${o.kind}`);
}

/** Occorrenze di calendar-core: oggetto costruito come la migrazione (buildEventFromLegacy) ed espanso con expandObject. */
export function oursOccurrences(c: ParityCase): ParityOccurrence[] {
  const now = new Date('2026-10-09T08:00:00Z');
  const uid = 'parita@caldes.test';
  const row = (x: LegacyRowLike): LegacyEventInput => ({
    uid,
    summary: c.name,
    start_time: x.start_time,
    end_time: x.end_time,
    all_day: c.master.all_day ?? false,
    rrule: x.rrule ?? null,
    exdates: x.exdates ?? [],
    recurrence_id: x.recurrence_id ?? null,
    status: x.status ?? 'confirmed',
  });
  const master = buildEventFromLegacy(row(c.master), { tz: ROME, now });
  const masterStart = readTimeProperty(getProperty(master, 'DTSTART')!);
  const overrides = (c.overrides ?? []).map((o) => buildEventFromLegacy(row(o), { tz: ROME, now, masterStart }));
  const obj = createCalendarObject({ uid, master, overrides });
  const res = expandObject(obj, { from: Date.parse(c.from), to: Date.parse(c.to), tz: ROME });
  return res.occurrences
    .filter((o) => o.status !== 'CANCELLED')
    .map((o) => ({ start: new Date(o.startUtc).toISOString(), end: new Date(o.endUtc).toISOString(), kind: o.kind === 'event' ? 'master' : 'override' }))
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
    .map((o) => `${o.start}|${o.end}|${o.kind}`);
}

/** Vista leggibile per i casi con differenza: ora di Roma dell'inizio (e della fine con `ends`), o il conteggio oltre 50. */
export function describeOccurrences(list: ParityOccurrence[], ends = false): string[] {
  if (list.length > 50) return [`${list.length} occorrenze`];
  return list.map((o) => {
    const [s, e] = o.split('|');
    return ends ? `${localOf(Date.parse(s))} → ${localOf(Date.parse(e))}` : localOf(Date.parse(s));
  });
}
