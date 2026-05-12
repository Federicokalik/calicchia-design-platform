'use client';

import { useLocale } from 'next-intl';
import { usePathname, getPathname } from '@/i18n/navigation';
import type { Locale } from '@/lib/i18n';

/**
 * Costruisce l'URL al server-side endpoint /api/locale che setta cookie
 * NEXT_LOCALE via Set-Cookie header (committed prima del redirect) e poi
 * redirige a `next`. Bypassa race condition di cookie client-side.
 */
function buildSwitchUrl(locale: Locale, nextPath: string): string {
  return `/api/locale?to=${locale}&next=${encodeURIComponent(nextPath)}`;
}

interface LanguageSwitcherProps {
  /** Variante visuale per adeguarsi al contesto (overlay scuro vs header chiaro). */
  variant?: 'dark' | 'light';
  /** Hide per route IT-only (la prop la passa il page-level se sa di non avere EN). */
  enLocked?: boolean;
}

/**
 * Switch IT ↔ EN — Pentagram-style mono uppercase con dot accent attivo.
 *
 * UX: mostra entrambe le lingue ma marca quella attiva con dot #F57F44 + opacity
 * piena. L'altra è hover-only.
 *
 * Edge case: se siamo su path IT-only e l'utente è IT (currentLocale='it'),
 * il link EN porta a `/en/<path>` che potrebbe 404 (gestito dal middleware
 * EN-availability route guard). Per UX, se `enLocked=true`, link EN diventa
 * disabilitato + tooltip esplicativo.
 */
export function LanguageSwitcher({
  variant = 'dark',
  enLocked = false,
}: LanguageSwitcherProps) {
  const currentLocale = useLocale() as Locale;
  const pathname = usePathname();

  const baseTextColor =
    variant === 'dark' ? 'rgba(250,250,247,0.68)' : 'var(--color-ink-muted)';
  const activeColor = variant === 'dark' ? '#FAFAF7' : 'var(--color-ink)';

  const renderLink = (locale: Locale, label: string, isActive: boolean, isLocked: boolean) => {
    const baseStyle = {
      color: isActive ? activeColor : baseTextColor,
      letterSpacing: '0.18em',
      transition: 'color 200ms',
    } as const;

    if (isLocked && !isActive) {
      return (
        <span
          aria-disabled="true"
          title="EN version coming soon"
          className="font-mono text-[11px] uppercase opacity-30 cursor-not-allowed"
          style={baseStyle}
        >
          {label}
        </span>
      );
    }

    // Pathname da usePathname() di next-intl è canonical IT (es. /lavori/foo
    // anche se l'URL è /en/works/foo). getPathname legge il `pathnames` config
    // (single source of truth in routing.ts) per produrre URL pubblica finale
    // — gestisce sia segmenti tradotti registrati (lavori→works, clienti→clients
    // ecc.) sia path non-tradotti (mantiene slug originale). Poi passa per
    // /api/locale per fare set-cookie server-side prima del redirect (no race
    // con localeDetection).
    let targetPath: string;
    try {
      targetPath = getPathname({ href: pathname as never, locale });
    } catch {
      // Fallback: path non registrato in pathnames config — append locale
      // prefix solo (no segment translation).
      targetPath = locale === 'it' ? pathname : `/${locale}${pathname}`;
    }
    const href = buildSwitchUrl(locale, targetPath);

    return (
      <a
        href={href}
        aria-current={isActive ? 'true' : undefined}
        onClick={(event) => {
          // Middle-click / cmd+click / ctrl+click → lascia behavior nativo
          // (apertura nuova tab); per il primary click force full navigation
          // via window.location.assign per bypassare RSC prefetch / Next Router
          // cache che servirebbero contenuto stale del locale precedente.
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          window.location.assign(href);
        }}
        className="font-mono text-[11px] uppercase hover:opacity-100 transition-opacity"
        style={baseStyle}
      >
        {label}
      </a>
    );
  };

  return (
    <div
      className="inline-flex items-center gap-3"
      role="group"
      aria-label="Lingua del sito / Site language"
    >
      <span className="inline-flex items-center gap-1.5">
        {currentLocale === 'it' ? (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5"
            style={{ background: 'var(--color-accent)' }}
          />
        ) : null}
        {renderLink('it', 'IT', currentLocale === 'it', false)}
      </span>
      <span
        aria-hidden
        className="inline-block h-px w-3"
        style={{ background: variant === 'dark' ? 'rgba(250,250,247,0.24)' : 'var(--color-line)' }}
      />
      <span className="inline-flex items-center gap-1.5">
        {currentLocale === 'en' ? (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5"
            style={{ background: 'var(--color-accent)' }}
          />
        ) : null}
        {renderLink('en', 'EN', currentLocale === 'en', enLocked)}
      </span>
    </div>
  );
}
