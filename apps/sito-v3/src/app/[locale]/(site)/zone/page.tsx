import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema } from '@/data/structured-data';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Button } from '@/components/ui/Button';
import { Section } from '@/components/ui/Section';
import { FinalCTA } from '@/components/home/FinalCTA';
import { SEO_CITIES } from '@/data/seo-cities';
import { SITE } from '@/data/site';

const PATH = '/zone';
const SITE_URL = SITE.url.replace(/\/$/, '');

const indexable = SEO_CITIES.filter((c) => c.tier <= 2);
const ciociaria = SEO_CITIES.filter((c) => c.tipo === 'ciociaria');
const capoluoghiTier1 = SEO_CITIES.filter(
  (c) => c.tipo === 'capoluogo' && c.tier === 1
).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
const ciociariaTier1 = ciociaria
  .filter((c) => c.tier === 1)
  .sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
const allCiociariaSorted = ciociaria.sort((a, b) =>
  a.nome.localeCompare(b.nome, 'it')
);

function letterGroups(items: typeof SEO_CITIES) {
  const groups = new Map<string, typeof SEO_CITIES>();
  for (const c of items) {
    const letter = c.nome.charAt(0).toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter)!.push(c);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'it'));
}

const ciociariaByLetter = letterGroups(allCiociariaSorted);

export const metadata: Metadata = {
  title: {
    absolute:
      'Zone in cui lavoro · Web design freelance a Frosinone, in Ciociaria e in Italia | Federico Calicchia',
  },
  description:
    'Web designer freelance attivo in tutta la Ciociaria (provincia di Frosinone) e nei capoluoghi italiani principali. Comuni serviti, pillar geo, mappa testuale.',
  alternates: { canonical: `${SITE_URL}${PATH}` },
  openGraph: {
    title: 'Zone in cui lavoro · Web design freelance Ciociaria + Italia',
    description:
      'Comuni serviti in Ciociaria e capoluoghi italiani con landing dedicate.',
    url: PATH,
  },
};

const collectionPageSchema = {
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'Zone in cui lavoro',
  description:
    'Comuni serviti in Ciociaria e capoluoghi italiani con landing dedicate.',
  url: `${SITE_URL}${PATH}`,
  mainEntity: {
    '@type': 'ItemList',
    numberOfItems: indexable.length,
    itemListElement: indexable.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${SITE_URL}/zone/${c.slug}`,
      name: c.nome,
    })),
  },
};

export default function ZoneHubPage() {
  return (
    <>
      <StructuredData
        json={[
          collectionPageSchema,
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Zone', url: PATH },
          ]),
        ]}
      />

      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-12 md:pb-16">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9">
            <Breadcrumbs
              items={[
                { name: 'Home', url: '/' },
                { name: 'Zone', url: PATH },
              ]}
              className="mb-8"
            />
            <Eyebrow as="p" mono className="mb-6">
              {`Zone — ${indexable.length} comuni con landing attiva`}
            </Eyebrow>
            <Heading
              as="h1"
              size="display-xl"
              className="mb-8"
              style={{ maxWidth: '20ch' }}
            >
              Zone in cui lavoro.
            </Heading>
            <p
              className="text-[length:var(--text-body-lg)] leading-relaxed"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              Vivo a Ceccano, lavoro da Frosinone. La Ciociaria non la coprono le
              agenzie milanesi: io ci sto dentro, conosco le partite IVA del
              territorio e parlo la stessa lingua. Sotto, i comuni con landing
              dedicate (Ciociaria + capoluoghi italiani principali). Lavoro anche
              fuori — basta scrivere.
            </p>
          </div>
        </div>
      </header>

      {/* Sezione 1 — Top Ciociaria (tier 1) — lista hairline numerata */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-4">
            <MonoLabel as="p" className="mb-4">
              01 — Ciociaria · Tier 1
            </MonoLabel>
            <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
              Comuni dove lavoro più spesso.
            </Heading>
            <p
              className="mt-4 text-base md:text-lg leading-relaxed"
              style={{ maxWidth: '50ch', color: 'var(--color-text-secondary)' }}
            >
              Sono i comuni con maggior numero di richieste reali — partita IVA
              locale, sede fisica, lingua condivisa.
            </p>
          </div>

          <ul role="list" className="col-span-12 md:col-span-8 flex flex-col">
            {ciociariaTier1.map((c, i) => (
              <li
                key={c.slug}
                className="border-t"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <Link
                  href={`/zone/${c.slug}`}
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
                    {c.nome}
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
            ))}
          </ul>
        </div>
      </Section>

      {/* Sezione 2 — Tutti i comuni Ciociaria — lista alfabetica */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-4">
            <MonoLabel as="p" className="mb-4">
              02 — Ciociaria · A-Z
            </MonoLabel>
            <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
              Tutti i comuni della provincia.
            </Heading>
            <p
              className="mt-4 text-base md:text-lg leading-relaxed"
              style={{ maxWidth: '50ch', color: 'var(--color-text-secondary)' }}
            >
              {ciociaria.length} comuni in provincia di Frosinone. Le landing tier
              1/2 puntano a pagine dedicate; per i tier 3 (long-tail) la richiesta
              passa per i contatti.
            </p>
          </div>

          <div className="col-span-12 md:col-span-8 flex flex-col">
            {ciociariaByLetter.map(([letter, group]) => (
              <div
                key={letter}
                className="grid grid-cols-12 gap-4 py-6 border-t"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <Heading
                  as="h3"
                  size="card"
                  className="col-span-2 md:col-span-1"
                  style={{ color: 'var(--color-accent-deep)', fontSize: '1.5rem' }}
                >
                  {letter}
                </Heading>
                <ul
                  role="list"
                  className="col-span-10 md:col-span-11 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2"
                >
                  {group.map((c) => {
                    const indexable = c.tier <= 2;
                    return (
                      <li key={c.slug}>
                        {indexable ? (
                          <Link
                            href={`/zone/${c.slug}`}
                            className="text-base leading-snug transition-opacity hover:opacity-60"
                            style={{ color: 'var(--color-text-primary)' }}
                          >
                            {c.nome}
                          </Link>
                        ) : (
                          <span
                            className="text-base leading-snug"
                            style={{ color: 'var(--color-text-tertiary)' }}
                            title={`Long-tail: ${c.nome} non ha una landing dedicata. Scrivimi e ne parliamo.`}
                          >
                            {c.nome}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Sezione 3 — Capoluoghi italiani tier 1 */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-4">
            <MonoLabel as="p" className="mb-4">
              03 — Capoluoghi italiani
            </MonoLabel>
            <Heading as="h2" size="display-md" style={{ maxWidth: '22ch' }}>
              Lavoro anche in remoto, in tutta Italia.
            </Heading>
            <p
              className="mt-4 text-base md:text-lg leading-relaxed"
              style={{ maxWidth: '50ch', color: 'var(--color-text-secondary)' }}
            >
              Capoluoghi tier 1 con landing dedicata. Roma e Milano restano i più
              richiesti — non avere uno studio lì non cambia niente sul progetto:
              il lavoro è remoto comunque.
            </p>
          </div>

          <ul role="list" className="col-span-12 md:col-span-8 flex flex-col">
            {capoluoghiTier1.map((c, i) => (
              <li
                key={c.slug}
                className="border-t"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <Link
                  href={`/zone/${c.slug}`}
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
                    {c.nome}
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
            ))}
          </ul>
        </div>
      </Section>

      {/* Sezione 4 — CTA non vedi il tuo comune */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-7 md:col-start-3">
            <MonoLabel as="p" className="mb-4">
              04 — Non vedi il tuo comune?
            </MonoLabel>
            <Heading
              as="h2"
              size="display-md"
              className="mb-6"
              style={{ maxWidth: '24ch' }}
            >
              Non c'è una landing per ogni comune. C'è una persona.
            </Heading>
            <p
              className="text-base md:text-lg leading-relaxed mb-6"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              Se il tuo comune è nella lista A-Z come long-tail (testo grigio,
              non cliccabile), o non c'è proprio, scrivimi. Lavoro su tutta
              Italia e all'estero in remoto. Una chiamata di 30 minuti chiarisce
              se ha senso lavorare insieme.
            </p>
            <Button href="/contatti" variant="solid" size="md">
              Parliamone
              <span aria-hidden="true">→</span>
            </Button>
          </div>
        </div>
      </Section>

      <FinalCTA />
    </>
  );
}
