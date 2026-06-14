/**
 * CRUD eventi calendario + espansione ricorrenze.
 *
 * Pattern RRULE/override:
 *  - Master ricorrente: row con rrule != null, recurrence_master_id = null
 *  - Override singola occorrenza: row con recurrence_master_id = master.id,
 *    recurrence_id = original_start del master che sta sostituendo
 *  - Esclusioni: master.exdates JSONB array di ISO timestamps
 *
 * `expandRecurrences` produce CalendarEventOccurrence[] per il rendering
 * (frontend admin, ICS feed, slot calculator busy ranges).
 */

import { createHash } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { sql, sqlv, sqlInsert } from '../../db';
import { expandRRule, validateRRule } from './rrule';
import type {
  CalendarEvent,
  CalendarEventOccurrence,
  CreateEventInput,
} from './types';

const generateEventUid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

export class EventValidationError extends Error {
  code = 'EVENT_VALIDATION' as const;
  constructor(message: string) { super(message); }
}

const COLUMNS = sql`
  id, calendar_id, uid, summary, description, location, url,
  start_time, end_time, all_day,
  rrule, exdates, recurrence_id, recurrence_master_id,
  source, source_id, status, created_at, updated_at
`;

// ============================================
// CRUD base
// ============================================

export async function getEvent(idOrUid: string): Promise<CalendarEvent | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrUid);
  const rows = await sql<CalendarEvent[]>`
    SELECT ${COLUMNS} FROM calendar_events
    WHERE ${isUuid ? sql`id = ${idOrUid}::uuid` : sql`uid = ${idOrUid}`}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function getEventBySource(source: string, sourceId: string): Promise<CalendarEvent | null> {
  const rows = await sql<CalendarEvent[]>`
    SELECT ${COLUMNS} FROM calendar_events
    WHERE source = ${source} AND source_id = ${sourceId}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function createEvent(input: CreateEventInput): Promise<CalendarEvent> {
  if (!input.calendar_id) throw new EventValidationError('calendar_id richiesto');
  if (!input.summary?.trim()) throw new EventValidationError('Titolo richiesto');
  const start = new Date(input.start_time);
  const end = new Date(input.end_time);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new EventValidationError('Date non valide');
  if (start >= end) throw new EventValidationError('end_time deve essere > start_time');

  // Valida RRULE se presente
  let rruleNormalized: string | null = null;
  if (input.rrule) {
    rruleNormalized = validateRRule(input.rrule, input.start_time);
    if (!rruleNormalized) throw new EventValidationError('RRULE non valida');
  }

  const rows = await sql<CalendarEvent[]>`
    INSERT INTO calendar_events ${sqlInsert({
      calendar_id: input.calendar_id,
      uid: input.uid?.trim().slice(0, 255) || generateEventUid(),
      summary: input.summary.trim().slice(0, 500),
      description: input.description?.trim().slice(0, 5000) || null,
      location: input.location?.trim().slice(0, 500) || null,
      url: input.url?.trim().slice(0, 1000) || null,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      all_day: !!input.all_day,
      rrule: rruleNormalized,
      exdates: input.exdates || [],
      recurrence_id: null,
      recurrence_master_id: null,
      source: input.source || 'manual',
      source_id: input.source_id || null,
      status: input.status || 'confirmed',
    })}
    RETURNING ${COLUMNS}
  `;
  return rows[0];
}

export interface UpdateEventInput {
  summary?: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  start_time?: string;
  end_time?: string;
  all_day?: boolean;
  rrule?: string | null;
  exdates?: string[];
  status?: 'confirmed' | 'tentative' | 'cancelled';
  calendar_id?: string;
}

export async function updateEvent(id: string, input: UpdateEventInput): Promise<CalendarEvent | null> {
  const existing = await getEvent(id);
  if (!existing) return null;

  const updates: Record<string, unknown> = {};
  if (input.summary !== undefined) updates.summary = String(input.summary).trim().slice(0, 500);
  if (input.description !== undefined) updates.description = input.description ? String(input.description).trim().slice(0, 5000) : null;
  if (input.location !== undefined) updates.location = input.location ? String(input.location).trim().slice(0, 500) : null;
  if (input.url !== undefined) updates.url = input.url ? String(input.url).trim().slice(0, 1000) : null;
  if (input.calendar_id !== undefined) updates.calendar_id = input.calendar_id;

  let newStart = existing.start_time;
  let newEnd = existing.end_time;
  if (input.start_time !== undefined) {
    const d = new Date(input.start_time);
    if (isNaN(d.getTime())) throw new EventValidationError('start_time non valido');
    newStart = d.toISOString();
    updates.start_time = newStart;
  }
  if (input.end_time !== undefined) {
    const d = new Date(input.end_time);
    if (isNaN(d.getTime())) throw new EventValidationError('end_time non valido');
    newEnd = d.toISOString();
    updates.end_time = newEnd;
  }
  if (new Date(newStart) >= new Date(newEnd)) throw new EventValidationError('end_time deve essere > start_time');

  if (input.all_day !== undefined) updates.all_day = !!input.all_day;
  if (input.exdates !== undefined) updates.exdates = input.exdates;
  if (input.status !== undefined) updates.status = input.status;

  if (input.rrule !== undefined) {
    if (input.rrule === null || input.rrule === '') {
      updates.rrule = null;
    } else {
      const normalized = validateRRule(input.rrule, newStart);
      if (!normalized) throw new EventValidationError('RRULE non valida');
      updates.rrule = normalized;
    }
  }

  if (Object.keys(updates).length === 0) return existing;

  const rows = await sql<CalendarEvent[]>`
    UPDATE calendar_events SET ${sql(updates)}
    WHERE id = ${id}::uuid
    RETURNING ${COLUMNS}
  `;
  return rows[0] || null;
}

export async function deleteEvent(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM calendar_events WHERE id = ${id}::uuid RETURNING id`;
  return rows.length > 0;
}

/**
 * Crea un override per una singola occorrenza di un master ricorrente.
 * Usato quando l'utente vuole modificare/cancellare solo "questa occorrenza".
 */
export async function createOccurrenceOverride(opts: {
  masterEventId: string;
  originalStartIso: string;
  newStartIso?: string;
  newEndIso?: string;
  newSummary?: string;
  newDescription?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
}): Promise<CalendarEvent> {
  const master = await getEvent(opts.masterEventId);
  if (!master) throw new EventValidationError('Master event non trovato');
  if (!master.rrule) throw new EventValidationError('L\'evento non è ricorrente');

  const originalStart = new Date(opts.originalStartIso);
  const masterStart = new Date(master.start_time);
  const masterEnd = new Date(master.end_time);
  const duration = masterEnd.getTime() - masterStart.getTime();

  const newStart = opts.newStartIso ? new Date(opts.newStartIso) : originalStart;
  const newEnd = opts.newEndIso ? new Date(opts.newEndIso) : new Date(newStart.getTime() + duration);

  const rows = await sql<CalendarEvent[]>`
    INSERT INTO calendar_events ${sqlInsert({
      calendar_id: master.calendar_id,
      uid: generateEventUid(),
      summary: opts.newSummary || master.summary,
      description: opts.newDescription !== undefined ? opts.newDescription : master.description,
      location: master.location,
      url: master.url,
      start_time: newStart.toISOString(),
      end_time: newEnd.toISOString(),
      all_day: master.all_day,
      rrule: null,
      exdates: [],
      recurrence_id: originalStart.toISOString(),
      recurrence_master_id: master.id,
      source: master.source,
      source_id: master.source_id,
      status: opts.status || 'confirmed',
    })}
    RETURNING ${COLUMNS}
  `;
  return rows[0];
}

// ============================================
// Espansione ricorrenze
// ============================================

export interface ListEventsOptions {
  calendarId?: string;
  fromIso: string;
  toIso: string;
  /** Se true include anche eventi cancellati */
  includeCancelled?: boolean;
  /** Se true limita agli eventi di calendari che bloccano disponibilita/capacity */
  blockingOnly?: boolean;
}

/**
 * Carica eventi (master + singoli + override) e li espande in occorrenze concrete
 * nel range richiesto. Output ordinato per start_time.
 *
 * Strategia:
 * 1. Carica:
 *    a) master ricorrenti il cui start_time <= toIso (la fine può estendersi nel range)
 *    b) eventi singoli che si sovrappongono al range
 *    c) override (recurrence_master_id != null) nel range
 * 2. Per ogni master ricorrente, espandi RRULE nel range escludendo:
 *    - exdates
 *    - timestamps degli override (l'override sostituisce l'occorrenza)
 * 3. Aggiungi gli override come occorrenze separate
 * 4. Aggiungi gli eventi singoli
 */
export async function listOccurrences(opts: ListEventsOptions): Promise<CalendarEventOccurrence[]> {
  const calendarFilter = opts.calendarId ? sql`AND calendar_id = ${opts.calendarId}::uuid` : sql``;
  const statusFilter = opts.includeCancelled
    ? sql``
    : sql`AND status != 'cancelled'`;
  const blockingFilter = opts.blockingOnly
    ? sql`AND EXISTS (
        SELECT 1 FROM calendars c
        WHERE c.id = calendar_events.calendar_id
          AND c.blocks_availability = true
      )`
    : sql``;

  // Carica eventi master+single che possono interessare il range
  // (i master ricorrenti possono iniziare prima del range e generare occorrenze dentro)
  const events = await sql<CalendarEvent[]>`
    SELECT ${COLUMNS} FROM calendar_events
    WHERE 1=1 ${calendarFilter} ${statusFilter} ${blockingFilter}
      AND (
        recurrence_master_id IS NOT NULL
        OR rrule IS NOT NULL
        OR (start_time < ${opts.toIso}::timestamptz AND end_time > ${opts.fromIso}::timestamptz)
      )
  `;

  const overrides = events.filter((e) => e.recurrence_master_id !== null);
  const singletons = events.filter((e) => !e.recurrence_master_id && !e.rrule);
  const masters = events.filter((e) => !e.recurrence_master_id && e.rrule);

  // Mappa override per (master_id, recurrence_id).
  // recurrence_id è timestamptz → il driver `postgres` lo restituisce come Date:
  // va normalizzato a ISO canonico, altrimenti la chiave non combacia mai con
  // overrideKey (basato su startIso ISO) e l'override non sostituisce mai
  // l'occorrenza del master (cancellazione/modifica di una singola occorrenza
  // ignorate → il giorno eliminato ricompare e quello modificato si duplica).
  const overrideMap = new Map<string, CalendarEvent>();
  for (const ov of overrides) {
    if (ov.recurrence_master_id && ov.recurrence_id) {
      overrideMap.set(occurrenceKey(ov.recurrence_master_id, ov.recurrence_id), ov);
    }
  }

  const occurrences: CalendarEventOccurrence[] = [];

  // 1. Singoli che cadono nel range
  for (const ev of singletons) {
    if (new Date(ev.start_time) < new Date(opts.toIso) && new Date(ev.end_time) > new Date(opts.fromIso)) {
      occurrences.push(toOccurrence(ev, null, false));
    }
  }

  // 2. Espandi master
  for (const master of masters) {
    if (!master.rrule) continue;
    const masterDuration = new Date(master.end_time).getTime() - new Date(master.start_time).getTime();
    const occStarts = expandRRule({
      rrule: master.rrule,
      masterStartIso: master.start_time,
      fromIso: opts.fromIso,
      toIso: opts.toIso,
      exdates: master.exdates || [],
    });
    for (const startIso of occStarts) {
      const overrideKey = occurrenceKey(master.id, startIso);
      const override = overrideMap.get(overrideKey);
      if (override) {
        // L'override sostituisce questa occorrenza — la includeremo nel passo 3
        continue;
      }
      occurrences.push({
        ...toOccurrence(master, startIso, false),
        start_time: startIso,
        end_time: new Date(new Date(startIso).getTime() + masterDuration).toISOString(),
        original_start: startIso,
      });
    }
  }

  // 3. Aggiungi override (sono già "occorrenze concrete" nel range)
  for (const ov of overrides) {
    if (new Date(ov.start_time) < new Date(opts.toIso) && new Date(ov.end_time) > new Date(opts.fromIso)) {
      occurrences.push(toOccurrence(ov, ov.recurrence_id, true));
    }
  }

  occurrences.sort((a, b) => a.start_time.localeCompare(b.start_time));
  return occurrences;
}

/**
 * Il driver `postgres` restituisce le colonne timestamptz come oggetti `Date`,
 * ma il tipo CalendarEventOccurrence (e il ramo di espansione dei master in
 * listOccurrences) usano ISO string. Senza questa normalizzazione gli eventi
 * singoli/override mantengono `Date` e il sort string-based a fine
 * listOccurrences (a.start_time.localeCompare) lancia "localeCompare is not a
 * function" — rompendo sia GET /events (calendario admin) sia il calcolo slot.
 */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Chiave canonica per abbinare un override alla sua occorrenza nel master.
 * Normalizza il timestamp (Date dal driver o stringa ISO da expandRRule) a una
 * forma ISO canonica, così i due lati del confronto combaciano sempre.
 */
function occurrenceKey(masterId: string, start: string | Date): string {
  const d = start instanceof Date ? start : new Date(start);
  const iso = isNaN(d.getTime()) ? String(start) : d.toISOString();
  return `${masterId}|${iso}`;
}

function toOccurrence(
  event: CalendarEvent,
  originalStart: string | null,
  isOverride: boolean,
): CalendarEventOccurrence {
  const { rrule: _r, exdates: _e, recurrence_master_id: _m, ...rest } = event;
  void _r; void _e; void _m;
  return {
    ...rest,
    start_time: toIsoString(event.start_time),
    end_time: toIsoString(event.end_time),
    original_start: originalStart,
    is_override: isOverride,
  };
}

// ============================================
// Helper: query "what's busy" — usato da slot calculator
// ============================================

export interface BusyRange {
  start: string;
  end: string;
}

export async function getBusyRanges(fromIso: string, toIso: string): Promise<BusyRange[]> {
  const occ = await listOccurrences({ fromIso, toIso, blockingOnly: true });
  return occ
    .filter((o) => o.status === 'confirmed' && !o.all_day) // all-day non blocca slot di booking
    .map((o) => ({ start: o.start_time, end: o.end_time }));
}

// ============================================
// CalDAV: una risorsa = un UID (master + override). NON espande le ricorrenze:
// il client CalDAV espande la RRULE da solo.
// ============================================

/**
 * Righe "risorsa" di un calendario per CalDAV: master ricorrenti + eventi
 * singoli (NO override, che vengono inglobati nella risorsa del master).
 * Esclude i cancellati (la loro href sparisce → il client li tratta come rimossi).
 */
export async function listEventsForCollection(calendarId: string): Promise<CalendarEvent[]> {
  return await sql<CalendarEvent[]>`
    SELECT ${COLUMNS} FROM calendar_events
    WHERE calendar_id = ${calendarId}::uuid
      AND recurrence_master_id IS NULL
      AND status != 'cancelled'
    ORDER BY start_time
  `;
}

/** Override (occorrenze materializzate) di un master ricorrente. */
export async function getEventOverrides(masterId: string): Promise<CalendarEvent[]> {
  return await sql<CalendarEvent[]>`
    SELECT ${COLUMNS} FROM calendar_events
    WHERE recurrence_master_id = ${masterId}::uuid
    ORDER BY recurrence_id
  `;
}

/**
 * ETag CalDAV per una risorsa: hash di uid|updated_at|status. updated_at è
 * mantenuto dal trigger, quindi ogni modifica cambia l'ETag (serve a If-Match).
 */
export function caldavEtag(event: { uid: string; updated_at: string | Date; status: string }): string {
  const updated = event.updated_at instanceof Date ? event.updated_at.toISOString() : event.updated_at;
  const h = createHash('sha256').update(`${event.uid}|${updated}|${event.status}`).digest('hex').slice(0, 32);
  return `"${h}"`;
}
