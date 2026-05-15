import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import { StructuredData } from '@/components/seo/StructuredData';
import {
  breadcrumbSchema,
  collectionPageSchema,
} from '@/data/structured-data';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Button } from '@/components/ui/Button';
import { Section } from '@/components/ui/Section';
import { FinalCTA } from '@/components/home/FinalCTA';
import { SERVICES } from '@/data/services';
import {
  PROFESSION_CATEGORIES,
  SEO_PROFESSIONS,
} from '@/data/seo-professions';
import { SITE } from '@/data/site';

const PATH = '/servizi-per-professioni';
const SITE_URL = SITE.url.replace(/\/$/, '');

const indexableProfessions = SEO_PROFESSIONS.filter((p) => p.tier <= 2);

const categoriesOrdered = Object.values(PROFESSION_CATEGORIES);
const professionsByCategory = new Map(
  categoriesOrdered.map((cat) => [
    cat.id,
    indexableProfessions
      .filter((p) => p.categoryId === cat.id)
      .sort((a, b) => a.label.localeCompare(b.label, 'it')),
  ])
);

export const metadata: Metadata = {
  title: {
    absolute:
      'Servizi per professione · Sito web per ogni mestiere | Federico Calicchia',
  },
  description:
    'Web design freelance per professioni e categorie: dentisti, avvocati, ristoratori, artigiani, hotel, e-commerce. Servizi su misura per il tuo settore — il cliente non cerca "web designer", cerca "sito per [professione]".',
  alternates: { canonical: `${SITE_URL}${PATH}` },
  openGraph: {
    title: 'Servizi per professione · Sito web per ogni mestiere',
    description:
      'Web design per professioni e categorie. Landing per ogni combinazione servizio × mestiere.',
    url: PATH,
  },
};

export default function ServiziPerProfessioniHubPage() {
  const collection = collectionPageSchema({
    name: 'Servizi per professione',
    description:
      'Combinazioni servizio × professione con landing dedicata: copywriter SEO, problemi tipici del settore, FAQ, pricing.',
    url: `${SITE_URL}${PATH}`,
    items: categoriesOrdered.map((cat) => ({
      name: cat.label,
      url: `${SITE_URL}${PATH}#${cat.id}`,
    })),
  });

  return (
    <>
      <StructuredData
        json={[
          collection,
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Servizi per professione', url: PATH },
          ]),
        ]}
      />

      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-12 md:pb-16">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9">
            <Breadcrumbs
              items={[
                { name: 'Home', url: '/' },
                { name: 'Servizi per professione', url: PATH },
              ]}
              className="mb-8"
            />
            <Eyebrow as="p" mono className="mb-6">
              {`Matrice — ${categoriesOrdered.length} categorie · ${indexableProfessions.length} professioni`}
            </Eyebrow>
            <Heading
              as="h1"
              size="display-xl"
              className="mb-8"
              style={{ maxWidth: '20ch' }}
            >
              Servizi per professione.
            </Heading>
            <p
              className="text-[length:var(--text-body-lg)] leading-relaxed"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              Il tuo cliente non cerca "web designer". Cerca "sito per dentista",
              "preventivo sito per avvocato", "e-commerce per artigiano".
              Per ogni mestiere il sito ha priorità diverse: prenotazioni online,
              vetrina lavori, area riservata, listino prezzi. Sotto, la matrice di
              categorie e professioni con landing dedicate.
            </p>
          </div>
        </div>
      </header>

      {/* Sezione 1 — Tabella categorie */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-4">
            <MonoLabel as="p" className="mb-4">
              01 — Categorie
            </MonoLabel>
            <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
              Per categoria di mestiere.
            </Heading>
            <p
              className="mt-4 text-base md:text-lg leading-relaxed"
              style={{ maxWidth: '50ch', color: 'var(--color-text-secondary)' }}
            >
              Ogni categoria ha problematiche e priorità diverse — dal sito
              vetrina con galleria al portale prenotazioni con gestionale.
            </p>
          </div>

          <ul role="list" className="col-span-12 md:col-span-8 flex flex-col">
            {categoriesOrdered.map((cat, i) => {
              const count =
                professionsByCategory.get(cat.id)?.length ?? 0;
              return (
                <li
                  key={cat.id}
                  className="border-t"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <a
                    href={`#${cat.id}`}
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
                      className="col-span-7 md:col-span-8"
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 'var(--text-card-title)',
                        fontWeight: 500,
                        letterSpacing: '-0.02em',
                        lineHeight: 1.1,
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {cat.label}
                    </span>
                    <span
                      aria-hidden="true"
                      className="col-span-3 md:col-span-3 self-center text-right"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-mono-xs)',
                        letterSpacing: '0.05em',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {count} professioni →
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      </Section>

      {/* Sezione 2 — 5 servizi hairline */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-4">
            <MonoLabel as="p" className="mb-4">
              02 — Servizi
            </MonoLabel>
            <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
              Cinque servizi, un solo standard.
            </Heading>
            <p
              className="mt-4 text-base md:text-lg leading-relaxed"
              style={{ maxWidth: '50ch', color: 'var(--color-text-secondary)' }}
            >
              Web design, sviluppo, branding, e-commerce, SEO. Ogni servizio si
              combina con ogni professione, ogni combinazione ha la sua landing.
            </p>
          </div>

          <ul role="list" className="col-span-12 md:col-span-8 flex flex-col">
            {SERVICES.map((s, i) => (
              <li
                key={s.slug}
                className="border-t"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <Link
                  href={`/servizi/${s.slug}`}
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
                    {s.title}
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

      {/* Sezione 3 — Per ogni categoria, lista professioni */}
      {categoriesOrdered.map((cat) => {
        const list = professionsByCategory.get(cat.id) ?? [];
        if (list.length === 0) return null;
        return (
          <Section
            key={cat.id}
            spacing="compact"
            bordered="top"
            id={cat.id}
          >
            <div className="grid grid-cols-12 gap-6 md:gap-8 scroll-mt-32">
              <div className="col-span-12 md:col-span-4">
                <MonoLabel as="p" className="mb-4">
                  {`${cat.label} · ${list.length} professioni`}
                </MonoLabel>
                <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
                  {cat.label}.
                </Heading>
                <p
                  className="mt-4 text-base md:text-lg leading-relaxed"
                  style={{ maxWidth: '50ch', color: 'var(--color-text-secondary)' }}
                >
                  {cat.description}
                </p>
              </div>

              <ul
                role="list"
                className="col-span-12 md:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-x-6"
              >
                {list.map((p, i) => (
                  <li
                    key={p.slug}
                    className="border-t"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <Link
                      href={`/sito-web-per-${p.slug}`}
                      className="grid grid-cols-12 gap-3 py-4 transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      <span
                        aria-hidden="true"
                        className="col-span-2 tabular-nums"
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
                        className="col-span-9"
                        style={{
                          color: 'var(--color-text-primary)',
                          fontFamily: 'var(--font-sans)',
                          fontSize: '1rem',
                          lineHeight: 1.3,
                        }}
                      >
                        {p.label}
                      </span>
                      <span
                        aria-hidden="true"
                        className="col-span-1 self-center text-right"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 'var(--text-mono-xs)',
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
        );
      })}

      {/* Sezione 4 — CTA */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-7 md:col-start-3">
            <MonoLabel as="p" className="mb-4">
              {`${categoriesOrdered.length + 2} — Non vedi il tuo mestiere?`}
            </MonoLabel>
            <Heading
              as="h2"
              size="display-md"
              className="mb-6"
              style={{ maxWidth: '24ch' }}
            >
              La matrice copre i mestieri più richiesti. Per gli altri, scrivimi.
            </Heading>
            <p
              className="text-base md:text-lg leading-relaxed mb-6"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              Il sito copre {indexableProfessions.length} professioni con landing
              indicizzate. Se il tuo mestiere è long-tail, lavoriamo direttamente
              su preventivo. Una chiamata di 30 minuti chiarisce se ha senso.
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
