import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  GLOSSARIO_UI,
  categoryLabel,
  glossarioTermAnchor,
  levelLabel,
  type GlossarioEntry,
} from '@/data/glossario';
import type { Locale } from '@/lib/i18n';

interface GlossarioTermItemProps {
  entry: GlossarioEntry;
  locale: Locale;
  /** Voci correlate già risolte (solo quelle pubblicate) */
  related: Array<Pick<GlossarioEntry, 'slug' | 'term'>>;
}

const BODY_CLASS =
  'body-longform max-w-[80ch] text-base md:text-lg leading-relaxed whitespace-pre-line text-justify';

/**
 * Una voce del glossario. Server component: tutto il testo è nell'HTML
 * iniziale (SEO), i filtri client la nascondono via `data-glossario-term`.
 * Anchor: #term-<slug> (vedi glossarioTermAnchor).
 *
 * Template per tipo:
 *   concept    → Cos'è / Perché ti riguarda / Cosa pretendere
 *   technology → Cos'è / A cosa serve / Quando conviene / Quando no /
 *                Cosa chiedere al fornitore
 */
export function GlossarioTermItem({ entry, locale, related }: GlossarioTermItemProps) {
  const ui = GLOSSARIO_UI[locale];
  const blocks: Array<{ label: string; text: string | undefined }> =
    entry.type === 'technology'
      ? [
          { label: ui.whatItIs, text: entry.whatItIs },
          { label: ui.whatFor, text: entry.whatFor },
          { label: ui.whenYes, text: entry.whenYes },
          { label: ui.whenNo, text: entry.whenNo },
          { label: ui.whatToAsk, text: entry.whatToAsk },
        ]
      : [
          { label: ui.whatItIs, text: entry.whatItIs },
          { label: ui.whyYouCare, text: entry.whyYouCare },
          { label: ui.whatToDemand, text: entry.whatToDemand },
        ];
  const meta = [categoryLabel(entry.category, locale), levelLabel(entry.level, locale)]
    .filter(Boolean)
    .join(' · ');

  return (
    <li
      id={glossarioTermAnchor(entry.slug)}
      data-glossario-term={entry.slug}
      className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-10 scroll-mt-24"
    >
      <div className="md:col-span-4 flex flex-col gap-3">
        <Heading as="h3" size="card">
          {entry.term}
        </Heading>
        {entry.fullName ? <MonoLabel as="p">{entry.fullName}</MonoLabel> : null}
        <MonoLabel as="p" tone="accent" className="uppercase tracking-[0.15em]" style={{ lineHeight: 1.5 }}>
          {meta}
        </MonoLabel>
        {entry.aliases.length > 0 ? (
          <p className="text-sm leading-snug" style={{ color: 'var(--color-text-tertiary)' }}>
            {ui.aliases}: {entry.aliases.join(', ')}
          </p>
        ) : null}
      </div>

      <div className="md:col-span-8 space-y-4">
        {blocks.map((block, i) =>
          block.text ? (
            <div key={block.label}>
              <MonoLabel as="p" tone="accent" className="mb-2">
                {block.label}
              </MonoLabel>
              <p
                className={BODY_CLASS}
                style={{
                  color: i === 0 ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                }}
              >
                {block.text}
              </p>
            </div>
          ) : null,
        )}

        {related.length > 0 ? (
          <p className="text-sm leading-relaxed pt-2" style={{ color: 'var(--color-text-secondary)' }}>
            <span className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.15em] mr-2">
              {ui.related}
            </span>
            {related.map((r, i) => (
              <span key={r.slug}>
                {i > 0 ? <span aria-hidden="true"> · </span> : null}
                <a
                  href={`#${glossarioTermAnchor(r.slug)}`}
                  data-glossario-link={r.slug}
                  className="underline underline-offset-4 transition-colors hover:text-[var(--color-link-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
                >
                  {r.term}
                </a>
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </li>
  );
}
