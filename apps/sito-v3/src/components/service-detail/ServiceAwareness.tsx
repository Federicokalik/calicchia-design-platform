import { useTranslations } from 'next-intl';
import { Body } from '@/components/ui/Body';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';
import type { ServiceAwareness as ServiceAwarenessData } from '@/data/services-detail';

interface ServiceAwarenessProps {
  data: ServiceAwarenessData;
  /** Section number (e.g. "01" — appears as eyebrow) */
  index?: string;
}

export function ServiceAwareness({ data, index = '01' }: ServiceAwarenessProps) {
  const t = useTranslations('servizi.detail');

  return (
    <Section spacing="default" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-16 md:mb-24">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {t('awarenessEyebrow')}
        </p>
      </div>

      <Heading size="display-md" className="mb-8" style={{ maxWidth: '20ch' }}>
        {data.title}
      </Heading>
      <p
        className="body-longform text-lg md:text-xl leading-relaxed max-w-[80ch] mb-16 whitespace-pre-line text-justify"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        {data.subtitle}
      </p>

      <ul role="list" className="flex flex-col">
        {data.problems.map((p, i) => (
          <li
            key={p.title}
            data-awareness-item
            className="grid grid-cols-12 gap-6 py-8 md:py-10 border-t border-hairline"
            style={{
              borderBottom:
                i === data.problems.length - 1 ? '1px solid var(--color-border)' : undefined,
            }}
          >
            <MonoLabel
              tone="accent"
              className="col-span-2 md:col-span-1 pt-2 tabular-nums"
            >
              {String(i + 1).padStart(2, '0')}
            </MonoLabel>
            <Heading
              as="h3"
              size="card"
              className="col-span-10 md:col-span-7"
            >
              {p.title}
            </Heading>
            <Body
              tone="secondary"
              className="col-span-12 md:col-span-3 md:col-start-10 whitespace-pre-line text-justify"
            >
              {p.desc}
            </Body>
          </li>
        ))}
      </ul>
    </Section>
  );
}
