import type { ReactNode } from 'react';

interface SubtitleProps {
  children: ReactNode;
  className?: string;
}

/**
 * Sottotitolo SEO sotto H1 — voice aggressiva, contiene la keyword.
 * Tipograficamente: lead grande, weight 400, max-w controllato.
 * Posizionato subito dopo l'H1 in tutte le pagine principali.
 */
export function Subtitle({ children, className = '' }: SubtitleProps) {
  return (
    <p
      className={`text-xl md:text-2xl leading-snug max-w-[55ch] mb-10 ${className}`}
      style={{
        color: 'var(--color-ink-muted)',
        fontWeight: 400,
        letterSpacing: '-0.005em',
      }}
    >
      {children}
    </p>
  );
}
