import { getTranslations } from 'next-intl/server';
import { LandingProblemsClient } from './LandingProblemsClient';

interface Problem {
  icon: string;
  title: string;
  desc: string;
}

interface LandingProblemsProps {
  problems: Problem[];
  index?: string;
  heading?: string;
}

export async function LandingProblems({
  problems,
  index = '01',
  heading,
}: LandingProblemsProps) {
  const t = await getTranslations('landing.problems');

  return (
    <LandingProblemsClient
      problems={problems}
      index={index}
      eyebrow={t('eyebrow')}
      heading={heading ?? t('heading')}
    />
  );
}
