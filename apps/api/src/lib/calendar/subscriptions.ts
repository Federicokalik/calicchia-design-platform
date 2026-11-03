/**
 * Facade delle iscrizioni ICS: stesse esportazioni e firme di prima della
 * fase F2 (CRUD e sync), delegate allo store selezionato dal modo del backend
 * (store.ts; design §12 "Facade").
 *
 * In mode postgres lo store è PgLegacyStore, cioè il codice di prima spostato
 * in legacy/subscriptions-pg.ts: il pull legacy verso calendar_events resta
 * invariato, compreso il sottoinsieme bacato di parseIcs (parità prima del
 * cutover, design §6.6). Il pull verso l'indice (subscriptions/pull.ts) è un
 * percorso separato e non passa da qui.
 */

import type { ParsedEvent } from './ics-import';
import { calendarStore, calendarStoreForWrite } from './store';
import type {
  CalendarSubscription,
  CreateSubscriptionInput,
  SyncResult,
  UpdateSubscriptionInput,
} from './types';

export { SubscriptionValidationError } from './errors';
export type { CalendarSubscription, CreateSubscriptionInput, SyncResult, UpdateSubscriptionInput } from './types';

// ============================================
// CRUD
// ============================================

export async function listSubscriptions(): Promise<CalendarSubscription[]> {
  return (await calendarStore()).listSubscriptions();
}

export async function getSubscription(id: string): Promise<CalendarSubscription | null> {
  return (await calendarStore()).getSubscription(id);
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<CalendarSubscription> {
  return (await calendarStoreForWrite()).createSubscription(input);
}

export async function updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<CalendarSubscription | null> {
  return (await calendarStoreForWrite()).updateSubscription(id, input);
}

export async function deleteSubscription(id: string): Promise<boolean> {
  return (await calendarStoreForWrite()).deleteSubscription(id);
}

// ============================================
// Sync
// ============================================

/**
 * Sync di una singola iscrizione. `force` ignora la cache ETag/Last-Modified e
 * accetta un feed legittimamente vuoto (solo sync manuale dell'admin).
 */
export async function syncSubscription(id: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
  return (await calendarStoreForWrite()).syncSubscription(id, opts);
}

/**
 * Sostituzione atomica degli eventi di un'iscrizione (anti-wipe: un feed a 0
 * eventi con eventi locali presenti annulla, salvo `allowEmpty`). Esportata
 * per i test e le fixture.
 */
export async function replaceSubscriptionEvents(
  subscriptionId: string,
  calendarId: string,
  parsed: ParsedEvent[],
  opts: { allowEmpty?: boolean } = {},
): Promise<{ inserted: number; removed: number }> {
  return (await calendarStoreForWrite()).replaceSubscriptionEvents(subscriptionId, calendarId, parsed, opts);
}

/** Sync di tutte le iscrizioni abilitate. Chiamato dal cron job. */
export async function syncAllSubscriptions(): Promise<{ total: number; ok: number; failed: number; notModified: number }> {
  return (await calendarStoreForWrite()).syncAllSubscriptions();
}
