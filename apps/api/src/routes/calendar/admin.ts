/**
 * Admin booking API — CRUD event types, schedule, bookings management.
 * Tutte le route richiedono authMiddleware (mountato in app.ts).
 */

import { Hono } from 'hono';
import { sql, sqlv } from '../../db';
import { computeAvailableSlots } from '../../lib/calendar/slots';
import { getEventType, loadScheduleForEventType } from '../../lib/calendar/availability';
import {
  createBooking,
  cancelBooking,
  rescheduleBooking,
  getBookingByUid,
  BookingConflictError,
  BookingValidationError,
} from '../../lib/calendar/booking';
import {
  sendBookingConfirmation,
  sendBookingAdminNotification,
  sendBookingCancelled,
  sendBookingRescheduled,
} from '../../lib/calendar/email';
import {
  listCalendars,
  getCalendar,
  createCalendar,
  updateCalendar,
  deleteCalendar,
  rotateFeedToken,
  buildFeedUrl,
  CalendarValidationError,
  CalendarSystemError,
} from '../../lib/calendar/calendars';
import {
  listOccurrences,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  createOccurrenceOverride,
  EventValidationError,
} from '../../lib/calendar/events';
import {
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  syncSubscription,
  SubscriptionValidationError,
} from '../../lib/calendar/subscriptions';
import type {
  AvailabilityOverride,
  AvailabilitySchedule,
  AvailabilitySlot,
  EventType,
} from '../../lib/calendar/types';

export const calendarAdmin = new Hono();

const isValidTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s);
const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;
const isValidSlug = (s: string) => /^[a-z0-9][a-z0-9-]{1,80}$/.test(s);

/**
 * Parse intero da input non fidato. Se null/undefined/NaN ritorna fallback.
 * Applica clamp opzionale [min, max].
 */
function safeInt(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' || typeof value === 'boolean') {
    n = parseInt(String(value), 10);
  } else {
    return Math.max(min, Math.min(max, fallback));
  }
  if (!Number.isFinite(n)) return Math.max(min, Math.min(max, fallback));
  return Math.max(min, Math.min(max, n));
}

// ============================================
// EVENT TYPES
// ============================================

calendarAdmin.get('/event-types', async (c) => {
  const rows = await sql<EventType[]>`
    SELECT * FROM calendar_event_types
    ORDER BY sort_order ASC, title ASC
  `;
  return c.json({ event_types: rows });
});

calendarAdmin.get('/event-types/:id', async (c) => {
  const rows = await sql<EventType[]>`
    SELECT * FROM calendar_event_types WHERE id = ${c.req.param('id')}::uuid LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: 'Event type non trovato' }, 404);
  return c.json({ event_type: rows[0] });
});

calendarAdmin.post('/event-types', async (c) => {
  const body = await c.req.json();
  const slug = String(body.slug || '').trim().toLowerCase();
  if (!isValidSlug(slug)) return c.json({ error: 'Slug non valido (a-z, 0-9, -)' }, 400);
  if (!body.title) return c.json({ error: 'Titolo richiesto' }, 400);
  if (!body.duration_minutes || body.duration_minutes < 5) return c.json({ error: 'Durata minima 5 minuti' }, 400);
  if (!body.location_type || !['google_meet','custom_url','in_person','phone'].includes(body.location_type)) {
    return c.json({ error: 'location_type non valido' }, 400);
  }

  try {
    const rows = await sql<EventType[]>`
      INSERT INTO calendar_event_types ${sqlv({
        slug,
        title: String(body.title).slice(0, 200),
        description: body.description ? String(body.description).slice(0, 5000) : null,
        duration_minutes: safeInt(body.duration_minutes, 30, 5, 480),
        buffer_before_minutes: safeInt(body.buffer_before_minutes, 0, 0),
        buffer_after_minutes: safeInt(body.buffer_after_minutes, 0, 0),
        slot_increment_minutes: safeInt(body.slot_increment_minutes, 30, 5),
        min_notice_hours: safeInt(body.min_notice_hours, 12, 0),
        max_advance_days: safeInt(body.max_advance_days, 60, 1, 365),
        location_type: body.location_type,
        location_value: body.location_value ? String(body.location_value).slice(0, 500) : null,
        color: typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#7c3aed',
        is_active: body.is_active !== false,
        is_public: body.is_public !== false,
        requires_approval: !!body.requires_approval,
        custom_questions: Array.isArray(body.custom_questions) ? body.custom_questions : [],
        workflow_event_key: body.workflow_event_key ? String(body.workflow_event_key).slice(0, 100) : null,
        schedule_id: body.schedule_id || null,
        sort_order: safeInt(body.sort_order, 0),
      })}
      RETURNING *
    `;
    return c.json({ event_type: rows[0] });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Slug già usato' }, 409);
    }
    throw err;
  }
});

calendarAdmin.put('/event-types/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const updates: Record<string, unknown> = {};
  const setIf = (key: string, val: unknown) => { if (val !== undefined) updates[key] = val; };

  if (body.slug !== undefined) {
    const s = String(body.slug).trim().toLowerCase();
    if (!isValidSlug(s)) return c.json({ error: 'Slug non valido' }, 400);
    updates.slug = s;
  }
  setIf('title', body.title ? String(body.title).slice(0, 200) : undefined);
  setIf('description', body.description !== undefined ? (body.description ? String(body.description).slice(0, 5000) : null) : undefined);
  if (body.duration_minutes !== undefined && body.duration_minutes !== null) updates.duration_minutes = safeInt(body.duration_minutes, 30, 5, 480);
  if (body.buffer_before_minutes !== undefined && body.buffer_before_minutes !== null) updates.buffer_before_minutes = safeInt(body.buffer_before_minutes, 0, 0);
  if (body.buffer_after_minutes !== undefined && body.buffer_after_minutes !== null) updates.buffer_after_minutes = safeInt(body.buffer_after_minutes, 0, 0);
  if (body.slot_increment_minutes !== undefined && body.slot_increment_minutes !== null) updates.slot_increment_minutes = safeInt(body.slot_increment_minutes, 30, 5);
  if (body.min_notice_hours !== undefined && body.min_notice_hours !== null) updates.min_notice_hours = safeInt(body.min_notice_hours, 12, 0);
  if (body.max_advance_days !== undefined && body.max_advance_days !== null) updates.max_advance_days = safeInt(body.max_advance_days, 60, 1, 365);
  if (body.location_type !== undefined) {
    if (!['google_meet','custom_url','in_person','phone'].includes(body.location_type)) {
      return c.json({ error: 'location_type non valido' }, 400);
    }
    updates.location_type = body.location_type;
  }
  setIf('location_value', body.location_value !== undefined ? (body.location_value ? String(body.location_value).slice(0, 500) : null) : undefined);
  if (body.color !== undefined && /^#[0-9a-f]{6}$/i.test(body.color)) updates.color = body.color;
  if (body.is_active !== undefined) updates.is_active = !!body.is_active;
  if (body.is_public !== undefined) updates.is_public = !!body.is_public;
  if (body.requires_approval !== undefined) updates.requires_approval = !!body.requires_approval;
  if (Array.isArray(body.custom_questions)) updates.custom_questions = body.custom_questions;
  setIf('workflow_event_key', body.workflow_event_key !== undefined ? (body.workflow_event_key ? String(body.workflow_event_key).slice(0, 100) : null) : undefined);
  if (body.schedule_id !== undefined) updates.schedule_id = body.schedule_id || null;
  if (body.sort_order !== undefined && body.sort_order !== null) updates.sort_order = safeInt(body.sort_order, 0);

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'Nessun campo da aggiornare' }, 400);
  }

  try {
    const rows = await sql<EventType[]>`
      UPDATE calendar_event_types SET ${sql(updates)} WHERE id = ${id}::uuid RETURNING *
    `;
    if (!rows[0]) return c.json({ error: 'Event type non trovato' }, 404);
    return c.json({ event_type: rows[0] });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Slug già usato' }, 409);
    }
    throw err;
  }
});

calendarAdmin.delete('/event-types/:id', async (c) => {
  // Soft-delete: imposta is_active=false per non rompere FK su bookings storici
  const rows = await sql<EventType[]>`
    UPDATE calendar_event_types SET is_active = false, is_public = false
    WHERE id = ${c.req.param('id')}::uuid RETURNING id
  `;
  if (!rows[0]) return c.json({ error: 'Event type non trovato' }, 404);
  return c.json({ success: true });
});

// ============================================
// SCHEDULE / DISPONIBILITA
// ============================================

calendarAdmin.get('/schedule', async (c) => {
  const schedules = await sql<AvailabilitySchedule[]>`
    SELECT id, name, timezone, is_default FROM calendar_availability_schedules
    ORDER BY is_default DESC, created_at ASC
  `;
  if (!schedules[0]) {
    return c.json({ schedule: null, slots: [], overrides: [] });
  }
  const schedule = schedules[0];

  const [slots, overrides] = await Promise.all([
    sql<AvailabilitySlot[]>`
      SELECT id, schedule_id, day_of_week,
             to_char(start_time, 'HH24:MI') AS start_time,
             to_char(end_time, 'HH24:MI') AS end_time
      FROM calendar_availability_slots
      WHERE schedule_id = ${schedule.id}::uuid
      ORDER BY day_of_week, start_time
    `,
    sql<AvailabilityOverride[]>`
      SELECT id, schedule_id, override_date::text AS override_date,
             is_unavailable,
             to_char(start_time, 'HH24:MI') AS start_time,
             to_char(end_time, 'HH24:MI') AS end_time,
             note
      FROM calendar_availability_overrides
      WHERE schedule_id = ${schedule.id}::uuid
      ORDER BY override_date DESC
    `,
  ]);

  return c.json({ schedule, slots, overrides });
});

calendarAdmin.put('/schedule', async (c) => {
  const body = await c.req.json();
  if (body.timezone !== undefined && typeof body.timezone !== 'string') {
    return c.json({ error: 'timezone deve essere stringa IANA' }, 400);
  }
  const updates: Record<string, unknown> = {};
  if (body.timezone) updates.timezone = body.timezone;
  if (body.name) updates.name = String(body.name).slice(0, 100);
  if (Object.keys(updates).length === 0) return c.json({ error: 'Nessun campo' }, 400);

  const rows = await sql<AvailabilitySchedule[]>`
    UPDATE calendar_availability_schedules SET ${sql(updates)}
    WHERE is_default = true RETURNING *
  `;
  return c.json({ schedule: rows[0] });
});

// Sostituisce TUTTI gli slot ricorrenti dello schedule default (replace-all atomico)
calendarAdmin.put('/schedule/slots', async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body.slots)) return c.json({ error: 'slots deve essere array' }, 400);

  for (const s of body.slots) {
    if (typeof s.day_of_week !== 'number' || s.day_of_week < 0 || s.day_of_week > 6) {
      return c.json({ error: 'day_of_week 0-6 richiesto per ogni slot' }, 400);
    }
    if (!isValidTime(s.start_time) || !isValidTime(s.end_time)) {
      return c.json({ error: 'Formato orario HH:MM richiesto' }, 400);
    }
    if (s.start_time >= s.end_time) {
      return c.json({ error: `Slot invalido: ${s.start_time} >= ${s.end_time}` }, 400);
    }
  }

  const [schedule] = await sql<AvailabilitySchedule[]>`
    SELECT id FROM calendar_availability_schedules WHERE is_default = true LIMIT 1
  `;
  if (!schedule) return c.json({ error: 'Schedule default non trovato' }, 404);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sql.begin(async (tx: any) => {
    await tx`DELETE FROM calendar_availability_slots WHERE schedule_id = ${schedule.id}::uuid`;
    if (body.slots.length) {
      const rows = body.slots.map((s: { day_of_week: number; start_time: string; end_time: string }) => ({
        schedule_id: schedule.id,
        day_of_week: s.day_of_week,
        start_time: s.start_time.length === 5 ? s.start_time + ':00' : s.start_time,
        end_time: s.end_time.length === 5 ? s.end_time + ':00' : s.end_time,
      }));
      await tx`
        INSERT INTO calendar_availability_slots ${tx(rows, 'schedule_id', 'day_of_week', 'start_time', 'end_time')}
      `;
    }
  });

  return c.json({ success: true });
});

// Override: GET già esposto in /schedule. POST/DELETE separati.
calendarAdmin.post('/schedule/overrides', async (c) => {
  const body = await c.req.json();
  if (!isValidDate(body.override_date)) return c.json({ error: 'override_date YYYY-MM-DD richiesto' }, 400);
  const isUnavail = !!body.is_unavailable;
  if (!isUnavail) {
    if (!isValidTime(body.start_time) || !isValidTime(body.end_time)) {
      return c.json({ error: 'start_time e end_time richiesti se non is_unavailable' }, 400);
    }
    if (body.start_time >= body.end_time) return c.json({ error: 'start < end richiesto' }, 400);
  }

  const [schedule] = await sql<AvailabilitySchedule[]>`
    SELECT id FROM calendar_availability_schedules WHERE is_default = true LIMIT 1
  `;
  if (!schedule) return c.json({ error: 'Schedule default non trovato' }, 404);

  const rows = await sql<AvailabilityOverride[]>`
    INSERT INTO calendar_availability_overrides ${sqlv({
      schedule_id: schedule.id,
      override_date: body.override_date,
      is_unavailable: isUnavail,
      start_time: isUnavail ? null : (body.start_time.length === 5 ? body.start_time + ':00' : body.start_time),
      end_time: isUnavail ? null : (body.end_time.length === 5 ? body.end_time + ':00' : body.end_time),
      note: body.note ? String(body.note).slice(0, 500) : null,
    })}
    ON CONFLICT (schedule_id, override_date) DO UPDATE SET
      is_unavailable = EXCLUDED.is_unavailable,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      note = EXCLUDED.note
    RETURNING *
  `;
  return c.json({ override: rows[0] });
});

calendarAdmin.delete('/schedule/overrides/:id', async (c) => {
  const rows = await sql`
    DELETE FROM calendar_availability_overrides WHERE id = ${c.req.param('id')}::uuid RETURNING id
  `;
  if (!rows[0]) return c.json({ error: 'Override non trovato' }, 404);
  return c.json({ success: true });
});

// ============================================
// BOOKINGS
// ============================================

calendarAdmin.get('/bookings', async (c) => {
  const status = c.req.query('status');
  const search = c.req.query('search');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const eventTypeId = c.req.query('event_type_id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const statusFilter = status && status !== 'all' ? sql`AND b.status = ${status}` : sql``;
  const searchFilter = search
    ? sql`AND (b.attendee_name ILIKE ${'%' + search + '%'} OR b.attendee_email ILIKE ${'%' + search + '%'})`
    : sql``;
  const fromFilter = from && isValidDate(from) ? sql`AND b.start_time >= ${from + 'T00:00:00Z'}` : sql``;
  const toFilter = to && isValidDate(to) ? sql`AND b.start_time < ${to + 'T23:59:59Z'}` : sql``;
  const etFilter = eventTypeId ? sql`AND b.event_type_id = ${eventTypeId}::uuid` : sql``;

  const [bookings, allCounts] = await Promise.all([
    sql`
      SELECT b.*, et.title AS event_type_title, et.slug AS event_type_slug,
             et.color AS event_type_color, et.duration_minutes AS event_type_duration,
             COUNT(*) OVER() AS _total_count
      FROM calendar_bookings b
      JOIN calendar_event_types et ON et.id = b.event_type_id
      WHERE 1=1 ${statusFilter} ${searchFilter} ${fromFilter} ${toFilter} ${etFilter}
      ORDER BY b.start_time DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql`
      SELECT status, COUNT(*) AS n FROM calendar_bookings
      WHERE start_time >= NOW() - INTERVAL '90 days'
      GROUP BY status
    `,
  ]);

  const total = bookings[0]?._total_count ? parseInt(bookings[0]._total_count as string) : 0;
  const cleaned = bookings.map((b) => ({ ...b, _total_count: undefined }));

  const stats: Record<string, number> = { confirmed: 0, cancelled: 0, completed: 0, no_show: 0, rescheduled: 0 };
  for (const r of allCounts) {
    stats[r.status as string] = parseInt(r.n as string);
  }

  return c.json({ bookings: cleaned, count: total, stats });
});

calendarAdmin.get('/bookings/:uid', async (c) => {
  const b = await getBookingByUid(c.req.param('uid'));
  if (!b) return c.json({ error: 'Prenotazione non trovata' }, 404);
  return c.json({ booking: b });
});

calendarAdmin.post('/bookings', async (c) => {
  const body = await c.req.json();
  if (!body.event_type_id && !body.event_type_slug) return c.json({ error: 'event_type_id o event_type_slug richiesto' }, 400);
  if (!body.start || isNaN(Date.parse(body.start))) return c.json({ error: 'start ISO richiesto' }, 400);
  if (!body.attendee_name || !body.attendee_email || !isValidEmail(body.attendee_email)) {
    return c.json({ error: 'Nome e email valida richiesti' }, 400);
  }

  try {
    const { booking, eventType } = await createBooking({
      event_type_id: body.event_type_id,
      event_type_slug: body.event_type_slug,
      start: body.start,
      attendee: {
        name: body.attendee_name,
        email: body.attendee_email,
        phone: body.attendee_phone || undefined,
        company: body.attendee_company || undefined,
        timezone: body.attendee_timezone || 'Europe/Rome',
        message: body.attendee_message || undefined,
      },
      source: 'admin_manual',
      source_metadata: { created_by: 'admin' },
    });

    if (body.send_emails !== false) {
      Promise.allSettled([
        sendBookingConfirmation({ booking, eventType }),
        sendBookingAdminNotification({ booking, eventType }),
      ]).catch((err) => console.error('[calendar/admin] email send error:', err));
    }

    return c.json({ booking });
  } catch (err) {
    if (err instanceof BookingConflictError) return c.json({ error: err.message, code: 'BOOKING_CONFLICT' }, 409);
    if (err instanceof BookingValidationError) return c.json({ error: err.message, code: 'BOOKING_VALIDATION' }, 400);
    throw err;
  }
});

calendarAdmin.post('/bookings/:uid/cancel', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await cancelBooking(c.req.param('uid'), {
    cancelled_by: 'admin',
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined,
  });
  if (!result) return c.json({ error: 'Prenotazione non trovata' }, 404);

  if (body.notify !== false) {
    Promise.allSettled([
      sendBookingCancelled({ ...result, recipient: 'attendee' }),
    ]).catch((err) => console.error('[calendar/admin] cancel email error:', err));
  }

  return c.json({ success: true });
});

calendarAdmin.post('/bookings/:uid/reschedule', async (c) => {
  const body = await c.req.json();
  if (!body.start || isNaN(Date.parse(body.start))) return c.json({ error: 'start ISO richiesto' }, 400);

  try {
    const previous = await getBookingByUid(c.req.param('uid'));
    if (!previous) return c.json({ error: 'Prenotazione non trovata' }, 404);
    const result = await rescheduleBooking(c.req.param('uid'), body.start, {
      by: 'admin',
      reason: body.reason || 'Riprogrammata dall\'admin',
    });
    if (body.notify !== false) {
      Promise.allSettled([
        sendBookingRescheduled({
          booking: result.booking, eventType: result.eventType,
          previousStart: previous.start_time, recipient: 'attendee',
        }),
      ]).catch((err) => console.error('[calendar/admin] reschedule email error:', err));
    }
    return c.json({ booking: result.booking });
  } catch (err) {
    if (err instanceof BookingConflictError) return c.json({ error: err.message, code: 'BOOKING_CONFLICT' }, 409);
    if (err instanceof BookingValidationError) return c.json({ error: err.message, code: 'BOOKING_VALIDATION' }, 400);
    throw err;
  }
});

calendarAdmin.post('/bookings/:uid/mark', async (c) => {
  const body = await c.req.json();
  const newStatus = body.status;
  if (!['completed','no_show'].includes(newStatus)) return c.json({ error: 'status deve essere completed o no_show' }, 400);

  const rows = await sql`
    UPDATE calendar_bookings SET status = ${newStatus}
    WHERE uid = ${c.req.param('uid')} AND status IN ('confirmed','rescheduled')
    RETURNING id
  `;
  if (!rows[0]) return c.json({ error: 'Prenotazione non trovata o già finalizzata' }, 404);
  return c.json({ success: true });
});

calendarAdmin.post('/bookings/:uid/resend-confirmation', async (c) => {
  const b = await getBookingByUid(c.req.param('uid'));
  if (!b) return c.json({ error: 'Prenotazione non trovata' }, 404);
  // Cancello la riga audit per permettere il re-invio
  await sql`
    DELETE FROM calendar_booking_reminders
    WHERE booking_id = ${b.id}::uuid AND reminder_type = 'confirmation'
  `;
  await sendBookingConfirmation({ booking: b, eventType: b.event_type });
  return c.json({ success: true });
});

// ============================================
// SLOTS PREVIEW (per UI admin)
// ============================================

calendarAdmin.get('/event-types/:idOrSlug/slots', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!from || !isValidDate(from)) return c.json({ error: 'from YYYY-MM-DD richiesto' }, 400);
  if (!to || !isValidDate(to)) return c.json({ error: 'to YYYY-MM-DD richiesto' }, 400);

  const result = await computeAvailableSlots({
    eventTypeIdOrSlug: c.req.param('idOrSlug'),
    fromDateLocal: from,
    toDateLocal: to,
    onlyPublic: false,
  });
  if (!result) return c.json({ error: 'Event type non trovato' }, 404);

  return c.json({
    timezone: result.timezone,
    duration_minutes: result.eventType.duration_minutes,
    slots_by_date: result.slotsByDate,
    slots: result.slots,
  });
});

// Schedule per event type (riusato dalla pagina disponibilità)
calendarAdmin.get('/event-types/:idOrSlug/schedule', async (c) => {
  const et = await getEventType(c.req.param('idOrSlug'));
  if (!et) return c.json({ error: 'Event type non trovato' }, 404);
  const sched = await loadScheduleForEventType(et);
  return c.json({ event_type: et, ...sched });
});

// ============================================
// CALENDARS (Caldes Calendar — multi-calendario self-hosted)
// ============================================

calendarAdmin.get('/calendars', async (c) => {
  const calendars = await listCalendars();
  // Conteggio eventi attivi per ogni calendario
  const counts = await sql<{ calendar_id: string; n: number }[]>`
    SELECT calendar_id, COUNT(*)::int AS n
    FROM calendar_events
    WHERE status != 'cancelled'
    GROUP BY calendar_id
  `;
  const countMap = new Map(counts.map((r) => [r.calendar_id, r.n]));
  return c.json({
    calendars: calendars.map((cal) => ({
      ...cal,
      event_count: countMap.get(cal.id) || 0,
      ics_feed_url: cal.ics_feed_enabled ? buildFeedUrl(cal) : null,
    })),
  });
});

calendarAdmin.get('/calendars/:idOrSlug', async (c) => {
  const cal = await getCalendar(c.req.param('idOrSlug'));
  if (!cal) return c.json({ error: 'Calendario non trovato' }, 404);
  return c.json({ calendar: { ...cal, ics_feed_url: cal.ics_feed_enabled ? buildFeedUrl(cal) : null } });
});

calendarAdmin.post('/calendars', async (c) => {
  const body = await c.req.json();
  try {
    const cal = await createCalendar({
      slug: String(body.slug || '').toLowerCase(),
      name: String(body.name || ''),
      description: body.description || null,
      color: body.color || '#7c3aed',
      icon: body.icon || null,
      timezone: body.timezone || 'Europe/Rome',
      is_default: !!body.is_default,
      sort_order: safeInt(body.sort_order, 0),
    });
    return c.json({ calendar: { ...cal, ics_feed_url: buildFeedUrl(cal) } });
  } catch (err) {
    if (err instanceof CalendarValidationError) return c.json({ error: err.message }, 400);
    if ((err as { code?: string }).code === '23505') return c.json({ error: 'Slug già usato' }, 409);
    throw err;
  }
});

calendarAdmin.put('/calendars/:id', async (c) => {
  const body = await c.req.json();
  try {
    const cal = await updateCalendar(c.req.param('id'), body);
    if (!cal) return c.json({ error: 'Calendario non trovato' }, 404);
    return c.json({ calendar: { ...cal, ics_feed_url: cal.ics_feed_enabled ? buildFeedUrl(cal) : null } });
  } catch (err) {
    if (err instanceof CalendarValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

calendarAdmin.delete('/calendars/:id', async (c) => {
  try {
    await deleteCalendar(c.req.param('id'));
    return c.json({ success: true });
  } catch (err) {
    if (err instanceof CalendarSystemError) return c.json({ error: err.message }, 422);
    throw err;
  }
});

calendarAdmin.post('/calendars/:id/rotate-token', async (c) => {
  const cal = await rotateFeedToken(c.req.param('id'));
  if (!cal) return c.json({ error: 'Calendario non trovato' }, 404);
  return c.json({ calendar: { ...cal, ics_feed_url: buildFeedUrl(cal) } });
});

// ============================================
// EVENTS (CRUD eventi calendario con espansione ricorrenze)
// ============================================

calendarAdmin.get('/events', async (c) => {
  const calendarId = c.req.query('calendar_id');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const includeCancelled = c.req.query('include_cancelled') === 'true';

  if (!from || !to) return c.json({ error: 'from e to richiesti (ISO datetime)' }, 400);

  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return c.json({ error: 'from/to devono essere ISO datetime validi' }, 400);
  }
  if (toDate.getTime() - fromDate.getTime() > 366 * 24 * 60 * 60 * 1000) {
    return c.json({ error: 'Range massimo 366 giorni' }, 400);
  }

  const occurrences = await listOccurrences({
    calendarId: calendarId || undefined,
    fromIso: fromDate.toISOString(),
    toIso: toDate.toISOString(),
    includeCancelled,
  });

  return c.json({ events: occurrences });
});

calendarAdmin.get('/events/:id', async (c) => {
  const ev = await getEvent(c.req.param('id'));
  if (!ev) return c.json({ error: 'Evento non trovato' }, 404);
  return c.json({ event: ev });
});

calendarAdmin.post('/events', async (c) => {
  const body = await c.req.json();
  try {
    const ev = await createEvent({
      calendar_id: body.calendar_id,
      summary: String(body.summary || ''),
      description: body.description || null,
      location: body.location || null,
      url: body.url || null,
      start_time: body.start_time,
      end_time: body.end_time,
      all_day: !!body.all_day,
      rrule: body.rrule || null,
      exdates: Array.isArray(body.exdates) ? body.exdates : [],
      source: body.source || 'admin',
      source_id: body.source_id || null,
      status: body.status || 'confirmed',
    });
    return c.json({ event: ev });
  } catch (err) {
    if (err instanceof EventValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

calendarAdmin.put('/events/:id', async (c) => {
  const body = await c.req.json();
  try {
    const ev = await updateEvent(c.req.param('id'), body);
    if (!ev) return c.json({ error: 'Evento non trovato' }, 404);
    return c.json({ event: ev });
  } catch (err) {
    if (err instanceof EventValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

calendarAdmin.delete('/events/:id', async (c) => {
  const ok = await deleteEvent(c.req.param('id'));
  if (!ok) return c.json({ error: 'Evento non trovato' }, 404);
  return c.json({ success: true });
});

// Crea override per occorrenza singola di evento ricorrente
// (es. "sposta SOLO il standup di mercoledi a 12:00 invece di 09:00")
calendarAdmin.post('/events/:id/exception', async (c) => {
  const body = await c.req.json();
  if (!body.original_start) return c.json({ error: 'original_start richiesto' }, 400);
  try {
    const override = await createOccurrenceOverride({
      masterEventId: c.req.param('id'),
      originalStartIso: body.original_start,
      newStartIso: body.new_start,
      newEndIso: body.new_end,
      newSummary: body.summary,
      newDescription: body.description,
      status: body.status || 'confirmed',
    });
    return c.json({ event: override });
  } catch (err) {
    if (err instanceof EventValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// ============================================
// SUBSCRIPTIONS (read-only ICS pull — Google Calendar via "secret iCal" URL)
// ============================================

calendarAdmin.get('/subscriptions', async (c) => {
  const subs = await listSubscriptions();
  return c.json({ subscriptions: subs });
});

calendarAdmin.post('/subscriptions', async (c) => {
  const body = await c.req.json();
  try {
    const sub = await createSubscription({
      calendar_id: String(body.calendar_id || ''),
      name: String(body.name || ''),
      ics_url: String(body.ics_url || ''),
    });
    // Sync immediato per dare feedback all'utente (non aspetta il prossimo cron tick)
    const result = await syncSubscription(sub.id);
    const refreshed = await getSubscription(sub.id);
    return c.json({ subscription: refreshed, sync: result });
  } catch (err) {
    if (err instanceof SubscriptionValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

calendarAdmin.put('/subscriptions/:id', async (c) => {
  const body = await c.req.json();
  try {
    const sub = await updateSubscription(c.req.param('id'), body);
    if (!sub) return c.json({ error: 'Subscription non trovata' }, 404);
    return c.json({ subscription: sub });
  } catch (err) {
    if (err instanceof SubscriptionValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

calendarAdmin.delete('/subscriptions/:id', async (c) => {
  const ok = await deleteSubscription(c.req.param('id'));
  if (!ok) return c.json({ error: 'Subscription non trovata' }, 404);
  return c.json({ success: true });
});

calendarAdmin.post('/subscriptions/:id/sync', async (c) => {
  try {
    const result = await syncSubscription(c.req.param('id'));
    const refreshed = await getSubscription(c.req.param('id'));
    return c.json({ subscription: refreshed, sync: result });
  } catch (err) {
    if (err instanceof SubscriptionValidationError) return c.json({ error: err.message }, 404);
    throw err;
  }
});
