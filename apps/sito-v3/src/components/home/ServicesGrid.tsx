import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';
import type { Service } from '@/data/types';

interface ServicesGridProps {
  services: Service[];
}

/**
 * Asymmetric editorial grid — NO 3-col equal cards (anti-AI-tell).
 * 12-col grid: services span varying col counts, large left → small right
 * to create visual rhythm. RSC-only — no animation.
 */
export async function ServicesGrid({ services }: ServicesGridProps) {
  const t = await getTranslations('home.services');

  // Editorial widths — varied col-spans for visual rhythm.
  const spans = [
    'md:col-span-7',
    'md:col-span-5',
    'md:col-span-5',
    'md:col-span-7',
    'md:col-span-12',
  ];

  return (
    <Section spacing="default">
      <div className="flex items-baseline justify-between gap-6 mb-16">
        <div className="flex flex-col gap-6">
          <Eyebrow>{t('eyebrow')}</Eyebrow>
          <Heading size="display-md" style={{ maxWidth: '18ch' }}>
            {t('h2')}
          </Heading>
        </div>
        <Link
          href="/servizi"
          className="hidden md:inline-block text-sm uppercase tracking-[0.15em] hover:opacity-60 transition-opacity"
        >
          {t('viewAll')}
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-8">
        {services.map((s, idx) => (
          <Link
            key={s.slug}
            href={`/servizi/${s.slug}`}
            className={`group flex flex-col p-8 md:p-10 transition-colors ${spans[idx % spans.length]}`}
            style={{
              border: '1px solid var(--color-line)',
              minHeight: idx === 0 || idx === services.length - 1 ? '380px' : '320px',
            }}
          >
            <div className="flex items-start justify-between gap-6 mb-6">
              <span
                className="font-mono text-xs"
                style={{ color: 'var(--color-accent-deep)' }}
              >
                {String(idx + 1).padStart(2, '0')} / {String(services.length).padStart(2, '0')}
              </span>
              <span
                aria-hidden
                className="block h-px w-6 origin-left transition-transform duration-300 group-hover:scale-x-[1.6]"
                style={{ background: 'var(--color-accent)' }}
              />
            </div>

            <Heading
              as="h3"
              size={idx === services.length - 1 ? 'display-sm' : 'card'}
              className="mb-4"
            >
              {s.title}
            </Heading>

            <p
              className="text-base leading-relaxed flex-1 max-w-[50ch]"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {s.lead}
            </p>

            <span
              className="mt-8 inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] pb-1 self-start"
              style={{
                borderBottom: '1px solid currentColor',
                color: 'var(--color-ink)',
              }}
            >
              {t('readMore')}
              <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
            </span>
          </Link>
        ))}
      </div>
    </Section>
  );
}
