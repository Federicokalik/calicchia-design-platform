'use client';

import { useEffect, useRef, useState } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';
import type { LegalDocument, LegalSection } from '@/data/legal-content';
import { useScrollToBottom } from '@/hooks/useScrollToBottom';

interface LegalDocumentReadableProps {
  document: LegalDocument;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Default open per la prima card; le successive si aprono su click. */
  defaultOpen?: boolean;
}

/**
 * Card collapsible con il testo integrale di un documento legale, container
 * scrollabile interno e checkbox "Ho letto" che si abilita solo dopo che
 * l'utente ha scrollato fino al sentinel a fine documento.
 *
 * Stile coerente con il design sistema del sito (ink/bg color tokens, mono
 * uppercase labels, no gradients, hairline borders).
 */
export function LegalDocumentReadable({
  document,
  checked,
  onCheckedChange,
  defaultOpen = false,
}: LegalDocumentReadableProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const reached = useScrollToBottom(sentinelRef);
  const [open, setOpen] = useState(defaultOpen);

  // Se il documento e` molto corto, il sentinel e` gia` in viewport al primo
  // render → useScrollToBottom restituisce true. Bene, ma vogliamo evitare
  // che l'utente flagghi senza nemmeno aprire l'accordion. `enabled` somma
  // le due condizioni.
  const enabled = open && reached;

  // Se l'utente espande con accordion molto corto: il sentinel diventa
  // visibile, scattando reached, ma vogliamo lasciare almeno un frame per
  // l'utente di vedere il contenuto. Non strettamente necessario, ma evita
  // un'esperienza "checkbox abilitato istantaneo". Trascurabile, skip.

  return (
    <div
      className="border"
      style={{
        background: 'var(--color-bg)',
        borderColor: 'rgba(17,17,17,0.12)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left transition-opacity hover:opacity-80"
        aria-expanded={open}
        aria-controls={`doc-${document.slug}`}
      >
        <div>
          <p
            className="font-mono text-[10px] uppercase tracking-[0.24em]"
            style={{ color: 'var(--color-accent-deep)' }}
          >
            Documento {document.slug === 'termini-e-condizioni' ? '1/2' : '2/2'}
          </p>
          <p className="mt-2 font-[family-name:var(--font-display)] text-2xl" style={{ letterSpacing: '-0.025em' }}>
            {document.title}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {checked && (
            <span
              className="inline-flex h-6 w-6 items-center justify-center rounded-full"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              aria-hidden
            >
              <Check size={14} weight="bold" />
            </span>
          )}
          <CaretDown
            size={18}
            aria-hidden
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
            style={{ color: 'var(--color-text-secondary)' }}
          />
        </div>
      </button>

      {open && (
        <div
          id={`doc-${document.slug}`}
          className="border-t"
          style={{ borderColor: 'rgba(17,17,17,0.08)' }}
        >
          <div
            className="max-h-[55vh] overflow-y-auto px-6 py-5 text-sm leading-relaxed"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <p className="mb-6 italic">{document.intro}</p>
            {document.sections.map((section) => (
              <DocumentSection key={section.id} section={section} />
            ))}
            <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
          </div>

          <div
            className="flex items-center justify-between gap-4 border-t px-6 py-4"
            style={{ borderColor: 'rgba(17,17,17,0.08)' }}
          >
            <p
              className="font-mono text-[10px] uppercase tracking-[0.18em]"
              style={{ color: reached ? 'var(--color-accent-deep)' : 'var(--color-text-tertiary)' }}
            >
              {reached
                ? 'Documento letto fino in fondo'
                : 'Scorri fino in fondo per abilitare l’accettazione'}
            </p>
            <label className="inline-flex items-center gap-3">
              <input
                type="checkbox"
                disabled={!enabled}
                checked={checked}
                onChange={(e) => onCheckedChange(e.target.checked)}
                className="size-4 accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              />
              <span className="text-xs font-medium uppercase tracking-[0.14em]">Ho letto e accetto</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentSection({ section }: { section: LegalSection }) {
  return (
    <section className="mb-7">
      <p
        className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em]"
        style={{ color: 'var(--color-accent-deep)' }}
      >
        {section.number} — Articolo
      </p>
      <h3
        className="mb-3 font-[family-name:var(--font-display)] text-lg"
        style={{ letterSpacing: '-0.015em', color: 'var(--color-text-primary)' }}
      >
        {section.heading}
      </h3>
      {section.paragraphs?.map((p, i) => (
        <p key={i} className="mb-2 whitespace-pre-line">
          {p}
        </p>
      ))}
      {section.list && section.list.length > 0 && (
        <ul className="mb-2 list-disc pl-5 space-y-1">
          {section.list.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
      {section.subsections?.map((sub) => <DocumentSection key={sub.id} section={sub} />)}
    </section>
  );
}
