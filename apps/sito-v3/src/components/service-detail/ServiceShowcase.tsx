import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';
import { fetchProjectsForService } from '@/lib/projects-api';
import { adaptApiListItem } from '@/lib/projects-adapter';

interface ServiceShowcaseProps {
  /** Service slug used to filter projects (matches API ?service= param). */
  serviceSlug: string;
  /** Max number of project tiles. */
  limit?: number;
  /** Eyebrow ordinal, e.g. "04". */
  index?: string;
  /** Heading override (default: "Lavori realizzati con questo servizio."). */
  heading?: string;
}

/**
 * ServiceShowcase — vertical hairline list of projects filtered by service.
 *
 * Pattern (eredita SWISS-RULES): 12-col asymmetric, hairline 1px tra card,
 * thumbnail offset col 8-12, mono numbering 01..0N, NO 3-col simmetrico.
 * Hides itself completely when no projects match (empty state passive — vedi
 * piano P0-04 task 4.5).
 */
export async function ServiceShowcase({
  serviceSlug,
  limit = 4,
  index = '04',
  heading,
}: ServiceShowcaseProps) {
  const t = await getTranslations('servizi.detail');
  const apiList = await fetchProjectsForService(serviceSlug, limit);
  if (apiList.length === 0) return null;

  const projects = apiList.map((p) => adaptApiListItem(p));

  return (
    <Section spacing="default" bordered="top">
      <div className="grid grid-cols-12 gap-6 md:gap-8">
        <div className="col-span-12 md:col-span-9 mb-12 md:mb-16">
          <Eyebrow as="p" mono className="mb-4">
            {t('showcaseEyebrow', { index, service: serviceSlug })}
          </Eyebrow>
          <Heading
            as="h2"
            size="display-md"
            style={{ maxWidth: '24ch' }}
          >
            {heading ?? t('showcaseHeading')}
          </Heading>
        </div>
      </div>

      <ul role="list" className="flex flex-col">
        {projects.map((p, i) => {
          const cover = p.cover_image;
          return (
            <li
              key={p.slug}
              className="border-t"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <Link
                href={`/lavori/${p.slug}`}
                className="grid grid-cols-12 gap-6 md:gap-8 py-10 md:py-12 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 hover:opacity-90"
              >
                <div className="col-span-12 md:col-span-7 flex flex-col gap-3">
                  <div
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-mono-xs)',
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    <span aria-hidden="true">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span>·</span>
                    <span style={{ color: 'var(--color-text-primary)' }}>
                      {p.tags.length > 0 ? p.tags.slice(0, 3).join(' · ') : t('projectFallback')}
                    </span>
                    <span>·</span>
                    <span>{p.year}</span>
                  </div>

                  <Heading as="h3" size="display-sm" style={{ maxWidth: '20ch' }}>
                    {p.title}
                  </Heading>

                  {p.description ? (
                    <p
                      className="text-base md:text-lg leading-relaxed"
                      style={{
                        maxWidth: '55ch',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {p.description}
                    </p>
                  ) : null}

                  <MonoLabel as="span" tone="accent" className="mt-3">
                    {t('openCaseStudy')} →
                  </MonoLabel>
                </div>

                <div className="col-span-12 md:col-span-5 md:col-start-8 self-start">
                  {cover ? (
                    <div className="relative aspect-video overflow-hidden">
                      <Image
                        src={cover}
                        alt={t('coverAlt', { title: p.title })}
                        fill
                        sizes="(min-width: 768px) 35vw, 100vw"
                        className="object-cover"
                      />
                    </div>
                  ) : (
                    <div
                      className="aspect-video flex items-center justify-center"
                      style={{
                        background: 'var(--color-surface-elev)',
                        borderTop: '1px solid var(--color-border)',
                        borderBottom: '1px solid var(--color-border)',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontSize: '4rem',
                          fontWeight: 500,
                          letterSpacing: '-0.04em',
                          color: 'var(--color-text-tertiary)',
                        }}
                      >
                        {p.title.charAt(0)}
                      </span>
                    </div>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
        <li
          className="border-t"
          style={{ borderColor: 'var(--color-border)' }}
          aria-hidden="true"
        />
      </ul>
    </Section>
  );
}
