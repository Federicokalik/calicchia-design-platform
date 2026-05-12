'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

interface Props {
  href: string;
  className?: string;
  children: ReactNode;
}

/**
 * Client wrapper around `next/link` for `/lavori` listing cards.
 */
export function LavoriCardLink({ href, className, children }: Props) {
  // Pattern Swiss hover (P1-10): apply `.swiss-hover-card` automaticamente.
  // Consumer aggiunge `.swiss-hover-card-image` all'<img> dentro children.
  const merged = ['swiss-hover-card', className].filter(Boolean).join(' ');
  return (
    <Link href={href} className={merged}>
      {children}
    </Link>
  );
}
