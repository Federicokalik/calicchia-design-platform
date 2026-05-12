import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export interface PortalTableColumn<T> {
  key: keyof T | string;
  header: ReactNode;
  /** Custom cell renderer. Falls back to `String(row[key])`. */
  render?: (row: T) => ReactNode;
  /** Tailwind width hint (e.g. "w-32", "flex-1"). Default flex-1. */
  width?: string;
  /** Right-align numeric columns. */
  align?: 'left' | 'right';
}

export interface PortalTableProps<T> {
  rows: T[];
  columns: PortalTableColumn<T>[];
  /** Optional: each row becomes a Link to this href derived from the row. */
  rowHref?: (row: T) => string | undefined;
  emptyState?: ReactNode;
  className?: string;
}

/**
 * Portal table — squared island, hairline rows, uppercase mono header.
 * Rows can become links for navigation. No zebra stripes. Type scale uses
 * `text-portal-{label,body}` instead of ad-hoc text-xs/sm.
 */
export function PortalTable<T>({
  rows,
  columns,
  rowHref,
  emptyState,
  className,
}: PortalTableProps<T>) {
  if (!rows.length && emptyState) {
    return <div className={className}>{emptyState}</div>;
  }

  return (
    <div className={cn('flex flex-col border border-border bg-card rounded-sm overflow-hidden', className)}>
      {/* Header */}
      <div className="hidden md:flex items-center gap-6 px-5 py-3 border-b border-border bg-muted/30">
        {columns.map((c) => (
          <span
            key={String(c.key)}
            className={cn(
              'text-portal-label uppercase tracking-[0.18em] text-muted-foreground',
              c.width ?? 'flex-1',
              c.align === 'right' && 'text-right'
            )}
          >
            {c.header}
          </span>
        ))}
      </div>

      {/* Rows */}
      {rows.map((row, idx) => {
        const href = rowHref?.(row);
        const cells = columns.map((c) => {
          const raw =
            c.render?.(row) ??
            (typeof c.key === 'string' && c.key in (row as object)
              ? String((row as Record<string, unknown>)[c.key as string] ?? '')
              : '');
          return (
            <span
              key={String(c.key)}
              className={cn(
                'text-portal-body text-foreground',
                c.width ?? 'flex-1',
                c.align === 'right' && 'text-right'
              )}
            >
              {raw}
            </span>
          );
        });

        const baseClass = cn(
          'flex flex-col md:flex-row md:items-center gap-2 md:gap-6 px-5 py-4 transition-colors',
          idx > 0 && 'border-t border-border'
        );

        if (href) {
          return (
            <Link key={idx} href={href} className={cn(baseClass, 'hover:bg-muted/40')}>
              {cells}
            </Link>
          );
        }
        return (
          <div key={idx} className={baseClass}>
            {cells}
          </div>
        );
      })}
    </div>
  );
}
