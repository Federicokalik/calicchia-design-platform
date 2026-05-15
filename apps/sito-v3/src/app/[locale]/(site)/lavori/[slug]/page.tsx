import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CaseHeroOverlay } from '@/components/case-study/CaseHeroOverlay';
import { CaseStaleNotice } from '@/components/case-study/CaseStaleNotice';
import { CaseBrief } from '@/components/case-study/CaseBrief';
import { CaseGallery } from '@/components/case-study/CaseGallery';
import { CaseOutcome } from '@/components/case-study/CaseOutcome';
import { CaseQuote } from '@/components/case-study/CaseQuote';
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
import { buildI18nAlternates, buildCanonical, buildOgLocale } from '@/lib/canonical';
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
      ...buildOgLocale(locale),
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

  // Gallery: l'unica sezione editorial residua dopo il redesign 090.
  const gallery = project.sections.find((s) => s.kind === 'gallery');

  // ── JSON-LD CreativeWork esteso ───────────────────────────────────
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

      <CaseHeroOverlay
        project={project}
        client={ext.client}
        services={ext.servicesLine}
      />

      {ext.isStale ? (
        <CaseStaleNotice
          year={ext.year}
          yearsAgo={ext.yearsAgo}
          liveUrl={ext.liveUrl}
        />
      ) : null}

      {/* Detail redesign 2026-05-14: la sequenza scende da 8 a 5 sezioni.
          Brief unico (markdown) sostituisce Contesto + Sfida + Approccio +
          Longform. Galleria, Outcome, Quote, Next invariati. */}
      <CaseBrief markdown={ext.brief} index="01" />

      {gallery ? <CaseGallery section={gallery} index="02" /> : null}

      <CaseOutcome outcome={ext.outcome} metrics={ext.metrics} index="03" />

      {feedback ? (
        <CaseQuote
          quote={`"${feedback.quote}"`}
          attribution={feedback.attribution}
        />
      ) : null}

      <CaseNext next={nextProject} />
    </article>
  );
}
