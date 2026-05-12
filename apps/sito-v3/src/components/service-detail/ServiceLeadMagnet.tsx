import { getTranslations } from 'next-intl/server';
import { Body } from '@/components/ui/Body';
import { Button } from '@/components/ui/Button';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';

interface ServiceLeadMagnetProps {
  serviceSlug: string;
  eyebrow: string;
  title: string;
  body: string;
  index: string;
}

export async function ServiceLeadMagnet({
  serviceSlug,
  eyebrow,
  title,
  body,
  index,
}: ServiceLeadMagnetProps) {
  const t = await getTranslations('servizi.detail');

  return (
    <Section spacing="compact" bordered="top">
      <div className="grid grid-cols-1 gap-12 md:grid-cols-12 md:gap-6">
        <div className="md:col-span-7">
          <MonoLabel as="p" className="mb-6 uppercase">
            {index} - {eyebrow}
          </MonoLabel>
          <Heading as="h2" size="display-md" className="max-w-[18ch]">
            {title}
          </Heading>
          <Body size="lg" tone="secondary" className="mt-6 max-w-[55ch]">
            {body}
          </Body>
        </div>

        <div className="md:col-span-5 md:self-end">
          <Button
            href={`/contatti?lead=audit-${serviceSlug}`}
            size="lg"
            className="swiss-hover-card hover:-translate-y-px motion-reduce:hover:translate-y-0"
          >
            {t('leadMagnetButton')}
            <span aria-hidden>→</span>
          </Button>
          <MonoLabel as="p" className="mt-5 uppercase">
            {t('leadMagnetNote')}
          </MonoLabel>
        </div>
      </div>
    </Section>
  );
}
