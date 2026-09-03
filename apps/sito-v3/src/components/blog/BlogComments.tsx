import Script from 'next/script';
import { getLocale, getTranslations } from 'next-intl/server';

// Commento++ self-hosted su VPS esterno — URL pubblici e stabili, niente env.
// Versionare l'asset evita che la CDN continui a servire una build precedente
// quando cambia il bundle self-hosted di Commento++.
const COMMENTO_URL = 'https://commenti.calicchia.design/js/commento.js?v=1.8.7-i18n-it-en-1';
// Tema del widget, allineato al design system (vedi public/css/commento.css).
// Commento carica questo stylesheet DOPO quello stock (cssOverride), quindi le
// regole vincono su pari specificità.
const COMMENTO_CSS = 'https://calicchia.design/css/commento.css';

interface BlogCommentsProps {
  src?: string;
  /** Mostra la sezione solo se l'articolo permette commenti. */
  allowComments?: boolean;
}

/**
 * Commento++ self-hosted comments widget.
 * Script source is the public Commento++ endpoint; the embed is the canonical
 * `<script defer src=...>` + `<div id="commento">` mount point Commento targets.
 * `window.commento.cssOverride` è settato prima del load perché Commento legge
 * la config quando lo script si esegue (afterInteractive → dopo hydration).
 */
export async function BlogComments({ src, allowComments = true }: BlogCommentsProps) {
  if (!allowComments) return null;

  const t = await getTranslations('blog.detail');
  // Locale della pagina: Commento sceglie la lingua dal locale (data-locale o
  // navigator.language) e carica /i18n/<locale>.json dal server Commento.
  // EN è il default del widget; it richiede un file it.json sul container.
  const locale = await getLocale();

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
      <script
        dangerouslySetInnerHTML={{
          __html: `window.commento = window.commento || {}; window.commento.cssOverride = ${JSON.stringify(COMMENTO_CSS)};`,
        }}
      />
      <Script
        src={src ?? COMMENTO_URL}
        strategy="afterInteractive"
        defer
        data-locale={locale}
      />
    </section>
  );
}