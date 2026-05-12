import type { ReactNode } from 'react';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import type { BreadcrumbItem } from '@/data/structured-data';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { FinalCTA } from '@/components/home/FinalCTA';
import {
  EditorialChapterIndex,
  type EditorialChapterEntry,
  type EditorialChapterIndexVariant,
} from './EditorialChapterIndex';
import { EditorialMeta } from './EditorialMeta';

export type { EditorialChapterEntry, EditorialChapterIndexVariant };

interface EditorialArticleLayoutProps {
  breadcrumbs?: BreadcrumbItem[];
  /** Mono eyebrow shown above the H1, e.g. "GUIDA — 7 CAPITOLI · 8 MIN". */
  eyebrow?: ReactNode;
  /** Title is left-aligned, NEVER centered. */
  title: ReactNode;
  /** Optional lead paragraph, max-width handled by the grid. */
  lead?: ReactNode;
  /** Chapters used by the sticky rail and active state. */
  chapters: EditorialChapterEntry[];
  /** "alphabet" switches the rail label; behavior is identical. */
  indexVariant?: EditorialChapterIndexVariant;
  /** Read time formatted by the caller, e.g. "8 min". */
  readTime?: string;
  /** Last updated, formatted "5 maggio 2026" or ISO. */
  updatedAt?: string;
  /** Body of the article — server-rendered children. */
  children: ReactNode;
  /** Show the closing FinalCTA section. */
  showFinalCta?: boolean;
}

/**
 * Editorial longform layout — Swiss asymmetric.
 *
 * Grid (md+):
 *   col 1-2  → sticky chapter index (rail sx)
 *   col 3-9  → article body (left-aligned, max-w handled by col span)
 *   col 10-12 → sticky meta (rail dx, read time / updated / share / progress)
 *
 * Mobile (<md):
 *   stacked: header → sticky chapter dropdown → article → footer meta
 *
 * Hard rules (eredita SWISS-RULES.md):
 *   - Title is left-aligned, NEVER centered.
 *   - No `mx-auto` on long-form prose (max-width is handled by the column span).
 *   - Headings inside `children` MUST have `id` matching `chapters[].id` so the
 *     IntersectionObserver can highlight active chapter.
 *   - Use `<Heading as="h2">` with the chapter `id` and an inline mono numbering.
 */
export function EditorialArticleLayout({
  breadcrumbs,
  eyebrow,
  title,
  lead,
  chapters,
  indexVariant = 'numbered',
  readTime,
  updatedAt,
  children,
  showFinalCta = true,
}: EditorialArticleLayoutProps) {
  return (
    <>
      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-12 md:pb-16">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9">
            {breadcrumbs ? <Breadcrumbs items={breadcrumbs} className="mb-8" /> : null}

            {eyebrow ? (
              <Eyebrow as="p" mono className="mb-6">
                {eyebrow}
              </Eyebrow>
            ) : null}

            <Heading
              as="h1"
              size="display-xl"
              className="mb-8"
              style={{ maxWidth: '22ch' }}
            >
              {title}
            </Heading>

            {lead ? (
              <p
                className="text-[length:var(--text-body-lg)] leading-relaxed"
                style={{
                  maxWidth: '55ch',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {lead}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      <div className="px-6 md:px-10 lg:px-14 pb-24 md:pb-32">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          {/* Rail sx — desktop sticky / mobile dropdown */}
          <div className="col-span-12 md:col-span-2 md:col-start-1">
            <EditorialChapterIndex chapters={chapters} variant={indexVariant} />
          </div>

          {/* Body — col 3-9 (7 of 12) */}
          <article className="col-span-12 md:col-span-7 md:col-start-3">
            {children}
          </article>

          {/* Rail dx — desktop only */}
          <div className="col-span-12 md:col-span-3 md:col-start-10">
            <EditorialMeta readTime={readTime} updatedAt={updatedAt} />
          </div>
        </div>
      </div>

      {showFinalCta ? <FinalCTA /> : null}
    </>
  );
}

/**
 * Editorial chapter wrapper — use inside `<EditorialArticleLayout>` children.
 *
 * Renders: mono numbering label, H2 heading (left, max-22ch), and body.
 * The `id` MUST match the corresponding entry in `chapters[]`.
 */
export function EditorialChapter({
  id,
  number,
  heading,
  children,
}: {
  id: string;
  number: string;
  heading: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mb-20 md:mb-28 scroll-mt-32">
      <p
        className="mb-4"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-mono-xs)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--color-accent-deep)',
          lineHeight: 1,
        }}
      >
        {number} — Capitolo
      </p>
      <Heading as="h2" size="display-md" className="mb-8" style={{ maxWidth: '22ch' }}>
        {heading}
      </Heading>
      <div
        className="space-y-5 text-lg md:text-xl leading-relaxed"
        style={{
          maxWidth: '64ch',
          color: 'var(--color-text-secondary)',
        }}
      >
        {children}
      </div>
    </section>
  );
}
