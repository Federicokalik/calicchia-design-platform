import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';

interface CaseStaleNoticeProps {
  /** Anno completamento del progetto. Se >1 anno fa rispetto a oggi, mostra il banner. */
  year: number;
  /** Years-ago già calcolato dall'adapter (`deriveCaseStudyExtension`). */
  yearsAgo: number;
  /** URL live opzionale: se presente, il banner suggerisce di verificare lo stato corrente. */
  liveUrl?: string | null;
}

/**
 * Avviso "lavoro >1 anno fa potrebbe essere cambiato o non più online".
 *
 * Pentagram-style: hairline border-y 1px, mono uppercase tracking-wide,
 * niente alert giallo/rosso — è metadata informativa, non emergency state.
 * Il colore accent (#F57F44) è usato SOLO sul dot prefisso, mai sul testo.
 */
export async function CaseStaleNotice({
  year,
  yearsAgo,
  liveUrl,
}: CaseStaleNoticeProps) {
  const t = await getTranslations('lavori.detail.stale');

  // Frase varia in base a quanti anni: "1 anno" / "2 anni" / "5 anni fa"
  const ageLabel =
    yearsAgo === 1 ? t('ageSingle') : t('ageMulti', { years: yearsAgo });

  return (
    <Section spacing="compact" bordered="top">
      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-3 py-2"
        role="note"
        aria-label={t('ariaLabel')}
      >
        <span
          className="inline-flex items-center gap-3 font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.2em]"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          <span
            aria-hidden
            className="inline-block size-1.5"
            style={{ background: 'var(--color-accent-deep)' }}
          />
          {t('publishedPrefix')} {ageLabel} ({year})
        </span>
        <span
          className="text-[length:var(--text-eyebrow)] uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          —
        </span>
        <span
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('warning')}
        </span>
        {liveUrl ? (
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-2 font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.18em] underline-offset-4 hover:underline"
            style={{ color: 'var(--color-ink)' }}
          >
            {t('verify')}
            <span aria-hidden>↗</span>
          </a>
        ) : null}
      </div>
    </Section>
  );
}
