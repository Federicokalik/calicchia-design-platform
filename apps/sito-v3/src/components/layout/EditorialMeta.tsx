'use client';

import { useState } from 'react';
import { MonoLabel } from '@/components/ui/MonoLabel';

interface EditorialMetaProps {
  readTime?: string;
  updatedAt?: string;
  author?: string;
  shareUrl?: string;
  /**
   * @deprecated Swiss compliance audit 2026-05-09: progress indicator removed
   * (austerity per Master report). Prop kept as optional for API back-compat,
   * has no effect.
   */
  showProgress?: boolean;
}

export function EditorialMeta({
  readTime,
  updatedAt,
  author = 'Federico Calicchia',
  shareUrl,
}: EditorialMetaProps) {
  const [copied, setCopied] = useState(false);

  const onShare = async () => {
    if (typeof window === 'undefined') return;
    const url = shareUrl ?? window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // graceful fallback: nothing
    }
  };

  return (
    <aside
      aria-label="Metadati articolo"
      className="hidden md:block flex-col"
    >
      <MonoLabel as="p" className="mb-6 uppercase tracking-[0.2em]">
        Articolo
      </MonoLabel>

      <dl className="flex flex-col gap-4 mb-8">
        {readTime ? (
          <div>
            <dt
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-mono-xs)',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: 'var(--color-text-tertiary)',
              }}
            >
              Lettura
            </dt>
            <dd
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '0.875rem',
                color: 'var(--color-text-primary)',
              }}
            >
              {readTime}
            </dd>
          </div>
        ) : null}
        {updatedAt ? (
          <div>
            <dt
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-mono-xs)',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: 'var(--color-text-tertiary)',
              }}
            >
              Aggiornato
            </dt>
            <dd
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '0.875rem',
                color: 'var(--color-text-primary)',
              }}
            >
              {updatedAt}
            </dd>
          </div>
        ) : null}
        <div>
          <dt
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-mono-xs)',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--color-text-tertiary)',
            }}
          >
            Autore
          </dt>
          <dd
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '0.875rem',
              color: 'var(--color-text-primary)',
            }}
          >
            {author}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onShare}
        className="self-start py-2 border-b focus-visible:outline-2 focus-visible:outline-offset-2 transition-opacity hover:opacity-60"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-mono-xs)',
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--color-text-primary)',
          borderColor: 'var(--color-border-strong)',
        }}
      >
        {copied ? '— Copiato' : '+ Copia link'}
      </button>
    </aside>
  );
}
