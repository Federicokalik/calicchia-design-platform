'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { hasConsent, installCookieConsentGlobals } from '@/lib/cookie-consent';

const MOUSEFLOW_PROJECT_ID = process.env.NEXT_PUBLIC_MOUSEFLOW_ID || '';
const MOUSEFLOW_SCRIPT_ID = 'mouseflow-script';

function loadMouseflow() {
  if (!MOUSEFLOW_PROJECT_ID) return;
  if (!hasConsent('analytics')) {
    window.mouseflow?.stop?.();
    return;
  }

  window._mfq = window._mfq || [];

  if (document.getElementById(MOUSEFLOW_SCRIPT_ID)) {
    window.mouseflow?.start?.();
    return;
  }

  const script = document.createElement('script');
  script.id = MOUSEFLOW_SCRIPT_ID;
  script.type = 'text/javascript';
  script.defer = true;
  script.src = `//cdn.mouseflow.com/projects/${MOUSEFLOW_PROJECT_ID}.js`;
  document.head.appendChild(script);
}

export function MouseflowAnalytics() {
  const pathname = usePathname();
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!MOUSEFLOW_PROJECT_ID) return;
    installCookieConsentGlobals();
    loadMouseflow();

    const onConsentChanged = () => {
      loadMouseflow();
    };

    window.addEventListener('cookie-consent-changed', onConsentChanged);
    return () => {
      window.removeEventListener('cookie-consent-changed', onConsentChanged);
      window.mouseflow?.stop?.();
    };
  }, []);

  useEffect(() => {
    if (!pathname) return;

    const pagePath = `${pathname}${window.location.search}`;
    if (lastPathRef.current === null) {
      lastPathRef.current = pagePath;
      return;
    }

    if (lastPathRef.current === pagePath) return;
    lastPathRef.current = pagePath;

    if (hasConsent('analytics')) {
      window._mfq?.push(['newPageView', pagePath]);
    }
  }, [pathname]);

  return null;
}
