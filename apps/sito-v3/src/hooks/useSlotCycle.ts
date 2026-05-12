'use client';

import { useEffect, useRef, useState } from 'react';

interface UseSlotCycleOptions {
  /** Items to cycle through. Loops at end. */
  items: readonly string[];
  /** Pause between transitions (ms). Default 2600. */
  intervalMs?: number;
  /** External pause flag (e.g. on hover or focus-within). */
  paused?: boolean;
  /** Initial index. Default 0. */
  startIndex?: number;
  /** Random offset on mount so two columns desync. Default false. */
  desync?: boolean;
}

interface SlotState {
  /** Current visible item. */
  current: string;
  /** Incoming next item (rendered behind for tween). */
  next: string;
  /** True for one tick when transitioning — drives the tween. */
  isAdvancing: boolean;
  /** Index of the next item (for keys). */
  index: number;
}

/**
 * RAF-driven slot cycle.
 *
 * - Honors `prefers-reduced-motion` by freezing on first item (no cycle).
 * - Pauses when `paused` is true (hover / focus-within).
 * - `desync: true` adds a random initial delay so two slots don't sync.
 *
 * This is JS-only state — the consumer renders the visual transition
 * (e.g. via GSAP yPercent tween between `current` and `next`).
 */
export function useSlotCycle({
  items,
  intervalMs = 2600,
  paused = false,
  startIndex = 0,
  desync = false,
}: UseSlotCycleOptions): SlotState {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const [index, setIndex] = useState(startIndex % items.length);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reducedMotion || paused || items.length < 2) return;

    const initialDelay = desync ? Math.random() * intervalMs * 0.7 : 0;
    let cancelled = false;

    const schedule = (delay: number) => {
      timeoutRef.current = setTimeout(() => {
        if (cancelled) return;
        setIsAdvancing(true);
        // After the visual transition (~0.6s), commit the new index and reset the flag.
        timeoutRef.current = setTimeout(() => {
          if (cancelled) return;
          setIndex((i) => (i + 1) % items.length);
          setIsAdvancing(false);
          schedule(intervalMs);
        }, 600);
      }, delay);
    };

    schedule(initialDelay > 0 ? initialDelay : intervalMs);

    return () => {
      cancelled = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [reducedMotion, paused, items, intervalMs, desync]);

  const current = items[index] ?? '';
  const next = items[(index + 1) % items.length] ?? '';

  return { current, next, isAdvancing, index };
}
