'use client';

import Image from 'next/image';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { gsap } from '@/lib/gsap';
import type { ApiBeforeAfterPair } from '@/lib/projects-api';

interface BeforeAfterSliderProps {
  pair: ApiBeforeAfterPair;
  /** Index in the parent collection — used for the "01 / N" counter. */
  position: number;
  total: number;
  /** Resolved label respecting current locale. */
  resolvedLabel: string | null;
  /** Localized BEFORE / AFTER caption strings (monospace, kept short). */
  beforeWord: string;
  afterWord: string;
  /** Accessible label for the range slider. */
  sliderAriaLabel: string;
  /** Localized hint text — keep it short. */
  hint: string;
}

const INITIAL_POSITION = 0.5;
const KEYBOARD_STEP = 0.05;
const KEYBOARD_LARGE_STEP = 0.1;

/**
 * Single before/after pair — drag slider with spring snap-back, full
 * keyboard a11y, and a CSS-only fallback for reduced-motion users.
 *
 * Implementation notes:
 *   - We avoid the GSAP Draggable plugin to keep the singleton small and
 *     keep keyboard control fully ours. Pointer events handle mouse + touch.
 *   - The "before" image sits on top with a `clip-path: inset(0 X% 0 0)`
 *     mask. The mask shrinks as position grows, revealing the "after"
 *     underneath. Animating clip-path is GPU-friendly enough for this
 *     single-shot interaction.
 *   - Reduced-motion users get a vertical stack (no drag, no JS interaction)
 *     so the comparison is still legible without motion.
 */
export function BeforeAfterSlider({
  pair,
  position,
  total,
  resolvedLabel,
  beforeWord,
  afterWord,
  sliderAriaLabel,
  hint,
}: BeforeAfterSliderProps) {
  const figureRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const beforeMaskRef = useRef<HTMLDivElement>(null);
  const sliderId = useId();

  const [sliderPosition, setSliderPosition] = useState(INITIAL_POSITION);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // ── Reduced-motion detection ─────────────────────────────────────
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // ── Position application (clip-path + handle x) ──────────────────
  // We write directly to the DOM during drag to avoid React state churn
  // on every pointermove (60+ updates/sec). React state still tracks the
  // committed value for aria-valuenow and keyboard logic.
  const applyPosition = useCallback((pos: number) => {
    const clamped = Math.max(0, Math.min(1, pos));
    if (beforeMaskRef.current) {
      const inset = (1 - clamped) * 100;
      beforeMaskRef.current.style.clipPath = `inset(0 ${inset}% 0 0)`;
    }
    if (handleRef.current && figureRef.current) {
      const width = figureRef.current.offsetWidth;
      handleRef.current.style.transform = `translate3d(${clamped * width}px, 0, 0)`;
    }
  }, []);

  // Sync DOM with reactive state changes (keyboard, programmatic).
  useEffect(() => {
    if (reducedMotion) return;
    applyPosition(sliderPosition);
  }, [sliderPosition, applyPosition, reducedMotion]);

  // Re-apply on resize so the handle x recomputes against the new width.
  useEffect(() => {
    if (reducedMotion) return;
    const onResize = () => applyPosition(sliderPosition);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sliderPosition, applyPosition, reducedMotion]);

  // ── Pointer handlers ─────────────────────────────────────────────
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (reducedMotion || !figureRef.current) return;
      event.preventDefault();
      const figure = figureRef.current;
      figure.setPointerCapture(event.pointerId);
      setIsDragging(true);

      const rect = figure.getBoundingClientRect();
      const pos = (event.clientX - rect.left) / rect.width;
      const clamped = Math.max(0, Math.min(1, pos));
      // Tween to where the user clicked (snappy but not instant).
      gsap.to(
        { v: sliderPosition },
        {
          v: clamped,
          duration: 0.18,
          ease: 'power2.out',
          onUpdate() {
            applyPosition(this.targets()[0].v);
          },
          onComplete: () => setSliderPosition(clamped),
        },
      );
    },
    [applyPosition, reducedMotion, sliderPosition],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (reducedMotion || !isDragging || !figureRef.current) return;
      const rect = figureRef.current.getBoundingClientRect();
      const pos = (event.clientX - rect.left) / rect.width;
      const clamped = Math.max(0, Math.min(1, pos));
      applyPosition(clamped);
    },
    [applyPosition, isDragging, reducedMotion],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (reducedMotion || !figureRef.current) return;
      figureRef.current.releasePointerCapture(event.pointerId);
      setIsDragging(false);
      // Commit the visual position to state (this is the value screen
      // readers / keyboard pick up after the drag).
      const rect = figureRef.current.getBoundingClientRect();
      const pos = (event.clientX - rect.left) / rect.width;
      setSliderPosition(Math.max(0, Math.min(1, pos)));
    },
    [reducedMotion],
  );

  // ── Keyboard handlers (on the handle button) ─────────────────────
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (reducedMotion) return;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = sliderPosition - KEYBOARD_STEP;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = sliderPosition + KEYBOARD_STEP;
        break;
      case 'PageDown':
        next = sliderPosition - KEYBOARD_LARGE_STEP;
        break;
      case 'PageUp':
        next = sliderPosition + KEYBOARD_LARGE_STEP;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setSliderPosition(Math.max(0, Math.min(1, next)));
  }, [reducedMotion, sliderPosition]);

  const counter = `${String(position + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  const ariaValueNow = Math.round(sliderPosition * 100);

  // ── Reduced-motion: vertical stack, no JS interaction ────────────
  if (reducedMotion) {
    return (
      <figure className="space-y-6">
        <header className="flex items-baseline justify-between gap-6">
          <span
            className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[0.22em]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {counter}
            {resolvedLabel ? <span className="ml-3">· {resolvedLabel}</span> : null}
          </span>
        </header>

        <div className="space-y-3">
          <p
            className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.28em]"
            style={{ color: 'var(--color-ink-subtle)' }}
          >
            {beforeWord}
          </p>
          <div
            className="relative aspect-[16/10] w-full overflow-hidden"
            style={{ background: 'var(--color-line)' }}
          >
            <Image
              src={pair.before.src}
              alt={pair.before.alt}
              width={pair.before.w ?? 2400}
              height={pair.before.h ?? 1500}
              sizes="(min-width: 1024px) 70vw, 100vw"
              className="w-full h-full object-cover"
            />
          </div>
        </div>

        <div className="space-y-3">
          <p
            className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.28em]"
            style={{ color: 'var(--color-ink-subtle)' }}
          >
            {afterWord}
          </p>
          <div
            className="relative aspect-[16/10] w-full overflow-hidden"
            style={{ background: 'var(--color-line)' }}
          >
            <Image
              src={pair.after.src}
              alt={pair.after.alt}
              width={pair.after.w ?? 2400}
              height={pair.after.h ?? 1500}
              sizes="(min-width: 1024px) 70vw, 100vw"
              className="w-full h-full object-cover"
            />
          </div>
        </div>

        {pair.note ? (
          <figcaption
            className="text-xs uppercase tracking-[0.18em]"
            style={{ color: 'var(--color-ink-subtle)' }}
          >
            {pair.note}
          </figcaption>
        ) : null}
      </figure>
    );
  }

  // ── Drag slider ──────────────────────────────────────────────────
  return (
    <figure className="space-y-5">
      {/* Counter + label rail above the figure (Bierut/Swiss meta line) */}
      <header className="flex items-baseline justify-between gap-6">
        <span
          className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[0.22em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {counter}
          {resolvedLabel ? <span className="ml-3">· {resolvedLabel}</span> : null}
        </span>
        <span
          className="hidden md:inline font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.22em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {hint}
        </span>
      </header>

      <div
        ref={figureRef}
        className="relative aspect-[16/10] w-full overflow-hidden select-none touch-none"
        style={{
          background: 'var(--color-line)',
          cursor: isDragging ? 'grabbing' : 'grab',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* AFTER layer — full-bleed background. */}
        <Image
          src={pair.after.src}
          alt={pair.after.alt}
          fill
          sizes="(min-width: 1024px) 70vw, 100vw"
          className="object-cover pointer-events-none"
          draggable={false}
        />

        {/* BEFORE layer — masked from the right. Inline default avoids
            a flash before the first useEffect tick on mount. */}
        <div
          ref={beforeMaskRef}
          className="absolute inset-0 pointer-events-none"
          style={{ clipPath: `inset(0 ${(1 - INITIAL_POSITION) * 100}% 0 0)` }}
        >
          <Image
            src={pair.before.src}
            alt={pair.before.alt}
            fill
            sizes="(min-width: 1024px) 70vw, 100vw"
            className="object-cover"
            draggable={false}
          />
        </div>

        {/* Corner caption labels — monospace, intentionally not translated. */}
        <span
          aria-hidden
          className="absolute top-4 left-4 px-2 py-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.22em]"
          style={{
            background: 'rgba(0,0,0,0.55)',
            color: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(4px)',
          }}
        >
          {beforeWord}
        </span>
        <span
          aria-hidden
          className="absolute top-4 right-4 px-2 py-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.22em]"
          style={{
            background: 'rgba(0,0,0,0.55)',
            color: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(4px)',
          }}
        >
          {afterWord}
        </span>

        {/* Handle: 1px vertical line + grab pill. transform-positioned via
            applyPosition() so it stays GPU-accelerated during drag. The
            translate is initialized inline to avoid the same first-tick flash
            as the mask. */}
        <button
          ref={handleRef}
          id={sliderId}
          type="button"
          role="slider"
          aria-label={sliderAriaLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ariaValueNow}
          onKeyDown={handleKeyDown}
          className="absolute top-0 left-0 h-full w-px focus:outline-none group"
          style={{ transform: `translate3d(0px, 0, 0)`, willChange: 'transform' }}
        >
          {/* Vertical 1px line */}
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-px"
            style={{ background: 'rgba(255,255,255,0.92)' }}
          />
          {/* Grab pill: small dark capsule centered on the line */}
          <span
            aria-hidden
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center transition-transform group-focus-visible:scale-110 group-hover:scale-110"
            style={{
              width: 40,
              height: 40,
              borderRadius: 9999,
              background: 'rgba(0,0,0,0.78)',
              border: '1px solid rgba(255,255,255,0.18)',
              backdropFilter: 'blur(6px)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.32)',
            }}
          >
            <span
              className="flex items-center gap-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.18em]"
              style={{ color: 'rgba(255,255,255,0.95)' }}
            >
              <span aria-hidden>‹</span>
              <span aria-hidden>›</span>
            </span>
          </span>
          {/* Focus ring — visible only on keyboard focus */}
          <span
            aria-hidden
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 group-focus-visible:opacity-100 transition-opacity"
            style={{
              width: 56,
              height: 56,
              boxShadow: '0 0 0 2px var(--color-focus, #fff)',
            }}
          />
        </button>
      </div>

      {pair.note ? (
        <figcaption
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {pair.note}
        </figcaption>
      ) : null}
    </figure>
  );
}
