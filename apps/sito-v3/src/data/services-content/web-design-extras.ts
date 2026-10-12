import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const WEB_DESIGN_EXTRAS = {
  deliverables: [
    { title: 'Sitemap pagine principali', format: 'Miro + .md', timeline: 'settimana 1' },
    { title: 'Wireframe lo-fi navigabili', format: 'Figma', timeline: 'settimana 1' },
    { title: 'Design tokens base', format: 'Figma + .json', timeline: 'settimana 1' },
    { title: 'Design hi-fi homepage', format: 'Figma', timeline: 'settimana 2' },
    { title: 'Template pagine interne', format: 'Figma', timeline: 'settimana 2-3' },
    { title: 'Componenti UI documentati', format: 'Figma', timeline: 'settimana 3' },
    { title: 'Microcopy form e CTA', format: '.md', timeline: 'settimana 3' },
    { title: 'Checklist responsive 4 breakpoint', format: 'PDF report', timeline: 'pre-launch' },
    { title: 'Handoff sviluppo e asset', format: 'Figma + .zip', timeline: 'pre-launch' },
    { title: 'Controllo post-lancio', format: 'Checklist', timeline: 'post-launch' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'seo', title: 'SEO & Visibilità', shortPitch: 'Se il sito è pulito ma Google non lo legge, il problema resta fuori dal design.' },
    { slug: 'performance-cwv', title: 'Performance & Core Web Vitals', shortPitch: 'Sito bello ma lento è invisibile. LCP, CLS, INP a posto o Google penalizza.' },
    { slug: 'sviluppo-web', title: 'Sviluppo Web', shortPitch: 'Per dashboard, aree clienti e flussi custom il web design da solo non basta.' },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Strumento gratuito · Palette di settore',
    title: 'Prima di scegliere i colori, guarda il tuo settore',
    body: "Scrivi la tua attività: lo strumento prende i colori da foto reali del settore, li prova su un'anteprima del sito e controlla il contrasto. Poi li esporti per Canva, CSS o Tailwind.",
    href: '/risorse/palette-di-settore',
    buttonLabel: 'Apri la palette di settore',
  } satisfies ServiceLeadMagnetCopy,
} as const;
