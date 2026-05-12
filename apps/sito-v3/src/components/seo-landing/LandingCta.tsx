import { getTranslations } from 'next-intl/server';
import { LandingCtaClient } from './LandingCtaClient';

interface LandingCtaProps {
  text: string;
  href?: string;
  buttonLabel?: string;
  index?: string;
}

export async function LandingCta({
  text,
  href = '/contatti',
  buttonLabel,
  index = '05',
}: LandingCtaProps) {
  const t = await getTranslations('landing.cta');

  return (
    <LandingCtaClient
      text={text}
      href={href}
      buttonLabel={buttonLabel ?? t('button')}
      index={index}
      eyebrow={t('eyebrow')}
    />
  );
}
