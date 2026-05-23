'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getConsent,
  hasConsent,
  installCookieConsentGlobals,
  setConsent,
} from '@/lib/cookie-consent';

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
 * Marketing-consent gated: the loader is mounted only when the user has
 * accepted the `marketing` cookie category — Trustindex sets its own
 * third-party cookies and contacts cdn.trustindex.io. Same pattern used by
 * FooterMap.tsx.
 *
 * Same widget id as the legacy site so reviews stay in sync.
 */
export function TrustIndexEmbed({ locale = 'it' }: TrustIndexEmbedProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [canLoad, setCanLoad] = useState(false);

  useEffect(() => {
    installCookieConsentGlobals();
    setCanLoad(hasConsent('marketing'));

    const onConsentChanged = () => {
      setCanLoad(hasConsent('marketing'));
    };

    window.addEventListener('cookie-consent-changed', onConsentChanged);
    return () => window.removeEventListener('cookie-consent-changed', onConsentChanged);
  }, []);

  useEffect(() => {
    if (!canLoad) return;
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
  }, [canLoad]);

  const acceptMarketing = () => {
    const current = getConsent()?.preferences;
    setConsent({
      analytics: current?.analytics ?? false,
      marketing: true,
    });
  };

  if (!canLoad) {
    const isEn = locale.toLowerCase().startsWith('en');
    return (
      <div
        className="flex w-full flex-col justify-between"
        style={{ minHeight: 320 }}
        aria-label={
          isEn
            ? 'Google Reviews blocked: third-party cookies required'
            : 'Recensioni Google bloccate: richiede cookie di terze parti'
        }
      >
        <div>
          <p
            className="font-mono text-[10px] uppercase tracking-[0.24em] mb-3"
            style={{ color: 'var(--color-ink-subtle)' }}
          >
            {isEn ? 'Google reviews blocked' : 'Recensioni Google bloccate'}
          </p>
          <p
            className="text-sm leading-relaxed"
            style={{ color: 'var(--color-ink-muted)', maxWidth: '36ch' }}
          >
            {isEn
              ? 'Trustindex sets third-party cookies and contacts cdn.trustindex.io. Accept marketing cookies to load the widget.'
              : 'Trustindex usa cookie di terze parti e contatta cdn.trustindex.io. Accetta i cookie marketing per caricare il widget.'}
          </p>
        </div>
        <button
          type="button"
          onClick={acceptMarketing}
          className="mt-8 inline-flex min-h-[44px] items-center justify-center gap-3 self-start border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-ink)]"
          style={{ borderColor: 'var(--color-line-strong)', color: 'var(--color-ink)' }}
        >
          {isEn ? 'Accept marketing cookies' : 'Accetta cookie marketing'}
          <span aria-hidden>→</span>
        </button>
      </div>
    );
  }

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
