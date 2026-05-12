import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const E_COMMERCE_EXTRAS = {
  deliverables: [
    { title: 'Mappa catalogo e varianti', format: '.xlsx + .md', timeline: 'settimana 1' },
    { title: 'Setup negozio base', format: 'CMS config', timeline: 'settimana 1-2' },
    { title: 'Gateway pagamento configurati', format: 'Stripe/PayPal', timeline: 'settimana 2' },
    { title: 'Regole spedizione e tasse', format: 'Config + .md', timeline: 'settimana 2' },
    { title: 'Schede prodotto strutturate', format: 'CMS + CSV', timeline: 'settimana 2-3' },
    { title: 'Schema Product e Offer', format: 'JSON-LD', timeline: 'settimana 3' },
    { title: 'Feed Google Shopping', format: 'XML/CSV feed', timeline: 'settimana 3' },
    { title: 'Email transazionali', format: 'MJML/HTML', timeline: 'settimana 3' },
    { title: 'Dashboard ordini', format: 'Admin panel', timeline: 'pre-launch' },
    { title: 'Test checkout 12 scenari', format: 'Checklist', timeline: 'pre-launch' },
    { title: 'Formazione gestione catalogo', format: 'Meet + .md', timeline: 'post-launch' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'web-design', title: 'Web Design', shortPitch: 'Prima del carrello serve una struttura che faccia capire cosa vendi e perché.' },
    { slug: 'seo', title: 'SEO & Visibilità', shortPitch: 'Product schema, feed e categorie pulite decidono quanto il catalogo viene letto.' },
    { slug: 'sviluppo-web', title: 'Sviluppo Web', shortPitch: 'Quando magazzino, ERP e marketplace non parlano, serve integrazione vera.' },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 15 minuti',
    title: 'Quanti ordini perdi al checkout?',
    body: 'Controllo carrello, pagamenti, email e feed prodotto. 15 minuti su Meet, niente giro largo e niente preventivo prima dei problemi.',
  } satisfies ServiceLeadMagnetCopy,
} as const;
