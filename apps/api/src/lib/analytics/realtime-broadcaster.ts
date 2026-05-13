/**
 * realtime-broadcaster.ts — In-memory pub/sub for SSE fan-out.
 *
 * Each /api/analytics/track call publishes a minimal event to all subscribed
 * SSE clients. Single-process only; multi-process deployments would need
 * Postgres LISTEN/NOTIFY (out of scope for v1).
 *
 * No cookies, no storage. Subscribers are referenced by callback only.
 */

export type LiveEvent = {
  type: 'pageview' | 'event' | 'web_vital' | 'outbound';
  page: string | null;
  event_name?: string | null;
  country?: string | null;
  at: string; // ISO timestamp
};

type Subscriber = (event: LiveEvent) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function publish(event: LiveEvent): void {
  for (const cb of subscribers) {
    try {
      cb(event);
    } catch {
      // Never let a misbehaving subscriber crash the broadcaster.
    }
  }
}

export function subscriberCount(): number {
  return subscribers.size;
}
