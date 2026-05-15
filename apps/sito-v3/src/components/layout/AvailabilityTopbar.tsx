'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

type CapacityStatus = 'available' | 'last_slot' | 'full';

interface CapacitySnapshot {
  used: number;
  max: number;
  status: CapacityStatus;
  nextAvailableMonth: string;
}

const STORAGE_KEY_PREFIX = 'caldes:availability-banner:';
const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/**
 * Topbar globale che esibisce la disponibilità ("3/6 posti questo mese") su
 * tutte le pagine, in alto, a contrasto rispetto al cream del sito.
 *
 * Mostrato solo quando:
 *  - lo status è `available` o `last_slot` (mostrare "PIENO" su ogni pagina
 *    sarebbe un boomerang — la home gestisce comunque il caso full nel suo hero).
 *  - l'utente non ha già dismissato la versione del mese corrente.
 *  - il path NON è in una pagina dove sarebbe ridondante o invasivo
 *    (contatti, legali, dettaglio blog).
 *
 * Dismiss persistito in localStorage con chiave per mese
 * (`caldes:availability-banner:2026-05`). Riappare automaticamente a mese nuovo.
 * Non usiamo cookie per evitare GDPR consent.
 */
export function AvailabilityTopbar() {
  const locale = useLocale();
  const t = useTranslations('home.hero');
  const tBanner = useTranslations('availabilityBanner');
  const pathname = usePathname();

  const [snapshot, setSnapshot] = useState<CapacitySnapshot | null>(null);
  const [dismissed, setDismissed] = useState(true); // start dismissed → no flash
  const [mounted, setMounted] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // Path escluso: rimuove la lingua iniziale poi confronta.
  const pathNoLocale = stripLocale(pathname, locale);
  const isExcluded = isExcludedPath(pathNoLocale);

  // 1. Read dismiss flag from localStorage (once mounted, no SSR)
  useEffect(() => {
    setMounted(true);
    if (typeof window === 'undefined') return;
    const monthKey = currentMonthKey();
    try {
      const v = window.localStorage.getItem(STORAGE_KEY_PREFIX + monthKey);
      setDismissed(v === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  // 2. Fetch capacity snapshot (skipped if dismissed or excluded — niente request inutili)
  useEffect(() => {
    if (!mounted || dismissed || isExcluded) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/public/capacity`, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: CapacitySnapshot | null) => {
        if (!cancelled && data) setSnapshot(data);
      })
      .catch(() => { /* silent fail — il banner semplicemente non appare */ });
    return () => { cancelled = true; };
  }, [mounted, dismissed, isExcluded]);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(STORAGE_KEY_PREFIX + currentMonthKey(), '1');
    } catch { /* private mode / quota → comunque sparisce per la sessione */ }
  };

  // 3. Quando il banner è visibile, pubblica la sua altezza come CSS variable
  //    (--availability-banner-height) sul documento. Il SiteHeader fixed legge
  //    questa variabile per spostarsi sotto il banner, così "tutto il sito"
  //    scende quando il banner appare. ResizeObserver gestisce wrap su mobile.
  const willRender =
    mounted && !dismissed && !isExcluded && snapshot !== null && snapshot.status !== 'full';
  useEffect(() => {
    const root = document.documentElement;
    if (!willRender) {
      root.style.setProperty('--availability-banner-height', '0px');
      return;
    }
    const bar = barRef.current;
    if (!bar) return;
    const apply = () => root.style.setProperty('--availability-banner-height', `${bar.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => {
      ro.disconnect();
      root.style.setProperty('--availability-banner-height', '0px');
    };
  }, [willRender]);

  // Visibility gates
  if (!willRender) return null;

  const label = snapshot.status === 'last_slot'
    ? t('lastSlot')
    : t('availableCount', { used: snapshot.used, max: snapshot.max });

  return (
    <div
      ref={barRef}
      role="region"
      aria-label={tBanner('regionLabel')}
      className="w-full"
      style={{
        background: 'var(--color-ink)',
        color: '#FAFAF7',
        position: 'sticky',
        top: 0,
        zIndex: 70,
      }}
    >
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4 px-6 py-2 md:px-10">
        <div className="flex items-center gap-3 min-h-[28px]">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5"
            style={{ background: 'var(--color-accent)' }}
          />
          <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
            {label}
          </span>
          <Link
            href="/contatti"
            className="group inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] hover:opacity-80 transition-opacity"
            style={{ color: '#FAFAF7' }}
          >
            <span className="underline underline-offset-4 decoration-from-font">
              {tBanner('cta')}
            </span>
            <span aria-hidden className="inline-block transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </Link>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={tBanner('dismissAria')}
          className="font-mono text-[11px] uppercase tracking-[0.18em] hover:opacity-60 transition-opacity"
          style={{ color: 'rgba(250,250,247,0.6)' }}
        >
          {tBanner('dismiss')} ×
        </button>
      </div>
    </div>
  );
}

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function stripLocale(pathname: string, locale: string): string {
  if (pathname === `/${locale}`) return '/';
  if (pathname.startsWith(`/${locale}/`)) return pathname.slice(locale.length + 1);
  return pathname;
}

/**
 * Path dove il banner sarebbe ridondante o fuori contesto:
 *  - /contatti, /lista-attesa, ecc: la conversione è già lì, banner è rumore.
 *  - pagine legali (/privacy, /termini, /cookie, /faq): rompono la lettura formale.
 *  - blog dettaglio (/blog/YYYY/MM/slug): l'attenzione del lettore non va spezzata.
 *  - guida glossario (/glossario-*): stesso ragionamento del blog.
 */
function isExcludedPath(path: string): boolean {
  if (path.startsWith('/contatti')) return true;
  if (path.startsWith('/privacy')) return true;
  if (path.startsWith('/termini')) return true;
  if (path.startsWith('/cookie')) return true;
  if (path.startsWith('/faq')) return true;
  if (path.startsWith('/glossario')) return true;
  // /blog è ok (lista), /blog/anno/mese/slug no.
  if (/^\/blog\/[^/]+\/[^/]+\/[^/]+/.test(path)) return true;
  return false;
}
