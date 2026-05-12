import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { SEO_CITIES } from '@/data/seo-cities';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';

interface RelatedZonesProps {
  /** Slug del comune corrente: viene escluso dalla lista. */
  currentSlug: string;
  /** Numero massimo di zone vicine da mostrare. */
  limit?: number;
  /** Slug servizio per linkare a `/zone/<comune>/<service>` invece di `/zone/<comune>`. */
  serviceSlug?: string;
}

/**
 * RelatedZones — lista hairline di comuni vicini.
 *
 * Heuristic di "vicinanza":
 *   1. Stessa regione del corrente
 *   2. Stesso `tipo` (capoluogo / ciociaria) per cluster locali
 *   3. Tier ≤ 2 (no long-tail noindex)
 *   4. Cap a `limit` voci (default 4) — ordinate alfabeticamente
 *
 * Pattern Swiss (vedi SWISS-RULES): 12-col grid asymmetric, hairline 1px,
 * mono numbering 01..0N, NO 3-col simmetrico, NO card-shadow.
 */
export async function RelatedZones({ currentSlug, limit = 4, serviceSlug }: RelatedZonesProps) {
  const t = await getTranslations('landing.relatedZones');
  const current = SEO_CITIES.find((city) => city.slug === currentSlug);
  if (!current) return null;

  const related = SEO_CITIES.filter(
    (city) =>
      city.slug !== currentSlug &&
      city.tier <= 2 &&
      city.regione === current.regione &&
      city.tipo === current.tipo
  )
    .sort((a, b) => a.nome.localeCompare(b.nome, 'it'))
    .slice(0, limit);

  if (related.length === 0) return null;

  return (
    <Section spacing="compact" bordered="top">
      <div className="grid grid-cols-12 gap-6 md:gap-8">
        <div className="col-span-12 md:col-span-4">
          <MonoLabel as="p" className="mb-4">
            {t('heading', { region: current.regione })}
          </MonoLabel>
          <Heading as="h2" size="display-sm" style={{ maxWidth: '20ch' }}>
            {t('subheading')}
          </Heading>
        </div>

        <ul role="list" className="col-span-12 md:col-span-8 flex flex-col">
          {related.map((zone, i) => {
            const path = serviceSlug
              ? `/zone/${zone.slug}/${serviceSlug}`
              : `/zone/${zone.slug}`;
            return (
              <li
                key={zone.slug}
                className="border-t"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <Link
                  href={path}
                  className="grid grid-cols-12 gap-4 py-5 transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <span
                    aria-hidden="true"
                    className="col-span-2 md:col-span-1 tabular-nums"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-mono-xs)',
                      letterSpacing: '0.05em',
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    className="col-span-7 md:col-span-9"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'var(--text-card-title)',
                      fontWeight: 500,
                      letterSpacing: '-0.02em',
                      lineHeight: 1.1,
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    {zone.nome}
                  </span>
                  <span
                    aria-hidden="true"
                    className="col-span-3 md:col-span-2 self-center text-right"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-mono-xs)',
                      letterSpacing: '0.05em',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    →
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}
