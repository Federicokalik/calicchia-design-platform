import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const ANALYTICS_SETUP_EXTRAS = {
  deliverables: [
    { title: 'Audit setup GA4 + GTM esistente', format: 'Report markdown', timeline: 'settimana 1' },
    { title: 'Mappa eventi business-driven', format: 'Spreadsheet condiviso', timeline: 'settimana 1' },
    { title: 'GA4 property pulito + filtri', format: 'Configurazione', timeline: 'settimana 1' },
    { title: 'GTM container ordinato (folder + naming)', format: 'Configurazione', timeline: 'settimana 1-2' },
    { title: 'Eventi e-commerce / lead form / content', format: 'Tag + trigger GTM', timeline: 'settimana 2' },
    { title: 'Consent Mode v2 + banner integration', format: 'Tag + script', timeline: 'settimana 2' },
    { title: 'Google Ads conversion + Meta CAPI (opzionale)', format: 'Tag GTM + server-side', timeline: 'settimana 2-3' },
    { title: 'Dashboard Looker Studio personalizzata', format: 'Dashboard condivisa', timeline: 'settimana 3' },
    { title: 'Documentazione eventi + variabili', format: 'Spreadsheet', timeline: 'pre-handoff' },
    { title: 'Sessione handoff (30 min)', format: 'Meet + recording', timeline: 'post-launch' }
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'seo', title: 'SEO & Visibilità', shortPitch: 'Senza analytics non sai quale keyword converte. Senza SEO non hai traffico da analizzare. Vanno insieme.' },
    { slug: 'performance-cwv', title: 'Performance & CWV', shortPitch: 'Performance e analytics si misurano insieme: un sito lento perde conversioni e i dati lo dimostrano.' },
    { slug: 'e-commerce', title: 'E-Commerce', shortPitch: 'Senza eventi e-commerce tracciati correttamente, ottimizzare un negozio online è puro sentimento.' }
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 20 minuti',
    title: 'Il tuo GA4 traccia davvero quello che ti serve?',
    body: 'Guardo il tuo setup GA4 + GTM (anche solo i nomi degli eventi via GTM Preview) e ti mando una mini-analisi: cosa è rotto, cosa manca, le 3 priorità di fix. Niente sales pitch.'
  } satisfies ServiceLeadMagnetCopy
} as const;
