'use client';

import { useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { Button } from '@/components/ui/Button';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface LandingCtaClientProps {
  text: string;
  href: string;
  buttonLabel: string;
  index: string;
  eyebrow: string;
}

export function LandingCtaClient({
  text,
  href,
  buttonLabel,
  index,
  eyebrow,
}: LandingCtaClientProps) {
  const root = useRef<HTMLElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useGSAP(
    () => {
      const r = root.current;
      if (!r) return;
      const content = r.querySelector<HTMLElement>('[data-landing-cta-content]');
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
          {index} - {eyebrow}
        </p>
      </div>

      <div
        data-landing-cta-content
        className="grid grid-cols-1 md:grid-cols-12 gap-12 items-end"
      >
        <Heading as="h2" size="display-xl" className="md:col-span-9 max-w-[18ch]">
          {text}
        </Heading>

        <div className="md:col-span-3 md:justify-self-end">
          <Button
            href={href}
            size="lg"
            className="swiss-hover-card hover:-translate-y-px motion-reduce:hover:translate-y-0"
          >
            {buttonLabel}
            <span aria-hidden>→</span>
          </Button>
        </div>
      </div>
    </Section>
  );
}
