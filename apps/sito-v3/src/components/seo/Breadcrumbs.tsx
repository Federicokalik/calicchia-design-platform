import Link from 'next/link';
import { breadcrumbSchema, type BreadcrumbItem } from '@/data/structured-data';
import { StructuredData } from './StructuredData';

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
}

/**
 * UI breadcrumbs + schema BreadcrumbList in un colpo solo.
 * Pattern: array di { name, url }, ultimo è la pagina corrente (non linked).
 *
 * Esempio:
 *   <Breadcrumbs items={[
 *     { name: 'Home', url: '/' },
 *     { name: 'Servizi', url: '/servizi' },
 *     { name: 'Web Design', url: '/servizi/web-design' },
 *   ]} />
 */
export function Breadcrumbs({ items, className = '' }: BreadcrumbsProps) {
  if (items.length < 2) return null;

  return (
    <>
      <StructuredData json={breadcrumbSchema(items)} />
      <nav
        aria-label="Breadcrumb"
        className={`text-xs uppercase tracking-[0.18em] ${className}`}
        style={{ color: 'var(--color-ink-subtle)' }}
      >
        <ol className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <li key={item.url} className="flex items-center gap-3">
                {isLast ? (
                  <span aria-current="page" style={{ color: 'var(--color-ink-muted)' }}>
                    {item.name}
                  </span>
                ) : (
                  <>
                    <Link
                      href={item.url}
                      className="hover:[color:var(--color-ink)] transition-colors"
                    >
                      {item.name}
                    </Link>
                    <span aria-hidden style={{ color: 'var(--color-ink-subtle)' }}>
                      /
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
