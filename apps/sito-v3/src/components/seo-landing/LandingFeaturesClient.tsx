'use client';

import { useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { Section } from '@/components/ui/Section';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface Feature {
  title: string;
  description: string;
}

interface LandingFeaturesClientProps {
  features: Feature[];
  index: string;
  heading: string;
  countLabel: string;
}

export function LandingFeaturesClient({
  features,
  index,
  heading,
  countLabel,
}: LandingFeaturesClientProps) {
  const root = useRef<HTMLElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useGSAP(
    () => {
      const r = root.current;
      if (!r) return;
      const items = gsap.utils.toArray<HTMLElement>('[data-feature]', r);
      if (
        prefersReducedMotion ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        gsap.set([r, ...items], { opacity: 1, y: 0 });
        return;
      }
      gsap.from(r, {
        opacity: 0,
        y: 16,
        duration: 0.2,
        ease: 'power2.out',
        scrollTrigger: { trigger: r, start: 'top 80%', once: true },
      });
      gsap.from(items, {
        opacity: 0,
        y: 12,
        duration: 0.18,
        stagger: 0.06,
        ease: 'power2.out',
        scrollTrigger: { trigger: r, start: 'top 78%', once: true },
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
          {index} — {heading}
        </p>
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {countLabel}
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
              className="col-span-10 md:col-span-5 font-[family-name:var(--font-display)] text-2xl md:text-3xl whitespace-pre-line"
              style={{ fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.1 }}
            >
              {f.title}
            </h3>
            <p
              data-desc
              className="col-span-12 md:col-span-6 text-base md:text-lg leading-relaxed self-center whitespace-pre-line"
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
