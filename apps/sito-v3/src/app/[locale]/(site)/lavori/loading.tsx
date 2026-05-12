import { Section } from '@/components/ui/Section';

/**
 * Loading skeleton — /lavori list. Pentagram-tier: hairline + tipografia mono,
 * niente spinner ornamentali. Renderizzato durante il fetch async dei progetti.
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
            Caricamento portfolio…
          </span>
          <div
            className="h-px w-full"
            style={{ background: 'var(--color-line)' }}
          />
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={`${i % 3 === 0 ? 'md:col-span-7' : 'md:col-span-5'} aspect-[4/3] animate-pulse`}
                style={{
                  background: 'var(--color-line)',
                  opacity: 0.15,
                }}
              />
            ))}
          </div>
        </div>
      </Section>
    </main>
  );
}
