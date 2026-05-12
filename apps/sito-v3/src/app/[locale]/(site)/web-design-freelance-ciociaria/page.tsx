import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { StructuredData } from '@/components/seo/StructuredData';
import {
  breadcrumbSchema,
  localBusinessSchema,
  serviceSchema,
} from '@/data/structured-data';
import { SEO_CITIES } from '@/data/seo-cities';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { FinalCTA } from '@/components/home/FinalCTA';

const CIOCIARIA_TIER1 = SEO_CITIES.filter(
  (c) => c.tipo === 'ciociaria' && c.tier === 1
);
const CIOCIARIA_TOTAL = SEO_CITIES.filter((c) => c.tipo === 'ciociaria').length + 1; // + Frosinone capoluogo

const TIER1_LIST = [
  { slug: 'frosinone', nome: 'Frosinone' },
  ...CIOCIARIA_TIER1.map((c) => ({ slug: c.slug, nome: c.nome })),
].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));

export const metadata: Metadata = {
  title: {
    absolute: `Web Designer Freelance in Ciociaria · Lavoro a Ceccano e in ${CIOCIARIA_TOTAL} comuni della provincia | Federico Calicchia`,
  },
  description: `Web designer freelance in Ciociaria, Frosinone. Sito fisico a Ceccano, lavoro su tutto il territorio ciociaro. ${CIOCIARIA_TOTAL} comuni serviti, partite IVA locali, niente intermediari milanesi.`,
  alternates: { canonical: '/web-design-freelance-ciociaria' },
  openGraph: {
    title: 'Web Designer Freelance in Ciociaria · 91 comuni serviti',
    description:
      'Sede a Ceccano, lavoro su tutta la provincia di Frosinone. Niente account manager che pronunciano sbagliato i comuni.',
    url: '/web-design-freelance-ciociaria',
  },
};

const RAGIONI = [
  {
    num: '01',
    title: 'Conosco il territorio.',
    body: 'Ceccano, Frosinone, Sora, Cassino, Anagni, Veroli — i nomi dei comuni li so pronunciare. So che tipo di partite IVA ci stanno, che tipo di clienti puntano. Un\'agenzia milanese sente "Frosinone" e pensa "città vicino Roma". Io ci vivo.',
  },
  {
    num: '02',
    title: 'Lingua di chi compra qui.',
    body: 'Il copy che scrivo per un dentista di Anagni non è il copy che funziona per uno studio di Milano. Le persone in Ciociaria hanno il loro modo di leggere, di chiamare, di fidarsi. Lo conosco perché lo sento ogni giorno.',
  },
  {
    num: '03',
    title: 'Sede fisica, non un coworking di Roma.',
    body: 'Indirizzo: Via Scifelli 74, Ceccano. Se vuoi venire a parlare di persona, lo fai. Se serve consegnare materiale stampato, è qui. Niente "ti chiamo dal centralino di Milano" — il centralino sono io.',
  },
  {
    num: '04',
    title: 'P.IVA italiana, fattura italiana.',
    body: 'Niente fatturazione cipriota, niente piattaforme con TOS in inglese. Fattura elettronica italiana, regime ordinario, IVA al 22%. Tutto trasparente, tutto deducibile, tutto qui.',
  },
];

const SERVIZI_PRIORITARI = [
  {
    slug: 'web-design',
    title: 'Siti vetrina per professionisti locali',
    body: 'Studi medici, avvocati, commercialisti, dentisti. Sito che si carica veloce sulla 4G ciociara, che funziona sui telefoni vecchi, che dice cosa fai senza buzzword inglesi.',
  },
  {
    slug: 'e-commerce',
    title: 'E-commerce per produttori del territorio',
    body: 'Olio, vino, prodotti tipici, artigianato. Negozio online che parla italiano, fattura italiana, spedisce dall\'Italia. Niente Shopify in inglese che spaventa il cliente.',
  },
  {
    slug: 'sviluppo-web',
    title: 'Gestionali su misura per PMI ciociare',
    body: 'Magazzini, prenotazioni, gestione clienti. Sviluppato per chi non ha un IT interno. Spiegazione semplice, supporto in italiano, formazione di persona se serve.',
  },
  {
    slug: 'seo',
    title: 'SEO geo-locale Ciociaria',
    body: 'Posizionarti per "dentista a Frosinone", "commercialista a Cassino", "ristorante ad Alatri". Schema LocalBusiness, Google Business Profile, recensioni reali. Niente promesse di prima pagina.',
  },
  {
    slug: 'branding',
    title: 'Identità visiva per chi vuole sembrare adulto',
    body: 'Logo, palette, tipografia. Per non sembrare un sito fatto dal cugino. Brand book consegnato, file vettoriali, manuale d\'uso.',
  },
];

export default function WebDesignFreelanceCiociariaPage() {
  return (
    <>
      <StructuredData
        json={[
          serviceSchema({
            name: 'Web Design Freelance in Ciociaria',
            description: `Servizi di web design, sviluppo, e-commerce e SEO per professionisti e PMI in ${CIOCIARIA_TOTAL} comuni della provincia di Frosinone.`,
            url: '/web-design-freelance-ciociaria',
            areaServed: ['Frosinone', 'Ceccano', 'Cassino', 'Sora', 'Anagni', 'Alatri'],
          }),
          localBusinessSchema({
            comune: 'Ceccano',
            areaServed: TIER1_LIST.map((c) => c.nome),
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Web Designer Freelance', url: '/web-design-freelance' },
            { name: 'Ciociaria', url: '/web-design-freelance-ciociaria' },
          ]),
        ]}
      />

      <main className="pt-24 md:pt-32 pb-24 md:pb-32">
        {/* HERO — asymmetric 7+5 */}
        <section className="px-4 md:px-8 lg:px-12 mb-24 md:mb-32">
          <div className="grid grid-cols-12 gap-6 md:gap-8">
            <div className="col-span-12 md:col-span-7 flex flex-col gap-6 md:gap-8">
              <Eyebrow>{`Pillar geo · Ciociaria · ${CIOCIARIA_TOTAL} comuni`}</Eyebrow>
              <Heading as="h1" size="display-xl" style={{ maxWidth: '18ch' }}>
                Web Designer Freelance in Ciociaria. Lavoro a Ceccano e nei {CIOCIARIA_TOTAL} comuni della provincia di Frosinone.
              </Heading>
            </div>
            <div className="col-span-12 md:col-span-5 md:col-start-8 flex flex-col gap-8 md:pt-4">
              <p
                className="text-lg md:text-xl leading-relaxed"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                Le agenzie milanesi non sanno cosa è la Ciociaria. Sentono &laquo;Frosinone&raquo; e cercano sulla mappa. Io ci vivo, ci lavoro, conosco le partite IVA del posto. Niente call con account manager che pronunciano sbagliato &laquo;Veroli&raquo;.
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <Button href="/contatti" variant="solid" size="md">
                  Parliamone <ArrowRight size={16} weight="regular" aria-hidden />
                </Button>
                <Button href="#comuni" variant="underline" size="md">
                  Vedi i comuni serviti
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* 01 — Perché un freelance ciociaro */}
        <section
          id="ragioni"
          className="px-4 md:px-8 lg:px-12 mb-24 md:mb-32 scroll-mt-32"
        >
          <div className="grid grid-cols-12 gap-6 md:gap-8 mb-10 md:mb-16">
            <div className="col-span-12 md:col-span-5 flex flex-col gap-4">
              <MonoLabel as="p" tone="accent">
                01 — Capitolo
              </MonoLabel>
              <Heading as="h2" size="display-md" style={{ maxWidth: '18ch' }}>
                Perché un freelance ciociaro, non uno di Milano.
              </Heading>
            </div>
            <div className="col-span-12 md:col-span-7 md:col-start-6 flex items-end">
              <p
                className="text-base md:text-lg leading-relaxed"
                style={{ color: 'var(--color-text-secondary)', maxWidth: '52ch' }}
              >
                Distanza geografica = distanza culturale. Quattro motivi pratici, non emotivi.
              </p>
            </div>
          </div>

          <ol role="list" className="flex flex-col">
            {RAGIONI.map((r) => (
              <li
                key={r.num}
                className="grid grid-cols-12 gap-6 py-8 md:py-10"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <span
                  className="col-span-12 md:col-span-2 tabular-nums"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '2rem',
                    color: 'var(--color-accent-deep)',
                    fontWeight: 500,
                    letterSpacing: '-0.03em',
                    lineHeight: 1,
                  }}
                >
                  {r.num}
                </span>
                <div className="col-span-12 md:col-span-10 flex flex-col gap-3">
                  <Heading as="h3" size="card">
                    {r.title}
                  </Heading>
                  <p
                    className="text-base md:text-lg leading-relaxed"
                    style={{ color: 'var(--color-text-secondary)', maxWidth: '64ch' }}
                  >
                    {r.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* 02 — Comuni serviti (table numerica) */}
        <section
          id="comuni"
          className="px-4 md:px-8 lg:px-12 mb-24 md:mb-32 scroll-mt-32"
        >
          <div className="grid grid-cols-12 gap-6 md:gap-8 mb-10 md:mb-16">
            <div className="col-span-12 md:col-span-5 flex flex-col gap-4">
              <MonoLabel as="p" tone="accent">
                02 — Capitolo
              </MonoLabel>
              <Heading as="h2" size="display-md" style={{ maxWidth: '18ch' }}>
                Comuni serviti in Ciociaria.
              </Heading>
            </div>
            <div className="col-span-12 md:col-span-7 md:col-start-6 flex items-end">
              <p
                className="text-base md:text-lg leading-relaxed"
                style={{ color: 'var(--color-text-secondary)', maxWidth: '52ch' }}
              >
                Lavoro su tutto il territorio. Sotto i {TIER1_LIST.length} comuni con più richieste — ma se il tuo non è in lista, scrivimi lo stesso. Su {CIOCIARIA_TOTAL} comuni totali, nessuno è troppo piccolo.
              </p>
            </div>
          </div>

          <div
            className="grid grid-cols-12 gap-6"
            style={{ borderTop: '1px solid var(--color-border-strong)' }}
          >
            <div className="col-span-12 md:col-span-8">
              <ul role="list" className="flex flex-col">
                {TIER1_LIST.map((city, i) => (
                  <li
                    key={city.slug}
                    className="grid grid-cols-12 gap-4 py-5 items-baseline"
                    style={{ borderBottom: '1px solid var(--color-border)' }}
                  >
                    <span
                      className="col-span-2 md:col-span-1 tabular-nums"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-mono-xs)',
                        color: 'var(--color-text-muted)',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <Link
                      href={`/zone/${city.slug}`}
                      className="col-span-7 md:col-span-8 hover:[color:var(--color-accent-deep)] transition-colors"
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 'var(--text-card-title)',
                        fontWeight: 500,
                        letterSpacing: '-0.02em',
                        lineHeight: 1.2,
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {city.nome}
                    </Link>
                    <span
                      aria-hidden
                      className="col-span-3 md:col-span-3 text-right"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-mono-xs)',
                        color: 'var(--color-text-muted)',
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                      }}
                    >
                      {city.slug === 'frosinone' ? 'Capoluogo' : 'Tier 1'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <aside className="col-span-12 md:col-span-4 md:col-start-9 flex flex-col gap-4 pt-5 md:pt-0">
              <MonoLabel as="p">Totale provincia</MonoLabel>
              <p
                className="tabular-nums"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(3rem, 6vw, 5rem)',
                  fontWeight: 500,
                  letterSpacing: '-0.04em',
                  lineHeight: 0.9,
                  color: 'var(--color-text-primary)',
                }}
              >
                {CIOCIARIA_TOTAL}
              </p>
              <p
                className="text-sm md:text-base leading-relaxed"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                comuni serviti tra Frosinone e tutta la Ciociaria. Da Acquafondata a Vico nel Lazio.
              </p>
              <Link
                href="/zone"
                className="inline-flex items-baseline gap-2 self-start mt-2 underline underline-offset-4 hover:[color:var(--color-text-primary)] transition-colors"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-mono-xs)',
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--color-text-secondary)',
                }}
              >
                Tutti i comuni <ArrowRight size={16} weight="regular" aria-hidden />
              </Link>
            </aside>
          </div>
        </section>

        {/* 03 — Servizi prioritari per il territorio */}
        <section
          id="servizi"
          className="px-4 md:px-8 lg:px-12 mb-24 md:mb-32 scroll-mt-32"
        >
          <div className="grid grid-cols-12 gap-6 md:gap-8 mb-10 md:mb-16">
            <div className="col-span-12 md:col-span-5 flex flex-col gap-4">
              <MonoLabel as="p" tone="accent">
                03 — Capitolo
              </MonoLabel>
              <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
                Servizi che servono qui, davvero.
              </Heading>
            </div>
            <div className="col-span-12 md:col-span-7 md:col-start-6 flex items-end">
              <p
                className="text-base md:text-lg leading-relaxed"
                style={{ color: 'var(--color-text-secondary)', maxWidth: '52ch' }}
              >
                Cinque servizi tarati su chi lavora in Ciociaria. Niente roba che funziona solo a San Babila.
              </p>
            </div>
          </div>

          <ul role="list" className="flex flex-col">
            {SERVIZI_PRIORITARI.map((s, i) => (
              <li
                key={s.slug}
                className="grid grid-cols-12 gap-6 py-8"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <span
                  className="col-span-2 md:col-span-1 tabular-nums"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-mono-xs)',
                    color: 'var(--color-text-muted)',
                    letterSpacing: '0.05em',
                    paddingTop: '6px',
                  }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="col-span-10 md:col-span-3">
                  <Link
                    href={`/servizi/${s.slug}`}
                    className="inline-flex items-baseline gap-2 hover:[color:var(--color-accent-deep)] transition-colors"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'var(--text-card-title)',
                      fontWeight: 500,
                      letterSpacing: '-0.02em',
                      lineHeight: 1.15,
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    {s.title}
                    <ArrowRight size={16} weight="regular" aria-hidden />
                  </Link>
                </div>
                <p
                  className="col-span-12 md:col-span-8 text-base md:text-lg leading-relaxed self-center"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {s.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* 04 — Case study locali (placeholder con redirect a /lavori) */}
        <section
          id="case"
          className="px-4 md:px-8 lg:px-12 mb-24 md:mb-32 scroll-mt-32"
        >
          <div className="grid grid-cols-12 gap-6 md:gap-8 mb-10">
            <div className="col-span-12 md:col-span-5 flex flex-col gap-4">
              <MonoLabel as="p" tone="accent">
                04 — Capitolo
              </MonoLabel>
              <Heading as="h2" size="display-md" style={{ maxWidth: '18ch' }}>
                Case study locali.
              </Heading>
            </div>
            <div className="col-span-12 md:col-span-7 md:col-start-6 flex flex-col gap-6 items-start">
              <p
                className="text-base md:text-lg leading-relaxed"
                style={{ color: 'var(--color-text-secondary)', maxWidth: '52ch' }}
              >
                Lavori realizzati per professionisti e aziende del territorio. Filtra per zona o servizio nella pagina dedicata.
              </p>
              <Button href="/lavori" variant="ghost" size="md">
                Vedi i lavori <ArrowRight size={16} weight="regular" aria-hidden />
              </Button>
            </div>
          </div>
        </section>

        {/* 05 — CTA finale */}
        <section className="px-4 md:px-8 lg:px-12">
          <div
            className="py-16 md:py-20"
            style={{
              borderTop: '1px solid var(--color-border-strong)',
              borderBottom: '1px solid var(--color-border-strong)',
            }}
          >
            <div className="grid grid-cols-12 gap-6 md:gap-8 items-end">
              <div className="col-span-12 md:col-span-7 flex flex-col gap-4">
                <MonoLabel as="p" tone="accent">
                  05 — Parliamone
                </MonoLabel>
                <Heading as="p" size="display-md" style={{ maxWidth: '20ch' }}>
                  Una chiamata di 30 minuti, gratuita. Capiamo se ha senso lavorare insieme.
                </Heading>
              </div>
              <div className="col-span-12 md:col-span-5 md:col-start-8 flex flex-wrap gap-4">
                <Button href="/contatti" variant="solid" size="md">
                  Scrivimi <ArrowRight size={16} weight="regular" aria-hidden />
                </Button>
                <Button href="/prenota/chiamata-conoscitiva" variant="ghost" size="md">
                  Prenota una chiamata
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <FinalCTA />
    </>
  );
}
