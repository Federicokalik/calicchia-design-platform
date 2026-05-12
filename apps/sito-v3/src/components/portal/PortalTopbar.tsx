import type { ReactNode } from 'react';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface PortalTopbarProps {
  /** Breadcrumb items — preserved on the type for forward-compat, currently unused. */
  breadcrumbs?: BreadcrumbItem[];
  /** Right-side slot — preserved on the type, currently unused. */
  right?: ReactNode;
}

/**
 * No-op stub — kept exported so existing pages that still import and call
 * `<PortalTopbar breadcrumbs={...} />` keep compiling. The floating topbar
 * island was removed (decisione utente 2026-05-10): page headers
 * (`PortalLabel` + `PortalDisplay`) carry the title and the sidebar
 * provides full navigation, making chrome breadcrumb redundant.
 *
 * To restore breadcrumb rendering, swap this for an inline `<nav>` element
 * placed above the page header content.
 */
export function PortalTopbar(_props: PortalTopbarProps): null {
  return null;
}
