import { getLocale, getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';
import { CURIOSITA_BIO_LINK, getCuriosita } from '@/data/curiosita';
import type { Locale } from '@/lib/i18n';

interface CuriositaListProps {
  index?: string;
  /** Optional override; falls back to t('curiosita.eyebrow'). */
  eyebrow?: string;
}

/**
 * "Chi c'è dietro lo schermo" — pinned-universal layout.
 * Sticky title a sinistra (CSS-only, no GSAP), scroll content a destra.
 * Server component: nessuna interattività, solo CSS sticky.
 */
export async function CuriositaList({
  index = '08',
  eyebrow,
}: CuriositaListProps) {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations('curiosita');
  const items = getCuriosita(locale);

  const eyebrowText = eyebrow ?? t('eyebrow');

  return (
    <Section spacing="default" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-12 md:mb-20">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {eyebrowText}
        </p>
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('countLabel', { count: items.length })}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-12 md:gap-16">
        <div className="md:col-span-5">
          {/* Swiss compliance 2026-05-09: rimosso 'md:sticky md:top-32' */}
          <div>
            <h2
              className="font-[family-name:var(--font-display)] mb-8 max-w-[14ch]"
              style={{
                fontSize: 'clamp(2.5rem, 4.5vw, 4rem)',
                fontWeight: 500,
                letterSpacing: '-0.03em',
                lineHeight: 0.95,
              }}
            >
              {t('stickyTitle')}
            </h2>
            <p
              className="text-lg md:text-xl leading-relaxed mb-8 max-w-[42ch]"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {t('stickyLead')}
            </p>
            <a
              href={CURIOSITA_BIO_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-3 text-base uppercase tracking-[0.18em] font-medium border-b transition-[gap] hover:gap-4 min-h-[44px] pb-2"
              style={{ borderColor: 'var(--color-ink)', color: 'var(--color-ink)' }}
            >
              {t('bioLink')}
              <span aria-hidden>↗</span>
            </a>
          </div>
        </div>

        <ol className="md:col-span-7 flex flex-col">
          {items.map((item, idx) => (
            <li
              key={item.label}
              className="grid grid-cols-12 gap-6 py-10 md:py-12"
              style={{
                borderTop: idx === 0 ? '1px solid var(--color-line)' : undefined,
                borderBottom: '1px solid var(--color-line)',
              }}
            >
              <span
                className="col-span-12 md:col-span-2 font-mono text-xs pt-2 tabular-nums"
                style={{ color: 'var(--color-accent-deep)' }}
              >
                {String(idx + 1).padStart(2, '0')}
              </span>
              <div className="col-span-12 md:col-span-10">
                <h3
                  className="font-[family-name:var(--font-display)] mb-3"
                  style={{
                    fontSize: 'clamp(1.5rem, 2.4vw, 2rem)',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.15,
                  }}
                >
                  {item.label}
                </h3>
                <p
                  className="text-base md:text-lg leading-relaxed max-w-[55ch]"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {item.text}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
