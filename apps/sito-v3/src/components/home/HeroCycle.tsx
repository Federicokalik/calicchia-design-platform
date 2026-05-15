'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

interface HeroCycleProps {
  /** Pause flag for contexts that need to freeze the rotating token. */
  paused?: boolean;
  /** Hold duration (ms) once a word is fully typed. Default 1800. */
  holdMs?: number;
  /** Per-grapheme reveal interval (ms). Default 70. */
  typeIntervalMs?: number;
  /**
   * Per-grapheme un-type (erase) interval (ms). Default = typeIntervalMs × 0.6.
   * Erasing is slightly faster than typing — matches keyboard rhythm.
   */
  unTypeIntervalMs?: number;
  /** Pause (ms) between fully-erased state and the next word's typing. Default 140. */
  gapMs?: number;
}

const useIsoEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type Phase = 'typing' | 'holding' | 'unTyping' | 'gap';

/**
 * Grapheme-aware split — covers accented chars / emoji / complex scripts.
 * Falls back to `Array.from` (codepoint split) on browsers without
 * `Intl.Segmenter` (Safari < 16.4 e.g.).
 */
function graphemesOf(word: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter('it', { granularity: 'grapheme' });
    return Array.from(seg.segment(word), (s) => s.segment);
  }
  return Array.from(word);
}

/**
 * HeroCycle — typing cycle for the home H1 trailing token.
 *
 * Motion contract (Swiss editorial — performative typography, NOT terminal
 * pastiche):
 *  - Entry: char-by-char reveal, ~70ms per grapheme, static hairline caret.
 *  - Hold: full word visible for `holdMs` (default 1800ms).
 *  - Exit: REVERSE typing — graphemes erase right-to-left at `unTypeIntervalMs`
 *    (~42ms per grapheme by default, ~0.6× the typing speed). Mirrors a real
 *    keyboard backspace cadence (delete is faster than typing).
 *  - Gap: brief 140ms beat with empty cell before the next word starts typing
 *    — gives the eye a moment to register the change.
 *
 * Width follows the FULL current word (not the partial reveal) so the trailing
 * `.` doesn't dance during typing. Width transitions softly between words
 * via `transition: width 320ms`.
 *
 * Honors `prefers-reduced-motion` by freezing on first item with full text.
 */
export function HeroCycle({
  paused = false,
  holdMs = 1800,
  typeIntervalMs = 70,
  unTypeIntervalMs,
  gapMs = 140,
}: HeroCycleProps) {
  const eraseInterval = unTypeIntervalMs ?? Math.round(typeIntervalMs * 0.6);
  const t = useTranslations('home.hero');
  const services = useMemo<readonly string[]>(() => {
    const raw = t.raw('cycleItems');
    return Array.isArray(raw) && raw.length > 0
      ? (raw as string[])
      : ['e-commerce'];
  }, [t]);

  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const h = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('typing');
  const [revealed, setRevealed] = useState(0);

  const word = services[index] ?? '';
  const graphemes = useMemo(() => graphemesOf(word), [word]);

  // State machine: typing → holding → unTyping → gap → (advance) → typing …
  useEffect(() => {
    if (paused) return;

    // Reduced motion / single item: freeze on full word, no cycling.
    if (reducedMotion || services.length < 2) {
      setRevealed(graphemes.length);
      setPhase('holding');
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (phase === 'typing') {
      if (revealed < graphemes.length) {
        timer = setTimeout(() => {
          if (!cancelled) setRevealed((r) => r + 1);
        }, typeIntervalMs);
      } else {
        setPhase('holding');
      }
    } else if (phase === 'holding') {
      timer = setTimeout(() => {
        if (!cancelled) setPhase('unTyping');
      }, holdMs);
    } else if (phase === 'unTyping') {
      if (revealed > 0) {
        timer = setTimeout(() => {
          if (!cancelled) setRevealed((r) => Math.max(0, r - 1));
        }, eraseInterval);
      } else {
        setPhase('gap');
      }
    } else if (phase === 'gap') {
      timer = setTimeout(() => {
        if (cancelled) return;
        setIndex((i) => (i + 1) % services.length);
        setPhase('typing');
      }, gapMs);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    phase,
    revealed,
    graphemes.length,
    services.length,
    reducedMotion,
    paused,
    typeIntervalMs,
    eraseInterval,
    holdMs,
    gapMs,
  ]);

  // Width measurement: always use the FULL current word so the layout doesn't
  // jitter as graphemes are revealed. Same offscreen sandbox approach as
  // before (inline-grid would otherwise return the allocated cell width).
  const measureRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);

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
      sandbox.textContent = word;
      document.body.appendChild(sandbox);
      const w = sandbox.getBoundingClientRect().width;
      document.body.removeChild(sandbox);
      setWidth(Math.ceil(w));
    };
    measure();
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(measure).catch(() => undefined);
    }
  }, [word]);

  const typed = useMemo(
    () => graphemes.slice(0, revealed).join(''),
    [graphemes, revealed],
  );
  // Caret visible during active composition/erasure (NOT during hold/gap so
  // the eye gets a beat of stable typography between cycles). Static hairline
  // — no blink, no terminal pastiche.
  const showCaret =
    !reducedMotion && (phase === 'typing' || phase === 'unTyping');

  return (
    <span
      className="relative inline-grid align-baseline overflow-hidden"
      style={{
        gridTemplateAreas: '"slot"',
        lineHeight: 1,
        verticalAlign: 'baseline',
        color: 'var(--color-accent-deep)',
        width: width ?? 'auto',
        transition: 'width 320ms cubic-bezier(0.16,1,0.3,1)',
        paddingBottom: '0.25em',
      }}
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Baseline driver — full word, invisible but in flow so the cell
          has the correct intrinsic height + baseline. */}
      <span
        ref={measureRef}
        aria-hidden
        className="whitespace-nowrap"
        style={{ gridArea: 'slot', visibility: 'hidden' }}
      >
        {word}
      </span>

      {/* Composed word — typed graphemes + trailing hairline caret. Exit is
          the reverse of entry (un-typing), not a slide. */}
      <span className="whitespace-nowrap" style={{ gridArea: 'slot' }}>
        {typed}
        {showCaret && (
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 1,
              height: '0.85em',
              marginLeft: 2,
              verticalAlign: '-0.05em',
              background: 'var(--color-accent)',
            }}
          />
        )}
      </span>
    </span>
  );
}
