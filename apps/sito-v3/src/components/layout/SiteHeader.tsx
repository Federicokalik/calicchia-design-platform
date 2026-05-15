'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Link, usePathname, getPathname } from '@/i18n/navigation';
import { gsap } from '@/lib/gsap';
import { cn } from '@/lib/utils';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@/lib/i18n';
import { Logo } from '@/components/Logo';
import { LanguageFlag } from '@/components/ui/LanguageFlag';
import { MenuOverlay } from './MenuOverlay';

/**
 * Header v3:
 *  - Logo sx con auto-hide on scroll-down / reveal on scroll-up
 *  - Dx: Contattami CTA + Menu pill + Language flag
 *  - Logo + Flag spariscono allo scroll-down (entrambi via stesso handler).
 *    Quando la flag riduce width→0, Menu+Contattami si compattano naturalmente
 *    grazie al flex-row + gap (nessun ricalcolo manuale).
 *
 * Swiss compliance audit 2026-05-09: `fixed top-0 left-0 right-0` formalizzato
 * come ECCEZIONE NAVIGATION/WAYFINDING (decisione utente). Auto-hide on scroll
 * mantenuto (motion micro accettato per chrome navigazione, prefers-reduced-motion
 * gestito tramite gsap.set vs gsap.to). CTA "Contattami" inline non passa da
 * Button: divergenza chrome vs body intenzionale (color swap ink↔accent su
 * stato `open`); refactor Button con variant 'inverse' deferred a P2.
 */
export function SiteHeader({ className }: { className?: string }) {
  const t = useTranslations('navigation');
  const headerRef = useRef<HTMLElement>(null);
  const flagRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [logoCollapsed, setLogoCollapsed] = useState(false);

  const pathname = usePathname() ?? '/';
  const currentLocale = useLocale() as Locale;
  const otherLocale: Locale =
    LOCALES.find((l) => l !== currentLocale) ?? DEFAULT_LOCALE;

  // Allineato a LanguageSwitcher: server-side cookie set via /api/locale +
  // getPathname per slug tradotto (lavori→works, servizi→services, ecc.) +
  // window.location.assign per bypass RSC prefetch / Next Router cache.
  const toggleLocale = () => {
    let targetPath: string;
    try {
      targetPath = getPathname({ href: pathname as never, locale: otherLocale });
    } catch {
      targetPath = otherLocale === DEFAULT_LOCALE ? pathname : `/${otherLocale}${pathname}`;
    }
    const href = `/api/locale?to=${otherLocale}&next=${encodeURIComponent(targetPath)}`;
    window.location.assign(href);
  };

  // Header scroll state: logo collapse and language token share the same trigger.
  useEffect(() => {
    const flag = flagRef.current;
    if (!flag) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const HIDE_THRESHOLD = 80;
    const DELTA_NOISE = 4;
    let lastY = window.scrollY;
    let hidden = false;
    let ticking = false;

    // capture flag's resting width once so we can restore it
    const flagRestWidth = flag.getBoundingClientRect().width;

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const delta = y - lastY;
        const absDelta = Math.abs(delta);

        if (absDelta < DELTA_NOISE) {
          ticking = false;
          return;
        }

        if (delta > 0 && y > HIDE_THRESHOLD && !hidden) {
          hidden = true;
          setLogoCollapsed(true);
          if (reduced) {
            gsap.set(flag, { scaleX: 0, opacity: 0, width: 0, marginRight: 0 });
          } else {
            gsap.to(flag, {
              scaleX: 0,
              opacity: 0,
              width: 0,
              marginRight: 0,
              duration: 0.4,
              ease: 'power3.out',
              overwrite: 'auto',
            });
          }
        } else if ((delta < 0 || y < HIDE_THRESHOLD) && hidden) {
          hidden = false;
          setLogoCollapsed(false);
          if (reduced) {
            gsap.set(flag, { scaleX: 1, opacity: 1, width: flagRestWidth, marginRight: 0 });
            gsap.set(flag, { clearProps: 'width' });
          } else {
            gsap.to(flag, {
              scaleX: 1,
              opacity: 1,
              width: flagRestWidth,
              marginRight: 0,
              duration: 0.45,
              ease: 'power3.out',
              overwrite: 'auto',
              onComplete: () => {
                gsap.set(flag, { clearProps: 'width' });
              },
            });
          }
        }

        lastY = y;
        ticking = false;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <>
      <header
        ref={headerRef}
        className={cn(
          'fixed left-0 right-0 px-6 md:px-10 lg:px-14 py-5 md:py-6 flex items-center justify-between gap-6 pointer-events-none',
          className
        )}
        // top legge `--availability-banner-height` settato dall'AvailabilityTopbar:
        // quando il banner è visibile, header si abbassa della stessa altezza
        // del banner; quando manca/è dismissato, fallback a 0px (top:0).
        style={{ zIndex: 90, top: 'var(--availability-banner-height, 0px)' }}
      >
        {/* Logo — auto-hide on scroll-down. Theme-swap: dark logo on light bg,
            white logo when MenuOverlay is open (dark bg). */}
        <Link
          href="/"
          aria-label={t('header.logoAriaLabel')}
          className="relative inline-flex min-h-[44px] items-center pointer-events-auto"
          style={{
            color: open ? '#FAFAF7' : 'var(--color-ink)',
            lineHeight: 0,
            transition: 'color var(--motion-fast, 240ms) var(--motion-ease-standard, ease)',
          }}
        >
          <Logo collapsed={logoCollapsed} className="site-header-logo" />
        </Link>

        {/* Right controls — always visible (Menu + Contattami stay; Flag auto-hides) */}
        <div className="flex items-center gap-2.5 pointer-events-auto">
          {/* Contattami CTA (accent) */}
          <Link
            href="/contatti"
            className="group hidden sm:inline-flex items-center gap-2 px-4 py-2.5 text-xs uppercase tracking-[0.2em] font-medium hover:gap-3 min-h-[44px]"
            style={{
              background: open ? 'rgba(245, 127, 68, 0.95)' : 'var(--color-ink)',
              color: open ? 'var(--color-accent-ink)' : '#FAFAF7',
              borderRadius: 2,
              transition: 'background 0.4s ease, color 0.4s ease, gap 0.3s ease',
            }}
          >
            <span>{t('header.contactCta')}</span>
            <span
              aria-hidden
              className="inline-block transition-transform group-hover:translate-x-0.5"
            >
              →
            </span>
          </Link>

          {/* Menu — squared outline button */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? t('header.closeMenu') : t('header.openMenu')}
            aria-expanded={open}
            className="group relative inline-flex items-center gap-3 px-4 py-2.5 text-xs uppercase tracking-[0.2em] font-medium min-h-[44px] cursor-pointer"
            style={{
              border: `1px solid ${open ? '#FAFAF7' : 'var(--color-ink)'}`,
              borderRadius: 2,
              color: open ? '#FAFAF7' : 'var(--color-ink)',
              background: 'transparent',
              transition: 'color 0.4s ease, border-color 0.4s ease',
            }}
          >
            <span className="relative inline-block w-[4.6em] text-left overflow-hidden h-[1em]">
              <span
                className="absolute inset-0 block transition-all duration-300"
                style={{
                  opacity: open ? 0 : 1,
                  transform: open ? 'translateY(-100%)' : 'translateY(0%)',
                }}
              >
                {t('header.menu')}
              </span>
              <span
                className="absolute inset-0 block transition-all duration-300"
                style={{
                  opacity: open ? 1 : 0,
                  transform: open ? 'translateY(0%)' : 'translateY(100%)',
                }}
              >
                {t('header.close')}
              </span>
            </span>

            {/* tiny lines → X */}
            <span aria-hidden className="relative inline-block size-3.5">
              <span
                className="absolute left-0 right-0 h-px transition-all duration-300 ease-out"
                style={{
                  background: open ? '#FAFAF7' : 'var(--color-ink)',
                  top: open ? '50%' : '30%',
                  transform: open ? 'translateY(-50%) rotate(45deg)' : 'rotate(0deg)',
                }}
              />
              <span
                className="absolute left-0 right-0 h-px transition-all duration-300 ease-out"
                style={{
                  background: open ? '#FAFAF7' : 'var(--color-ink)',
                  top: open ? '50%' : '70%',
                  transform: open ? 'translateY(-50%) rotate(-45deg)' : 'rotate(0deg)',
                }}
              />
            </span>
          </button>

          {/* Language token — auto-hide on scroll-down */}
          <button
            ref={flagRef}
            type="button"
            onClick={toggleLocale}
            aria-label={t('header.switchToLocale', { locale: otherLocale.toUpperCase() })}
            title={t('header.switchLocaleTitle', {
              current: currentLocale.toUpperCase(),
              next: otherLocale.toUpperCase(),
            })}
            className="inline-flex items-center justify-center min-h-[44px] cursor-pointer overflow-hidden hover:opacity-80 transition-opacity"
            style={{
              transformOrigin: 'right center',
              willChange: 'transform, opacity, width',
              background: 'transparent',
              border: 'none',
              padding: 0,
            }}
          >
            <LanguageFlag locale={currentLocale} inverted={open} />
          </button>
        </div>
      </header>

      <MenuOverlay open={open} onClose={() => setOpen(false)} />
    </>
  );
}
