/**
 * CRUD calendari + helper per accesso comuni.
 *
 * Mono-utente Federico: tutti i calendari sono di sua proprietà.
 * Calendari di sistema (is_system=true) come 'bookings' e 'scadenze' non sono
 * eliminabili dall'admin (DELETE blocca con 422).
 */

import { customAlphabet } from 'nanoid';
import { sql, sqlv } from '../../db';
import type { Calendar, CreateCalendarInput } from './types';

const generateFeedToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 32);

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,80}$/;

export class CalendarValidationError extends Error {
  code = 'CALENDAR_VALIDATION' as const;
  constructor(message: string) { super(message); }
}

export class CalendarSystemError extends Error {
  code = 'CALENDAR_SYSTEM' as const;
  constructor(message = 'Calendario di sistema non eliminabile') { super(message); }
}

const COLUMNS = sql`
  id, slug, name, description, color, icon, timezone,
  is_default, is_system, ics_feed_token, ics_feed_enabled,
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

export async function createCalendar(input: CreateCalendarInput): Promise<Calendar> {
  if (!SLUG_REGEX.test(input.slug)) {
    throw new CalendarValidationError('Slug non valido (a-z, 0-9, -)');
  }
  if (!input.name?.trim()) {
    throw new CalendarValidationError('Nome richiesto');
  }

  // Se nuovo è default, demota gli altri prima
  if (input.is_default) {
    await sql`UPDATE calendars SET is_default = false WHERE is_default = true`;
  }

  const rows = await sql<Calendar[]>`
    INSERT INTO calendars ${sqlv({
      slug: input.slug.toLowerCase(),
      name: input.name.trim().slice(0, 200),
      description: input.description?.trim().slice(0, 1000) || null,
      color: input.color || '#7c3aed',
      icon: input.icon || null,
      timezone: input.timezone || 'Europe/Rome',
      is_default: !!input.is_default,
      is_system: false,
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
  input: Partial<Pick<Calendar, 'name' | 'description' | 'color' | 'icon' | 'timezone' | 'is_default' | 'ics_feed_enabled' | 'sort_order'>>
): Promise<Calendar | null> {
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = String(input.name).trim().slice(0, 200);
  if (input.description !== undefined) updates.description = input.description ? String(input.description).trim().slice(0, 1000) : null;
  if (input.color !== undefined && /^#[0-9a-f]{6}$/i.test(input.color)) updates.color = input.color;
  if (input.icon !== undefined) updates.icon = input.icon;
  if (input.timezone !== undefined) updates.timezone = input.timezone;
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

/**
 * Costruisce l'URL pubblico ICS feed per un calendario.
 * Es. https://api.calicchia.design/api/calendar/feed/abc123def456...ics
 */
export function buildFeedUrl(calendar: Calendar, baseUrl?: string): string {
  const base = baseUrl || process.env.PUBLIC_API_URL || 'http://localhost:3001';
  return `${base.replace(/\/$/, '')}/api/calendar/feed/${calendar.ics_feed_token}.ics`;
}
