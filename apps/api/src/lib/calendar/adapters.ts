/**
 * Adattatori indice → DTO legacy (fase F2 del passaggio a Radicale; design
 * §12 "Adattatori", §5 "All-day"; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §6.3).
 *
 * Producono esattamente le chiavi dei DTO di oggi (`types.ts`: CalendarEvent,
 * CalendarEventOccurrence, Calendar), nello stesso ordine del codice legacy,
 * a partire dalle righe dell'indice (cal_components, cal_occurrences,
 * cal_objects) e del sidecar. Convenzioni:
 *  - istanti ISO UTC (toISOString), come i DTO legacy serializzati;
 *  - all-day: mezzanotte del fuso del calendario in ISO UTC con
 *    `all_day=true` e fine esclusiva (calendar-core toLegacyEventFields, che
 *    l'indicizzatore ha già applicato a start_utc/end_utc dei componenti);
 *    gli EXDATE all-day, salvati come 'YYYY-MM-DD', tornano mezzanotte locale;
 *  - gli override espongono l'UID del master (differenza ammessa n. 1,
 *    RFC 5545) e l'id del proprio componente (cal_object_ids);
 *  - titolo assente → '(senza titolo)' (UNTITLED_SUMMARY), come la proiezione
 *    inversa e ics-import;
 *  - le occorrenze di un'iscrizione portano come calendar_id il calendario di
 *    destinazione (design §1), passato dal chiamante in `displayCalendarId`.
 *
 * Modulo puro (nessun I/O): lo usano RadicaleStore, il feed e i tool MCP.
 */

import { dateToLegacyIso, isDateString, UNTITLED_SUMMARY } from '@calicchia/calendar-core';
import type { CalComponentRow, CalObjectRow, CalOccurrenceRow } from './index-model';
import type { Booking, Calendar, CalendarEvent, CalendarEventOccurrence, CalendarEventSource } from './types';

/** Fuso di ripiego per gli all-day quando il calendario non ne ha uno valido (come il resto del dominio). */
const FALLBACK_TZ = 'Europe/Rome';

/** Timestamp (Date di postgres-js o stringa) → ISO UTC; null resta null. */
export function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Colonna date (Date a mezzanotte UTC da postgres-js, o 'YYYY-MM-DD') → 'YYYY-MM-DD'. */
export function dateColumn(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  const s = value.slice(0, 10);
  return isDateString(s) ? s : null;
}

function safeTz(timezone: string | null | undefined): string {
  if (!timezone) return FALLBACK_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return FALLBACK_TZ;
  }
}

/**
 * Elemento di cal_components.exdates/rdates → ISO legacy: gli istanti restano
 * istanti, le date all-day diventano la mezzanotte locale del calendario
 * (come toLegacyEventFields).
 */
function listValueToIso(value: unknown, tz: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (isDateString(value)) return dateToLegacyIso(value, tz);
  return isoOrNull(value);
}

function summaryOf(summary: string | null | undefined): string {
  return summary != null && summary.trim() !== '' ? summary : UNTITLED_SUMMARY;
}

function textOrNull(value: string | null | undefined): string | null {
  return value == null || value === '' ? null : value;
}

/** Inizio/fine legacy di un componente: start_utc/end_utc (già mezzanotte locale per gli all-day). */
function componentTimes(component: Pick<CalComponentRow, 'start_utc' | 'end_utc' | 'all_day' | 'start_date' | 'end_date'>, tz: string): { start: string; end: string } {
  let start = isoOrNull(component.start_utc);
  let end = isoOrNull(component.end_utc);
  if (component.all_day) {
    const sd = dateColumn(component.start_date);
    const ed = dateColumn(component.end_date);
    if (!start && sd) start = dateToLegacyIso(sd, tz);
    if (!end && ed) end = dateToLegacyIso(ed, tz);
  }
  start ??= new Date(0).toISOString();
  end ??= start;
  return { start, end };
}

/**
 * Componente indicizzato (master, singolo o override) → CalendarEvent con le
 * chiavi e l'ordine di oggi. `ctx.masterId` è l'id della risorsa per gli
 * override (recurrence_master_id), null per master e singoli.
 * `ctx.displayCalendarId` (facoltativo) sostituisce calendar_id per le
 * iscrizioni (calendario di destinazione).
 */
export function toLegacyEvent(
  component: CalComponentRow,
  object: Pick<CalObjectRow, 'id' | 'calendar_id' | 'source' | 'source_id' | 'first_seen_at' | 'changed_at'>,
  ctx: { masterId: string | null; timezone: string; displayCalendarId?: string },
): CalendarEvent {
  const tz = safeTz(ctx.timezone);
  const times = componentTimes(component, tz);
  const isOverride = component.recurrence_key !== '';
  return {
    id: component.id,
    calendar_id: ctx.displayCalendarId ?? object.calendar_id,
    uid: component.uid ?? '',
    summary: summaryOf(component.summary),
    description: textOrNull(component.description),
    location: textOrNull(component.location),
    url: textOrNull(component.url),
    start_time: times.start,
    end_time: times.end,
    all_day: component.all_day,
    rrule: isOverride ? null : component.rrule ?? null,
    exdates: isOverride ? [] : (component.exdates ?? []).map((v) => listValueToIso(v, tz)).filter((v): v is string => v !== null),
    recurrence_id: isOverride ? isoOrNull(component.recurrence_id_utc) : null,
    recurrence_master_id: isOverride ? ctx.masterId : null,
    source: object.source as CalendarEventSource,
    source_id: object.source_id ?? null,
    status: component.status,
    created_at: isoOrNull(object.first_seen_at) ?? new Date(0).toISOString(),
    updated_at: isoOrNull(object.changed_at) ?? isoOrNull(object.first_seen_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Occorrenza indicizzata → CalendarEventOccurrence con le chiavi di oggi
 * (quelle di CalendarEvent senza rrule, exdates e recurrence_master_id, più
 * original_start e is_override):
 *  - id: quello del componente che produce l'istanza (master per le
 *    occorrenze espanse, override per le sue);
 *  - original_start: istante originale dell'istanza per le occorrenze di una
 *    serie e per gli override (RECURRENCE-ID), null per un evento singolo
 *    (come expandRecurrences di oggi);
 *  - status: quello dell'occorrenza (per gli override il loro).
 * `object` può portare first_seen_at e changed_at per created_at/updated_at.
 */
export function toLegacyOccurrence(
  occ: CalOccurrenceRow,
  component: CalComponentRow,
  object: Pick<CalObjectRow, 'source' | 'source_id'> & Partial<Pick<CalObjectRow, 'first_seen_at' | 'changed_at'>>,
  ctx: { timezone: string; displayCalendarId?: string },
): CalendarEventOccurrence {
  const tz = safeTz(ctx.timezone);
  const isOverride = occ.kind === 'override' || occ.kind === 'orphan_override' || component.recurrence_key !== '';
  let start = isoOrNull(occ.start_utc);
  let end = isoOrNull(occ.end_utc);
  if (occ.all_day) {
    const sd = dateColumn(occ.start_date);
    const ed = dateColumn(occ.end_date);
    if (sd) start = dateToLegacyIso(sd, tz);
    if (ed) end = dateToLegacyIso(ed, tz);
  }
  start ??= new Date(0).toISOString();
  end ??= start;
  const recurring = !isOverride && (Boolean(component.rrule) || (component.rdates?.length ?? 0) > 0);
  const recurrenceId = isOverride ? isoOrNull(component.recurrence_id_utc) : null;
  const created = isoOrNull(object.first_seen_at ?? null) ?? isoOrNull(component.created) ?? isoOrNull(component.dtstamp) ?? new Date(0).toISOString();
  const updated = isoOrNull(object.changed_at ?? null) ?? isoOrNull(component.last_modified) ?? created;
  return {
    id: component.id,
    calendar_id: ctx.displayCalendarId ?? occ.calendar_id,
    uid: component.uid ?? '',
    summary: summaryOf(component.summary),
    description: textOrNull(component.description),
    location: textOrNull(component.location),
    url: textOrNull(component.url),
    start_time: start,
    end_time: end,
    all_day: occ.all_day,
    recurrence_id: recurrenceId,
    source: object.source as CalendarEventSource,
    source_id: object.source_id ?? null,
    status: occ.status,
    created_at: created,
    updated_at: updated,
    original_start: isOverride ? recurrenceId ?? start : recurring ? start : null,
    is_override: isOverride,
  };
}

/** Colonne di Calendar, nell'ordine dei SELECT legacy. */
export const CALENDAR_DTO_KEYS = [
  'id', 'slug', 'name', 'description', 'color', 'icon', 'timezone',
  'is_default', 'is_system', 'blocks_availability', 'ics_feed_token', 'ics_feed_enabled',
  'sort_order', 'created_at', 'updated_at',
] as const satisfies readonly (keyof Calendar)[];

/**
 * Riga di `calendars` (anche con le colonne del sidecar) → Calendar con le
 * sole chiavi di oggi. I valori passano invariati (created_at e updated_at
 * restano Date di postgres-js come nelle risposte legacy).
 */
export function toLegacyCalendar(row: Record<string, unknown>): Calendar {
  const out: Record<string, unknown> = {};
  for (const key of CALENDAR_DTO_KEYS) out[key] = row[key] ?? null;
  out.is_default = Boolean(row.is_default);
  out.is_system = Boolean(row.is_system);
  out.blocks_availability = Boolean(row.blocks_availability);
  out.ics_feed_enabled = Boolean(row.ics_feed_enabled);
  out.sort_order = typeof row.sort_order === 'number' ? row.sort_order : Number(row.sort_order ?? 0) || 0;
  return out as unknown as Calendar;
}

/**
 * Descrizione delle proiezioni ricomposta da calendar_bookings con il
 * template attuale di booking.ts (projectBookingEvent) e le stesse
 * normalizzazioni di createEvent (trim, 5000 caratteri): MCP e admin vedono
 * lo stesso testo di oggi qualunque sia il contenuto scritto per i device
 * (decisione 3, design §12, allowed-diffs "descrizione-proiezioni-ricomposta").
 */
export function projectionDescription(
  booking: Pick<Booking, 'uid' | 'attendee_name' | 'attendee_email' | 'attendee_phone' | 'attendee_company' | 'attendee_message'>,
): string {
  const text = [
    `Cliente: ${booking.attendee_name} <${booking.attendee_email}>`,
    booking.attendee_phone ? `Tel: ${booking.attendee_phone}` : null,
    booking.attendee_company ? `Azienda: ${booking.attendee_company}` : null,
    booking.attendee_message ? `\nNote:\n${booking.attendee_message}` : null,
    `\nUID prenotazione: ${booking.uid}`,
  ].filter(Boolean).join('\n');
  return text.trim().slice(0, 5000);
}
