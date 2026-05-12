import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale } from 'next-intl/server';
import { PerChiLavoro } from '@/components/seo/PerChiLavoro';
import { StructuredData } from '@/components/seo/StructuredData';
import {
  articleSchema,
  breadcrumbSchema,
  faqPageSchema,
  serviceSchema,
} from '@/data/structured-data';
import { FaqAccordion } from '@/components/about/FaqAccordion';
import { FinalCTA } from '@/components/home/FinalCTA';
import { Heading } from '@/components/ui/Heading';
import { Button } from '@/components/ui/Button';
import {
  EditorialArticleLayout,
  EditorialChapter,
  type EditorialChapterEntry,
} from '@/components/layout/EditorialArticleLayout';
import type { Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical } from '@/lib/canonical';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  return {
    title: {
      absolute:
        'Web Designer Freelance in Italia · La guida onesta per chi non vuole farsi prendere in giro | Federico Calicchia',
    },
    description:
      "Cosa fa un web designer freelance, quanto costa, come riconoscerlo. Guida completa con esempi reali, errori da evitare e tempi misurati. Niente fumo, niente promesse vuote.",
    alternates: buildI18nAlternates('/web-design-freelance', locale),
    openGraph: {
      title: 'Web Designer Freelance in Italia · La guida onesta',
      description:
        'Cosa fa, quanto costa, come riconoscerlo. Niente fumo, niente promesse vuote.',
      url: buildCanonical('/web-design-freelance', locale),
    },
  };
}

const FAQS = [
  {
    question: 'Lavori da solo o hai un team?',
    answer:
      'Lavoro da solo, e per scelta.\nSono io a progettare, sviluppare, mettere online e seguire il sito dopo il lancio.\nQuando un progetto richiede competenze specifiche (copywriting, fotografia, campagne ADV) mi affianco a professionisti fidati.\nTu però parli sempre e solo con me — niente catene di mail, niente passaggi di mano.',
  },
  {
    question: 'E se sparisco / cambio mestiere?',
    answer:
      'Domanda giusta.\nTi consegno tutto: codice sorgente, credenziali del dominio (a tuo nome), credenziali hosting, documentazione del CMS.\nSe domani cambio mestiere, qualsiasi sviluppatore può prendere in mano il sito senza dipendere da me.\nÈ un rischio reale anche con le agenzie — di solito non te lo dicono.',
  },
  {
    question: 'Posso modificare i contenuti da solo?',
    answer:
      "Sì.\nOgni progetto include formazione completa sul CMS scelto (WordPress, headless, custom): testo registrato + manuale scritto.\nDopo il lancio gestisci articoli, prodotti, immagini in autonomia.\nQuando ti serve qualcosa di strutturale, ci sono io.",
  },
  {
    question: 'Mi posizioni su Google?',
    answer:
      'Ogni sito che faccio nasce con SEO tecnico di base: struttura semantica, sitemap, schema markup, performance ottimizzate.\nPer posizionarti su keyword competitive serve anche content strategy nel tempo: te la propongo come pacchetto separato, ma onesto sul fatto che la SEO non si compra in un mese.',
  },
  {
    question: 'Cosa succede dopo che il sito è online?',
    answer:
      'Il lancio è solo un punto di partenza.\nOffro piani di manutenzione mensile per backup, aggiornamenti, monitoraggio uptime e supporto tecnico.\nNiente "prendi i soldi e scappa": se il sito si rompe alle 23 di domenica, qualcuno lo aggiusta.',
  },
];

const SERVIZI = [
  {
    slug: 'web-design',
    title: 'Web Design',
    body: "Siti vetrina, one page, multipagina.\nNiente template Avada riadattati.\nTutto progettato sui tuoi obiettivi reali — non su quello che 'va di moda'.",
  },
  {
    slug: 'e-commerce',
    title: 'E-Commerce',
    body: 'Negozi online che vendono davvero.\nCheckout snello, gestione prodotti chiara, integrazione con i tuoi strumenti (gestionale, fatturazione, magazzino).\nFino a 200 prodotti su Shopify/WooCommerce, oltre passiamo a custom.',
  },
  {
    slug: 'sviluppo-web',
    title: 'Sviluppo Web',
    body: "Quando un sito vetrina non basta: gestionali, prenotazioni, area clienti, automazioni.\nCodice scritto da me, non assemblato da plugin che si rompono al primo aggiornamento.",
  },
  {
    slug: 'seo',
    title: 'SEO & Visibilità',
    body: 'SEO tecnico incluso in ogni sito (sitemap, schema, performance).\nSEO advanced come pacchetto a parte: content strategy, keyword research, ottimizzazione semantica.\nNiente "garanzie di prima pagina" — chi le promette mente.',
  },
  {
    slug: 'branding',
    title: 'Branding',
    body: 'Logo, palette, tipografia, sistema visivo.\nQuello che serve a un brand per sembrare adulto e durare nel tempo, non per vincere un award.\nBrand book consegnato.',
  },
];

const PROCESSO = [
  {
    num: '01',
    title: 'Ascolto',
    body: "Una chiamata di 30 minuti, gratuita.\nMi racconti cosa vendi, a chi, qual è il problema.\nNon ti vendo niente — verifico se ha senso lavorare insieme.\nSe non lo è, te lo dico subito e ti consiglio dove guardare.",
  },
  {
    num: '02',
    title: 'Strategia',
    body: 'Ti scrivo nero su bianco cosa farò, perché, in quanto tempo, con quale impegno economico.\nNiente sorprese a fine progetto, niente listino gonfiato, niente fornitori in catena.\nSe accetti, blocco le date e si parte.',
  },
  {
    num: '03',
    title: 'Design + Codice',
    body: "Ti faccio vedere i mockup prima di scrivere una riga di codice.\nQuando approvi, sviluppo.\nRicevi un link 'staging' aggiornato in tempo reale: vedi il sito crescere, mi dici cosa cambiare prima del lancio.",
  },
  {
    num: '04',
    title: 'Lancio',
    body: 'Sito online, formazione sul CMS, documentazione consegnata, analytics configurati.\nPer i primi 30 giorni post-lancio, supporto incluso.\nDopo, manutenzione mensile come optional.',
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'definizione', number: '01', label: 'Definizione' },
  { id: 'costi-tempi', number: '02', label: 'Costi e tempi' },
  { id: 'servizi', number: '03', label: 'Servizi' },
  { id: 'processo', number: '04', label: 'Processo' },
  { id: 'rischi', number: '05', label: 'Costi, tempi, rischi' },
  { id: 'faq', number: '06', label: 'FAQ' },
];

export default function WebDesignFreelancePage() {
  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title:
              'Web Designer Freelance in Italia · La guida onesta per chi non vuole farsi prendere in giro',
            description:
              'Cosa fa un web designer freelance, quanto costa, come riconoscerlo. Guida completa.',
            url: '/web-design-freelance',
            section: 'Web Design',
            datePublished: '2026-05-04',
          }),
          serviceSchema({
            name: 'Web Design Freelance',
            description:
              'Servizi di web design, sviluppo, e-commerce e SEO realizzati da un singolo freelance. Un solo contatto, design + codice + strategia in casa.',
            url: '/web-design-freelance',
          }),
          faqPageSchema(FAQS),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Web Designer Freelance', url: '/web-design-freelance' },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Web Designer Freelance', url: '/web-design-freelance' },
        ]}
        eyebrow="Guida — 6 capitoli · 8 minuti di lettura"
        title="Web Designer Freelance in Italia · La guida onesta per chi non vuole farsi prendere in giro."
        lead={
          <>
            L'80% dei siti online oggi è cosmesi.\nBelli da vedere, vuoti dentro: non
            posizionano, non convertono, non portano un cliente.\nSe sei qui è perché stai
            pensando di rifarne uno — o di rifarlo bene per la prima volta.\nQuesta guida
            ti dice quello che agenzie e venditori di template non ti diranno mai.
          </>
        }
        chapters={CHAPTERS}
        readTime="8 min"
        updatedAt="5 maggio 2026"
        showFinalCta={false}
      >
        <EditorialChapter
          id="definizione"
          number="01"
          heading="Cos'è davvero un web designer freelance (e cosa NO)."
        >
          <p className="body-longform whitespace-pre-line text-justify">
            Un <strong>web designer freelance</strong> non è un grafico che "fa anche
            siti".\nNon è un creativo che ti vende mockup di Figma e poi ti molla allo
            sviluppatore di turno.\nNon è un consulente che parla in riunione e fattura
            quando non scrive una riga di codice.
          </p>
          <p className="body-longform whitespace-pre-line text-justify">
            È una persona sola che fa tutto: progetta l'interfaccia, scrive il codice,
            configura SEO e analytics, lancia il sito, lo segue dopo.\nQuattro mestieri
            in una bocca sola, una sola fattura, zero passaggi di mano.
          </p>
          <p className="body-longform whitespace-pre-line text-justify">
            Il mestiere vero: <em>design + sviluppo + SEO + strategia</em> in mano a una
            persona che capisce cosa influenza ogni leva e sa tirarle insieme.\nLe
            agenzie lo dividono in cinque ruoli per giustificare il costo.\nIo no.
          </p>
        </EditorialChapter>

        <EditorialChapter
          id="costi-tempi"
          number="02"
          heading="Perché un freelance costa meno e consegna prima."
        >
          <p className="body-longform whitespace-pre-line text-justify">
            Un'agenzia media coinvolge 4-6 figure su un singolo progetto: account
            manager, project manager, UX designer, UI designer, sviluppatore front-end,
            sviluppatore back-end.\nA volte aggiungono copywriter e SEO specialist.{' '}
            <strong>Ognuna di queste figure prende margine.</strong> Tu paghi tutto.
          </p>
          <p className="body-longform whitespace-pre-line text-justify">
            Il project manager, in particolare, è il costo più nascosto: ti viene
            fatturato perché serve a "coordinare il team".\nÈ un costo che esiste solo
            perché il team è grande.\nCon un freelance: zero project manager, zero
            coordinamento, zero margini di mezzo.
          </p>
          <p className="body-longform whitespace-pre-line text-justify">
            I tempi seguono la stessa logica.\nIn agenzia il tuo progetto entra in una
            coda con altri venti.\nDevi aspettare il turno per ogni passaggio.\nCon un
            freelance hai accesso diretto al tempo della persona che lavora — e capisci
            se ha capacità prima di firmare, non dopo.
          </p>
          <p className="body-longform whitespace-pre-line text-justify">
            <strong>Quando un freelance NON è la scelta giusta:</strong> progetti
            enterprise multinazionali con SLA 24/7, sistemi mission-critical con uptime
            contrattualizzato al 99,99%, budget oltre i 100k.\nLì serve un team
            strutturato, e va bene così.\nPer tutto il resto — PMI, professionisti,
            e-commerce sotto 200 prodotti, landing campagne — un freelance vince.
          </p>
        </EditorialChapter>

        {/* Capitolo 03 — struttura non-prosa: lista servizi hairline */}
        <section id="servizi" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-4"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-mono-xs)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--color-accent-deep)',
              lineHeight: 1,
            }}
          >
            03 — Capitolo
          </p>
          <Heading
            as="h2"
            size="display-md"
            className="mb-8"
            style={{ maxWidth: '22ch' }}
          >
            Cosa faccio per te.
          </Heading>
          <p
            className="body-longform text-lg md:text-xl leading-relaxed mb-10 whitespace-pre-line text-justify"
            style={{ maxWidth: '80ch', color: 'var(--color-text-secondary)' }}
          >
            Cinque servizi, un solo standard.\nOgni link ti porta alla pagina dedicata
            con processo, deliverable e tempi.
          </p>
          <ul role="list" className="flex flex-col">
            {SERVIZI.map((s) => (
              <li
                key={s.slug}
                className="grid grid-cols-12 gap-6 py-6"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <div className="col-span-12 md:col-span-3">
                  <Link
                    href={`/servizi/${s.slug}`}
                    className="inline-flex items-baseline gap-2 hover:[color:var(--color-accent-deep)] transition-colors"
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
                    <span aria-hidden="true">→</span>
                  </Link>
                </div>
                <p
                  className="col-span-12 md:col-span-9 text-base md:text-lg leading-relaxed self-center whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {s.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Capitolo 04 — processo numerato hairline */}
        <section id="processo" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-4"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-mono-xs)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--color-accent-deep)',
              lineHeight: 1,
            }}
          >
            04 — Capitolo
          </p>
          <Heading
            as="h2"
            size="display-md"
            className="mb-8"
            style={{ maxWidth: '22ch' }}
          >
            Come funziona un progetto.
          </Heading>
          <p
            className="body-longform text-lg md:text-xl leading-relaxed mb-10 whitespace-pre-line text-justify"
            style={{ maxWidth: '80ch', color: 'var(--color-text-secondary)' }}
          >
            Quattro fasi nette.\nNiente acronimi, niente "metodologia agile" da
            consulente.\nSolo cosa succede.
          </p>
          <ol role="list" className="flex flex-col">
            {PROCESSO.map((p) => (
              <li
                key={p.num}
                className="grid grid-cols-12 gap-6 py-6"
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
                  {p.num}
                </span>
                <div className="col-span-12 md:col-span-10">
                  <Heading as="h3" size="card" className="mb-3">
                    {p.title}
                  </Heading>
                  <p
                    className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    {p.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <p
            className="body-longform mt-8 text-lg md:text-xl leading-relaxed whitespace-pre-line text-justify"
            style={{
              maxWidth: '80ch',
              color: 'var(--color-text-primary)',
              fontWeight: 500,
            }}
          >
            In ogni fase, sai sempre a che punto siamo. Punto.
          </p>
        </section>

        <EditorialChapter
          id="rischi"
          number="05"
          heading="Quanto costa, quanto tempo, cosa rischi se scegli male."
        >
          <p className="body-longform whitespace-pre-line text-justify">
            Sui costi: ogni progetto è una proposta su misura, non un listino da
            supermercato.\nCosa influenza il prezzo: complessità, numero di
            pagine/prodotti, integrazioni con sistemi esistenti, urgenza, quantità di
            contenuti che devo produrre vs quelli che mi consegni tu.
          </p>
          <p className="body-longform whitespace-pre-line text-justify">
            Sui tempi: una landing one-page può andare online in 10 giorni.\nUn sito
            multipagina richiede 3-4 settimane.\nUn e-commerce completo 8-12
            settimane.\nSono tempi reali, non promesse di vendita.\nSe ti dicono "sito
            in una settimana" stanno tagliando qualcosa di serio (analisi, mobile,
            SEO).
          </p>
          <p className="body-longform whitespace-pre-line text-justify">
            <strong>Cosa rischi se scegli male.</strong> Tre rischi reali:
          </p>
          <ul className="list-disc pl-6 space-y-3 whitespace-pre-line text-justify">
            <li>
              <strong>Template riciclato.</strong> Compri un sito Avada/Divi
              customizzato male.\nSi carica in 8 secondi, non posiziona, è impossibile
              da modificare.\nLo butti via dopo 18 mesi.
            </li>
            <li>
              <strong>Agenzia che sparisce post-lancio.</strong> Pagamento ricevuto,
              supporto a singhiozzo, e quando il sito si rompe ti rispondono dopo due
              settimane.\nHai pagato un sito morto.
            </li>
            <li>
              <strong>Cugino/amico che fa siti la domenica.</strong> Costa poco,
              sembra il deal della vita.\nRisultato: niente SEO, niente accessibilità,
              niente backup.\nQuando il dominio scade, scopri che era intestato a lui.
            </li>
          </ul>
        </EditorialChapter>

        {/* Capitolo 06 — FAQ */}
        <section id="faq" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-4"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-mono-xs)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--color-accent-deep)',
              lineHeight: 1,
            }}
          >
            06 — Capitolo
          </p>
          <Heading
            as="h2"
            size="display-md"
            className="mb-10"
            style={{ maxWidth: '22ch' }}
          >
            Domande frequenti.
          </Heading>
          <FaqAccordion faqs={FAQS} />
        </section>

        {/* Coda CTA editoriale (resta dentro l'article come closing) */}
        <div
          className="py-12 my-16"
          style={{
            borderTop: '1px solid var(--color-border)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <Heading
            as="p"
            size="display-sm"
            className="mb-6 whitespace-pre-line text-justify"
            style={{ maxWidth: '42ch' }}
          >
            Se sei arrivato fin qui hai capito come ragiono. Decidi tu se vale la pena
            fare due chiacchiere.
          </Heading>
          <Button href="/contatti" variant="underline" size="md">
            Parliamone
            <span aria-hidden="true">→</span>
          </Button>
        </div>
      </EditorialArticleLayout>

      <PerChiLavoro index="07" />

      <FinalCTA />
    </>
  );
}
