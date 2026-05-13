'use client';

import { Suspense } from 'react';
import { usePathname } from 'next/navigation';
import { isLocale } from '@/lib/i18n';
import { GoogleAnalytics } from './GoogleAnalytics';
import { MouseflowAnalytics } from './MouseflowAnalytics';
import { InternalAnalytics } from './InternalAnalytics';
import { WebVitalsTracker } from './WebVitalsTracker';
import { OutboundLinkTracker } from './OutboundLinkTracker';

function isPortalPath(pathname: string | null): boolean {
  const segments = (pathname ?? '/').split('/').filter(Boolean);
  const first = segments[0];
  const section = first && isLocale(first) ? segments[1] : first;

  return section === 'clienti';
}

export function PublicAnalytics() {
  const pathname = usePathname();

  if (isPortalPath(pathname)) return null;

  return (
    <>
      <GoogleAnalytics />
      <MouseflowAnalytics />
      {/* Cookieless trackers — Suspense required by useSearchParams in Next 16 */}
      <Suspense fallback={null}>
        <InternalAnalytics />
      </Suspense>
      <WebVitalsTracker />
      <OutboundLinkTracker />
    </>
  );
}
