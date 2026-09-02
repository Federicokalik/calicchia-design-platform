'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

interface CaseNoteStickyProps {
  /** Testo completo della nota (già risolto i18n). */
  text: string;
}

const URL_RE = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"')\]]*)?)/i;

function firstSentence(text: string): string {
  const firstLine = text.split(/\n+/)[0]?.trim() ?? '';
  const m = firstLine.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : firstLine).trim();
}

function firstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  if (!m) return null;
  return m[0].replace(/[.,;:!?)]+$/, '');
}

/**
 * Versione compatta della nota che accompagna lo scroll delle sezioni visive
 * (Prima/Dopo + Galleria) e si sblocca prima dei Risultati.
 *
 * `position: sticky` dentro il wrapper che contiene ANCHE le sezioni visive:
 * resta agganciata finché quel blocco è in viewport, poi scorre via con lui.
 *
 * Visibilità: nascosta finché la nota completa (`#case-note`) è ancora a
 * schermo — così non si vedono le due versioni insieme. Compare (fade) solo
 * quando la nota completa è scrollata sopra l'header.
 */
export function CaseNoteSticky({ text }: CaseNoteStickyProps) {
  const t = useTranslations('lavori.detail');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const full = document.getElementById('case-note');
    if (!full) {
      setVisible(true);
      return;
    }
    let raf = 0;
    const check = () => {
      raf = 0;
      // La barra compare quando il bordo inferiore della nota completa passa
      // sotto la linea dell'header (~96px dal top).
      setVisible(full.getBoundingClientRect().bottom < 96);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  const summary = firstSentence(text);
  if (!summary) return null;

  const url = firstUrl(text);
  const href = url ? (url.startsWith('http') ? url : `https://${url}`) : null;
  const showUrl = Boolean(href && url && !summary.includes(url));

  return (
    <div
      aria-hidden={!visible}
      className="sticky border-y"
      style={{
        top: 'calc(var(--availability-banner-height, 0px) + 4rem)',
        zIndex: 40,
        background: 'var(--color-bg)',
        borderColor: 'var(--color-line)',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 220ms ease',
      }}
    >
      <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-6 py-2.5 md:px-10 lg:px-14">
        <span
          className="shrink-0 font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('note.label')}
        </span>
        <span aria-hidden style={{ color: 'var(--color-line-strong)' }}>
          ·
        </span>
        <a
          href="#case-note"
          tabIndex={visible ? undefined : -1}
          className="min-w-0 flex-1 truncate text-xs transition-opacity hover:opacity-70"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {summary}
        </a>
        {showUrl ? (
          <a
            href={href as string}
            target="_blank"
            rel="noopener noreferrer"
            tabIndex={visible ? undefined : -1}
            className="hidden shrink-0 items-center gap-1 font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.14em] transition-opacity hover:opacity-70 sm:inline-flex"
            style={{ color: 'var(--color-ink)' }}
          >
            {url}
            <span aria-hidden>↗</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}
