'use client';

import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';
import { CLIENTS } from '@/data/clients';
import { TrustIndexEmbed } from './TrustIndexEmbed';

const ROTATION_MS = 4500;

/**
 * Trust block — editorial, not "bento card".
 *
 * Two columns, divided by hairlines (1px var(--color-line)):
 *   Left  (8/12) — TrustIndex Google Reviews widget
 *   Right (4/12) — sample of client logos with honest caption
 *
 * No rounded cards, no diffusion shadows — sticks to the Swiss-restraint
 * pattern used by StatsSection and the rest of the home.
 */
export function TrustBento() {
  const t = useTranslations('home.trust');
  const root = useRef<HTMLElement>(null);
  const [activeClient, setActiveClient] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const visibleClients = CLIENTS.filter((c) => c.url && c.url !== '#' && c.logo);

  // Auto-rotate; pause on hover/focus and when reduced motion is preferred.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (isPaused) return;
    if (visibleClients.length < 2) return;
    const t = window.setInterval(() => {
      setActiveClient((prev) => (prev + 1) % visibleClients.length);
    }, ROTATION_MS);
    return () => window.clearInterval(t);
  }, [isPaused, visibleClients.length]);

  const current = visibleClients[activeClient];
  const hostname = current
    ? (() => {
        try {
          return new URL(current.url).hostname.replace(/^www\./, '');
        } catch {
          return current.url;
        }
      })()
    : '';

  useGSAP(
    () => {
      const r = root.current;
      if (!r) return;
      const mm = gsap.matchMedia();
      mm.add(
        {
          motion: '(prefers-reduced-motion: no-preference)',
          reduced: '(prefers-reduced-motion: reduce)',
        },
        (ctx) => {
          if (ctx.conditions?.reduced) return;
          const blocks = gsap.utils.toArray<HTMLElement>('[data-trust-block]', r);
          if (!blocks.length) return;
          gsap.set(blocks, { y: 32, opacity: 0 });
          gsap.to(blocks, {
            y: 0,
            opacity: 1,
            duration: 0.85,
            ease: 'expo.out',
            stagger: 0.1,
            scrollTrigger: { trigger: r, start: 'top 75%', once: true },
          });
        }
      );
    },
    { scope: root }
  );

  return (
    <Section
      ref={root}
      spacing="default"
      bordered="top"
      aria-labelledby="trust-heading"
    >
      <div className="flex items-baseline justify-between gap-6 mb-12 md:mb-20">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {t('eyebrow')}
        </p>
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('subtitle')}
        </span>
      </div>

      <Heading
        id="trust-heading"
        size="display-lg"
        className="mb-16 md:mb-24"
        style={{ maxWidth: '18ch' }}
      >
        {t('h2')}
      </Heading>

      <div
        className="grid grid-cols-1 md:grid-cols-12"
        style={{
          borderTop: '1px solid var(--color-line)',
          borderBottom: '1px solid var(--color-line)',
        }}
      >
        {/* Reviews */}
        <div
          data-trust-block
          className="md:col-span-8 py-10 md:py-14 md:pr-12"
          style={{
            borderRight: '1px solid var(--color-line)',
          }}
        >
          <p
            className="font-mono text-xs uppercase tracking-[0.22em] mb-6"
            style={{ color: 'var(--color-ink-subtle)' }}
          >
            {t('reviewsLabel')}
          </p>
          <TrustIndexEmbed />
        </div>

        {/* Clients sample — one visible at a time, project preview + meta */}
        <div
          data-trust-block
          className="md:col-span-4 py-10 md:py-14 md:pl-12 flex flex-col"
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
          onFocusCapture={() => setIsPaused(true)}
          onBlurCapture={() => setIsPaused(false)}
        >
          <div className="flex items-baseline justify-between gap-4 mb-6">
            <p
              className="font-mono text-xs uppercase tracking-[0.22em]"
              style={{ color: 'var(--color-ink-subtle)' }}
            >
              {t('clientsLabel')}
            </p>
            {visibleClients.length > 0 && (
              <span
                className="font-mono text-xs tabular-nums"
                style={{ color: 'var(--color-ink-subtle)' }}
                aria-live="polite"
              >
                {String(activeClient + 1).padStart(2, '0')} / {String(visibleClients.length).padStart(2, '0')}
              </span>
            )}
          </div>

          {/* Slide: logo crossfade — fills available height */}
          <div
            className="relative overflow-hidden mb-6 flex-1 min-h-[14rem]"
            aria-roledescription="carousel"
            aria-label={t('logosAriaLabel')}
            style={{ borderTop: '1px solid var(--color-line)', borderBottom: '1px solid var(--color-line)' }}
          >
            {visibleClients.map((c, i) => {
              const isActive = i === activeClient;
              return (
                <div
                  key={c.name}
                  aria-hidden={!isActive}
                  className="absolute inset-0 flex items-center justify-center transition-all duration-700 ease-out"
                  style={{
                    opacity: isActive ? 1 : 0,
                    transform: isActive
                      ? 'translateX(0)'
                      : i < activeClient
                        ? 'translateX(-32px)'
                        : 'translateX(32px)',
                  }}
                >
                  {c.logo && (
                    <Image
                      src={c.logo}
                      alt={t('logoAlt', { name: c.name })}
                      width={300}
                      height={120}
                      sizes="(min-width: 768px) 300px, 70vw"
                      className="max-h-[60%] max-w-[80%] object-contain"
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Slide caption — animated by `key={current.name}` */}
          {current && (
            <a
              key={current.name}
              href={current.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('openClientSite', { name: current.name })}
              className="group block transition-opacity duration-500"
              style={{ animation: 'fadeInUp 0.6s ease-out both' }}
            >
              <span
                aria-hidden
                className="block w-8 h-px mb-3"
                style={{ background: 'var(--color-accent-deep)' }}
              />
              <span
                className="block font-[family-name:var(--font-display)] text-2xl md:text-3xl mb-2 group-hover:[color:var(--color-accent-deep)] transition-colors"
                style={{ fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.1 }}
              >
                {current.name}
              </span>
              <span
                className="font-mono text-xs uppercase tracking-[0.18em] flex flex-wrap items-center gap-x-2 gap-y-1"
                style={{ color: 'var(--color-ink-muted)' }}
              >
                {current.industry && (
                  <>
                    <span>{current.industry}</span>
                    <span aria-hidden style={{ color: 'var(--color-ink-subtle)' }}>·</span>
                  </>
                )}
                <span>{hostname} →</span>
              </span>
            </a>
          )}

          {/* Pagination dots */}
          <div className="flex gap-2 mt-6" role="tablist" aria-label={t('clientPaginationLabel')}>
            {visibleClients.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="tab"
                aria-selected={i === activeClient}
                aria-label={t('showClient', { name: c.name })}
                onClick={() => setActiveClient(i)}
                className="h-9 inline-flex items-center"
              >
                <span
                  className="block transition-all"
                  style={{
                    width: i === activeClient ? '20px' : '8px',
                    height: '2px',
                    background:
                      i === activeClient ? 'var(--color-ink)' : 'var(--color-line-strong)',
                  }}
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
