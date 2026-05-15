'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Link } from '@/i18n/navigation';

interface Props {
  href: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * Client wrapper around `next/link` for `/servizi` listing cards.
 */
export function ServiziCardLink({ href, className, style, children }: Props) {
  // Pattern Swiss hover (P1-10): apply `.swiss-hover-card` automaticamente.
  // Consumer aggiunge `.swiss-hover-card-image` all'<img> dentro children.
  const merged = ['swiss-hover-card', className].filter(Boolean).join(' ');
  return (
    <Link href={href} className={merged} style={style}>
      {children}
    </Link>
  );
}
