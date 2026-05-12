'use client';

import Lenis from 'lenis';

/**
 * Default Lenis options — tuned to coexist with ScrollTrigger pin sections.
 *
 * `duration: 0.7` (was 1.1) reduces visual lag between native scroll position
 * (where ScrollTrigger fires) and Lenis's interpolated position. With longer
 * smoothing, pin engagement appears to "jump" because the user sees the lagging
 * visual but ScrollTrigger has already fired. 0.7 is the sweet spot for
 * editorial smooth feel + responsive pin.
 */
export const lenisOptions: ConstructorParameters<typeof Lenis>[0] = {
  duration: 0.7,
  easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), // expo.out
  smoothWheel: true,
  wheelMultiplier: 1,
  touchMultiplier: 1.4,
  // Disable on touch — iOS momentum + Lenis often jitters during pinning.
  syncTouch: false,
};

export { Lenis };
