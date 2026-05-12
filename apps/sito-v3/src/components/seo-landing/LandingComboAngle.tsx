import { getTranslations } from 'next-intl/server';
import { LandingComboAngleClient } from './LandingComboAngleClient';

interface LandingComboAngleProps {
  intro: string;
  angle: string;
  index?: string;
}

/** Paragrafo deterministico (comune × servizio) per /zone/[comune]/[service]. */
export async function LandingComboAngle({
  intro,
  angle,
  index = '00',
}: LandingComboAngleProps) {
  const t = await getTranslations('landing.comboAngle');

  return (
    <LandingComboAngleClient
      intro={intro}
      angle={angle}
      index={index}
      eyebrow={t('eyebrow')}
    />
  );
}
