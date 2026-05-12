'use client';

import { useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { Section } from '@/components/ui/Section';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface LandingComboAngleClientProps {
  intro: string;
  angle: string;
  index: string;
  eyebrow: string;
}

export function LandingComboAngleClient({
  intro,
  angle,
  index,
  eyebrow,
}: LandingComboAngleClientProps) {
  const root = useRef<HTMLElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useGSAP(
    () => {
      const r = root.current;
      if (!r) return;
      const content = r.querySelector<HTMLElement>('[data-combo-content]');
      if (!content) return;
      if (
        prefersReducedMotion ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        gsap.set(content, { opacity: 1, y: 0 });
        return;
      }
      gsap.from(content, {
        opacity: 0,
        y: 16,
        duration: 0.2,
        ease: 'power2.out',
        scrollTrigger: { trigger: r, start: 'top 78%', once: true },
      });
    },
    { scope: root, dependencies: [prefersReducedMotion], revertOnUpdate: true }
  );

  return (
    <Section ref={root} spacing="compact" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-12">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {eyebrow}
        </p>
      </div>
      <div data-combo-content>
        <p
          className="font-[family-name:var(--font-display)] mb-8 max-w-[28ch] whitespace-pre-line"
          style={{
            fontSize: 'clamp(1.75rem, 3vw, 2.75rem)',
            fontWeight: 500,
            letterSpacing: '-0.025em',
            lineHeight: 1.1,
          }}
        >
          {intro}
        </p>
        <p
          className="text-lg md:text-xl leading-relaxed max-w-[60ch] whitespace-pre-line"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {angle}
        </p>
      </div>
    </Section>
  );
}
