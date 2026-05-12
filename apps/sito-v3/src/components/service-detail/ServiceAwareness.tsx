'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { gsap, useGSAP } from '@/lib/gsap';
import { Body } from '@/components/ui/Body';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import type { ServiceAwareness as ServiceAwarenessData } from '@/data/services-detail';

interface ServiceAwarenessProps {
  data: ServiceAwarenessData;
  /** Section number (e.g. "01" — appears as eyebrow) */
  index?: string;
}

export function ServiceAwareness({ data, index = '01' }: ServiceAwarenessProps) {
  const t = useTranslations('servizi.detail');
  const root = useRef<HTMLElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useGSAP(
    () => {
      const r = root.current;
      if (!r) return;
      const items = gsap.utils.toArray<HTMLElement>('[data-awareness-item]', r);
      if (!items.length) return;
      if (
        prefersReducedMotion ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        gsap.set(items, { opacity: 1, y: 0 });
        return;
      }
      gsap.from(items, {
        y: 16,
        opacity: 0,
        duration: 0.2,
        stagger: 0.06,
        ease: 'power2.out',
        scrollTrigger: { trigger: r, start: 'top 75%', once: true },
      });
    },
    { scope: root, dependencies: [prefersReducedMotion], revertOnUpdate: true }
  );

  return (
    <Section ref={root} spacing="default" bordered="top">
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
