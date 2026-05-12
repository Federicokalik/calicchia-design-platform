'use client';

import { useEffect, useId, useRef } from 'react';
import { useScrollCollapse } from '@/hooks/useScrollCollapse';
import {
  CALICCHIA_PATHS,
  DESIGN_PATHS,
  TILDE_PATH,
  VIEWBOX_FULL,
  VIEWBOX_COLLAPSED,
} from './Logo.paths';
import styles from './Logo.module.css';

/** Durata animazione viewBox in ms. Sincronizzata con --motion-base nel CSS. */
const VIEWBOX_DURATION = 320;

interface LogoProps {
  /**
   * Stato controllato. Se omesso, il componente usa internamente useScrollCollapse.
   */
  collapsed?: boolean;
  /**
   * Soglia px per il trigger automatico (ignored se `collapsed` è esplicitamente passato).
   * Default: 80px.
   */
  scrollThreshold?: number;
  /**
   * className aggiuntiva per il container SVG.
   */
  className?: string;
}

/**
 * Easing standard cubic-bezier(0.4, 0, 0.2, 1) approssimato in JS.
 * Usato per l'animazione del viewBox via requestAnimationFrame.
 * Approssimazione cubica accettabile per durate < 500ms.
 */
function easeStandard(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Logo Calicchia Design con animazione di collapse swiss-revival.
 *
 * Comportamenti:
 * - Calicchia esce a sinistra (translateX -100% + opacity 0)
 * - Design esce verso il basso (translateY 100% + opacity 0, stagger 80ms)
 * - Tilde resta immobile, intensifica saturazione (opacity 0.85 → 1.0)
 * - viewBox si stringe attorno alla tilde mantenendo la scala
 *
 * @example
 * // Uncontrolled (gestisce scroll internamente)
 * <Logo />
 *
 * @example
 * // Controlled
 * <Logo collapsed={isScrolled} />
 *
 * @example
 * // Custom threshold
 * <Logo scrollThreshold={120} />
 */
export function Logo({
  collapsed: controlledCollapsed,
  scrollThreshold = 80,
  className = '',
}: LogoProps) {
  const internalCollapsed = useScrollCollapse(scrollThreshold);
  const collapsed = controlledCollapsed ?? internalCollapsed;

  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef<number | null>(null);

  // Animate viewBox via RAF.
  // Nota: il viewBox SVG è un attributo, non una property animabile via CSS.
  // Per questo serve interpolazione manuale.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const target = collapsed ? VIEWBOX_COLLAPSED : VIEWBOX_FULL;

    // Reduced motion: snap immediato senza animazione
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion) {
      svg.setAttribute('viewBox', target.join(' '));
      return;
    }

    // Parse stato corrente del viewBox
    const currentAttr = svg.getAttribute('viewBox');
    const current = currentAttr
      ? currentAttr.split(/[ ,]+/).map(Number)
      : [...VIEWBOX_FULL];

    // Cancella eventuale animazione in corso
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }

    const startTime = performance.now();

    const frame = (now: number) => {
      const t = Math.min((now - startTime) / VIEWBOX_DURATION, 1);
      const e = easeStandard(t);
      const vb = current.map((v, i) => v + (target[i] - v) * e);
      svg.setAttribute('viewBox', vb.join(' '));

      if (t < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(frame);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [collapsed]);

  return (
    <svg
      ref={svgRef}
      className={`${styles.logo} ${collapsed ? styles.collapsed : ''} ${className}`.trim()}
      viewBox={VIEWBOX_FULL.join(' ')}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby={titleId}
    >
      <title id={titleId}>Calicchia Design</title>

      {/* CALICCHIA — esce a sinistra in stato collapsed */}
      <g className={styles.calicchia} fill="currentColor">
        {CALICCHIA_PATHS.map((d, i) => (
          <path key={`c-${i}`} d={d} />
        ))}
      </g>

      {/* DESIGN — esce verso il basso in stato collapsed (stagger 80ms) */}
      <g className={styles.design} fill="currentColor">
        {DESIGN_PATHS.map((d, i) => (
          <path key={`d-${i}`} d={d} />
        ))}
      </g>

      {/* TILDE — anchor immobile, intensifica saturazione in stato collapsed */}
      <path className={styles.tilde} fill="#f57f44" d={TILDE_PATH} />
    </svg>
  );
}
