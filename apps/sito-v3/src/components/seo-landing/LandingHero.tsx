import { getTranslations } from 'next-intl/server';
import { PageHero } from '@/components/layout/PageHero';

interface LandingHeroProps {
  eyebrow?: string;
  title: string;
  intro: string;
  /** Optional secondary line under the intro (e.g. tagline-specifico) */
  tagline?: string;
  /** Optional back link href + label */
  backHref?: string;
  backLabel?: string;
}

export async function LandingHero({
  eyebrow,
  title,
  intro,
  tagline,
  backHref,
  backLabel,
}: LandingHeroProps) {
  const t = await getTranslations('landing.hero');

  return (
    <PageHero
      eyebrow={eyebrow ?? t('eyebrowFallback')}
      title={title}
      intro={intro}
      tagline={tagline}
      backLink={backHref ? { href: backHref, label: backLabel ?? t('backFallback') } : undefined}
      compact
    />
  );
}
