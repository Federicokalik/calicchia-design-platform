'use client';

/**
 * InternalAnalytics — Cookieless pageview tracker for our self-hosted analytics.
 *
 * RIGOROUSLY COOKIELESS at the transport layer:
 *  - No reads or writes of any browser-side persistent or session storage.
 *  - sendBeacon with credentials omitted — no cookies travel with the request.
 *  - Pure in-memory dedupe via module-scoped variable.
 *  - No fingerprinting (no canvas, no audio, no font enumeration).
 *
 * AUDIT A-022 — consent-gated despite being cookieless:
 *  Even without browser storage, the server side HMAC-derives a per-day
 *  session_id from IP+UA. EDPB Guidelines 2/2023 and the Garante 2025
 *  guidance classify any persistent pseudonymous identifier as requiring
 *  consent, regardless of where it lives. So we gate the entire pipeline
 *  behind hasConsent('analytics') and listen to cookie-consent-changed so
 *  a user who accepts mid-session starts being tracked from that point.
 *
 * If you change this file, run the cookieless verify script.
 */

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { hasConsent, installCookieConsentGlobals } from '@/lib/cookie-consent';

const TRACK_URL = (() => {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  return `${base.replace(/\/$/, '')}/api/track`;
})();

// In-memory dedupe — survives within the same JS context (page load + SPA navs)
// but NOT across hard reloads. Zero storage on the browser.
let lastTrackedPath: string | null = null;

function sanitizeReferrer(): string | null {
  try {
    const r = document.referrer;
    if (!r) return null;
    const u = new URL(r);
    if (u.host === window.location.host) return null; // own-site nav, not a referrer
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function extractUtm(params: URLSearchParams) {
  const utm = {
    source: params.get('utm_source'),
    medium: params.get('utm_medium'),
    campaign: params.get('utm_campaign'),
    term: params.get('utm_term'),
    content: params.get('utm_content'),
  };
  const hasAny = Object.values(utm).some((v) => v !== null);
  return hasAny ? utm : undefined;
}

function send(payload: Record<string, unknown>): void {
  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      // text/plain → simple cross-origin POST, no CORS preflight. sendBeacon non
      // puo` omettere credentials per spec; con application/json scattava
      // preflight + ACAC check, e /api/track strippa Access-Control-Allow-
      // Credentials per invariante cookieless (apps/api/src/app.ts:165). L'api
      // accetta text/plain in analytics-track.ts:62.
      const blob = new Blob([body], { type: 'text/plain' });
      navigator.sendBeacon(TRACK_URL, blob);
      return;
    }
    // Fallback: fetch with credentials explicitly omitted (no cookies sent).
    fetch(TRACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'omit',
      keepalive: true,
    }).catch(() => { /* never throw to the page */ });
  } catch {
    /* never throw to the page */
  }
}

export function InternalAnalytics() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [analyticsAllowed, setAnalyticsAllowed] = useState(false);

  // Subscribe to consent changes. Initial read happens in the same effect
  // because hasConsent() touches document.cookie and must run client-side.
  useEffect(() => {
    installCookieConsentGlobals();
    setAnalyticsAllowed(hasConsent('analytics'));
    const onConsentChanged = () => setAnalyticsAllowed(hasConsent('analytics'));
    window.addEventListener('cookie-consent-changed', onConsentChanged);
    return () => window.removeEventListener('cookie-consent-changed', onConsentChanged);
  }, []);

  useEffect(() => {
    if (!analyticsAllowed) return;
    if (!pathname) return;
    const fullPath = searchParams?.toString()
      ? `${pathname}?${searchParams.toString()}`
      : pathname;

    if (lastTrackedPath === fullPath) return;
    lastTrackedPath = fullPath;

    send({
      type: 'pageview',
      page: pathname,
      referrer: sanitizeReferrer(),
      utm: extractUtm(searchParams ?? new URLSearchParams()),
    });
  }, [analyticsAllowed, pathname, searchParams]);

  return null;
}
