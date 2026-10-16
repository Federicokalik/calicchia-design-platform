/**
 * Eventi personalizzati verso l'analytics interno (`/api/track`).
 *
 * Stesse regole di `components/analytics/InternalAnalytics.tsx`: niente
 * storage nel browser, niente cookie nella richiesta (sendBeacon text/plain
 * o fetch con credentials omessi) e invio solo con il consenso analytics.
 * Nei metadata vanno valori enumerabili (slug, formato, esito), mai testo
 * libero scritto dal visitatore.
 */

import { hasConsent } from '@/lib/cookie-consent';

const TRACK_URL = (() => {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  return `${base.replace(/\/$/, '')}/api/track`;
})();

export type TrackMetadata = Record<string, string | number | boolean | null>;

export function trackEvent(eventName: string, metadata?: TrackMetadata): void {
  if (typeof window === 'undefined') return;
  if (!hasConsent('analytics')) return;
  try {
    const body = JSON.stringify({
      type: 'event',
      event_name: eventName,
      page: window.location.pathname,
      ...(metadata ? { metadata } : {}),
    });
    if (navigator.sendBeacon) {
      // text/plain: POST cross-origin semplice, senza preflight (vedi InternalAnalytics).
      navigator.sendBeacon(TRACK_URL, new Blob([body], { type: 'text/plain' }));
      return;
    }
    fetch(TRACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'omit',
      keepalive: true,
    }).catch(() => {
      /* mai errori verso la pagina */
    });
  } catch {
    /* mai errori verso la pagina */
  }
}
