/**
 * Descrizioni delle proiezioni delle prenotazioni per admin e MCP (fase F2
 * del passaggio a Radicale; design §12 "Proiezioni", decisione 3; contratto
 * dei moduli docs/calendar-radicale/contracts/f2-modules.md §9).
 *
 * Con lo store Radicale la risorsa `booking-<uid>.ics` della collezione
 * Prenotazioni ha il contenuto della decisione 3 (titolo con il nome,
 * telefono, link all'admin: niente email, azienda né messaggio), perché è
 * quello che vedono i device. Admin e MCP devono invece continuare a vedere
 * il testo di oggi: qui la descrizione delle proiezioni (source='booking',
 * source_id = uid della prenotazione: la provenienza la decidono collezione e
 * href, mai le X-prop) si ricompone dai dati correnti di calendar_bookings con
 * il template di booking.ts (adapters.projectionDescription). È la differenza
 * ammessa "descrizione-proiezioni-ricomposta" del contratto MCP.
 *
 * Con PgLegacyStore (mode postgres) i DTO passano invariati: la riga legacy
 * della proiezione ha già la descrizione completa scritta alla prenotazione.
 * Una prenotazione che non esiste più (per esempio dopo un'erasure GDPR)
 * lascia la descrizione dell'indice.
 */

import { sql } from '../../db';
import { projectionDescription } from './adapters';
import type { Db } from './radicale/policy';
import { calendarStore } from './store';
import type { Booking } from './types';

/** DTO con i campi che servono a riconoscere una proiezione (CalendarEvent, CalendarEventOccurrence). */
export interface ProjectionCandidate {
  source: string;
  source_id: string | null;
  description: string | null;
}

type BookingTextRow = Pick<Booking, 'uid' | 'attendee_name' | 'attendee_email' | 'attendee_phone' | 'attendee_company' | 'attendee_message'>;

/** Prenotazioni lette per volta (ANY di un array: una sola query anche per molte proiezioni). */
const MAX_UIDS_PER_QUERY = 1_000;

/** true se le proiezioni vanno ricomposte: solo con lo store Radicale. */
export async function projectionDescriptionsApply(): Promise<boolean> {
  return (await calendarStore()).kind === 'radicale';
}

function isProjection(item: ProjectionCandidate): item is ProjectionCandidate & { source_id: string } {
  return item.source === 'booking' && typeof item.source_id === 'string' && item.source_id !== '';
}

/**
 * Restituisce `items` con la descrizione delle proiezioni ricomposta da
 * calendar_bookings (testa del file). Gli altri elementi, e tutti con lo
 * store legacy, restano gli stessi oggetti; quelli ricomposti sono copie con
 * le chiavi nello stesso ordine. `opts.force` salta il controllo dello store
 * (il chiamante lo ha già fatto).
 */
export async function withProjectionDescriptions<T extends ProjectionCandidate>(
  items: readonly T[],
  opts: { db?: Db; force?: boolean } = {},
): Promise<T[]> {
  const projections = items.filter(isProjection);
  if (projections.length === 0) return [...items];
  if (!opts.force && !(await projectionDescriptionsApply())) return [...items];

  const db = opts.db ?? sql;
  const uids = [...new Set(projections.map((p) => p.source_id))];
  const bookings = new Map<string, BookingTextRow>();
  for (let i = 0; i < uids.length; i += MAX_UIDS_PER_QUERY) {
    const chunk = uids.slice(i, i + MAX_UIDS_PER_QUERY);
    const rows = await db<BookingTextRow[]>`
      SELECT uid, attendee_name, attendee_email, attendee_phone, attendee_company, attendee_message
      FROM calendar_bookings
      WHERE uid = ANY(${chunk}::text[])
    `;
    for (const row of rows) bookings.set(row.uid, row);
  }
  return items.map((item) => {
    if (!isProjection(item)) return item;
    const booking = bookings.get(item.source_id);
    return booking ? { ...item, description: projectionDescription(booking) } : item;
  });
}

/** Come withProjectionDescriptions per un solo DTO (null resta null). */
export async function withProjectionDescription<T extends ProjectionCandidate>(item: T | null, opts: { db?: Db; force?: boolean } = {}): Promise<T | null> {
  if (!item) return item;
  const [out] = await withProjectionDescriptions([item], opts);
  return out ?? item;
}
