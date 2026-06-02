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
 * "Festività" (blocks_availability=true).
 *
 * Idempotenza: source_id stabile `it-holiday-YYYY-MM-DD`. Ri-esecuzioni non
 * creano duplicati; ogni anno la finestra avanza e vengono aggiunte solo le
 * nuove date (inclusa la Pasqua dell'anno entrante).
 */

import Holidays from 'date-holidays';
import { createCalendar } from '../lib/calendar/calendars';
import { createEvent, getEventBySource } from '../lib/calendar/events';
import { sql } from '../db';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'cron-italian-holidays' });

const YEARS_AHEAD = 6;
// La tabella calendar_events vincola source a un set fisso; 'admin' è quello
// semanticamente più vicino per eventi gestiti dal sistema senza migrazione.
const HOLIDAY_SOURCE = 'admin' as const;

/**
 * Trova il calendario "Festività" esistente (per nome o slug, così riusa quello
 * eventualmente già creato a mano dall'utente) o ne crea uno dedicato.
 */
async function getOrCreateFestivitaCalendarId(): Promise<string> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM calendars
    WHERE lower(name) = 'festività' OR slug = 'festivita'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (existing[0]) return existing[0].id;

  const cal = await createCalendar({
    slug: 'festivita',
    name: 'Festività',
    description: 'Festività nazionali italiane (auto-gestite)',
    color: '#ef4444',
    timezone: 'Europe/Rome',
    blocks_availability: true,
  });
  log.info(`Calendario "Festività" creato (${cal.id})`);
  return cal.id;
}

export async function runItalianHolidays(): Promise<void> {
  const calendarId = await getOrCreateFestivitaCalendarId();

  const hd = new Holidays('IT');
  const currentYear = new Date().getUTCFullYear();

  let checked = 0;
  let created = 0;

  for (let year = currentYear; year <= currentYear + YEARS_AHEAD; year++) {
    const holidays = hd.getHolidays(year).filter((h) => h.type === 'public');
    for (const h of holidays) {
      checked++;
      // h.date è 'YYYY-MM-DD HH:mm:ss' (wall time IT); la data identifica univocamente la festività.
      const sourceId = `it-holiday-${h.date.slice(0, 10)}`;
      if (await getEventBySource(HOLIDAY_SOURCE, sourceId)) continue;
      // h.start / h.end sono istanti assoluti (DST-aware): 00:00 → 24:00 ora di Roma.
      await createEvent({
        calendar_id: calendarId,
        summary: h.name,
        start_time: new Date(h.start).toISOString(),
        end_time: new Date(h.end).toISOString(),
        all_day: false,
        source: HOLIDAY_SOURCE,
        source_id: sourceId,
        status: 'confirmed',
      });
      created++;
    }
  }

  log.info(`Festività IT: ${checked} verificate, ${created} create (finestra ${currentYear}-${currentYear + YEARS_AHEAD})`);
}
