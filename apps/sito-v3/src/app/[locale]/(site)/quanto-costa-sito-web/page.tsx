import type { Metadata } from 'next';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import {
  EditorialArticleLayout,
  type EditorialChapterEntry,
} from '@/components/layout/EditorialArticleLayout';

export const metadata: Metadata = {
  title: {
    absolute:
      'Quanto costa un sito web · I 5 fattori che decidono il prezzo (senza listini fumosi) | Federico Calicchia',
  },
  description:
    'Quanto costa davvero un sito web nel 2026? I 5 fattori che muovono il preventivo, perché le agenzie costano di più, quando un DIY basta, come riconoscere un preventivo onesto. Senza cifre fittizie.',
  alternates: { canonical: '/quanto-costa-sito-web' },
  openGraph: {
    title: 'Quanto costa un sito web · I 5 fattori che decidono il prezzo',
    description:
      'I 5 fattori reali che muovono il preventivo. Niente cifre da listino, niente bullshit.',
    url: '/quanto-costa-sito-web',
  },
};

const COST_FACTORS = [
  {
    n: '01',
    title: 'Lo scope (cosa fa il sito davvero)',
    body: "Sito vetrina con 5 pagine, e-commerce con 200 prodotti, gestionale con area clienti, piattaforma SaaS con multi-tenant.\nSono progetti diversi che richiedono ore di lavoro completamente diverse.\nChi ti dà un prezzo prima di chiarire lo scope ti sta vendendo un pacchetto, non un progetto.",
  },
  {
    n: '02',
    title: 'La complessità tecnica',
    body: 'Integrazione con un gestionale legacy che parla solo SOAP nel 2026, importazione di 50.000 prodotti da CSV malformato, sincronizzazione con un magazzino fisico via barcode scanner, multi-lingua + multi-valuta + multi-checkout.\nOgni complessità è ore.\nLe agenzie spesso le scoprono a metà progetto e te le fatturano come "extra".',
  },
  {
    n: '03',
    title: 'Il tempo (tuo, non solo mio)',
    body: 'Quanto tempo ti serve per dare feedback, mandare i contenuti, approvare wireframe, fornire foto.\nUn progetto in cui il cliente sparisce per 3 settimane si dilata, ed è tempo che qualcuno paga (di solito tu).\nUn cliente presente accelera.\nUn cliente assente fa lievitare il preventivo o la deadline.',
  },
  {
    n: '04',
    title: 'I contenuti (chi li scrive, chi li produce)',
    body: 'Testi del sito, foto dei prodotti, video, traduzioni: chi se ne occupa?\nSe li hai già pronti, costi giù.\nSe devo scriverli, fotografarli o coordinare freelancer per produrli, costi su.\nUn sito senza contenuti non esiste — la domanda è solo chi li mette.',
  },
  {
    n: '05',
    title: 'La qualità (cosa significa davvero)',
    body: 'Performance Core Web Vitals che passano il check Google, accessibilità WCAG 2.1 AA, SEO tecnica configurata, GDPR-compliant, manutenzione inclusa, hosting tuned.\nSono tutte cose che possono essere "fatte bene" oppure "fatte".\nLa differenza tra un sito che dura 5 anni e uno che va rifatto dopo 18 mesi è qui.',
  },
];

const RED_FLAGS = [
  {
    flag: '"Ti faccio un sito a 500€"',
    why: "Senza aver chiesto cosa fa, per chi, con quale traffico atteso.\nÈ un template applicato uguale a tutti, e dopo 6 mesi ti rendi conto che non puoi modificare nulla senza pagare un altro intervento.",
  },
  {
    flag: '"Listino fisso a partire da X"',
    why: "Il listino fisso copre il 20% dei progetti.\nL'80% finisce in 'extra' fatturati separatamente.\nChi pubblica un listino sa che ti aggancia e poi ricalcola.",
  },
  {
    flag: '"3 round di revisione, poi paghi extra"',
    why: 'Conta i round, non quello che ottieni.\nUn progetto fatto bene ha un giro di feedback strutturato, non un conteggio burocratico.\nSe ti danno una calcolatrice di "round", stanno già preparando l\'extra.',
  },
  {
    flag: '"Hosting + manutenzione obbligatori con noi"',
    why: 'Se ti vincolano a hosting + manutenzione del fornitore, non puoi più cambiare.\nLo standard onesto: codice consegnato, credenziali tue, hosting tuo, manutenzione opzionale.',
  },
  {
    flag: 'Preventivo senza scope scritto',
    why: 'Se non c\'è un documento scritto che dice "questo è incluso, questo no", ogni discussione finisce in "ah, ma quello non era nel preventivo, è extra".\nLo scope scritto è la prima difesa contro i ricarichi nascosti.',
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'opacita', number: '01', label: 'Perché nessuno ti dice quanto costa' },
  { id: 'fattori', number: '02', label: '5 fattori che muovono il preventivo' },
  { id: 'agenzia', number: '03', label: 'Costo nascosto delle agenzie' },
  { id: 'diy', number: '04', label: 'Quando un DIY basta' },
  { id: 'red-flags', number: '05', label: 'Red flag in un preventivo' },
  { id: 'domande', number: '06', label: 'Cosa chiedere prima del prezzo' },
];

export default function QuantoCostaSitoWebPage() {
  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title:
              'Quanto costa un sito web · I 5 fattori che decidono il prezzo',
            description:
              'I 5 fattori reali che muovono il preventivo, perché le agenzie costano di più, quando un DIY basta, come riconoscere un preventivo onesto.',
            url: '/quanto-costa-sito-web',
            section: 'Web Design',
            datePublished: '2026-05-08',
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Web Designer Freelance', url: '/web-design-freelance' },
            { name: 'Quanto costa un sito web', url: '/quanto-costa-sito-web' },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Web Designer Freelance', url: '/web-design-freelance' },
          { name: 'Quanto costa un sito web', url: '/quanto-costa-sito-web' },
        ]}
        eyebrow="Pricing transparency — 6 capitoli · 7 minuti di lettura"
        title="Quanto costa un sito web. I 5 fattori che decidono il prezzo (senza listini fumosi)."
        lead={
          <div className="whitespace-pre-line text-justify">
            Cerchi "quanto costa un sito web" e trovi listini con cifre fisse, "a partire da" e calcolatori
            che spuntano numeri dal nulla.<br />
            Non funziona così.<br />
            Il prezzo dipende da 5 fattori reali — qui te
            li spiego senza vendere niente.
          </div>
        }
        chapters={CHAPTERS}
        readTime="7 min"
        updatedAt="8 maggio 2026"
        showFinalCta={true}
      >
        {/* Cap 01 — Opacità */}
        <section id="opacita" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            01 — Perché nessuno ti dice quanto costa
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Cerchi "quanto costa un sito web" su Google e trovi tre tipi di pagine: listini con prezzi finti.\n
            Calcolatori che chiedono dati per inviarti un preventivo via email.\n
            Agenzie che ti fanno scaricare un PDF di 18 pagine.\n
            Nessuno risponde alla domanda davvero.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Il motivo è semplice: <strong>il prezzo di un sito web dipende da cosa deve fare</strong>.\n
            Chi pubblica un numero prima di chiederti cosa fa il sito sta vendendo un template, non un progetto.\n
            Listino fisso = pacchetto pre-cotto.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Per dare un preventivo onesto serve mezz'ora di chiamata: capire cosa vendi, a chi, da dove arriva il traffico, cosa hai già, cosa ti serve.\n
            Senza queste informazioni qualsiasi prezzo è un'invenzione, e tu lo paghi a metà progetto in "extra non previsti".
          </p>
        </section>

        {/* Cap 02 — Fattori */}
        <section id="fattori" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            02 — I 5 fattori che muovono il preventivo
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-10 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Tutto si riduce a questi cinque.\n
            Cambiano da progetto a progetto, e insieme determinano le ore reali — quindi il costo reale.
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {COST_FACTORS.map((f) => (
              <li
                key={f.n}
                className="flex flex-col gap-4 p-6 md:p-8"
                style={{ border: '1px solid var(--color-line)' }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    letterSpacing: '0.18em',
                    color: 'var(--color-accent-deep)',
                  }}
                >
                  {f.n} — Fattore
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.5rem, 2.2vw, 2rem)',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.1,
                  }}
                >
                  {f.title}
                </h3>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {f.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 03 — Agenzia */}
        <section id="agenzia" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            03 — Il costo nascosto delle agenzie
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Un'agenzia non è "più professionale" di un freelance: è solo più persone.\n
            Ogni persona costa, anche quando non lavora direttamente sul tuo progetto.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Quando paghi un'agenzia, paghi: il commerciale che ti ha chiamato (che non scrive una riga di codice), il project manager che gestisce le tue email (idem), il direttore creativo che "supervisiona" (vede la prima volta il tuo progetto due settimane prima della consegna).
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            A questo si aggiungono l'ufficio fisico che hanno deciso di tenere in centro città e gli stipendi del team interno anche nei mesi in cui c'è meno lavoro.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Tutto questo costo viene caricato sul tuo preventivo.\n
            Non è "valore aggiunto": è costo strutturale che qualcuno deve pagare.\n
            <strong>Quel qualcuno sei tu.</strong>
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Un freelance non ha questa overhead.\n
            Costa il proprio tempo, niente di più.\n
            Per progetti piccoli e medi, la differenza si misura in multipli, non in percentuali.
          </p>
        </section>

        {/* Cap 04 — DIY */}
        <section id="diy" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            04 — Quando un DIY (Wix, Squarespace, WordPress.com) basta
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            A volte è giusto NON pagare nessuno.\n
            Lo dico per primo, anche se è contro-interessato.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Se hai bisogno di un sito da 3 pagine per testare un'idea, dimostrare che esisti, raccogliere email per una newsletter — Wix, Squarespace o WordPress.com fanno il lavoro.\n
            Costo basso, zero manutenzione, vivi da subito.\n
            Non è il momento di chiamare un freelance.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Chiamare un freelance ha senso quando il sito deve fare qualcosa di specifico:</strong>{' '}
            convertire visite in clienti reali, gestire un catalogo, integrarsi con un gestionale, ranking SEO competitivo, design coerente con un brand serio.\n
            Lì il template DIY perde subito (limiti SEO, design uguale a tutti, performance scarse, integrazioni assenti).
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Regola pratica: se il sito è la <em>prima fonte di lead</em> del business, non scegliere DIY.\n
            Se è una vetrina secondaria, DIY va benissimo.
          </p>
        </section>

        {/* Cap 05 — Red flags */}
        <section id="red-flags" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            05 — Red flag in un preventivo
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-10 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Cinque segnali che ti dicono "qui ti stanno preparando un agguato di extra a metà progetto".
          </p>
          <ul className="flex flex-col">
            {RED_FLAGS.map((rf, i) => (
              <li
                key={i}
                className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-4 md:gap-12 py-6"
                style={{
                  borderTop: i === 0 ? '1px solid var(--color-line)' : undefined,
                  borderBottom: '1px solid var(--color-line)',
                }}
              >
                <div className="flex items-start gap-3">
                  <span style={{ background: 'var(--color-accent)', width: 8, height: 8, marginTop: 8 }} />
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1.25rem, 1.8vw, 1.5rem)',
                      fontWeight: 500,
                      lineHeight: 1.2,
                    }}
                  >
                    {rf.flag}
                  </span>
                </div>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {rf.why}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 06 — Domande */}
        <section id="domande" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            06 — Cosa chiedere prima di chiedere il prezzo
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Prima ancora di sapere quanto costa, devi sapere queste cinque cose.\n
            Se chi ti dà il preventivo non sa rispondere, il preventivo non vale il PDF su cui è scritto.
          </p>
          <ol className="flex flex-col gap-6 list-decimal pl-6 max-w-[65ch]">
            <li className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>Lo scope è scritto in modo chiaro?</strong> Pagine, funzionalità, integrazioni, contenuti inclusi e non inclusi.\n
              Senza un documento, ogni discussione futura è interpretazione.
            </li>
            <li className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>A chi appartiene il codice e l'hosting?</strong> Devi possedere tutto: codice sorgente, account hosting, dominio, credenziali database.\n
              Se ti vincolano, sei prigioniero.
            </li>
            <li className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>Cosa succede dopo il go-live?</strong> Manutenzione inclusa o opzionale?\n
              Per quanto tempo?\n
              Cosa è coperto (security patch, update, fix urgenti)?\n
              Cosa è extra?
            </li>
            <li className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>Quanto è già stato fatto in casi simili?</strong> Portfolio reale con clienti veri, non concept o mockup decorativi.\n
              Possibilmente con risultati misurabili.
            </li>
            <li className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>Chi tocca il progetto giorno per giorno?</strong> Una persona o sei?\n
              Se cambia, ti avvisano?\n
              Se sparisce, cosa succede?\n
              Niente passaggio di mano = niente bug "di qualcun altro".
            </li>
          </ol>
        </section>

        <section className="mb-12">
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Quando avrai chiarito queste cinque domande, scoprirai che il prezzo non è il problema.\n
            Il problema è che i preventivi opachi nascondono sempre qualcosa, e quando lo trovi è già troppo tardi.\n
            Un preventivo trasparente parte da una conversazione, non da un listino.
          </p>
        </section>
      </EditorialArticleLayout>
    </>
  );
}
