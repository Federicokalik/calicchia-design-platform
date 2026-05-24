import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table';

/**
 * Column descriptor for {@link ResponsiveTable}.
 *
 *  - `header`     — string or node rendered as desktop column header AND
 *                   as the inline label in the mobile card row.
 *  - `cell`       — function returning the cell content for a given row.
 *  - `primary`    — promote this column to the mobile card title position
 *                   (spans full width, no label). Use for "name"-like fields.
 *  - `hideOnMobile` — drop this column from the mobile card stack entirely
 *                   (use for low-priority secondary data).
 *  - `align`      — text alignment for desktop and mobile value side.
 *  - `className`  — extra classes for desktop `<td>` cell.
 */
export interface ResponsiveTableColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  primary?: boolean;
  hideOnMobile?: boolean;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

interface ResponsiveTableProps<T> {
  columns: ResponsiveTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Render an empty-state block when `rows.length === 0`. */
  emptyState?: ReactNode;
  /** Click handler shared by desktop row and mobile card. */
  onRowClick?: (row: T) => void;
  /** Optional classes for the outer container. */
  className?: string;
  /**
   * Right-side action node rendered inside the mobile card header line
   * (e.g. a chevron icon to signal navigation). Receives the row.
   */
  mobileTrailing?: (row: T) => ReactNode;
}

/**
 * Adaptive data table.
 *
 *  - `lg:` (≥1024px): renders a classic `<table>` (shadcn-styled).
 *  - Below `lg:`: renders the same data as a stacked card list. Each card
 *    shows the `primary` column as title, then the remaining columns as
 *    label/value rows. `hideOnMobile` columns are dropped.
 *
 * Pattern preferred over horizontal-scroll on phones (touch users struggle
 * with x-scroll discovery). Inspired by the manual implementation in
 * `pages/clienti/index.tsx`, generalized.
 */
export function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
  emptyState,
  onRowClick,
  className,
  mobileTrailing,
}: ResponsiveTableProps<T>) {
  if (rows.length === 0 && emptyState) {
    return <div className={className}>{emptyState}</div>;
  }

  const visibleMobile = columns.filter((col) => !col.hideOnMobile);
  const primaryCol = visibleMobile.find((col) => col.primary);
  const secondaryCols = visibleMobile.filter((col) => !col.primary);

  return (
    <div className={cn('w-full', className)}>
      {/* Mobile: stacked card list */}
      <ul role="list" className="lg:hidden divide-y divide-border rounded-md border bg-card">
        {rows.map((row) => (
          <li key={rowKey(row)}>
            <div
              className={cn(
                'flex flex-col gap-2 px-4 py-3 text-sm',
                onRowClick && 'cursor-pointer transition-colors hover:bg-muted/60 active:bg-muted',
              )}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              role={onRowClick ? 'button' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {primaryCol ? (
                <div className="flex items-start justify-between gap-3">
                  <div className="font-medium text-foreground min-w-0 flex-1">
                    {primaryCol.cell(row)}
                  </div>
                  {mobileTrailing ? (
                    <div className="shrink-0">{mobileTrailing(row)}</div>
                  ) : null}
                </div>
              ) : null}
              {secondaryCols.length > 0 ? (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                  {secondaryCols.map((col) => (
                    <Fragment key={col.key}>
                      <dt className="text-muted-foreground">{col.header}</dt>
                      <dd
                        className={cn(
                          'text-foreground min-w-0',
                          col.align === 'right' && 'text-right',
                          col.align === 'center' && 'text-center',
                        )}
                      >
                        {col.cell(row)}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {/* Desktop: real table */}
      <div className="hidden lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={cn(
                    col.align === 'right' && 'text-right',
                    col.align === 'center' && 'text-center',
                  )}
                >
                  {col.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? 'cursor-pointer' : undefined}
              >
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={cn(
                      col.align === 'right' && 'text-right',
                      col.align === 'center' && 'text-center',
                      col.className,
                    )}
                  >
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
