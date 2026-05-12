import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../services-detail';

export const ACCESSIBILITY_WCAG_EXTRAS = {
  deliverables: [
    { title: 'Audit automatico (axe + WAVE + Lighthouse)', format: 'PDF report + JSON', timeline: 'settimana 1' },
    { title: 'Audit manuale screen reader (NVDA + VoiceOver)', format: 'Video walkthrough + report', timeline: 'settimana 1' },
    { title: 'Mappa violazioni per Level (A/AA/AAA)', format: 'Notion / spreadsheet', timeline: 'settimana 1' },
    { title: 'Remediation Level A (blocking)', format: 'Codice', timeline: 'settimana 2' },
    { title: 'Remediation Level AA (mandatory EAA)', format: 'Codice', timeline: 'settimana 2-3' },
    { title: 'Contrast + color fix', format: 'Design tokens + codice', timeline: 'settimana 3' },
    { title: 'Form errors + ARIA validation', format: 'Codice', timeline: 'settimana 3' },
    { title: 'Re-audit + verifica', format: 'PDF before/after', timeline: 'settimana 3-4' },
    { title: 'Accessibility statement', format: 'HTML/MD pubblicabile', timeline: 'pre-handoff' },
    { title: 'Checklist operativa per redazione contenuti', format: 'Markdown', timeline: 'pre-handoff' }
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'web-design', title: 'Web Design', shortPitch: 'Un sito accessibile nasce dal design, non dal patch finale. Componenti pensati per tastiera + screen reader fin dal wireframe.' },
    { slug: 'sviluppo-web', title: 'Sviluppo Web', shortPitch: 'Componenti React/Next con semantica corretta, ARIA dove serve, focus management built-in.' },
    { slug: 'manutenzione-siti', title: 'Manutenzione siti', shortPitch: 'Re-audit trimestrale per intercettare regressioni prima che arrivino sanzioni o segnalazioni.' }
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Audit gratuito · 30 minuti',
    title: 'Il tuo sito è conforme all\'European Accessibility Act?',
    body: 'Faccio uno scan automatico + 10 minuti di test manuale con screen reader sulle 3 page più critiche. Ti mando un mini-report con le violazioni Level A che bloccano il sito agli utenti con disabilità. Niente compliance-washing.'
  } satisfies ServiceLeadMagnetCopy
} as const;
