/**
 * Feed ICS pubblico generato dall'indice derivato (fase F2 del passaggio a
 * Radicale; design §10 "Condivisione invariata", §14 "Feed"; contratto dei
 * moduli docs/calendar-radicale/contracts/f2-modules.md §9).
 *
 * `buildIndexFeed` è l'implementazione di RadicaleStore.buildCalendarFeed: la
 * route `GET /api/calendar/feed/<token>.ics` resta quella di oggi (stessi
 * token, toggle e rigenerazione) e chiama la facade; in mode postgres il feed
 * lo produce ancora PgLegacyStore (ics-feed.ts, senza ETag).
 *
 * Contenuto (feed-transform di @calicchia/calendar-core, che applica le regole
 * del design §10):
 *  - dall'indice della collezione (cal_objects), quindi funziona anche con
 *    Radicale giù: serie sempre, singoli nella finestra −90/+365 giorni;
 *  - niente iscrizioni (vivono nel sidecar dell'iscrizione, mai in questa
 *    collezione, e gli oggetti remoti si escludono comunque) e niente master o
 *    singoli STATUS:CANCELLED, anche se scritti dai device;
 *  - override nella risorsa del master con lo stesso UID, occorrenze
 *    cancellate come EXDATE, VTIMEZONE deduplicati;
 *  - whitelist delle proprietà (niente VALARM, ATTENDEE, ORGANIZER, X-*) e
 *    CLASS:PRIVATE/CONFIDENTIAL → "Occupato";
 *  - UID: `legacy_uid@CAL_FEED_UID_DOMAIN` per gli oggetti migrati
 *    (cal_object_ids.legacy_uid, l'UID che gli abbonati vedono oggi, anche
 *    per le proiezioni delle prenotazioni); un oggetto migrato senza
 *    legacy_uid (legacy_event_id valorizzato) usa il proprio UID con il
 *    dominio, sempre, come il feed legacy (`${uid}@dominio` anche per gli UID
 *    con '@'): gli abbonati non vedono duplicati dopo il cutover. Gli altri
 *    oggetti: suffisso `@CAL_FEED_UID_DOMAIN` per gli UID senza '@', gli
 *    altri invariati;
 *  - proiezioni delle prenotazioni (risorse booking-<uid>.ics, source
 *    'booking'): il contenuto si ricompone al momento del feed dai dati
 *    correnti di calendar_bookings e calendar_event_types con la decisione 3
 *    (feed-transform.bookingProjectionContent, lo stesso testo che l'API
 *    scrive per i device): titolo con il nome, telefono e link all'admin,
 *    "Prenotazione" dopo 24 mesi dalla fine o se la prenotazione non c'è più
 *    (erasure). Qualunque testo ci sia in Radicale (una proiezione migrata
 *    con l'email, una scritta prima della scadenza dei 24 mesi), il feed non
 *    pubblica più di così;
 *  - DTSTAMP stabile (LAST-MODIFIED o first_seen_at): due letture senza
 *    modifiche danno lo stesso corpo.
 *
 * Oggetti in quarantena: se il testo corrente non si legge si pubblica
 * l'ultima versione buona (come fanno le occorrenze del busy, design §6.5);
 * senza versione buona l'oggetto resta fuori e si registra un avviso. Un solo
 * oggetto non porta mai il feed in errore.
 *
 * Finestra e ETag. La finestra si àncora al giorno di Europe/Rome: va
 * dall'inizio del giorno − 90 giorni alla fine del giorno + 365 giorni, quindi
 * comprende tutto ciò che il feed legacy pubblicherebbe in qualunque ora del
 * giorno e il corpo resta identico per tutta la giornata (anche fra processi
 * diversi e dopo un riavvio). L'ETag è lo SHA-256 del corpo: cambia quando la
 * finestra scorre al giorno dopo e un evento entra o esce (la festività che
 * entra a +365 giorni arriva agli abbonati di `f`), o quando cambia l'indice.
 * Cache in memoria per (index_version della collezione, calendars.updated_at,
 * campi del calendario, FEED_TRANSFORM_VERSION, data di Roma, dominio degli
 * UID), con single-flight per chiave. I dati delle prenotazioni non sono
 * nella chiave: una modifica di calendar_bookings arriva al feed al più dopo
 * FEED_CACHE_TTL_MS (la proiezione stessa la aggiorna il suo job).
 *
 * Collezione mai indicizzata (nessuna sync riuscita): CalendarUnavailableError
 * invece di un feed vuoto, così i client degli abbonati conservano la copia
 * che hanno (mai un calendario svuotato per errore).
 *
 * Regola d'import (contratto §10): nessun import della facade o di store.ts;
 * lo carica radicale/store.ts alla prima chiamata.
 */

import {
  type BookingProjectionData,
  buildFeed,
  type CalendarObject,
  FEED_FUTURE_DAYS,
  FEED_PAST_DAYS,
  FEED_TRANSFORM_VERSION,
  type FeedObjectInput,
  parseCalendarObject,
} from '@calicchia/calendar-core';
import { fromZonedTime } from 'date-fns-tz';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../logger';
import { publicApiUrl } from '../public-url';
import { CalendarUnavailableError } from './errors';
import { resolveLocationForBooking } from './meeting-url';
import type { Db } from './radicale/policy';
import type { Booking, Calendar, CalendarFeedOptions, CalendarFeedResult, EventType } from './types';
import { isValidTimeZone } from './validation';

const log: Logger = rootLogger.child({ scope: 'calendar-feed-builder' });

/** Fuso del giorno a cui si àncora la finestra (quello del feed legacy e della capacity). */
export const FEED_DAY_TZ = 'Europe/Rome';

/** Voci massime della cache dei feed (una per calendario). */
export const FEED_CACHE_MAX_ENTRIES = 64;

/**
 * Età massima di una voce di cache: la chiave copre tutto ciò che cambia il
 * corpo tranne legacy_uid (preassegnato dalla migrazione F3, senza
 * index_version). Il ricalcolo è deterministico: l'ETag non cambia se il corpo
 * non cambia.
 */
export const FEED_CACHE_TTL_MS = 15 * 60_000;

/** Fuso di ripiego per floating e all-day se il calendario non ne ha uno valido. */
const FALLBACK_TZ = 'Europe/Rome';

const DAY_MS = 86_400_000;

// ─── Dominio degli UID ───────────────────────────────

/** Nome host plausibile: niente spazi, '@', '/', ':' né caratteri di controllo. */
const UID_DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/**
 * Dominio degli UID del feed (design §10): CAL_FEED_UID_DOMAIN se impostata e
 * valida, altrimenti l'host di publicApiUrl() calcolato come il feed di oggi
 * (stessa espressione di routes/calendar/feed.ts prima della F2), con ripiego
 * 'caldes.it'. Il valore va congelato: cambiarlo cambierebbe gli UID visti
 * dagli abbonati, quindi la variabile serve a fissare quello di oggi.
 */
export function feedUidDomain(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CAL_FEED_UID_DOMAIN?.trim();
  if (explicit) {
    if (UID_DOMAIN_RE.test(explicit)) return explicit;
    log.warn({ value: explicit.slice(0, 80) }, 'CAL_FEED_UID_DOMAIN non valida: uso l\'host di PUBLIC_API_URL');
  }
  return publicApiUrl().replace(/^https?:\/\//, '').replace(/[/:].*/, '') || 'caldes.it';
}

// ─── Finestra ───────────────────────────────

/**
 * Giorno di Europe/Rome di `now` e istante d'àncora della finestra (inizio di
 * quel giorno). Con FEED_PAST_DAYS e FEED_FUTURE_DAYS + 1 giorni la finestra
 * copre [inizio giorno − 90 g, fine giorno + 365 g).
 */
export function feedWindowAnchor(now: Date): { day: string; anchor: Date } {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: FEED_DAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return { day, anchor: fromZonedTime(`${day}T00:00:00`, FEED_DAY_TZ) };
}

// ─── Cache ───────────────────────────────

interface CacheEntry {
  key: string;
  result: CalendarFeedResult;
  at: number;
}

/** Ultimo feed per calendario (Map in ordine d'uso: la prima voce è la meno recente). */
const cache = new Map<string, CacheEntry>();
/** Generazioni in corso per chiave (single-flight). */
const inflight = new Map<string, Promise<CalendarFeedResult>>();

function cacheGet(calendarId: string, key: string): CalendarFeedResult | null {
  const entry = cache.get(calendarId);
  if (!entry || entry.key !== key || performance.now() - entry.at > FEED_CACHE_TTL_MS) return null;
  cache.delete(calendarId);
  cache.set(calendarId, entry);
  return entry.result;
}

function cachePut(calendarId: string, key: string, result: CalendarFeedResult): void {
  cache.delete(calendarId);
  cache.set(calendarId, { key, result, at: performance.now() });
  while (cache.size > FEED_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Svuota la cache dei feed (test; dopo una migrazione che riassegna legacy_uid). */
export function clearIndexFeedCache(): void {
  cache.clear();
}

// ─── Lettura dell'indice ───────────────────────────────

interface CollectionVersionRow {
  role: string;
  updated_at: Date | null;
  timezone: string | null;
  index_version: string | null;
  origin_store: string | null;
  last_synced_at: Date | null;
  last_full_sync_at: Date | null;
  rebuild_required: boolean | null;
}

interface FeedObjectRow {
  id: string;
  href: string;
  raw_ics: string | null;
  health: string;
  first_seen_at: Date;
  source: string | null;
  source_id: string | null;
  legacy_uid: string | null;
  legacy_event_id: string | null;
  last_good_raw: string | null;
}

async function readCollectionVersion(db: Db, calendarId: string): Promise<CollectionVersionRow | null> {
  const [row] = await db<CollectionVersionRow[]>`
    SELECT c.role, c.updated_at, c.timezone,
           st.index_version::text AS index_version, st.origin_store,
           st.last_synced_at, st.last_full_sync_at,
           (SELECT b.rebuild_required FROM calendar_backend_state b LIMIT 1) AS rebuild_required
    FROM calendars c
    LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
    WHERE c.id = ${calendarId}::uuid
  `;
  return row ?? null;
}

/**
 * Oggetti candidati al feed: risorse Radicale VEVENT della collezione (o
 * illeggibili, che potrebbero avere un'ultima versione buona), filtrate sulla
 * finestra con un margine di due giorni; la decisione esatta la prende
 * feed-transform. Serie, intervalli aperti e oggetti non sani passano sempre.
 */
async function readFeedObjects(db: Db, calendarId: string, from: Date, to: Date): Promise<FeedObjectRow[]> {
  const fromSlack = new Date(from.getTime() - 2 * DAY_MS);
  const toSlack = new Date(to.getTime() + 2 * DAY_MS);
  return db<FeedObjectRow[]>`
    SELECT o.id, o.href, o.raw_ics, o.health, o.first_seen_at, o.source, o.source_id,
           ids.legacy_uid, ids.legacy_event_id::text AS legacy_event_id,
           CASE WHEN o.health <> 'ok' THEN v.raw_ics END AS last_good_raw
    FROM cal_objects o
    LEFT JOIN cal_object_ids ids ON ids.id = o.id
    LEFT JOIN cal_object_versions v ON v.id = o.last_good_version_id
    WHERE o.calendar_id = ${calendarId}::uuid
      AND o.origin_store = 'radicale'
      AND o.source <> 'ics_pull'
      AND o.component IN ('VEVENT', 'UNKNOWN')
      AND (
        o.health <> 'ok'
        OR o.is_recurring
        OR o.range_start IS NULL
        OR o.range_end IS NULL
        OR (o.range_start < ${toSlack.toISOString()}::timestamptz AND o.range_end >= ${fromSlack.toISOString()}::timestamptz)
      )
    ORDER BY o.href
  `;
}

// ─── Proiezioni delle prenotazioni (decisione 3) ───────────────────────────────

/** Prenotazioni lette per volta (ANY di un array: una query anche per molte proiezioni). */
const MAX_BOOKINGS_PER_QUERY = 1_000;

/**
 * Link alla prenotazione nell'admin: lo stesso di
 * booking-projection.bookingAdminUrl (ADMIN_URL), che scrive le risorse dei
 * device; ricalcolato qui per non importare il job delle proiezioni nel feed.
 */
export function feedBookingAdminUrl(uid: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.ADMIN_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/calendario/prenotazioni?uid=${encodeURIComponent(uid)}`;
}

interface ProjectionBookingRow {
  uid: string;
  attendee_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  start_time: Date | string;
  end_time: Date | string;
  location_value: string | null;
  event_title: string | null;
  event_location_type: EventType['location_type'] | null;
  event_location_value: string | null;
}

/** True se l'oggetto è la proiezione di una prenotazione (collezione Prenotazioni, href booking-<uid>.ics). */
function projectionUid(row: FeedObjectRow): string | null {
  return row.source === 'booking' && typeof row.source_id === 'string' && row.source_id !== '' ? row.source_id : null;
}

/**
 * Dati della decisione 3 per le prenotazioni date, da calendar_bookings e
 * calendar_event_types (le assenti, per esempio dopo un'erasure, non sono nella mappa:
 * il feed le riduce a "Prenotazione"). Mai email, azienda né messaggio.
 */
export async function readBookingProjectionData(db: Db, uids: readonly string[]): Promise<Map<string, BookingProjectionData>> {
  const out = new Map<string, BookingProjectionData>();
  const unique = [...new Set(uids)];
  for (let i = 0; i < unique.length; i += MAX_BOOKINGS_PER_QUERY) {
    const chunk = unique.slice(i, i + MAX_BOOKINGS_PER_QUERY);
    const rows = await db<ProjectionBookingRow[]>`
      SELECT b.uid, b.attendee_name, b.attendee_email, b.attendee_phone, b.start_time, b.end_time, b.location_value,
             et.title AS event_title, et.location_type AS event_location_type, et.location_value AS event_location_value
      FROM calendar_bookings b
      LEFT JOIN calendar_event_types et ON et.id = b.event_type_id
      WHERE b.uid = ANY(${chunk}::text[])
    `;
    for (const row of rows) {
      // Stesso link della riunione della risorsa scritta dall'API (resolveLocationForBooking).
      const resolved = row.event_location_type
        ? await resolveLocationForBooking({
          eventType: { location_type: row.event_location_type, location_value: row.event_location_value } as EventType,
          booking: {
            uid: row.uid,
            start_time: String(row.start_time),
            end_time: String(row.end_time),
            attendee_name: row.attendee_name ?? '',
            attendee_email: row.attendee_email ?? '',
          } as Pick<Booking, 'uid' | 'start_time' | 'end_time' | 'attendee_name' | 'attendee_email'>,
        })
        : null;
      out.set(row.uid, {
        bookingUid: row.uid,
        title: row.event_title ?? 'Prenotazione',
        attendeeName: row.attendee_name ?? '',
        attendeePhone: row.attendee_phone,
        adminUrl: feedBookingAdminUrl(row.uid),
        start: row.start_time instanceof Date ? row.start_time : String(row.start_time),
        end: row.end_time instanceof Date ? row.end_time : String(row.end_time),
        location: row.location_value,
        meetingUrl: resolved?.meetingUrl ?? null,
      });
    }
  }
  return out;
}

/** Testo pubblicabile di un oggetto: corrente se si legge, altrimenti l'ultima versione buona. */
function objectForFeed(row: FeedObjectRow, calendarId: string): CalendarObject | null {
  if (row.raw_ics) {
    const current = parseCalendarObject(row.raw_ics);
    if (current.ok) return current.value;
  }
  if (row.last_good_raw) {
    const good = parseCalendarObject(row.last_good_raw);
    if (good.ok) return good.value;
  }
  log.warn({ calendarId, objectId: row.id, href: row.href, health: row.health }, 'oggetto illeggibile senza versione buona: escluso dal feed');
  return null;
}

// ─── Generazione ───────────────────────────────

/**
 * Feed ICS di un calendario dall'indice (testa del file). `db` è il pool o la
 * transazione su cui leggere; `opts.now` fissa il giorno della finestra,
 * `opts.uidDomain` il dominio degli UID (feedUidDomain() nella route).
 * Lancia CalendarUnavailableError se la collezione non è mai stata
 * indicizzata; gli errori del database si propagano.
 */
export async function buildIndexFeed(db: Db, calendar: Calendar, opts: CalendarFeedOptions): Promise<CalendarFeedResult> {
  const version = await readCollectionVersion(db, calendar.id);
  if (!version) {
    // Il calendario è sparito fra la lettura del token e quella dell'indice.
    throw new CalendarUnavailableError('collection_unsyncable', `calendario ${calendar.id} non trovato nell'indice`);
  }
  const subscription = version.role === 'subscription' || version.origin_store === 'remote';
  if (!subscription && !version.last_synced_at && !version.last_full_sync_at) {
    throw new CalendarUnavailableError(
      version.rebuild_required ? 'rebuild_in_progress' : 'collection_unsyncable',
      `collezione ${calendar.id} mai indicizzata: il feed non si genera da un indice vuoto`,
    );
  }

  const tz = isValidTimeZone(calendar.timezone) ? calendar.timezone : isValidTimeZone(version.timezone) ? version.timezone : FALLBACK_TZ;
  const { day, anchor } = feedWindowAnchor(opts.now);
  const key = JSON.stringify([
    version.index_version ?? 'none',
    version.updated_at instanceof Date ? version.updated_at.toISOString() : String(version.updated_at ?? ''),
    calendar.name, calendar.description ?? null, calendar.color, tz,
    FEED_TRANSFORM_VERSION, day, opts.uidDomain,
  ]);
  const cached = cacheGet(calendar.id, key);
  if (cached) return cached;

  const flightKey = `${calendar.id}|${key}`;
  const running = inflight.get(flightKey);
  if (running) return running;
  const job = (async (): Promise<CalendarFeedResult> => {
    // Iscrizioni: mai nel feed (fonte remota, design §10). Un sidecar non ha token pubblici, ma per
    // sicurezza il suo feed resta vuoto invece di ripubblicare il calendario sottostante.
    const rows = subscription
      ? []
      : await readFeedObjects(db, calendar.id, new Date(anchor.getTime() - FEED_PAST_DAYS * DAY_MS), new Date(anchor.getTime() + (FEED_FUTURE_DAYS + 1) * DAY_MS));
    const projectionUids = rows.map(projectionUid).filter((uid): uid is string => uid !== null);
    const bookings = projectionUids.length > 0 ? await readBookingProjectionData(db, projectionUids) : new Map<string, BookingProjectionData>();
    const inputs: FeedObjectInput[] = [];
    for (const row of rows) {
      const object = objectForFeed(row, calendar.id);
      if (!object) continue;
      const bookingUid = projectionUid(row);
      inputs.push({
        object,
        firstSeenAt: row.first_seen_at,
        // Oggetto migrato senza legacy_uid: l'UID di oggi con il dominio, come il feed legacy.
        legacyUid: row.legacy_uid ?? (row.legacy_event_id ? object.uid : null),
        bookingProjection: bookingUid ? { data: bookings.get(bookingUid) ?? null } : null,
      });
    }
    const feed = buildFeed(
      { name: calendar.name, description: calendar.description ?? null, timezone: tz, color: calendar.color },
      inputs,
      {
        now: anchor,
        uidDomain: opts.uidDomain,
        tz,
        pastDays: FEED_PAST_DAYS,
        futureDays: FEED_FUTURE_DAYS + 1,
        onObjectError: (input, error) => {
          log.warn({ calendarId: calendar.id, uid: input.object.uid, code: error.code, err: error.message }, 'oggetto escluso dal feed: trasformazione non riuscita');
        },
      },
    );
    const result: CalendarFeedResult = { body: feed.body, etag: feed.etag };
    cachePut(calendar.id, key, result);
    return result;
  })();
  inflight.set(flightKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(flightKey);
  }
}
