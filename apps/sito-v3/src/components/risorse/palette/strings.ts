import type { PaletteSaturation, PaletteTemperature } from '@calicchia/shared/palette';
import type { SectorCopy } from '@/data/risorse/palette/types';
import type { Locale } from '@/lib/i18n';

/** Stringhe del tool "Palette di settore" (pattern di components/tools/GeoAuditTool.tsx). */

export type VisionMode = 'none' | 'deut' | 'prot' | 'trit' | 'gray';

export interface ToolStrings {
  // 01 Settore
  sectorTitle: string;
  sectorHelp: string;
  sectorLabel: string;
  sectorPlaceholder: string;
  generate: string;
  searching: string;
  chipsLabel: string;
  queryPrefix: string;
  queryLocal: string;
  msgSimulated: (text: string) => string;
  msgSectorPhotosMissing: string;
  msgTooShort: string;
  // 02 Foto e logo
  photosTitle: string;
  photosHelp: string;
  logoTitle: string;
  logoSub: string;
  logoUpload: string;
  logoAlt: string;
  logoBgRemoved: string;
  logoBgTransparent: string;
  logoFixed: (n: number) => string;
  logoRemove: string;
  logoErrEmpty: string;
  logoErrUnreadable: string;
  logoErrInvalid: string;
  photoUpload: string;
  photoHint: string;
  photoSimulated: (n: number) => string;
  photoSimulatedAlt: (n: number, label: string) => string;
  photoUser: string;
  photoUserAlt: string;
  photoRemove: string;
  photoDefaultAlt: string;
  photoCredit: string;
  photoCreditOn: string;
  photoBroken: string;
  dominantColors: string;
  loadingPhotos: string;
  method: string;
  // 03 Palette
  paletteTitle: string;
  paletteHelp: string;
  flagLogo: string;
  flagLocked: string;
  rolePrimary: string;
  rolePrimaryUsed: (hex: string) => string;
  roleAccent: string;
  roleAccentText: (hex: string) => string;
  lock: string;
  unlock: string;
  lockAria: (hex: string) => string;
  unlockAria: (hex: string) => string;
  usePrimary: string;
  usePrimaryAria: (hex: string) => string;
  neutralsHead: string;
  neutralsNote: string;
  neutralBg: string;
  neutralSurface: string;
  neutralBorder: string;
  neutralMuted: string;
  neutralText: string;
  regenerate: string;
  status: (label: string, variant: number, locked: number) => string;
  // 04 Stile
  styleTitle: string;
  styleHelp: string;
  styleGroup: string;
  suggested: string;
  reasonTitle: string;
  temperature: Record<PaletteTemperature, string>;
  saturation: Record<PaletteSaturation, string>;
  reason: (args: { mapped: boolean; label: string; temp: string; sat: string; chroma: string; why: string }) => string;
  picked: (name: string) => string;
  // 05 Anteprima
  previewTitle: string;
  previewHelp: string;
  visionLabel: string;
  visionNote: string;
  vision: Record<VisionMode, string>;
  previewBar: string;
  previewStyle: (name: string) => string;
  previewLinks: [string, string, string];
  previewImgAlt: string;
  // 06 Supporti
  mockTitle: string;
  mockHelp: string;
  mockPost: string;
  mockCardFront: string;
  mockCardBack: string;
  mockSign: string;
  mockAddress: [string, string];
  // 07 Contrasti
  contrastTitle: string;
  contrastHelp: string;
  autofix: string;
  thSample: string;
  thPair: string;
  thRatio: string;
  thGrade: string;
  rowTextBg: string;
  rowMutedBg: string;
  rowTextSurface: string;
  rowOnPrimary: string;
  rowAccentText: string;
  rowAccentUi: string;
  gradeAAA: string;
  gradeAA: string;
  gradeLarge: string;
  gradeUi: string;
  gradeFail: string;
  fixPrimary: string;
  fixAccent: string;
  fixPrimaryNote: (ratio: string, onWhite: boolean) => string;
  fixAccentNote: (ratio: string) => string;
  fixLine: (what: string) => [string, string, string];
  autofixOff: string;
  noFixes: string;
  // 08 Esporta
  exportTitle: string;
  exportHelp: string;
  exportGroup: string;
  exportTabs: { css: string; tailwind: string; json: string; canva: string };
  codeAria: string;
  copy: string;
  copied: string;
  copyFallback: string;
  shareTitle: string;
  shareText: string;
  share: string;
  shareCopied: string;
  shareReady: string;
  shareLinkLabel: string;
  shareNote: string;
  // 09 CTA
  ctaEyebrow: string;
  ctaTitle: [string, string];
  ctaBody: string;
  ctaButton: string;
  // Generico
  stepOf: (n: string) => string;
}

export const T: Record<Locale, ToolStrings> = {
  it: {
    sectorTitle: 'Settore',
    sectorHelp:
      'Scrivi la tua attività o scegline una. Se non è tra i settori pronti, traduco la ricerca in inglese, dove Unsplash ha più foto.',
    sectorLabel: 'Che attività hai?',
    sectorPlaceholder: 'Es. pizzeria, studio legale, fioraio',
    generate: 'Genera',
    searching: 'Cerco…',
    chipsLabel: 'Settori pronti',
    queryPrefix: 'Ricerca su Unsplash: ',
    queryLocal: 'Foto simulate nel browser',
    msgSimulated: (text) =>
      `Non ho trovato foto per «${text}»: uso foto simulate con colori generici. Prova con una parola più comune o scegli un settore pronto.`,
    msgSectorPhotosMissing:
      'Le foto di questo settore non sono disponibili in questo momento: uso foto simulate con colori generici.',
    msgTooShort: 'Scrivi almeno due lettere.',
    photosTitle: 'Foto e logo',
    photosHelp:
      'Ogni foto viene ridotta ai suoi tre colori dominanti. Se hai già un logo, i suoi colori entrano nella palette e restano fissi.',
    logoTitle: 'Hai già un logo?',
    logoSub:
      'Tolgo lo sfondo, ne estraggo fino a tre colori e li tengo fissi. Funziona con loghi su sfondo trasparente o a tinta unita. Il file resta nel tuo browser.',
    logoUpload: 'Carica il logo',
    logoAlt: 'Il tuo logo senza sfondo',
    logoBgRemoved: 'Sfondo rimosso',
    logoBgTransparent: 'Sfondo già trasparente',
    logoFixed: (n) => `${n} ${n === 1 ? 'colore fisso' : 'colori fissi'} nella palette`,
    logoRemove: 'Rimuovi logo',
    logoErrEmpty: "Non trovo il logo nell'immagine: sembra tutto sfondo. Prova con un file su sfondo trasparente.",
    logoErrUnreadable: 'Non riesco a leggere questo file. Prova con un PNG o un SVG su sfondo trasparente.',
    logoErrInvalid: "Il file non è un'immagine valida. Usa PNG, SVG, JPG o WebP.",
    photoUpload: 'Aggiungi una tua foto',
    photoHint: 'Resta nel tuo browser · pesa il doppio · massimo 3 · puoi anche trascinarla qui',
    photoSimulated: (n) => `Simulata ${String(n).padStart(2, '0')}`,
    photoSimulatedAlt: (n, label) => `Foto simulata ${n} per ${label}`,
    photoUser: 'Tua foto · ×2',
    photoUserAlt: 'Foto caricata da te',
    photoRemove: 'Rimuovi',
    photoDefaultAlt: 'Foto del settore',
    photoCredit: 'Foto di',
    photoCreditOn: 'su',
    photoBroken: 'Foto non disponibile: restano i suoi colori',
    dominantColors: 'Colori dominanti',
    loadingPhotos: 'Carico le foto…',
    method:
      'Metodo: 6 foto per settore · 3 colori dominanti per foto (k-means nello spazio OKLab) · doppioni percettivi uniti sotto ΔE 0,05 · tengo i 5 più rappresentativi',
    paletteTitle: 'Palette',
    paletteHelp: 'I cinque colori più rappresentativi, senza doppioni. Blocca quelli che vuoi tenere e rigenera il resto.',
    flagLogo: 'Dal logo',
    flagLocked: 'Bloccato',
    rolePrimary: 'Primario',
    rolePrimaryUsed: (hex) => `nei bottoni ${hex}`,
    roleAccent: 'Accento',
    roleAccentText: (hex) => `nei testi ${hex}`,
    lock: 'Blocca',
    unlock: 'Sblocca',
    lockAria: (hex) => `Blocca ${hex}`,
    unlockAria: (hex) => `Sblocca ${hex}`,
    usePrimary: 'Usa come primario',
    usePrimaryAria: (hex) => `Usa ${hex} come primario`,
    neutralsHead: 'Neutri derivati dalla palette',
    neutralsNote: 'Non estratti: calcolati per leggibilità',
    neutralBg: 'Sfondo',
    neutralSurface: 'Superficie',
    neutralBorder: 'Bordo',
    neutralMuted: 'Testo secondario',
    neutralText: 'Testo',
    regenerate: 'Rigenera',
    status: (label, variant, locked) =>
      `${label} · variante ${variant} · ${locked} ${locked === 1 ? 'colore bloccato' : 'colori bloccati'}`,
    styleTitle: 'Stile',
    styleHelp: 'Quattro stili già pronti. Te ne suggerisco uno in base al settore e ai colori, ma puoi cambiarlo.',
    styleGroup: 'Stile',
    suggested: 'Suggerito',
    reasonTitle: 'Perché questo suggerimento',
    temperature: { warm: 'calda', cool: 'fredda', mixed: 'mista' },
    saturation: { saturated: 'satura', soft: 'morbida', muted: 'desaturata' },
    reason: ({ mapped, label, temp, sat, chroma, why }) =>
      `${mapped ? `Settore ${label.toLowerCase()}, ` : 'Settore fuori elenco, scelta dai colori: '}palette ${temp} e ${sat} (croma media ${chroma}). ${why}`,
    picked: (name) => ` Hai scelto ${name}.`,
    previewTitle: 'Anteprima',
    previewHelp: 'Palette e stile applicati a una home di esempio. Si aggiorna a ogni modifica.',
    visionLabel: 'Simula la visione',
    visionNote: 'Modello di Machado et al. (2009) · vale anche per i supporti',
    vision: {
      none: 'Normale',
      deut: 'Deuteranopia · verde',
      prot: 'Protanopia · rosso',
      trit: 'Tritanopia · blu',
      gray: 'Scala di grigi',
    },
    previewBar: 'Home di esempio · testi fittizi',
    previewStyle: (name) => `Stile ${name}`,
    previewLinks: ['Servizi', 'Chi siamo', 'Contatti'],
    previewImgAlt: 'Foto di esempio del settore',
    mockTitle: 'Supporti',
    mockHelp: "La stessa palette su quello che usi ogni giorno: un post, il biglietto da visita, l'insegna.",
    mockPost: 'Post Instagram · 1080 × 1350',
    mockCardFront: 'Biglietto da visita, fronte · 85 × 55 mm',
    mockCardBack: 'Biglietto da visita, retro',
    mockSign: 'Insegna o targa · proporzione 4:1',
    mockAddress: ['Via Roma 12 · Frosinone', '0775 000 000'],
    contrastTitle: 'Contrasti',
    contrastHelp:
      'Verifico ogni coppia con i criteri WCAG 2.2. Se un contrasto non basta, correggo la luminosità e tengo la tinta.',
    autofix: 'Correggi i contrasti in automatico',
    thSample: 'Campione',
    thPair: 'Coppia',
    thRatio: 'Rapporto',
    thGrade: 'Esito',
    rowTextBg: 'Testo su sfondo',
    rowMutedBg: 'Testo secondario su sfondo',
    rowTextSurface: 'Testo su superficie',
    rowOnPrimary: 'Testo sul bottone primario',
    rowAccentText: 'Accento come testo',
    rowAccentUi: 'Accento come grafica (icone, bordi)',
    gradeAAA: 'AAA',
    gradeAA: 'AA',
    gradeLarge: 'Solo testo grande',
    gradeUi: 'Passa (grafica)',
    gradeFail: 'Non passa',
    fixPrimary: 'Primario',
    fixAccent: 'Accento per i testi',
    fixPrimaryNote: (ratio, onWhite) => `${ratio} con il testo ${onWhite ? 'bianco' : 'scuro'} del bottone`,
    fixAccentNote: (ratio) => `${ratio} sullo sfondo`,
    fixLine: (what) => [`${what}: `, ' → ', ' per arrivare a '],
    autofixOff: 'Correzione automatica disattivata: vedi i rapporti dei colori estratti così come sono.',
    noFixes: 'Nessuna correzione necessaria: tutte le coppie usate nei testi passano già.',
    exportTitle: 'Esporta',
    exportHelp: 'Token pronti per lo sviluppo, o i codici da incollare in Canva se i post li fai da solo.',
    exportGroup: 'Formato di esportazione',
    exportTabs: { css: 'Variabili CSS', tailwind: 'Tailwind v4', json: 'JSON', canva: 'Canva' },
    codeAria: 'Codice da copiare',
    copy: 'Copia',
    copied: 'Copiato negli appunti.',
    copyFallback: 'Testo selezionato: premi Ctrl+C (Cmd+C su Mac).',
    shareTitle: 'Condividi la palette',
    shareText: 'Un link con colori e stile, da girare a chi ti segue il sito o da tenere per dopo.',
    share: 'Crea il link',
    shareCopied: 'Link copiato negli appunti.',
    shareReady: 'Ecco il link: selezionalo e copialo.',
    shareLinkLabel: 'Link alla palette',
    shareNote: 'Il link contiene solo colori, stile e settore: niente logo, niente foto tue, niente testo cercato.',
    ctaEyebrow: '09 · Prossimo passo',
    ctaTitle: ["Hai un'idea?", 'Vediamola insieme.'],
    ctaBody:
      'Una chiamata di 30 minuti per capire se ha senso lavorare insieme. Risposta entro 24 ore.',
    ctaButton: 'Scrivimi',
    stepOf: (n) => `Passo ${n}`,
  },
  en: {
    sectorTitle: 'Industry',
    sectorHelp:
      "Type your business or pick one. If it isn't one of the ready-made industries, I translate the search into English, where Unsplash has more photos.",
    sectorLabel: "What's your business?",
    sectorPlaceholder: 'E.g. pizzeria, law firm, florist',
    generate: 'Generate',
    searching: 'Searching…',
    chipsLabel: 'Ready-made industries',
    queryPrefix: 'Unsplash search: ',
    queryLocal: 'Photos simulated in your browser',
    msgSimulated: (text) =>
      `I couldn't find photos for “${text}”, so I'm using simulated photos with generic colours. Try a more common word or pick a ready-made industry.`,
    msgSectorPhotosMissing:
      "This industry's photos aren't available right now, so I'm using simulated photos with generic colours.",
    msgTooShort: 'Type at least two letters.',
    photosTitle: 'Photos and logo',
    photosHelp:
      'Each photo is reduced to its three dominant colours. If you already have a logo, its colours join the palette and stay fixed.',
    logoTitle: 'Already have a logo?',
    logoSub:
      'I remove the background, extract up to three colours and keep them fixed. It works with logos on a transparent or solid background. The file stays in your browser.',
    logoUpload: 'Upload your logo',
    logoAlt: 'Your logo without its background',
    logoBgRemoved: 'Background removed',
    logoBgTransparent: 'Background already transparent',
    logoFixed: (n) => `${n} fixed ${n === 1 ? 'colour' : 'colours'} in the palette`,
    logoRemove: 'Remove logo',
    logoErrEmpty: "I can't find the logo in the image: it all looks like background. Try a file with a transparent background.",
    logoErrUnreadable: "I can't read this file. Try a PNG or an SVG with a transparent background.",
    logoErrInvalid: "The file isn't a valid image. Use PNG, SVG, JPG or WebP.",
    photoUpload: 'Add your own photo',
    photoHint: 'Stays in your browser · counts double · up to 3 · you can also drag it here',
    photoSimulated: (n) => `Simulated ${String(n).padStart(2, '0')}`,
    photoSimulatedAlt: (n, label) => `Simulated photo ${n} for ${label}`,
    photoUser: 'Your photo · ×2',
    photoUserAlt: 'Photo you uploaded',
    photoRemove: 'Remove',
    photoDefaultAlt: 'Industry photo',
    photoCredit: 'Photo by',
    photoCreditOn: 'on',
    photoBroken: 'Photo unavailable: its colours remain',
    dominantColors: 'Dominant colours',
    loadingPhotos: 'Loading photos…',
    method:
      'Method: 6 photos per industry · 3 dominant colours per photo (k-means in OKLab space) · perceptual duplicates merged below ΔE 0.05 · the 5 most representative kept',
    paletteTitle: 'Palette',
    paletteHelp: 'The five most representative colours, with no duplicates. Lock the ones you want to keep and regenerate the rest.',
    flagLogo: 'From logo',
    flagLocked: 'Locked',
    rolePrimary: 'Primary',
    rolePrimaryUsed: (hex) => `on buttons ${hex}`,
    roleAccent: 'Accent',
    roleAccentText: (hex) => `in text ${hex}`,
    lock: 'Lock',
    unlock: 'Unlock',
    lockAria: (hex) => `Lock ${hex}`,
    unlockAria: (hex) => `Unlock ${hex}`,
    usePrimary: 'Use as primary',
    usePrimaryAria: (hex) => `Use ${hex} as primary`,
    neutralsHead: 'Neutrals derived from the palette',
    neutralsNote: 'Not extracted: calculated for legibility',
    neutralBg: 'Background',
    neutralSurface: 'Surface',
    neutralBorder: 'Border',
    neutralMuted: 'Secondary text',
    neutralText: 'Text',
    regenerate: 'Regenerate',
    status: (label, variant, locked) =>
      `${label} · variant ${variant} · ${locked} ${locked === 1 ? 'colour locked' : 'colours locked'}`,
    styleTitle: 'Style',
    styleHelp: "Four ready-made styles. I suggest one based on the industry and the colours, but you're free to change it.",
    styleGroup: 'Style',
    suggested: 'Suggested',
    reasonTitle: 'Why this suggestion',
    temperature: { warm: 'warm', cool: 'cool', mixed: 'mixed' },
    saturation: { saturated: 'saturated', soft: 'soft', muted: 'muted' },
    reason: ({ mapped, label, temp, sat, chroma, why }) =>
      `${mapped ? `Industry: ${label.toLowerCase()}, ` : 'Industry not in the list, chosen from the colours: '}a ${temp}, ${sat} palette (average chroma ${chroma}). ${why}`,
    picked: (name) => ` You picked ${name}.`,
    previewTitle: 'Preview',
    previewHelp: 'Palette and style applied to a sample homepage. It updates with every change.',
    visionLabel: 'Simulate vision',
    visionNote: 'Machado et al. (2009) model · applies to the touchpoints too',
    vision: {
      none: 'Normal',
      deut: 'Deuteranopia · green',
      prot: 'Protanopia · red',
      trit: 'Tritanopia · blue',
      gray: 'Greyscale',
    },
    previewBar: 'Sample homepage · placeholder copy',
    previewStyle: (name) => `${name} style`,
    previewLinks: ['Services', 'About', 'Contact'],
    previewImgAlt: 'Sample photo of the industry',
    mockTitle: 'Touchpoints',
    mockHelp: 'The same palette on what you use every day: a post, a business card, a sign.',
    mockPost: 'Instagram post · 1080 × 1350',
    mockCardFront: 'Business card, front · 85 × 55 mm',
    mockCardBack: 'Business card, back',
    mockSign: 'Sign or plaque · 4:1 ratio',
    mockAddress: ['12 Market Street · Bristol', '0117 000 0000'],
    contrastTitle: 'Contrast',
    contrastHelp:
      "I check every pair against the WCAG 2.2 criteria. If a contrast falls short, I adjust the lightness and keep the hue.",
    autofix: 'Fix contrast automatically',
    thSample: 'Sample',
    thPair: 'Pair',
    thRatio: 'Ratio',
    thGrade: 'Result',
    rowTextBg: 'Text on background',
    rowMutedBg: 'Secondary text on background',
    rowTextSurface: 'Text on surface',
    rowOnPrimary: 'Text on the primary button',
    rowAccentText: 'Accent as text',
    rowAccentUi: 'Accent as graphics (icons, borders)',
    gradeAAA: 'AAA',
    gradeAA: 'AA',
    gradeLarge: 'Large text only',
    gradeUi: 'Passes (graphics)',
    gradeFail: 'Fails',
    fixPrimary: 'Primary',
    fixAccent: 'Accent for text',
    fixPrimaryNote: (ratio, onWhite) => `${ratio} with the button's ${onWhite ? 'white' : 'dark'} text`,
    fixAccentNote: (ratio) => `${ratio} on the background`,
    fixLine: (what) => [`${what}: `, ' → ', ' to reach '],
    autofixOff: 'Automatic fixing is off: you see the ratios of the extracted colours as they are.',
    noFixes: 'No fixes needed: every pair used for text already passes.',
    exportTitle: 'Export',
    exportHelp: 'Tokens ready for development, or the codes to paste into Canva if you make your own posts.',
    exportGroup: 'Export format',
    exportTabs: { css: 'CSS variables', tailwind: 'Tailwind v4', json: 'JSON', canva: 'Canva' },
    codeAria: 'Code to copy',
    copy: 'Copy',
    copied: 'Copied to the clipboard.',
    copyFallback: 'Text selected: press Ctrl+C (Cmd+C on a Mac).',
    shareTitle: 'Share the palette',
    shareText: 'A link with the colours and style, to pass on to whoever builds your site or to keep for later.',
    share: 'Create the link',
    shareCopied: 'Link copied to the clipboard.',
    shareReady: 'Here is the link: select it and copy it.',
    shareLinkLabel: 'Palette link',
    shareNote: 'The link only holds the colours, style and industry: no logo, none of your photos, no search text.',
    ctaEyebrow: '09 · Next step',
    ctaTitle: ['Got an idea?', "Let's look at it together."],
    ctaBody:
      'A 30-minute call to see whether it makes sense to work together. Reply within 24 hours.',
    ctaButton: 'Write to me',
    stepOf: (n) => `Step ${n}`,
  },
};

/** Testi della home di esempio quando il settore non è tra quelli pronti. */
export function genericCopy(label: string, locale: Locale): SectorCopy {
  if (locale === 'en') {
    return {
      name: label,
      nav: 'Contact',
      eyebrow: label,
      h1: 'Your homepage headline.',
      lead: 'This is where the line explaining what you do, and for whom, goes. Two lines at most.',
      btn1: 'Get in touch',
      btn2: 'Services',
      cards: [
        { title: 'First service', description: 'One line on what the customer gets.', meta: 'On request' },
        { title: 'Second service', description: 'One line on what the customer gets.', meta: 'On request' },
        { title: 'Find us', description: 'Opening hours, address and phone up front.', meta: 'Mon–Sat' },
      ],
      banner: 'A highlighted line: opening hours, an offer, news',
    };
  }
  return {
    name: label,
    nav: 'Contatti',
    eyebrow: label,
    h1: 'Il titolo della tua home.',
    lead: 'Qui va la frase che spiega cosa fai e per chi. Due righe al massimo.',
    btn1: 'Contattaci',
    btn2: 'Servizi',
    cards: [
      { title: 'Primo servizio', description: 'Una riga su cosa ottiene il cliente.', meta: 'Su richiesta' },
      { title: 'Secondo servizio', description: 'Una riga su cosa ottiene il cliente.', meta: 'Su richiesta' },
      { title: 'Dove siamo', description: 'Orari, indirizzo e telefono in evidenza.', meta: 'Lun–Sab' },
    ],
    banner: 'Una frase in evidenza: orari, promozione, novità',
  };
}

/** Rapporto di contrasto con la virgola in italiano: 4,5:1. */
export function fmtRatio(ratio: number, locale: Locale): string {
  const s = ratio.toFixed(1);
  return `${locale === 'it' ? s.replace('.', ',') : s}:1`;
}

export function fmt2(n: number, locale: Locale): string {
  const s = n.toFixed(2);
  return locale === 'it' ? s.replace('.', ',') : s;
}
