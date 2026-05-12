/**
 * Easing & timing tokens shared between CSS (tokens.css) and JS (GSAP tweens).
 * Keep in sync with `--ease-*` and `--motion-*` custom properties.
 */
export const ease = {
  outQuint: 'cubic-bezier(0.22, 1, 0.36, 1)',
  expoOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  inOutQuart: 'cubic-bezier(0.76, 0, 0.24, 1)',
} as const;

export const duration = {
  micro: 0.18,    // hover / press
  short: 0.32,    // small transitions
  base: 0.6,      // default
  long: 0.9,      // hero reveals
  cinematic: 1.4, // case study hero
} as const;

export const stagger = {
  tight: 0.04,
  base: 0.08,
  loose: 0.14,
} as const;

/**
 * Reveal presets — config objects (not running tweens). Caller owns the
 * timeline and the `useGSAP({ scope })` boundary. Use `reveal-presets.ts`
 * for the helper factories that consume these into a `gsap.from()` config.
 *
 * Single source of truth so heroes (CaseHero / ServiceHero / LandingHero /
 * BlogHero / HeroNarrative) stop drifting in micro-timing.
 */
export const reveal = {
  text: {
    duration: duration.long,
    ease: ease.expoOut,
    stagger: stagger.tight,
    yPercent: 110,
  },
  eyebrow: {
    duration: duration.base,
    ease: ease.expoOut,
    y: 12,
  },
  meta: {
    duration: duration.base,
    ease: ease.expoOut,
    y: 8,
  },
  image: {
    duration: duration.cinematic,
    ease: ease.expoOut,
    fromScale: 1.08,
    toScale: 1,
  },
  clipReveal: {
    duration: duration.cinematic,
    ease: ease.expoOut,
  },
} as const;

export type RevealPreset = keyof typeof reveal;
