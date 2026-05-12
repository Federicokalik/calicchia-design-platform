import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CaseHero } from '@/components/case-study/CaseHero';
import { CaseStaleNotice } from '@/components/case-study/CaseStaleNotice';
import { CaseOverview } from '@/components/case-study/CaseOverview';
import { CaseQuote } from '@/components/case-study/CaseQuote';
import { CaseChallenge } from '@/components/case-study/CaseChallenge';
import { CaseGallery } from '@/components/case-study/CaseGallery';
import { CaseOutcome } from '@/components/case-study/CaseOutcome';
import { CaseLongform } from '@/components/case-study/CaseLongform';
import { CaseNext } from '@/components/case-study/CaseNext';
import {
  fetchAllPublishedProjects,
  fetchProjectBySlug,
} from '@/lib/projects-api';
import {
  adaptApiProjectToLegacy,
  deriveCaseStudyExtension,
  deriveFeedbackQuote,
} from '@/lib/projects-adapter';
import type { Project } from '@/data/types';
import { SITE } from '@/data/site';
import { breadcrumbSchema as buildBreadcrumbSchema } from '@/data/structured-data';
import type { Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical } from '@/lib/canonical';
import { getLocale } from 'next-intl/server';

const SITE_URL = SITE.url.replace(/\/$/, '');

interface Params {
  slug: string;
}

export async function generateStaticParams(): Promise<Params[]> {
  const list = await fetchAllPublishedProjects();
  return list.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const detail = await fetchProjectBySlug(slug);
  if (!detail) return { title: 'Progetto non trovato' };
  const { project } = detail;
  const locale = (await getLocale()) as Locale;

  // SEO override (migration 075). Se l'editor ha valorizzato seo_title /
  // seo_description, vincono sul fallback derivato da title/description.
  const title =
    project.seo_title ??
    `${project.title} · Case study${project.client ? ` ${project.client}` : ''}`;
  const description =
    project.seo_description ??
    project.description ??
    `Case study: ${project.title}.`;
  const url = `/lavori/${project.slug}`;

  return {
    title,
    description,
    alternates: buildI18nAlternates(url, locale),
    openGraph: {
      title,
      description,
      url: buildCanonical(url, locale),
      images: project.cover_image ? [{ url: project.cover_image }] : undefined,
    },
  };
}

export default async function CaseStudyPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const detail = await fetchProjectBySlug(slug);
  if (!detail) notFound();

  const project: Project = adaptApiProjectToLegacy(detail.project);
  const ext = deriveCaseStudyExtension(detail.project);
  const feedback = deriveFeedbackQuote(detail.project);

  // Anti self-loop: backend prev/next is circular. If both equal current,
  // it means there's a single published project — no neighbours to show.
  const isSelfLoop =
    detail.prev?.slug === slug && detail.next?.slug === slug;
  const next = isSelfLoop ? null : detail.next;
  const nextProject: Project | undefined = next
    ? {
        slug: next.slug,
        title: next.title,
        client: next.title,
        year: project.year,
        tags: [],
        excerpt: '',
        hero: {
          src: project.hero.src,
          alt: `${next.title} — preview`,
          width: 2400,
          height: 1350,
        },
        sections: [],
        next: '',
      }
    : undefined;

  // Estrazione sezioni dal Project legacy (mantenute per back-compat
  // con CaseHero/CaseOverview/CaseChallenge/CaseGallery).
  const overview = project.sections.find(
    (s) => s.kind === 'overview' && s.title === 'Il contesto',
  );
  const solution = project.sections.find(
    (s) => s.kind === 'overview' && s.title === "L'approccio",
  );
  const challenge = project.sections.find((s) => s.kind === 'challenge');
  const gallery = project.sections.find((s) => s.kind === 'gallery');

  // ── JSON-LD CreativeWork esteso ───────────────────────────────────
  // Schema migliorato (decision lock #5: lavori da DB) con:
  //   - dateCreated dal campo year (migration 075) o created_at
  //   - inLanguage it-IT
  //   - author/creator riferito al Person (Federico)
  //   - mainEntityOfPage: la URL canonica
  //   - keywords: tags + technologies + services concatenati
  //   - workExample: live_url (se presente)
  // Niente Review/AggregateRating per coerenza con TrustIndex unico
  // fornitore recensioni (decision lock P2-11 #3).
  const dateCreated = ext.year
    ? `${ext.year}-01-01`
    : detail.project.published_at ?? detail.project.created_at;
  const keywords = [
    ...(detail.project.tags ?? []),
    ...(detail.project.technologies ?? []),
    ...(detail.project.services
      ? detail.project.services.split(/[·,;|]/).map((s) => s.trim()).filter(Boolean)
      : []),
  ].filter(Boolean);

  const creativeWorkSchema = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: detail.project.title,
    headline: detail.project.title,
    description:
      detail.project.seo_description ?? detail.project.description ?? undefined,
    image: detail.project.cover_image ?? undefined,
    inLanguage: 'it-IT',
    dateCreated,
    datePublished: detail.project.published_at ?? undefined,
    author: { '@id': `${SITE_URL}/#person` },
    creator: { '@id': `${SITE_URL}/#person` },
    mainEntityOfPage: `${SITE_URL}/lavori/${detail.project.slug}`,
    url: `${SITE_URL}/lavori/${detail.project.slug}`,
    about: detail.project.industries ?? undefined,
    keywords: keywords.length > 0 ? keywords.join(', ') : undefined,
    workExample: detail.project.live_url
      ? { '@type': 'WebSite', url: detail.project.live_url }
      : undefined,
  };

  const breadcrumbSchema = buildBreadcrumbSchema([
    { name: 'Home', url: '/' },
    { name: 'Lavori', url: '/lavori' },
    { name: detail.project.title, url: `/lavori/${detail.project.slug}` },
  ]);

  return (
    <article>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([creativeWorkSchema, breadcrumbSchema]),
        }}
      />

      <CaseHero project={project} />

      {ext.isStale ? (
        <CaseStaleNotice
          year={ext.year}
          yearsAgo={ext.yearsAgo}
          liveUrl={ext.liveUrl}
        />
      ) : null}

      {/* Numbering sequenziale Pentagram-style: ogni sezione editorial ha
          il suo prefisso 01..06. Hero/StaleNotice/Quote/Next sono "no number"
          (intro, metadata, pausa, navigation). */}
      {overview ? (
        <CaseOverview section={overview} index="01" eyebrowLabel="Il contesto" />
      ) : null}
      {challenge ? <CaseChallenge section={challenge} index="02" /> : null}
      {solution ? (
        <CaseOverview section={solution} index="03" eyebrowLabel="L'approccio" />
      ) : null}

      <CaseOutcome
        outcome={ext.outcome}
        metrics={ext.metrics}
        index="04"
      />

      <CaseLongform markdown={ext.longformMarkdown} index="05" />

      {feedback ? (
        <CaseQuote
          quote={`"${feedback.quote}"`}
          attribution={feedback.attribution}
        />
      ) : null}

      {gallery ? <CaseGallery section={gallery} index="06" /> : null}

      <CaseNext next={nextProject} />
    </article>
  );
}
