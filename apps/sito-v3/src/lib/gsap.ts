'use client';

/**
 * GSAP singleton — registers all plugins exactly once on the client.
 * Every client component that needs GSAP must import from THIS file,
 * never directly from `gsap/...`, so registration runs only one time
 * even with React 19 StrictMode double-invocation.
 */
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Flip } from 'gsap/Flip';
import { Observer } from 'gsap/Observer';

declare global {
  interface Window {
    __gsap_registered?: boolean;
  }
}

if (typeof window !== 'undefined' && !window.__gsap_registered) {
  gsap.registerPlugin(useGSAP, ScrollTrigger, Flip, Observer);
  // Project-wide tween defaults — keep micro-interactions in 150–300ms band per UX guidelines.
  gsap.defaults({ duration: 0.6, ease: 'power2.out' });
  window.__gsap_registered = true;
}

export { gsap, useGSAP, ScrollTrigger, Flip, Observer };
