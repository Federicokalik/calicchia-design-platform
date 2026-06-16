import type { Locale } from '@/lib/i18n';

/**
 * Static registry of /risorse entries. Source of truth for the hub listing.
 * Not DB-backed: resources are curated, evergreen documents (white papers,
 * glossaries) that don't need the blog CMS workflow.
 *
 * `path` is the IT-canonical path; the hub localizes it with `localizedPath`.
 * `kind` drives the card label; `standalone` marks bespoke-design documents
 * (own layout, no site chrome).
 */
export type ResourceKind = 'whitepaper' | 'glossary';

export interface ResourceEntry {
  key: string;
  path: string;
  kind: ResourceKind;
  standalone: boolean;
  /** Sort key — higher first. */
  weight: number;
  title: Record<Locale, string>;
  description: Record<Locale, string>;
  /** Short meta line shown on the card (e.g. "White paper · 2026"). */
  meta: Record<Locale, string>;
}

export const RESOURCES: ResourceEntry[] = [
  {
    key: 'geo-whitepaper',
    path: '/risorse/dalla-seo-alla-geo',
    kind: 'whitepaper',
    standalone: true,
    weight: 100,
    title: {
      it: 'Dalla SEO alla GEO',
      en: 'From SEO to GEO',
    },
    description: {
      it: 'Come funzionano davvero i motori generativi — retrieval, embeddings, chunking, fan-out — cosa rende un contenuto citabile e il quadro normativo UE/Italia. Con fonti primarie e demo interattive.',
      en: 'How generative engines really work — retrieval, embeddings, chunking, fan-out — what makes content citable, and the EU/Italy legal frame. With primary sources and interactive demos.',
    },
    meta: {
      it: 'White paper · 2026',
      en: 'White paper · 2026',
    },
  },
  {
    key: 'glossario-seo',
    // Migrato sotto /risorse (vedi 301 in proxy.ts).
    path: '/risorse/glossario-seo',
    kind: 'glossary',
    standalone: false,
    weight: 30,
    title: {
      it: 'Glossario SEO',
      en: 'SEO Glossary',
    },
    description: {
      it: 'I termini della SEO spiegati senza gergo: cosa sono, perché contano e cosa pretendere da chi te ne parla.',
      en: 'SEO terms explained without jargon: what they are, why they matter, and what to demand from whoever sells them to you.',
    },
    meta: {
      it: 'Glossario',
      en: 'Glossary',
    },
  },
  {
    key: 'glossario-e-commerce',
    path: '/risorse/glossario-e-commerce',
    kind: 'glossary',
    standalone: false,
    weight: 20,
    title: {
      it: 'Glossario E-commerce',
      en: 'E-commerce Glossary',
    },
    description: {
      it: 'Il vocabolario dell’e-commerce: metriche, tecnologie e concetti chiave per capire un negozio online e le sue performance.',
      en: 'The e-commerce vocabulary: metrics, technologies and key concepts to understand an online store and its performance.',
    },
    meta: {
      it: 'Glossario',
      en: 'Glossary',
    },
  },
  {
    key: 'glossario-web-design',
    path: '/risorse/glossario-web-design',
    kind: 'glossary',
    standalone: false,
    weight: 10,
    title: {
      it: 'Glossario Web Design',
      en: 'Web Design Glossary',
    },
    description: {
      it: 'I termini del web design e dello sviluppo, spiegati in modo chiaro per chi commissiona un sito e vuole capire cosa sta comprando.',
      en: 'Web design and development terms, explained clearly for whoever commissions a site and wants to understand what they are buying.',
    },
    meta: {
      it: 'Glossario',
      en: 'Glossary',
    },
  },
];

export function listResources(): ResourceEntry[] {
  return [...RESOURCES].sort((a, b) => b.weight - a.weight);
}
