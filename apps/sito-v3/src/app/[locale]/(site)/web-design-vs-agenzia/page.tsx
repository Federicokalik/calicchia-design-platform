import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  EditorialArticleLayout,
  EditorialChapter,
  type EditorialChapterEntry,
} from '@/components/layout/EditorialArticleLayout';
import type { Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical, buildOgLocale } from '@/lib/canonical';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  return {
    title: {
      absolute:
        "Freelance vs Agenzia · Perché un'agenzia ti costa il triplo per metà del risultato | Federico Calicchia",
    },
    description:
      "Confronto onesto tra web designer freelance e agenzia: costi reali, tempi, responsabilità, rischi. Quando scegliere uno, quando l'altra. Senza vendere niente.",
    alternates: buildI18nAlternates('/web-design-vs-agenzia', locale),
    openGraph: {
      title: "Freelance vs Agenzia · Perché un'agenzia ti costa il triplo",
      description:
        'Confronto onesto: costi reali, tempi, responsabilità, rischi. Senza vendere niente.',
      url: buildCanonical('/web-design-vs-agenzia', locale),
      ...buildOgLocale(locale),
    },
  };
}

const COMPARISON_ROWS = [
  {
    label: 'Costo',
    freelance: 'Una sola fattura, una sola persona.\nNiente margini sui margini.',
    agency:
      "3-5 figure professionali, ognuna prende il suo.\nTi viene fatturato anche il project manager (che non scrive una riga di codice).",
  },
  {
    label: 'Tempi',
    freelance:
      'Accesso diretto al tempo della persona.\nUn piccolo sito in 2-3 settimane.',
    agency:
      'Il tuo progetto entra in coda con altri venti.\nAspetti il turno per ogni passaggio.',
  },
  {
    label: 'Punto di contatto',
    freelance: 'Una persona.\nUna mail.\nUn numero.\nNessun passaggio di mano.',
    agency:
      'Account manager (commerciale), project manager (gestione), team tecnico (esecuzione).\nOgni richiesta passa per 3 mani.',
  },
  {
    label: 'Responsabilità',
    freelance:
      'Se qualcosa va storto, sai chi chiamare.\nUna sola persona, zero scuse.',
    agency:
      "Se qualcosa va storto, ognuno scarica sull'altro.\nIl bug è sempre 'di qualcun altro'.",
  },
  {
    label: 'Cosa succede se sparisce',
    freelance:
      'Codice + credenziali consegnate.\nQualsiasi sviluppatore può prendere in mano.\nRischio mitigabile.',
    agency:
      'Stesso identico rischio (le agenzie chiudono come tutti), ma con burocrazia in più per estrarre asset e codice.',
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'tabella', number: '01', label: 'Tabella confronto' },
  { id: 'costo-agenzia', number: '02', label: "Costo agenzia" },
  { id: 'costo-freelance', number: '03', label: 'Costo freelance' },
  { id: 'agenzia-senso', number: '04', label: 'Quando agenzia ha senso' },
  { id: 'freelance-vince', number: '05', label: 'Quando freelance vince' },
];

export default function WebDesignVsAgenziaPage() {
  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title:
              "Freelance vs Agenzia · Perché un'agenzia ti costa il triplo per metà del risultato",
            description:
              'Confronto onesto tra web designer freelance e agenzia: costi reali, tempi, responsabilità, rischi.',
            url: '/web-design-vs-agenzia',
            section: 'Web Design',
            datePublished: '2026-05-04',
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Web Designer Freelance', url: '/web-design-freelance' },
            { name: 'Freelance vs Agenzia', url: '/web-design-vs-agenzia' },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Web Designer Freelance', url: '/web-design-freelance' },
          { name: 'Freelance vs Agenzia', url: '/web-design-vs-agenzia' },
        ]}
        eyebrow="Comparison — 5 capitoli · 6 minuti di lettura"
        title="Freelance vs Agenzia · Perché un'agenzia ti costa il triplo per metà del risultato."
        lead={
          <>
            Ti hanno detto che "un'agenzia è più sicura".\nForse hanno omesso un dettaglio:
            chi te l'ha detto era un'agenzia.\nConfronto onesto, senza vendere niente.
          </>
        }
        chapters={CHAPTERS}
        readTime="6 min"
        updatedAt="5 maggio 2026"
        showFinalCta={true}
      >
        {/* Cap 01 — Tabella confronto */}
        <section id="tabella" className="mb-20 md:mb-28 scroll-mt-32">
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
            01 — Capitolo
          </p>
          <Heading
            as="h2"
            size="display-md"
            className="mb-8"
            style={{ maxWidth: '20ch' }}
          >
            Il confronto in cinque punti.
          </Heading>

          <div
            className="hidden md:grid grid-cols-12 gap-6 py-3"
            style={{ borderBottom: '1px solid var(--color-text-primary)' }}
          >
            <MonoLabel as="span" className="col-span-3">
              Aspetto
            </MonoLabel>
            <MonoLabel as="span" tone="accent" className="col-span-4">
              Freelance
            </MonoLabel>
            <MonoLabel as="span" className="col-span-5">
              Agenzia
            </MonoLabel>
          </div>

          <ul role="list" className="flex flex-col">
            {COMPARISON_ROWS.map((row) => (
              <li
                key={row.label}
                className="grid grid-cols-1 md:grid-cols-12 gap-4 md:gap-6 py-6 md:py-8"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <Heading
                  as="h3"
                  size="card"
                  className="md:col-span-3 self-start"
                >
                  {row.label}
                </Heading>
                <p
                  className="md:col-span-4 text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  <span className="md:hidden block mb-1">
                    <MonoLabel tone="accent">Freelance</MonoLabel>
                  </span>
                  {row.freelance}
                </p>
                <p
                  className="md:col-span-5 text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  <span className="md:hidden block mb-1">
                    <MonoLabel>Agenzia</MonoLabel>
                  </span>
                  {row.agency}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <EditorialChapter
          id="costo-agenzia"
          number="02"
          heading="Quanto ti costa davvero un'agenzia."
        >
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            Apri il preventivo di un'agenzia.\nVedi una cifra, magari due righe di
            descrizione.\nQuello che non vedi è la struttura interna che genera quella
            cifra: account manager, project manager, senior designer, junior designer,
            sviluppatore, QA tester.\nSei persone su un sito.
          </p>
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            Ognuna di queste persone fattura ore.\nL'agenzia ci aggiunge il suo margine
            sopra (di solito 30-50%).\nIl risultato finale lo paghi tu.\nPer un sito che,
            fatto da un freelance esperto, richiederebbe una persona sola.
          </p>
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            <strong>I margini sui margini.</strong> Se l'agenzia coinvolge uno
            sviluppatore esterno (capita spesso), quello sviluppatore fattura
            all'agenzia, l'agenzia ci mette il suo margine, e ti fattura te.\nPagamento
            doppio per lo stesso lavoro.
          </p>
        </EditorialChapter>

        <EditorialChapter
          id="costo-freelance"
          number="03"
          heading="Quanto ti costa un freelance."
        >
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            Una persona, una tariffa.\nNiente margini di mezzo, niente costi di
            struttura, niente PM da pagare per "coordinare" un team che c'è perché
            l'agenzia ha bisogno di tenerlo occupato.
          </p>
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            Il freelance giusto ti costa il 40-60% di quello che ti costerebbe la
            stessa cosa in agenzia.\nStesso risultato, spesso migliore (perché chi
            lavora sul tuo sito è anche chi te l'ha progettato — il contesto non si
            perde).
          </p>
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            <strong>Nota onesta:</strong> il freelance giusto non è il freelance più
            economico.\nIl freelance da 500€ che ti vende un sito in una settimana è la
            categoria peggiore — quella che ti fa rimpiangere l'agenzia.\nIl freelance
            senior, con clienti consolidati, costa di meno di un'agenzia ma non è
            gratis.
          </p>
        </EditorialChapter>

        <EditorialChapter
          id="agenzia-senso"
          number="04"
          heading="Quando l'agenzia ha senso (sì, esiste)."
        >
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            Sono onesto: l'agenzia non è sempre la scelta sbagliata.\nTre casi reali in
            cui ha senso:
          </p>
          <ul className="list-disc pl-6 space-y-3 whitespace-pre-line text-justify">
            <li>
              <strong>Progetti enterprise multinazionali</strong> con supporto 24/7
              contrattualizzato, SLA al 99,99%, integrazioni con sistemi corporate
              (SAP, Salesforce, Workday).\nLì serve un team strutturato e un account
              dedicato.
            </li>
            <li>
              <strong>Multilingua reale</strong> con localizzazione in 10+ lingue,
              traduzioni native, content team distribuito.\nUn freelance non lo
              gestisce, e va bene così.
            </li>
            <li>
              <strong>Budget oltre i 100k</strong> con esigenze di governance, audit,
              compliance (GDPR enterprise, accessibility WCAG AAA, ISO).\nTi serve la
              struttura, non il singolo bravo.
            </li>
          </ul>
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            Per tutto il resto — PMI, professionisti, e-commerce sotto 200 prodotti,
            landing campagne — l'agenzia è overkill.\nStai pagando una struttura che
            non ti serve.
          </p>
        </EditorialChapter>

        <EditorialChapter
          id="freelance-vince"
          number="05"
          heading="Quando il freelance vince."
        >
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            <strong>PMI e professionisti.</strong> Avvocati, dentisti, ristoratori,
            commercialisti, B&B.\nFatturato sotto i 5 milioni.\nHai bisogno di un sito
            che funzioni, ti dia visibilità locale, porti contatti.\nNon hai bisogno di
            un team di 6 persone per farlo.
          </p>
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            <strong>E-commerce sotto 200 prodotti.</strong> Catalogo gestibile,
            checkout snello, integrazione gestionale.\nWooCommerce o Shopify configurati
            bene fanno tutto.\nSopra i 200 prodotti si ragiona caso per caso.
          </p>
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            <strong>Landing per campagne.</strong> Hai una campagna ADV partendo
            lunedì e ti serve la landing online entro venerdì.\nUn freelance ti dice
            "sì" o "no" subito.\nUn'agenzia ti chiede tre giorni solo per fare la
            riunione di kick-off.
          </p>
          <p className="body-longform whitespace-pre-line text-justify" style={{ maxWidth: '80ch' }}>
            <strong>Restyling con scadenza.</strong> Il sito attuale ti sta perdendo
            clienti, non puoi aspettare 6 mesi.\nUn freelance può consegnare in 4-6
            settimane, l'agenzia ti dà date che si spostano sempre.
          </p>
        </EditorialChapter>

        {/* CTA editoriale di chiusura */}
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
            Sei nel campo "freelance vince"? Allora vediamoci.
          </Heading>
          <div className="flex flex-wrap gap-6">
            <Button href="/contatti" variant="underline" size="md">
              Parliamone
              <span aria-hidden="true">→</span>
            </Button>
            <Button
              href="/web-design-freelance"
              variant="underline"
              size="md"
              className="opacity-70"
            >
              Guida completa al web design freelance
              <span aria-hidden="true">→</span>
            </Button>
          </div>
        </div>
      </EditorialArticleLayout>
    </>
  );
}
