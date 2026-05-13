'use client';

/**
 * OutboundLinkTracker — Track clicks on external links and file downloads.
 *
 * Same cookieless invariants as InternalAnalytics.tsx.
 * Listens for document-level click events; doesn't intercept navigation.
 */

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

const TRACK_URL = (() => {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  return `${base.replace(/\/$/, '')}/api/track`;
})();

const FILE_EXTENSIONS = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt|mp3|mp4|mov|dmg|exe|apk)$/i;

function send(payload: Record<string, unknown>): void {
  try {
    const body = JSON.stringify(payload);
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

function isExternal(href: string): boolean {
  try {
    const u = new URL(href, window.location.href);
    return u.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function isFileDownload(href: string): boolean {
  try {
    const u = new URL(href, window.location.href);
    return FILE_EXTENSIONS.test(u.pathname);
  } catch {
    return false;
  }
}

export function OutboundLinkTracker() {
  const pathname = usePathname();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Walk up the DOM to find the closest anchor element.
      let el = e.target as HTMLElement | null;
      while (el && el !== document.body) {
        if (el.tagName === 'A') break;
        el = el.parentElement;
      }
      if (!el || el.tagName !== 'A') return;
      const href = (el as HTMLAnchorElement).href;
      if (!href) return;

      if (isFileDownload(href)) {
        send({
          type: 'event',
          page: pathname || '/',
          event_name: 'file_download',
          metadata: { url: href },
        });
      } else if (isExternal(href)) {
        send({
          type: 'outbound',
          page: pathname || '/',
          event_name: 'outbound_click',
          metadata: { url: href },
        });
      }
    };

    document.addEventListener('click', handler, { capture: true });
    return () => document.removeEventListener('click', handler, { capture: true });
  }, [pathname]);

  return null;
}
