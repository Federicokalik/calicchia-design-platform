import type { Locale } from '@/lib/i18n';

interface PlaceholderProps {
  title: string;
  locale: Locale;
  todo: string;
  meta?: Record<string, string | string[] | undefined>;
}

/**
 * Reusable scaffold placeholder for skeleton pages.
 * Shows route info, locale chip, heading, and a TODO line pointing to the
 * legacy source to port. Drop this into every new placeholder page.
 */
export function Placeholder({ title, locale, todo, meta }: PlaceholderProps) {
  return (
    <main className="min-h-[80vh] pt-32 md:pt-40 pb-20 px-6 md:px-10 lg:px-14 max-w-5xl mx-auto">
      <p
        className="text-[10px] uppercase tracking-[0.25em] font-mono mb-4"
        style={{ color: 'var(--color-ink-muted, #5C5C58)' }}
      >
        Skeleton · {locale}
      </p>
      <h1
        className="font-[family-name:var(--font-display)] text-5xl md:text-7xl"
        style={{ fontWeight: 500, letterSpacing: '-0.025em', lineHeight: 1.02 }}
      >
        {title}
      </h1>
      <p className="mt-6 text-base md:text-lg max-w-prose" style={{ color: 'var(--color-ink-muted, #5C5C58)' }}>
        TODO: {todo}
      </p>
      {meta && Object.keys(meta).length > 0 && (
        <dl className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-8 max-w-md">
          {Object.entries(meta).map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1">
              <dt
                className="text-[10px] uppercase tracking-[0.22em] font-mono"
                style={{ color: 'var(--color-ink-subtle, #8C8C86)' }}
              >
                {k}
              </dt>
              <dd className="font-mono text-sm">{Array.isArray(v) ? v.join(' / ') : (v ?? '—')}</dd>
            </div>
          ))}
        </dl>
      )}
    </main>
  );
}
