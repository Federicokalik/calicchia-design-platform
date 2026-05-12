import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Tag({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 px-3 py-1 text-xs uppercase tracking-[0.15em] border',
        className
      )}
      style={{ borderColor: 'var(--color-line-strong)' }}
    >
      {children}
    </span>
  );
}
