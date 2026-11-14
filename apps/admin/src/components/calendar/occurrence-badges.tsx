import type { ComponentType } from 'react';
import { Lock, PauseCircle, ShieldAlert, Smartphone, Unlink } from 'lucide-react';
import type { CalV2OccurrenceBadge } from '@calicchia/shared';
import { cn } from '@/lib/utils';

interface BadgeMeta {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Spiegazione mostrata come tooltip e nel pannello laterale. */
  hint: string;
  /** Colore dell'icona sul chip dell'evento (leggibile sul colore del calendario). */
  tone: string;
}

/** Badge delle occorrenze v2 (contratto F6 §9.1.6): icona, etichetta e spiegazione in italiano. */
const OCCURRENCE_BADGE_META: Record<CalV2OccurrenceBadge, BadgeMeta> = {
  orphan: {
    icon: Unlink,
    label: 'Orfano',
    hint: 'Eccezione senza serie: l\'evento ricorrente a cui apparteneva non esiste più.',
    tone: 'text-amber-200',
  },
  quarantined: {
    icon: ShieldAlert,
    label: 'In quarantena',
    hint: 'Il testo dell\'evento non è interpretabile: si vede l\'ultima versione valida e non si può modificare.',
    tone: 'text-red-200',
  },
  hold: {
    icon: PauseCircle,
    label: 'In attesa',
    hint: 'La collezione è in attesa di una decisione (cancellazione di massa o ricostruzione): le scritture sono ferme.',
    tone: 'text-amber-200',
  },
  conservative: {
    icon: Lock,
    label: 'Blocco conservativo',
    hint: 'Il server non riesce a leggere l\'evento e, per sicurezza, lo considera occupato.',
    tone: 'text-sky-200',
  },
  new_from_device: {
    icon: Smartphone,
    label: 'Nuovo dal dispositivo',
    hint: 'Calendario creato da un dispositivo collegato: controllalo e dagli un nome nella pagina Calendari.',
    tone: 'text-emerald-200',
  },
};

/** Icone compatte per il chip dell'evento nella griglia (tooltip nativo). */
export function OccurrenceBadgeIcons({ badges, className, tone = 'chip' }: {
  badges: readonly CalV2OccurrenceBadge[];
  className?: string;
  /** `chip`: su sfondo colorato (icone chiare); `plain`: su sfondo neutro (eventi a puntino del mese). */
  tone?: 'chip' | 'plain';
}) {
  if (!badges.length) return null;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-0.5 align-middle', className)}>
      {badges.map((badge) => {
        const meta = OCCURRENCE_BADGE_META[badge];
        const Icon = meta.icon;
        return (
          <span
            key={badge}
            data-testid={`cal-occ-badge-${badge}`}
            title={`${meta.label}: ${meta.hint}`}
            role="img"
            aria-label={meta.label}
            className="inline-flex"
          >
            <Icon className={cn('h-3 w-3', tone === 'chip' ? meta.tone : 'text-muted-foreground')} />
          </span>
        );
      })}
    </span>
  );
}

/** Elenco esteso nel pannello laterale: icona, etichetta e spiegazione di ogni badge. */
export function OccurrenceBadgeList({ badges }: { badges: readonly CalV2OccurrenceBadge[] }) {
  if (!badges.length) return null;
  return (
    <ul className="space-y-1.5">
      {badges.map((badge) => {
        const meta = OCCURRENCE_BADGE_META[badge];
        const Icon = meta.icon;
        return (
          <li key={badge} data-testid={`cal-occ-badge-detail-${badge}`} className="flex items-start gap-2 text-[11px] text-muted-foreground">
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span><span className="font-medium text-foreground">{meta.label}.</span> {meta.hint}</span>
          </li>
        );
      })}
    </ul>
  );
}
