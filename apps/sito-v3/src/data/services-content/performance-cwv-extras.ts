import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const PERFORMANCE_CWV_EXTRAS = {
  deliverables: [
    { title: 'Audit baseline 5-10 page', format: 'PDF report + JSON', timeline: 'settimana 1' },
    { title: 'Mappa bottleneck per metrica', format: 'Notion / Markdown', timeline: 'settimana 1' },
    { title: 'Image pipeline (AVIF/WebP + lazy)', format: 'Codice + script CI', timeline: 'settimana 2' },
    { title: 'Font loading ottimizzato', format: 'Codice + preload', timeline: 'settimana 2' },
    { title: 'JavaScript splitting + tree-shake', format: 'Bundle analyzer report', timeline: 'settimana 2-3' },
    { title: 'Layout shift fix (CLS)', format: 'Codice', timeline: 'settimana 3' },
    { title: 'INP optimization (yield + idle)', format: 'Codice', timeline: 'settimana 3' },
    { title: 'Re-audit + waterfall a confronto', format: 'PDF before/after', timeline: 'settimana 3-4' },
    { title: 'Checklist manutenzione', format: 'Markdown', timeline: 'pre-handoff' },
    { title: 'Setup monitoring continuo (opzionale)', format: 'PageSpeed API + alert', timeline: 'post-handoff' }
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'web-design', title: 'Web Design', shortPitch: 'Un sito veloce nasce dal design, non si rincorre dopo. Le performance entrano già in fase di wireframe.' },
    { slug: 'sviluppo-web', title: 'Sviluppo Web', shortPitch: 'Stack moderno, hydration intelligente, build pipeline tarata. Le performance non sono un layer applicato dopo.' },
    { slug: 'manutenzione-siti', title: 'Manutenzione siti', shortPitch: 'Monitoring continuo per intercettare regressioni prima che le veda Google.' }
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 20 minuti',
    title: 'Scopri se il tuo sito passa il check Core Web Vitals',
    body: 'Misuro LCP, CLS, INP sulle 3 page più importanti del tuo sito e ti mando un report con i 3 fix più impattanti. Niente sales pitch: solo numeri.'
  } satisfies ServiceLeadMagnetCopy
} as const;
