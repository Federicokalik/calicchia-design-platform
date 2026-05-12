'use client';

import { useState } from 'react';
import type { FaqEntry } from '@/data/faqs';

interface FaqAccordionProps {
  faqs: FaqEntry[];
}

/**
 * Accordion FAQ riusabile (usato in /faq).
 * Single-open behavior: solo un item aperto alla volta.
 */
export function FaqAccordion({ faqs }: FaqAccordionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <ul className="flex flex-col">
      {faqs.map((faq, idx) => {
        const open = openIndex === idx;
        const id = `faq-${idx}`;
        return (
          <li
            key={idx}
            style={{
              borderTop: idx === 0 ? '1px solid var(--color-line)' : undefined,
              borderBottom: '1px solid var(--color-line)',
            }}
          >
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpenIndex(open ? null : idx)}
              className="w-full text-left py-6 md:py-8 flex items-start justify-between gap-6 transition-colors hover:bg-[var(--color-bg-elev)] min-h-[44px]"
            >
              <span
                className="font-[family-name:var(--font-display)] flex-1 max-w-[60ch]"
                style={{
                  fontSize: 'clamp(1.25rem, 2vw, 1.625rem)',
                  fontWeight: 500,
                  letterSpacing: '-0.015em',
                  lineHeight: 1.25,
                }}
              >
                {faq.question}
              </span>
              <span
                aria-hidden
                className="font-mono text-2xl pt-1 transition-transform"
                style={{
                  color: 'var(--color-accent-deep)',
                  transform: open ? 'rotate(45deg)' : 'rotate(0deg)',
                }}
              >
                +
              </span>
            </button>

            <div id={id} hidden={!open} className="pb-6 md:pb-8 pr-12">
              <p
                className="text-base md:text-lg leading-relaxed max-w-[60ch]"
                style={{ color: 'var(--color-ink-muted)' }}
              >
                {faq.answer}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
