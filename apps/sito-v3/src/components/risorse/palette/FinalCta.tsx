'use client';

import { ContactButton } from './ContactButton';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import type { ToolStrings } from './strings';

/** CTA finale (pattern FinalCTA): fondo neutro, tipografia grande, accento solo sul bottone. */
export function FinalCta({ t, query, onClick }: { t: ToolStrings; query: Record<string, string>; onClick: () => void }) {
  return (
    <section
      aria-labelledby="pds-final"
      className="grid grid-cols-1 gap-7 border-t py-[clamp(4rem,10vw,7.5rem)]"
      style={{ borderColor: 'var(--color-ink)' }}
    >
      <Eyebrow>{t.ctaEyebrow}</Eyebrow>
      <Heading as="h2" size="display-md" id="pds-final">
        {t.ctaTitle[0]}
        <br />
        {t.ctaTitle[1]}
      </Heading>
      <p className="max-w-[52ch] text-[length:var(--text-body-lg)] leading-normal" style={{ color: 'var(--color-text-secondary)' }}>
        {t.ctaBody}
      </p>
      <div>
        <ContactButton query={query} onClick={onClick}>
          {t.ctaButton}
        </ContactButton>
      </div>
    </section>
  );
}
