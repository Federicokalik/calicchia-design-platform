/**
 * Cron: festività nazionali italiane — auto-mantenute, zero manutenzione.
 *
 * Le festività a data fissa si potrebbero esprimere come FREQ=YEARLY, ma
 * Pasqua e Lunedì dell'Angelo sono mobili e NESSUNA RRULE standard le esprime
 * (la libreria `rrule` non supporta BYEASTER). Invece di reinserirle a mano
 * ogni pochi anni, qui usiamo `date-holidays` (set ufficiale IT, già aggiornato
 * — es. San Francesco d'Assisi festività nazionale dal 2026) e manteniamo gli
 * eventi su una finestra mobile [anno corrente .. +YEARS_AHEAD].
 *
 * Gli eventi sono timed 24h (NON all_day, così bloccano gli slot di
 * prenotazione — gli all_day per design non bloccano) sul calendario
 * "Festività e chiusure" (blocks_availability=true), che ospita anche le
 * chiusure manuali dal–al inserite dall'admin (route /closures, source='admin').
 *
 * Idempotenza: source_id stabile `it-holiday-YYYY-MM-DD`. Ri-esecuzioni non
 * creano duplicati; ogni anno la finestra avanza e vengono aggiunte solo le
 * nuove date (inclusa la Pasqua dell'anno entrante).
 *
 * Calendario su Radicale (design §5 "Festività nuove", §8 "Scrittori di
 * sistema", §13.8; contratto docs/calendar-radicale/contracts/f3-modules.md
 * §6.4):
 *  - store postgres (mode postgres e cutover): invariato. In mode postgres con
 *    lo shadow acceso le righe legacy create qui passano su Radicale dallo
 *    shadow mirror (trigger della 165), come ogni altra scrittura legacy;
 *  - store Radicale: PUT diretta di `it-holiday-YYYY-MM-DD.ics` con UID
 *    `it-holiday-YYYY-MM-DD@caldes.it`, timed 00:00-24:00 Europe/Rome, nella
 *    collezione con role='holidays', con If-None-Match: * (412 = esiste già,
 *    anche per le festività migrate con l'UID legacy e lo stesso href), dentro
 *    il gate cal-write con l'identità del volume verificata e write-through
 *    alla fine. Mai MKCALENDAR: senza la collezione si registra un avviso e
 *    non si scrive nulla. Non passa dalla facade: RadicaleStore riserva
 *    source='system' alle festività e il cron non deve creare calendari.
 */

import {
  buildEventFromLegacy,
  createCalendarObject,
  holidayHref,
  holidayUid,
  serializeObject,
} from '@calicchia/calendar-core';
import Holidays from 'date-holidays';
import { sql } from '../db';
import { readBackendStateFresh, storeKindForMode, storeKindOverride, writesSuspendedInMode } from '../lib/calendar/backend-mode';
import { getOrCreateFestivitaCalendar } from '../lib/calendar/calendars';
import { createEvent, getEventBySource } from '../lib/calendar/events';
import { INDEX_LIMITS } from '../lib/calendar/index-model';
import { objectPath } from '../lib/calendar/radicale/client';
import { isRadicaleError } from '../lib/calendar/radicale/errors';
import { raiseIndexAlert } from '../lib/calendar/radicale/health';
import { radicaleRuntime, syncCollection, verifyVolumeIdentity } from '../lib/calendar/radicale/sync';
import { withCalendarWriteGate } from '../lib/calendar/radicale/write-gate';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'cron-italian-holidays' });

const YEARS_AHEAD = 6;
// Migr. 147: source dedicato per eventi auto-gestiti (prima ripiegava su
// 'admin'; le righe storiche sono state ri-classificate dalla migrazione).
const HOLIDAY_SOURCE = 'system' as const;

/** Fuso delle festività su Radicale: 00:00-24:00 di Roma. */
const HOLIDAY_TZ = 'Europe/Rome';

/** Distanza minima fra due PUT del cron (≤ 20 PUT/s degli scrittori di sistema, design §8). */
const MIN_PUT_INTERVAL_MS = Math.ceil(1_000 / INDEX_LIMITS.maxSystemPutsPerSecond);

/** Una festività della finestra: data (YYYY-MM-DD), nome e istanti assoluti di inizio e fine. */
export interface ItalianHoliday {
  date: string;
  name: string;
  start: string;
  end: string;
}

/** Festività pubbliche italiane della finestra [anno corrente, +YEARS_AHEAD]. */
export function italianHolidaysWindow(now: Date = new Date()): ItalianHoliday[] {
  const hd = new Holidays('IT');
  const currentYear = now.getUTCFullYear();
  const out: ItalianHoliday[] = [];
  for (let year = currentYear; year <= currentYear + YEARS_AHEAD; year++) {
    for (const h of hd.getHolidays(year).filter((x) => x.type === 'public')) {
      // h.date è 'YYYY-MM-DD HH:mm:ss' (wall time IT); h.start / h.end sono istanti assoluti (DST-aware): 00:00 → 24:00 ora di Roma.
      out.push({ date: h.date.slice(0, 10), name: h.name, start: new Date(h.start).toISOString(), end: new Date(h.end).toISOString() });
    }
  }
  return out;
}

export async function runItalianHolidays(): Promise<void> {
  const state = await readBackendStateFresh(sql);
  const kind = storeKindOverride() ?? storeKindForMode(state.mode);
  if (kind === 'radicale') {
    if (writesSuspendedInMode(state.mode)) {
      log.warn({ mode: state.mode }, 'festività: scritture del calendario sospese, riprova al prossimo giro');
      return;
    }
    await runItalianHolidaysOnRadicale(italianHolidaysWindow());
    return;
  }

  // Calendario condiviso "Festività e chiusure" (migr. 148) — lookup/creazione
  // centralizzati in calendars.ts, riusati anche dalle route /closures.
  const { id: calendarId } = await getOrCreateFestivitaCalendar();

  const currentYear = new Date().getUTCFullYear();
  let checked = 0;
  let created = 0;

  for (const h of italianHolidaysWindow()) {
    checked++;
    // La data identifica univocamente la festività.
    const sourceId = `it-holiday-${h.date}`;
    if (await getEventBySource(HOLIDAY_SOURCE, sourceId)) continue;
    await createEvent({
      calendar_id: calendarId,
      summary: h.name,
      start_time: h.start,
      end_time: h.end,
      all_day: false,
      source: HOLIDAY_SOURCE,
      source_id: sourceId,
      status: 'confirmed',
    });
    created++;
  }

  log.info(`Festività IT: ${checked} verificate, ${created} create (finestra ${currentYear}-${currentYear + YEARS_AHEAD})`);
}

/** Esito del giro sullo store Radicale (per log e test). */
export interface RadicaleHolidaysResult {
  checked: number;
  created: number;
  existing: number;
  skipped: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Festività sullo store Radicale (testa del file): PUT con If-None-Match: *
 * di ogni festività della finestra nella collezione role='holidays'. Non crea
 * mai la collezione. Lancia gli errori di Radicale non legati alla singola
 * festività (il cron riprova al giro successivo).
 */
export async function runItalianHolidaysOnRadicale(holidays: readonly ItalianHoliday[], opts: { now?: Date } = {}): Promise<RadicaleHolidaysResult> {
  const result: RadicaleHolidaysResult = { checked: 0, created: 0, existing: 0, skipped: null };
  const rt = radicaleRuntime();
  if (!rt.client) {
    result.skipped = 'radicale_not_configured';
    log.warn({ reason: rt.unavailableReason }, 'festività: Radicale non configurato, nessuna scrittura');
    return result;
  }
  const client = rt.client;
  const [cal] = await sql<Array<{ id: string; collection_name: string }>>`
    SELECT id::text AS id, collection_name
    FROM calendars
    WHERE role = 'holidays' AND lifecycle = 'active' AND collection_name IS NOT NULL
    ORDER BY (slug = 'f') DESC, (slug = 'festivita') DESC, created_at ASC
    LIMIT 1
  `;
  if (!cal) {
    result.skipped = 'collection_missing';
    raiseIndexAlert('holidays-collection-missing', 'Festività non scritte: manca la collezione del calendario festività (role=holidays), la crea solo l\'inizializzazione', {
      key: 'holidays',
    });
    return result;
  }
  const state = await readBackendStateFresh(sql);
  const { check } = await verifyVolumeIdentity({ state });
  if (check.status !== 'ok') {
    result.skipped = `identity_${check.status}`;
    log.warn({ identity: check.status }, 'festività: identità del volume non verificata, nessuna scrittura');
    return result;
  }

  const now = opts.now ?? new Date();
  let lastPutAt = 0;
  for (const h of holidays) {
    result.checked++;
    const uid = holidayUid(h.date);
    const href = holidayHref(h.date);
    const object = createCalendarObject({
      uid,
      componentType: 'VEVENT',
      master: buildEventFromLegacy({
        uid,
        summary: h.name,
        description: null,
        location: null,
        url: null,
        start_time: h.start,
        end_time: h.end,
        all_day: false,
        rrule: null,
        exdates: [],
        status: 'confirmed',
        source: null,
        source_id: null,
      }, { tz: HOLIDAY_TZ, now, created: now, lastModified: now, sequence: 0 }),
    });
    const ics = serializeObject(object);
    const wait = lastPutAt + MIN_PUT_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastPutAt = Date.now();
    const outcome = await withCalendarWriteGate(async (): Promise<'created' | 'existing' | 'collection_missing'> => {
      try {
        await client.put(objectPath(rt.principal, cal.collection_name, href), ics, { ifNoneMatch: '*' });
        return 'created';
      } catch (err) {
        if (isRadicaleError(err, 'precondition_failed')) return 'existing';
        if (isRadicaleError(err, 'not_found')) return 'collection_missing';
        throw err;
      }
    }, { expect: 'radicale' });
    if (outcome === 'collection_missing') {
      result.skipped = 'collection_missing';
      raiseIndexAlert('holidays-collection-missing', 'Festività non scritte: la collezione del calendario festività non esiste su Radicale (mai creata dal cron)', {
        key: 'holidays',
        calendarId: cal.id,
      });
      break;
    }
    if (outcome === 'created') result.created++;
    else result.existing++;
  }

  if (result.created > 0) {
    // Write-through dopo il rilascio del gate: facoltativo, il campanello indicizzerà comunque.
    await syncCollection(cal.id, { reason: 'write-through', actor: 'italian-holidays' }).catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), calendarId: cal.id }, 'write-through delle festività non riuscito: indicizzerà il campanello');
    });
  }
  log.info({ ...result, store: 'radicale' }, `Festività IT su Radicale: ${result.checked} verificate, ${result.created} create`);
  return result;
}
