import { Hono } from 'hono';
import { sql } from '../db';
import { authMiddleware } from '../middleware/auth';
import { sendContactNotification } from '../lib/email';
import { verifyTurnstileToken } from '../lib/turnstile';
import {
  createBooking,
  BookingConflictError,
  BookingValidationError,
} from '../lib/calendar/booking';
import { computeAvailableSlots } from '../lib/calendar/slots';
import {
  sendBookingConfirmation,
  sendBookingAdminNotification,
} from '../lib/calendar/email';
import {
  isAuditLeadSource,
  scheduleAuditOnboardingSequence,
  runLeadAuditSequence,
} from '../jobs/lead-audit-sequence';

export const contacts = new Hono();

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;

// Slug del nuovo event type dedicato al form contatti
const CONTACT_FORM_EVENT_TYPE = process.env.CONTACT_FORM_EVENT_TYPE || 'consulenza-gratuita-30min';

// ─── Public: slot disponibili per il form contatti ──────────────────────────
// Mantiene compatibilità con il vecchio path /cal-slots ma usa il sistema interno.

contacts.get('/cal-slots', async (c) => {
  const date = c.req.query('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Parametro date richiesto (YYYY-MM-DD)' }, 400);
  }

  try {
    const result = await computeAvailableSlots({
      eventTypeIdOrSlug: CONTACT_FORM_EVENT_TYPE,
      fromDateLocal: date,
      toDateLocal: date,
      onlyPublic: true,
    });

    if (!result) return c.json({ error: 'Tipologia di prenotazione non disponibile' }, 503);

    // Mantiene la shape originale { slots: { 'YYYY-MM-DD': [{time}] } } per compat
    // con MultiStepContactForm finché non viene aggiornato.
    const slotsByDate: Record<string, { time: string }[]> = {};
    for (const [d, list] of Object.entries(result.slotsByDate)) {
      slotsByDate[d] = list.map((s) => ({ time: s.start }));
    }

    return c.json({ slots: slotsByDate });
  } catch (err) {
    console.error('[contacts/cal-slots] error:', err);
    return c.json({ error: 'Errore nel recupero degli slot disponibili' }, 500);
  }
});

// ─── Public: Submit contact form ───────────────────────────────

contacts.post('/', async (c) => {
  const body = await c.req.json();
  const {
    name, email, message, phone, company,
    services, sectors,
    wants_call, wants_meet, gdpr_consent,
    source_page, source_service, source_profession,
    lead_source,
    meet_slot, // ISO datetime string if user picked a slot
    turnstile_token,
  } = body;

  // Turnstile verification
  const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined;
  const turnstileOk = await verifyTurnstileToken(turnstile_token || '', clientIp);
  if (!turnstileOk) {
    return c.json({ error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' }, 403);
  }

  // Validation
  if (!name || !email) {
    return c.json({ error: 'Nome e email richiesti' }, 400);
  }
  if (!isValidEmail(email)) {
    return c.json({ error: 'Email non valida' }, 400);
  }
  if (typeof name === 'string' && name.length > 100) {
    return c.json({ error: 'Nome troppo lungo (max 100 caratteri)' }, 400);
  }
  if (typeof message === 'string' && message.length > 2000) {
    return c.json({ error: 'Messaggio troppo lungo (max 2000 caratteri)' }, 400);
  }
  if (typeof phone === 'string') {
    if (phone.length > 30) return c.json({ error: 'Numero di telefono troppo lungo' }, 400);
    if (phone && !/^\+\d{1,4}\s?\d{4,15}$/.test(phone.replace(/\s+/g, ' ').trim())) {
      return c.json({ error: 'Formato telefono non valido (es. +39 3510000000)' }, 400);
    }
  }
  if (typeof company === 'string' && company.length > 150) {
    return c.json({ error: 'Nome azienda troppo lungo' }, 400);
  }
  if (typeof lead_source === 'string' && lead_source.length > 64) {
    return c.json({ error: 'Origine lead troppo lunga' }, 400);
  }
  if (meet_slot && (typeof meet_slot !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(meet_slot))) {
    return c.json({ error: 'Formato slot non valido' }, 400);
  }
  if (gdpr_consent !== true) {
    return c.json({ error: 'Consenso GDPR richiesto' }, 400);
  }

  // Sanitize arrays
  const safeServices = Array.isArray(services) ? services.filter((s: unknown) => typeof s === 'string').slice(0, 20) : null;
  const safeSectors = Array.isArray(sectors) ? sectors.filter((s: unknown) => typeof s === 'string').slice(0, 10) : null;
  const safeLeadSource =
    typeof lead_source === 'string' && lead_source.trim()
      ? lead_source.trim().slice(0, 64)
      : null;

  // Crea booking interno se l'utente ha scelto uno slot
  let calBookingUid: string | null = null;
  let meetingUrl: string | null = null;
  let bookingConflict = false;

  if (wants_meet && meet_slot) {
    try {
      const { booking, eventType } = await createBooking({
        event_type_slug: CONTACT_FORM_EVENT_TYPE,
        start: meet_slot,
        attendee: {
          name,
          email,
          phone: phone || undefined,
          company: company || undefined,
          timezone: 'Europe/Rome',
          message: message || undefined,
        },
        source: 'contact_form',
        source_metadata: {
          source_page: source_page || null,
          source_service: source_service || null,
          source_profession: source_profession || null,
          lead_source: safeLeadSource,
        },
      });

      calBookingUid = booking.uid;
      meetingUrl = booking.location_value || null;

      // Email asincrone (non blocca il form)
      Promise.allSettled([
        sendBookingConfirmation({ booking, eventType }),
        sendBookingAdminNotification({ booking, eventType }),
      ]).catch((err) => console.error('[contacts] booking email error:', err));
    } catch (err) {
      if (err instanceof BookingConflictError) {
        bookingConflict = true;
      } else if (err instanceof BookingValidationError) {
        console.warn('[contacts] booking validation:', err.message);
      } else {
        console.error('[contacts] booking create error:', err);
      }
      // Non blocca il form — il messaggio viene salvato comunque
    }
  }

  const [inserted] = await sql`
    INSERT INTO contacts (
      name, email, message, phone, company,
      services, sectors,
      wants_call, wants_meet, gdpr_consent,
      source_page, source_service, source_profession,
      lead_source,
      meet_slot, cal_booking_uid
    )
    VALUES (
      ${name},
      ${email},
      ${message || null},
      ${phone || null},
      ${company || null},
      ${safeServices},
      ${safeSectors},
      ${!!wants_call},
      ${!!wants_meet},
      ${!!gdpr_consent},
      ${typeof source_page === 'string' ? source_page.slice(0, 255) : null},
      ${typeof source_service === 'string' ? source_service.slice(0, 100) : null},
      ${typeof source_profession === 'string' ? source_profession.slice(0, 100) : null},
      ${safeLeadSource},
      ${meet_slot || null},
      ${calBookingUid}
    )
    RETURNING id
  `;

  if (isAuditLeadSource(safeLeadSource)) {
    scheduleAuditOnboardingSequence(inserted.id, safeLeadSource)
      .then(() => runLeadAuditSequence())
      .catch((err) => console.error('[contacts] audit sequence schedule failed:', err));
  }

  // Auto-create lead in pipeline + notify Telegram
  try {
    await sql`
      INSERT INTO leads (name, email, phone, company, source, source_id, status, notes)
      VALUES (
        ${name},
        ${email},
        ${phone || null},
        ${company || null},
        'website_form',
        ${inserted.id},
        'new',
        ${message || null}
      )
    `;
    // Notify via Telegram
    import('../lib/telegram').then(({ notifyTelegram }) => {
      const value = company ? ` (${company})` : '';
      notifyTelegram('🔔 Nuovo lead dal sito', `${name}${value}\n${email}${phone ? `\n${phone}` : ''}`);
    }).catch((err) => console.error('[contacts] Telegram notify failed:', err));
    // Fire workflow event
    import('../lib/workflow/triggers').then(({ fireEvent }) => {
      fireEvent('nuovo_lead', { name, email, phone, company });
    }).catch((err) => console.error('[contacts] Workflow trigger failed:', err));
  } catch (err) {
    console.error('Error auto-creating lead from contact:', err);
  }

  // Send email notification (non-blocking)
  sendContactNotification({
    name, email, company, phone, message,
    services: safeServices,
    sectors: safeSectors,
    wants_call: !!wants_call,
    wants_meet: !!wants_meet,
    source_page, source_service, source_profession,
  }).catch((err) => console.error('Failed to send contact notification:', err));

  return c.json({
    success: true,
    message: 'Messaggio inviato!',
    id: inserted.id,
    booking: calBookingUid ? { uid: calBookingUid, meetingUrl } : null,
    booking_conflict: bookingConflict || undefined,
  });
});

// ─── Protected: Admin endpoints ───────────────────────────────

contacts.get('/', authMiddleware, async (c) => {
  const filter = c.req.query('filter');

  const unreadFilter = filter === 'unread' ? sql`AND is_read = false` : sql``;
  const readFilter = filter === 'read' ? sql`AND is_read = true` : sql``;
  const archivedFilter = filter === 'archived' ? sql`AND is_archived = true` : sql``;

  const contacts = await sql`
    SELECT * FROM contacts
    WHERE 1=1 ${unreadFilter} ${readFilter} ${archivedFilter}
    ORDER BY created_at DESC
  `;

  return c.json({ contacts });
});

contacts.put('/:id/read', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const { is_read } = await c.req.json();

  await sql`UPDATE contacts SET is_read = ${is_read} WHERE id = ${id}`;
  return c.json({ success: true });
});

contacts.put('/:id/archive', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const { is_archived } = await c.req.json();

  await sql`UPDATE contacts SET is_archived = ${is_archived} WHERE id = ${id}`;
  return c.json({ success: true });
});

contacts.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  await sql`DELETE FROM contacts WHERE id = ${id}`;
  return c.json({ success: true });
});
