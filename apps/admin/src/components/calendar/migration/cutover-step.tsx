/**
 * Passo 6 del wizard di migrazione: passaggio a Radicale (design §13.10,
 * §13.13; contratto f3-modules §2.3 e §11.3).
 *
 * In F3 è sempre disabilitato: Postgres resta autorevole fino alla conferma
 * del passaggio, che arriva con la fase F4 (cutover, finestra di rollback,
 * proiezione inversa). Qui si vedono i criteri e la frase di conferma che
 * servirà, senza poterla usare.
 */

import { CheckCircle2, Circle, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { findAction, MIGRATION_CONFIRMATIONS, type MigrationStateView, type WizardStepView } from '@/lib/calendar-migration-api';
import { Section, StepStatusBadge } from './shared';

interface Props {
  state: MigrationStateView;
  step: WizardStepView;
}

export function CutoverStep({ state, step }: Props) {
  const cutover = state.cutover;
  const action = findAction(step, 'cutover');
  const met = cutover.criteria.filter((c) => c.ok).length;
  return (
    <div className="space-y-4">
      <Section title="Passaggio a Radicale" description={step.summary} actions={<StepStatusBadge status={step.status} />}>
        <div className="flex items-start gap-2 rounded-md border border-dashed bg-muted/30 p-3 text-xs">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium">Disponibile dalla fase {cutover.phase}</p>
            <p className="text-muted-foreground">{cutover.reason}</p>
            <p className="text-muted-foreground">
              Con la F4 il passaggio congelerà per pochi secondi le scritture del calendario, farà un'ultima sincronizzazione e renderà Radicale autorevole,
              con una finestra di rollback ("Torna a Postgres") in cui ogni modifica viene riportata anche in Postgres.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Criteri del passaggio" description={`${met} di ${cutover.criteria.length} soddisfatti (informativi in questa fase).`}>
        <ul className="divide-y rounded-md border">
          {cutover.criteria.map((c) => (
            <li key={c.id} className="flex items-start gap-2 p-2.5">
              {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0">
                <p className="text-xs font-medium">{c.label}</p>
                {c.detail && <p className="text-[11px] text-muted-foreground">{c.detail}</p>}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Conferma" description="La frase e il pulsante sono qui solo come anteprima: in F3 restano disattivati.">
        <div className="space-y-2 max-w-md">
          <Label htmlFor="cutover-phrase" className="text-xs">Per confermare si dovrà digitare <span className="font-mono font-semibold">{action?.confirm ?? MIGRATION_CONFIRMATIONS.cutover}</span></Label>
          <Input id="cutover-phrase" disabled placeholder={action?.confirm ?? MIGRATION_CONFIRMATIONS.cutover} />
          <Button size="sm" variant="destructive" disabled title={action?.reason ?? undefined}>Passa a Radicale</Button>
          {action?.reason && <p className="text-[11px] text-muted-foreground">{action.reason}</p>}
        </div>
      </Section>
    </div>
  );
}
