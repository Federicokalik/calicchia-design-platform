import { useTranslations } from 'next-intl';
import { Section } from '@/components/ui/Section';
import type { ServiceFeature } from '@/data/services-detail';

interface ServiceFeaturesProps {
  features: ServiceFeature[];
  index?: string;
}

export function ServiceFeatures({ features, index = '02' }: ServiceFeaturesProps) {
  const t = useTranslations('servizi.detail');

  return (
    <Section spacing="default" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-16 md:mb-24">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {t('deliverables')}
        </p>
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('featuresCount', { count: features.length })}
        </span>
      </div>

      <ol className="flex flex-col">
        {features.map((f, i) => (
          <li
            key={i}
            data-feature
            className="grid grid-cols-12 gap-6 md:gap-12 py-10 md:py-14"
            style={{
              borderTop: i === 0 ? '1px solid var(--color-line)' : undefined,
              borderBottom: '1px solid var(--color-line)',
            }}
          >
            <span
              className="col-span-2 md:col-span-1 font-mono text-xs pt-2 tabular-nums"
              style={{ color: 'var(--color-accent-deep)' }}
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3
              data-title
              className="col-span-10 md:col-span-5 font-[family-name:var(--font-display)] text-2xl md:text-3xl"
              style={{ fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.1 }}
            >
              {f.title}
            </h3>
            <p
              data-desc
              className="col-span-12 md:col-span-6 text-base md:text-lg leading-relaxed self-center whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {f.description}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
