// Contact form multi-step options: services matrix, sectors, skip logic

export interface ServiceOption {
  value: string;
  label: string;
}

export interface ServiceCategory {
  slug: string;
  label: string;
  subOptions: ServiceOption[];
}

// ─── Matrice servizi con sotto-opzioni ───────────────────────────────

export const SERVICE_CATEGORIES: ServiceCategory[] = [
  {
    slug: 'web-design',
    label: 'Web Design',
    subOptions: [
      { value: 'Sito One Page', label: 'Sito One Page' },
      { value: 'Sito Multipagina', label: 'Sito Multipagina' },
      { value: 'Sito Multipagina + Blog', label: 'Sito Multipagina + Blog' },
    ],
  },
  {
    slug: 'e-commerce',
    label: 'E-Commerce',
    subOptions: [
      { value: 'E-Commerce Completo (WooCommerce)', label: 'E-Commerce Completo (WooCommerce)' },
      { value: 'E-Commerce + Corso gestione', label: 'E-Commerce + Corso gestione' },
      { value: 'Migrazione e-commerce esistente', label: 'Migrazione e-commerce esistente' },
    ],
  },
  {
    slug: 'sviluppo-web',
    label: 'Sviluppo Web',
    subOptions: [
      { value: 'Portale aziendale / Area riservata', label: 'Portale aziendale / Area riservata' },
      { value: 'Dashboard operativa', label: 'Dashboard operativa' },
      { value: 'Integrazioni CRM/ERP/API', label: 'Integrazioni CRM/ERP/API' },
      { value: 'Web App custom', label: 'Web App custom' },
      { value: 'Automazioni / Chatbot AI', label: 'Automazioni / Chatbot AI' },
    ],
  },
  {
    slug: 'seo',
    label: 'SEO & Posizionamento',
    subOptions: [
      { value: 'SEO Base (audit + ottimizzazione)', label: 'SEO Base (audit + ottimizzazione)' },
      { value: 'SEO Premium (+ link building + contenuti)', label: 'SEO Premium (+ link building + contenuti)' },
      { value: 'Ottimizzazione SEO una tantum', label: 'Ottimizzazione SEO una tantum' },
    ],
  },
  {
    slug: 'manutenzione-siti',
    label: 'Manutenzione siti',
    subOptions: [
      { value: 'Piano Base', label: 'Piano Base' },
      { value: 'Piano Standard', label: 'Piano Standard' },
      { value: 'Piano Premium', label: 'Piano Premium' },
    ],
  },
  {
    slug: 'assistenza-wordpress',
    label: 'Assistenza WordPress',
    subOptions: [
      { value: 'Pulizia malware / Recovery', label: 'Pulizia malware / Recovery' },
      { value: 'Security hardening', label: 'Security hardening' },
      { value: 'Risoluzione conflitti plugin', label: 'Risoluzione conflitti plugin' },
      { value: 'Performance tuning', label: 'Performance tuning' },
    ],
  },
  {
    slug: 'wordpress-migrazione',
    label: 'Migrazione & Hosting WordPress',
    subOptions: [
      { value: 'Migrazione zero-downtime', label: 'Migrazione zero-downtime' },
      { value: 'Setup nuovo hosting WP', label: 'Setup nuovo hosting WP' },
      { value: 'Migrazione DNS / SSL', label: 'Migrazione DNS / SSL' },
    ],
  },
];

// ─── Settori ───────────────────────────────

export const SECTORS: ServiceOption[] = [
  { value: 'Agricolo', label: 'Agricolo' },
  { value: 'Automobilistico', label: 'Automobilistico' },
  { value: 'Alimentare', label: 'Alimentare' },
  { value: 'Casa ? Arredamento', label: 'Casa ? Arredamento' },
  { value: 'Commercio al dettaglio', label: 'Commercio al dettaglio' },
  { value: 'Commercio all\'ingrosso', label: 'Commercio all\'ingrosso' },
  { value: 'Sim-Racing', label: 'Sim-Racing' },
  { value: 'E-sports', label: 'E-sports' },
  { value: 'Editoriale', label: 'Editoriale' },
  { value: 'Edilizia', label: 'Edilizia' },
  { value: 'Elettronico', label: 'Elettronico' },
  { value: 'Hotel ? B&B', label: 'Hotel ? B&B' },
  { value: 'Immobiliare', label: 'Immobiliare' },
  { value: 'Motorsport', label: 'Motorsport' },
  { value: 'Modellismo', label: 'Modellismo' },
  { value: 'Sport', label: 'Sport' },
  { value: 'Salute ? Benessere', label: 'Salute ? Benessere' },
  { value: 'Turismo', label: 'Turismo' },
  { value: 'Altro', label: 'Altro' },
];

// ─── Context types ───────────────────────────────

export type FormContext = {
  /** Which page the form is on */
  type: 'generic' | 'service' | 'seo';
  /** Service slug if on a service page */
  service?: string;
  /** Profession label if on a SEO landing page */
  profession?: string;
  /** City name if on a SEO landing page */
  city?: string;
};

// ─── Helper functions ───────────────────────────────

/**
 * Get service options based on context.
 * - Generic: returns macro categories (just the label)
 * - Service page: returns sub-options for that service
 * - SEO page: returns nothing (service is implicit)
 */
export function getServiceOptions(context: FormContext): ServiceOption[] {
  if (context.type === 'seo') return [];

  if (context.type === 'service' && context.service) {
    const category = SERVICE_CATEGORIES.find(c => c.slug === context.service);
    if (category) return category.subOptions;
  }

  // Generic: return macro categories + "Altro"
  return [
    ...SERVICE_CATEGORIES.map(c => ({ value: c.label, label: c.label })),
    { value: 'Altro', label: 'Altro' },
  ];
}

/**
 * Steps visible for a given context
 */
export type StepId =
  | 'welcome' | 'gdpr' | 'name' | 'email' | 'company'
  | 'phone-ask' | 'phone' | 'services' | 'sectors'
  | 'message' | 'meet' | 'pick-slot' | 'thanks';

export function getVisibleSteps(context: FormContext, wantsPhone: boolean, wantsMeet: boolean): StepId[] {
  const steps: StepId[] = ['welcome', 'gdpr', 'name', 'email', 'company', 'phone-ask'];

  if (wantsPhone) steps.push('phone');

  // Services step: only for generic and service contexts
  if (context.type !== 'seo') steps.push('services');

  // Sectors: only for generic and single service pages (not SEO — profession is implicit)
  if (context.type === 'generic' || context.type === 'service') steps.push('sectors');

  steps.push('message');

  // Booking slot picker only if user wants a call
  if (wantsPhone) steps.push('pick-slot');

  steps.push('thanks');
  return steps;
}
