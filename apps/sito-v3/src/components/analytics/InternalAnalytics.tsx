'use client';

/**
 * InternalAnalytics — Cookieless pageview tracker for our self-hosted analytics.
 *
 * RIGOROUSLY COOKIELESS:
 *  - No reads or writes of any browser-side persistent or session storage.
 *  - sendBeacon with credentials omitted — no cookies travel with the request.
 *  - Pure in-memory dedupe via module-scoped variable.
 *  - No fingerprinting (no canvas, no audio, no font enumeration).
 *
 * If you change this file, run the cookieless verify script.
 */

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

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
      const blob = new Blob([body], { type: 'application/json' });
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

  useEffect(() => {
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
  }, [pathname, searchParams]);

  return null;
}
