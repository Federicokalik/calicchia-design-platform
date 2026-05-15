/**
 * Public ICS feed per subscription da iPhone/macOS Calendar/Outlook/Thunderbird.
 *
 * URL: GET /api/calendar/feed/:token.ics
 *
 * Token random 32 char (~190 bit) nel path (NON query) per evitare strip nei
 * log access dei reverse proxy. Validation lato server: lookup su
 * `calendars.ics_feed_token`. Niente auth headers (i client subscription non
 * possono inviarli).
 *
 * Range eventi inclusi nel feed:
 * - Eventi singoli: ultimi 90 giorni → +365 giorni futuro
 * - Master ricorrenti: emessi as-is (RRULE/EXDATE) — il client espande lui
 *
 * Cache: 5 minuti (sufficienti per refresh iPhone Calendar che è ogni 5min-1h).
 */

import { Hono } from 'hono';
import { sql } from '../../db';
import { getCalendarByFeedToken } from '../../lib/calendar/calendars';
import { buildIcsFeed } from '../../lib/calendar/ics-feed';
import type { CalendarEvent } from '../../lib/calendar/types';

export const calendarFeed = new Hono();

calendarFeed.get('/:token{.+\\.ics}', async (c) => {
  // Estrai token dal path (rimuove il suffisso .ics)
  const param = c.req.param('token');
  const token = param.replace(/\.ics$/, '');

  if (!token || token.length !== 32 || !/^[a-z0-9]+$/.test(token)) {
    return c.body('Invalid feed token', 400);
  }

  const calendar = await getCalendarByFeedToken(token);
  if (!calendar) {
    return c.body('Feed not found or disabled', 404);
  }

  // Range eventi: ultimi 90 giorni → +365 giorni futuro
  const now = new Date();
  const fromIso = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const toIso = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

  // Query eventi del calendario nel range
  // - Eventi singoli che si sovrappongono al range
  // - Master ricorrenti il cui start_time è prima del fine range
  // - Override (sostituiscono occorrenze del master)
  //
  // Esclusi: gli eventi importati da ICS subscription (source='ics_pull').
  // Sono già sull'origine remota dell'utente (es. Google) — ripubblicarli sul
  // feed Caldes esporrebbe il calendario sottostante a chiunque abbia il token,
  // e creerebbe un loop se Caldes si auto-sottoscrivesse al proprio feed.
  const events = await sql<CalendarEvent[]>`
    SELECT id, calendar_id, uid, summary, description, location, url,
           start_time, end_time, all_day,
           rrule, exdates, recurrence_id, recurrence_master_id,
           source, source_id, status, created_at, updated_at
    FROM calendar_events
    WHERE calendar_id = ${calendar.id}::uuid
      AND status != 'cancelled'
      AND source != 'ics_pull'
      AND (
        rrule IS NOT NULL
        OR (start_time < ${toIso}::timestamptz AND end_time > ${fromIso}::timestamptz)
      )
    ORDER BY start_time ASC
  `;

  const ics = buildIcsFeed({
    calendar,
    events,
    uidDomain: process.env.PUBLIC_API_URL?.replace(/^https?:\/\//, '').replace(/[/:].*/, '') || 'caldes.it',
  });

  return c.body(ics, 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `inline; filename="${calendar.slug}.ics"`,
    'Cache-Control': 'private, max-age=300',
    // CORS per consentire fetch da web client (es. preview del feed)
    'Access-Control-Allow-Origin': '*',
  });
});
