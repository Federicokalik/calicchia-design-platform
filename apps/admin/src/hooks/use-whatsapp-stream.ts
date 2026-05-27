import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE, refreshAdminSession } from '@/lib/api';

/**
 * Subscribes to /api/whatsapp-admin/stream (SSE) and invalidates TanStack
 * Query keys when relevant events arrive. The page can then drop its 5s
 * `refetchInterval` and rely on push instead.
 *
 * Behaviour:
 *  - On the first SSE event we mark `connected = true`. The page reads this
 *    to decide whether to enable interval polling as a backstop.
 *  - If no event arrives within SSE_GRACE_MS we assume a proxy is buffering
 *    or stripping SSE and stay in `connecting` indefinitely. The page's
 *    fallback polling kicks in either way (it only runs while connected is
 *    false), so this hook never has to actively reach for an XHR fallback.
 *  - All events trigger broad invalidation of `wa-conversations` and
 *    `wa-messages`. We don't try to surgically apply diffs because the
 *    server-side query already returns enriched joins (customer_name,
 *    company_name, ...) that we don't want to maintain client-side.
 *
 * Also exposes a `liveBlip` boolean that flashes for ~600ms on every event,
 * useful for "live" status dots in the UI.
 *
 * Notify callback fires once per inbound message:inserted event. Pages use
 * it to play a sound / show a browser notification.
 */

const SSE_GRACE_MS = 5000;

export interface WaStreamHookOptions {
  /**
   * Called for every inbound `message:inserted` event (i.e. a contact wrote
   * to us). Receives the conversation id. Use it to fire notifications.
   */
  onInbound?: (conversationId: string) => void;
  /**
   * Called whenever a `chat:typing` event arrives. Useful for surfacing
   * "sta scrivendo…" in the thread header. The page is responsible for
   * clearing stale typing states (typically after a 5s timeout).
   */
  onTyping?: (conversationId: string, state: 'composing' | 'recording' | 'paused') => void;
}

export function useWhatsAppStream(options: WaStreamHookOptions = {}) {
  const { onInbound, onTyping } = options;
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [liveBlip, setLiveBlip] = useState(false);

  // Keep callbacks in refs so the EventSource doesn't restart whenever the
  // parent component re-renders with a fresh callback identity.
  const onInboundRef = useRef(onInbound);
  useEffect(() => { onInboundRef.current = onInbound; }, [onInbound]);
  const onTypingRef = useRef(onTyping);
  useEffect(() => { onTypingRef.current = onTyping; }, [onTyping]);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    // Audit D-006: only refresh the session once per mount so a permanently
    // expired cookie doesn't loop.
    let didRefresh = false;

    const blip = () => {
      setLiveBlip(true);
      setTimeout(() => setLiveBlip(false), 600);
    };

    const invalidateConvs = () => qc.invalidateQueries({ queryKey: ['wa-conversations'] });
    const invalidateMsgs = (convId?: string) => {
      if (convId) qc.invalidateQueries({ queryKey: ['wa-messages', convId] });
      else qc.invalidateQueries({ queryKey: ['wa-messages'] });
    };

    const connect = () => {
      if (cancelled) return;
    try {
      es = new EventSource(`${API_BASE}/api/whatsapp-admin/stream`, { withCredentials: true });

      graceTimer = setTimeout(() => {
        // No SSE traffic in time → we leave connected=false so the page
        // continues to poll. Don't close the EventSource here; if the
        // server is just slow to send the first event, we can still
        // promote to connected later.
        if (!cancelled && !connected) {
          // intentionally noop — page polling handles it
        }
      }, SSE_GRACE_MS);

      const markLive = () => {
        if (cancelled) return;
        setConnected(true);
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      };

      es.addEventListener('ready', () => { markLive(); });

      es.addEventListener('message:inserted', (e) => {
        if (cancelled) return;
        markLive();
        blip();
        try {
          const evt = JSON.parse((e as MessageEvent).data) as {
            conversationId: string;
            direction: 'inbound' | 'outbound';
          };
          invalidateConvs();
          invalidateMsgs(evt.conversationId);
          if (evt.direction === 'inbound') onInboundRef.current?.(evt.conversationId);
        } catch { /* ignore */ }
      });

      es.addEventListener('message:ack', (e) => {
        if (cancelled) return;
        markLive();
        // ack doesn't include conversationId so we invalidate the whole
        // wa-messages prefix; thread query keys include the conv id.
        try {
          const _ = (e as MessageEvent).data; // touch to avoid lint
          void _;
        } catch { /* ignore */ }
        invalidateMsgs();
      });

      es.addEventListener('message:reaction', (e) => {
        if (cancelled) return;
        markLive();
        try {
          const evt = JSON.parse((e as MessageEvent).data) as { conversationId: string };
          invalidateMsgs(evt.conversationId);
        } catch {
          invalidateMsgs();
        }
      });

      es.addEventListener('chat:typing', (e) => {
        if (cancelled) return;
        markLive();
        try {
          const evt = JSON.parse((e as MessageEvent).data) as {
            conversationId: string;
            state: 'composing' | 'recording' | 'paused';
          };
          onTypingRef.current?.(evt.conversationId, evt.state);
        } catch { /* ignore */ }
      });

      es.addEventListener('conversation:updated', (e) => {
        if (cancelled) return;
        markLive();
        try {
          const evt = JSON.parse((e as MessageEvent).data) as { conversationId: string; reason: string };
          invalidateConvs();
          // 'message' is the only reason that also affects the open thread;
          // others are list-only mutations.
          if (evt.reason === 'message') invalidateMsgs(evt.conversationId);
        } catch {
          invalidateConvs();
        }
      });

      es.onerror = () => {
        if (cancelled) return;
        setConnected(false);
        es?.close();
        es = null;
        // Audit D-006: try a session refresh ONCE before giving up — the
        // EventSource API swallows the HTTP status so 401 looks like any
        // other socket drop. If the refresh succeeds we re-open the stream.
        if (!didRefresh) {
          didRefresh = true;
          refreshAdminSession()
            .then((ok) => { if (ok && !cancelled) connect(); })
            .catch(() => { /* stay disconnected; page polling handles UX */ });
        }
      };
    } catch {
      setConnected(false);
    }
    };

    connect();

    return () => {
      cancelled = true;
      if (graceTimer) clearTimeout(graceTimer);
      es?.close();
    };
    // qc is stable; intentionally omit `connected` from deps to avoid restart loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);

  return { connected, liveBlip };
}
