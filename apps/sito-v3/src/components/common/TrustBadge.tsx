'use client';

import { useEffect, useRef } from 'react';

const BADGE_WIDGET_ID = 'b6d27ea71e820416e706c5df027';
const LOADER_SRC = `https://cdn.trustindex.io/loader.js?${BADGE_WIDGET_ID}`;

declare global {
  interface Window {
    tiElementToWaitForActivity?: HTMLElement[];
    TrustindexWidget?: new (a: unknown, el: HTMLElement) => unknown;
  }
}

interface TrustBadgeProps {
  /** Optional className applied to the wrapper (alignment, margin). */
  className?: string;
  /**
   * When the loader is already mounted by a parent widget, skip appending
   * another placement script and just drain the Trustindex activation queue.
   */
  reuseExistingLoader?: boolean;
  /**
   * BCP-47 / Trustindex locale code (`it`, `en`, ...). Passed as `data-language`
   * on the wrapper so Trustindex localizes the widget UI ("5.0 · See reviews").
   * Note: review TEXT comes from Google Business Profile and is NOT auto-translated.
   */
  locale?: string;
}

/**
 * Small Google-Reviews badge ("5.0 · Freelance più votato") rendered by
 * TrustIndex. Loads the loader script with `defer async` (mirrors the
 * snippet we use externally) and applies the same Lenis-aware queue drain
 * as `TrustIndexEmbed` — without it, `data-delay-load="1"` widgets never
 * activate because Lenis intercepts native scroll/resize on window.
 *
 * Mounted on the dark footer of the site, so the wrapper drops the inline
 * dark background that used to compensate cream pages — l'hack CSS globale
 * è stato rimosso insieme.
 */
export function TrustBadge({
  className = '',
  reuseExistingLoader = false,
  locale = 'it',
}: TrustBadgeProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const alreadyMountedHere = !!container.querySelector(
      'script[data-trustindex-badge-loader]'
    );

    if (!alreadyMountedHere && !reuseExistingLoader) {
      const script = document.createElement('script');
      script.src = LOADER_SRC;
      script.defer = true;
      script.async = true;
      script.dataset.trustindexBadgeLoader = '';
      container.appendChild(script);
    }

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
  }, [reuseExistingLoader]);

  return (
    <div
      ref={containerRef}
      data-trustindex-badge
      data-language={locale}
      className={className}
      // Shrink-fit alla width naturale del widget Trustindex. Su sfondo dark
      // del footer non serve forzare un background o nascondere i residui:
      // il widget si fonde col contesto.
      style={{
        display: 'inline-block',
        width: 'fit-content',
        maxWidth: 360,
        lineHeight: 0,
      }}
      aria-label="Badge recensioni Google verificate da Trustindex"
    />
  );
}
