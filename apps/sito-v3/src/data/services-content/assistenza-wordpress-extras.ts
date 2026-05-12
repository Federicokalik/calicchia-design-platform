import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const ASSISTENZA_WORDPRESS_EXTRAS = {
  deliverables: [
    { title: 'Hardening admin WordPress', format: 'Config report', timeline: 'giorno 1' },
    { title: 'Plugin audit', format: 'PDF report', timeline: 'giorno 1' },
    { title: 'Malware cleanup se serve', format: 'Fix log', timeline: 'on-demand' },
    { title: 'Backup configurati', format: 'Backup job', timeline: 'giorno 1-2' },
    { title: 'WAF e firewall', format: 'Security config', timeline: 'giorno 2' },
    { title: 'Performance audit', format: 'Lighthouse + log', timeline: 'giorno 2' },
    { title: 'Recovery plan', format: '.md', timeline: 'post-fix' },
    { title: 'Permessi file corretti', format: 'Server config', timeline: 'post-fix' },
    { title: 'Report intervento', format: 'PDF report', timeline: 'post-fix' },
    { title: 'Training basico gestione', format: 'Meet + .md', timeline: 'post-fix' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'manutenzione-siti', title: 'Manutenzione siti', shortPitch: 'Dopo la riparazione serve presidio, altrimenti WordPress torna nel caos.' },
    { slug: 'wordpress-migrazione', title: 'Migrazione & Hosting WordPress', shortPitch: 'Se l’hosting è il collo di bottiglia, pulire plugin non basta.' },
    { slug: 'web-design', title: 'Web Design', shortPitch: 'Quando il sito è irrecuperabile, conviene rifare struttura e base tecnica.' },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 15 minuti',
    title: 'Il tuo WordPress è bucato?',
    body: 'Guardo plugin, admin, redirect, backup e segnali di compromissione. 15 minuti su Meet, diagnosi prima del panico.',
  } satisfies ServiceLeadMagnetCopy,
} as const;
