'use client';

/**
 * WebVitalsTracker — Core Web Vitals (LCP, CLS, INP, FCP, TTFB) via the
 * web-vitals library. Reports to our cookieless /api/track endpoint.
 *
 * Same cookieless invariants as InternalAnalytics.tsx.
 */

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

const TRACK_URL = (() => {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  return `${base.replace(/\/$/, '')}/api/track`;
})();

type Metric = {
  name: string;     // 'LCP', 'CLS', 'INP', 'FCP', 'TTFB'
  value: number;
  rating: string;   // 'good' | 'needs-improvement' | 'poor'
  id: string;
};

function send(metric: Metric, page: string): void {
  try {
    const body = JSON.stringify({
      type: 'web_vital',
      page,
      event_name: metric.name,
      event_value: metric.value,
      metadata: { rating: metric.rating, id: metric.id },
    });
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(TRACK_URL, blob);
      return;
    }
    fetch(TRACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'omit',
      keepalive: true,
    }).catch(() => { /* never throw */ });
  } catch {
    /* never throw */
  }
}

export function WebVitalsTracker() {
  const pathname = usePathname();

  useEffect(() => {
    // Lazy import keeps the bundle slim on initial render.
    let cancelled = false;
    import('web-vitals')
      .then(({ onLCP, onCLS, onINP, onFCP, onTTFB }) => {
        if (cancelled) return;
        const page = pathname || '/';
        onLCP((m) => send(m as Metric, page));
        onCLS((m) => send(m as Metric, page));
        onINP((m) => send(m as Metric, page));
        onFCP((m) => send(m as Metric, page));
        onTTFB((m) => send(m as Metric, page));
      })
      .catch(() => { /* lib failed to load — skip */ });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return null;
}
