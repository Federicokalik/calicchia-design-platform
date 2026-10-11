/**
 * Passo 3 del wizard di migrazione: apply (design §13.6; contratto
 * f3-modules §4.3, §7.2 e §11).
 *
 * L'apply ricalcola il piano dell'anteprima e si ferma prima di scrivere se è
 * cambiato (PLAN_CHANGED); ogni scrittura passa da una riga d'intento nel
 * ledger, quindi un'interruzione o un crash si riprendono senza duplicati. I
 * conflitti non si sovrascrivono mai, salvo "forza" esplicito per item o per
 * codice. Criterio di uscita: una seconda esecuzione a zero scritture.
 */

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Play, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  CONFLICT_LABELS,
  findAction,
  isRunActive,
  FORCEABLE_CONFLICTS,
  formatAgo,
  formatDuration,
  MIGRATION_CONFIRMATIONS,
  migrationApi,
  migrationErrorMessage,
  OUTCOME_LABELS,
  shortHash,
  type ApplyOutcome,
  type ApplySummary,
  type ConflictCode,
  type MigrationItemView,
  type MigrationStateView,
  type PlanSummary,
  type WizardStepView,
} from '@/lib/calendar-migration-api';
import { ActionButton, ActionReason, BlockingList, ConfirmPhraseDialog, DownloadReportButtons, RunItemsTable, RunPanel, Section, Stat, StepStatusBadge } from './shared';
import { useCalendarNames, useRun, useRunMutation } from './hooks';

interface Props {
  state: MigrationStateView;
  step: WizardStepView;
}

const OUTCOMES: ApplyOutcome[] = ['done', 'forced', 'adopted', 'noop', 'skipped', 'conflict', 'failed'];

export function ApplyStep({ state, step }: Props) {
  const previewStep = state.wizard.steps.find((s) => s.id === 'anteprima');
  const planCandidate = previewStep?.last_run_id && previewStep.last_run_id !== state.active_run?.id ? previewStep.last_run_id : null;
  // Anteprima di riferimento: l'ultima conclusa (resta quella di prima mentre ne gira una nuova).
  // Aggiornata durante il render e non in un effetto: nessun render con lo stato nuovo e
  // l'anteprima vecchia, in cui "Applica" partirebbe con il piano superato (PLAN_CHANGED).
  const [planId, setPlanId] = useState<string | null>(planCandidate);
  if (planCandidate && planCandidate !== planId) setPlanId(planCandidate);
  const plan = useRun<PlanSummary>(planId);
  const planSummary = plan.data?.status === 'succeeded' && plan.data.kind === 'plan' ? plan.data.summary : null;
  // "Nuova anteprima" appena chiesta: finché non è conclusa (e lo stato non la mostra) l'apply resta
  // fermo, anche nell'istante prima che lo stato rilegga il run in corso.
  const [awaitedPlanId, setAwaitedPlanId] = useState<string | null>(null);
  const lastPlanRun = state.last_runs.plan ?? null;
  const awaitedSettled = awaitedPlanId !== null && lastPlanRun?.id === awaitedPlanId && !isRunActive(lastPlanRun);
  const waitingForPlan = awaitedPlanId !== null && planId !== awaitedPlanId && !awaitedSettled;

  const applyCandidate = step.last_run_id && step.last_run_id !== state.active_run?.id ? step.last_run_id : null;
  const [applyId, setApplyId] = useState<string | null>(applyCandidate);
  useEffect(() => {
    if (applyCandidate) setApplyId(applyCandidate);
  }, [applyCandidate]);
  const apply = useRun<ApplySummary>(applyId);
  const applySummary = apply.data?.status === 'succeeded' ? apply.data.summary : null;
  const calendarNames = useCalendarNames(state);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [forceCodes, setForceCodes] = useState<Set<ConflictCode>>(new Set());
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<ApplyOutcome | 'all'>('all');
  // Le selezioni di "forza" valgono per un'anteprima: si azzerano quando cambia.
  useEffect(() => {
    setSelected(new Set());
    setForceCodes(new Set());
  }, [planId]);

  const run = useRunMutation(
    (vars: { confirm: string; confirm_force: string | null }, key) => migrationApi.apply({
      plan_run_id: planId as string,
      expect_plan_hash: planSummary?.plan_hash ?? null,
      force_item_ids: [...selected],
      force_codes: [...forceCodes],
      confirm: vars.confirm,
      ...(vars.confirm_force ? { confirm_force: vars.confirm_force } : {}),
    }, key),
    { success: 'Apply avviato', onCreated: () => setOpen(false) },
  );
  const replan = useRunMutation((_: void, key) => migrationApi.plan({ options: planSummary?.options, scope: planSummary?.scope }, key), {
    success: 'Nuova anteprima avviata: al termine applica di nuovo per verificare zero scritture',
    onCreated: (res) => setAwaitedPlanId(res.run.id),
  });

  const forcing = selected.size > 0 || forceCodes.size > 0;
  const planConflicts = planSummary ? Object.entries(planSummary.conflicts).filter(([, n]) => (n ?? 0) > 0) as Array<[ConflictCode, number]> : [];
  const forceableItem = (item: MigrationItemView) => item.action === 'conflict' && !!item.code && (FORCEABLE_CONFLICTS as readonly string[]).includes(item.code);
  const latestApply = state.last_runs.apply ?? null;
  const planAge = plan.data?.finished_at ? formatAgo(plan.data.finished_at) : null;
  const applyTotals = applySummary?.totals;

  const perCalendar = useMemo(() => applySummary?.calendars ?? [], [applySummary]);

  return (
    <div className="space-y-4">
      <Section title="Applica" description={step.summary} actions={<StepStatusBadge status={step.status} />}>
        <BlockingList items={step.blocking} />
        {planSummary && plan.data ? (
          <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
            <p>
              Anteprima di riferimento generata {planAge} · hash <span className="font-mono">{shortHash(planSummary.plan_hash)}</span>
            </p>
            <p className="text-muted-foreground">
              {planSummary.writes} scritture previste ({planSummary.totals.create} create, {planSummary.totals.update} aggiornamenti, {planSummary.totals.delete} eliminazioni),
              {' '}{planSummary.totals.conflict} conflitti · stima {formatDuration(planSummary.estimate_seconds * 1000)}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Genera prima un'anteprima al passo 2.</p>
        )}

        {planConflicts.length > 0 && (
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-xs font-medium">Forza per codice</p>
            <p className="text-[11px] text-muted-foreground">I conflitti non si sovrascrivono mai da soli. Forzare scrive il contenuto del piano sopra quello della destinazione: fallo solo se sai perché la destinazione è diversa.</p>
            <div className="flex flex-wrap gap-3">
              {planConflicts.map(([code, n]) => {
                const forceable = FORCEABLE_CONFLICTS.includes(code);
                return (
                  <label key={code} className={cn('flex items-center gap-2 text-xs', !forceable && 'text-muted-foreground')}>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      disabled={!forceable}
                      checked={forceCodes.has(code)}
                      onChange={(e) => {
                        const next = new Set(forceCodes);
                        if (e.target.checked) next.add(code); else next.delete(code);
                        setForceCodes(next);
                      }}
                    />
                    {CONFLICT_LABELS[code] ?? code} ({n}){!forceable && ' — non forzabile'}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <ActionButton action={findAction(step, 'apply')} disabled={!planSummary || waitingForPlan} onClick={() => setOpen(true)}>
            <Play className="h-3.5 w-3.5" /> Applica{forcing ? ` (forza ${selected.size + forceCodes.size})` : ''}
          </ActionButton>
          <Button
            size="sm"
            variant="outline"
            disabled={!planSummary || !!state.active_run || replan.isPending}
            onClick={() => replan.mutate()}
            title="Per ripetere l'apply serve un'anteprima nuova: quella vecchia contiene le scritture già fatte"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Nuova anteprima con le stesse opzioni
          </Button>
          {applySummary?.zero_writes && (
            <Badge variant="outline" className="gap-1 text-[11px] text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Zero scritture: apply idempotente</Badge>
          )}
        </div>
        <ActionReason action={findAction(step, 'apply')} />
        {latestApply && latestApply.id !== state.active_run?.id && latestApply.status !== 'succeeded' && <RunPanel run={latestApply} compact />}
        {latestApply?.error?.code === 'PLAN_CHANGED' && latestApply.id !== state.active_run?.id && (
          <p className="text-xs text-amber-600">Il piano è cambiato dall'anteprima (nuove scritture in Postgres o un apply già fatto): genera una nuova anteprima e applica di nuovo.</p>
        )}
      </Section>

      {applySummary && apply.data && applyTotals && (
        <Section
          title="Ultimo apply"
          description={`Concluso ${formatAgo(apply.data.finished_at)} · durata ${formatDuration(applySummary.duration_ms)}${apply.data.attempts > 1 ? ` · ripreso ${apply.data.attempts - 1} volte` : ''}`}
          actions={<DownloadReportButtons runId={apply.data.id} />}
        >
          <div className="flex flex-wrap gap-2">
            <Stat label="Scritte" value={applySummary.writes.create + applySummary.writes.update + applySummary.writes.delete} hint={`${applySummary.writes.create} create · ${applySummary.writes.update} agg. · ${applySummary.writes.delete} elim.`} />
            <Stat label="Adottati" value={applySummary.adopted} />
            <Stat label="Invariati" value={applyTotals.noop} />
            <Stat label="Saltati" value={applyTotals.skipped} />
            <Stat label="Forzati" value={applySummary.forced} tone={applySummary.forced ? 'warn' : undefined} />
            <Stat label="Conflitti" value={applyTotals.conflict} tone={applyTotals.conflict ? 'bad' : 'ok'} />
            <Stat label="Falliti" value={applySummary.failed} tone={applySummary.failed ? 'bad' : 'ok'} />
          </div>
          {Object.entries(applySummary.conflicts).some(([, n]) => (n ?? 0) > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(applySummary.conflicts).filter(([, n]) => (n ?? 0) > 0).map(([code, n]) => (
                <Badge key={code} variant="outline" className="text-[10px] text-amber-700">{CONFLICT_LABELS[code] ?? code}: {n}</Badge>
              ))}
            </div>
          )}
          {perCalendar.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-2 py-1.5">Calendario</th>
                    {OUTCOMES.map((o) => <th key={o} className="px-2 py-1.5 text-right">{OUTCOME_LABELS[o]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {perCalendar.map((c) => (
                    <tr key={c.calendar_id} className="border-t">
                      <td className="px-2 py-1.5">{calendarNames[c.calendar_id] ?? c.collection_name}</td>
                      {OUTCOMES.map((o) => (
                        <td key={o} className={cn('px-2 py-1.5 text-right tabular-nums', (o === 'conflict' || o === 'failed') && c.totals[o] > 0 && 'text-red-600 font-medium')}>{c.totals[o] || ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <p className="text-xs font-medium">Righe dell'apply</p>
            <select className="h-8 rounded-md border bg-background px-2 text-xs" value={outcome} onChange={(e) => setOutcome(e.target.value as ApplyOutcome | 'all')}>
              <option value="all">Tutti gli esiti</option>
              {OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
            </select>
          </div>
          <RunItemsTable key={`${apply.data.id}-${outcome}`} runId={apply.data.id} filter={{ item_type: 'object', ...(outcome === 'all' ? {} : { outcome }) }} calendarNames={calendarNames} />
        </Section>
      )}

      {planId && planSummary && planSummary.totals.conflict > 0 && (
        <Section title="Conflitti dell'anteprima" description="Spunta i singoli conflitti da forzare al prossimo apply.">
          <RunItemsTable
            key={`conflicts-${planId}`}
            runId={planId}
            filter={{ item_type: 'object', action: 'conflict' }}
            calendarNames={calendarNames}
            selectable={forceableItem}
            selected={selected}
            onToggle={(item) => {
              const next = new Set(selected);
              if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
              setSelected(next);
            }}
          />
        </Section>
      )}

      <ConfirmPhraseDialog
        open={open}
        onOpenChange={setOpen}
        title="Applica il piano a Radicale"
        phrase={MIGRATION_CONFIRMATIONS.apply}
        confirmLabel="Applica"
        destructive={forcing}
        pending={run.isPending}
        error={run.isError ? migrationErrorMessage(run.error) : null}
        extraPhrase={forcing ? { phrase: MIGRATION_CONFIRMATIONS.force, label: `Stai forzando ${selected.size} conflitti e ${forceCodes.size} codici: digita` } : null}
        disabled={!planSummary || waitingForPlan}
        onConfirm={({ phrase, extra }) => run.mutate({ confirm: phrase, confirm_force: extra })}
        description={
          <>
            <p>Scrive su Radicale gli oggetti dell'anteprima ({planSummary?.writes ?? 0} scritture previste). Postgres non cambia e resta autorevole; i device restano in sola lettura.</p>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>Se il piano è cambiato dall'anteprima l'apply si ferma prima di scrivere.</li>
              <li>Ogni scrittura usa If-Match o If-None-Match: niente viene sovrascritto alla cieca.</li>
              <li>Puoi interromperlo: riprende dal ledger senza duplicati.</li>
            </ul>
          </>
        }
      />
    </div>
  );
}
