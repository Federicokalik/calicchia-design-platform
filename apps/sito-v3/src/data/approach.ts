export interface ApproachClaim {
  title: string;
  description: string;
  /** Phosphor icon class (e.g. "ph-crosshair") */
  phosphorIcon: string;
}

export const APPROACH: ApproachClaim[] = [
  {
    title: 'Ossessione per i dettagli',
    description:
      'Non mi accontento del "va bene così".\nOgni pixel, ogni riga di codice, ogni interazione — tutto è pensato per essere impeccabile.\nLa differenza la fanno i dettagli che gli altri ignorano.',
    phosphorIcon: 'ph-crosshair'
  },
  {
    title: 'Sempre un passo avanti',
    description:
      'Il web cambia ogni giorno.\nStudio, sperimento e applico le tecnologie più recenti prima che diventino mainstream.\nIl tuo progetto non nasce già vecchio.',
    phosphorIcon: 'ph-rocket-launch'
  },
  {
    title: 'Competenze trasversali',
    description:
      'Design, sviluppo, SEO, branding: non devo delegare niente.\nQuesto significa più coerenza, meno errori di comunicazione e un risultato finale che tiene tutto insieme.',
    phosphorIcon: 'ph-circles-three-plus'
  },
  {
    title: 'Tutto in un unico punto',
    description:
      'Non devi coordinare designer, sviluppatore e consulente SEO.\nParlo con te, capisco cosa ti serve e me ne occupo io. Punto.',
    phosphorIcon: 'ph-user-focus'
  },
  {
    title: 'Risultati, non promesse',
    description:
      'Non ti vendo "visibilità" o "engagement".\nTi mostro numeri reali: più contatti, più vendite, più crescita. È l\'unica metrica che conta.',
    phosphorIcon: 'ph-chart-line-up'
  }
];

// ─── EN translations (Round 5b, 2026-05-08) ─────────────────────────
// Anti-marketing voice preserved. Phosphor icons identical.
export const APPROACH_EN: ApproachClaim[] = [
  {
    title: 'Obsession with details',
    description:
      "I do not settle for \"good enough\".\nEvery pixel, every line of code, every interaction — all built to be impeccable.\nFocusing on the details that others ignore.",
    phosphorIcon: 'ph-crosshair'
  },
  {
    title: 'Always one step ahead',
    description:
      "The web changes every day.\nI study, experiment and apply recent technologies before they go mainstream.\nYour project is not born already old.",
    phosphorIcon: 'ph-rocket-launch'
  },
  {
    title: 'Cross-disciplinary skills',
    description:
      "Design, development, SEO, branding: I do not have to delegate.\nThat means more consistency, fewer miscommunications, and a final result that holds together.",
    phosphorIcon: 'ph-circles-three-plus'
  },
  {
    title: 'One single point of contact',
    description:
      "You do not coordinate a designer, a developer and an SEO consultant.\nI talk to you, I understand what you need, and I handle it. Period.",
    phosphorIcon: 'ph-user-focus'
  },
  {
    title: 'Results, not promises',
    description:
      "I do not sell you \"visibility\" or \"engagement\".\nI show you real numbers: more leads, more sales, more growth. It is the only metric that matters.",
    phosphorIcon: 'ph-chart-line-up'
  }
];

import type { Locale } from '@/lib/i18n';

/** Locale-aware getter for /perche-scegliere-me approach pillars. */
export function getApproach(locale: Locale = 'it'): ApproachClaim[] {
  return locale === 'en' ? APPROACH_EN : APPROACH;
}
