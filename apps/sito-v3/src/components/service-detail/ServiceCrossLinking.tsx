import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Body } from '@/components/ui/Body';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';

export interface RelatedService {
  slug: string;
  title: string;
  shortPitch: string;
}

interface ServiceCrossLinkingProps {
  related: readonly RelatedService[];
  index: string;
}

function padNum(value: number) {
  return String(value).padStart(2, '0');
}

export async function ServiceCrossLinking({
  related,
  index,
}: ServiceCrossLinkingProps) {
  const t = await getTranslations('servizi.detail');

  return (
    <Section spacing="tight" bordered="top">
      <div className="mb-12">
        <MonoLabel as="p" className="uppercase">
          {index} - {t('relatedServices')}
        </MonoLabel>
      </div>

      <ul role="list" className="grid grid-cols-1 gap-10 md:grid-cols-12 md:gap-6">
        {related.map((item, i) => (
          <li key={item.slug} className="md:col-span-4">
            <Link
              href={`/servizi/${item.slug}`}
              className="swiss-hover-card block min-h-[44px] border-t border-hairline pt-6 transition-hover-transform hover:-translate-y-px motion-reduce:hover:translate-y-0"
            >
              <MonoLabel tone="accent" className="tabular-nums">
                {padNum(i + 1)}
              </MonoLabel>
              <Heading as="h3" size="card" className="mt-5">
                {item.title}
              </Heading>
              <Body size="sm" tone="secondary" className="mt-4 max-w-[40ch]">
                {item.shortPitch}
              </Body>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
