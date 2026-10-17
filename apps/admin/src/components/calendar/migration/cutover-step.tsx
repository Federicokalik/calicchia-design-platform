/**
 * Passo 6 del wizard di migrazione: passaggio a Radicale, rollback e
 * chiusura della finestra (fase F4; design §13.9-§13.13; contratto
 * docs/calendar-radicale/contracts/f4-modules.md §6.3).
 *
 * Tre situazioni, decise dall'API (GET /state):
 *  - mode postgres: criteri del passaggio (tutti visibili, con il dettaglio di
 *    quelli mancanti) e il pulsante "Passa a Radicale" con la frase da
 *    digitare e la finestra di rollback; dopo un rollback anche la
 *    ri-baseline di riparazione;
 *  - transizione attiva (passaggio, ritorno o chiusura): avanzamento passo per
 *    passo dal journal, errori del passo fermo, "Riprendi" e (prima del passo
 *    d'epoch) "Annulla";
 *  - mode radicale: giorni residui della finestra, salute della copia verso
 *    Postgres (proiezione inversa) con i degradi per classe, anteprima del
 *    rollback con busy identico e risorse non copiabili, "Torna a Postgres"
 *    (con la variante di emergenza), "Chiudi finestra" ed export v2.
 *
 * La pagina rilegge lo stato ogni 2 secondi mentre un run o una transizione
 * sono attivi: il journal avanza da solo, senza ricaricare.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Circle, CircleDashed, Download, Loader2, Lock, Play, RotateCcw, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  BACKEND_MODE_LABELS,
  DEGRADATION_LABELS,
  F4_LIMITS,
  findAction,
  formatDateTime,
  formatDuration,
  JOURNAL_STATUS_LABELS,
  MIGRATION_CONFIRMATIONS,
  migrationApi,
  migrationErrorMessage,
  PRECONDITION_REASON_LABELS,
  shortHash,
  TRANSITION_KIND_LABELS,
  TRANSITION_STEP_LABELS,
  TRANSITION_STEPS,
  type CutoverSummary,
  type DegradationClass,
  type JournalStepView,
  type MigrationStateView,
  type ReverseProjectionHealthView,
  type RollbackPreviewSummary,
  type TransitionKind,
  type TransitionView,
  type WizardStepView,
} from '@/lib/calendar-migration-api';
import { ActionButton, ActionReason, BlockingList, ConfirmPhraseDialog, Section, Stat, StepStatusBadge } from './shared';
import { useCalendarNames, useRun, useRunMutation } from './hooks';

interface Props {
  state: MigrationStateView;
  step: WizardStepView;
}

const RESUME_PHRASES: Readonly<Record<TransitionKind, string>> = {
  cutover: MIGRATION_CONFIRMATIONS.cutover,
  rollback: MIGRATION_CONFIRMATIONS.rollback,
  finalize: MIGRATION_CONFIRMATIONS.finalize,
};

/** Criteri solo informativi (non bloccano il passaggio). */
const INFORMATIVE_CRITERIA = new Set(['backup_recent']);

/** Solo la data (fuso di Roma) di un istante. */
function formatDate(iso: string | null | undefined): string {
  return formatDateTime(iso).split(',')[0];
}

export function CutoverStep({ state, step }: Props) {
  const transition = state.transition ?? null;
  const active = transition?.status === 'active' ? transition : null;
  const mode = state.backend.mode;
  return (
    <div className="space-y-4">
      <Section
        title="Passaggio a Radicale"
        description={step.summary}
        actions={(
          <>
            <Badge variant="outline" className="text-[10px]">Autorevole: {BACKEND_MODE_LABELS[mode] ?? mode}</Badge>
            <StepStatusBadge status={step.status} />
          </>
        )}
      >
        <BlockingList items={step.blocking} />
      </Section>

      {active ? (
        <ActiveTransition state={state} step={step} transition={active} />
      ) : mode === 'postgres' ? (
        <PostgresView state={state} step={step} />
      ) : mode === 'radicale' || mode === 'finalized' ? (
        <RadicaleView state={state} step={step} />
      ) : null}

      {transition && !active && <TransitionJournal transition={transition} title="Ultima transizione" collapsible />}
    </div>
  );
}

// ─── Mode postgres: criteri e passaggio ───────────────────────────────

function PostgresView({ state, step }: Props) {
  const cutover = state.cutover;
  const action = findAction(step, 'cutover');
  const rebaselineAction = findAction(step, 'rebaseline');
  const blocking = cutover.criteria.filter((c) => !INFORMATIVE_CRITERIA.has(c.id));
  const met = blocking.filter((c) => c.ok).length;
  const verifyRunId = state.wizard.steps.find((s) => s.id === 'verifica')?.last_run_id ?? null;
  const [open, setOpen] = useState(false);
  const [rebaselineOpen, setRebaselineOpen] = useState(false);
  const [days, setDays] = useState<number>(F4_LIMITS.rollbackWindowDays);
  const daysValid = Number.isInteger(days) && days >= F4_LIMITS.rollbackWindowMinDays && days <= F4_LIMITS.rollbackWindowMaxDays;

  const start = useRunMutation(
    (vars: { confirm: string; days: number }, key) => migrationApi.cutover({ confirm: vars.confirm, rollback_window_days: vars.days, verify_run_id: verifyRunId }, key),
    { success: 'Passaggio avviato: segui i passi qui sotto', onCreated: () => setOpen(false) },
  );
  const rebaseline = useRunMutation(
    (vars: { confirm: string }, key) => migrationApi.rebaseline({ confirm: vars.confirm }, key),
    { success: 'Ri-baseline avviata', onCreated: () => setRebaselineOpen(false) },
  );

  return (
    <>
      <Section title="Criteri del passaggio" description={`${met} di ${blocking.length} soddisfatti. ${cutover.reason}`}>
        <ul className="divide-y rounded-md border">
          {cutover.criteria.map((c) => {
            const informative = INFORMATIVE_CRITERIA.has(c.id);
            return (
              <li key={c.id} className="flex items-start gap-2 p-2.5">
                {c.ok
                  ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  : informative ? <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    {c.label}
                    {informative && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">(informativo)</span>}
                  </p>
                  {c.detail && <p className={cn('text-[11px]', !c.ok && !informative ? 'text-red-700' : 'text-muted-foreground')}>{c.detail}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title="Passa a Radicale"
        description="Postgres resta autorevole fino a questa conferma. Il passaggio sospende per pochi secondi le scritture del calendario, porta su Radicale le ultime modifiche, verifica, rende Radicale autorevole e apre la finestra di rollback."
      >
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Feed ICS (stessi token), CalDAV <span className="font-mono">dav.calicchia.design/federico/&lt;slug&gt;/</span> con le app-password esistenti, sito e strumenti MCP non cambiano.</li>
          <li>Finché la finestra è aperta ogni modifica fatta su Radicale viene copiata anche in Postgres: "Torna a Postgres" non perde gli appuntamenti.</li>
          <li>Ogni passo è registrato: un riavvio dell'API riprende dal primo passo non concluso; fino alla verifica del delta il passaggio si può annullare.</li>
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton action={action} variant="destructive" onClick={() => setOpen(true)} pending={start.isPending}>
            <ArrowLeftRight className="h-3.5 w-3.5" /> Passa a Radicale
          </ActionButton>
        </div>
        <ActionReason action={action} />
      </Section>

      {rebaselineAction?.enabled && (
        <Section
          title="Ri-baseline del ledger"
          description="Riparazione dopo un rollback: riallinea il ledger della migrazione alle righe di Postgres e alle risorse di Radicale, così il prossimo passaggio non riscrive gli oggetti non toccati."
        >
          <ActionButton action={rebaselineAction} variant="outline" onClick={() => setRebaselineOpen(true)} pending={rebaseline.isPending}>
            <RotateCcw className="h-3.5 w-3.5" /> Esegui la ri-baseline
          </ActionButton>
        </Section>
      )}

      <ConfirmPhraseDialog
        open={open}
        onOpenChange={setOpen}
        title="Passare a Radicale?"
        description={(
          <>
            <p>Radicale diventerà il calendario autorevole. Le scritture si fermano per il tempo del passaggio (in genere meno di un minuto) e i device restano in sola lettura fino alla fine.</p>
            <p>Se la verifica del delta non è verde il passaggio si annulla da solo e Postgres resta autorevole.</p>
          </>
        )}
        phrase={action?.confirm ?? MIGRATION_CONFIRMATIONS.cutover}
        confirmLabel="Passa a Radicale"
        destructive
        pending={start.isPending}
        disabled={!daysValid}
        error={start.error ? migrationErrorMessage(start.error) : null}
        onConfirm={({ phrase }) => start.mutate({ confirm: phrase, days })}
      >
        <div className="space-y-1.5">
          <Label htmlFor="rollback-window-days" className="text-xs">Finestra di rollback (giorni, da {F4_LIMITS.rollbackWindowMinDays} a {F4_LIMITS.rollbackWindowMaxDays})</Label>
          <Input
            id="rollback-window-days"
            type="number"
            min={F4_LIMITS.rollbackWindowMinDays}
            max={F4_LIMITS.rollbackWindowMaxDays}
            step={1}
            value={Number.isFinite(days) ? days : ''}
            onChange={(e) => setDays(Number.parseInt(e.target.value, 10))}
            className="max-w-[8rem]"
          />
          {!daysValid && <p className="text-[11px] text-red-600">Indica un numero intero di giorni fra {F4_LIMITS.rollbackWindowMinDays} e {F4_LIMITS.rollbackWindowMaxDays}.</p>}
        </div>
      </ConfirmPhraseDialog>

      <ConfirmPhraseDialog
        open={rebaselineOpen}
        onOpenChange={setRebaselineOpen}
        title="Eseguire la ri-baseline del ledger?"
        description={<p>Legge le righe di Postgres e le risorse di Radicale e aggiorna solo il ledger della migrazione: nessuna scrittura sul calendario.</p>}
        phrase={rebaselineAction?.confirm ?? MIGRATION_CONFIRMATIONS.apply}
        confirmLabel="Esegui"
        pending={rebaseline.isPending}
        error={rebaseline.error ? migrationErrorMessage(rebaseline.error) : null}
        onConfirm={({ phrase }) => rebaseline.mutate({ confirm: phrase })}
      />
    </>
  );
}

// ─── Transizione attiva: avanzamento, ripresa, annullamento ───────────────────────────────

function ActiveTransition({ step, transition }: Props & { transition: TransitionView }) {
  const resumeAction = findAction(step, 'transition_resume');
  const abortAction = findAction(step, 'cutover_abort');
  const [dialog, setDialog] = useState<'resume' | 'abort' | null>(null);
  const resume = useRunMutation((vars: { confirm: string }, key) => migrationApi.transitionResume({ confirm: vars.confirm }, key), {
    success: 'Ripresa avviata dal primo passo non concluso',
    onCreated: () => setDialog(null),
  });
  const abort = useRunMutation(
    (vars: { confirm: string }, key) => (transition.kind === 'rollback' ? migrationApi.rollbackAbort(vars, key) : migrationApi.cutoverAbort(vars, key)),
    { success: 'Annullamento avviato', onCreated: () => setDialog(null) },
  );
  const label = TRANSITION_KIND_LABELS[transition.kind];
  const abortTarget = transition.kind === 'rollback' ? 'Radicale resta autorevole e i device tornano a scrivere.' : 'Postgres resta autorevole e i device restano in sola lettura (shadow).';

  return (
    <>
      <TransitionJournal transition={transition} title={`${label} in corso`} />
      <Section
        title="Controllo della transizione"
        description={transition.resumable
          ? 'La transizione è ferma (run interrotto, fallito o annullato). I passi conclusi non si ripetono: la ripresa parte dal primo passo non concluso.'
          : 'La transizione è in esecuzione (run in cima alla pagina, con "Interrompi"): l\'avanzamento si aggiorna da solo.'}
      >
        <div className="flex flex-wrap gap-2">
          <ActionButton action={resumeAction} onClick={() => setDialog('resume')} pending={resume.isPending}>
            <Play className="h-3.5 w-3.5" /> Riprendi
          </ActionButton>
          {transition.kind !== 'finalize' && (
            <ActionButton action={abortAction} variant="outline" onClick={() => setDialog('abort')} pending={abort.isPending}>
              <Undo2 className="h-3.5 w-3.5" /> Annulla la transizione
            </ActionButton>
          )}
        </div>
        <ActionReason action={resumeAction} />
        {transition.kind !== 'finalize' && <ActionReason action={abortAction} />}
        {!transition.abortable && transition.kind !== 'finalize' && (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-700">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Il passo d'epoch è concluso: la transizione si completa solo andando avanti.
          </p>
        )}
      </Section>

      <ConfirmPhraseDialog
        open={dialog === 'resume'}
        onOpenChange={(o) => setDialog(o ? 'resume' : null)}
        title={`Riprendere: ${label.toLowerCase()}?`}
        description={<p>Riparte da {transition.next_step ? <span className="font-medium">{TRANSITION_STEP_LABELS[transition.kind][transition.next_step] ?? transition.next_step}</span> : 'il primo passo non concluso'}. I passi già conclusi non si ripetono.</p>}
        phrase={resumeAction?.confirm ?? RESUME_PHRASES[transition.kind]}
        confirmLabel="Riprendi"
        pending={resume.isPending}
        error={resume.error ? migrationErrorMessage(resume.error) : null}
        onConfirm={({ phrase }) => resume.mutate({ confirm: phrase })}
      />
      <ConfirmPhraseDialog
        open={dialog === 'abort'}
        onOpenChange={(o) => setDialog(o ? 'abort' : null)}
        title={`Annullare: ${label.toLowerCase()}?`}
        description={<p>La transizione torna allo stato di partenza: {abortTarget}</p>}
        phrase={abortAction?.confirm ?? MIGRATION_CONFIRMATIONS.cutoverAbort}
        confirmLabel="Annulla la transizione"
        destructive
        pending={abort.isPending}
        error={abort.error ? migrationErrorMessage(abort.error) : null}
        onConfirm={({ phrase }) => abort.mutate({ confirm: phrase })}
      />
    </>
  );
}

function JournalIcon({ status, current }: { status: JournalStepView['status'] | null; current: boolean }) {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === 'skipped') return <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 shrink-0 text-red-600" />;
  if (status === 'started') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />;
  return <Circle className={cn('h-4 w-4 shrink-0', current ? 'text-blue-600' : 'text-muted-foreground/50')} />;
}

/** Passi della transizione dal journal, nell'ordine del tipo (più l'eventuale annullamento). */
function TransitionJournal({ transition, title, collapsible }: { transition: TransitionView; title: string; collapsible?: boolean }) {
  const [expanded, setExpanded] = useState(!collapsible);
  const byStep = new Map(transition.steps.map((s) => [s.step, s]));
  const order = [...TRANSITION_STEPS[transition.kind]];
  if (byStep.has('abort')) order.push('abort');
  const labels = TRANSITION_STEP_LABELS[transition.kind];
  const done = transition.steps.filter((s) => s.step !== 'abort' && (s.status === 'done' || s.status === 'skipped')).length;
  const outcome = transition.status === 'completed' ? 'conclusa' : transition.status === 'aborted' ? 'annullata' : 'attiva';
  return (
    <Section
      title={title}
      description={(
        <span>
          {TRANSITION_KIND_LABELS[transition.kind]} {outcome} · avviata {formatDateTime(transition.started_at)} da {transition.started_by}
          {transition.finished_at ? ` · finita ${formatDateTime(transition.finished_at)}` : ''} · epoch {transition.epoch_before}{transition.epoch_after !== null ? ` → ${transition.epoch_after}` : ''}
          {' · '}{done}/{TRANSITION_STEPS[transition.kind].length} passi
        </span>
      )}
      actions={collapsible ? <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Nascondi i passi' : 'Mostra i passi'}</Button> : undefined}
    >
      {transition.outcome && transition.status !== 'active' && (
        <p className={cn('text-xs', transition.status === 'aborted' ? 'text-amber-700' : 'text-muted-foreground')}>
          Esito: {transition.outcome}{transition.outcome_code ? ` (${transition.outcome_code})` : ''}
        </p>
      )}
      {expanded && (
        <ol className="divide-y rounded-md border">
          {order.map((name) => {
            const s = byStep.get(name) ?? null;
            const current = transition.status === 'active' && transition.next_step === name;
            return (
              <li key={name} className={cn('flex items-start gap-2 p-2.5', current && 'bg-blue-500/5')}>
                <JournalIcon status={s?.status ?? null} current={current} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium">{labels[name] ?? name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{name}</span>
                    {name === 'epoch' && <Badge variant="outline" className="text-[10px]">punto di non ritorno</Badge>}
                    {s && <Badge variant="outline" className="text-[10px]">{JOURNAL_STATUS_LABELS[s.status]}</Badge>}
                    {s && s.attempts > 1 && <Badge variant="outline" className="text-[10px]">tentativo {s.attempts}</Badge>}
                  </div>
                  {s && (
                    <p className="text-[11px] text-muted-foreground">
                      {formatDateTime(s.started_at)}{s.finished_at ? ` · ${formatDuration(Date.parse(s.finished_at) - Date.parse(s.started_at))}` : ''}
                    </p>
                  )}
                  {s?.status === 'failed' && (
                    <p className="text-[11px] text-red-600"><span className="font-mono">{s.error_code}</span> — {s.error}</p>
                  )}
                  {s?.status === 'skipped' && typeof s.data.reason === 'string' && <p className="text-[11px] text-muted-foreground">{s.data.reason}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

// ─── Mode radicale: finestra, copia verso Postgres, rollback, finalize ───────────────────────────────

function RadicaleView({ state, step }: Props) {
  const finalized = state.backend.mode === 'finalized';
  const w = state.rollback_window ?? null;
  const previewAction = findAction(step, 'rollback_preview');
  const rollbackAction = findAction(step, 'rollback');
  const finalizeAction = findAction(step, 'finalize');
  const exportAction = findAction(step, 'export_v2');
  const lastPreview = state.last_runs.rollback_preview ?? null;
  const preview = useRun<RollbackPreviewSummary>(lastPreview?.id ?? null);
  const previewSummary = preview.data?.status === 'succeeded' ? preview.data.summary : null;
  const cutoverRun = useRun<CutoverSummary>(state.last_runs.cutover?.status === 'succeeded' ? state.last_runs.cutover.id : null);
  const cutoverSummary = cutoverRun.data?.status === 'succeeded' ? cutoverRun.data.summary : null;
  const calendarNames = useCalendarNames(state);

  const [dialog, setDialog] = useState<'rollback' | 'finalize' | null>(null);
  const [emergency, setEmergency] = useState(false);
  const runPreview = useRunMutation((_: void, key) => migrationApi.rollbackPreview({}, key), { success: 'Anteprima del rollback avviata' });
  const rollback = useRunMutation(
    (vars: { previewRunId: string; confirm: string; extra: string | null }, key) => migrationApi.rollback({
      preview_run_id: vars.previewRunId,
      expect_preview_hash: previewSummary?.preview_hash ?? null,
      confirm: vars.confirm,
      ...(emergency ? { emergency: true, confirm_emergency: vars.extra ?? '' } : {}),
    }, key),
    { success: 'Ritorno a Postgres avviato: segui i passi', onCreated: () => { setDialog(null); setEmergency(false); } },
  );
  const finalize = useRunMutation((vars: { confirm: string }, key) => migrationApi.finalize(vars, key), {
    success: 'Chiusura della finestra avviata',
    onCreated: () => setDialog(null),
  });
  const exportV2 = useMutation({
    mutationFn: () => migrationApi.downloadCalendarExportV2(),
    onSuccess: () => toast.success('Export v2 scaricato'),
    onError: (err) => toast.error(migrationErrorMessage(err)),
  });

  return (
    <>
      <Section
        title={finalized ? 'Finestra di rollback chiusa' : 'Finestra di rollback'}
        description={finalized ? 'Radicale è l\'unico calendario: Postgres non riceve più copie.' : 'Finché è aperta ogni modifica su Radicale viene copiata anche in Postgres e "Torna a Postgres" è disponibile.'}
      >
        <div className="flex flex-wrap gap-2">
          {!finalized && <Stat label="Giorni residui" value={w ? w.days_left : '—'} tone={w?.expired ? 'bad' : w && w.days_left <= 3 ? 'warn' : 'ok'} hint={w?.rollback_until ? `fino al ${formatDateTime(w.rollback_until)}` : undefined} />}
          <Stat label="Passaggio" value={formatDate(w?.cutover_at ?? state.backend.cutover_at)} hint={w?.cutover_by ?? undefined} />
          {!finalized && <Stat label="Chiusura possibile dal" value={w ? formatDate(w.finalize_available_at) : '—'} tone={w?.finalize_ready ? 'ok' : undefined} />}
          {finalized && <Stat label="Chiusa il" value={formatDate(state.backend.finalized_at)} />}
          <Stat label="Epoch" value={state.backend.epoch} />
        </div>
        {cutoverSummary?.smoke && (
          <div className="space-y-1">
            <p className="text-xs font-medium">Prove finali del passaggio: {cutoverSummary.smoke.ok ? 'riuscite' : 'non riuscite'}</p>
            <ul className="flex flex-wrap gap-1.5">
              {cutoverSummary.smoke.checks.map((c) => (
                <li key={c.code}>
                  <Badge variant="outline" className={cn('text-[10px]', c.ok ? 'text-emerald-700' : 'text-red-700')} title={c.detail ?? undefined}>
                    {c.ok ? '✓' : '✗'} {c.code}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {state.reverse_projection && <ReverseHealth health={state.reverse_projection} />}

      {!finalized && (
        <Section
          title="Torna a Postgres"
          description="Il rollback sospende le scritture, fa l'ultima copia verso Postgres, verifica che coincida con l'anteprima confermata e riporta Postgres autorevole. Il volume di Radicale resta intatto."
          actions={(
            <ActionButton action={previewAction} variant="outline" onClick={() => runPreview.mutate()} pending={runPreview.isPending}>
              <ShieldCheck className="h-3.5 w-3.5" /> {lastPreview ? 'Rigenera l\'anteprima' : 'Anteprima del rollback'}
            </ActionButton>
          )}
        >
          <ActionReason action={previewAction} />
          {lastPreview && (lastPreview.status === 'failed' || lastPreview.status === 'interrupted' || lastPreview.status === 'cancelled') && (
            <p className="text-xs text-red-600">Ultima anteprima non riuscita: {lastPreview.error?.message ?? lastPreview.status}</p>
          )}
          {previewSummary && <RollbackPreview summary={previewSummary} finishedAt={preview.data?.finished_at ?? null} calendarNames={calendarNames} />}
          <div className="flex flex-wrap gap-2">
            <ActionButton action={rollbackAction} variant="destructive" onClick={() => setDialog('rollback')} pending={rollback.isPending}>
              <Undo2 className="h-3.5 w-3.5" /> Torna a Postgres
            </ActionButton>
          </div>
          <ActionReason action={rollbackAction} />
        </Section>
      )}

      <Section
        title={finalized ? 'Export' : 'Chiudi la finestra ed export'}
        description={finalized ? undefined : `La chiusura ferma la copia verso Postgres e rende definitivo il passaggio: possibile dopo ${F4_LIMITS.finalizeMinDays} giorni, con la salute verde e senza risorse non copiate.`}
      >
        <div className="flex flex-wrap gap-2">
          {!finalized && (
            <ActionButton action={finalizeAction} variant="outline" onClick={() => setDialog('finalize')} pending={finalize.isPending}>
              <Lock className="h-3.5 w-3.5" /> Chiudi finestra
            </ActionButton>
          )}
          <ActionButton action={exportAction} variant="outline" onClick={() => exportV2.mutate()} pending={exportV2.isPending}>
            <Download className="h-3.5 w-3.5" /> Export v2 (un .ics per calendario)
          </ActionButton>
        </div>
        {!finalized && <ActionReason action={finalizeAction} />}
        {!finalized && w && !w.finalize_ready && w.finalize_blockers.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {w.finalize_blockers.map((b) => <li key={b}><Badge variant="outline" className="text-[10px]">{PRECONDITION_REASON_LABELS[b] ?? b}</Badge></li>)}
          </ul>
        )}
      </Section>

      <ConfirmPhraseDialog
        open={dialog === 'rollback'}
        onOpenChange={(o) => { setDialog(o ? 'rollback' : null); if (!o) setEmergency(false); }}
        title="Tornare a Postgres?"
        description={(
          <>
            <p>Postgres tornerà autorevole con le modifiche fatte su Radicale durante la finestra. Quello che Postgres non sa rappresentare resta nel volume di Radicale ed è riassunto nell'anteprima{previewSummary ? ` (${shortHash(previewSummary.preview_hash)})` : ''}.</p>
            <p>Se dopo la sospensione delle scritture l'anteprima risulta cambiata il rollback si annulla da solo: rigenerala e riprova (o usa l'emergenza).</p>
          </>
        )}
        phrase={rollbackAction?.confirm ?? MIGRATION_CONFIRMATIONS.rollback}
        confirmLabel={emergency ? 'Rollback di emergenza' : 'Torna a Postgres'}
        destructive
        pending={rollback.isPending}
        disabled={!lastPreview}
        error={rollback.error ? migrationErrorMessage(rollback.error) : null}
        extraPhrase={emergency ? { phrase: MIGRATION_CONFIRMATIONS.rollbackEmergency, label: 'Emergenza: digita anche' } : null}
        onConfirm={({ phrase, extra }) => { if (lastPreview) rollback.mutate({ previewRunId: lastPreview.id, confirm: phrase, extra }); }}
      >
        <label className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
          <input type="checkbox" className="mt-0.5 h-3.5 w-3.5" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} />
          <span>
            <span className="font-medium">Rollback di emergenza</span>: prosegue anche se l'anteprima ricalcolata è diversa o se la sincronizzazione finale non riesce. Usalo solo se Radicale non è utilizzabile.
          </span>
        </label>
      </ConfirmPhraseDialog>

      <ConfirmPhraseDialog
        open={dialog === 'finalize'}
        onOpenChange={(o) => setDialog(o ? 'finalize' : null)}
        title="Chiudere la finestra di rollback?"
        description={(
          <>
            <p>Dopo la chiusura Postgres non riceve più le modifiche e "Torna a Postgres" non è più disponibile. Radicale resta l'unico calendario.</p>
            <p>Prima di chiudere scarica l'export v2 e verifica che i device funzionino.</p>
          </>
        )}
        phrase={finalizeAction?.confirm ?? MIGRATION_CONFIRMATIONS.finalize}
        confirmLabel="Chiudi la finestra"
        destructive
        pending={finalize.isPending}
        error={finalize.error ? migrationErrorMessage(finalize.error) : null}
        onConfirm={({ phrase }) => finalize.mutate({ confirm: phrase })}
      />
    </>
  );
}

function DegradationTable({ byClass }: { byClass: Partial<Record<DegradationClass, number>> }) {
  const entries = (Object.entries(byClass) as Array<[DegradationClass, number]>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <p className="text-xs text-muted-foreground">Nessun degrado: tutto è rappresentabile anche in Postgres.</p>;
  return (
    <table className="w-full text-xs">
      <tbody className="divide-y">
        {entries.map(([cls, n]) => (
          <tr key={cls}>
            <td className="py-1 pr-2">
              {cls === 'REVERSE_FAILED' && <AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-red-600" />}
              {DEGRADATION_LABELS[cls] ?? cls} <span className="font-mono text-[10px] text-muted-foreground">{cls}</span>
            </td>
            <td className="py-1 text-right font-medium tabular-nums">{n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReverseHealth({ health }: { health: ReverseProjectionHealthView }) {
  return (
    <Section
      title="Copia verso Postgres (proiezione inversa)"
      description={health.active
        ? `Attiva${health.until ? ` fino al ${formatDateTime(health.until)}` : ''}; ultima copia ${formatDateTime(health.last_projected_at)}.`
        : 'Ferma: la finestra di rollback non è aperta.'}
    >
      <div className="flex flex-wrap gap-2">
        <Stat label="Risorse" value={health.objects} />
        <Stat label="Copiate" value={health.by_status.projected} tone="ok" />
        <Stat label="Con degradi" value={health.by_status.degraded} tone={health.by_status.degraded ? 'warn' : undefined} />
        <Stat label="Non copiate" value={health.by_status.failed} tone={health.by_status.failed ? 'bad' : 'ok'} />
        <Stat label="Righe espanse" value={health.derived_rows} />
        <Stat label="In coda" value={health.queue.pending + health.queue.running} hint={health.queue.dead ? `${health.queue.dead} in dead letter` : undefined} tone={health.queue.dead ? 'bad' : undefined} />
      </div>
      <DegradationTable byClass={health.by_class} />
    </Section>
  );
}

function RollbackPreview({ summary, finishedAt, calendarNames }: { summary: RollbackPreviewSummary; finishedAt: string | null; calendarNames: Record<string, string> }) {
  const actors = Object.entries(summary.changes_since_cutover.by_actor ?? {}).filter(([, n]) => (n ?? 0) > 0);
  const changes = summary.changes_since_cutover;
  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">Anteprima del {formatDateTime(finishedAt ?? summary.generated_at)}</span>
        <Badge variant="outline" className="font-mono text-[10px]">{shortHash(summary.preview_hash)}</Badge>
        {summary.busy_identical === true && <Badge variant="outline" className="text-[10px] text-emerald-700">busy identico</Badge>}
        {summary.busy_identical === false && <Badge variant="outline" className="text-[10px] text-red-700">busy diverso</Badge>}
        {summary.busy_identical === null && <Badge variant="outline" className="text-[10px]">busy non calcolato</Badge>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Stat label="Risorse" value={summary.objects} />
        <Stat label="Righe espanse" value={summary.derived_rows} />
        <Stat label="Non copiabili" value={summary.reverse_failed} tone={summary.reverse_failed ? 'bad' : 'ok'} />
        <Stat
          label="Modifiche dal passaggio"
          value={changes.created + changes.updated + changes.deleted}
          hint={`${changes.created} nuove, ${changes.updated} modificate, ${changes.deleted} cancellate`}
        />
      </div>
      {actors.length > 0 && <p className="text-[11px] text-muted-foreground">Per origine: {actors.map(([a, n]) => `${a} ${n}`).join(', ')}</p>}
      {summary.busy_identical === false && (
        <p className="flex items-start gap-1.5 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Dopo il rollback la disponibilità calcolata da Postgres non coinciderebbe con quella di Radicale: controlla i degradi prima di procedere.
        </p>
      )}
      <DegradationTable byClass={summary.by_class} />
      {summary.calendars.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Calendario</th>
              <th className="py-1 pr-2 text-right font-medium">Risorse</th>
              <th className="py-1 pr-2 text-right font-medium">Con degradi</th>
              <th className="py-1 pr-2 text-right font-medium">Non copiabili</th>
              <th className="py-1 text-right font-medium">Righe espanse</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {summary.calendars.map((c) => (
              <tr key={c.calendar_id}>
                <td className="py-1 pr-2">{calendarNames[c.calendar_id] ?? c.collection_name}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{c.objects}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{c.degraded}</td>
                <td className={cn('py-1 pr-2 text-right tabular-nums', c.failed > 0 && 'font-medium text-red-600')}>{c.failed}</td>
                <td className="py-1 text-right tabular-nums">{c.derived_rows}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
