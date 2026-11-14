'use client';

import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Cluster, PalettePhoto } from '@calicchia/shared/palette';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { cn } from '@/lib/utils';
import styles from './PaletteTool.module.css';

/** Passo del tool: rail 3/12 (numero, titolo, aiuto) + corpo 9/12. */
export function Step({
  n,
  id,
  title,
  help,
  children,
}: {
  n: string;
  id: string;
  title: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid grid-cols-1 gap-6 border-t py-[clamp(2.25rem,5vw,3.5rem)] min-[960px]:grid-cols-12 min-[960px]:gap-x-8"
      style={{ borderColor: 'var(--color-line)' }}
    >
      <div className="grid content-start gap-2.5 min-[960px]:col-span-3">
        <MonoLabel as="span">{n}</MonoLabel>
        <Heading as="h2" size="card" id={id}>
          {title}
        </Heading>
        <p className="max-w-[40ch] text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
          {help}
        </p>
      </div>
      <div className="grid min-w-0 grid-cols-1 content-start gap-5 min-[960px]:col-span-9">{children}</div>
    </section>
  );
}

/** Scelta a chip (pattern bl-picker del sito), con aria-pressed. */
export function Chip({ pressed, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'border px-[0.9rem] py-[0.55rem] text-sm leading-[1.3] transition-colors hover:border-[var(--color-ink)]',
        'border-[var(--color-line-strong)] aria-pressed:border-[var(--color-ink)] aria-pressed:bg-[var(--color-ink)] aria-pressed:text-[var(--color-bg)]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Bottone testuale sottolineato, piccolo e in maiuscolo. */
export function LinkButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'cursor-pointer border-b border-current py-[0.2rem] text-[0.7rem] uppercase tracking-[0.15em] transition-opacity hover:opacity-60 aria-pressed:font-semibold',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Quadratino d'accento del sito. */
export function Square({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-2 w-2 flex-none', className)}
      style={{ background: 'var(--color-accent)' }}
    />
  );
}

/** Messaggio di stato col quadratino d'accento. */
export function Notice({ children, live = false }: { children: ReactNode; live?: boolean }) {
  return (
    <p
      className="flex items-baseline gap-2.5 text-sm"
      style={{ color: 'var(--color-text-secondary)' }}
      {...(live ? { role: 'status' } : {})}
    >
      <Square className="-translate-y-px" />
      <span>{children}</span>
    </p>
  );
}

/** Fasce dei colori dominanti, larghe quanto il loro peso. */
export function Bands({ clusters, className, label }: { clusters: readonly Cluster[]; className?: string; label?: string }) {
  return (
    <div
      className={cn(styles.bands, className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {clusters.map((c) => (
        <span key={c.hex} style={{ background: c.hex, width: `${(c.w * 100).toFixed(1)}%` }} title={c.hex} />
      ))}
    </div>
  );
}

/**
 * Foto Unsplash in hotlink: `<img>` semplice, mai letta via canvas. Se non
 * carica restano le fasce dei suoi colori (già estratti nei dati).
 */
export function UnsplashImg({
  photo,
  clusters,
  size,
  alt,
  className,
  bandsClassName,
  brokenLabel,
}: {
  photo: PalettePhoto;
  clusters: readonly Cluster[];
  size: 'small' | 'regular';
  alt: string;
  className?: string;
  bandsClassName?: string;
  brokenLabel: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = photo[size];
  if (failedSrc === src) {
    return <Bands clusters={clusters} className={bandsClassName ?? className} label={brokenLabel} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- hotlink obbligatorio per le linee guida Unsplash
    <img
      src={src}
      alt={alt}
      className={className}
      width={photo.width}
      height={photo.height}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      style={photo.color ? { backgroundColor: photo.color } : undefined}
      onError={() => setFailedSrc(src)}
    />
  );
}
