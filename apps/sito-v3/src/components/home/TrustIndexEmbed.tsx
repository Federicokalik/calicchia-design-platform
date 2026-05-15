'use client';

import { useEffect, useRef } from 'react';

const WIDGET_ID = 'f60b4ee62d499198f7563ee8095';
const LOADER_SRC = `https://cdn.trustindex.io/loader.js?${WIDGET_ID}`;

declare global {
  interface Window {
    tiElementToWaitForActivity?: HTMLElement[];
    TrustindexWidget?: new (a: unknown, el: HTMLElement) => unknown;
  }
}

interface TrustIndexEmbedProps {
  /**
   * BCP-47 / Trustindex locale code. Forwarded as `data-language` so the
   * widget localizes its UI strings (button labels, relative dates, etc.).
   * The review text itself stays in the original Google Business Profile
   * language: Trustindex does not auto-translate review bodies.
   */
  locale?: string;
}

/**
 * Embeds the TrustIndex (Google Reviews) widget on the home page.
 * Wraps the external widget script so React controls its lifecycle:
 *
 *   The loader.js queues elements with `data-delay-load="1"` into
 *   `window.tiElementToWaitForActivity`, expecting native scroll/resize
 *   events to trigger activation. With Lenis (smooth-scroll) those native
 *   events never reach window, so we drain the queue manually after load.
 *
 * Same widget id as the legacy site so reviews stay in sync.
 *
 * NOTE: this component currently auto-loads (no cookie-consent system in
 * sito-v3 yet). When the consent layer is added, gate this component behind
 * a marketing-consent check and offer a click-to-load placeholder.
 */
export function TrustIndexEmbed({ locale = 'it' }: TrustIndexEmbedProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Avoid double-load if remounted (e.g. View Transitions)
    if (container.querySelector('script[data-trustindex-loader]')) return;

    const script = document.createElement('script');
    script.src = LOADER_SRC;
    script.defer = true;
    script.async = true;
    script.dataset.trustindexLoader = '';
    container.appendChild(script);

    let processed = false;
    const drainQueue = () => {
      if (processed) return;
      const queue = window.tiElementToWaitForActivity;
      const TIWidget = window.TrustindexWidget;
      if (queue && queue.length > 0 && TIWidget) {
        processed = true;
        queue.forEach((el) => new TIWidget(null, el));
        window.tiElementToWaitForActivity = [];
      }
    };

    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts++;
      drainQueue();
      if (processed || attempts > 60) window.clearInterval(interval);
    }, 250);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <div
      ref={containerRef}
      id="trustindex-widget"
      data-trustindex
      data-language={locale}
      className="w-full"
      // Reserve a baseline height so the section doesn't reflow when the
      // widget injects its DOM. Trustindex itself paints the carousel
      // inside this container.
      style={{ minHeight: 320 }}
      aria-label="Recensioni Google verificate"
    />
  );
}
