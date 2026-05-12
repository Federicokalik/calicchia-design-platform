import Script from 'next/script';
import { getTranslations } from 'next-intl/server';

interface BlogCommentsProps {
  src?: string;
}

/**
 * Commento++ self-hosted comments widget.
 * Script source comes from env `COMMENTO_URL` (read server-side, baked into the rendered HTML).
 * Mount point `<div id="commento" />` is what Commento targets to inject the UI.
 */
export async function BlogComments({ src }: BlogCommentsProps) {
  const url = src ?? process.env.COMMENTO_URL;
  if (!url) return null;

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
      <Script src={url} strategy="afterInteractive" defer />
    </section>
  );
}
