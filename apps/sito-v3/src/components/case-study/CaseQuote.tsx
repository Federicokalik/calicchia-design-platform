import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';

interface CaseQuoteProps {
  quote: string;
  attribution?: string;
}

/**
 * Editorial pull-quote — display type left + mono attribution.
 * Bierut purist: niente big quote-mark ornamentale, niente SplitText
 * line-reveal, niente decorativismo. La quote È il visual; la sua
 * tipografia gigante + attribution mono è il pattern sufficiente.
 *
 * Server component — fade-in entry minimal via CSS .case-fade-in
 * (reduced-motion guard incluso).
 */
export async function CaseQuote({ quote, attribution }: CaseQuoteProps) {
  const t = await getTranslations('lavori.detail');

  return (
    <Section spacing="cinematic" bordered="top">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-8 relative">
        <p
          className="md:col-span-2 font-mono text-xs uppercase tracking-[0.18em] pt-3"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('clientVoice')}
        </p>
        <p
          className="case-fade-in md:col-span-9 font-[family-name:var(--font-display)]"
          style={{
            fontSize: 'clamp(2rem, 4.6vw, 4rem)',
            fontWeight: 500,
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
            color: 'var(--color-ink)',
          }}
        >
          {quote}
        </p>
      </div>

      {attribution && (
        <p
          className="mt-10 md:ml-[16.66%] text-sm uppercase tracking-[0.2em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          — {attribution}
        </p>
      )}
    </Section>
  );
}
