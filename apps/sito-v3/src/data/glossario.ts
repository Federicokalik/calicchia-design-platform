/**
 * Glossario Web Design — tipi, categorie e copy della pagina.
 *
 * I contenuti vivono nel DB (site_glossario, editabili da /admin/cms/glossario)
 * e arrivano da `getGlossario()` in lib/cms.ts. Lo snapshot usato quando
 * l'API non risponde è in `glossario-fallback.ts`.
 *
 * Due template per voce, scelti da `type`:
 *   concept    → Cos'è / Perché ti riguarda / Cosa pretendere
 *   technology → Cos'è / A cosa serve / Quando conviene / Quando no /
 *                Cosa chiedere al fornitore
 *
 * Schema.org DefinedTerm: lo `slug` diventa l'anchor #lcp, #cms, ecc.
 */

import type { Locale } from '@/lib/i18n';

export const GLOSSARIO_CATEGORIES = [
  { id: 'seo', label: { it: 'SEO e contenuti', en: 'SEO and content' } },
  { id: 'performance', label: { it: 'Performance', en: 'Performance' } },
  { id: 'infrastruttura', label: { it: 'Hosting e infrastruttura', en: 'Hosting and infrastructure' } },
  { id: 'dominio-email', label: { it: 'Dominio, DNS ed email', en: 'Domain, DNS and email' } },
  { id: 'sviluppo', label: { it: 'Linguaggi e sviluppo', en: 'Languages and development' } },
  { id: 'piattaforme', label: { it: 'Piattaforme e framework', en: 'Platforms and frameworks' } },
  { id: 'sicurezza-legale', label: { it: 'Sicurezza e privacy', en: 'Security and privacy' } },
  { id: 'design-ux', label: { it: 'Design, UX e accessibilità', en: 'Design, UX and accessibility' } },
  { id: 'motion-3d', label: { it: 'Animazione e 3D', en: 'Animation and 3D' } },
] as const;

export type GlossarioCategory = (typeof GLOSSARIO_CATEGORIES)[number]['id'];

export const GLOSSARIO_LEVELS = [
  { id: 'base', label: { it: 'Base', en: 'Basic' } },
  { id: 'tecnico', label: { it: 'Tecnico', en: 'Technical' } },
] as const;

export type GlossarioLevel = (typeof GLOSSARIO_LEVELS)[number]['id'];

export type GlossarioTermType = 'concept' | 'technology';

export interface GlossarioEntry {
  /** Anchor slug per #fragment URL (lowercase, hyphenated), uguale in IT ed EN */
  slug: string;
  /** Termine principale */
  term: string;
  /** Sottotitolo / nome esteso (opzionale) */
  fullName?: string;
  /** Lettera A-Z (o cifra) per l'indice */
  letter: string;
  category?: GlossarioCategory;
  level: GlossarioLevel;
  type: GlossarioTermType;
  /** Sinonimi cercabili, non mostrati come titolo */
  aliases: string[];
  /** Slug di altre voci da linkare */
  related: string[];
  /** "Cos'è" — comune ai due template */
  whatItIs: string;
  /** concept: "Perché ti riguarda" */
  whyYouCare?: string;
  /** concept: "Cosa pretendere" */
  whatToDemand?: string;
  /** technology: "A cosa serve" */
  whatFor?: string;
  /** technology: "Quando conviene" */
  whenYes?: string;
  /** technology: "Quando no" */
  whenNo?: string;
  /** technology: "Cosa chiedere al fornitore" */
  whatToAsk?: string;
}

export const GLOSSARIO_WEB_DESIGN_PATH = '/risorse/glossario-web-design';

/**
 * Id DOM della voce. Prefissato perché un id uguale allo slug finirebbe su
 * `window` (named access): con `id="gsap"` GSAP/Flip leggono `window.gsap`
 * e trovano l'elemento invece della libreria.
 */
export function glossarioTermAnchor(slug: string): string {
  return `term-${slug}`;
}

/** Copy della pagina. Il conteggio arriva sempre dai dati, mai hardcoded. */
export function glossarioWebDesignCopy(locale: Locale, count: number) {
  if (locale === 'en') {
    const title = `Web Design Glossary · The ${count} terms agencies hope you won't understand`;
    return {
      metaTitle: `${title} | Federico Calicchia`,
      description: `LCP, DNS, WordPress, Next.js, GDPR, hreflang… ${count} web design and development terms explained simply. What each one is, why it matters and what to demand from your provider.`,
      ogTitle: title,
      ogDescription: `${count} technical terms explained simply. What they are, why they matter, what to demand.`,
      eyebrow: `Glossary — ${count} terms · A-Z order`,
      pageTitle: `${title}.`,
      lead:
        'The fastest way to be sold smoke is with technical terms you don\'t understand. Here they are, explained for what they are — and why they matter to you. For each concept: what it is, why it matters, what to demand. For each technology: what it\'s for, when it fits, when it doesn\'t, what to ask your provider.',
      readTime: 'free reading',
      letterTerms: (n: number) => (n === 1 ? '1 term' : `${n} terms`),
      breadcrumbParent: { name: 'Resources', url: '/risorse' },
      breadcrumbGlossary: 'Web Design Glossary',
      jsonLdName: 'Web Design Glossary',
      closingTitle:
        'Now when a provider tells you "don\'t worry about CLS, it\'s normal for it to be red", you know what to reply.',
      ctaPrimary: 'Talk to someone who gets it',
      ctaSecondary: { label: 'Freelance web designer in Italy', href: '/freelance-web-designer-italy' },
    };
  }

  const title = `Glossario Web Design · I ${count} termini che le agenzie sperano tu non capisca`;
  return {
    metaTitle: `${title} | Federico Calicchia`,
    description: `LCP, DNS, WordPress, Next.js, GDPR, hreflang… ${count} termini di web design e sviluppo spiegati semplici. Per ogni termine: cos'è, perché ti riguarda, cosa pretendere dal fornitore.`,
    ogTitle: title,
    ogDescription: `${count} termini tecnici spiegati semplici. Cos'è, perché ti riguarda, cosa pretendere.`,
    eyebrow: `Glossario — ${count} termini · ordine A-Z`,
    pageTitle: `${title}.`,
    lead:
      "Il modo più veloce per farti vendere fumo è usare termini tecnici che non capisci. Eccoli, spiegati per quello che sono — e perché ti riguardano. Per ogni concetto: cos'è, perché ti riguarda, cosa pretendere. Per ogni tecnologia: a cosa serve, quando conviene, quando no, cosa chiedere al fornitore.",
    readTime: 'lettura libera',
    letterTerms: (n: number) => (n === 1 ? '1 termine' : `${n} termini`),
    breadcrumbParent: { name: 'Web Designer Freelance', url: '/web-design-freelance' },
    breadcrumbGlossary: 'Glossario',
    jsonLdName: 'Glossario Web Design',
    closingTitle:
      'Adesso quando un fornitore ti dice "non preoccuparti del CLS, è normale che sia rosso", sai cosa rispondere.',
    ctaPrimary: 'Parlane con uno che capisce',
    ctaSecondary: { label: 'Guida completa al web design freelance', href: '/web-design-freelance' },
  };
}

/** Etichette dei blocchi di testo e dei controlli di filtro/ricerca. */
export const GLOSSARIO_UI = {
  it: {
    whatItIs: "Cos'è",
    whyYouCare: 'Perché ti riguarda',
    whatToDemand: 'Cosa pretendere',
    whatFor: 'A cosa serve',
    whenYes: 'Quando conviene',
    whenNo: 'Quando no',
    whatToAsk: 'Cosa chiedere al fornitore',
    aliases: 'Detto anche',
    related: 'Vedi anche',
    searchLabel: 'Cerca un termine',
    searchPlaceholder: 'Es. ssl, wordpress, velocità…',
    categoryLabel: 'Categoria',
    allCategories: 'Tutte',
    levelLabel: 'Livello',
    allLevels: 'Tutti',
    reset: 'Azzera filtri',
    results: (n: number, total: number) =>
      n === total ? `${total} termini` : n === 1 ? `1 termine su ${total}` : `${n} termini su ${total}`,
    noResults: 'Nessun termine trovato. Prova con un sinonimo o azzera i filtri.',
  },
  en: {
    whatItIs: 'What it is',
    whyYouCare: 'Why it matters',
    whatToDemand: 'What to demand',
    whatFor: "What it's for",
    whenYes: 'When it fits',
    whenNo: "When it doesn't",
    whatToAsk: 'What to ask your provider',
    aliases: 'Also known as',
    related: 'See also',
    searchLabel: 'Search a term',
    searchPlaceholder: 'E.g. ssl, wordpress, speed…',
    categoryLabel: 'Category',
    allCategories: 'All',
    levelLabel: 'Level',
    allLevels: 'All',
    reset: 'Reset filters',
    results: (n: number, total: number) =>
      n === total ? `${total} terms` : n === 1 ? `1 term of ${total}` : `${n} terms of ${total}`,
    noResults: 'No terms found. Try a synonym or reset the filters.',
  },
} as const;

export function categoryLabel(id: GlossarioCategory | undefined, locale: Locale): string | undefined {
  return GLOSSARIO_CATEGORIES.find((c) => c.id === id)?.label[locale];
}

export function levelLabel(id: GlossarioLevel, locale: Locale): string {
  return GLOSSARIO_LEVELS.find((l) => l.id === id)?.label[locale] ?? id;
}

/** Minuscolo, senza accenti: "Velocità" e "velocita" si trovano a vicenda. */
export function normalizeSearch(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Lettere presenti, cifre prima delle lettere (ordine di `sort()`). */
export function glossarioLetters(entries: GlossarioEntry[]): string[] {
  return Array.from(new Set(entries.map((e) => e.letter))).sort();
}
