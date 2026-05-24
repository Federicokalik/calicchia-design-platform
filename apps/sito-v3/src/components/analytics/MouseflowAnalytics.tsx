'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { hasConsent, installCookieConsentGlobals } from '@/lib/cookie-consent';
import { useRuntimeConfig } from '@/lib/runtime-config';

const MOUSEFLOW_SCRIPT_ID = 'mouseflow-script';

function loadMouseflow(projectId: string) {
  if (!projectId) return;
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
  script.src = `//cdn.mouseflow.com/projects/${projectId}.js`;
  document.head.appendChild(script);
}

export function MouseflowAnalytics() {
  const pathname = usePathname();
  const lastPathRef = useRef<string | null>(null);
  const { config, ready } = useRuntimeConfig();
  const projectId = config.mouseflowId;

  useEffect(() => {
    if (!ready) return;
    if (!projectId) return;
    installCookieConsentGlobals();
    loadMouseflow(projectId);

    const onConsentChanged = () => {
      loadMouseflow(projectId);
    };

    window.addEventListener('cookie-consent-changed', onConsentChanged);
    return () => {
      window.removeEventListener('cookie-consent-changed', onConsentChanged);
      window.mouseflow?.stop?.();
    };
  }, [ready, projectId]);

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
