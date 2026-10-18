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
 *
 * Dalla fase F2 (design §10, contratto f2-modules §9) il corpo lo genera lo
 * store del calendario attraverso la facade (buildCalendarFeed): in mode
 * postgres è il feed di prima (ics-feed.ts, stessa query, stessi header e
 * nessun ETag); con lo store Radicale nasce dall'indice della collezione
 * (lib/calendar/feed-builder.ts) e porta un ETag forte calcolato sul corpo,
 * con 304 su If-None-Match. Token, toggle e rigenerazione restano quelli di
 * oggi. Se il calendario non è verificabile (CalendarUnavailableError, per
 * esempio una collezione mai indicizzata) la risposta è 503 con Retry-After:
 * i client conservano la copia che hanno, mai un calendario svuotato.
 */

import { Hono } from 'hono';
import { getCalendarByFeedToken } from '../../lib/calendar/calendars';
import { isCalendarUnavailable } from '../../lib/calendar/errors';
import { buildCalendarFeed } from '../../lib/calendar/events';
import { feedUidDomain } from '../../lib/calendar/feed-builder';
import { logger } from '../../lib/logger';

const log = logger.child({ scope: 'calendar-feed' });

export const calendarFeed = new Hono();

/** Attesa suggerita ai client quando il feed non è generabile adesso. */
const UNAVAILABLE_RETRY_AFTER_S = 120;

/**
 * If-None-Match contiene l'ETag? Confronto debole (RFC 9110 §13.1.2): `*`,
 * elenco separato da virgole, prefisso W/ ignorato.
 */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const value = header.trim();
  if (value === '*') return true;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = opaque(etag);
  return value.split(',').some((candidate) => opaque(candidate) === target);
}

calendarFeed.get('/:token{.+\\.ics}', async (c) => {
  // Estrai token dal path (rimuove il suffisso .ics)
  const param = c.req.param('token');
  const token = param.replace(/\.ics$/, '');

  if (!token || token.length !== 32 || !/^[a-z0-9]+$/.test(token)) {
    return c.body('Invalid feed token', 400);
  }

  let feed;
  let slug: string;
  try {
    const calendar = await getCalendarByFeedToken(token);
    if (!calendar) {
      return c.body('Feed not found or disabled', 404);
    }
    slug = calendar.slug;
    // Range eventi, filtri (niente cancellati né iscrizioni) e UID: li applica lo store.
    feed = await buildCalendarFeed(calendar, { now: new Date(), uidDomain: feedUidDomain() });
  } catch (err) {
    if (!isCalendarUnavailable(err)) throw err;
    log.warn({ reason: err.reason, detail: err.detail }, 'feed ICS non generabile adesso: 503');
    return c.body('Feed temporaneamente non disponibile, riprova tra poco', 503, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': String(UNAVAILABLE_RETRY_AFTER_S),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `inline; filename="${slug}.ics"`,
    'Cache-Control': 'private, max-age=300',
    // CORS per consentire fetch da web client (es. preview del feed)
    'Access-Control-Allow-Origin': '*',
  };
  // ETag e 304 solo se lo store lo calcola (store Radicale): in mode postgres gli header restano quelli di oggi.
  if (feed.etag) {
    headers.ETag = feed.etag;
    if (ifNoneMatchMatches(c.req.header('If-None-Match'), feed.etag)) {
      return c.body(null, 304, {
        ETag: feed.etag,
        'Cache-Control': headers['Cache-Control'],
        'Access-Control-Allow-Origin': '*',
      });
    }
  }
  return c.body(feed.body, 200, headers);
});
