/**
 * Passo 4 del wizard di migrazione: verifica per calendario (design §13.7;
 * contratto f3-modules §8 e §11).
 *
 * V1 struttura, V2 contenuto, V3 occorrenze (finestre di 60 giorni), V4 busy
 * (con e senza iscrizioni), V5 feed ICS. Semaforo per calendario e livello:
 * verde nessuna differenza, giallo solo differenze attese (da accettare
 * esplicitamente), rosso almeno una inattesa (si corregge, non si accetta).
 * Drill-down sulle righe e report scaricabile.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCheck, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  COLOR_LABELS,
  findAction,
  formatAgo,
  MIGRATION_CONFIRMATIONS,
  migrationApi,
  migrationErrorMessage,
  migrationKeys,
  VERIFY_LEVEL_LABELS,
  VERIFY_LEVELS,
  type CalendarVerdict,
  type MigrationItemView,
  type MigrationStateView,
  type VerifyLevel,
  type VerifySummary,
  type WizardStepView,
} from '@/lib/calendar-migration-api';
import {
  ActionButton,
  ActionReason,
  BlockingList,
  ColorBadge,
  ColorDot,
  ConfirmPhraseDialog,
  DownloadReportButtons,
  RunItemsTable,
  RunPanel,
  Section,
  Stat,
  StepStatusBadge,
} from './shared';
import { useCalendarNames, useRun, useRunMutation } from './hooks';

interface Props {
  state: MigrationStateView;
  step: WizardStepView;
}

type AcceptTarget = { kind: 'all' } | { kind: 'calendar'; verdict: CalendarVerdict } | { kind: 'items'; ids: string[] };

export function VerifyStep({ state, step }: Props) {
  const queryClient = useQueryClient();
  const candidate = step.last_run_id && step.last_run_id !== state.active_run?.id ? step.last_run_id : null;
  // Verifica mostrata e da accettare: aggiornata durante il render (non in un effetto), così
  // "Accetta" non parte mai sulle righe della verifica precedente nel render di transizione.
  const [verifyId, setVerifyId] = useState<string | null>(candidate);
  if (candidate && candidate !== verifyId) setVerifyId(candidate);
  const verify = useRun<VerifySummary>(verifyId);
  const summary = verify.data?.status === 'succeeded' ? verify.data.summary : null;
  const calendarNames = useCalendarNames(state);

  const [levels, setLevels] = useState<Set<VerifyLevel>>(new Set(VERIFY_LEVELS));
  const [drill, setDrill] = useState<{ calendarId: string | null; level: VerifyLevel | null; expected: boolean | null }>({ calendarId: null, level: null, expected: null });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [accept, setAccept] = useState<AcceptTarget | null>(null);
  useEffect(() => {
    setSelected(new Set());
  }, [verifyId]);

  const run = useRunMutation((_: void, key) => migrationApi.verify({ levels: VERIFY_LEVELS.filter((l) => levels.has(l)) }, key), { success: 'Verifica avviata' });
  const acceptMutation = useMutation({
    mutationFn: (vars: { target: AcceptTarget; confirm: string }) => {
      const t = vars.target;
      return migrationApi.accept(verifyId as string, {
        confirm: vars.confirm,
        ...(t.kind === 'all' ? { all_expected: true } : t.kind === 'calendar' ? { calendar_id: t.verdict.calendar_id } : { item_ids: t.ids }),
      });
    },
    onSuccess: (res) => {
      setAccept(null);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: migrationKeys.all });
      toast.success(`${res.accepted === 1 ? '1 differenza accettata' : `${res.accepted} differenze accettate`}${res.acceptable ? ': verifica accettabile' : ''}`);
    },
    onError: (err) => toast.error(migrationErrorMessage(err)),
  });

  const verdicts = summary?.calendars ?? [];
  const pendingYellow = verdicts.filter((v) => v.color === 'yellow' && !v.accepted);
  const latestVerify = state.last_runs.verify ?? null;
  const shownLevels = summary?.levels ?? VERIFY_LEVELS;
  const selectableDiff = (item: MigrationItemView) => item.item_type === 'diff' && item.expected === true && !item.accepted_at && item.detail?.variant !== 'with_subscriptions';

  return (
    <div className="space-y-4">
      <Section title="Verifica" description={step.summary} actions={<StepStatusBadge status={step.status} />}>
        <BlockingList items={step.blocking} />
        <div className="flex flex-wrap items-center gap-3">
          {VERIFY_LEVELS.map((l) => (
            <label key={l} className="flex items-center gap-1.5 text-xs" title={VERIFY_LEVEL_LABELS[l]}>
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={levels.has(l)}
                onChange={(e) => {
                  const next = new Set(levels);
                  if (e.target.checked) next.add(l); else next.delete(l);
                  setLevels(next);
                }}
              />
              {l} <span className="text-muted-foreground">{VERIFY_LEVEL_LABELS[l]}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <ActionButton action={findAction(step, 'verify')} pending={run.isPending} disabled={levels.size === 0} onClick={() => run.mutate()}>
            <ShieldCheck className="h-3.5 w-3.5" /> {levels.size === VERIFY_LEVELS.length ? 'Verifica V1-V5' : 'Verifica i livelli scelti'}
          </ActionButton>
          <ActionButton variant="outline" action={findAction(step, 'accept')} onClick={() => setAccept({ kind: 'all' })}>
            <CheckCheck className="h-3.5 w-3.5" /> Accetta tutte le differenze attese
          </ActionButton>
        </div>
        <p className="text-[11px] text-muted-foreground">Solo una verifica completa (tutti i livelli, tutti i calendari) conta per il passo e per lo shadow.</p>
        <ActionReason action={findAction(step, 'verify')} />
        {latestVerify && latestVerify.id !== state.active_run?.id && latestVerify.status !== 'succeeded' && latestVerify.trigger === 'admin' && <RunPanel run={latestVerify} compact />}
      </Section>

      {summary && verify.data && (
        <Section
          title="Semaforo per calendario"
          description={`Verifica del ${formatAgo(verify.data.finished_at)} · complessivo ${COLOR_LABELS[summary.overall]}${summary.acceptable ? ' · accettabile' : ''}`}
          actions={<DownloadReportButtons runId={verify.data.id} />}
        >
          <div className="flex flex-wrap gap-2">
            <Stat label="Differenze" value={summary.totals.diffs} />
            <Stat label="Attese" value={summary.totals.expected} tone={summary.totals.expected ? 'warn' : undefined} />
            <Stat label="Accettate" value={summary.totals.accepted} />
            <Stat label="Inattese" value={summary.totals.unexpected} tone={summary.totals.unexpected ? 'bad' : 'ok'} />
            {summary.v4 && (
              <div className="rounded-md border bg-background px-3 py-2 space-y-1">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Busy (V4)</p>
                <p className="flex items-center gap-1.5 text-xs"><ColorDot color={summary.v4.without_subscriptions} /> senza iscrizioni</p>
                <p className="flex items-center gap-1.5 text-xs"><ColorDot color={summary.v4.with_subscriptions} /> con le iscrizioni (informativo)</p>
              </div>
            )}
          </div>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-2 py-1.5">Calendario</th>
                  <th className="px-2 py-1.5">Esito</th>
                  {shownLevels.map((l) => <th key={l} className="px-2 py-1.5 text-center" title={VERIFY_LEVEL_LABELS[l]}>{l}</th>)}
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {verdicts.map((v) => (
                  <tr key={v.calendar_id} className="border-t">
                    <td className="px-2 py-1.5">
                      <button type="button" className="text-left font-medium hover:underline" onClick={() => setDrill({ calendarId: v.calendar_id, level: null, expected: null })}>
                        {calendarNames[v.calendar_id] ?? v.slug ?? v.collection_name}
                      </button>
                      <div className="font-mono text-[10px] text-muted-foreground">/{v.collection_name}</div>
                    </td>
                    <td className="px-2 py-1.5"><ColorBadge color={v.color} accepted={v.accepted} /></td>
                    {shownLevels.map((l) => {
                      const lv = v.levels[l];
                      return (
                        <td key={l} className="px-2 py-1.5 text-center">
                          {lv ? (
                            <button
                              type="button"
                              className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted', drill.calendarId === v.calendar_id && drill.level === l && 'bg-muted')}
                              onClick={() => setDrill({ calendarId: v.calendar_id, level: l, expected: null })}
                              title={`${lv.diffs} differenze (${lv.expected} attese, ${lv.unexpected} inattese)`}
                            >
                              <ColorDot color={lv.color} />
                              {lv.diffs > 0 && <span className="tabular-nums">{lv.diffs}</span>}
                            </button>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5 text-right">
                      {v.color === 'yellow' && !v.accepted && (
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setAccept({ kind: 'calendar', verdict: v })}>Accetta attese</Button>
                      )}
                      {v.color === 'red' && <Badge variant="outline" className="text-[10px] text-red-600">Da correggere</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pendingYellow.length > 0 && (
            <p className="text-[11px] text-muted-foreground">Le differenze attese accettate si riportano sulle verifiche successive con la stessa firma (il giro notturno dello shadow non le richiede di nuovo).</p>
          )}
        </Section>
      )}

      {summary && verify.data && (
        <Section
          title="Differenze"
          description={drill.calendarId ? `${calendarNames[drill.calendarId] ?? 'Calendario'}${drill.level ? ` · ${drill.level} ${VERIFY_LEVEL_LABELS[drill.level]}` : ''}` : 'Tutte le differenze della verifica'}
          actions={(
            <div className="flex flex-wrap gap-2">
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={drill.expected === null ? 'all' : drill.expected ? 'expected' : 'unexpected'}
                onChange={(e) => setDrill({ ...drill, expected: e.target.value === 'all' ? null : e.target.value === 'expected' })}
              >
                <option value="all">Attese e inattese</option>
                <option value="expected">Solo attese (gialle)</option>
                <option value="unexpected">Solo inattese (rosse)</option>
              </select>
              {(drill.calendarId || drill.level) && <Button size="sm" variant="ghost" className="h-8 text-[11px]" onClick={() => setDrill({ calendarId: null, level: null, expected: drill.expected })}>Tutti i calendari</Button>}
              {selected.size > 0 && (
                <Button size="sm" className="h-8 text-[11px]" onClick={() => setAccept({ kind: 'items', ids: [...selected] })}>Accetta {selected.size} selezionate</Button>
              )}
            </div>
          )}
        >
          <RunItemsTable
            key={`${verify.data.id}-${drill.calendarId}-${drill.level}-${drill.expected}`}
            runId={verify.data.id}
            filter={{
              item_type: 'diff',
              ...(drill.calendarId ? { calendar_id: drill.calendarId } : {}),
              ...(drill.level ? { level: drill.level } : {}),
              ...(drill.expected === null ? {} : { expected: drill.expected }),
            }}
            calendarNames={calendarNames}
            selectable={selectableDiff}
            selected={selected}
            onToggle={(item) => {
              const next = new Set(selected);
              if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
              setSelected(next);
            }}
            emptyText="Nessuna differenza: verde."
          />
        </Section>
      )}

      <ConfirmPhraseDialog
        open={accept !== null}
        onOpenChange={(o) => { if (!o) setAccept(null); }}
        title="Accetta le differenze attese"
        phrase={MIGRATION_CONFIRMATIONS.accept}
        confirmLabel="Accetta"
        pending={acceptMutation.isPending}
        error={acceptMutation.isError ? migrationErrorMessage(acceptMutation.error) : null}
        onConfirm={({ phrase }) => { if (accept) acceptMutation.mutate({ target: accept, confirm: phrase }); }}
        description={
          <>
            <p>
              {accept?.kind === 'all' && 'Accetti tutte le differenze attese (gialle) della verifica.'}
              {accept?.kind === 'calendar' && `Accetti le differenze attese di ${calendarNames[accept.verdict.calendar_id] ?? accept.verdict.slug}.`}
              {accept?.kind === 'items' && `Accetti ${accept.ids.length} differenze attese selezionate.`}
            </p>
            <p>Sono differenze previste dal design (orfani convertiti, eccezioni riallineate, UID degli override nel feed…). Le differenze inattese (rosse) non si accettano: vanno corrette.</p>
          </>
        }
      />
    </div>
  );
}
