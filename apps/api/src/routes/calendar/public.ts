/**
 * Public booking API.
 * No auth — Turnstile su POST /bookings, token HMAC su GET/POST :uid actions.
 */

import { Hono } from 'hono';
import { sql } from '../../db';
import { verifyTurnstileToken } from '../../lib/turnstile';
import { getClientIp } from '../../lib/client-ip';
import { computeAvailableSlots } from '../../lib/calendar/slots';
import { getEventType } from '../../lib/calendar/availability';
import {
  createBooking,
  cancelBooking,
  rescheduleBooking,
  getBookingByUid,
  BookingConflictError,
  BookingValidationError,
} from '../../lib/calendar/booking';
import { verifyBookingToken } from '../../lib/calendar/token';
import {
  sendBookingConfirmation,
  sendBookingAdminNotification,
  sendBookingCancelled,
  sendBookingRescheduled,
} from '../../lib/calendar/email';
import { buildIcs } from '../../lib/calendar/ics';
import type { EventType } from '../../lib/calendar/types';
import { logger } from '../../lib/logger';

const log = logger.child({ scope: 'calendar-public' });

export const calendarPublic = new Hono();

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;
const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function publicEventType(et: EventType) {
  return {
    id: et.id,
    slug: et.slug,
    title: et.title,
    description: et.description,
    duration_minutes: et.duration_minutes,
    location_type: et.location_type,
    location_value: et.location_type === 'in_person' ? et.location_value : null,
    color: et.color,
    custom_questions: et.custom_questions,
    min_notice_hours: et.min_notice_hours,
    max_advance_days: et.max_advance_days,
  };
}

// ─── Lista event types pubblici ───────────────────────────────

calendarPublic.get('/event-types', async (c) => {
  const rows = await sql<EventType[]>`
    SELECT id, slug, title, description, duration_minutes,
           buffer_before_minutes, buffer_after_minutes, slot_increment_minutes,
           min_notice_hours, max_advance_days,
           location_type, location_value, color,
           is_active, is_public, requires_approval,
           custom_questions, workflow_event_key, schedule_id, sort_order
    FROM calendar_event_types
    WHERE is_active = true AND is_public = true
    ORDER BY sort_order ASC, title ASC
  `;
  return c.json({ event_types: rows.map(publicEventType) });
});

// ─── Dettaglio per pagina /prenota/[slug] ───────────────────────────────

calendarPublic.get('/event-types/:slug', async (c) => {
  const slug = c.req.param('slug');
  const et = await getEventType(slug, { onlyPublic: true });
  if (!et) return c.json({ error: 'Tipologia di prenotazione non trovata' }, 404);
  return c.json({ event_type: publicEventType(et) });
});

// ─── Slot disponibili ───────────────────────────────

calendarPublic.get('/event-types/:slug/slots', async (c) => {
  const slug = c.req.param('slug');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const tz = c.req.query('tz') || 'Europe/Rome';

  if (!from || !isValidDate(from)) return c.json({ error: 'Parametro from richiesto (YYYY-MM-DD)' }, 400);
  if (!to || !isValidDate(to)) return c.json({ error: 'Parametro to richiesto (YYYY-MM-DD)' }, 400);

  // Cap range a 60 giorni
  const fromMs = new Date(from + 'T00:00:00Z').getTime();
  const toMs = new Date(to + 'T00:00:00Z').getTime();
  if (toMs - fromMs > 60 * 24 * 60 * 60 * 1000) {
    return c.json({ error: 'Range massimo 60 giorni' }, 400);
  }
  if (toMs < fromMs) return c.json({ error: 'to deve essere >= from' }, 400);

  const result = await computeAvailableSlots({
    eventTypeIdOrSlug: slug,
    fromDateLocal: from,
    toDateLocal: to,
    onlyPublic: true,
  });

  if (!result) return c.json({ error: 'Tipologia di prenotazione non trovata' }, 404);

  return c.json({
    timezone: result.timezone,
    duration_minutes: result.eventType.duration_minutes,
    slots_by_date: result.slotsByDate,
    slots: result.slots,
  });
});

// ─── Crea booking ───────────────────────────────

calendarPublic.post('/bookings', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Body JSON richiesto' }, 400);
  }

  // Turnstile (skippa in dev se TURNSTILE_SECRET_KEY non configurato)
  const clientIp = getClientIp(c) ?? undefined;
  const turnstileOk = await verifyTurnstileToken(body.turnstile_token || '', {
    remoteIp: clientIp,
    expectedAction: 'booking_create',
  });
  if (!turnstileOk) {
    return c.json({ error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' }, 403);
  }

  // Validation
  const eventTypeSlug = typeof body.event_type_slug === 'string' ? body.event_type_slug : null;
  const start = typeof body.start === 'string' ? body.start : null;
  const attendee = body.attendee || {};
  const tz = typeof attendee.timezone === 'string' && attendee.timezone.length > 0 && attendee.timezone.length < 80
    ? attendee.timezone : 'Europe/Rome';

  // Type guards e normalizzazione attendee fields
  const attendeeName = typeof attendee.name === 'string' ? attendee.name.trim() : '';
  const attendeeEmail = typeof attendee.email === 'string' ? attendee.email.trim().toLowerCase() : '';
  const attendeePhone = typeof attendee.phone === 'string' ? attendee.phone.trim() : '';
  const attendeeCompany = typeof attendee.company === 'string' ? attendee.company.trim() : '';
  const attendeeMessage = typeof attendee.message === 'string' ? attendee.message.trim() : '';

  if (!eventTypeSlug) return c.json({ error: 'event_type_slug richiesto' }, 400);
  if (!start || isNaN(Date.parse(start))) return c.json({ error: 'start ISO richiesto' }, 400);
  if (attendeeName.length < 2) return c.json({ error: 'Nome richiesto (min 2 caratteri)' }, 400);
  if (attendeeName.length > 200) return c.json({ error: 'Nome troppo lungo (max 200)' }, 400);
  if (!isValidEmail(attendeeEmail)) return c.json({ error: 'Email non valida' }, 400);
  if (attendeePhone && !/^[+\d][\d\s\-().]{4,49}$/.test(attendeePhone)) {
    return c.json({ error: 'Numero di telefono non valido' }, 400);
  }
  if (attendeeCompany.length > 200) return c.json({ error: 'Nome azienda troppo lungo (max 200)' }, 400);
  if (attendeeMessage.length > 2000) return c.json({ error: 'Messaggio troppo lungo (max 2000 caratteri)' }, 400);
  if (body.gdpr_consent !== true) {
    return c.json({ error: 'Consenso GDPR richiesto' }, 400);
  }

  // Verifica event type pubblico
  const et = await getEventType(eventTypeSlug, { onlyPublic: true });
  if (!et) return c.json({ error: 'Tipologia di prenotazione non disponibile' }, 404);

  try {
    const { booking, eventType } = await createBooking({
      event_type_slug: et.slug,
      start,
      attendee: {
        name: attendeeName,
        email: attendeeEmail,
        phone: attendeePhone || undefined,
        company: attendeeCompany || undefined,
        timezone: tz,
        message: attendeeMessage || undefined,
      },
      custom_responses: body.custom_responses && typeof body.custom_responses === 'object'
        ? body.custom_responses : {},
      source: 'public_page',
      source_metadata: {
        source_page: typeof body.source_page === 'string' ? body.source_page.slice(0, 255) : null,
        user_agent: c.req.header('user-agent')?.slice(0, 255) || null,
      },
    });

    // Auto-create lead in pipeline (best-effort: errori non bloccano il booking,
    // ma vengono loggati con context completo per recovery manuale via uid)
    let leadId: string | null = null;
    try {
      const leadRows = await sql<{ id: string }[]>`
        INSERT INTO leads (name, email, phone, company, source, source_id, status, notes)
        VALUES (
          ${booking.attendee_name},
          ${booking.attendee_email},
          ${booking.attendee_phone || null},
          ${booking.attendee_company || null},
          ${'booking_' + et.slug},
          ${booking.uid},
          'new',
          ${booking.attendee_message || null}
        )
        RETURNING id
      `;
      leadId = leadRows[0]?.id || null;
      if (leadId) {
        await sql`UPDATE calendar_bookings SET lead_id = ${leadId}::uuid WHERE id = ${booking.id}::uuid`;
      }
    } catch (err) {
      log.error({ err }, `Lead auto-create FAILED for booking uid=${booking.uid}`);
      // Notifica admin per recovery manuale (best-effort)
      import('../../lib/telegram').then(({ notifyTelegram }) => {
        notifyTelegram(
          '⚠️ Lead non creato',
          `Booking ${booking.uid} confermato ma lead pipeline NON creato.\nAttendee: ${booking.attendee_email}\nVerifica e crea lead manualmente.`
        ).catch(() => {});
      }).catch(() => {});
    }

    // Send emails (non-blocking, claim+mark idempotenza in lib/calendar/email.ts)
    Promise.allSettled([
      sendBookingConfirmation({ booking, eventType }),
      sendBookingAdminNotification({ booking, eventType }),
    ]).catch((err) => log.error({ err }, 'email send error'));

    // Telegram notification (best-effort, log errori)
    import('../../lib/telegram').then(({ notifyTelegram }) => {
      const where = booking.location_value || eventType.location_type;
      return notifyTelegram(
        '📅 Nuova prenotazione',
        `${eventType.title}\n${booking.attendee_name} <${booking.attendee_email}>\n${new Date(booking.start_time).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}\n${where}`
      );
    }).catch((err) => log.error({ err }, 'Telegram notify failed'));

    // Workflow event fire (best-effort, log errori in modo che fallimenti automation siano visibili)
    import('../../lib/workflow/triggers').then(({ fireEvent }) => {
      const eventKey = eventType.workflow_event_key || 'booking_creato';
      return fireEvent(eventKey, {
        booking_uid: booking.uid,
        event_type_slug: eventType.slug,
        attendee_name: booking.attendee_name,
        attendee_email: booking.attendee_email,
        start_time: booking.start_time,
      });
    }).catch((err) => log.error({ err }, `Workflow fireEvent failed for booking ${booking.uid}`));

    return c.json({
      success: true,
      booking: {
        uid: booking.uid,
        start_time: booking.start_time,
        end_time: booking.end_time,
        location_type: booking.location_type,
        location_value: booking.location_value,
      },
    });
  } catch (err) {
    if (err instanceof BookingConflictError) {
      return c.json({ error: err.message, code: 'BOOKING_CONFLICT' }, 409);
    }
    if (err instanceof BookingValidationError) {
      return c.json({ error: err.message, code: 'BOOKING_VALIDATION' }, 400);
    }
    log.error({ err }, 'booking create error');
    return c.json({ error: 'Errore creazione prenotazione' }, 500);
  }
});

// ─── Self-service: dettaglio + cancel + reschedule + ICS ───────────────────────────────

function requireToken(c: import('hono').Context, uid: string): boolean {
  const token = c.req.query('token') || '';
  return verifyBookingToken(token, uid) !== null;
}

calendarPublic.get('/bookings/:uid', async (c) => {
  const uid = c.req.param('uid');
  if (!requireToken(c, uid)) return c.json({ error: 'Token mancante o scaduto' }, 401);

  const b = await getBookingByUid(uid);
  if (!b) return c.json({ error: 'Prenotazione non trovata' }, 404);

  return c.json({
    booking: {
      uid: b.uid,
      status: b.status,
      attendee_name: b.attendee_name,
      attendee_email: b.attendee_email,
      attendee_timezone: b.attendee_timezone,
      start_time: b.start_time,
      end_time: b.end_time,
      location_type: b.location_type,
      location_value: b.location_value,
      cancelled_at: b.cancelled_at,
    },
    event_type: publicEventType(b.event_type),
  });
});

calendarPublic.post('/bookings/:uid/cancel', async (c) => {
  const uid = c.req.param('uid');
  if (!requireToken(c, uid)) return c.json({ error: 'Token mancante o scaduto' }, 401);

  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;

  const result = await cancelBooking(uid, { cancelled_by: 'attendee', reason });
  if (!result) return c.json({ error: 'Prenotazione non trovata' }, 404);

  Promise.allSettled([
    sendBookingCancelled({ ...result, recipient: 'attendee' }),
    sendBookingCancelled({ ...result, recipient: 'admin' }),
  ]).catch((err) => log.error({ err }, 'cancel email error'));

  import('../../lib/workflow/triggers').then(({ fireEvent }) => {
    return fireEvent('booking_cancellato', {
      booking_uid: uid,
      event_type_slug: result.eventType.slug,
      attendee_email: result.booking.attendee_email,
      cancelled_by: 'attendee',
    });
  }).catch((err) => log.error({ err }, `Workflow fireEvent (cancellato) failed for ${uid}`));

  return c.json({ success: true });
});

calendarPublic.post('/bookings/:uid/reschedule', async (c) => {
  const uid = c.req.param('uid');
  if (!requireToken(c, uid)) return c.json({ error: 'Token mancante o scaduto' }, 401);

  const body = await c.req.json().catch(() => ({}));

  // Turnstile verify if the client sent a token (booking-api.ts always does
  // on the reschedule path). The HMAC `requireToken` above already binds the
  // request to a specific booking, but anti-bot still belongs here as defense
  // in depth — and it closes a previous gap where the client sent the field
  // and the server silently ignored it.
  if (body.turnstile_token) {
    const ok = await verifyTurnstileToken(body.turnstile_token, {
      remoteIp: getClientIp(c) ?? undefined,
      expectedAction: 'booking_reschedule',
    });
    if (!ok) return c.json({ error: 'Verifica anti-bot fallita. Riprova.' }, 403);
  }

  const newStart = typeof body.start === 'string' ? body.start : null;
  if (!newStart || isNaN(Date.parse(newStart))) return c.json({ error: 'start ISO richiesto' }, 400);

  try {
    const previous = await getBookingByUid(uid);
    if (!previous) return c.json({ error: 'Prenotazione non trovata' }, 404);

    const result = await rescheduleBooking(uid, newStart, {
      by: 'attendee',
      reason: body.reason || 'Riprogrammata dal partecipante',
    });

    Promise.allSettled([
      sendBookingRescheduled({
        booking: result.booking, eventType: result.eventType,
        previousStart: previous.start_time, recipient: 'attendee',
      }),
      sendBookingRescheduled({
        booking: result.booking, eventType: result.eventType,
        previousStart: previous.start_time, recipient: 'admin',
      }),
    ]).catch((err) => log.error({ err }, 'reschedule email error'));

    import('../../lib/workflow/triggers').then(({ fireEvent }) => {
      return fireEvent('booking_riprogrammato', {
        previous_uid: uid,
        new_uid: result.booking.uid,
        event_type_slug: result.eventType.slug,
        attendee_email: result.booking.attendee_email,
      });
    }).catch((err) => log.error({ err }, `Workflow fireEvent (riprogrammato) failed for ${uid}`));

    return c.json({
      success: true,
      booking: {
        uid: result.booking.uid,
        start_time: result.booking.start_time,
        end_time: result.booking.end_time,
      },
    });
  } catch (err) {
    if (err instanceof BookingConflictError) {
      return c.json({ error: err.message, code: 'BOOKING_CONFLICT' }, 409);
    }
    if (err instanceof BookingValidationError) {
      return c.json({ error: err.message, code: 'BOOKING_VALIDATION' }, 400);
    }
    log.error({ err }, 'reschedule error');
    return c.json({ error: 'Errore riprogrammazione' }, 500);
  }
});

calendarPublic.get('/bookings/:uid/ics', async (c) => {
  const uid = c.req.param('uid');
  if (!requireToken(c, uid)) return c.json({ error: 'Token mancante o scaduto' }, 401);

  const b = await getBookingByUid(uid);
  if (!b) return c.json({ error: 'Prenotazione non trovata' }, 404);

  const ics = buildIcs({
    booking: b,
    eventType: b.event_type,
    organizerName: process.env.ORGANIZER_NAME || 'Federico Calicchia',
    organizerEmail: process.env.ADMIN_EMAIL || 'info@calicchia.design',
    method: b.status === 'cancelled' ? 'CANCEL' : 'REQUEST',
  });

  return c.body(ics, 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="prenotazione-${b.uid}.ics"`,
  });
});
