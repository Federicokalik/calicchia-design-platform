import { getTranslations } from 'next-intl/server';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';

interface Faq {
  question: string;
  answer: string;
}

interface LandingFaqProps {
  faqs: Faq[];
  index?: string;
  heading?: string;
}

/** FAQ accordion CSS-only — server component. */
export async function LandingFaq({
  faqs,
  index = '04',
  heading,
}: LandingFaqProps) {
  const t = await getTranslations('servizi.detail');

  return (
    <Section spacing="default" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-16 md:mb-24">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {t('faqs')}
        </p>
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('faqCount', { count: faqs.length })}
        </span>
      </div>

      <ul className="grid grid-cols-1 md:grid-cols-12 gap-x-12">
        {/* Swiss compliance 2026-05-09: rimosso 'md:sticky md:top-32' */}
        <li className="md:col-span-3 self-start mb-12 md:mb-0">
          <Heading size="display-md">{heading ?? t('faqHeading')}</Heading>
        </li>
        <li className="md:col-span-9 flex flex-col">
          {faqs.map((f, i) => (
            <details
              key={i}
              className="group py-6 md:py-8"
              style={{
                borderTop: i === 0 ? '1px solid var(--color-line)' : 'none',
                borderBottom: '1px solid var(--color-line)',
              }}
            >
              <summary
                className="flex items-baseline justify-between gap-6 cursor-pointer list-none"
                style={{ color: 'var(--color-ink)' }}
              >
                <span
                  className="font-[family-name:var(--font-display)] text-xl md:text-2xl"
                  style={{ fontWeight: 500, letterSpacing: '-0.015em', lineHeight: 1.2 }}
                >
                  {f.question}
                </span>
                <span
                  className="font-mono text-2xl shrink-0 transition-transform group-open:rotate-45"
                  aria-hidden
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  +
                </span>
              </summary>
              <p
                className="mt-4 md:mt-6 max-w-[60ch] text-base md:text-lg leading-relaxed"
                style={{ color: 'var(--color-ink-muted)' }}
              >
                {f.answer}
              </p>
            </details>
          ))}
        </li>
      </ul>
    </Section>
  );
}
