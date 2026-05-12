import { getTranslations } from 'next-intl/server';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Section } from '@/components/ui/Section';
import type { ProjectSection } from '@/data/types';

interface CaseOverviewProps {
  section: ProjectSection;
  /** Section number prefix (es. "01"). Default mantiene back-compat. */
  index?: string;
  /** Override del label dell'eyebrow (default "Overview"). Distingue Brief
   *  vs Approccio quando lo stesso componente è usato due volte. */
  eyebrowLabel?: string;
}

/**
 * Sezione editorial 4+7+1 asimmetrica. Pentagram-Bierut: una sola label
 * (eyebrow numerato come metadata categoriale), il body è la sezione.
 * Niente double-label "01 · IL CONTESTO" + Heading "Il contesto" che diceva
 * la stessa cosa due volte.
 *
 * Il rail SX ospita l'eyebrow come anchor statico (Swiss compliance
 * 2026-05-09: rimosso sticky); il body 7-col porta la prosa display.
 * Whitespace asimmetrico è elemento attivo.
 *
 * Server component — fade-in entry minimal via CSS .case-fade-in
 * (reduced-motion guard incluso).
 */
export async function CaseOverview({
  section,
  index = '01',
  eyebrowLabel = 'Overview',
}: CaseOverviewProps) {
  const t = await getTranslations('lavori.detail');
  const label =
    eyebrowLabel === "L'approccio"
      ? t('approach')
      : eyebrowLabel === 'Il contesto'
        ? t('context')
        : eyebrowLabel === 'Overview'
          ? t('overview')
          : eyebrowLabel;

  return (
    <Section spacing="default">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-12 md:gap-16">
        <div className="md:col-span-3 md:self-start">
          <Eyebrow>{`${index} · ${label}`}</Eyebrow>
        </div>

        <div className="md:col-span-8 md:col-start-5">
          {section.body && (
            <p
              className="case-fade-in font-[family-name:var(--font-display)] text-xl md:text-2xl leading-[1.4]"
              style={{ color: 'var(--color-ink)', fontWeight: 400 }}
            >
              {section.body}
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}
