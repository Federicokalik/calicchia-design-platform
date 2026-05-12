import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const SEO_EXTRAS = {
  deliverables: [
    { title: 'Audit tecnico SEO', format: 'PDF report', timeline: 'settimana 1' },
    { title: 'Crawl error map', format: 'CSV + .md', timeline: 'settimana 1' },
    { title: 'Sitemap XML revisionata', format: 'XML', timeline: 'settimana 1-2' },
    { title: 'Schema markup base', format: 'JSON-LD', timeline: 'settimana 2' },
    { title: 'Keyword research locale', format: '.xlsx', timeline: 'settimana 2' },
    { title: 'Content gap analysis', format: '.xlsx + .md', timeline: 'settimana 2-3' },
    { title: 'Piano pagine prioritarie', format: '.md', timeline: 'settimana 3' },
    { title: 'Setup GSC e GA4', format: 'Console config', timeline: 'settimana 3' },
    { title: 'Link building shortlist', format: '.xlsx', timeline: 'ongoing' },
    { title: 'Report mensile leggibile', format: 'PDF + dashboard', timeline: 'mensile' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'web-design', title: 'Web Design', shortPitch: 'Se la struttura del sito è confusa, la SEO lavora con una zavorra addosso.' },
    { slug: 'sviluppo-web', title: 'Sviluppo Web', shortPitch: 'Performance, markup e routing sporco sono problemi SEO prima che estetici.' },
    { slug: 'analytics-setup', title: 'Analytics & Tag Manager', shortPitch: 'Senza GA4 + GTM correttamente configurati, ogni decisione SEO è alla cieca.' },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 15 minuti',
    title: 'Vediamo dove Google ti sta penalizzando?',
    body: 'Guardo indicizzazione, query, pagine deboli e Google Business. 15 minuti su Meet, niente promessa di prima pagina.',
  } satisfies ServiceLeadMagnetCopy,
} as const;
