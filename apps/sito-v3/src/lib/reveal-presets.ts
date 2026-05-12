/**
 * Reveal preset factories — `gsap.from()` config builders that share micro-
 * timing across all hero entry sequences. Caller still owns the timeline and
 * the `useGSAP({ scope })` boundary; these just emit the `from` argument.
 *
 * Why factories instead of just exporting the raw `reveal` config: callers
 * frequently need to override one field (e.g. add `delay`, change `y`) while
 * keeping the rest of the preset. Spreading at the call site is verbose; a
 * factory keeps the override surface small.
 */

import { reveal } from './motion-tokens';

type RevealOverride<T> = Partial<T> & { delay?: number };

interface TextRevealConfig {
  yPercent: number;
  duration: number;
  ease: string;
  stagger: number;
  delay?: number;
}

interface YRevealConfig {
  y: number;
  opacity: number;
  duration: number;
  ease: string;
  delay?: number;
}

interface ImageRevealConfig {
  scale: number;
  duration: number;
  ease: string;
  delay?: number;
}

interface ClipRevealConfig {
  clipPath: string;
  duration: number;
  ease: string;
  delay?: number;
}

/**
 * Words-up reveal — for headings split via SplitText. Apply on the line/word
 * elements: `gsap.from(target, revealText())`.
 */
export function revealText(over: RevealOverride<TextRevealConfig> = {}): TextRevealConfig {
  return {
    yPercent: reveal.text.yPercent,
    duration: reveal.text.duration,
    ease: reveal.text.ease,
    stagger: reveal.text.stagger,
    ...over,
  };
}

/**
 * Eyebrow reveal — y + opacity. Slower than meta, faster than text. Used on
 * the small mono/uppercase label above heroes.
 */
export function revealEyebrow(over: RevealOverride<YRevealConfig> = {}): YRevealConfig {
  return {
    y: reveal.eyebrow.y,
    opacity: 0,
    duration: reveal.eyebrow.duration,
    ease: reveal.eyebrow.ease,
    ...over,
  };
}

/**
 * Meta line reveal — small caption / role / date line. Subtler than eyebrow.
 */
export function revealMeta(over: RevealOverride<YRevealConfig> = {}): YRevealConfig {
  return {
    y: reveal.meta.y,
    opacity: 0,
    duration: reveal.meta.duration,
    ease: reveal.meta.ease,
    ...over,
  };
}

/**
 * Hero image scale-in. Pair with `clipPath: inset(0 0 0 0)` on the parent
 * for a Pentagram-style mask reveal.
 */
export function revealImage(over: RevealOverride<ImageRevealConfig> = {}): ImageRevealConfig {
  return {
    scale: reveal.image.fromScale,
    duration: reveal.image.duration,
    ease: reveal.image.ease,
    ...over,
  };
}

/**
 * Clip-path mask reveal — `clipPath: inset(100% 0 0 0)` → `inset(0)` over
 * cinematic duration. Caller wraps target in a container that owns the
 * mask (otherwise the inset clips the page background).
 */
export function revealClip(
  over: RevealOverride<ClipRevealConfig> & { from?: string } = {}
): ClipRevealConfig {
  const { from = 'inset(100% 0 0 0)', ...rest } = over;
  return {
    clipPath: from,
    duration: reveal.clipReveal.duration,
    ease: reveal.clipReveal.ease,
    ...rest,
  };
}
