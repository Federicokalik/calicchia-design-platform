import { getTranslations } from 'next-intl/server';
import { LandingFeaturesClient } from './LandingFeaturesClient';

interface Feature {
  title: string;
  description: string;
}

interface LandingFeaturesProps {
  features: Feature[];
  index?: string;
  heading?: string;
  profession?: string;
}

export async function LandingFeatures({
  features,
  index = '02',
  heading,
  profession,
}: LandingFeaturesProps) {
  const t = await getTranslations('landing.features');
  const resolvedHeading = heading ?? (
    profession ? t('heading', { profession }) : t('fallbackHeading')
  );

  return (
    <LandingFeaturesClient
      features={features}
      index={index}
      heading={resolvedHeading}
      countLabel={t('itemsCount', { count: features.length })}
    />
  );
}
