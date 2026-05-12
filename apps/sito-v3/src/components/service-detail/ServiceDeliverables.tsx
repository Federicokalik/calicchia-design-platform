import { getTranslations } from 'next-intl/server';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';

export interface ServiceDeliverable {
  title: string;
  format: string;
  timeline: string;
}

interface ServiceDeliverablesProps {
  deliverables: readonly ServiceDeliverable[];
  index: string;
}

function padNum(value: number) {
  return String(value).padStart(2, '0');
}

export async function ServiceDeliverables({
  deliverables,
  index,
}: ServiceDeliverablesProps) {
  const t = await getTranslations('servizi.detail');

  return (
    <Section spacing="default" bordered="top">
      <div className="mb-16 md:mb-24">
        <MonoLabel as="p" className="mb-6 uppercase">
          {index} - {t('deliverables')}
        </MonoLabel>
        <Heading as="h2" size="display-md">
          {t('deliverablesHeading')}
        </Heading>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="border-b border-hairline">
              <th scope="col" className="w-[8%] pb-4 pr-6 text-left">
                <MonoLabel>{t('deliverablesTableNumber')}</MonoLabel>
              </th>
              <th scope="col" className="w-[52%] pb-4 pr-6 text-left">
                <MonoLabel>{t('deliverablesTableDeliverable')}</MonoLabel>
              </th>
              <th scope="col" className="w-[24%] pb-4 pr-6 text-left">
                <MonoLabel>{t('deliverablesTableFormat')}</MonoLabel>
              </th>
              <th scope="col" className="w-[16%] pb-4 text-left">
                <MonoLabel>{t('deliverablesTableTiming')}</MonoLabel>
              </th>
            </tr>
          </thead>
          <tbody>
            {deliverables.map((deliverable, i) => (
              <tr key={`${deliverable.title}-${i}`} className="border-b border-hairline">
                <td className="py-6 pr-6 align-top">
                  <MonoLabel tone="accent" className="tabular-nums">
                    {padNum(i + 1)}
                  </MonoLabel>
                </td>
                <td className="py-6 pr-6 align-top font-[family-name:var(--font-display)] text-2xl leading-tight tracking-[-0.02em]">
                  {deliverable.title}
                </td>
                <td className="py-6 pr-6 align-top">
                  <MonoLabel>{deliverable.format}</MonoLabel>
                </td>
                <td className="py-6 align-top">
                  <MonoLabel>{deliverable.timeline}</MonoLabel>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
