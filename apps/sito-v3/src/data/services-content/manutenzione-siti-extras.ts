import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const MANUTENZIONE_SITI_EXTRAS = {
  deliverables: [
    { title: 'Setup backup giornaliero', format: 'Backup job', timeline: 'settimana 1' },
    { title: 'Test ripristino backup', format: 'Checklist', timeline: 'settimana 1' },
    { title: 'Monitoring uptime', format: 'Alert dashboard', timeline: 'settimana 1' },
    { title: 'Update pianificati', format: 'Maintenance log', timeline: 'mensile' },
    { title: 'Security hardening base', format: 'Config report', timeline: 'settimana 1-2' },
    { title: 'Log accessi e errori', format: 'Log review', timeline: 'mensile' },
    { title: 'Report tecnico mensile', format: 'PDF report', timeline: 'mensile' },
    { title: 'Intervento emergency', format: 'Ticket + log', timeline: 'on-demand' },
    { title: 'Rollback testato', format: 'Restore note', timeline: 'post-update' },
    { title: 'Controllo rinnovi critici', format: 'Scadenziario', timeline: 'ongoing' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'assistenza-wordpress', title: 'Assistenza WordPress', shortPitch: 'Se WordPress è già lento, bucato o rotto, prima si ripara e poi si presidia.' },
    { slug: 'sviluppo-web', title: 'Sviluppo Web', shortPitch: 'Web app e dashboard hanno bisogno di monitoraggio, log e backup veri.' },
    { slug: 'seo', title: 'SEO & Visibilità', shortPitch: 'Downtime, errori server e redirect rotti mangiano traffico organico senza chiedere permesso.' },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 15 minuti',
    title: 'Quando è stato l’ultimo backup testato?',
    body: 'Controllo backup, update, uptime, SSL e punti fragili. 15 minuti su Meet, senza pacchetto manutenzione spinto a forza.',
  } satisfies ServiceLeadMagnetCopy,
} as const;
