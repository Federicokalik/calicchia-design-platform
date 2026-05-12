import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const WORDPRESS_MIGRAZIONE_EXTRAS = {
  deliverables: [
    { title: 'Pre-migration audit', format: 'PDF report', timeline: 'settimana 1' },
    { title: 'Mapping URL e redirect', format: '.xlsx', timeline: 'settimana 1' },
    { title: 'Copia DB e files', format: 'Staging copy', timeline: 'settimana 1' },
    { title: 'Test staging', format: 'Checklist', timeline: 'settimana 1-2' },
    { title: 'Setup hosting nuovo', format: 'Server config', timeline: 'settimana 2' },
    { title: 'Switch DNS controllato', format: 'DNS log', timeline: 'go-live' },
    { title: 'Check post-migrazione', format: 'Checklist', timeline: 'go-live' },
    { title: 'Performance baseline', format: 'Lighthouse report', timeline: 'post-launch' },
    { title: 'Log monitoring 7 giorni', format: 'Log review', timeline: 'post-launch' },
    { title: 'Documentazione accessi', format: '.md', timeline: 'post-launch' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'manutenzione-siti', title: 'Manutenzione siti', shortPitch: 'Dopo il cambio DNS servono backup, alert e update controllati.' },
    { slug: 'assistenza-wordpress', title: 'Assistenza WordPress', shortPitch: 'Se la migrazione scopre malware o plugin rotti, prima si chiude la falla.' },
    { slug: 'web-design', title: 'Web Design', shortPitch: 'Se il sito resta vecchio anche sul nuovo host, il problema è solo spostato.' },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 15 minuti',
    title: 'Migrazione fatta male = SEO bruciata?',
    body: 'Controllo hosting, DNS, redirect, media e rischi SEO prima del cambio. 15 minuti su Meet, niente salto nel buio.',
  } satisfies ServiceLeadMagnetCopy,
} as const;
