import { getTranslations } from 'next-intl/server';

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
 * Sfondo opaco `--color-bg` + hairline. Il testo rimanda alla nota completa
 * (`#case-note`); l'eventuale URL è un link diretto.
 */
export async function CaseNoteSticky({ text }: CaseNoteStickyProps) {
  const t = await getTranslations('lavori.detail');
  const summary = firstSentence(text);
  if (!summary) return null;

  const url = firstUrl(text);
  const href = url ? (url.startsWith('http') ? url : `https://${url}`) : null;
  // Evita di ripetere l'URL se è già dentro la frase mostrata.
  const showUrl = href && !summary.includes(url as string);

  return (
    <div
      className="sticky border-y"
      style={{
        top: 'calc(var(--availability-banner-height, 0px) + 4rem)',
        zIndex: 40,
        background: 'var(--color-bg)',
        borderColor: 'var(--color-line)',
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
