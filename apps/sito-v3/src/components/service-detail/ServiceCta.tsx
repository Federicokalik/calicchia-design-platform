'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { gsap, useGSAP } from '@/lib/gsap';
import { Body } from '@/components/ui/Body';
import { Button } from '@/components/ui/Button';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface ServiceCtaProps {
  serviceTitle: string;
  serviceSlug: string;
  index?: string;
}

export function ServiceCta({ serviceSlug, index = '06' }: ServiceCtaProps) {
  const t = useTranslations('servizi.detail');
  const root = useRef<HTMLElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useGSAP(
    () => {
      const r = root.current;
      if (!r) return;
      const content = r.querySelector<HTMLElement>('[data-cta-content]');
      if (!content) return;
      if (
        prefersReducedMotion ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        gsap.set(content, { opacity: 1 });
        return;
      }
      gsap.from(content, {
        opacity: 0,
        duration: 0.2,
        ease: 'power2.out',
        scrollTrigger: { trigger: r, start: 'top 80%', once: true },
      });
    },
    { scope: root, dependencies: [prefersReducedMotion], revertOnUpdate: true }
  );

  return (
    <Section ref={root} spacing="epic" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-16">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} - {t('ctaEyebrow')}
        </p>
      </div>

      <div
        data-cta-content
        className="grid grid-cols-1 md:grid-cols-12 gap-12 items-end"
      >
        <div className="md:col-span-9">
          <Heading as="h2" size="display-xl" className="max-w-[16ch]">
            {t('ctaTitle')}
          </Heading>
          <Body size="lg" tone="secondary" className="mt-6 max-w-[48ch]">
            {t('ctaSubtitle')}
          </Body>
        </div>

        <div className="md:col-span-3 md:justify-self-end">
          <Button
            href={`/contatti?service=${serviceSlug}`}
            size="lg"
            className="swiss-hover-card hover:-translate-y-px motion-reduce:hover:translate-y-0"
          >
            {t('ctaButton')}
            <span aria-hidden>→</span>
          </Button>
        </div>
      </div>
    </Section>
  );
}
