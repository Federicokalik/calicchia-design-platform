'use client';

import { useTranslations } from 'next-intl';
import { Counter } from '@/components/motion/Counter';
import { Section } from '@/components/ui/Section';

interface StatsSectionProps {
  years: number;
}

export function StatsSection({ years }: StatsSectionProps) {
  const t = useTranslations('home.stats');

  const stats = [
    { value: 999, suffix: '+', label: t('linesOfCode') },
    { value: 99, suffix: '+', label: t('coffeeCups') },
    { value: years, suffix: '+', label: t('yearsExperience') },
    { value: 70, suffix: '+', label: t('projectsDelivered') },
  ];

  return (
    <Section spacing="compact">
      <div
        className="grid grid-cols-2 md:grid-cols-4"
        style={{
          borderTop: '1px solid var(--color-line)',
          borderBottom: '1px solid var(--color-line)',
        }}
      >
        {stats.map((s, idx) => (
          <div
            key={s.label}
            className="py-10 md:py-14 px-4 md:px-6 flex flex-col gap-3"
            style={{
              borderRight:
                idx < stats.length - 1 ? '1px solid var(--color-line)' : 'none',
              borderLeft: idx === 0 ? 'none' : undefined,
            }}
          >
            <Counter
              to={s.value}
              suffix={s.suffix}
              className="font-[family-name:var(--font-display)] text-5xl md:text-7xl tabular-nums"
            />
            <span
              className="text-xs md:text-sm uppercase tracking-[0.15em]"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {s.label}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}
