import { getTranslations } from 'next-intl/server';
import { PageHero } from '@/components/layout/PageHero';

interface ServiceHeroProps {
  eyebrow: string;
  title: string;
  longDescription: string;
  slug: string;
}

export async function ServiceHero({ eyebrow, title, longDescription, slug }: ServiceHeroProps) {
  const t = await getTranslations('servizi.detail');

  return (
    <PageHero
      backLink={{ href: '/servizi', label: t('allServices') }}
      eyebrow={eyebrow}
      title={title}
      intro={longDescription}
      actions={[
        { label: t('talkAboutProject'), href: `/contatti?service=${slug}`, variant: 'primary' },
      ]}
    />
  );
}
