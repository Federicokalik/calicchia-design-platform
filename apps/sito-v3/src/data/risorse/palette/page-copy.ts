import type { Locale } from '@/lib/i18n';

/** Testi delle pagine del tool "Palette di settore" (hub, settore, condividi). */

export const TOOL_PATH = '/risorse/palette-di-settore';
export const SHARE_PATH = '/risorse/palette-di-settore/condividi';

export interface PaletteFaq {
  question: string;
  answer: string;
}

export interface PalettePageCopy {
  metaTitle: string;
  metaDescription: string;
  /** Titolo dell'immagine OG e della card social. */
  ogTitle: string;
  breadcrumbResources: string;
  breadcrumbTool: string;
  eyebrow: string;
  title: string;
  lead: string;
  facts: string;
  appName: string;
  appFeatures: string[];
  defaultLabel: string;
  methodEyebrow: string;
  methodTitle: string;
  methodSteps: { title: string; body: string }[];
  faqTitle: string;
  faqs: PaletteFaq[];
  indexEyebrow: string;
  indexTitle: string;
  indexLead: string;
  indexSoon: string;
  // Pagina settore
  sectorMetaTitle: (label: string) => string;
  sectorMetaDescription: (label: string) => string;
  sectorEyebrow: string;
  sectorTitle: (label: string) => string;
  whyEyebrow: string;
  whyTitle: (label: string) => string;
  whyBody: (args: { label: string; temp: string; sat: string; chroma: string; style: string; why: string }) => string;
  whyPrimary: string;
  whyAccent: string;
  creditsTitle: string;
  creditsLead: string;
  relatedTitle: (category: string) => string;
  landingTitle: string;
  landingBody: (label: string) => string;
  landingCta: (label: string) => string;
  // Pagina condividi
  shareMetaTitle: string;
  shareMetaDescription: string;
  shareEyebrow: string;
  shareTitle: string;
  shareTitleSector: (label: string) => string;
  shareLead: string;
  shareStyle: (name: string) => string;
  shareColors: string;
  sharePrimary: string;
  shareOpenTool: string;
  shareOpenSector: (label: string) => string;
  shareContact: string;
  shareInvalidTitle: string;
  shareInvalidBody: string;
}

export const PAGE_COPY: Record<Locale, PalettePageCopy> = {
  it: {
    metaTitle: 'Palette di settore: i colori del tuo settore, gratis — Calicchia Design',
    metaDescription:
      'Strumento gratuito: scrivi la tua attività, estraggo i colori dominanti dalle foto del settore e te li mostro su un sito, un post e un biglietto, con i contrasti WCAG verificati. Token CSS, Tailwind, JSON e Canva.',
    ogTitle: 'Palette di settore: i colori del tuo settore',
    breadcrumbResources: 'Risorse',
    breadcrumbTool: 'Palette di settore',
    eyebrow: 'Risorse · Strumento gratuito',
    title: 'La palette del tuo settore.',
    lead: "Scrivi che attività hai e, se ce l'hai, carica il logo. Cerco foto del tuo settore, ne estraggo i colori dominanti e te li mostro su un sito, un post e un biglietto da visita, con i contrasti già verificati.",
    facts: 'Gratis · senza registrazione · token in CSS, Tailwind e JSON',
    appName: 'Palette di settore',
    appFeatures: [
      'Colori dominanti estratti da foto del settore (k-means in OKLab)',
      'Colori del logo fissi nella palette',
      'Quattro stili con font open source',
      'Anteprima su home, post, biglietto da visita e insegna',
      'Simulazione del daltonismo',
      'Verifica e correzione dei contrasti WCAG 2.2',
      'Esportazione in CSS, Tailwind v4, JSON (DTCG) e Canva',
    ],
    defaultLabel: 'Pizzeria',
    methodEyebrow: 'Metodo',
    methodTitle: 'Come nasce la palette.',
    methodSteps: [
      {
        title: 'Foto vere del settore',
        body: 'Parto da foto reali su Unsplash, scelte per il tuo settore. Per le attività fuori elenco la ricerca parte al momento, tradotta in inglese.',
      },
      {
        title: 'Colori misurati, non scelti a occhio',
        body: 'Ogni foto viene ridotta a una miniatura 64 × 48 e i suoi pixel raggruppati con k-means nello spazio OKLab, che segue la percezione umana. Tengo tre colori per foto, unisco i doppioni sotto ΔE 0,05 e scelgo i cinque più rappresentativi.',
      },
      {
        title: 'Ruoli e contrasti',
        body: 'Sfondo, testo e neutri sono calcolati per la leggibilità; primario e accento vengono dai colori estratti. Ogni coppia usata per i testi passa i criteri WCAG 2.2: se non basta, cambio la luminosità e tengo la tinta.',
      },
    ],
    faqTitle: 'Domande frequenti',
    faqs: [
      {
        question: 'Da dove arrivano le foto?',
        answer:
          "Da Unsplash, una raccolta di foto libere. Per i settori pronti le ho scelte e analizzate in anticipo; per le altre attività la ricerca parte al momento. Sotto ogni foto trovi il nome del fotografo e il link all'originale.",
      },
      {
        question: 'Il mio logo e le mie foto finiscono su un server?',
        answer:
          'No. Logo e foto restano nel tuo browser: li leggo con il canvas e non partono mai verso un server. Il link condiviso contiene solo i colori, lo stile e il settore.',
      },
      {
        question: 'Cosa vuol dire che i contrasti sono verificati?',
        answer:
          'Ogni coppia di colori usata per i testi viene misurata con il rapporto di contrasto WCAG 2.2: almeno 4,5:1 per il testo normale, 3:1 per icone e bordi. Se un colore non basta, ne correggo la luminosità e tengo la tinta. Puoi anche spegnere la correzione e vedere i rapporti originali.',
      },
      {
        question: 'Posso usare la palette per il mio sito o per i social?',
        answer:
          'Sì, è tua. Esporti le variabili CSS, il tema per Tailwind v4, i token in JSON (formato DTCG) o i codici da incollare in Canva. I font dei quattro stili sono open source (licenza OFL).',
      },
      {
        question: 'Perché proprio quello stile?',
        answer:
          'Ogni settore pronto ha uno stile di partenza. Per le altre attività lo deduco dai colori: croma media, temperatura e luminosità della palette. Puoi sempre sceglierne un altro: anteprima, supporti ed esportazione si aggiornano subito.',
      },
      {
        question: 'Serve registrarsi?',
        answer: "No: lo strumento è gratuito e senza registrazione. Se poi vuoi un sito costruito su questa palette, scrivimi e la usiamo come punto di partenza.",
      },
    ],
    indexEyebrow: 'Indice',
    indexTitle: 'La palette di ogni professione.',
    indexLead: 'Le professioni per cui preparo palette e testi di esempio, divise per categoria.',
    indexSoon: 'in arrivo',
    sectorMetaTitle: (label) => `Palette di colori per ${label.toLowerCase()} — Palette di settore | Calicchia Design`,
    sectorMetaDescription: (label) =>
      `I colori dominanti delle foto di ${label.toLowerCase()}, con stile, contrasti WCAG verificati e anteprima su sito, post e biglietto. Strumento gratuito, esportazione in CSS, Tailwind, JSON e Canva.`,
    sectorEyebrow: 'Palette di settore',
    sectorTitle: (label) => `Palette di colori per ${label.toLowerCase()}.`,
    whyEyebrow: 'Perché questi colori',
    whyTitle: (label) => `I colori di ${label.toLowerCase()}, misurati.`,
    whyBody: ({ label, temp, sat, chroma, style, why }) =>
      `Nelle foto di ${label.toLowerCase()} prevale una palette ${temp} e ${sat} (croma media ${chroma}). Per questo parto dallo stile ${style}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`,
    whyPrimary: 'Primario',
    whyAccent: 'Accento',
    creditsTitle: 'Le foto',
    creditsLead: 'Foto da Unsplash: ogni palette nasce da qui. Grazie ai fotografi.',
    relatedTitle: (category) => `Altre palette: ${category}`,
    landingTitle: 'Dalla palette al sito',
    landingBody: (label) => `Ho una pagina dedicata ai siti web per ${label.toLowerCase()}: cosa serve, quanto costa, come lavoro.`,
    landingCta: (label) => `Sito web per ${label.toLowerCase()}`,
    shareMetaTitle: 'Palette condivisa — Palette di settore | Calicchia Design',
    shareMetaDescription: 'Una palette creata con lo strumento gratuito Palette di settore: colori, stile e anteprima.',
    shareEyebrow: 'Palette condivisa',
    shareTitle: 'Una palette condivisa.',
    shareTitleSector: (label) => `Una palette per ${label.toLowerCase()}.`,
    shareLead: 'Creata con Palette di settore: colori estratti da foto vere, contrasti verificati. Per farne una tua, apri lo strumento.',
    shareStyle: (name) => `Stile ${name}`,
    shareColors: 'Colori',
    sharePrimary: 'primario',
    shareOpenTool: 'Apri lo strumento',
    shareOpenSector: (label) => `Palette per ${label.toLowerCase()}`,
    shareContact: 'Parliamone',
    shareInvalidTitle: 'Questo link non contiene una palette valida.',
    shareInvalidBody: 'Forse è stato copiato a metà. Puoi crearne una nuova in un minuto.',
  },
  en: {
    metaTitle: "Industry colour palette: your industry's colours, free — Calicchia Design",
    metaDescription:
      'Free tool: type your business, I extract the dominant colours from photos of your industry and show them on a website, a post and a business card, with WCAG contrast already checked. CSS, Tailwind, JSON and Canva tokens.',
    ogTitle: "Industry colour palette: your industry's colours",
    breadcrumbResources: 'Resources',
    breadcrumbTool: 'Industry colour palette',
    eyebrow: 'Resources · Free tool',
    title: "Your industry's palette.",
    lead: 'Tell me what your business is and, if you have one, upload your logo. I look for photos of your industry, extract their dominant colours and show them on a website, a post and a business card, with the contrast already checked.',
    facts: 'Free · no sign-up · tokens in CSS, Tailwind and JSON',
    appName: 'Industry colour palette',
    appFeatures: [
      'Dominant colours extracted from industry photos (k-means in OKLab)',
      'Logo colours kept fixed in the palette',
      'Four styles with open-source fonts',
      'Preview on a homepage, post, business card and sign',
      'Colour-blindness simulation',
      'WCAG 2.2 contrast checks and fixes',
      'Export to CSS, Tailwind v4, JSON (DTCG) and Canva',
    ],
    defaultLabel: 'Pizzeria',
    methodEyebrow: 'Method',
    methodTitle: 'How the palette is made.',
    methodSteps: [
      {
        title: 'Real photos of the industry',
        body: 'I start from real photos on Unsplash, chosen for your industry. For businesses outside the list, the search runs on the spot, translated into English.',
      },
      {
        title: 'Colours measured, not picked by eye',
        body: 'Each photo is reduced to a 64 × 48 thumbnail and its pixels are grouped with k-means in OKLab space, which follows human perception. I keep three colours per photo, merge duplicates below ΔE 0.05 and choose the five most representative.',
      },
      {
        title: 'Roles and contrast',
        body: 'Background, text and neutrals are calculated for legibility; primary and accent come from the extracted colours. Every pair used for text passes the WCAG 2.2 criteria: if it falls short, I change the lightness and keep the hue.',
      },
    ],
    faqTitle: 'Frequently asked questions',
    faqs: [
      {
        question: 'Where do the photos come from?',
        answer:
          "From Unsplash, a collection of free-to-use photos. For the ready-made industries I chose and analysed them in advance; for other businesses the search runs on the spot. Under each photo you'll find the photographer's name and a link to the original.",
      },
      {
        question: 'Do my logo and photos end up on a server?',
        answer:
          'No. Your logo and photos stay in your browser: I read them with the canvas and they never go to a server. The shared link only holds the colours, the style and the industry.',
      },
      {
        question: 'What does checked contrast mean?',
        answer:
          'Every colour pair used for text is measured with the WCAG 2.2 contrast ratio: at least 4.5:1 for normal text, 3:1 for icons and borders. If a colour falls short, I adjust its lightness and keep the hue. You can also switch the fixes off and see the original ratios.',
      },
      {
        question: 'Can I use the palette for my website or social media?',
        answer:
          "Yes, it's yours. Export the CSS variables, the Tailwind v4 theme, JSON tokens (DTCG format) or the codes to paste into Canva. The fonts of the four styles are open source (OFL licence).",
      },
      {
        question: 'Why that style?',
        answer:
          "Each ready-made industry has a starting style. For other businesses I infer it from the colours: the palette's average chroma, temperature and lightness. You can always pick another one: the preview, touchpoints and export update straight away.",
      },
      {
        question: 'Do I need to sign up?',
        answer: "No: the tool is free and needs no sign-up. If you'd like a website built on this palette, write to me and we'll use it as a starting point.",
      },
    ],
    indexEyebrow: 'Index',
    indexTitle: 'A palette for every profession.',
    indexLead: 'The professions I prepare palettes and sample copy for, grouped by category.',
    indexSoon: 'coming soon',
    sectorMetaTitle: (label) => `Colour palette for ${label.toLowerCase()} — Industry colour palette | Calicchia Design`,
    sectorMetaDescription: (label) =>
      `The dominant colours in photos of ${label.toLowerCase()}, with a style, checked WCAG contrast and a preview on a website, post and business card. Free tool, export to CSS, Tailwind, JSON and Canva.`,
    sectorEyebrow: 'Industry colour palette',
    sectorTitle: (label) => `Colour palette for ${label.toLowerCase()}.`,
    whyEyebrow: 'Why these colours',
    whyTitle: (label) => `The colours of ${label.toLowerCase()}, measured.`,
    whyBody: ({ label, temp, sat, chroma, style, why }) =>
      `Photos of ${label.toLowerCase()} lean towards a ${temp}, ${sat} palette (average chroma ${chroma}). That's why I start from the ${style} style: ${why.charAt(0).toLowerCase()}${why.slice(1)}`,
    whyPrimary: 'Primary',
    whyAccent: 'Accent',
    creditsTitle: 'The photos',
    creditsLead: 'Photos from Unsplash: every palette starts here. Thanks to the photographers.',
    relatedTitle: (category) => `More palettes: ${category}`,
    landingTitle: 'From palette to website',
    landingBody: (label) => `I have a page dedicated to websites for ${label.toLowerCase()}: what you need, what it costs, how I work.`,
    landingCta: (label) => `Websites for ${label.toLowerCase()}`,
    shareMetaTitle: 'Shared palette — Industry colour palette | Calicchia Design',
    shareMetaDescription: 'A palette made with the free Industry colour palette tool: colours, style and preview.',
    shareEyebrow: 'Shared palette',
    shareTitle: 'A shared palette.',
    shareTitleSector: (label) => `A palette for ${label.toLowerCase()}.`,
    shareLead: 'Made with the Industry colour palette tool: colours extracted from real photos, contrast checked. To make your own, open the tool.',
    shareStyle: (name) => `${name} style`,
    shareColors: 'Colours',
    sharePrimary: 'primary',
    shareOpenTool: 'Open the tool',
    shareOpenSector: (label) => `Palette for ${label.toLowerCase()}`,
    shareContact: "Let's talk",
    shareInvalidTitle: "This link doesn't hold a valid palette.",
    shareInvalidBody: 'Maybe it was only partly copied. You can make a new one in a minute.',
  },
};
