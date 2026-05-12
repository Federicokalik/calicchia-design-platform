import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const SVILUPPO_WEB_EXTRAS = {
  deliverables: [
    { title: 'Mappa processo operativo', format: 'Miro + .md', timeline: 'settimana 1' },
    { title: 'API design', format: 'OpenAPI', timeline: 'settimana 1-2' },
    { title: 'Schema database', format: 'ERD + SQL', timeline: 'settimana 1-2' },
    { title: 'Dashboard custom', format: 'React app', timeline: 'settimana 2-4' },
    { title: 'Ruoli e permessi', format: 'Access matrix', timeline: 'settimana 2' },
    { title: 'Integrazioni CRM/ERP', format: 'API/Webhook', timeline: 'settimana 3-5' },
    { title: 'Automazioni operative', format: 'Worker/jobs', timeline: 'settimana 4-5' },
    { title: 'Deploy CI/CD', format: 'GitHub Actions', timeline: 'pre-launch' },
    { title: 'Monitoring e log', format: 'Dashboard', timeline: 'pre-launch' },
    { title: 'Documentazione tecnica', format: '.md repo', timeline: 'post-launch' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'web-design', title: 'Web Design', shortPitch: 'Se l’app ha utenti reali, l’interfaccia deve tagliare passaggi, non decorarli.' },
    { slug: 'seo', title: 'SEO & Visibilità', shortPitch: 'Le app pubbliche devono essere leggibili anche da Google, non solo dagli utenti loggati.' },
    { slug: 'manutenzione-siti', title: 'Manutenzione siti', shortPitch: 'Dopo il deploy servono log, backup e responsabilità tecnica continuativa.' },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 15 minuti',
    title: "Quanto costa un'integrazione fragile?",
    body: 'Mappiamo un flusso reale: dati, passaggi manuali, tool coinvolti e punto di rottura. 15 minuti su Meet, nessun documento inutile.',
  } satisfies ServiceLeadMagnetCopy,
} as const;
