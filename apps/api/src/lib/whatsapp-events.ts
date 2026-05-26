/**
 * In-process event bus for the WhatsApp inbox.
 *
 * Why in-process: the API is a single Node container today (see CLAUDE.md
 * §architecture invariant 1 & 6). When multi-instance becomes a constraint
 * this swaps to Redis pub/sub without changing the publisher/subscriber
 * shape — keep the surface area small.
 *
 * Why not just write to the DB and have clients re-poll: SSE makes the
 * inbox feel instant (sub-second) and removes the 5-second TanStack
 * refetch cycle from the hot path. The polling fallback in
 * `apps/admin/src/hooks/use-whatsapp-stream.ts` covers proxies that strip
 * SSE.
 *
 * Subscribers should be cheap — no DB work in the callback. The handler
 * just dispatches an invalidation hint to the connected SSE clients.
 */

import { EventEmitter } from 'node:events';

export interface WaMessageInsertedEvent {
  type: 'message:inserted';
  conversationId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  externalId: string | null;
  /** True if this message bumped the conversation's unread counter. */
  unread: boolean;
}

export interface WaMessageAckEvent {
  type: 'message:ack';
  externalId: string;
  status: 'sent' | 'delivered' | 'read';
}

export interface WaReactionEvent {
  type: 'message:reaction';
  conversationId: string;
  /** External id of the message the reaction targets. */
  targetExternalId: string | null;
  emoji: string;
  from: string | null;
}

export interface WaConversationUpdatedEvent {
  type: 'conversation:updated';
  conversationId: string;
  /** Why the row changed — UI uses it for lighter invalidations. */
  reason:
    | 'read'
    | 'archive'
    | 'unread'
    | 'delete'
    | 'link'
    | 'ai-mode'
    | 'message';
}

/**
 * The contact (or one of the participants in a group) is composing /
 * recording / paused. We forward this from `chat_presence` webhooks so the
 * UI can show "sta scrivendo…" under the thread header. The event has no
 * persistent storage — it's purely transient.
 */
export interface WaTypingEvent {
  type: 'chat:typing';
  conversationId: string;
  /** Phone-only chat or group; both can typing. */
  chatId: string;
  /** Specific participant in group chats. Null for 1-to-1. */
  fromJid: string | null;
  state: 'composing' | 'recording' | 'paused';
}

export type WaEvent =
  | WaMessageInsertedEvent
  | WaMessageAckEvent
  | WaReactionEvent
  | WaConversationUpdatedEvent
  | WaTypingEvent;

const emitter = new EventEmitter();
// SSE clients can stack up; bump the cap so attaching from many admin tabs
// doesn't spam Node with "MaxListenersExceeded" warnings.
emitter.setMaxListeners(64);

const CHANNEL = 'wa';

export function publishWaEvent(evt: WaEvent): void {
  emitter.emit(CHANNEL, evt);
}

export function subscribeWaEvents(listener: (evt: WaEvent) => void): () => void {
  emitter.on(CHANNEL, listener);
  return () => emitter.off(CHANNEL, listener);
}
