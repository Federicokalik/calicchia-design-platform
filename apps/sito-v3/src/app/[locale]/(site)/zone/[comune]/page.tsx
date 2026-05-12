import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SEO_CITIES, getCityBySlug } from '@/data/seo-cities';
import { SEO_SERVICES } from '@/data/seo-service-matrix';
import { COMUNE_ATTRIBUTES, getPreposizione } from '@/lib/comune-attributes';
import { buildCanonical } from '@/lib/canonical';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema, localBusinessSchema } from '@/data/structured-data';
import { LandingHero } from '@/components/seo-landing/LandingHero';
import { LandingCta } from '@/components/seo-landing/LandingCta';
import { RelatedZones } from '@/components/seo-landing/RelatedZones';

interface Params {
  locale?: Locale;
  comune: string;
}

export function generateStaticParams(): Params[] {
  return SEO_CITIES.filter((c) => c.tier <= 2).map((c) => ({ comune: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { comune, locale = DEFAULT_LOCALE } = await params;
  const city = getCityBySlug(comune);
  if (!city) return { title: 'Zona non trovata' };
  const prep = getPreposizione(city.nome);
  return {
    title: `Web designer ${prep} ${city.nome}`,
    description: `Progettazione siti web, e-commerce, SEO ${prep} ${city.nome}. Lavoro con professionisti e attività della zona.`,
    alternates: { canonical: buildCanonical(`/zone/${comune}`, locale) },
    robots: city.tier <= 2 ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function ZonaComunePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { comune, locale = DEFAULT_LOCALE } = await params;
  const city = getCityBySlug(comune);
  if (!city) notFound();

  const attrs = COMUNE_ATTRIBUTES[comune];
  const prep = getPreposizione(city.nome);
  const prepCap = prep === 'ad' ? 'Ad' : 'A';

  const availableServices = attrs ? SEO_SERVICES : [];

  const intro = attrs
    ? `${prepCap} ${city.nome}, ${attrs.isUniversitaria ? 'città universitaria' : attrs.isIndustriale ? 'polo produttivo' : attrs.isTuristica ? 'destinazione turistica' : attrs.isStorica ? 'centro storico' : attrs.isCapoluogo ? 'capoluogo di provincia' : 'centro vitale'} ${city.regione !== 'Lazio' ? `nella regione ${city.regione}` : 'del Lazio'}, le attività cercano un partner digitale che capisca il territorio. Progetto siti, e-commerce, brand e strategie SEO per chi lavora qui.`
    : `${prepCap} ${city.nome} progetto siti web, e-commerce e strategie SEO per professionisti e attività della zona. Lavoro da remoto ma penso locale.`;

  return (
    <article>
      <StructuredData
        json={[
          localBusinessSchema({ comune: city.nome, areaServed: [city.nome] }),
          breadcrumbSchema([
            { name: 'Home', url: buildCanonical('/', locale) },
            { name: 'Zone', url: buildCanonical('/zone', locale) },
            { name: city.nome, url: buildCanonical(`/zone/${city.slug}`, locale) },
          ]),
        ]}
      />

      <LandingHero
        eyebrow={`Zona · ${city.regione}`}
        title={`Web design ${prep} ${city.nome}.`}
        intro={intro}
        backHref="/lavori"
        backLabel="Lavori recenti"
      />

      {availableServices.length > 0 && (
        <section
          className="relative px-6 md:px-10 lg:px-14 py-32 md:py-44 max-w-[1600px] mx-auto"
          style={{ borderTop: '1px solid var(--color-line)' }}
        >
          <div className="flex items-baseline justify-between gap-6 mb-16 md:mb-24">
            <p
              className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              01 — Servizi disponibili {prep} {city.nome}
            </p>
            <span
              className="text-xs uppercase tracking-[0.18em]"
              style={{ color: 'var(--color-ink-subtle)' }}
            >
              {availableServices.length} servizi
            </span>
          </div>

          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-2">
            {availableServices.map((s, idx) => (
              <li key={s.slug}>
                <Link
                  href={`/zone/${city.slug}/${s.slug}`}
                  className="group grid grid-cols-12 gap-4 py-8 transition-colors hover:bg-[var(--color-bg-elev)]"
                  style={{
                    borderTop: idx < 2 ? '1px solid var(--color-line)' : 'none',
                    borderBottom: '1px solid var(--color-line)',
                  }}
                >
                  <span
                    className="col-span-1 font-mono text-xs pt-3 tabular-nums"
                    style={{ color: 'var(--color-accent-deep)' }}
                  >
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <h2
                    className="col-span-9 font-[family-name:var(--font-display)] text-2xl md:text-3xl"
                    style={{ fontWeight: 500, letterSpacing: '-0.02em' }}
                  >
                    {s.label} {prep} {city.nome}
                  </h2>
                  <span
                    className="col-span-2 self-center justify-self-end text-2xl transition-transform group-hover:translate-x-2"
                    aria-hidden
                  >
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RelatedZones currentSlug={city.slug} limit={4} />

      <LandingCta
        text={`Progetti ${prep} ${city.nome}? Sentiamoci.`}
        href={`/contatti?city=${city.slug}`}
        index="02"
      />
    </article>
  );
}
