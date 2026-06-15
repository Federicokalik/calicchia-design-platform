'use client';

import { Link, usePathname } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import {
  LayoutDashboard,
  FolderOpen,
  Megaphone,
  FileText,
  File,
  Upload,
  Wallet,
  Receipt,
  Repeat,
  RefreshCw,
  LogOut,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PortalLabel } from './ui/typography';

type PortalRole = 'client' | 'collaborator';

interface NavItem {
  href: string;
  /** Translation key under `portal.nav.items.*` */
  key: string;
  icon: LucideIcon;
  /** Roles allowed to see this item. Defaults to client-only. */
  roles?: PortalRole[];
}

interface NavGroup {
  /** Translation key under `portal.nav.groups.*` */
  key: string;
  items: NavItem[];
}

// Default role allowlist: 'client' only. Items the collaborator can actually
// hit without 403 must opt-in via `roles`. Audit B-004: every clientOnly link
// shown to a collab caused either a 403 page or a 500 (B-020). projects + the
// shared logout are the only routes that work for both roles today
// (auth.ts: portalAuth vs portalClientAuth).
const GROUPS: NavGroup[] = [
  {
    key: 'work',
    items: [
      { href: '/clienti/dashboard', key: 'dashboard', icon: LayoutDashboard, roles: ['client'] },
      { href: '/clienti/progetti', key: 'projects', icon: FolderOpen, roles: ['client', 'collaborator'] },
      { href: '/clienti/campagne', key: 'campaigns', icon: Megaphone, roles: ['client'] },
      { href: '/clienti/report', key: 'reports', icon: FileText, roles: ['client'] },
    ],
  },
  {
    key: 'documents',
    items: [
      { href: '/clienti/file', key: 'files', icon: File, roles: ['client'] },
      { href: '/clienti/upload', key: 'upload', icon: Upload, roles: ['client'] },
    ],
  },
  {
    key: 'account',
    items: [
      { href: '/clienti/fatture', key: 'invoices', icon: Receipt, roles: ['client'] },
      { href: '/clienti/abbonamenti', key: 'subscriptions', icon: Repeat, roles: ['client'] },
      { href: '/clienti/investimento', key: 'billing', icon: Wallet, roles: ['client'] },
      { href: '/clienti/rinnovi', key: 'renewals', icon: RefreshCw, roles: ['client'] },
      { href: '/clienti/preferenze', key: 'preferences', icon: SlidersHorizontal, roles: ['client'] },
      { href: '/clienti/logout', key: 'logout', icon: LogOut, roles: ['client', 'collaborator'] },
    ],
  },
];

/**
 * Vertical navigation for the portal sidebar — admin-inspired structure
 * (icon + label, group eyebrows) but Pentagram-restrained styling
 * (squared, hairline border on active, no shadow, no heavy fills).
 *
 * Active state pattern: subtle accent bg + 2px primary left tick + medium
 * weight. Mirrors `apps/admin/src/index.css:127-133` (`nav-item-active`)
 * but flat.
 */
export function PortalNav({ role = 'client' }: { role?: PortalRole }) {
  const pathname = usePathname();
  const tNav = useTranslations('portal.nav');
  const tShell = useTranslations('portal.shell');
  // Strip locale prefix so active matching works in /it/clienti/... and /en/clients/...
  // (next-intl rewrites EN URLs to IT canonical for matching, but pathname
  // here is the public URL, so we accept both segment forms via prefix match.)
  const path = pathname.replace(/^\/(?:it|en)(?=\/|$)/, '');

  function isActive(itHref: string): boolean {
    // Map IT canonical → list of acceptable URL segments (IT + EN translations).
    const enHref = itHref
      .replace('/clienti', '/clients')
      .replace('/progetti', '/projects')
      .replace('/campagne', '/campaigns')
      .replace('/file', '/files')
      .replace('/investimento', '/billing')
      .replace('/rinnovi', '/renewals')
      .replace('/report', '/reports')
      .replace('/fatture', '/invoices')
      .replace('/abbonamenti', '/subscriptions')
      .replace('/login', '/sign-in');
    return (
      path === itHref ||
      path.startsWith(itHref + '/') ||
      path === enHref ||
      path.startsWith(enHref + '/')
    );
  }

  const visibleGroups = GROUPS
    .map((g) => ({ ...g, items: g.items.filter((item) => !item.roles || item.roles.includes(role)) }))
    .filter((g) => g.items.length > 0);

  return (
    <nav className="flex flex-col gap-7" aria-label={tShell('navAriaLabel')}>
      {visibleGroups.map((g) => (
        <div key={g.key} className="space-y-2">
          <PortalLabel className="px-3 block">{tNav(`groups.${g.key}`)}</PortalLabel>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              // /clienti/logout e` un Route Handler che ritorna 307 redirect:
              // next-intl Link fa client-side navigation che non segue redirect
              // server, quindi serve un plain <a> per la navigation full-page.
              const isLogout = item.href === '/clienti/logout';
              const classes = cn(
                'group flex items-center gap-3 px-3 py-2 text-portal-body transition-colors border-l-2',
                active
                  ? 'bg-primary/10 text-primary border-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground border-transparent hover:bg-muted/60'
              );
              const content = (
                <>
                  <Icon
                    className="h-4 w-4 shrink-0"
                    aria-hidden
                    strokeWidth={active ? 2.25 : 1.75}
                  />
                  <span>{tNav(`items.${item.key}`)}</span>
                </>
              );
              return (
                <li key={item.href}>
                  {isLogout ? (
                    <a href={item.href} className={classes}>
                      {content}
                    </a>
                  ) : (
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={classes}
                    >
                      {content}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
