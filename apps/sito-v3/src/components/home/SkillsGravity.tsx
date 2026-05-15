'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Gravity, MatterBody, type GravityRef } from '@/components/motion/Gravity';

/**
 * "Strumenti che padroneggio" — gravity playground edition.
 *
 * Mirror della sezione TechStacks di /sito (12 tool: 8 stack tecnico + 4 AI),
 * ma in modalità tactile: icone + label cadono dall'alto e si fermano a metà
 * viewport. Icone monocromatiche (mask-image bianca o ink in base alla variante).
 */
const CHIPS: Array<{
  label: string;
  icon: string;
  x: string;
  y: string;
  angle?: number;
  variant: 'ink' | 'accent' | 'outline' | 'cream';
}> = [
  // Stack tecnico
  { label: 'Astro', icon: '/img/brands/astro.svg', x: '8%', y: '0%', variant: 'ink' },
  { label: 'React', icon: '/img/brands/react.svg', x: '22%', y: '4%', variant: 'outline', angle: -6 },
  { label: 'TypeScript', icon: '/img/brands/typescript.svg', x: '38%', y: '0%', variant: 'cream' },
  { label: 'Tailwind CSS', icon: '/img/brands/tailwindcss.svg', x: '54%', y: '6%', variant: 'ink', angle: 4 },
  { label: 'GSAP', icon: '/img/brands/greensock.svg', x: '70%', y: '0%', variant: 'accent' },
  { label: 'Three.js', icon: '/img/brands/threedotjs.svg', x: '85%', y: '4%', variant: 'outline', angle: -3 },
  { label: 'WordPress', icon: '/img/brands/wordpress.svg', x: '15%', y: '14%', variant: 'cream' },
  { label: 'Node.js', icon: '/img/brands/nodedotjs.svg', x: '32%', y: '12%', variant: 'ink', angle: 6 },
  // AI tools
  { label: 'Claude', icon: '/img/brands/claude.svg', x: '50%', y: '14%', variant: 'accent', angle: -4 },
  { label: 'ChatGPT', icon: '/img/brands/chatgpt.svg', x: '66%', y: '12%', variant: 'outline' },
  { label: 'Gemini', icon: '/img/brands/googlegemini.svg', x: '80%', y: '14%', variant: 'cream', angle: 8 },
  { label: 'Perplexity', icon: '/img/brands/perplexity.svg', x: '92%', y: '8%', variant: 'ink' },
];

const VARIANT_STYLES: Record<typeof CHIPS[number]['variant'], React.CSSProperties> = {
  ink: { background: 'var(--color-ink)', color: '#FAFAF7', border: '1px solid var(--color-ink)' },
  accent: { background: 'var(--color-accent)', color: 'var(--color-accent-ink)', border: '1px solid var(--color-accent)' },
  outline: { background: 'transparent', color: 'var(--color-ink)', border: '1px solid var(--color-ink)' },
  cream: { background: '#FAFAF7', color: 'var(--color-ink)', border: '1px solid var(--color-line)' },
};

/** Returns CSS color for the monochrome icon, matching the chip's foreground color. */
function iconColorFor(variant: typeof CHIPS[number]['variant']): string {
  switch (variant) {
    case 'ink':
    case 'accent':
      return '#FAFAF7';
    case 'outline':
    case 'cream':
      return 'var(--color-ink)';
  }
}

interface SkillsGravityProps {
  index?: string;
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  counterLabel?: string;
}

export function SkillsGravity({
  index = '04',
  eyebrow,
  title,
  subtitle,
  counterLabel,
}: SkillsGravityProps = {}) {
  const t = useTranslations('home.skillsGravity');
  const eyebrowText = eyebrow ?? t('eyebrowDefault');
  const titleText = title ?? t('titleDefault');
  const subtitleText = subtitle ?? t('subtitleDefault');
  const counterLabelText = counterLabel ?? t('counterLabel');
  const root = useRef<HTMLElement>(null);
  const playgroundRef = useRef<HTMLDivElement>(null);
  const gravityRef = useRef<GravityRef>(null);
  const [staticMode, setStaticMode] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia(
      '(min-width: 768px) and (prefers-reduced-motion: no-preference)'
    );
    setStaticMode(!mq.matches);
    const handler = (e: MediaQueryListEvent) => setStaticMode(!e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Start physics only when playground enters viewport (so user sees the
  // items fall). Pause when it leaves — saves CPU and prevents drift while
  // pin sections (WorksHorizontal) take over the scroll.
  useEffect(() => {
    if (staticMode) return;
    const el = playgroundRef.current;
    if (!el) return;
    let firstStart = false;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.3) {
            if (!firstStart) {
              firstStart = true;
              // Tiny delay on first visit so the user sees the section first
              setTimeout(() => gravityRef.current?.start(), 150);
            } else {
              gravityRef.current?.start();
            }
          } else if (!e.isIntersecting) {
            // Pause when fully out of viewport (saves CPU during pin scroll)
            gravityRef.current?.stop();
          }
        }
      },
      { threshold: [0, 0.3] }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [staticMode]);

  return (
    <section
      ref={root}
      className="relative px-6 md:px-10 lg:px-14 py-32 md:py-44 max-w-[1600px] mx-auto"
    >
      <div className="flex items-baseline justify-between gap-6 mb-16 md:mb-20">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {eyebrowText}
        </p>
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {CHIPS.length} {counterLabelText}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 mb-12 md:mb-16 items-end">
        <div className="md:col-span-7">
          <h2 className="font-[family-name:var(--font-display)] max-w-[18ch]">
            {titleText}
          </h2>
        </div>
        <div className="md:col-span-5 md:justify-self-end flex flex-col gap-3 md:items-end">
          <p
            className="text-base leading-relaxed max-w-[42ch]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {subtitleText}
          </p>
          <button
            type="button"
            onClick={() => gravityRef.current?.reset()}
            aria-label={t('resetAriaLabel')}
            className="self-start md:self-end inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] border-b pb-1 hover:gap-3 transition-all min-h-[44px]"
            style={{ borderColor: 'var(--color-ink)' }}
          >
            {t('resetButton')}
            <span aria-hidden>↺</span>
          </button>
        </div>
      </div>

      {/* Accessible list — screen readers + keyboard always get the full list */}
      <ul className="sr-only" aria-label={t('stackListLabel')}>
        {CHIPS.map((c) => (
          <li key={c.label}>{c.label}</li>
        ))}
      </ul>

      {staticMode ? (
        // Mobile / reduced-motion fallback — static asymmetric chip grid
        <div
          className="relative w-full p-8 md:p-12 flex flex-wrap gap-3 md:gap-4 justify-center"
          style={{
            background: 'var(--color-bg)',
            borderTop: '1px solid var(--color-line)',
            borderBottom: '1px solid var(--color-line)',
          }}
          aria-hidden
        >
          {CHIPS.map((c) => (
            <Chip key={c.label} chip={c} />
          ))}
        </div>
      ) : (
        <div
          ref={playgroundRef}
          className="relative w-full overflow-hidden"
          style={{
            height: '50vh',
            background: 'var(--color-bg)',
            borderTop: '1px solid var(--color-line)',
            borderBottom: '1px solid var(--color-line)',
          }}
          aria-hidden
        >
          <Gravity
            ref={gravityRef}
            gravity={{ x: 0, y: 0.6 }}
            grabCursor
            autoStart={false}
            resetOnResize
            addTopWall={false}
            className="w-full h-full"
          >
            {CHIPS.map((c) => (
              <MatterBody
                key={c.label}
                x={c.x}
                y={c.y}
                angle={c.angle ?? 0}
                matterBodyOptions={{
                  friction: 0.4,
                  restitution: 0.32,
                  density: 0.0014,
                }}
              >
                <Chip chip={c} draggable />
              </MatterBody>
            ))}
          </Gravity>
        </div>
      )}
    </section>
  );
}

function Chip({
  chip,
  draggable = false,
}: {
  chip: typeof CHIPS[number];
  draggable?: boolean;
}) {
  return (
    <div
      className={`select-none whitespace-nowrap font-[family-name:var(--font-display)] inline-flex items-center gap-2.5 px-5 py-3 ${
        draggable ? 'hover:cursor-grab active:cursor-grabbing' : ''
      }`}
      style={{
        ...VARIANT_STYLES[chip.variant],
        fontWeight: 500,
        fontSize: '1rem',
        letterSpacing: '-0.005em',
        lineHeight: 1,
        borderRadius: 2,
      }}
    >
      {/* Monochrome icon via CSS mask — color matches chip foreground */}
      <span
        aria-hidden
        className="inline-block shrink-0"
        style={{
          width: 20,
          height: 20,
          background: iconColorFor(chip.variant),
          WebkitMask: `url(${chip.icon}) center/contain no-repeat`,
          mask: `url(${chip.icon}) center/contain no-repeat`,
        }}
      />
      <span>{chip.label}</span>
    </div>
  );
}
