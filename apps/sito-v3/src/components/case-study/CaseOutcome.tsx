import { getTranslations } from 'next-intl/server';
import { Body } from '@/components/ui/Body';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';
import type { ApiProjectMetric } from '@/lib/projects-api';

interface CaseOutcomeProps {
  /** Sintesi 80-150 parole "cosa è cambiato dopo il go-live". */
  outcome: string | null;
  /**
   * Metrics flessibili. Forme accettate (rendering automatico):
   *   { label: "Lead/mese", value: "+120%" }                          → single
   *   { label: "Tempo prenotazione", before: "3 min", after: "40 sec" } → before→after
   */
  metrics: ApiProjectMetric[];
  /** Section number (default "05") */
  index?: string;
}

function isBeforeAfter(m: ApiProjectMetric): boolean {
  return Boolean(m.before || m.after);
}

/**
 * Outcome + metrics in formato editorial Pentagram. Niente count-up
 * animation (Bierut/Jen austerity). Tabella dati hairline + tipografia
 * grande per i numeri, mono per i label.
 *
 * Layout:
 *   Eyebrow numerato → Heading "I risultati" → outcome paragraph
 *   (asymmetric col-7) → grid metrics N-cols hairline-divided.
 */
export async function CaseOutcome({ outcome, metrics, index = '05' }: CaseOutcomeProps) {
  const t = await getTranslations('lavori.detail');

  if (!outcome && metrics.length === 0) return null;

  const n = metrics.length;
  const hasBeforeAfter = metrics.some(isBeforeAfter);

  return (
    <Section spacing="default" bordered="top">
      <div className="grid grid-cols-12 gap-6 md:gap-10 mb-16 md:mb-20">
        <div className="col-span-12 md:col-span-7">
          <Eyebrow as="p" mono className="mb-6">
            {index} — {t('outcome')}
          </Eyebrow>
          <Heading
            as="h2"
            size="display-md"
            className="mb-8"
            style={{ maxWidth: '18ch' }}
          >
            {hasBeforeAfter ? t('beforeAfterHeading') : t('numbersHeading')}
          </Heading>
          {outcome ? (
            <Body
              tone="secondary"
              className="text-[length:var(--text-body-lg)] leading-relaxed"
            >
              {outcome}
            </Body>
          ) : null}
        </div>
      </div>

      {n > 0 ? (
        <div
          className="grid grid-cols-2 md:[grid-template-columns:repeat(var(--metrics-cols),1fr)]"
          style={
            {
              '--metrics-cols': Math.min(n, 4),
              borderTop: '1px solid var(--color-border)',
              borderBottom: '1px solid var(--color-border)',
            } as React.CSSProperties
          }
        >
          {metrics.map((m, idx) => {
            const cols = Math.min(n, 4);
            const isLastInRow = (idx + 1) % cols === 0;
            return (
              <div
                key={`${m.label}-${idx}`}
                className="py-10 md:py-14 px-4 md:px-6 flex flex-col gap-3"
                style={{
                  borderRight: isLastInRow
                    ? 'none'
                    : '1px solid var(--color-border)',
                }}
              >
                {isBeforeAfter(m) ? (
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span
                      className="font-[family-name:var(--font-display)] text-[clamp(1.4rem,3vw,2.4rem)] font-medium leading-none tabular-nums line-through opacity-50"
                      style={{ letterSpacing: '-0.02em' }}
                    >
                      {m.before ?? '—'}
                    </span>
                    <span
                      aria-hidden
                      className="font-mono text-xs uppercase tracking-[0.18em]"
                      style={{ color: 'var(--color-accent-deep)' }}
                    >
                      →
                    </span>
                    <span
                      className="font-[family-name:var(--font-display)] text-[clamp(2.4rem,5vw,4rem)] font-medium leading-none tabular-nums"
                      style={{ letterSpacing: '-0.02em' }}
                    >
                      {m.after ?? '—'}
                      {m.unit ? <span className="text-xl ml-1">{m.unit}</span> : null}
                    </span>
                  </div>
                ) : (
                  <span
                    className="font-[family-name:var(--font-display)] text-[clamp(2.5rem,6vw,4.5rem)] font-medium leading-none tabular-nums"
                    style={{ letterSpacing: '-0.02em' }}
                  >
                    {m.value ?? '—'}
                  </span>
                )}
                <MonoLabel className="mt-2">{m.label}</MonoLabel>
              </div>
            );
          })}
        </div>
      ) : null}
    </Section>
  );
}
