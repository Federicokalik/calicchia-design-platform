import { Section } from '@/components/ui/Section';

/**
 * Loading skeleton — /blog list. Pentagram-tier hairline.
 */
export default function Loading() {
  return (
    <main>
      <Section spacing="default">
        <div className="flex flex-col gap-6">
          <span
            className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Caricamento articoli…
          </span>
          <div
            className="h-px w-full"
            style={{ background: 'var(--color-line)' }}
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-3">
                <div
                  className="aspect-[16/9] animate-pulse"
                  style={{ background: 'var(--color-line)', opacity: 0.15 }}
                />
                <div
                  className="h-4 w-3/4 animate-pulse"
                  style={{ background: 'var(--color-line)', opacity: 0.2 }}
                />
                <div
                  className="h-3 w-full animate-pulse"
                  style={{ background: 'var(--color-line)', opacity: 0.12 }}
                />
              </div>
            ))}
          </div>
        </div>
      </Section>
    </main>
  );
}
