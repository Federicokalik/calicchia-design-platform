'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';

const COOKIE_NAME = 'LANG_BANNER_DISMISSED';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 anno

/**
 * Banner topbar non-intrusivo: suggerisce switch a EN se l'utente ha
 * `navigator.language` EN-ish ma sta navigando su locale IT.
 *
 * UX:
 * - Hidden by default fino al mount (no CLS).
 * - Mostrato solo se cookie LANG_BANNER_DISMISSED non settato.
 * - Mostrato solo se currentLocale='it' E navigator.language inizia con 'en'.
 * - Click "Switch to English" → redirect a /en/freelance-web-designer-italy + cookie set.
 * - Click "Dismiss" → cookie set, banner sparisce immediatamente.
 *
 * Pentagram-style: hairline 1px top+bottom, mono uppercase 11px, accent dot,
 * altezza fissa per evitare layout shift.
 */
export function LanguagePromptBanner() {
  const currentLocale = useLocale();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (currentLocale !== 'it') return;
    if (typeof navigator === 'undefined') return;

    // Cookie check
    const dismissed = document.cookie
      .split(';')
      .map((c) => c.trim())
      .some((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (dismissed) return;

    // Browser language check
    const langs = [
      navigator.language,
      ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    ]
      .filter(Boolean)
      .map((l) => l.toLowerCase());

    const prefersEn = langs.some((l) => l.startsWith('en'));
    if (prefersEn) setVisible(true);
  }, [currentLocale]);

  const dismiss = () => {
    document.cookie = `${COOKIE_NAME}=1; max-age=${COOKIE_MAX_AGE}; path=/; SameSite=Lax`;
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Language preference suggestion"
      className="w-full"
      style={{
        background: '#FAFAF7',
        borderTop: '1px solid var(--color-line)',
        borderBottom: '1px solid var(--color-line)',
        position: 'relative',
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
          <span
            className="font-mono text-[11px] uppercase tracking-[0.18em]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Reading in English?
          </span>
          <Link
            href="/freelance-web-designer-italy"
            locale="en"
            onClick={() => {
              document.cookie = `${COOKIE_NAME}=1; max-age=${COOKIE_MAX_AGE}; path=/; SameSite=Lax`;
            }}
            className="font-mono text-[11px] uppercase tracking-[0.18em] underline-offset-4 hover:underline"
            style={{ color: 'var(--color-ink)' }}
          >
            Switch to English version →
          </Link>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss language banner"
          className="font-mono text-[11px] uppercase tracking-[0.18em] hover:opacity-60 transition-opacity"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          Dismiss ×
        </button>
      </div>
    </div>
  );
}
