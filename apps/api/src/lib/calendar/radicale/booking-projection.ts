/**
 * Proiezione delle prenotazioni nella collezione Prenotazioni di Radicale e
 * controllo delle sovrapposizioni dopo una decisione (fase F2 del passaggio a
 * Radicale, spostato in radicale/ nella F3; design §5 "UID e href", §8
 * "Scrittori di sistema", §9 "Proiezione delle prenotazioni" e "Protocollo di
 * decisione", §16.4; decisione 3; contratti dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §3 e §7.4,
 * docs/calendar-radicale/contracts/f3-modules.md §6.4 e §13).
 *
 * `lib/calendar/booking-projection.ts` resta come `export *` di questo file
 * per compatibilità con gli import esistenti.
 *
 * Contenuto (una sola implementazione, decisione 3): buildBookingProjectionIcs
 * usa bookingProjectionContent di @calicchia/calendar-core, lo stesso testo
 * che il feed pubblico ricompone da calendar_bookings e che il serializer
 * della migrazione scrive: titolo con il nome del cliente, telefono e link
 * alla prenotazione in admin; niente email, azienda, messaggio né ATTENDEE.
 * Le proiezioni concluse da più di 24 mesi, e quelle di una prenotazione
 * anonimizzata dall'erasure GDPR (attendee_email `erased-<id>@deleted.invalid`),
 * diventano "Prenotazione" senza descrizione, luogo e link. Admin e MCP vedono
 * comunque la descrizione completa, ricomposta da calendar_bookings
 * (adapters.projectionDescription).
 *
 * Proiezione (job `project_booking`, handler in booking.ts):
 *  - stato desiderato calcolato all'esecuzione da calendar_bookings:
 *    confirmed, completed e no_show → risorsa presente; pending, cancelled o
 *    prenotazione sparita → risorsa assente (le pending non si proiettano,
 *    parità);
 *  - href `booking-<uid>.ics`, UID `<uid>@caldes.it` (lo stesso dell'invito,
 *    ics.ts), nella collezione con role='bookings';
 *  - PUT con If-None-Match: * (un 412 significa "esiste già"), DELETE con
 *    If-Match dell'ETag letto; dentro il gate cal-write (radicale/write-gate.ts)
 *    con l'identità del volume verificata; write-through della collezione
 *    dopo il rilascio del gate;
 *  - convergente e idempotente: una risorsa già presente non viene riscritta
 *    (le modifiche fatte dall'API alle proiezioni, consentite oggi, non si
 *    annullano, design §9) TRANNE quando la minimizzazione cambia stato
 *    (oltre 24 mesi dalla fine, prenotazione anonimizzata): allora si
 *    confrontano i soli campi della decisione 3 (SUMMARY, DESCRIPTION,
 *    LOCATION, URL) e la risorsa si riscrive con If-Match dell'ETag letto,
 *    applicando la patch per campo all'oggetto corrente (il resto resta). Se
 *    gli orari della risorsa non sono quelli della prenotazione parte un
 *    avviso di deriva (BOOKING_DRIFT).
 *
 * Sovrapposizioni (design §9, "post"): dopo il commit della prenotazione si
 * verifica di nuovo la freshness e si confrontano le occorrenze bloccanti
 * sovrapposte con quelle già presenti al momento della decisione; quelle
 * nuove (un evento comparso fra la verifica e il commit, o durante la
 * modalità degradata) finiscono in cal_booking_conflicts con un avviso.
 * Nessun annullamento automatico.
 *
 * Mai MKCALENDAR: se la collezione Prenotazioni non c'è la proiezione si salta
 * (come oggi senza calendario 'bookings').
 */

import {
  applyComponentOps,
  type BookingProjectionContent as CoreProjectionContent,
  type BookingProjectionData,
  bookingHref,
  bookingProjectionContent,
  bookingProjectionUid,
  createCalendarObject,
  createComponent,
  createProperty,
  getTextValue,
  type PatchOp,
  parseCalendarObject,
  serializeObject,
  setTextValue,
} from '@calicchia/calendar-core';
import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { getEventType } from '../availability';
import { indexBlockingOccurrences, type BlockingOccurrence } from '../busy';
import { CalendarUnavailableError } from '../errors';
import { INDEX_LIMITS } from '../index-model';
import { resolveLocationForBooking } from '../meeting-url';
import type { Booking, BookingStatus } from '../types';
import { objectPath, type RadicaleClient } from './client';
import { isRadicaleError } from './errors';
import { raiseIndexAlert } from './health';
import type { Db } from './policy';
import { radicaleRuntime, syncCollection, verifyVolumeIdentity } from './sync';
import type { CalendarBackendState } from './types';
import { withCalendarWriteGate } from './write-gate';

const log: Logger = rootLogger.child({ scope: 'calendar-booking-projection' });

// ─── Regole ───────────────────────────────

/** Stati proiettati nella collezione Prenotazioni (le pending no: parità). */
export const PROJECTED_BOOKING_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>(['confirmed', 'completed', 'no_show']);

/** Retention della decisione 3: oltre questi mesi dalla fine la proiezione è solo "Prenotazione". */
export const PROJECTION_RETENTION_MONTHS = 24;

/** PRODID delle proiezioni scritte dall'API. */
export const BOOKING_PROJECTION_PRODID = '-//Caldes//Prenotazioni//IT';

/** Titolo delle proiezioni oltre la retention (o anonimizzate). */
export const RETAINED_PROJECTION_SUMMARY = 'Prenotazione';

/**
 * Email di una prenotazione anonimizzata dall'erasure GDPR (contratto f3 §13.1,
 * stesso schema di clienti e lead): `erased-<id>@deleted.invalid`. Nessuna
 * colonna nuova in calendar_bookings: i SELECT * legacy non cambiano forma.
 */
export const ANONYMIZED_BOOKING_EMAIL_RE = /^erased-[^@\s]+@deleted\.invalid$/i;

/** Nome con cui l'erasure sostituisce quello del cliente. */
export const ANONYMIZED_ATTENDEE_NAME = 'Dato cancellato (GDPR)';

/** Email anonimizzata di una prenotazione (id della riga). */
export function anonymizedBookingEmail(bookingId: string): string {
  return `erased-${bookingId}@deleted.invalid`;
}

/** true se la prenotazione è stata anonimizzata dall'erasure GDPR. */
export function isAnonymizedBooking(booking: Pick<Booking, 'attendee_email'> | null | undefined): boolean {
  return typeof booking?.attendee_email === 'string' && ANONYMIZED_BOOKING_EMAIL_RE.test(booking.attendee_email.trim());
}

/** Intervallo minimo fra due scritture di proiezioni (≤ 20 PUT/s degli scrittori di sistema, design §8). */
const MIN_WRITE_INTERVAL_MS = Math.ceil(1_000 / INDEX_LIMITS.maxSystemPutsPerSecond);

function adminBaseUrl(): string {
  return (process.env.ADMIN_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

/** Link alla prenotazione nell'admin (decisione 3). */
export function bookingAdminUrl(uid: string): string {
  return `${adminBaseUrl()}/calendario/prenotazioni?uid=${encodeURIComponent(uid)}`;
}

function utcStamp(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) throw new RangeError(`istante non valido: ${String(value).slice(0, 40)}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export interface BookingProjectionContent {
  booking: Pick<Booking, 'uid' | 'attendee_name' | 'attendee_phone' | 'start_time' | 'end_time' | 'location_value' | 'created_at'>;
  /** Titolo del tipo di prenotazione. */
  eventTitle: string;
  /** Link della riunione ricalcolato con resolveLocationForBooking (design §14). */
  meetingUrl: string | null;
  now: Date;
  /**
   * Contenuto ridotto a "Prenotazione" anche prima dei 24 mesi: prenotazione
   * anonimizzata dall'erasure GDPR (contratto f3 §13.1).
   */
  minimized?: boolean;
}

/** Dati della decisione 3 per calendar-core (link all'admin costruito qui da ADMIN_URL). */
export function bookingProjectionData(input: Omit<BookingProjectionContent, 'now' | 'minimized'>): BookingProjectionData {
  const { booking } = input;
  return {
    bookingUid: booking.uid,
    title: input.eventTitle,
    attendeeName: booking.attendee_name,
    attendeePhone: booking.attendee_phone,
    adminUrl: bookingAdminUrl(booking.uid),
    start: booking.start_time,
    end: booking.end_time,
    location: booking.location_value,
    meetingUrl: input.meetingUrl,
  };
}

/**
 * Contenuto voluto della proiezione (SUMMARY, DESCRIPTION, LOCATION, URL e
 * stato di minimizzazione), dall'unica implementazione di calendar-core.
 */
export function bookingProjectionContentFor(input: BookingProjectionContent): CoreProjectionContent {
  return bookingProjectionContent(input.minimized ? null : bookingProjectionData(input), { now: input.now });
}

/**
 * VCALENDAR della proiezione di una prenotazione (decisione 3): SUMMARY
 * «titolo – nome», DESCRIPTION con telefono e link all'admin, LOCATION e URL
 * della riunione (contenuto di bookingProjectionContent di calendar-core),
 * STATUS:CONFIRMED, tempi in UTC. Mai email, azienda, messaggio, ORGANIZER o
 * ATTENDEE. Oltre i 24 mesi dalla fine, o con `minimized`, solo
 * "Prenotazione".
 */
export function buildBookingProjectionIcs(input: BookingProjectionContent): string {
  const { booking, now } = input;
  const uid = bookingProjectionUid(booking.uid);
  const content = bookingProjectionContentFor(input);
  const vevent = createComponent('VEVENT', [
    createProperty('UID', uid),
    createProperty('DTSTAMP', utcStamp(now)),
    createProperty('CREATED', utcStamp(booking.created_at ?? now)),
    createProperty('LAST-MODIFIED', utcStamp(now)),
    createProperty('SEQUENCE', '0'),
    createProperty('DTSTART', utcStamp(booking.start_time)),
    createProperty('DTEND', utcStamp(booking.end_time)),
    createProperty('STATUS', 'CONFIRMED'),
    createProperty('TRANSP', 'OPAQUE'),
  ]);
  setTextValue(vevent, 'SUMMARY', content.summary);
  if (content.location) setTextValue(vevent, 'LOCATION', content.location);
  if (content.url) vevent.properties.push(createProperty('URL', content.url));
  if (content.description) setTextValue(vevent, 'DESCRIPTION', content.description);
  return serializeObject(createCalendarObject({ uid, master: vevent }), { prodid: BOOKING_PROJECTION_PRODID });
}

// ─── Minimizzazione di una risorsa esistente ───────────────────────────────

function emptyToNull(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : v;
}

/**
 * Stato di minimizzazione di una risorsa letta da Radicale: true se il master
 * ha SUMMARY "Prenotazione" senza DESCRIPTION, LOCATION e URL; null se il
 * testo non si legge.
 */
export function projectionResourceMinimized(body: string): boolean | null {
  const parsed = parseCalendarObject(body);
  if (!parsed.ok || !parsed.value.master) return null;
  const master = parsed.value.master;
  return (getTextValue(master, 'SUMMARY') ?? '').trim() === RETAINED_PROJECTION_SUMMARY
    && emptyToNull(getTextValue(master, 'DESCRIPTION')) === null
    && emptyToNull(getTextValue(master, 'LOCATION')) === null
    && emptyToNull(getTextValue(master, 'URL')) === null;
}

/**
 * Riscrittura per un cambio di minimizzazione (contratto f3 §6.4): se lo
 * stato della risorsa (minimizzata o no) è diverso da quello voluto, applica
 * all'oggetto corrente i soli campi della decisione 3 (patch per campo di
 * calendar-core: il resto resta, DTSTAMP e LAST-MODIFIED aggiornati) e
 * restituisce il testo da scrivere con If-Match; altrimenti null (le
 * modifiche fatte dall'API agli altri campi non si annullano). null anche se
 * il testo non si legge: la risorsa resta com'è e si registra un avviso.
 */
export function minimizationRewrite(body: string, wanted: CoreProjectionContent, now: Date): string | null {
  const current = projectionResourceMinimized(body);
  if (current === null || current === wanted.minimized) return null;
  const parsed = parseCalendarObject(body);
  if (!parsed.ok || !parsed.value.master) return null;
  const obj = parsed.value;
  const ops: PatchOp[] = [
    { op: 'set', field: 'summary', value: wanted.summary },
    { op: 'set', field: 'description', value: wanted.description },
    { op: 'set', field: 'location', value: wanted.location },
    { op: 'set', field: 'url', value: wanted.url },
  ];
  const res = applyComponentOps(obj.master as NonNullable<typeof obj.master>, ops, { tz: 'UTC', now, timezones: obj.timezones });
  if (res.changed.length === 0) return null;
  return serializeObject(obj, { prodid: 'preserve', timezones: 'preserve' });
}

// ─── Scrittura su Radicale ───────────────────────────────

export type BookingProjectionAction = 'created' | 'exists' | 'rewritten' | 'deleted' | 'absent' | 'skipped';

export interface BookingProjectionResult {
  action: BookingProjectionAction;
  href: string;
  calendarId: string | null;
  /** Motivo di un salto. */
  reason?: string;
}

interface BookingsCollection {
  id: string;
  collectionName: string;
}

/** Collezione Prenotazioni (role='bookings', attiva), la più vecchia se ce ne fossero più d'una. */
export async function bookingsCollection(db: Db): Promise<BookingsCollection | null> {
  const [row] = await db<Array<{ id: string; collection_name: string | null }>>`
    SELECT id, collection_name FROM calendars
    WHERE role = 'bookings' AND lifecycle = 'active' AND collection_name IS NOT NULL
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return row?.collection_name ? { id: row.id, collectionName: row.collection_name } : null;
}

async function getOrNull(client: RadicaleClient, path: string): Promise<{ etag: string | null; body: string } | null> {
  try {
    const res = await client.get(path);
    return { etag: res.etag, body: res.body };
  } catch (err) {
    if (isRadicaleError(err, 'not_found')) return null;
    throw err;
  }
}

let lastWriteAt = 0;

/** Distanzia le scritture di proiezioni del processo (limite degli scrittori di sistema). */
async function throttleWrite(): Promise<void> {
  const wait = lastWriteAt + MIN_WRITE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastWriteAt = Date.now();
}

/** DTSTART e DTEND (UTC compatto) di una risorsa letta, per l'avviso di deriva. */
function readTimes(body: string): { start: string | null; end: string | null } {
  const unfolded = body.replace(/\r?\n[ \t]/g, '');
  const start = /^DTSTART[^:\r\n]*:([0-9TZ]+)\s*$/m.exec(unfolded)?.[1] ?? null;
  const end = /^DTEND[^:\r\n]*:([0-9TZ]+)\s*$/m.exec(unfolded)?.[1] ?? null;
  return { start, end };
}

/**
 * Porta la collezione Prenotazioni di Radicale allo stato desiderato per la
 * prenotazione `uid` (testa del file). `booking` è la riga letta adesso
 * (null se sparita); `state` lo stato del backend appena riletto. Lancia
 * CalendarUnavailableError (ripetibile) se Radicale non è utilizzabile adesso
 * (transizione, freeze, identità, Radicale irraggiungibile) e gli errori del
 * client.
 */
export async function syncBookingProjection(
  uid: string,
  booking: Booking | null,
  opts: { state: CalendarBackendState; signal?: AbortSignal; now?: Date; db?: Db },
): Promise<BookingProjectionResult> {
  const db = opts.db ?? sql;
  const href = bookingHref(uid);
  const rt = radicaleRuntime();
  const client = rt.client;
  if (!client) throw new CalendarUnavailableError('radicale_unreachable', rt.unavailableReason ?? 'Radicale non configurato');
  const { check } = await verifyVolumeIdentity({ state: opts.state });
  if (check.status !== 'ok') {
    throw new CalendarUnavailableError(
      check.status === 'mismatch' ? 'identity_mismatch' : 'identity_unverified',
      `proiezione della prenotazione sospesa: identità del volume ${check.status}`,
    );
  }
  const collection = await bookingsCollection(db);
  if (!collection) return { action: 'skipped', href, calendarId: null, reason: 'collezione Prenotazioni assente' };
  if (opts.signal?.aborted) throw new CalendarUnavailableError('freshness_timeout', 'proiezione interrotta');

  const now = opts.now ?? new Date();
  const desired = booking !== null && PROJECTED_BOOKING_STATUSES.has(booking.status);
  let content: string | null = null;
  let wanted: CoreProjectionContent | null = null;
  if (desired && booking) {
    const eventType = await getEventType(booking.event_type_id, { includeInactive: true });
    const resolved = eventType ? await resolveLocationForBooking({ eventType, booking, pushToGoogle: false }) : null;
    const input: BookingProjectionContent = {
      booking,
      eventTitle: eventType?.title ?? RETAINED_PROJECTION_SUMMARY,
      meetingUrl: resolved?.meetingUrl ?? null,
      now,
      minimized: isAnonymizedBooking(booking),
    };
    content = buildBookingProjectionIcs(input);
    wanted = bookingProjectionContentFor(input);
  }

  const path = objectPath(rt.principal, collection.collectionName, href);
  await throttleWrite();
  const action = await withCalendarWriteGate(async (): Promise<BookingProjectionAction> => {
    const existing = await getOrNull(client, path);
    if (desired && booking && content !== null && wanted !== null) {
      if (existing) {
        warnOnDrift(booking, existing.body, collection.id, href);
        const rewrite = minimizationRewrite(existing.body, wanted, now);
        if (rewrite === null) {
          if (projectionResourceMinimized(existing.body) === null) {
            log.warn({ calendarId: collection.id, href }, 'proiezione esistente non leggibile: non viene riscritta');
          }
          return 'exists';
        }
        if (!existing.etag) throw new Error(`proiezione ${href} senza ETag: nuovo tentativo`);
        try {
          await client.put(path, rewrite, { ifMatch: existing.etag });
          return 'rewritten';
        } catch (err) {
          // Risorsa cambiata fra GET e PUT: il job riprova e rilegge.
          if (isRadicaleError(err, 'precondition_failed')) {
            throw new Error(`proiezione ${href} modificata durante la riscrittura: nuovo tentativo`, { cause: err });
          }
          throw err;
        }
      }
      try {
        await client.put(path, content, { ifNoneMatch: '*' });
        return 'created';
      } catch (err) {
        if (isRadicaleError(err, 'precondition_failed')) return 'exists';
        throw err;
      }
    }
    let current = existing;
    for (let attempt = 0; current; attempt++) {
      try {
        await client.delete(path, { ifMatch: current.etag ?? '*' });
        return 'deleted';
      } catch (err) {
        if (isRadicaleError(err, 'not_found')) return 'absent';
        if (!isRadicaleError(err, 'precondition_failed')) throw err;
        // Risorsa cambiata fra GET e DELETE: si rilegge una volta, poi il job riprova.
        if (attempt >= 1) throw new Error(`proiezione ${href} modificata durante la rimozione: nuovo tentativo`, { cause: err });
        current = await getOrNull(client, path);
      }
    }
    return 'absent';
  }, { expect: 'radicale' });

  if (action === 'created' || action === 'deleted' || action === 'rewritten') {
    // Write-through dopo il rilascio del gate (contratto §1.3 regola 2):
    // facoltativo, il campanello indicizzerà comunque la modifica.
    await syncCollection(collection.id, { reason: 'write-through', actor: 'project_booking', signal: opts.signal }).catch((err: unknown) => {
      log.warn({ err, calendarId: collection.id, href }, 'write-through della proiezione non riuscito: indicizzerà il campanello');
    });
  }
  return { action, href, calendarId: collection.id };
}

function warnOnDrift(booking: Booking, body: string, calendarId: string, href: string): void {
  const times = readTimes(body);
  const start = utcStamp(booking.start_time);
  const end = utcStamp(booking.end_time);
  if (times.start === start && times.end === end) return;
  raiseIndexAlert('booking-drift', 'Proiezione della prenotazione con orari diversi dalla prenotazione: non viene riscritta', {
    key: booking.uid,
    calendarId,
    href,
    bookingUid: booking.uid,
  });
}

// ─── Sovrapposizioni dopo la decisione ───────────────────────────────

/** Chiave di un'occorrenza per il confronto prima/dopo il commit (orari compresi: un evento spostato conta come nuovo). */
export function blockingOccurrenceKey(occ: Pick<BlockingOccurrence, 'objectId' | 'recurrenceKey' | 'start' | 'end'>): string {
  return `${occ.objectId}|${occ.recurrenceKey}|${occ.start.getTime()}|${occ.end.getTime()}`;
}

/** Occorrenze bloccanti sovrapposte all'intervallo di una prenotazione, al momento della decisione (chiavi). */
export async function blockingOccurrenceKeys(db: Db, startIso: string, endIso: string): Promise<string[]> {
  const occurrences = await indexBlockingOccurrences(db, startIso, endIso);
  return occurrences.map(blockingOccurrenceKey);
}

export type ConflictDetector = 'post_commit' | 'auditor';

/**
 * Registra in cal_booking_conflicts le occorrenze bloccanti sovrapposte alla
 * prenotazione che non c'erano al momento della decisione (`preexisting`),
 * con un avviso per ciascuna nuova. Idempotente (un conflitto aperto per
 * prenotazione, oggetto e istanza). Restituisce quante ne ha registrate.
 */
export async function recordBookingConflicts(
  db: Db,
  booking: Pick<Booking, 'id' | 'uid' | 'start_time' | 'end_time'>,
  preexisting: ReadonlySet<string>,
  detectedBy: ConflictDetector,
): Promise<number> {
  const startIso = new Date(booking.start_time).toISOString();
  const endIso = new Date(booking.end_time).toISOString();
  const occurrences = (await indexBlockingOccurrences(db, startIso, endIso))
    .filter((occ) => occ.kind !== 'booking_projection' && !preexisting.has(blockingOccurrenceKey(occ)));
  let recorded = 0;
  for (const occ of occurrences) {
    const rows = await db<Array<{ id: string }>>`
      INSERT INTO cal_booking_conflicts (
        booking_id, booking_uid, calendar_id, object_id, recurrence_key,
        booking_start, booking_end, event_start, event_end, detected_by
      ) VALUES (
        ${booking.id}, ${booking.uid}, ${occ.calendarId}, ${occ.objectId}, ${occ.recurrenceKey},
        ${startIso}::timestamptz, ${endIso}::timestamptz, ${occ.start}, ${occ.end}, ${detectedBy}
      )
      ON CONFLICT (booking_id, object_id, recurrence_key) WHERE resolved_at IS NULL DO NOTHING
      RETURNING id
    `;
    if (rows.length === 0) continue;
    recorded++;
    raiseIndexAlert('booking-conflict', 'Prenotazione sovrapposta a un evento del calendario comparso durante la decisione: verificare in admin', {
      key: `${booking.uid}|${occ.objectId}|${occ.recurrenceKey}`,
      bookingUid: booking.uid,
      calendarId: occ.calendarId,
      objectId: occ.objectId,
      recurrenceKey: occ.recurrenceKey,
      detectedBy,
    });
    await db`UPDATE cal_booking_conflicts SET alerted_at = now() WHERE id = ${rows[0].id}`;
  }
  return recorded;
}

/** index_version massima delle collezioni bloccanti (source_version del job booking_conflict_check). */
export async function maxBlockingIndexVersion(db: Db): Promise<string> {
  const [row] = await db<Array<{ v: string | null }>>`
    SELECT COALESCE(MAX(st.index_version), 0)::text AS v
    FROM cal_collection_state st
    JOIN calendars c ON c.id = st.calendar_id
    LEFT JOIN calendars p ON p.id = c.parent_calendar_id
    LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
    WHERE CASE WHEN c.role = 'subscription'
               THEN COALESCE(s.blocks_availability, false) AND COALESCE(p.blocks_availability, false)
               ELSE c.blocks_availability END
  `;
  return row?.v ?? '0';
}
