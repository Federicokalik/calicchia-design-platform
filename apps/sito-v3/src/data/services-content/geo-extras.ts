import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const GEO_EXTRAS = {
  deliverables: [
    { title: 'GEO Audit tecnico', format: 'Report PDF + JSON', timeline: 'settimana 1' },
    { title: 'Mappa accesso bot', format: 'robots/sitemap review', timeline: 'settimana 1' },
    { title: 'Snippet directives review', format: 'Checklist tecnica', timeline: 'settimana 1' },
    { title: 'Piano pagine citabili', format: '.md', timeline: 'settimana 1-2' },
    { title: 'Riscrittura answer-first', format: 'Copy + markup', timeline: 'settimana 2-3' },
    { title: 'Fonti e statistiche integrate', format: 'Content pack', timeline: 'settimana 2-3' },
    { title: 'Prompt set di misurazione', format: '.xlsx + .md', timeline: 'settimana 3' },
    { title: 'Report citabilita ripetuto', format: 'PDF + note operative', timeline: 'mensile' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'seo', title: 'SEO & Visibilità', shortPitch: 'La GEO non sostituisce la SEO: senza basi tecniche e contenuti solidi, i motori AI hanno poco da citare.' },
    { slug: 'analytics-setup', title: 'Analytics & Tag Manager', shortPitch: 'La visibilità AI va letta insieme a conversioni, referral e query reali, non come metrica isolata.' },
    { slug: 'performance-cwv', title: 'Performance & Core Web Vitals', shortPitch: 'Rendering, HTML pulito e velocità restano prerequisiti anche quando il lettore è un crawler.' },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 2 minuti',
    title: 'Prima misura, poi decidi cosa sistemare',
    body: 'Inserisci una pagina nel GEO Audit: controlla accesso bot, SSR, struttura, citabilità e direttive snippet. Nessuna promessa di citazione, solo criteri verificabili.',
    href: '/audit-geo',
    buttonLabel: 'Avvia il GEO Audit',
  } satisfies ServiceLeadMagnetCopy,
} as const;
