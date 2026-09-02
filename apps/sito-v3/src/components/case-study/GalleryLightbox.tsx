'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Asset } from '@/data/types';

export interface GalleryTile {
  span: number;
  start?: number;
  mt?: 'md' | 'lg';
}

interface GalleryLightboxLabels {
  open: string;
  close: string;
  prev: string;
  next: string;
  ariaLabel: string;
}

interface GalleryLightboxProps {
  assets: Asset[];
  tiles: GalleryTile[];
  labels: GalleryLightboxLabels;
}

// Classi literal — Tailwind v4 non rileva le template-string dinamiche.
const SPAN_CLASS: Record<number, string> = {
  4: 'md:col-span-4',
  5: 'md:col-span-5',
  7: 'md:col-span-7',
  8: 'md:col-span-8',
  12: 'md:col-span-12',
};
const START_CLASS: Record<number, string> = {
  3: 'md:col-start-3',
  9: 'md:col-start-9',
};
const MT_CLASS: Record<'md' | 'lg', string> = {
  md: 'md:mt-16',
  lg: 'md:mt-24 lg:mt-32',
};

const isVideoAsset = (a: Asset) => a.type === 'video' || !!a.video;

/**
 * Griglia galleria + lightbox a schermo intero.
 *
 * Pattern modale allineato a MenuOverlay: portal su body, `role="dialog"` +
 * `aria-modal`, focus trap, Escape/frecce, scroll lock, ripristino focus sul
 * trigger. Temato col design system (ink #111 di fondo, testo #FAFAF7, mono,
 * hairline `--color-border-inverse`, accent su hover). `prefers-reduced-motion`
 * disattiva il fade.
 */
export function GalleryLightbox({ assets, tiles, labels }: GalleryLightboxProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const openIndexRef = useRef<number | null>(null);
  openIndexRef.current = openIndex;
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const isOpen = openIndex !== null;
  const close = useCallback(() => setOpenIndex(null), []);
  const step = useCallback(
    (dir: 1 | -1) => {
      setOpenIndex((i) => (i === null ? i : (i + dir + assets.length) % assets.length));
    },
    [assets.length],
  );

  // Scroll lock + focus management. Deps: [isOpen] only — la navigazione
  // prev/next cambia openIndex ma NON deve ri-triggerare il ripristino focus.
  useEffect(() => {
    if (!isOpen) return;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = 'hidden';

    const previousActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeBtnRef.current?.focus(), 50);
    // Stable array ref — its contents change as tiles mount, but we want the
    // trigger for whatever index is showing when the lightbox closes.
    const triggers = triggerRefs.current;

    return () => {
      html.style.overflow = prevOverflow;
      window.clearTimeout(focusTimer);
      const restoreTo =
        (openIndexRef.current !== null && triggers[openIndexRef.current]) || previousActive;
      restoreTo?.focus();
    };
  }, [isOpen]);

  // Keyboard: Esc / frecce / Tab-trap.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close, step]);

  const active = openIndex !== null ? assets[openIndex] : null;

  return (
    <>
      <div className="grid grid-cols-12 gap-6 md:gap-10">
        {assets.map((a, idx) => {
          const tile = tiles[idx] ?? { span: 8 };
          const ratioW = a.width || 1600;
          const ratioH = a.height || 1067;
          const cls = [
            'relative min-w-0 col-span-12',
            SPAN_CLASS[tile.span] ?? 'md:col-span-8',
            tile.start ? START_CLASS[tile.start] : '',
            tile.mt ? MT_CLASS[tile.mt] : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <figure key={a.src + idx} className={cls}>
              <button
                ref={(el) => {
                  triggerRefs.current[idx] = el;
                }}
                type="button"
                onClick={() => setOpenIndex(idx)}
                aria-label={a.alt ? `${labels.open} — ${a.alt}` : labels.open}
                aria-haspopup="dialog"
                className="group block w-full cursor-zoom-in overflow-hidden focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  aspectRatio: `${ratioW} / ${ratioH}`,
                  outlineColor: 'var(--color-ink)',
                }}
              >
                {isVideoAsset(a) ? (
                  <video
                    src={a.video ?? a.src}
                    poster={a.poster}
                    muted
                    playsInline
                    preload="metadata"
                    className="pointer-events-none h-full w-full object-contain"
                  />
                ) : (
                  <Image
                    src={a.src}
                    alt={a.alt}
                    width={ratioW}
                    height={ratioH}
                    sizes="(min-width: 1024px) 60vw, 100vw"
                    className={`h-full w-full object-contain ${
                      reducedMotion
                        ? ''
                        : 'transition-transform duration-500 ease-out group-hover:scale-[1.02]'
                    }`}
                  />
                )}
              </button>
              {a.alt && (
                <figcaption
                  className="mt-3 text-xs uppercase tracking-[0.18em]"
                  style={{ color: 'var(--color-ink-subtle)' }}
                >
                  {a.alt}
                </figcaption>
              )}
            </figure>
          );
        })}
      </div>

      {mounted && isOpen && active
        ? createPortal(
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-label={labels.ariaLabel}
              className="fixed inset-0 flex flex-col"
              style={{
                zIndex: 95,
                background: 'rgba(17, 17, 17, 0.96)',
                animation: reducedMotion ? undefined : 'caldesLbIn 160ms ease-out',
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) close();
              }}
            >
              <style>{`@keyframes caldesLbIn{from{opacity:0}to{opacity:1}}`}</style>

              {/* Top bar — contatore + chiudi */}
              <div className="flex shrink-0 items-center justify-between px-6 py-5 md:px-10">
                <span
                  className="font-mono text-[11px] uppercase tracking-[0.22em] tabular-nums"
                  style={{ color: 'rgba(250,250,247,0.55)' }}
                >
                  {String((openIndex ?? 0) + 1).padStart(2, '0')} / {String(assets.length).padStart(2, '0')}
                </span>
                <button
                  ref={closeBtnRef}
                  type="button"
                  onClick={close}
                  aria-label={labels.close}
                  className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors"
                  style={{ color: 'rgba(250,250,247,0.82)' }}
                >
                  {labels.close}
                  <span aria-hidden>✕</span>
                </button>
              </div>

              {/* Stage */}
              <div
                className="relative flex flex-1 items-center justify-center overflow-hidden px-4 pb-8 md:px-20"
                onClick={(e) => {
                  if (e.target === e.currentTarget) close();
                }}
              >
                {assets.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => step(-1)}
                    aria-label={labels.prev}
                    className="absolute left-1 top-1/2 -translate-y-1/2 px-4 py-6 font-mono text-3xl leading-none transition-opacity hover:opacity-100 md:left-6"
                    style={{ color: 'rgba(250,250,247,0.6)' }}
                  >
                    <span aria-hidden>‹</span>
                  </button>
                ) : null}

                <figure className="flex max-h-full flex-col items-center">
                  {isVideoAsset(active) ? (
                    <video
                      src={active.video ?? active.src}
                      poster={active.poster}
                      controls
                      autoPlay
                      playsInline
                      className="max-h-[76vh] max-w-full object-contain"
                    />
                  ) : (
                    // Immagine intera (nessun ritaglio) — <img> diretto: è
                    // un'azione esplicita "vedi a grandezza reale", non serve
                    // l'ottimizzazione next/image della griglia.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={active.src}
                      alt={active.alt}
                      className="max-h-[76vh] max-w-full object-contain"
                      style={{ background: 'transparent' }}
                    />
                  )}
                  {active.alt ? (
                    <figcaption
                      className="mt-4 max-w-[70ch] text-center text-[11px] uppercase tracking-[0.16em]"
                      style={{ color: 'rgba(250,250,247,0.55)' }}
                    >
                      {active.alt}
                    </figcaption>
                  ) : null}
                </figure>

                {assets.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => step(1)}
                    aria-label={labels.next}
                    className="absolute right-1 top-1/2 -translate-y-1/2 px-4 py-6 font-mono text-3xl leading-none transition-opacity hover:opacity-100 md:right-6"
                    style={{ color: 'rgba(250,250,247,0.6)' }}
                  >
                    <span aria-hidden>›</span>
                  </button>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
