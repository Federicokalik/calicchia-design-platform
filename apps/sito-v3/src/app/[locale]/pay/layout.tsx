import type { ReactNode } from 'react';

/**
 * Minimal layout for public payment pages.
 *
 * Strips SiteHeader / SiteFooter on purpose: payment pages need focus,
 * not navigation. The wordmark+secure-payment header is rendered per-page
 * inside the layout shell so analytics and consent banner can sit at the root.
 */
export default function PayLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-background">{children}</div>;
}
