'use client';

import { usePathname } from 'next/navigation';
import { isLocale } from '@/lib/i18n';
import { GoogleAnalytics } from './GoogleAnalytics';
import { MouseflowAnalytics } from './MouseflowAnalytics';

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
    </>
  );
}
