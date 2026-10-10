/**
 * Booking creation / cancel / reschedule / approval.
 *
 * Garanzie:
 * - No-overlap: EXCLUDE constraint `calendar_bookings_no_overlap` (23P01 →
 *   BookingConflictError) su status confirmed+pending (migr. 146).
 * - Capacità settimanale + buffer: verificati PRE-insert dentro una
 *   transazione serializzata da pg_advisory_xact_lock per settimana ISO —
 *   chiude il TOCTOU tra check e insert concorrenti.
 * - Reschedule atomico: cancel-old + create-new in un'unica transazione; se il
 *   nuovo slot confligge il rollback ripristina automaticamente l'originale.
 * - Workflow events centralizzati: booking_creato / booking_cancellato /
 *   booking_riprogrammato / booking_approvato partono da QUI per ogni percorso
 *   (public, admin, MCP, contact form). Le email restano nelle route.
 * - requires_approval: prenotazioni self-service (public_page/contact_form) su
 *   event type con requires_approval → status 'pending': lo slot è bloccato
 *   dalla EXCLUDE constraint ma la proiezione calendar_event avviene solo
 *   all'approvazione.
 *
 * Protocollo di decisione della fase F2 del passaggio a Radicale (design §9,
 * §14; decisione 1; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §7.4), per createBooking e
 * rescheduleBooking con qualsiasi source (anche mcp e admin: la capacity
 * nella sezione critica legge gli eventi):
 *
 *   tx: pg_advisory_xact_lock(cal-week-IYYY-IW)                   (invariato)
 *       stato del backend riletto nella tx, senza cache
 *       store Radicale: niente write_freeze; verifyFreshness({ db: tx })
 *         (identità del volume, stat delle collezioni bloccanti, sync se
 *         cambiate; fallimento → 503, salvo modalità degradata)
 *       require_available_slot → computeAvailableSlots(…, { level: 'decision', db: tx })
 *       capacity e buffer con db: tx
 *       INSERT calendar_bookings (EXCLUDE)
 *       store Radicale: enqueue project_booking nella tx (outbox)
 *   commit
 *   post, store Radicale: nuova verifica della freshness e confronto delle
 *     occorrenze sovrapposte con quelle viste nella decisione → eventuali
 *     cal_booking_conflicts con avviso, mai un annullamento automatico; se la
 *     verifica non riesce, job booking_conflict_check
 *   post, mode postgres: proiezione legacy sincrona in calendar_events, come
 *     oggi
 *
 * In mode postgres il risultato è quello di oggi: stessa proiezione legacy
 * (anche il link della riunione nullo dopo riprogrammazione e approvazione,
 * correzione del design §14 che cambia un valore di contratto e quindi esce
 * con lo store Radicale), stessi messaggi d'errore. Cambia solo che slot,
 * capacity e buffer si leggono con la transazione della prenotazione (la
 * riprogrammazione vede l'originale già annullata) e che il controllo dello
 * slot avviene dentro l'advisory lock.
 *
 * Con lo store Radicale le proiezioni booking-* non bloccano (design §9):
 * una riprogrammazione su uno slot sovrapposto all'originale è accettata. Il
 * job project_booking (registerBookingJobs) calcola lo stato desiderato da
 * calendar_bookings all'esecuzione (booking-projection.ts) e ricalcola sempre
 * il link della riunione con resolveLocationForBooking.
 */

import { customAlphabet } from 'nanoid';
import { sql } from '../../db';
import { getEventType } from './availability';
import { resolveLocationForBooking, deleteGoogleEvent } from './meeting-url';
import { getBookingsCalendar } from './calendars';
import { hasWeeklyCapacityForBooking } from './capacity';
import { createEvent, getEventBySource, updateEvent } from './events';
import {
  type CalendarStoreKind,
  readBackendStateFresh,
  storeKindForMode,
  storeKindOverride,
  writesSuspendedInMode,
} from './backend-mode';
import {
  blockingOccurrenceKeys,
  maxBlockingIndexVersion,
  PROJECTED_BOOKING_STATUSES,
  recordBookingConflicts,
  syncBookingProjection,
} from './booking-projection';
import { assertReadyOrDegraded } from './busy';
import { CalendarUnavailableError, type CalendarUnavailableReason } from './errors';
import {
  CAL_JOB_KINDS,
  CalendarJobPermanentError,
  type CalendarJob,
  type CalendarJobContext,
  type CalendarJobOutcome,
  enqueueCalendarJob,
  registerCalendarJobHandler,
} from './jobs';
import { isRadicaleError } from './radicale/errors';
import { verifyFreshness } from './radicale/freshness';
import { raiseIndexAlert } from './radicale/health';
import type { Db } from './radicale/policy';
import type { CalendarBackendState } from './radicale/types';
import type {
  Booking,
  BookingWithEventType,
  CancelledBy,
  CreateBookingInput,
  CustomQuestion,
  EventType,
} from './types';
import { logger } from '../logger';

const log = logger.child({ scope: 'calendar-booking' });

// Alphabet URL-safe, 12 char (~62^12 = abbastanza per uso commerciale)
const generateBookingUid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

export class BookingConflictError extends Error {
  code = 'BOOKING_CONFLICT' as const;
  constructor(message = 'Lo slot selezionato non è più disponibile') { super(message); }
}

export class BookingValidationError extends Error {
  code = 'BOOKING_VALIDATION' as const;
  constructor(message: string) { super(message); }
}

/**
 * Come si proietta una prenotazione nel calendario Prenotazioni:
 * 'legacy' = riga di calendar_events scritta in modo sincrono (mode postgres,
 * come oggi); 'job' = risorsa booking-<uid>.ics in Radicale tramite il job
 * project_booking (modi cutover, radicale, rollback e finalized: il job
 * attende da solo la fine di una transizione).
 */
export type BookingProjectionStrategy = 'legacy' | 'job';

/** Esito della parte "calendario" di una decisione di prenotazione (design §9). */
export interface BookingDecision {
  /** Store che ha servito busy e capacity. */
  store: CalendarStoreKind;
  projection: BookingProjectionStrategy;
  /** Verifica scavalcata dalla modalità degradata (decisione 1); null se riuscita o non necessaria. */
  degraded: { reason: CalendarUnavailableReason; detail: string | null } | null;
  /** Occorrenze bloccanti già sovrapposte alla prenotazione nella decisione (store Radicale). */
  preexisting: string[];
}

interface CreateBookingResult {
  booking: Booking;
  eventType: EventType;
  /** Parte calendario della decisione (per i side effect post-commit di chi possiede la tx). */
  decision: BookingDecision;
}

/** Strategia di proiezione per uno stato del backend (lo store forzato dai test vale come modo). */
export function projectionStrategyFor(state: Pick<CalendarBackendState, 'mode'>): BookingProjectionStrategy {
  const forced = storeKindOverride();
  if (forced) return forced === 'postgres' ? 'legacy' : 'job';
  return state.mode === 'postgres' ? 'legacy' : 'job';
}

/** Versione della sorgente di una prenotazione per i job (updated_at in ISO). */
function bookingVersion(booking: Pick<Booking, 'updated_at'> | null | undefined): string | null {
  if (!booking?.updated_at) return null;
  const d = new Date(booking.updated_at);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(booking.updated_at);
}

/** Accoda la proiezione di una prenotazione (outbox: con `db` = tx esiste solo dopo la COMMIT). */
async function enqueueProjection(booking: Pick<Booking, 'uid' | 'updated_at'>, db: Db): Promise<void> {
  await enqueueCalendarJob(CAL_JOB_KINDS.projectBooking, booking.uid, {}, { db, sourceVersion: bookingVersion(booking) });
}

/** Payload del job booking_conflict_check. */
interface ConflictCheckPayload extends Record<string, unknown> {
  booking_id: string;
  preexisting: string[];
  degraded_reason: string | null;
}

/** Accoda il controllo delle sovrapposizioni da rifare più tardi (freshness non verificabile adesso). */
async function enqueueConflictCheck(
  booking: Pick<Booking, 'id' | 'uid'>,
  decision: BookingDecision,
  opts: { db: Db; delayMs: number },
): Promise<void> {
  const payload: ConflictCheckPayload = {
    booking_id: booking.id,
    preexisting: decision.preexisting,
    degraded_reason: decision.degraded?.reason ?? null,
  };
  await enqueueCalendarJob(CAL_JOB_KINDS.bookingConflictCheck, booking.uid, payload, {
    db: opts.db,
    delayMs: opts.delayMs,
    sourceVersion: await maxBlockingIndexVersion(opts.db),
  });
}

/**
 * Parte calendario della decisione, dentro la sezione critica (dopo
 * l'advisory lock): stato riletto nella tx; con lo store Radicale niente
 * write_freeze e freshness verificata, oppure modalità degradata accesa per
 * un motivo scavalcabile (decisione 1). Lancia CalendarUnavailableError (503).
 */
async function beginDecision(tx: Db): Promise<BookingDecision> {
  const state = await readBackendStateFresh(tx);
  const store = storeKindOverride() ?? storeKindForMode(state.mode);
  const decision: BookingDecision = { store, projection: projectionStrategyFor(state), degraded: null, preexisting: [] };
  if (store === 'postgres') return decision;
  // In mode postgres write_freeze non conta (contratto control-plane §6.2).
  if (storeKindForMode(state.mode) === 'radicale' && state.write_freeze) {
    throw new CalendarUnavailableError('write_freeze', 'prenotazioni sospese: scritture del calendario congelate (write_freeze)');
  }
  const bypassed = await assertReadyOrDegraded(tx, () => verifyFreshness({ db: tx }), 'decision');
  if (bypassed) decision.degraded = { reason: bypassed.reason, detail: bypassed.detail };
  return decision;
}

/**
 * Valida le custom_responses contro le custom_questions dell'event type:
 * required presenti e non vuote, select dentro le options, cap 2000 char,
 * chiavi sconosciute scartate. Ritorna l'oggetto sanificato.
 * Lancia BookingValidationError alla prima violazione.
 */
export function validateCustomResponses(
  questions: CustomQuestion[],
  responses: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  const src = responses && typeof responses === 'object' && !Array.isArray(responses)
    ? (responses as Record<string, unknown>)
    : {};
  for (const q of questions || []) {
    const raw = src[q.key];
    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
    if (!value) {
      if (q.required) throw new BookingValidationError(`Risposta obbligatoria mancante: ${q.label}`);
      continue;
    }
    if (value.length > 2000) {
      throw new BookingValidationError(`Risposta troppo lunga per: ${q.label} (max 2000 caratteri)`);
    }
    if (q.type === 'select' && q.options?.length && !q.options.includes(value)) {
      throw new BookingValidationError(`Valore non valido per: ${q.label}`);
    }
    out[q.key] = value;
  }
  return out;
}

/**
 * Fire di un workflow event legato a un booking (best-effort, dynamic import
 * per non caricare l'engine sui percorsi che non lo usano).
 */
function fireBookingWorkflow(
  eventKey: string,
  booking: Booking,
  eventType: EventType,
  extra: Record<string, unknown> = {},
): void {
  import('../workflow/triggers')
    .then(({ fireEvent }) => fireEvent(eventKey, {
      booking_uid: booking.uid,
      event_type_slug: eventType.slug,
      attendee_name: booking.attendee_name,
      attendee_email: booking.attendee_email,
      start_time: booking.start_time,
      status: booking.status,
      source: booking.source,
      ...extra,
    }))
    .catch((err) => log.error({ err }, `Workflow fireEvent ${eventKey} FAILED for booking ${booking.uid}`));
}

/**
 * Proietta un booking confermato come calendar_event nel calendario 'bookings'
 * (store legacy). Lancia gli errori di createEvent: la usano il percorso
 * sincrono (projectBookingEvent, best-effort) e il job project_booking dopo un
 * ritorno a mode postgres (convergeLegacyProjection, che riprova).
 */
async function createLegacyProjection(
  booking: Booking,
  eventType: EventType,
  meetingUrl: string | null,
): Promise<boolean> {
  const bookingsCal = await getBookingsCalendar();
  if (!bookingsCal) return false;
  await createEvent({
    calendar_id: bookingsCal.id,
    summary: `${eventType.title} – ${booking.attendee_name}`,
    description: [
      `Cliente: ${booking.attendee_name} <${booking.attendee_email}>`,
      booking.attendee_phone ? `Tel: ${booking.attendee_phone}` : null,
      booking.attendee_company ? `Azienda: ${booking.attendee_company}` : null,
      booking.attendee_message ? `\nNote:\n${booking.attendee_message}` : null,
      `\nUID prenotazione: ${booking.uid}`,
    ].filter(Boolean).join('\n'),
    location: booking.location_value,
    url: meetingUrl,
    start_time: booking.start_time,
    end_time: booking.end_time,
    source: 'booking',
    source_id: booking.uid,
    status: 'confirmed',
  });
  return true;
}

/**
 * Proietta un booking confermato come calendar_event nel calendario 'bookings'
 * (best-effort: non blocca il chiamante). Così il booking appare nel
 * calendario admin, nel feed ICS e via CalDAV. Solo store legacy: con lo
 * store Radicale la proiezione passa dal job project_booking.
 */
async function projectBookingEvent(
  booking: Booking,
  eventType: EventType,
  meetingUrl: string | null,
): Promise<void> {
  try {
    await createLegacyProjection(booking, eventType, meetingUrl);
  } catch (eventErr) {
    log.error({ err: eventErr, bookingUid: booking.uid }, 'Auto-create calendar_event FAILED for booking');
  }
}

/** Marca come cancellata la proiezione legacy di una prenotazione (best-effort, come oggi). */
async function cancelLegacyProjection(bookingUid: string, what: string): Promise<void> {
  try {
    const linkedEvent = await getEventBySource('booking', bookingUid);
    if (linkedEvent) {
      await updateEvent(linkedEvent.id, { status: 'cancelled' });
    }
  } catch (err) {
    log.error({ err, bookingUid }, `${what} FAILED for booking`);
  }
}

/**
 * Side effect calendario dopo il commit di una prenotazione (design §9):
 * proiezione legacy sincrona in mode postgres; con lo store Radicale avviso
 * della modalità degradata oppure controllo delle sovrapposizioni.
 */
async function afterBookingCommitted(
  booking: Booking,
  eventType: EventType,
  decision: BookingDecision,
  meetingUrl: string | null,
): Promise<void> {
  if (decision.projection === 'legacy' && booking.status === 'confirmed') {
    await projectBookingEvent(booking, eventType, meetingUrl);
  }
  if (decision.store !== 'radicale') return;
  if (decision.degraded) {
    raiseIndexAlert('booking-degraded', `Prenotazione presa in modalità degradata (${decision.degraded.reason}): sovrapposizioni da verificare`, {
      key: booking.uid,
      bookingUid: booking.uid,
      reason: decision.degraded.reason,
      source: booking.source,
    });
    return;
  }
  await checkConflictsAfterCommit(booking, decision);
}

/**
 * Controllo post-commit (design §9): nuova verifica della freshness (stat
 * delle collezioni del set, sync di quelle cambiate) e confronto delle
 * occorrenze sovrapposte con quelle viste nella decisione. Non lancia: se la
 * verifica non riesce adesso il controllo passa al job booking_conflict_check.
 */
async function checkConflictsAfterCommit(booking: Booking, decision: BookingDecision): Promise<void> {
  try {
    await verifyFreshness({ db: sql });
    await recordBookingConflicts(sql, booking, new Set(decision.preexisting), 'post_commit');
  } catch (err) {
    log.warn({ err, bookingUid: booking.uid }, 'controllo post-commit delle sovrapposizioni non riuscito: rimandato al job');
    await enqueueConflictCheck(booking, decision, { db: sql, delayMs: 30_000 }).catch((enqueueErr: unknown) => {
      log.error({ err: enqueueErr, bookingUid: booking.uid }, 'accodamento del controllo delle sovrapposizioni non riuscito');
    });
  }
}

interface CreateBookingOptions {
  /** Transazione esterna (reschedule): usa questo handle invece di aprirne una. */
  db?: unknown;
  /** True quando il chiamante fa parte di un flusso che spara un proprio evento (reschedule). */
  suppressWorkflowEvents?: boolean;
}

/**
 * Crea un booking. Lancia:
 * - BookingConflictError se lo slot è occupato (EXCLUDE constraint, buffer o capacità)
 * - BookingValidationError se start non è valido / fuori range
 * - CalendarUnavailableError (503) se con lo store Radicale il calendario non
 *   è verificabile (design §9, decisione 1)
 *
 * Con event type `requires_approval` e source self-service
 * (public_page/contact_form) il booking nasce `pending`.
 *
 * NB: il chiamante è responsabile di inviare le email.
 */
export async function createBooking(
  input: CreateBookingInput,
  opts: CreateBookingOptions = {},
): Promise<CreateBookingResult> {
  if (!input.event_type_id && !input.event_type_slug) {
    throw new BookingValidationError('event_type_id o event_type_slug richiesto');
  }
  if (!input.attendee?.name || !input.attendee?.email || !input.start) {
    throw new BookingValidationError('Dati mancanti: nome, email, slot');
  }

  const eventType = await getEventType(
    input.event_type_id || input.event_type_slug!,
    { onlyPublic: false }
  );
  if (!eventType) throw new BookingValidationError('Event type non trovato');

  // Calcola end
  const startDate = new Date(input.start);
  if (isNaN(startDate.getTime())) {
    throw new BookingValidationError('Data inizio non valida');
  }
  const endDate = new Date(startDate.getTime() + eventType.duration_minutes * 60_000);

  // Vincoli temporali
  const now = new Date();
  const minStart = new Date(now.getTime() + eventType.min_notice_hours * 60 * 60 * 1000);
  const maxStart = new Date(now.getTime() + eventType.max_advance_days * 24 * 60 * 60 * 1000);
  if (startDate < minStart) {
    throw new BookingValidationError(`Devi prenotare con almeno ${eventType.min_notice_hours} ore di anticipo`);
  }
  if (startDate > maxStart) {
    throw new BookingValidationError(`Puoi prenotare al massimo ${eventType.max_advance_days} giorni in anticipo`);
  }

  const uid = generateBookingUid();
  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();
  const source = input.source || 'public_page';
  const requiresApproval = eventType.requires_approval
    && (source === 'public_page' || source === 'contact_form');

  // Pre-risolvi location PRIMA dell'INSERT (best-effort; Google rimosso → stub).
  const resolved = await resolveLocationForBooking({
    eventType,
    booking: {
      uid,
      start_time: startIso,
      end_time: endIso,
      attendee_name: input.attendee.name.trim().slice(0, 200),
      attendee_email: input.attendee.email.trim().toLowerCase().slice(0, 255),
    },
    pushToGoogle: true,
  });

  const insertRow = {
    uid,
    event_type_id: eventType.id,
    status: requiresApproval ? 'pending' : 'confirmed',
    attendee_name: input.attendee.name.trim().slice(0, 200),
    attendee_email: input.attendee.email.trim().toLowerCase().slice(0, 255),
    attendee_phone: input.attendee.phone?.trim().slice(0, 50) || null,
    attendee_company: input.attendee.company?.trim().slice(0, 200) || null,
    attendee_timezone: input.attendee.timezone || 'Europe/Rome',
    attendee_message: input.attendee.message?.trim().slice(0, 2000) || null,
    custom_responses: input.custom_responses || {},
    start_time: startIso,
    end_time: endIso,
    location_type: eventType.location_type,
    location_value: resolved.locationValue || null,
    google_event_id: resolved.googleEventId,
    source,
    source_metadata: input.source_metadata || {},
    contact_id: input.contact_id || null,
    lead_id: input.lead_id || null,
    consent_ip: input.consent_ip ?? null,
    consent_user_agent: input.consent_user_agent ?? null,
  };

  // Sezione critica: advisory lock per settimana ISO → freshness del
  // calendario, slot, capacità e buffer vengono verificati e l'INSERT
  // eseguito senza races (il competitor attende il lock e al suo turno vede il
  // booking già committato). Tutte le letture usano la tx (una sola
  // connessione; READ COMMITTED: la query di busy vede le sync appena fatte
  // dalla freshness, e la riprogrammazione vede l'originale già annullata).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const criticalSection = async (tx: any): Promise<{ booking: Booking; decision: BookingDecision }> => {
    await tx`
      SELECT pg_advisory_xact_lock(hashtext(
        'cal-week-' || to_char(date_trunc('week', ${startIso}::timestamptz AT TIME ZONE 'Europe/Rome'), 'IYYY-IW')
      ))
    `;

    const decision = await beginDecision(tx as Db);

    if (input.require_available_slot) {
      // Prima bastava rispettare min_notice/max_advance: un orario fuori
      // disponibilità, in una chiusura/festività, sopra un evento occupato o nei
      // buffer veniva confermato (pagina aperta da prima di una chiusura, o
      // richiesta manipolata). Finestra ±1 giorno per coprire il fuso dello schedule.
      const { computeAvailableSlots } = await import('./slots');
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const available = await computeAvailableSlots({
        eventTypeIdOrSlug: eventType.id,
        fromDateLocal: day(startDate.getTime() - 86_400_000),
        toDateLocal: day(startDate.getTime() + 86_400_000),
      }, { level: 'decision', db: tx as Db });
      if (!available?.slots.some((s) => new Date(s.start).getTime() === startDate.getTime())) {
        throw new BookingConflictError('Orario non più disponibile: scegli uno degli slot proposti');
      }
    }

    const hasCapacity = await hasWeeklyCapacityForBooking(startIso, eventType.duration_minutes, { db: tx as Db, level: 'decision' });
    if (!hasCapacity) {
      throw new BookingConflictError('Capacita settimanale esaurita: scegli un altro slot');
    }

    // Buffer re-check per prenotazioni manuali (admin/MCP): gli slot pubblici
    // arrivano già buffer-aware da computeAvailableSlots. Un booking esistente
    // blocca [start - buffer_after, end + buffer_before] del nuovo slot.
    const bufBefore = eventType.buffer_before_minutes;
    const bufAfter = eventType.buffer_after_minutes;
    if (source !== 'public_page' && !input.allow_buffer_override && (bufBefore > 0 || bufAfter > 0)) {
      const clash = await tx`
        SELECT uid FROM calendar_bookings
        WHERE status IN ('confirmed', 'pending')
          AND start_time - ${bufAfter} * INTERVAL '1 minute' < ${endIso}::timestamptz
          AND end_time + ${bufBefore} * INTERVAL '1 minute' > ${startIso}::timestamptz
        LIMIT 1
      `;
      if (clash.length) {
        throw new BookingConflictError(
          `Lo slot viola i buffer dell'event type (${bufBefore}min prima / ${bufAfter}min dopo). Usa allow_buffer_override per forzare.`
        );
      }
    }

    // Store Radicale: occorrenze bloccanti già sovrapposte (eventi sotto una
    // prenotazione admin/MCP, decisione 2): il controllo post-commit segnala
    // solo quelle comparse dopo la decisione.
    if (decision.store === 'radicale') {
      decision.preexisting = await blockingOccurrenceKeys(tx as Db, startIso, endIso);
    }

    // Modalità degradata (decisione 1): la prenotazione porta il segno del
    // motivo scavalcato, oltre alla riga di audit e all'avviso.
    const row = decision.degraded
      ? {
          ...insertRow,
          source_metadata: {
            ...insertRow.source_metadata,
            calendar_degraded: { reason: decision.degraded.reason, at: new Date().toISOString() },
          },
        }
      : insertRow;

    const rows = await tx`
      INSERT INTO calendar_bookings ${tx(row)}
      RETURNING *
    `;
    const booking = rows[0] as Booking;

    if (decision.projection === 'job' && booking.status === 'confirmed') {
      await enqueueProjection(booking, tx as Db);
    }
    if (decision.degraded) {
      await tx`
        INSERT INTO audit_logs (action, table_name, record_id, new_data, metadata)
        VALUES (
          'INSERT', 'calendar_degraded_bookings', ${booking.id},
          ${tx.json({
            booking_uid: booking.uid,
            start_time: startIso,
            end_time: endIso,
            source,
            reason: decision.degraded.reason,
            detail: decision.degraded.detail,
          })},
          ${tx.json({ calendar: 'degraded_booking' })}
        )
      `;
      await enqueueConflictCheck(booking, decision, { db: tx as Db, delayMs: 60_000 });
    }
    return { booking, decision };
  };

  let inserted: Booking;
  let decision: BookingDecision;
  try {
    const result = opts.db
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? await criticalSection(opts.db as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : await sql.begin(criticalSection) as any;
    inserted = result.booking;
    decision = result.decision;
  } catch (err: unknown) {
    // Cleanup evento Google orfano se l'INSERT fallisce (no-op dopo rimozione Google)
    if (resolved.googleEventId) {
      deleteGoogleEvent(resolved.googleEventId).catch((cleanupErr) => {
        log.error({ err: cleanupErr }, 'Orphan Google event cleanup failed');
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('calendar_bookings_no_overlap') || (err as { code?: string })?.code === '23P01') {
      throw new BookingConflictError();
    }
    throw err;
  }

  // Side effects POST-commit — solo quando questa funzione possiede la
  // transazione. Con opts.db (reschedule) è il chiamante a occuparsene dopo
  // il commit, altrimenti proietteremmo eventi per una tx che può abortire.
  if (!opts.db) {
    await afterBookingCommitted(inserted, eventType, decision, resolved.meetingUrl ?? null);
    if (!opts.suppressWorkflowEvents) {
      fireBookingWorkflow(eventType.workflow_event_key || 'booking_creato', inserted, eventType);
    }
  }

  return { booking: inserted, eventType, decision };
}

export async function cancelBooking(uid: string, opts: {
  cancelled_by: CancelledBy;
  reason?: string;
}): Promise<{ booking: Booking; eventType: EventType } | null> {
  const rows = await sql<Booking[]>`
    SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  const booking = rows[0];
  if (!booking) return null;
  if (booking.status === 'cancelled') {
    const et = await getEventType(booking.event_type_id, { includeInactive: true });
    if (!et) return null;
    return { booking, eventType: et };
  }

  const strategy = projectionStrategyFor(await readBackendStateFresh(sql));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markCancelled = async (db: any): Promise<Booking[]> => db`
    UPDATE calendar_bookings SET
      status = 'cancelled',
      cancelled_at = NOW(),
      cancelled_by = ${opts.cancelled_by},
      cancellation_reason = ${opts.reason?.slice(0, 1000) || null}
    WHERE id = ${booking.id}::uuid
    RETURNING *
  `;
  const updated: Booking[] = strategy === 'job'
    // Store Radicale: la rimozione della proiezione è un job accodato nella
    // stessa tx dell'annullamento (outbox).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? await sql.begin(async (tx: any) => {
        const res = await markCancelled(tx);
        if (res[0]) await enqueueProjection(res[0], tx as Db);
        return res;
      }) as unknown as Booking[]
    : await markCancelled(sql);

  // Cleanup Google event (no-op dopo rimozione Google)
  await deleteGoogleEvent(booking.google_event_id);

  // Marca anche l'evento calendario corrispondente come cancellato
  // (cosi sparisce dal calendario admin + ICS feed iPhone)
  if (strategy === 'legacy') {
    await cancelLegacyProjection(booking.uid, 'Sync cancel calendar_event');
  }

  const eventType = await getEventType(booking.event_type_id, { includeInactive: true });
  if (!eventType) return null;
  fireBookingWorkflow('booking_cancellato', updated[0], eventType, {
    reason: opts.reason || null,
    cancelled_by: opts.cancelled_by,
  });
  return { booking: updated[0], eventType };
}

export async function rescheduleBooking(uid: string, newStartIso: string, opts: {
  by: CancelledBy;
  reason?: string;
  /** Admin/MCP: consente il nuovo slot anche se viola i buffer dell'event type. */
  allow_buffer_override?: boolean;
  /** Riprogrammazione dal cliente: il nuovo orario deve essere uno slot disponibile. */
  require_available_slot?: boolean;
}): Promise<{ booking: Booking; eventType: EventType; previousUid: string }> {
  // Cancel-old + create-new in un'unica transazione: se il nuovo INSERT
  // fallisce (EXCLUDE/capacità/buffer) il rollback ripristina automaticamente
  // l'originale — nessuna finestra in cui la prenotazione resta cancellata.
  // Slot, busy e capacity della nuova prenotazione si leggono con la stessa
  // tx (design §14): l'originale risulta già annullata e, con lo store
  // Radicale, la sua proiezione non blocca, quindi uno slot sovrapposto
  // all'originale si può scegliere.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txResult = await sql.begin(async (tx: any) => {
    const rows = await tx`
      SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1 FOR UPDATE
    `;
    const original = rows[0] as Booking | undefined;
    if (!original) throw new BookingValidationError('Prenotazione non trovata');
    if (original.status === 'cancelled') {
      throw new BookingValidationError('Prenotazione già cancellata');
    }

    const cancelledRows = await tx`
      UPDATE calendar_bookings SET
        status = 'cancelled',
        cancelled_at = NOW(),
        cancelled_by = ${opts.by},
        cancellation_reason = ${`Rescheduled${opts.reason ? ': ' + opts.reason.slice(0, 950) : ''}`}
      WHERE id = ${original.id}::uuid
      RETURNING *
    `;

    const created = await createBooking({
      event_type_id: original.event_type_id,
      start: newStartIso,
      attendee: {
        name: original.attendee_name,
        email: original.attendee_email,
        phone: original.attendee_phone || undefined,
        company: original.attendee_company || undefined,
        timezone: original.attendee_timezone,
        message: original.attendee_message || undefined,
      },
      custom_responses: original.custom_responses,
      source: original.source,
      source_metadata: { ...original.source_metadata, rescheduled_from: uid },
      contact_id: original.contact_id || undefined,
      lead_id: original.lead_id || undefined,
      allow_buffer_override: opts.allow_buffer_override,
      require_available_slot: opts.require_available_slot,
    }, { db: tx, suppressWorkflowEvents: true });

    const linked = await tx`
      UPDATE calendar_bookings SET rescheduled_from_uid = ${uid}
      WHERE id = ${created.booking.id}::uuid
      RETURNING *
    `;
    const booking = linked[0] as Booking;

    if (created.decision.projection === 'job') {
      // Rimozione della vecchia proiezione e (ri)accodamento della nuova con
      // la versione finale della riga: entrambe nella tx (outbox).
      if (cancelledRows[0]) await enqueueProjection(cancelledRows[0] as Booking, tx as Db);
      if (booking.status === 'confirmed') await enqueueProjection(booking, tx as Db);
    }

    return { original, booking, eventType: created.eventType, decision: created.decision };
  });

  // Side effects post-commit (best-effort)
  await deleteGoogleEvent(txResult.original.google_event_id);
  if (txResult.decision.projection === 'legacy') {
    await cancelLegacyProjection(uid, 'Sync cancel calendar_event (reschedule)');
  }
  // Store legacy: link della riunione nullo come oggi (la correzione del
  // design §14 esce con lo store Radicale, dove il job lo ricalcola sempre).
  await afterBookingCommitted(txResult.booking, txResult.eventType, txResult.decision, null);
  fireBookingWorkflow('booking_riprogrammato', txResult.booking, txResult.eventType, {
    previous_uid: uid,
    previous_start: txResult.original.start_time,
  });

  return { booking: txResult.booking, eventType: txResult.eventType, previousUid: uid };
}

/**
 * Approva una richiesta pending → confirmed: proietta il calendar_event e
 * spara `booking_approvato`. Ritorna null se il booking non esiste; lancia
 * BookingValidationError se non è pending.
 */
export async function approveBooking(uid: string): Promise<{ booking: Booking; eventType: EventType } | null> {
  const rows = await sql<Booking[]>`
    SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  const booking = rows[0];
  if (!booking) return null;
  if (booking.status !== 'pending') {
    throw new BookingValidationError('La prenotazione non è in attesa di approvazione');
  }

  const strategy = projectionStrategyFor(await readBackendStateFresh(sql));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markConfirmed = async (db: any): Promise<Booking[]> => db`
    UPDATE calendar_bookings SET
      status = 'confirmed',
      approved_at = NOW()
    WHERE id = ${booking.id}::uuid AND status = 'pending'
    RETURNING *
  `;
  const updated: Booking[] = strategy === 'job'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? await sql.begin(async (tx: any) => {
        const res = await markConfirmed(tx);
        if (res[0]) await enqueueProjection(res[0], tx as Db);
        return res;
      }) as unknown as Booking[]
    : await markConfirmed(sql);
  if (!updated[0]) {
    throw new BookingValidationError('La prenotazione non è in attesa di approvazione');
  }

  const eventType = await getEventType(booking.event_type_id, { includeInactive: true });
  if (!eventType) return null;

  // Store legacy: link della riunione nullo come oggi (vedi rescheduleBooking).
  if (strategy === 'legacy') await projectBookingEvent(updated[0], eventType, null);
  fireBookingWorkflow('booking_approvato', updated[0], eventType);
  return { booking: updated[0], eventType };
}

/**
 * Rifiuta una richiesta pending → cancelled (nessun calendar_event da pulire:
 * per i pending non viene mai proiettato). Ritorna null se il booking non
 * esiste; lancia BookingValidationError se non è pending.
 */
export async function rejectBooking(
  uid: string,
  reason?: string,
): Promise<{ booking: Booking; eventType: EventType } | null> {
  const rows = await sql<Booking[]>`
    SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  const booking = rows[0];
  if (!booking) return null;
  if (booking.status !== 'pending') {
    throw new BookingValidationError('La prenotazione non è in attesa di approvazione');
  }

  const updated = await sql<Booking[]>`
    UPDATE calendar_bookings SET
      status = 'cancelled',
      cancelled_at = NOW(),
      cancelled_by = 'admin',
      cancellation_reason = ${reason ? `Rifiutata: ${reason.slice(0, 950)}` : 'Rifiutata'}
    WHERE id = ${booking.id}::uuid AND status = 'pending'
    RETURNING *
  `;
  if (!updated[0]) {
    throw new BookingValidationError('La prenotazione non è in attesa di approvazione');
  }

  const eventType = await getEventType(booking.event_type_id, { includeInactive: true });
  if (!eventType) return null;
  fireBookingWorkflow('booking_cancellato', updated[0], eventType, {
    reason: reason || null,
    cancelled_by: 'admin',
    rejected: true,
  });
  return { booking: updated[0], eventType };
}

export async function getBookingByUid(uid: string): Promise<BookingWithEventType | null> {
  const rows = await sql<Booking[]>`
    SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  if (!rows[0]) return null;
  const eventType = await getEventType(rows[0].event_type_id, { includeInactive: true });
  if (!eventType) return null;
  return { ...rows[0], event_type: eventType };
}

// ─── Job della fase F2 (registerBookingJobs) ───────────────────────────────

async function loadBooking(uid: string): Promise<Booking | null> {
  const rows = await sql<Booking[]>`SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Proiezione legacy convergente (job eseguito dopo un ritorno a mode
 * postgres): prenotazione da proiettare senza riga → la crea; riga attiva di
 * una prenotazione non più proiettata → la marca cancellata. Gli errori si
 * propagano (il job riprova).
 */
async function convergeLegacyProjection(uid: string, booking: Booking | null): Promise<{ action: string }> {
  const linked = await getEventBySource('booking', uid);
  const desired = booking !== null && PROJECTED_BOOKING_STATUSES.has(booking.status);
  if (desired && booking) {
    if (linked) return { action: 'exists' };
    const eventType = await getEventType(booking.event_type_id, { includeInactive: true });
    if (!eventType) return { action: 'skipped' };
    const resolved = await resolveLocationForBooking({ eventType, booking, pushToGoogle: false });
    return { action: (await createLegacyProjection(booking, eventType, resolved.meetingUrl)) ? 'created' : 'skipped' };
  }
  if (linked && linked.status !== 'cancelled') {
    await updateEvent(linked.id, { status: 'cancelled' });
    return { action: 'cancelled' };
  }
  return { action: 'absent' };
}

/**
 * Handler di project_booking (chiave = uid della prenotazione): stato
 * desiderato da calendar_bookings all'esecuzione. Store Radicale → risorsa
 * booking-<uid>.ics nella collezione Prenotazioni (booking-projection.ts);
 * mode postgres (ritorno dopo un rollback) → proiezione legacy convergente;
 * cutover e rollback → errore ripetibile (si riprova a transizione finita).
 * Restituisce updated_at riletto come versione corrente della sorgente.
 */
async function runProjectBookingJob(job: CalendarJob, ctx: CalendarJobContext): Promise<CalendarJobOutcome> {
  const uid = job.key;
  const booking = await loadBooking(uid);
  const state = await readBackendStateFresh(sql);
  if (projectionStrategyFor(state) === 'legacy') {
    const result = await convergeLegacyProjection(uid, booking);
    return { result: { ...result, store: 'postgres' }, currentSourceVersion: bookingVersion(await loadBooking(uid)) };
  }
  if (writesSuspendedInMode(state.mode)) {
    throw new CalendarUnavailableError('transition', `modo ${state.mode}: proiezione della prenotazione rimandata`);
  }
  let result: Awaited<ReturnType<typeof syncBookingProjection>>;
  try {
    result = await syncBookingProjection(uid, booking, { state, signal: ctx.signal });
  } catch (err) {
    // Contratto f2-modules §1.4: un errore di Radicale non transitorio (403,
    // 409, 400, configurazione) va in dead letter; l'auditor notturno
    // riaccoda le proiezioni mancanti. Rete, timeout e 502-504 si ripetono.
    if (isRadicaleError(err) && !err.transient) {
      throw new CalendarJobPermanentError(`proiezione della prenotazione ${uid} rifiutata da Radicale: ${err.message}`, { cause: err });
    }
    throw err;
  }
  ctx.log.info({ bookingUid: uid, action: result.action }, 'proiezione della prenotazione');
  // Versione riletta a fine lavoro: se la prenotazione è cambiata durante la
  // PUT (es. annullata) il job si riaccoda e converge al nuovo stato.
  return { result, currentSourceVersion: bookingVersion(await loadBooking(uid)) };
}

/**
 * Handler di booking_conflict_check (chiave = uid): controllo delle
 * sovrapposizioni rimandato (freshness non verificabile dopo il commit, o
 * prenotazione presa in modalità degradata). Verifica la freshness (errore →
 * nuovo tentativo con backoff) e registra le occorrenze sovrapposte che non
 * c'erano al momento della decisione. Prenotazione non più attiva o mode
 * postgres → nulla da fare.
 */
async function runBookingConflictCheckJob(job: CalendarJob): Promise<CalendarJobOutcome> {
  const booking = await loadBooking(job.key);
  if (!booking || (booking.status !== 'confirmed' && booking.status !== 'pending')) {
    return { result: { skipped: 'prenotazione non attiva' } };
  }
  const state = await readBackendStateFresh(sql);
  if ((storeKindOverride() ?? storeKindForMode(state.mode)) === 'postgres') {
    return { result: { skipped: 'store legacy' } };
  }
  await verifyFreshness({ db: sql });
  const preexisting = Array.isArray(job.payload.preexisting)
    ? (job.payload.preexisting as unknown[]).filter((k): k is string => typeof k === 'string')
    : [];
  const recorded = await recordBookingConflicts(sql, booking, new Set(preexisting), 'post_commit');
  return { result: { recorded } };
}

/**
 * Registra gli handler dei job delle prenotazioni (project_booking,
 * booking_conflict_check). Idempotente. La chiama il bootstrap dell'API
 * prima di startCalendarJobWorker() (contratto f2-modules §12).
 */
export function registerBookingJobs(): void {
  registerCalendarJobHandler(CAL_JOB_KINDS.projectBooking, runProjectBookingJob);
  registerCalendarJobHandler(CAL_JOB_KINDS.bookingConflictCheck, runBookingConflictCheckJob);
}
