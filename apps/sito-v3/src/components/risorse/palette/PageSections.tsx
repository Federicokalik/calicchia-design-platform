import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import type { PaletteFaq } from '@/data/risorse/palette/page-copy';

/**
 * Sezioni server delle pagine del tool (metodo, FAQ, indice, crediti):
 * stessa griglia dei passi del tool, rail 3/12 + corpo 9/12.
 */

export function RailSection({
  id,
  eyebrow,
  title,
  lead,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid grid-cols-1 gap-6 border-t py-[clamp(2.25rem,5vw,3.5rem)] min-[960px]:grid-cols-12 min-[960px]:gap-x-8"
      style={{ borderColor: 'var(--color-line)' }}
    >
      <div className="grid content-start gap-2.5 min-[960px]:col-span-3">
        <MonoLabel as="span">{eyebrow}</MonoLabel>
        <Heading as="h2" size="card" id={id}>
          {title}
        </Heading>
        {lead ? (
          <p className="max-w-[40ch] text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {lead}
          </p>
        ) : null}
      </div>
      <div className="grid min-w-0 grid-cols-1 content-start gap-5 min-[960px]:col-span-9">{children}</div>
    </section>
  );
}

export function MethodList({ steps }: { steps: { title: string; body: string }[] }) {
  return (
    <ol role="list" className="m-0 grid list-none grid-cols-1 gap-6 p-0 md:grid-cols-3">
      {steps.map((s, i) => (
        <li key={s.title} className="grid content-start gap-2 border-t pt-4" style={{ borderColor: 'var(--color-ink)' }}>
          <MonoLabel as="span">{String(i + 1).padStart(2, '0')}</MonoLabel>
          <h3 className="text-lg font-semibold leading-snug">{s.title}</h3>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {s.body}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function FaqList({ faqs }: { faqs: PaletteFaq[] }) {
  return (
    <div className="border-t" style={{ borderColor: 'var(--color-ink)' }}>
      {faqs.map((f) => (
        <details key={f.question} className="group border-b" style={{ borderColor: 'var(--color-line)' }}>
          <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4 py-4 text-base font-medium [&::-webkit-details-marker]:hidden">
            <span>{f.question}</span>
            <span aria-hidden="true" className="font-mono text-sm transition-transform group-open:rotate-45">
              +
            </span>
          </summary>
          <p className="max-w-[70ch] pb-5 text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {f.answer}
          </p>
        </details>
      ))}
    </div>
  );
}

export interface IndexGroup {
  categoryId: string;
  label: string;
  items: { slug: string; label: string; href: string | null }[];
}

/** Indice delle professioni per categoria: link solo alle pagine settore che esistono. */
export function ProfessionIndex({ groups, soonLabel }: { groups: IndexGroup[]; soonLabel: string }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-2">
      {groups.map((g) => (
        <div key={g.categoryId} className="grid content-start gap-3 border-t pt-4" style={{ borderColor: 'var(--color-ink)' }}>
          <h3 className="text-base font-semibold">{g.label}</h3>
          <ul role="list" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-2 p-0 text-sm">
            {g.items.map((it) => (
              <li key={it.slug}>
                {it.href ? (
                  <Link href={it.href} className="underline decoration-[var(--color-line-strong)] underline-offset-4 hover:decoration-current">
                    {it.label}
                  </Link>
                ) : (
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    {it.label}
                    <span className="sr-only"> ({soonLabel})</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
