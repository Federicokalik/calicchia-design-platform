import { type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface ResponsiveFieldGridProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Target column count at the widest breakpoint. The grid always starts at
   * 1 column on phones and progressively expands. Default: 2.
   *
   *   cols=2 → `grid-cols-1 sm:grid-cols-2`
   *   cols=3 → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`
   *   cols=4 → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`
   */
  cols?: 1 | 2 | 3 | 4;
  /** Tailwind gap utility. Default `gap-4` (16px) which matches form rhythm. */
  gap?: string;
}

const COL_CLASSES: Record<Required<ResponsiveFieldGridProps>['cols'], string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
};

/**
 * Form/field grid that respects mobile-first responsive rhythm.
 *
 * Replaces the recurring `grid grid-cols-2 gap-4` pattern (which compresses
 * inputs on phones into useless half-columns) with a single column on phones
 * that progressively expands. Use everywhere a form lays fields side-by-side
 * (impostazioni sections, preventivi editor, customer detail panels).
 *
 * Example:
 * ```tsx
 * <ResponsiveFieldGrid cols={2}>
 *   <Field label="Nome" value={name} onChange={setName} />
 *   <Field label="Cognome" value={surname} onChange={setSurname} />
 * </ResponsiveFieldGrid>
 * ```
 */
export function ResponsiveFieldGrid({
  cols = 2,
  gap = 'gap-4',
  className,
  ...props
}: ResponsiveFieldGridProps) {
  return <div className={cn('grid', COL_CLASSES[cols], gap, className)} {...props} />;
}
