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
  /** @deprecated Every badge now uses the controlled dark Trustindex-sized surface. */
  surface?: 'plain' | 'solid';
  /**
   * When the loader is already mounted by a parent widget, skip appending
   * another placement script and just drain the Trustindex activation queue.
   */
  reuseExistingLoader?: boolean;
}

/**
 * Small Google-Reviews badge ("5.0 · Freelance più votato") rendered by
 * TrustIndex. Loads the loader script with `defer async` (mirrors the
 * snippet we use externally) and applies the same Lenis-aware queue drain
 * as `TrustIndexEmbed` — without it, `data-delay-load="1"` widgets never
 * activate because Lenis intercepts native scroll/resize on window.
 *
 * Same widget id stays consistent across the whole site.
 */
export function TrustBadge({
  className = '',
  reuseExistingLoader = false,
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

  // Le regole CSS che compattano il footprint del widget (margin-bottom: -5px,
  // reset margin sui figli, transparent borders) vivono in globals.css cosi'
  // sono nell'HTML al primo paint. Tenerle in <style jsx global> faceva sparire
  // la patch sul cold load: lo styled-jsx di un client component viene iniettato
  // dopo l'idratazione, e Trustindex monta il DOM prima.
  return (
    <div
      ref={containerRef}
      data-trustindex-badge
      className={className}
      // Shrink-fit alla width naturale del widget Trustindex (no stretch
      // verso il parent). Background nero + overflow hidden sui residui.
      style={{
        display: 'inline-block',
        width: 'fit-content',
        maxWidth: 360,
        background: 'var(--color-ink)',
        overflow: 'hidden',
        lineHeight: 0,
      }}
      aria-label="Badge recensioni Google verificate da Trustindex"
    />
  );
}
