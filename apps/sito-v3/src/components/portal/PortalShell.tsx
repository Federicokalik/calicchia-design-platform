'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Menu, X, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/Logo/Logo';
import { LanguageSwitcher } from '@/components/layout/LanguageSwitcher';
import { PortalNav } from './PortalNav';
import { PortalLabel, PortalCaption } from './ui/typography';

interface PortalShellProps {
  children: ReactNode;
  /** Optional override of the user-name slot in the sidebar bottom. */
  userLabel?: string;
}

/**
 * Portal layout shell — admin-inspired island pattern, Pentagram-flat:
 *   - Stage `bg-background` (warm off-white #FAFAF7)
 *   - Sidebar fixed left, 248px, `bg-card border rounded-sm` (no shadow)
 *   - No floating topbar (page header carries the title via PortalLabel +
 *     PortalDisplay; floating chrome was redundant — decisione utente
 *     2026-05-10)
 *   - Mobile (<lg): sidebar slides in/out, small hamburger floats top-left.
 */
export function PortalShell({ children, userLabel }: PortalShellProps) {
  const t = useTranslations('portal.shell');
  const [mobileOpen, setMobileOpen] = useState(false);
  const label = userLabel ?? t('userFallback');

  return (
    <div className="min-h-svh bg-background">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <button
          type="button"
          aria-label={t('closeMenu')}
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/40 lg:hidden"
        />
      )}

      {/* Mobile hamburger — small floating button, only visible <lg */}
      <button
        type="button"
        aria-label={t('openMenu')}
        onClick={() => setMobileOpen(true)}
        className={cn(
          'lg:hidden fixed top-3 left-3 z-30 inline-flex h-9 w-9 items-center justify-center rounded-sm border border-border bg-card text-foreground transition-colors hover:bg-muted',
          mobileOpen && 'hidden'
        )}
      >
        <Menu className="h-4 w-4" />
      </button>

      {/* Sidebar — island */}
      <aside
        className={cn(
          'fixed left-0 top-0 z-50 m-2 flex flex-col border border-border bg-card rounded-sm transition-transform w-[248px] h-[calc(100svh-1rem)]',
          mobileOpen
            ? 'translate-x-0'
            : '-translate-x-[calc(100%+1rem)] lg:translate-x-0'
        )}
        aria-label={t('navAriaLabel')}
      >
        {/* Header — logo stacked over eyebrow, compact */}
        <div className="relative border-b border-border px-5 py-3">
          <Link
            href="/clienti/dashboard"
            aria-label={t('backToDashboard')}
            className="flex flex-col items-start gap-1"
            onClick={() => setMobileOpen(false)}
          >
            <Logo collapsed={false} className="h-5 w-auto" />
            <PortalLabel>{t('areaEyebrow')}</PortalLabel>
          </Link>
          <button
            type="button"
            aria-label={t('closeMenu')}
            onClick={() => setMobileOpen(false)}
            className="lg:hidden absolute top-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Nav — flex-1 scrollable */}
        <div className="flex-1 overflow-y-auto py-5">
          <PortalNav />
        </div>

        {/* User section */}
        <div className="border-t border-border px-3 py-3 space-y-2">
          <div className="flex items-center gap-3 px-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-primary/10 text-primary">
              <span className="text-portal-caption font-medium">
                {label.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <PortalLabel className="block">{t('sessionLabel')}</PortalLabel>
              <PortalCaption tone="foreground" className="truncate">
                {label}
              </PortalCaption>
            </div>
          </div>
          <Link
            href="/clienti/logout"
            className="flex items-center justify-center gap-2 rounded-sm border border-transparent px-3 py-1.5 text-portal-caption text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            {t('logout')}
          </Link>
          <div className="flex justify-center pt-1">
            <LanguageSwitcher variant="light" />
          </div>
        </div>
      </aside>

      {/* Main column — content offset right of sidebar on lg, full-bleed on mobile */}
      <main className="lg:ml-[264px] px-4 pb-6 pt-4 lg:pt-6">
        {children}
      </main>
    </div>
  );
}
