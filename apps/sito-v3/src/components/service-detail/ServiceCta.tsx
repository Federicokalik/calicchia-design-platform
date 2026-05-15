import { useTranslations } from 'next-intl';
import { Body } from '@/components/ui/Body';
import { Button } from '@/components/ui/Button';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';

interface ServiceCtaProps {
  serviceTitle: string;
  serviceSlug: string;
  index?: string;
}

export function ServiceCta({ serviceSlug, index = '06' }: ServiceCtaProps) {
  const t = useTranslations('servizi.detail');

  return (
    <Section spacing="epic" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-16">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} - {t('ctaEyebrow')}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-12 items-end">
        <div className="md:col-span-9">
          <Heading as="h2" size="display-xl" className="max-w-[16ch]">
            {t('ctaTitle')}
          </Heading>
          <Body size="lg" tone="secondary" className="mt-6 max-w-[48ch]">
            {t('ctaSubtitle')}
          </Body>
        </div>

        <div className="md:col-span-3 md:justify-self-end">
          <Button
            href={`/contatti?service=${serviceSlug}`}
            size="lg"
            className="swiss-hover-card hover:-translate-y-px motion-reduce:hover:translate-y-0"
          >
            {t('ctaButton')}
            <span aria-hidden>→</span>
          </Button>
        </div>
      </div>
    </Section>
  );
}
