/**
 * Strumento di migrazione del calendario a Radicale (fase F3; design §13.13;
 * contratto docs/calendar-radicale/contracts/f3-modules.md §11).
 *
 * Wizard a 6 passi: prerequisiti e inizializzazione, anteprima e opzioni,
 * apply, verifica, shadow e prova sui device, passaggio (disabilitato fino
 * alla F4). Lo stato dei passi lo calcola l'API (GET /state): la pagina lo
 * rilegge ogni 5 secondi, ogni 2 mentre un run è in corso, e dopo ogni azione;
 * alla fine di un run mostra l'esito e aggiorna tutto senza ricaricare.
 * Postgres resta autorevole per tutta la fase.
 */

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Database, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/shared/loading-state';
import { CalendarTabs } from '@/components/layout/calendar-tabs';
import { useTopbar } from '@/hooks/use-topbar';
import { cn } from '@/lib/utils';
import {
  formatDateTime,
  IDENTITY_LABELS,
  isRunActive,
  migrationApi,
  MigrationApiError,
  migrationErrorMessage,
  migrationKeys,
  RUN_KIND_LABELS,
  type MigrationStateView,
  type WizardStepId,
} from '@/lib/calendar-migration-api';
import { RunPanel, StepStatusBadge, StepStatusIcon } from '@/components/calendar/migration/shared';
import { PreflightStep } from '@/components/calendar/migration/preflight-step';
import { PreviewStep } from '@/components/calendar/migration/preview-step';
import { ApplyStep } from '@/components/calendar/migration/apply-step';
import { VerifyStep } from '@/components/calendar/migration/verify-step';
import { ShadowStep } from '@/components/calendar/migration/shadow-step';
import { CutoverStep } from '@/components/calendar/migration/cutover-step';

const STEP_PARAM = 'passo';
const STEP_IDS: readonly WizardStepId[] = ['prerequisiti', 'anteprima', 'applica', 'verifica', 'shadow', 'passaggio'];

export default function MigrazionePage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  useTopbar({
    title: 'Migrazione a Radicale',
    subtitle: 'Anteprima, apply idempotente, verifica e shadow — Postgres resta autorevole fino al passaggio',
  });

  const stateQuery = useQuery({
    queryKey: migrationKeys.state,
    queryFn: migrationApi.state,
    refetchInterval: (q) => (isRunActive((q.state.data as MigrationStateView | undefined)?.active_run) ? 2_000 : 5_000),
    // Un riavvio dell'API (502 di nginx) dura qualche secondo: più tentativi con attesa crescente per i 5xx e la rete.
    retry: (failures, err) => failures < 3 && (!(err instanceof MigrationApiError) || err.status >= 500),
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
  });
  const state = stateQuery.data;

  // Fine di un run: esito in un toast e aggiornamento di tutte le viste della pagina.
  const previousActive = useRef<string | null>(null);
  const activeId = state?.active_run?.id ?? null;
  useEffect(() => {
    const previous = previousActive.current;
    previousActive.current = activeId;
    if (!previous || previous === activeId) return;
    void (async () => {
      try {
        const run = await queryClient.fetchQuery({ queryKey: migrationKeys.run(previous), queryFn: () => migrationApi.run(previous), staleTime: 0 });
        const label = RUN_KIND_LABELS[run.kind] ?? run.kind;
        // "run" come soggetto: le etichette dei tipi sono sia maschili sia femminili (Preflight, Anteprima).
        if (run.status === 'succeeded') toast.success(`${label}: run completato`);
        else if (run.status === 'cancelled') toast.info(`${label}: run annullato`);
        else if (run.status === 'failed' || run.status === 'interrupted') toast.error(`${label}: run ${run.status === 'failed' ? 'fallito' : 'interrotto'}: ${run.error?.message ?? 'vedi il dettaglio del passo'}`);
      } catch {
        /* il run non è più leggibile: basta l'aggiornamento */
      }
      await queryClient.invalidateQueries({ queryKey: migrationKeys.all });
    })();
  }, [activeId, queryClient]);

  if (stateQuery.isLoading) return <div className="space-y-6"><CalendarTabs /><LoadingState /></div>;
  // Pannello d'errore bloccante solo senza dati: un errore transitorio del polling (502 durante un riavvio o un deploy
  // dell'API) non smonta passi e dialog aperti (file scelto, frasi digitate, selezioni), resta un avviso sopra.
  if (!state) {
    return (
      <div className="space-y-6">
        <CalendarTabs />
        <div className="rounded-lg border bg-card p-6 text-center space-y-3">
          <p className="text-sm text-red-600">{migrationErrorMessage(stateQuery.error)}</p>
          <Button size="sm" variant="outline" onClick={() => stateQuery.refetch()}><RefreshCw className="h-3.5 w-3.5" /> Riprova</Button>
        </div>
      </div>
    );
  }

  const requested = params.get(STEP_PARAM) as WizardStepId | null;
  const selectedId: WizardStepId = requested && STEP_IDS.includes(requested) ? requested : state.wizard.current_step;
  const selected = state.wizard.steps.find((s) => s.id === selectedId) ?? state.wizard.steps[0];
  const select = (id: WizardStepId) => {
    const next = new URLSearchParams(params);
    next.set(STEP_PARAM, id);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <CalendarTabs />

      {stateQuery.isError && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <span>
            Stato non aggiornato da {formatDateTime(stateQuery.dataUpdatedAt ? new Date(stateQuery.dataUpdatedAt).toISOString() : null)}
            {' '}({migrationErrorMessage(stateQuery.error)}): riprovo da solo.
          </span>
          <Button size="sm" variant="outline" onClick={() => stateQuery.refetch()}><RefreshCw className="h-3.5 w-3.5" /> Riprova</Button>
        </div>
      )}

      <StatusBar state={state} />

      {state.active_run && <RunPanel run={state.active_run} />}

      <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav aria-label="Passi della migrazione" className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
          {state.wizard.steps.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => select(s.id)}
              aria-current={s.id === selected.id ? 'step' : undefined}
              className={cn(
                'min-w-[13rem] shrink-0 rounded-lg border p-3 text-left transition-colors lg:min-w-0',
                s.id === selected.id ? 'border-foreground bg-card shadow-sm' : 'bg-card/50 hover:bg-card',
              )}
            >
              <div className="flex items-center gap-2">
                <StepStatusIcon status={s.status} />
                <span className="text-[11px] text-muted-foreground">{s.index}.</span>
                <span className="text-sm font-medium truncate">{s.title}</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <StepStatusBadge status={s.status} />
                {s.id === state.wizard.current_step && <span className="text-[10px] text-muted-foreground">passo corrente</span>}
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{s.summary}</p>
            </button>
          ))}
        </nav>

        <div className="min-w-0">
          {selected.id === 'prerequisiti' && <PreflightStep state={state} step={selected} />}
          {selected.id === 'anteprima' && <PreviewStep state={state} step={selected} />}
          {selected.id === 'applica' && <ApplyStep state={state} step={selected} />}
          {selected.id === 'verifica' && <VerifyStep state={state} step={selected} />}
          {selected.id === 'shadow' && <ShadowStep state={state} step={selected} />}
          {selected.id === 'passaggio' && <CutoverStep state={state} step={selected} />}
        </div>
      </div>
    </div>
  );
}

function StatusBar({ state }: { state: MigrationStateView }) {
  const b = state.backend;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
      <span className="inline-flex items-center gap-1.5"><Database className="h-3.5 w-3.5 text-muted-foreground" /> Autorevole: <span className="font-medium">{b.mode === 'postgres' ? 'Postgres' : b.mode}</span></span>
      <span className="text-muted-foreground">·</span>
      <span className="inline-flex items-center gap-1.5">
        <Server className="h-3.5 w-3.5 text-muted-foreground" /> Radicale: <span className="font-medium">{state.radicale.configured ? 'configurato' : 'non configurato'}</span>
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="inline-flex items-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" /> Identità: <span className={cn('font-medium', state.identity.status === 'mismatch' && 'text-red-600')}>{IDENTITY_LABELS[state.identity.status] ?? state.identity.status}</span>
      </span>
      <span className="text-muted-foreground">·</span>
      <span>Shadow: <span className="font-medium">{b.shadow_enabled ? 'attivo' : 'spento'}</span></span>
      <span className="text-muted-foreground">·</span>
      <span>Ledger: {state.ledger.live} oggetti{state.ledger.pending_intents ? `, ${state.ledger.pending_intents} scritture a metà` : ''}{state.ledger.revalidation_pending ? `, ${state.ledger.revalidation_pending} da rivalidare` : ''}</span>
      {b.restore_guard_until && <Badge variant="outline" className="text-[10px] text-amber-700">Guardia post-ripristino</Badge>}
      {b.rebuild_required && <Badge variant="outline" className="text-[10px] text-amber-700">Indice da ricostruire</Badge>}
    </div>
  );
}
