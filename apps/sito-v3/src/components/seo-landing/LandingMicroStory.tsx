import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Body } from '@/components/ui/Body';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';

interface LandingMicroStoryProps {
  story: string;
  caseStudyRef?: string;
  index?: string;
}

export async function LandingMicroStory({
  story,
  caseStudyRef,
  index = '02',
}: LandingMicroStoryProps) {
  const t = await getTranslations('landing.microStory');

  return (
    <Section spacing="default" bordered="top">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-12 md:gap-12">
        <div className="md:col-span-3">
          <MonoLabel as="p" className="uppercase">
            {index} - {t('eyebrow')}
          </MonoLabel>
        </div>

        <div className="md:col-span-9">
          <Body
            as="p"
            size="lg"
            className="max-w-[58ch]"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
          >
            {story}
          </Body>

          {caseStudyRef ? (
            <Link
              href={`/lavori/${caseStudyRef}`}
              className="swiss-hover-card mt-8 inline-flex items-baseline gap-2 border-t border-hairline pt-4"
            >
              <MonoLabel tone="accent" className="uppercase">
                {t('caseStudyLink')}
              </MonoLabel>
              <span aria-hidden>→</span>
            </Link>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
