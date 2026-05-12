import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { buildI18nAlternates, buildCanonical } from '@/lib/canonical';
import { Hero } from '@/components/home/Hero';
import { PortraitBlock } from '@/components/home/PortraitBlock';
import { WorksHorizontal } from '@/components/home/WorksHorizontal';
import { TrustBento } from '@/components/home/TrustBento';
import { ServicesGrid } from '@/components/home/ServicesGrid';
import { HowIWork } from '@/components/home/HowIWork';
import { FinalCTA } from '@/components/home/FinalCTA';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { getServices } from '@/data/services';
import type { ShowcaseTile } from '@/data/showcase';
import { getYearsOfExperience } from '@/data/site';
import type { Locale } from '@/lib/i18n';
import { fetchAllPublishedProjects } from '@/lib/projects-api';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('home.metadata');
  const locale = (await getLocale()) as Locale;

  return {
    title: {
      absolute: t('title'),
    },
    description: t('description'),
    alternates: buildI18nAlternates('/', locale),
    openGraph: {
      title: t('ogTitle'),
      description: t('ogDescription'),
      url: buildCanonical('/', locale),
    },
  };
}

/**
 * Homepage — marketing-driven AIDA flow.
 *
 *   1. Hero          — Attention (signature)
 *   2. PortraitBlock — Hook (compressed bio + 4 stats)
 *   3. WorksHorizontal — Interest (Swiss exception: pin scrub allowed only on home)
 *   4. TrustBento    — Trust (TrustIndex Google Reviews — widget carica recensioni reali)
 *   5. ServicesGrid  — Desire (primary conversion driver)
 *   6. HowIWork      — Reasoning (manifesto pillars + process fasi, unified)
 *   7. FinalCTA      — Action (magnetic button)
 *
 * Swiss compliance audit 2026-05-09: rimossi HeroMarquee + SkillsGravity dalla
 * home (zero marquee globale; gravity playground solo in /perche-scegliere-me
 * come signature personale).
 */
export default async function HomePage() {
  const years = getYearsOfExperience();
  const locale = (await getLocale()) as Locale;
  const services = getServices(locale);
  const projects = await fetchAllPublishedProjects();
  const showcase: ShowcaseTile[] = projects.slice(0, 6).map((p) => ({
    src: p.cover_image ?? '',
    client: '',
    title: p.title,
    year: 0,
    tags: p.tags ?? [],
    href: `/lavori/${p.slug}`,
  }));

  return (
    <>
      <SiteHeader />
      <main>
        {/* 01 — Hero (Pentagram signature) */}
        <Hero years={years} />
        {/* 02 — Portrait + bio compresso */}
        <PortraitBlock years={years} />
        {/* 03 — Lavori (UNICO pin della home) — top 6 più recenti dal DB */}
        {showcase.length > 0 ? <WorksHorizontal showcase={showcase} /> : null}
        {/* 04 — Trust block (TrustIndex widget carica recensioni Google reali) */}
        <TrustBento />
        {/* 05 — Servizi (asymmetric 12-col) — primary conversion driver */}
        <ServicesGrid services={services} />
        {/* 06 — Come lavoro (manifesto + process unificati) */}
        <HowIWork />
        {/* 07 — Final CTA (magnetic button) */}
        <FinalCTA />
      </main>
      <SiteFooter />
    </>
  );
}
