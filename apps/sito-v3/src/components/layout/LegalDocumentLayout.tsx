import type { ReactNode } from 'react';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import type { BreadcrumbItem } from '@/data/structured-data';
import type { LegalDocument } from '@/data/legal-content';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  EditorialChapterIndex,
  type EditorialChapterEntry,
} from './EditorialChapterIndex';
import { EditorialMeta } from './EditorialMeta';

interface LegalDocumentLayoutProps {
  breadcrumbs?: BreadcrumbItem[];
  document: LegalDocument;
  /** Optional override of the page title (defaults to document.title). */
  pageTitle?: string;
}

function renderSection(section: LegalDocument['sections'][number]) {
  return (
    <section
      key={section.id}
      id={section.id}
      className="mb-16 md:mb-20 scroll-mt-32"
    >
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
        {section.number} — Articolo
      </p>
      <Heading
        as="h2"
        size="display-sm"
        className="mb-6"
        style={{ maxWidth: '28ch' }}
      >
        {section.heading}
      </Heading>
      {section.paragraphs?.length ? (
        <div
          className="space-y-4 text-base md:text-lg leading-relaxed"
          style={{ maxWidth: '64ch', color: 'var(--color-text-secondary)' }}
        >
          {section.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : null}
      {section.list?.length ? (
        <ul
          className="mt-4 space-y-2 list-disc pl-6 text-base md:text-lg leading-relaxed"
          style={{ maxWidth: '64ch', color: 'var(--color-text-secondary)' }}
        >
          {section.list.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : null}
      {section.subsections?.length ? (
        <div className="mt-8 space-y-10 border-l pl-6" style={{ borderColor: 'var(--color-border)' }}>
          {section.subsections.map((sub) => (
            <div key={sub.id} id={sub.id} className="scroll-mt-32">
              <Heading as="h3" size="card" className="mb-3">
                {sub.number ? `${sub.number} · ` : ''}
                {sub.heading}
              </Heading>
              {sub.paragraphs?.length ? (
                <div
                  className="space-y-3 text-base leading-relaxed"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {sub.paragraphs.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              ) : null}
              {sub.list?.length ? (
                <ul
                  className="mt-3 space-y-2 list-disc pl-6 text-base leading-relaxed"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {sub.list.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * LegalDocumentLayout — pattern asymmetric per le pagine legali (cookie/privacy/T&C).
 *
 * Grid (md+):
 *   col 1-2  → indice articoli statico (rail sx; sticky rimosso 2026-05-09 per
 *              Swiss compliance — ChapterIndex ora statico, vedi Task #4 audit)
 *   col 3-9  → corpo del documento
 *   col 10-12 → metadata (versione, ultimo aggiornamento, copia link)
 *
 * Eredita SWISS-RULES: nessuna centratura, hairline 1px, mono labels, primitive
 * `Heading` per i titoli, accent solo per il numero articolo.
 */
export function LegalDocumentLayout({
  breadcrumbs,
  document: doc,
  pageTitle,
}: LegalDocumentLayoutProps) {
  const chapters: EditorialChapterEntry[] = doc.sections.map((section) => ({
    id: section.id,
    number: section.number,
    label: section.heading,
  }));

  return (
    <>
      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-10 md:pb-14">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9">
            {breadcrumbs ? <Breadcrumbs items={breadcrumbs} className="mb-8" /> : null}

            <Eyebrow as="p" mono className="mb-6">
              {`Documento legale · ${doc.sections.length} articoli`}
            </Eyebrow>

            <Heading
              as="h1"
              size="display-lg"
              className="mb-6"
              style={{ maxWidth: '24ch' }}
            >
              {pageTitle ?? doc.title}
            </Heading>

            <p
              className="text-[length:var(--text-body-lg)] leading-relaxed mb-6"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              {doc.intro}
            </p>

            <MonoLabel as="p">
              Ultimo aggiornamento · {doc.lastUpdated}
            </MonoLabel>
          </div>
        </div>
      </header>

      <div className="px-6 md:px-10 lg:px-14 pb-24 md:pb-32">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          {/* Rail sx — desktop static rail / mobile static dropdown (Swiss compliance) */}
          <div className="col-span-12 md:col-span-2 md:col-start-1">
            <EditorialChapterIndex
              chapters={chapters}
              variant="numbered"
              ariaLabel="Indice articoli"
            />
          </div>

          {/* Body — col 3-9 (7 of 12) */}
          <article className="col-span-12 md:col-span-7 md:col-start-3">
            {doc.sections.map((section) => renderSection(section))}
          </article>

          {/* Rail dx — metadata + share + scroll progress */}
          <div className="col-span-12 md:col-span-3 md:col-start-10">
            <EditorialMeta updatedAt={doc.lastUpdated} showProgress={true} />
          </div>
        </div>
      </div>
    </>
  );
}
