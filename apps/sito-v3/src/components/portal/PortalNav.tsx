'use client';

import { Link, usePathname } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import {
  LayoutDashboard,
  FolderOpen,
  FileText,
  File,
  Upload,
  Wallet,
  Receipt,
  Repeat,
  RefreshCw,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PortalLabel } from './ui/typography';

interface NavItem {
  href: string;
  /** Translation key under `portal.nav.items.*` */
  key: string;
  icon: LucideIcon;
}

interface NavGroup {
  /** Translation key under `portal.nav.groups.*` */
  key: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    key: 'work',
    items: [
      { href: '/clienti/dashboard', key: 'dashboard', icon: LayoutDashboard },
      { href: '/clienti/progetti', key: 'projects', icon: FolderOpen },
      { href: '/clienti/report', key: 'reports', icon: FileText },
    ],
  },
  {
    key: 'documents',
    items: [
      { href: '/clienti/file', key: 'files', icon: File },
      { href: '/clienti/upload', key: 'upload', icon: Upload },
    ],
  },
  {
    key: 'account',
    items: [
      { href: '/clienti/fatture', key: 'invoices', icon: Receipt },
      { href: '/clienti/abbonamenti', key: 'subscriptions', icon: Repeat },
      { href: '/clienti/investimento', key: 'billing', icon: Wallet },
      { href: '/clienti/rinnovi', key: 'renewals', icon: RefreshCw },
      { href: '/clienti/logout', key: 'logout', icon: LogOut },
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
export function PortalNav() {
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

  return (
    <nav className="flex flex-col gap-7" aria-label={tShell('navAriaLabel')}>
      {GROUPS.map((g) => (
        <div key={g.key} className="space-y-2">
          <PortalLabel className="px-3 block">{tNav(`groups.${g.key}`)}</PortalLabel>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-3 px-3 py-2 text-portal-body transition-colors border-l-2',
                      active
                        ? 'bg-primary/10 text-primary border-primary font-medium'
                        : 'text-muted-foreground hover:text-foreground border-transparent hover:bg-muted/60'
                    )}
                  >
                    <Icon
                      className="h-4 w-4 shrink-0"
                      aria-hidden
                      strokeWidth={active ? 2.25 : 1.75}
                    />
                    <span>{tNav(`items.${item.key}`)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
