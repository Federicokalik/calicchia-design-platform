import type { Metadata } from 'next';
import { PerChiLavoro } from '@/components/seo/PerChiLavoro';
import { StructuredData } from '@/components/seo/StructuredData';
import {
  articleSchema,
  breadcrumbSchema,
  faqPageSchema,
} from '@/data/structured-data';
import { FaqAccordion } from '@/components/about/FaqAccordion';
import { FinalCTA } from '@/components/home/FinalCTA';
import { Heading } from '@/components/ui/Heading';
import { Button } from '@/components/ui/Button';
import {
  EditorialArticleLayout,
  type EditorialChapterEntry,
} from '@/components/layout/EditorialArticleLayout';

export const metadata: Metadata = {
  title: {
    absolute:
      'Sito Web per PMI · Quello che hai adesso ti sta facendo perdere clienti | Federico Calicchia',
  },
  description:
    'Guida per PMI: 5 segnali che il sito sta perdendo clienti, cosa deve fare nel 2026, errori comuni, come scegliere il fornitore. Senza buzzword.',
  alternates: { canonical: '/sito-web-per-pmi' },
  openGraph: {
    title: 'Sito Web per PMI · Quello che hai adesso ti sta facendo perdere clienti',
    description:
      '5 segnali, errori comuni, come scegliere chi te lo fa. Senza buzzword.',
    url: '/sito-web-per-pmi',
  },
};

const FAQS = [
  {
    question: 'Quanto costa rifare il sito di una PMI?',
    answer:
      'Dipende da cosa serve davvero.\nUn sito vetrina ben fatto per una PMI parte da poche migliaia di euro, un sito con area clienti o e-commerce sale.\nQuello che NON serve: un budget enterprise.\nLe PMI spesso pagano in agenzia il triplo del necessario per servizi che non usano.\nUn preventivo dettagliato chiarisce subito.',
  },
  {
    question: 'Posso usare WordPress o devo per forza farmi fare un sito custom?',
    answer:
      'WordPress va benissimo per il 70% delle PMI.\nNon è "il sito dei principianti" — è la base del 40% del web.\nQuando NON va bene: traffico molto alto (centinaia di migliaia di visite/mese), funzionalità custom complesse, integrazioni proprietarie.\nPer un sito vetrina di una PMI, WordPress configurato bene è veloce, sicuro, gestibile.',
  },
  {
    question: 'Quanto tempo serve per avere il sito online?',
    answer:
      'Un sito vetrina per una PMI richiede 3-4 settimane di lavoro effettivo.\nUn e-commerce 8-12.\nI tempi reali dipendono anche da te: quanto rapidamente fornisci contenuti, foto, approvazioni.\nLa maggior parte dei progetti che si bloccano si bloccano per contenuti mancanti, non per il fornitore.',
  },
];

const SEGNALI = [
  {
    n: '01',
    title: 'Lentezza',
    body: "Apre in più di 3 secondi su mobile?\nHai già perso il 50% dei visitatori.\nGoogle penalizza, gli utenti chiudono.\nUn sito lento non è 'fastidioso' — è invisibile.",
  },
  {
    n: '02',
    title: 'Mobile rotto',
    body: "Il 70% dei visitatori arriva da telefono.\nSe il menu non si apre, le immagini escono dallo schermo, i pulsanti sono troppo piccoli — il sito non esiste su mobile, e il mercato non perdona.",
  },
  {
    n: '03',
    title: 'Non si trova su Google',
    body: "Cerca il nome della tua azienda + servizio + città.\nCompari?\nSotto il quinto risultato?\nSopra ci sono concorrenti meno bravi di te ma con SEO migliore.\nSei tu a regalargli i clienti.",
  },
  {
    n: '04',
    title: 'Parla di te invece che del cliente',
    body: "L'home page inizia con 'La nostra storia', 'I nostri valori', 'Chi siamo'.\nAl cliente non interessa.\nVuole sapere se gli risolvi un problema.\nPunto.",
  },
  {
    n: '05',
    title: 'Niente CTA chiare',
    body: "Sai cosa deve fare il visitatore quando arriva?\nChiamarti, prenotare, comprare?\nSe non c'è un pulsante chiaro che lo guida lì, il visitatore va via.\nUn sito senza CTA è un volantino senza numero di telefono.",
  },
];

const RED_FLAGS = [
  '"Garantisco la prima posizione su Google in 30 giorni." — Bugia.\nLa SEO non si garantisce, si costruisce nel tempo.',
  '"Il sito te lo facciamo a 500 euro in una settimana." — Stai comprando un template scaduto.\nLo butti via in 18 mesi.',
  '"Il dominio lo registriamo noi, non preoccuparti." — Pretendi che sia intestato a te.\nSempre.\nSenza eccezioni.',
  '"Per modificare i contenuti devi chiamarci." — Il sito deve essere modificabile da te in autonomia.\nAltrimenti sei in trappola.',
  '"Il preventivo te lo mando dopo che firmi il pre-contratto." — Se non ti dicono il prezzo prima, non vogliono dirti il prezzo.',
  '"La SEO non è inclusa, è un pacchetto a parte." — La SEO TECNICA di base (sitemap, schema, performance) deve essere inclusa.\nNon è un\'opzione.',
];

const PRETENDERE = [
  'Preventivo dettagliato: cosa farà, in quanto tempo, a quanto.\nNiente sorprese.',
  'Dominio intestato a te.\nHosting con credenziali condivise.',
  'Mockup mobile prima del desktop (mobile-first).',
  'PageSpeed Insights ≥ 85 su mobile prima del lancio.',
  'Schema markup (FAQ, LocalBusiness, BreadcrumbList) configurato.',
  'CMS modificabile in autonomia.\nFormazione + manuale.',
  'Backup automatici settimanali.\nPiano di manutenzione.',
  'Codice sorgente consegnato a te al lancio.\nNon in locazione.',
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'segnali', number: '01', label: 'Diagnosi · 5 segnali' },
  { id: 'standard', number: '02', label: 'Standard 2026' },
  { id: 'errori', number: '03', label: 'Errori comuni' },
  { id: 'red-flag', number: '04', label: 'Red flag fornitori' },
  { id: 'pretendere', number: '05', label: 'Da pretendere' },
  { id: 'faq', number: '06', label: 'FAQ' },
];

export default function SitoWebPerPmiPage() {
  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title:
              'Sito Web per PMI · Quello che hai adesso ti sta facendo perdere clienti',
            description:
              'Guida pratica per PMI: 5 segnali che il sito sta perdendo clienti, errori comuni, come scegliere il fornitore.',
            url: '/sito-web-per-pmi',
            section: 'Web Design',
            datePublished: '2026-05-04',
          }),
          faqPageSchema(FAQS),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Web Designer Freelance', url: '/web-design-freelance' },
            { name: 'Sito Web per PMI', url: '/sito-web-per-pmi' },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Web Designer Freelance', url: '/web-design-freelance' },
          { name: 'Sito Web per PMI', url: '/sito-web-per-pmi' },
        ]}
        eyebrow="Guida — 6 capitoli · 6 minuti di lettura"
        title="Sito Web per PMI · Quello che hai adesso ti sta facendo perdere clienti."
        lead={
          <>
            Il tuo sito attuale lavora 24 ore al giorno.\nPer chi?\nProbabilmente per
            nessuno.\nSe non vendi, contatti o converti da quella pagina, è un costo,
            non uno strumento.\nCinque segnali per capirlo, cinque cose da pretendere
            prima di rifarlo.
          </>
        }
        chapters={CHAPTERS}
        readTime="6 min"
        updatedAt="5 maggio 2026"
        showFinalCta={false}
      >
        {/* Cap 01 — Diagnosi: lista 5 segnali */}
        <section id="segnali" className="mb-20 md:mb-28 scroll-mt-32">
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
            style={{ maxWidth: '22ch' }}
          >
            5 segnali che il tuo sito sta perdendo clienti.
          </Heading>
          <ol role="list" className="flex flex-col">
            {SEGNALI.map((s) => (
              <li
                key={s.n}
                className="grid grid-cols-12 gap-6 py-8"
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
                  {s.n}
                </span>
                <div className="col-span-12 md:col-span-10">
                  <Heading as="h3" size="card" className="mb-3">
                    {s.title}
                  </Heading>
                  <p
                    className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Cap 02 — Standard 2026 */}
        <section id="standard" className="mb-20 md:mb-28 scroll-mt-32">
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
            02 — Capitolo
          </p>
          <Heading
            as="h2"
            size="display-md"
            className="mb-8"
            style={{ maxWidth: '22ch' }}
          >
            Cosa deve fare un sito di PMI nel 2026.
          </Heading>
          <div
            className="space-y-5 text-lg md:text-xl leading-relaxed"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <p className="body-longform max-w-[80ch] whitespace-pre-line text-justify">
              Zero buzzword.\nSolo fatti.\nUn sito di PMI nel 2026 deve fare quattro cose,
              in ordine di importanza:
            </p>
            <ol className="list-decimal pl-6 space-y-3 max-w-[80ch]">
              <li>
                <strong>Trovarsi su Google</strong> per le ricerche che contano (nome
                azienda, servizio + città, problema risolto). Senza questo, il sito è
                un foglio in un cassetto.
              </li>
              <li>
                <strong>Caricare in meno di 2,5 secondi su mobile</strong> (LCP &lt;
                2,5s). Sotto questa soglia, vince. Sopra, perde clienti ogni minuto.
              </li>
              <li>
                <strong>Trasformare visite in azioni</strong>: chiamata, prenotazione,
                contatto, acquisto. Niente "lasciate un feedback" — vuoi conversioni,
                non like.
              </li>
              <li>
                <strong>Essere modificabile da te</strong> in autonomia per quello che
                cambia spesso (orari, prodotti, news). Solo le cose strutturali devono
                passare dal fornitore.
              </li>
            </ol>
            <p className="body-longform max-w-[80ch] whitespace-pre-line text-justify">
              Tutto il resto — animazioni, parallax, dark mode, AI chatbot — è
              cosmetico.\nBello da vedere, irrilevante per il business.
            </p>
          </div>
        </section>

        {/* Cap 03 — Errori comuni */}
        <section id="errori" className="mb-20 md:mb-28 scroll-mt-32">
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
            Errori che fanno tutte le PMI (e che le agenzie nascondono).
          </Heading>
          <div
            className="space-y-5 text-lg md:text-xl leading-relaxed"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <p className="body-longform max-w-[80ch] whitespace-pre-line text-justify">
              <strong>Errore 1: il sito parla di te.</strong> Quasi tutti i siti di PMI
              iniziano con "La nostra storia".\nAl cliente non interessa.\nIl cliente
              vuole sapere cosa fai per LUI.\nIl sito deve aprirsi sul problema che
              risolvi, non sull'anno di fondazione dell'azienda.
            </p>
            <p className="body-longform max-w-[80ch] whitespace-pre-line text-justify">
              <strong>Errore 2: troppi servizi in vetrina.</strong> Se elenchi 15
              servizi, sembri un tuttofare.\nI clienti scelgono lo specialista.\nMeglio
              3-5 servizi messi bene che 15 in un elenco illeggibile.
            </p>
            <p className="body-longform max-w-[80ch] whitespace-pre-line text-justify">
              <strong>Errore 3: niente prove.</strong> Il sito dice "siamo esperti,
              professionali, affidabili".\nOgni concorrente dice la stessa cosa.\nQuello
              che convince sono recensioni reali, casi studio con numeri, foto del
              lavoro vero.\nLe agenzie le omettono perché non le hanno.
            </p>
            <p className="body-longform max-w-[80ch] whitespace-pre-line text-justify">
              <strong>Errore 4: form di contatto da 12 campi.</strong> Più campi metti,
              meno persone compilano.\nTre campi: nome, email, messaggio.\nIl resto si
              chiede dopo, in chiamata.
            </p>
          </div>
        </section>

        {/* Cap 04 — Red flag list */}
        <section id="red-flag" className="mb-20 md:mb-28 scroll-mt-32">
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
            Come scegliere chi te lo fa.
          </Heading>
          <p
            className="text-lg md:text-xl leading-relaxed mb-6 whitespace-pre-line text-justify"
            style={{ maxWidth: '64ch', color: 'var(--color-text-secondary)' }}
          >
            Red flag list: se senti queste frasi, scappa.
          </p>
          <ul role="list" className="flex flex-col">
            {RED_FLAGS.map((flag, i) => (
              <li
                key={i}
                className="grid grid-cols-12 gap-4 py-4"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <span
                  className="col-span-2 md:col-span-1 tabular-nums"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-mono-xs)',
                    letterSpacing: '0.05em',
                    color: 'var(--color-accent-deep)',
                  }}
                  aria-hidden="true"
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <p
                  className="col-span-10 md:col-span-11 text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {flag}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 05 — Da pretendere: lista hairline */}
        <section id="pretendere" className="mb-20 md:mb-28 scroll-mt-32">
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
            05 — Capitolo
          </p>
          <Heading
            as="h2"
            size="display-md"
            className="mb-8"
            style={{ maxWidth: '22ch' }}
          >
            Cosa devi pretendere prima di firmare.
          </Heading>
          <ul role="list" className="flex flex-col">
            {PRETENDERE.map((item, i) => (
              <li
                key={i}
                className="grid grid-cols-12 gap-4 py-4"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <span
                  className="col-span-2 md:col-span-1 tabular-nums"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-mono-xs)',
                    letterSpacing: '0.05em',
                    color: 'var(--color-accent-deep)',
                  }}
                  aria-hidden="true"
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <p
                  className="col-span-10 md:col-span-11 text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {item}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 06 — FAQ */}
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

        {/* Coda CTA */}
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
            Il tuo sito attuale ti sta facendo perdere clienti.\nSai cosa deve
            cambiare.\nDecidi tu se farlo da solo o con qualcuno che l'ha già fatto
            cento volte.
          </Heading>
          <Button href="/contatti" variant="underline" size="md">
            Parliamone
            <span aria-hidden="true">→</span>
          </Button>
        </div>
      </EditorialArticleLayout>

      <PerChiLavoro index="07" eyebrow="Per chi lavoro" />

      <FinalCTA />
    </>
  );
}
