import Image from 'next/image';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import type { Project } from '@/data/types';

interface CaseHeroProps {
  project: Project;
}

/**
 * Editorial case-study hero — Pentagram-Bierut pattern allineato alle
 * altre PageHero del sito (breadcrumbs + back link + eyebrow + display H1
 * + cover hero, niente excerpt sotto perché viene già renderizzato come
 * body della prima sezione "01 · Il contesto").
 *
 * Server component — niente parallax cover (locked: kill parallax tutto
 * /lavori). Cover image statica con viewTransitionName per morph in
 * navigation list↔detail.
 */
export async function CaseHero({ project }: CaseHeroProps) {
  const t = await getTranslations('lavori.detail');

  return (
    <section className="px-6 md:px-10 lg:px-14 pt-32 md:pt-40 pb-16 max-w-[1600px] mx-auto">
      <Breadcrumbs
        items={[
          { name: t('breadcrumbHome'), url: '/' },
          { name: t('breadcrumbLavori'), url: '/lavori' },
          { name: project.title, url: `/lavori/${project.slug}` },
        ]}
        className="mb-8"
      />

      {/* Back link compatto verso index — coerente con altre PageHero del sito.
          Mono uppercase tracking-wide. Niente icona decorativa. */}
      <Link
        href="/lavori"
        className="inline-flex items-center gap-2 mb-7 text-xs uppercase tracking-[0.18em] hover:opacity-60 transition-opacity"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        <span aria-hidden>←</span>
        {t('backToAll')}
      </Link>

      {/* Eyebrow categorial: sezione case study, anno, fino a 4 tag.
          Bierut metadata layer — client va ENORME come heading dopo (anchor
          principale dell'identificazione del progetto). */}
      <div
        className="flex flex-wrap items-baseline gap-x-6 gap-y-2 mb-7 text-xs uppercase tracking-[0.22em]"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        <span style={{ color: 'var(--color-accent-deep)' }}>{t('caseStudy')}</span>
        <span aria-hidden>·</span>
        <span>{project.year}</span>
        {project.tags.slice(0, 4).map((tag) => (
          <span key={tag} aria-label={`${t('tagLabel')}: ${tag}`}>
            <span aria-hidden>·</span> {tag}
          </span>
        ))}
      </div>

      {/* H1 display: il TITOLO è il visual (Bierut type-as-image). Niente
          max-w così la display type respira sull'intera griglia secondo
          la lunghezza naturale del titolo. */}
      <h1
        className="font-[family-name:var(--font-display)] mb-12"
        style={{
          fontSize: 'var(--text-display-xl)',
          fontWeight: 500,
          letterSpacing: '-0.035em',
          lineHeight: 0.9,
        }}
      >
        {project.title}
      </h1>

      {/* Client line sotto H1: client name in display medium come secondo
          anchor (cioè "per chi è stato fatto"). Visivamente più del tag,
          meno del titolo. */}
      {project.client && project.client !== project.title ? (
        <p
          className="font-mono text-sm uppercase tracking-[0.2em] mb-12"
          style={{ color: 'var(--color-ink)' }}
        >
          <span style={{ color: 'var(--color-text-secondary)' }}>{t('client')}</span>
          <span className="mx-3" aria-hidden>·</span>
          {project.client}
        </p>
      ) : null}

      {/* Cover image — niente parallax (kill parallax policy). Static
          rectangle 16:9 + viewTransitionName per morph navigation. */}
      <div
        className="relative w-full aspect-[16/9] overflow-hidden"
        style={{ background: 'var(--color-line)' }}
      >
        <Image
          src={project.hero.src}
          alt={project.hero.alt}
          fill
          sizes="(min-width: 1024px) 80vw, 100vw"
          priority
          className="object-cover"
          style={{ viewTransitionName: `case-${project.slug}` }}
        />
      </div>
    </section>
  );
}
