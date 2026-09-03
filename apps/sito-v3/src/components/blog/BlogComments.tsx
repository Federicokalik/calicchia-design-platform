import Script from 'next/script';
import { getTranslations } from 'next-intl/server';

// Commento++ self-hosted su VPS esterno — URL pubblico e stabile, niente env.
const COMMENTO_URL = 'https://commenti.calicchia.design/js/commento.js';

interface BlogCommentsProps {
  src?: string;
  /** Mostra la sezione solo se l'articolo permette commenti. */
  allowComments?: boolean;
}

/**
 * Commento++ self-hosted comments widget.
 * Script source is the public Commento++ endpoint; the embed is the canonical
 * `<script defer src=...>` + `<div id="commento">` mount point Commento targets.
 */
export async function BlogComments({ src, allowComments = true }: BlogCommentsProps) {
  if (!allowComments) return null;

  const t = await getTranslations('blog.detail');

  return (
    <section
      className="px-6 md:px-10 lg:px-14 py-16 max-w-[800px] mx-auto"
      style={{ borderTop: '1px solid var(--color-line)' }}
      aria-label={t('comments')}
    >
      <p
        className="font-mono text-xs uppercase tracking-[0.25em] mb-6"
        style={{ color: 'var(--color-ink-subtle)' }}
      >
        {t('comments')}
      </p>
      <div id="commento" />
      <Script src={src ?? COMMENTO_URL} strategy="afterInteractive" defer />
    </section>
  );
}