import { getLocale, getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { BeforeAfterSlider } from './BeforeAfterSlider';
import type { ApiBeforeAfterPair } from '@/lib/projects-api';
import type { Locale } from '@/lib/i18n';

interface CaseBeforeAfterProps {
  pairs: ApiBeforeAfterPair[];
  /** Section number prefix (default "02" — slots between Brief and Gallery). */
  index?: string;
}

/**
 * Restyling section (Migration 095) — Bierut/Swiss layout:
 *   - Left rail (col-span-4) with eyebrow "02 — Prima / Dopo" + counter.
 *   - Right column (col-span-7 col-start-6) with the display heading.
 *   - Full-width pair list below, each pair a drag-slider that compares
 *     before vs after with a 1px handle, monospace caption pills, and
 *     full keyboard a11y.
 *
 * Renders nothing when there are no usable pairs (rendering is gated by
 * `is_restyling` + filtered in the adapter, so this is a defensive check).
 */
export async function CaseBeforeAfter({
  pairs,
  index = '02',
}: CaseBeforeAfterProps) {
  if (!pairs || pairs.length === 0) return null;

  const t = await getTranslations('lavori.detail.beforeAfter');
  const locale = (await getLocale()) as Locale;

  return (
    <Section spacing="default" bordered="top">
      <div className="grid grid-cols-12 gap-6 md:gap-10 mb-12 md:mb-16">
        <div className="col-span-12 md:col-span-4">
          <Eyebrow as="p" mono>
            {index} — {t('eyebrow')}
          </Eyebrow>
        </div>
        <div className="col-span-12 md:col-span-7 md:col-start-6">
          <Heading as="h2" size="display-md" style={{ maxWidth: '18ch' }}>
            {t('heading')}
          </Heading>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 md:gap-10">
        <div className="col-span-12 md:col-span-10 md:col-start-2 space-y-16 md:space-y-24">
          {pairs.map((pair, i) => {
            const resolvedLabel =
              locale === 'en'
                ? pair.label_en ?? pair.label ?? null
                : pair.label ?? null;
            return (
              <BeforeAfterSlider
                key={`${pair.before.src}-${i}`}
                pair={pair}
                position={i}
                total={pairs.length}
                resolvedLabel={resolvedLabel}
                beforeWord={t('beforeWord')}
                afterWord={t('afterWord')}
                sliderAriaLabel={t('sliderAriaLabel', {
                  label: resolvedLabel ?? `${i + 1}`,
                })}
                hint={t('hint')}
              />
            );
          })}
        </div>
      </div>
    </Section>
  );
}
