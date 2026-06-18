'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { hasConsent, installCookieConsentGlobals } from '@/lib/cookie-consent';

const PIXEL_ID = '1526850581624086';
const PIXEL_SCRIPT_ID = 'meta-pixel-script';

/**
 * Meta (Facebook) Pixel — marketing-consent gated.
 *
 * Like Mouseflow/TrustIndex, the third-party script (connect.facebook.net) is
 * NOT loaded until the user accepts the `marketing` category, so no data
 * reaches Meta before consent (Garante 2021 §6, EDPB Taskforce 2023). On SPA
 * navigation we fire an additional `PageView`. Disclosed as a vendor in
 * data/cookie-vendors.ts (`meta-pixel`).
 */
function ensureFbq() {
  if (window.fbq) return;
  const fbq: FbqFn = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue?.push(args);
  };
  fbq.queue = [];
  fbq.loaded = true;
  fbq.version = '2.0';
  fbq.push = fbq;
  window.fbq = fbq;
  if (!window._fbq) window._fbq = fbq;
}

function loadPixel() {
  if (!hasConsent('marketing')) {
    // Consent withdrawn (or never given): tell Meta to stop if already loaded.
    window.fbq?.('consent', 'revoke');
    return;
  }

  ensureFbq();

  if (!document.getElementById(PIXEL_SCRIPT_ID)) {
    const script = document.createElement('script');
    script.id = PIXEL_SCRIPT_ID;
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);
    window.fbq?.('init', PIXEL_ID);
  }

  window.fbq?.('consent', 'grant');
  window.fbq?.('track', 'PageView');
}

export function MetaPixel() {
  const pathname = usePathname();
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    installCookieConsentGlobals();
    loadPixel();

    const onConsentChanged = () => loadPixel();
    window.addEventListener('cookie-consent-changed', onConsentChanged);
    return () => window.removeEventListener('cookie-consent-changed', onConsentChanged);
  }, []);

  useEffect(() => {
    if (!pathname) return;

    const pagePath = `${pathname}${window.location.search}`;
    // Skip the first run: the mount effect already fired the initial PageView.
    if (lastPathRef.current === null) {
      lastPathRef.current = pagePath;
      return;
    }
    if (lastPathRef.current === pagePath) return;
    lastPathRef.current = pagePath;

    if (hasConsent('marketing')) {
      window.fbq?.('track', 'PageView');
    }
  }, [pathname]);

  return null;
}
