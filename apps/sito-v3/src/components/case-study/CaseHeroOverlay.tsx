import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import type { Project } from '@/data/types';

interface CaseHeroOverlayProps {
  project: Project;
  client: string | null;
  services: string | null;
}

/**
 * Detail-page hero — cover dominante con titolo + meta strip in overlay
 * (decision 2026-05-14): l'identita' del lavoro vive DENTRO l'immagine, non
 * accanto. Passepartout = container max-w-[1600px] + padding responsive
 * intorno alla cover (la cover non e' full-bleed). Gradient bottom-up
 * garantisce leggibilita' del testo bianco indipendentemente dall'immagine.
 *
 * Sostituisce CaseHero (migration 090 — redesign detail).
 */
export async function CaseHeroOverlay({
  project,
  client,
  services,
}: CaseHeroOverlayProps) {
  const t = await getTranslations('lavori.detail');

  // Meta segments: client (se differente dal title), anno, servizi (primi 2-3).
  const servicesShort = services
    ? services
        .split(/[·,;|]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' · ')
    : null;

  const metaSegments: string[] = [];
  if (client && client !== project.title) metaSegments.push(client);
  metaSegments.push(String(project.year));
  if (servicesShort) metaSegments.push(servicesShort);

  return (
    <section className="px-6 md:px-10 lg:px-14 pt-28 md:pt-36 pb-12 max-w-[1600px] mx-auto">
      <Breadcrumbs
        items={[
          { name: t('breadcrumbHome'), url: '/' },
          { name: t('breadcrumbLavori'), url: '/lavori' },
          { name: project.title, url: `/lavori/${project.slug}` },
        ]}
        className="mb-6"
      />

      <Link
        href="/lavori"
        className="inline-flex items-center gap-2 mb-8 text-xs uppercase tracking-[0.18em] hover:opacity-60 transition-opacity"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        <span aria-hidden>←</span>
        {t('backToAll')}
      </Link>

      {/* Cover con overlay. aspect-[16/9] mantiene il rapporto coerente con
          la card index (view transition `case-${slug}` morpha bene). Niente
          parallax (kill parallax policy). Gradient bottom-up dal nero per
          contrasto AA sul testo bianco anche su cover chiare. */}
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

        {/* Gradient overlay — limita la zona scura alla meta inferiore
            (~55%) per non oscurare troppo l'immagine. */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.42) 28%, rgba(0,0,0,0.08) 55%, rgba(0,0,0,0) 70%)',
          }}
        />

        {/* Overlay content: meta strip + titolo display. Allineato bottom-left,
            inset responsive. */}
        <div className="absolute inset-x-5 sm:inset-x-8 md:inset-x-12 bottom-5 sm:bottom-8 md:bottom-12 flex flex-col gap-3 md:gap-5">
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px] sm:text-xs uppercase tracking-[0.22em]"
            style={{ color: 'rgba(255,255,255,0.92)' }}
          >
            <span
              className="inline-block px-2.5 py-1 rounded-full"
              style={{
                background: 'rgba(255,255,255,0.14)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
              }}
            >
              {t('caseStudy')}
            </span>
            {metaSegments.map((seg, i) => (
              <span key={`${seg}-${i}`} className="flex items-center gap-3">
                <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                <span>{seg}</span>
              </span>
            ))}
          </div>

          <h1
            className="font-[family-name:var(--font-display)] text-white"
            style={{
              fontSize: 'clamp(2rem, 6vw, 5.5rem)',
              fontWeight: 500,
              letterSpacing: '-0.035em',
              lineHeight: 0.92,
              maxWidth: '20ch',
              textShadow: '0 2px 24px rgba(0,0,0,0.35)',
            }}
          >
            {project.title}
          </h1>
        </div>
      </div>
    </section>
  );
}
