'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSlotCycle } from '@/hooks/useSlotCycle';

const SERVICES = ['e-commerce', 'sviluppo', 'SEO', 'WordPress'] as const;

interface HeroCycleProps {
  /** Pause flag for contexts that need to freeze the rotating token. */
  paused?: boolean;
  /** Cycle interval in ms. Default 2600. */
  intervalMs?: number;
}

const useIsoEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * HeroCycle — slot cycle for the home H1 trailing token.
 *
 * Width segue dinamicamente la parola corrente (con transition 280ms) — così
 * il `.` finale si attacca alla parola, NON resta fisso alla larghezza della
 * parola più lunga. La altezza è ridotta a 0.95em (line-height parent) per
 * evitare mismatch verticale con l'inline flow.
 *
 * Le transition tra slot usano translateY ± fade. Honors prefers-reduced-motion
 * via il hook (frozen on first item).
 */
export function HeroCycle({ paused = false, intervalMs = 2600 }: HeroCycleProps) {
  const { current, next, isAdvancing } = useSlotCycle({
    items: SERVICES,
    intervalMs,
    paused,
  });

  // The word currently *driving* the layout: during a transition we need the
  // container to expand to the incoming word's width so the slide-in lands at
  // the correct horizontal position. At rest, drive layout from `current`.
  const drivingWord = isAdvancing ? next : current;

  const measureRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  // Re-measure quando driving word cambia O fonts finiscono di caricare.
  // Usiamo un sandbox span offscreen perché measureRef è dentro inline-grid
  // e la sua getBoundingClientRect ritornerebbe la width allocata dal grid,
  // non la width naturale della parola — causando gap residuo dopo il punto.
  useIsoEffect(() => {
    const measure = () => {
      const ref = measureRef.current;
      if (!ref || typeof document === 'undefined') return;
      const computed = window.getComputedStyle(ref);
      const sandbox = document.createElement('span');
      sandbox.style.position = 'fixed';
      sandbox.style.left = '-9999px';
      sandbox.style.top = '-9999px';
      sandbox.style.visibility = 'hidden';
      sandbox.style.whiteSpace = 'nowrap';
      sandbox.style.fontFamily = computed.fontFamily;
      sandbox.style.fontSize = computed.fontSize;
      sandbox.style.fontWeight = computed.fontWeight;
      sandbox.style.fontStyle = computed.fontStyle;
      sandbox.style.letterSpacing = computed.letterSpacing;
      sandbox.style.fontStretch = computed.fontStretch;
      sandbox.textContent = drivingWord;
      document.body.appendChild(sandbox);
      const w = sandbox.getBoundingClientRect().width;
      document.body.removeChild(sandbox);
      setWidth(Math.ceil(w));
    };
    measure();
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(measure).catch(() => undefined);
    }
  }, [drivingWord]);

  // Pattern inline-grid: tutti i token (measurer + current + next) si stackano
  // nello stesso grid area "slot". L'altezza del container = altezza del token
  // più alto (incluso descender). La baseline è quella del primo in-flow item
  // (il measurer), che ha lo stesso glyph del current/next → baseline corretta
  // automaticamente. NO height esplicita, NO inset:0 absolute children, NO
  // paddingBottom (cause precedente del top-misalignment di "SEO").
  return (
    <span
      className="relative inline-grid align-baseline overflow-hidden"
      style={{
        gridTemplateAreas: '"slot"',
        lineHeight: 1,
        verticalAlign: 'baseline',
        color: 'var(--color-accent-deep)',
        width: width ?? 'auto',
        transition: 'width 280ms cubic-bezier(0.16,1,0.3,1)',
        // Spazio sotto la baseline per il descender (g/p/q). overflow-hidden
        // clippa solo oltre il padding-box, quindi il descender ci sta dentro.
        paddingBottom: '0.25em',
      }}
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Driver — fornisce baseline + altezza. Invisible ma nel layout. */}
      <span
        ref={measureRef}
        aria-hidden
        className="whitespace-nowrap"
        style={{ gridArea: 'slot', visibility: 'hidden' }}
      >
        {drivingWord}
      </span>

      {/* Current token (sovrapposto allo stesso slot) */}
      <span
        className="whitespace-nowrap"
        style={{
          gridArea: 'slot',
          transform: isAdvancing ? 'translateY(-100%)' : 'translateY(0)',
          transition: isAdvancing
            ? 'transform 280ms cubic-bezier(0.16,1,0.3,1), opacity 200ms ease-out'
            : 'none',
          opacity: isAdvancing ? 0 : 1,
        }}
      >
        {current}
      </span>

      {/* Incoming token (sovrapposto allo stesso slot) */}
      <span
        className="whitespace-nowrap"
        style={{
          gridArea: 'slot',
          transform: isAdvancing ? 'translateY(0)' : 'translateY(100%)',
          transition: isAdvancing
            ? 'transform 280ms cubic-bezier(0.16,1,0.3,1), opacity 200ms ease-in'
            : 'none',
          opacity: isAdvancing ? 1 : 0,
        }}
      >
        {next}
      </span>
    </span>
  );
}
