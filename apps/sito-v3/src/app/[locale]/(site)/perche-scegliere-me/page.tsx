import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { HeroNarrative } from '@/components/about/HeroNarrative';
import { LaScintilla } from '@/components/about/LaScintilla';
import { ServicesGrid } from '@/components/home/ServicesGrid';
import { ManifestoSlides } from '@/components/about/ManifestoSlides';
import { TeamSection } from '@/components/about/TeamSection';
import { PerchiFaqs } from '@/components/about/PerchiFaqs';
import { ApproachStack } from '@/components/about/ApproachStack';
import { SkillsGravity } from '@/components/home/SkillsGravity';
import { CuriositaList } from '@/components/about/CuriositaList';
import { TrustBento } from '@/components/home/TrustBento';
import { BlogLatest } from '@/components/blog/BlogLatest';
import { FinalCTA } from '@/components/home/FinalCTA';
import { PerChiLavoro } from '@/components/seo/PerChiLavoro';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema, faqPageSchema } from '@/data/structured-data';
import { getPerchiFaqs } from '@/data/perchi-faqs';
import { getServices } from '@/data/services';
import type { Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical, buildOgLocale } from '@/lib/canonical';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('perche.metadata');
  const locale = (await getLocale()) as Locale;

  return {
    title: {
      absolute: t('title'),
    },
    description: t('description'),
    alternates: buildI18nAlternates('/perche-scegliere-me', locale),
    openGraph: {
      title: t('ogTitle'),
      description: t('ogDescription'),
      url: buildCanonical('/perche-scegliere-me', locale),
      ...buildOgLocale(locale),
    },
  };
}

/**
 * /perche-scegliere-me — pagina manifesto della freelance practice.
 *
 * Composizione (12 sezioni, port 1:1 dal legacy):
 *   01. HeroNarrative   — video + avatar + value prop (kill marquee policy)
 *   02. LaScintilla     — "Zero intermediari" two-column con liste skill
 *   03. ServicesGrid    — riuso da home (cosa faccio per te)
 *   04. ManifestoSlides — 7-slide pin scroll (slide 4 e 7 accent)
 *   05. TeamSection     — Paolo + Davide ("non lavoro da solo")
 *   06. PerchiFaqs      — 6 FAQ specifiche (no prezzi)
 *   07. ApproachStack   — 5 pilastri
 *   08. SkillsGravity   — playground signature (Swiss exception 2026-05-09:
 *                          tollerato SOLO qui come voce personale autobiografica;
 *                          rimosso dalla home, prefers-reduced-motion gated)
 *   09. CuriositaList   — chi c'è dietro lo schermo (6 item personali)
 *   10. TrustBento      — Google Reviews + clienti
 *   11. BlogLatest      — ultimi 3 articoli
 *   12. FinalCTA        — magnetic button verso /contatti
 */
export default async function PercheScegliereMePage() {
  const locale = (await getLocale()) as Locale;
  const services = getServices(locale);
  const faqs = getPerchiFaqs(locale);
  const tSkills = await getTranslations('perche.skillsOverride');
  const tBlog = await getTranslations('perche.blogLatestOverride');
  const tBreadcrumbs = await getTranslations('perche.structuredData');

  return (
    <article>
      <StructuredData
        json={[
          breadcrumbSchema([
            { name: tBreadcrumbs('breadcrumbHome'), url: '/' },
            { name: tBreadcrumbs('breadcrumbCurrent'), url: '/perche-scegliere-me' },
          ]),
          faqPageSchema(faqs),
        ]}
      />
      <HeroNarrative />
      <LaScintilla index="02" />
      <ServicesGrid services={services} />
      <ManifestoSlides />
      <TeamSection index="05" eyebrow="Team" />
      <PerchiFaqs index="06" />
      <ApproachStack index="07" />
      <SkillsGravity
        index="08"
        eyebrow={tSkills('eyebrow')}
        title={tSkills('title')}
        subtitle={tSkills('subtitle')}
        counterLabel={tSkills('counterLabel')}
      />
      <CuriositaList index="09" />
      <PerChiLavoro index="10" />
      <TrustBento />
      <BlogLatest index="12" title={tBlog('title')} />
      <FinalCTA />
    </article>
  );
}
