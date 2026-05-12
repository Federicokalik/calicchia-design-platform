'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import {
  acceptAll,
  getConsent,
  installCookieConsentGlobals,
  logConsentToServer,
  rejectAll,
  setConsent,
  shouldShowBanner,
  type ConsentRecord,
} from '@/lib/cookie-consent';
import {
  DEFAULT_LOCALE,
  isLocale,
  localizedPath,
  type Locale,
} from '@/lib/i18n';

type BannerView = 'main' | 'preferences';

function persist(record: ConsentRecord) {
  void logConsentToServer(record);
}

function localeFromPath(pathname: string | null): Locale {
  const firstSeg = (pathname ?? '/').split('/')[1];
  return isLocale(firstSeg) ? firstSeg : DEFAULT_LOCALE;
}

export function CookieConsentBanner() {
  const pathname = usePathname();
  const locale = localeFromPath(pathname);
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<BannerView>('main');
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    installCookieConsentGlobals();
    setMounted(true);
    setVisible(shouldShowBanner());

    window.__openCookiePreferences = () => {
      const consent = getConsent();
      setAnalytics(consent?.preferences.analytics ?? false);
      setMarketing(consent?.preferences.marketing ?? false);
      setView('preferences');
      setVisible(true);
    };

    return () => {
      if (window.__openCookiePreferences) {
        delete window.__openCookiePreferences;
      }
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, [visible]);

  const closeWithNecessary = () => {
    const record = rejectAll();
    persist(record);
    setVisible(false);
    setView('main');
  };

  const accept = () => {
    const record = acceptAll();
    persist(record);
    setVisible(false);
    setView('main');
  };

  const savePreferences = () => {
    const record = setConsent({ analytics, marketing });
    persist(record);
    setVisible(false);
    setView('main');
  };

  if (!mounted || !visible) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Preferenze cookie"
      className="fixed inset-0 z-[120] flex items-center justify-center px-4 py-6"
    >
      <div className="absolute inset-0 bg-[rgba(10,10,9,0.72)] backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[720px] border p-6 md:p-8"
        style={{
          background: 'var(--color-ink)',
          color: 'var(--color-bg)',
          borderColor: 'rgba(250,250,247,0.14)',
        }}
      >
        <button
          type="button"
          onClick={closeWithNecessary}
          aria-label="Chiudi e usa solo cookie necessari"
          className="absolute right-4 top-4 inline-flex size-11 items-center justify-center border transition-colors hover:bg-white/10"
          style={{ borderColor: 'rgba(250,250,247,0.18)' }}
        >
          <X size={18} aria-hidden />
        </button>

        {view === 'main' ? (
          <>
            <p
              className="font-mono text-[10px] uppercase tracking-[0.24em]"
              style={{ color: 'rgba(250,250,247,0.52)' }}
            >
              Preferenze cookie
            </p>
            <h2
              className="mt-5 max-w-[12ch] font-[family-name:var(--font-display)] text-4xl md:text-5xl"
              style={{ fontWeight: 500, letterSpacing: '-0.035em', lineHeight: 0.98 }}
            >
              Scegli cosa caricare.
            </h2>
            <p className="mt-5 max-w-[58ch] text-sm leading-relaxed" style={{ color: 'rgba(250,250,247,0.68)' }}>
              Uso cookie tecnici necessari al funzionamento. Con il tuo consenso posso
              caricare servizi di terze parti, come Google Maps nel footer.
            </p>
            <p className="mt-4 text-sm" style={{ color: 'rgba(250,250,247,0.62)' }}>
              <Link href={localizedPath('/cookie-policy', locale)} className="underline underline-offset-4">
                Cookie Policy
              </Link>{' '}
              /{' '}
              <Link href={localizedPath('/privacy-policy', locale)} className="underline underline-offset-4">
                Privacy Policy
              </Link>
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={closeWithNecessary}
                className="min-h-[44px] border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em]"
                style={{ borderColor: 'rgba(250,250,247,0.22)' }}
              >
                Solo necessari
              </button>
              <button
                type="button"
                onClick={() => setView('preferences')}
                className="min-h-[44px] border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em]"
                style={{ borderColor: 'rgba(250,250,247,0.22)' }}
              >
                Personalizza
              </button>
              <button
                type="button"
                onClick={accept}
                className="min-h-[44px] border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em]"
                style={{
                  background: 'var(--color-accent)',
                  borderColor: 'var(--color-accent)',
                  color: 'var(--color-accent-ink)',
                }}
              >
                Accetta tutti
              </button>
            </div>
          </>
        ) : (
          <>
            <p
              className="font-mono text-[10px] uppercase tracking-[0.24em]"
              style={{ color: 'rgba(250,250,247,0.52)' }}
            >
              Gestisci consenso
            </p>
            <h2
              className="mt-5 font-[family-name:var(--font-display)] text-4xl md:text-5xl"
              style={{ fontWeight: 500, letterSpacing: '-0.035em', lineHeight: 0.98 }}
            >
              Preferenze.
            </h2>

            <div className="mt-8 divide-y" style={{ borderTop: '1px solid rgba(250,250,247,0.14)', borderColor: 'rgba(250,250,247,0.14)' }}>
              <div className="grid grid-cols-[1fr_auto] gap-5 py-5">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.14em]">Necessari</p>
                  <p className="mt-2 text-sm leading-relaxed" style={{ color: 'rgba(250,250,247,0.62)' }}>
                    Essenziali per funzionamento, sicurezza e preferenze.
                  </p>
                </div>
                <span className="font-mono text-xs uppercase tracking-[0.18em]" style={{ color: 'rgba(250,250,247,0.5)' }}>
                  Sempre
                </span>
              </div>

              <label className="grid cursor-pointer grid-cols-[1fr_auto] gap-5 py-5">
                <span>
                  <span className="block text-sm font-medium uppercase tracking-[0.14em]">Analytics</span>
                  <span className="mt-2 block text-sm leading-relaxed" style={{ color: 'rgba(250,250,247,0.62)' }}>
                    Dati aggregati per capire come viene usato il sito.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={analytics}
                  onChange={(event) => setAnalytics(event.target.checked)}
                  className="mt-1 size-5 accent-[var(--color-accent)]"
                />
              </label>

              <label className="grid cursor-pointer grid-cols-[1fr_auto] gap-5 py-5">
                <span>
                  <span className="block text-sm font-medium uppercase tracking-[0.14em]">Terze parti</span>
                  <span className="mt-2 block text-sm leading-relaxed" style={{ color: 'rgba(250,250,247,0.62)' }}>
                    Abilita contenuti esterni come Google Maps.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={marketing}
                  onChange={(event) => setMarketing(event.target.checked)}
                  className="mt-1 size-5 accent-[var(--color-accent)]"
                />
              </label>
            </div>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => setView('main')}
                className="min-h-[44px] border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em]"
                style={{ borderColor: 'rgba(250,250,247,0.22)' }}
              >
                Indietro
              </button>
              <button
                type="button"
                onClick={savePreferences}
                className="min-h-[44px] border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em]"
                style={{
                  background: 'var(--color-accent)',
                  borderColor: 'var(--color-accent)',
                  color: 'var(--color-accent-ink)',
                }}
              >
                Salva preferenze
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
