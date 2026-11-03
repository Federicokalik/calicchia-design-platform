/**
 * PgLegacyStore, calendari: CRUD sulla tabella calendars + helper di accesso.
 *
 * Codice spostato da lib/calendar/calendars.ts nella fase F2 del passaggio a
 * Radicale SENZA modifiche di comportamento (cambiano solo i percorsi degli
 * import: errori in ../errors, validazioni pure in ../validation, che usa
 * anche RadicaleStore). buildFeedUrl resta nella facade ../calendars.ts
 * perché non dipende dallo store. Lo usa solo PgLegacyStore in ../store.ts.
 * Si elimina in F7.
 *
 * Contenuto originale:
 *
 * Mono-utente Federico: tutti i calendari sono di sua proprietà.
 * Calendari di sistema (is_system=true) come 'bookings' e 'scadenze' non sono
 * eliminabili dall'admin (DELETE blocca con 422).
 */

import { customAlphabet } from 'nanoid';
import { sql } from '../../../db';
import { CalendarConflictError, CalendarSystemError, CalendarValidationError } from '../errors';
import type { Calendar, ClosuresView, CreateCalendarInput, UpdateCalendarInput } from '../types';
import { CALENDAR_SLUG_REGEX as SLUG_REGEX, isValidTimeZone } from '../validation';

const generateFeedToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 32);

const COLUMNS = sql`
  id, slug, name, description, color, icon, timezone,
  is_default, is_system, blocks_availability, ics_feed_token, ics_feed_enabled,
  sort_order, created_at, updated_at
`;

export async function listCalendars(): Promise<Calendar[]> {
  return await sql<Calendar[]>`
    SELECT ${COLUMNS} FROM calendars
    ORDER BY sort_order ASC, name ASC
  `;
}

export async function getCalendar(idOrSlug: string): Promise<Calendar | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const rows = await sql<Calendar[]>`
    SELECT ${COLUMNS} FROM calendars
    WHERE ${isUuid ? sql`id = ${idOrSlug}::uuid` : sql`slug = ${idOrSlug}`}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function getCalendarByFeedToken(token: string): Promise<Calendar | null> {
  if (!token || token.length !== 32) return null;
  const rows = await sql<Calendar[]>`
    SELECT ${COLUMNS} FROM calendars
    WHERE ics_feed_token = ${token} AND ics_feed_enabled = true
    LIMIT 1
  `;
  return rows[0] || null;
}

/** Calendario di default — usato come fallback quando un evento non specifica calendar_id */
export async function getDefaultCalendar(): Promise<Calendar | null> {
  const rows = await sql<Calendar[]>`
    SELECT ${COLUMNS} FROM calendars
    WHERE is_default = true LIMIT 1
  `;
  return rows[0] || null;
}

/** Calendario 'bookings' (is_system) — destinazione per eventi auto-creati da prenotazioni */
export async function getBookingsCalendar(): Promise<Calendar | null> {
  const rows = await sql<Calendar[]>`
    SELECT ${COLUMNS} FROM calendars WHERE slug = 'bookings' LIMIT 1
  `;
  return rows[0] || null;
}

/**
 * Calendario "Festività e chiusure" (slug 'festivita'): festività IT auto-gestite
 * dal cron + chiusure manuali dal–al (ferie/ponti) inserite dall'admin.
 * Trova quello esistente — anche col vecchio nome "Festività" — o lo crea.
 * Condiviso da cron/italian-holidays.ts e dalle route /closures.
 */
export async function getOrCreateFestivitaCalendar(): Promise<Calendar> {
  const rows = await sql<Calendar[]>`
    SELECT ${COLUMNS} FROM calendars
    WHERE slug = 'festivita' OR lower(name) IN ('festività', 'festività e chiusure')
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (rows[0]) return rows[0];

  return await createCalendar({
    slug: 'festivita',
    name: 'Festività e chiusure',
    description: 'Festività nazionali italiane (auto) e chiusure manuali (ferie, ponti)',
    color: '#ef4444',
    timezone: 'Europe/Rome',
    blocks_availability: true,
    // Eliminarlo dall'UI cancellava in cascata tutte le chiusure manuali (ferie,
    // ponti) che il cron non ricrea: gli slot tornavano prenotabili.
    is_system: true,
  });
}

export async function createCalendar(input: CreateCalendarInput): Promise<Calendar> {
  if (input.timezone && !isValidTimeZone(input.timezone)) {
    throw new CalendarValidationError('Timezone non valida (es. Europe/Rome)');
  }
  if (!SLUG_REGEX.test(input.slug)) {
    throw new CalendarValidationError('Slug non valido (a-z, 0-9, -)');
  }
  const name = input.name?.trim();
  if (!name) {
    throw new CalendarValidationError('Nome richiesto');
  }

  const [duplicate] = await sql<Array<{ slug: string; name: string }>>`
    SELECT slug, name
    FROM calendars
    WHERE slug = ${input.slug.toLowerCase()}
       OR lower(name) = ${name.toLowerCase()}
    LIMIT 1
  `;
  if (duplicate?.slug === input.slug.toLowerCase()) {
    throw new CalendarConflictError('Slug gia usato');
  }
  if (duplicate) {
    throw new CalendarConflictError('Nome calendario gia usato');
  }

  // Se nuovo è default, demota gli altri prima
  if (input.is_default) {
    await sql`UPDATE calendars SET is_default = false WHERE is_default = true`;
  }

  const rows = await sql<Calendar[]>`
    INSERT INTO calendars ${sql({
      slug: input.slug.toLowerCase(),
      name: name.slice(0, 200),
      description: input.description?.trim().slice(0, 1000) || null,
      color: input.color || '#7c3aed',
      icon: input.icon || null,
      timezone: input.timezone || 'Europe/Rome',
      is_default: !!input.is_default,
      is_system: !!input.is_system,
      blocks_availability: input.blocks_availability !== false,
      ics_feed_token: generateFeedToken(),
      ics_feed_enabled: true,
      sort_order: input.sort_order || 0,
    })}
    RETURNING ${COLUMNS}
  `;
  return rows[0];
}

export async function updateCalendar(
  id: string,
  input: UpdateCalendarInput
): Promise<Calendar | null> {
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = String(input.name).trim().slice(0, 200);
  if (input.description !== undefined) updates.description = input.description ? String(input.description).trim().slice(0, 1000) : null;
  if (input.color !== undefined && /^#[0-9a-f]{6}$/i.test(input.color)) updates.color = input.color;
  if (input.icon !== undefined) updates.icon = input.icon;
  if (input.timezone !== undefined) {
    if (!isValidTimeZone(input.timezone)) throw new CalendarValidationError('Timezone non valida (es. Europe/Rome)');
    updates.timezone = input.timezone;
  }
  if (input.blocks_availability !== undefined) updates.blocks_availability = !!input.blocks_availability;
  if (input.ics_feed_enabled !== undefined) updates.ics_feed_enabled = !!input.ics_feed_enabled;
  if (input.sort_order !== undefined) updates.sort_order = parseInt(String(input.sort_order)) || 0;

  if (input.is_default === true) {
    // Demota gli altri prima di promuovere questo
    await sql`UPDATE calendars SET is_default = false WHERE is_default = true AND id != ${id}::uuid`;
    updates.is_default = true;
  } else if (input.is_default === false) {
    updates.is_default = false;
  }

  if (Object.keys(updates).length === 0) {
    return getCalendar(id);
  }

  const rows = await sql<Calendar[]>`
    UPDATE calendars SET ${sql(updates)}
    WHERE id = ${id}::uuid
    RETURNING ${COLUMNS}
  `;
  return rows[0] || null;
}

export async function deleteCalendar(id: string): Promise<void> {
  const cal = await getCalendar(id);
  if (!cal) return;
  if (cal.is_system) {
    throw new CalendarSystemError(`Calendario "${cal.name}" è di sistema e non può essere eliminato`);
  }
  // ON DELETE CASCADE rimuove tutti gli events
  await sql`DELETE FROM calendars WHERE id = ${id}::uuid`;
}

export async function rotateFeedToken(id: string): Promise<Calendar | null> {
  const rows = await sql<Calendar[]>`
    UPDATE calendars SET ics_feed_token = ${generateFeedToken()}
    WHERE id = ${id}::uuid
    RETURNING ${COLUMNS}
  `;
  return rows[0] || null;
}

// ============================================
// Letture spostate dalle route nella fase F2 (store-aware dalla facade),
// SENZA modifiche: stesse query e stessi effetti collaterali di prima.
// ============================================

/**
 * Conteggio degli eventi non cancellati per calendario (override compresi):
 * la query di GET /api/admin/calendar/calendars e del tool MCP list_calendars.
 */
export async function countEventsByCalendar(): Promise<Map<string, number>> {
  const counts = await sql<{ calendar_id: string; n: number }[]>`
    SELECT calendar_id, COUNT(*)::int AS n
    FROM calendar_events
    WHERE status != 'cancelled'
    GROUP BY calendar_id
  `;
  return new Map(counts.map((r) => [r.calendar_id, r.n]));
}

/**
 * Chiusure di GET /api/admin/calendar/closures: eventi del calendario
 * "Festività e chiusure" con source diversa da 'system' (le festività del
 * cron) e fine negli ultimi 30 giorni o dopo. Come prima, crea il calendario
 * se manca (effetto collaterale che lo store Radicale non ha, design §7).
 */
export async function listClosures(): Promise<ClosuresView> {
  const cal = await getOrCreateFestivitaCalendar();
  // source != 'system' separa le chiusure manuali dalle festività auto (cron).
  const closures = await sql<ClosuresView['closures']>`
    SELECT id, summary, start_time, end_time, source, status
    FROM calendar_events
    WHERE calendar_id = ${cal.id}::uuid
      AND source != 'system'
      AND end_time > NOW() - interval '30 days'
    ORDER BY start_time ASC
  `;
  return { closures, calendar: { id: cal.id, name: cal.name, timezone: cal.timezone } };
}
