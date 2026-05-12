import type { SiteConfig } from './types';

export const SITE: SiteConfig = {
  brand: 'Caldes',
  legalName: 'Calicchia Design',
  url: 'https://calicchia.design',
  description:
    'Web Designer & Developer Freelance a Frosinone, in Ciociaria.\nSiti, e-commerce, sviluppo, SEO, manutenzione e assistenza WordPress.\nLavoro in tutta Italia e all\'estero.',
  nav: [
    { label: 'Lavori', href: '/lavori' },
    { label: 'Servizi', href: '/servizi' },
    { label: 'Contatti', href: '/contatti' }
  ],
  social: [
    { label: 'Instagram', url: 'https://instagram.com/calicchia.design', icon: 'instagram-logo' },
    { label: 'LinkedIn', url: 'https://linkedin.com/in/federicocalicchia', icon: 'linkedin-logo' },
    { label: 'GitHub', url: 'https://github.com/Federicokalik/', icon: 'github-logo' },
    { label: 'Gitea', url: 'https://git.calicchia.design/', icon: 'git-branch' },
    { label: 'Facebook', url: 'https://facebook.com/calicchiadesign', icon: 'facebook-logo' },
    { label: 'Telegram', url: 'https://t.me/calicchiadesign', icon: 'telegram-logo' },
    { label: 'WhatsApp', url: 'https://wa.me/393517773467', icon: 'whatsapp-logo' },
    { label: 'Mastodon', url: 'https://mastodon.uno/@calicchiadesig', icon: 'mastodon-logo' }
  ],
  contact: {
    email: 'federico@calicchia.design',
    phone: '+39 351 777 3467',
    address: 'Via Scifelli 74, Ceccano 03023 FR',
    vat: 'P.IVA 03160480608',
    cal: '/prenota/consulenza-gratuita-30min'
  },
  experienceStartYear: 2016,
  geo: {
    lat: 41.60222783980282,
    lng: 13.353679588853057,
    city: 'Ceccano',
    province: 'FR',
    region: 'Lazio',
    country: 'IT',
    postalCode: '03023'
  }
};

export function getYearsOfExperience(now: Date = new Date()): number {
  return Math.max(0, now.getFullYear() - SITE.experienceStartYear);
}

/**
 * Hero "Disegno [SERVIZIO] per [PROFESSIONE]" Pentagram-style cycle.
 * The two slots cycle independently, producing combinatorial pairs that
 * communicate the service × audience matrix at a glance.
 */
export const SERVICES_TYPES = [
  'siti web',
  'e-commerce',
  'strategie SEO',
  'automazioni AI',
  'brand identity',
  'app gestionali'
] as const;

export const PROFESSIONI = [
  'avvocati',
  'ristoratori',
  'B&B',
  'studi dentistici',
  'commercialisti',
  'artigiani',
  'consulenti',
  'agenzie immobiliari'
] as const;

/**
 * Slug map for matrix pages — `/{service-slug}-per-{profession-slug}`.
 * Aligned with the legacy `/sito-web-per-[professione]` SEO pattern.
 */
export const SERVICE_SLUGS: Record<(typeof SERVICES_TYPES)[number], string> = {
  'siti web': 'sito-web',
  'e-commerce': 'e-commerce',
  'strategie SEO': 'seo',
  'automazioni AI': 'automazione-ai',
  'brand identity': 'branding',
  'app gestionali': 'gestionale'
};

export const PROFESSION_SLUGS: Record<(typeof PROFESSIONI)[number], string> = {
  avvocati: 'avvocati',
  ristoratori: 'ristoratori',
  'B&B': 'b-and-b',
  'studi dentistici': 'dentisti',
  commercialisti: 'commercialisti',
  artigiani: 'artigiani',
  consulenti: 'consulenti',
  'agenzie immobiliari': 'agenzie-immobiliari'
};

export function buildMatrixUrl(
  service: (typeof SERVICES_TYPES)[number],
  profession: (typeof PROFESSIONI)[number]
): string {
  return `/${SERVICE_SLUGS[service]}-per-${PROFESSION_SLUGS[profession]}`;
}
