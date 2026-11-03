/**
 * Hook condivisi dai passi del wizard di migrazione del calendario: run che
 * si aggiorna da solo finché è attivo, mutazione che crea un run con la
 * chiave d'idempotenza stabile, nomi dei calendari per le tabelle.
 */

import { useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createIdempotencyKeyTracker } from './idempotency-key';
import {
  isRunActive,
  migrationApi,
  migrationErrorMessage,
  MigrationApiError,
  migrationKeys,
  newIdempotencyKey,
  RUN_KIND_LABELS,
  type MigrationRunView,
  type MigrationStateView,
  type RunCreatedResponse,
} from '@/lib/calendar-migration-api';

/**
 * Errori che garantiscono che la richiesta non ha creato un run: dopo uno di
 * questi la chiave d'idempotenza si rigenera (IDEMPOTENCY_KEY_REUSED compreso:
 * la chiave è già legata a una richiesta diversa, riusarla darebbe sempre 409).
 */
const KEY_RESET_CODES = new Set([
  'IDEMPOTENCY_KEY_REUSED',
  'VALIDATION_FAILED',
  'CONFIRMATION_REQUIRED',
  'PRECONDITION_FAILED',
  'MIGRATION_BUSY',
  'PAYLOAD_TOO_LARGE',
]);

const noRunCreated = (err: unknown): boolean => err instanceof MigrationApiError && err.code !== null && KEY_RESET_CODES.has(err.code);

/**
 * Mutazione che crea un run: toast con l'esito della richiesta, invalidazione
 * delle query della pagina (lo stato mostra subito il run in coda) e chiave
 * d'idempotenza legata alla richiesta (createIdempotencyKeyTracker): un nuovo
 * tentativo identico dopo un errore di rete non crea un secondo run, uno
 * modificato usa una chiave nuova.
 */
export function useRunMutation<V>(
  fn: (vars: V, idempotencyKey: string) => Promise<RunCreatedResponse>,
  opts: { success?: string; onCreated?: (res: RunCreatedResponse) => void } = {},
) {
  const queryClient = useQueryClient();
  const tracker = useRef<ReturnType<typeof createIdempotencyKeyTracker> | null>(null);
  if (tracker.current === null) tracker.current = createIdempotencyKeyTracker({ generate: newIdempotencyKey, noRunCreated });
  return useMutation({
    mutationFn: (vars: V) => fn(vars, (tracker.current as ReturnType<typeof createIdempotencyKeyTracker>).keyFor(vars)),
    onSuccess: (res) => {
      tracker.current?.succeeded();
      queryClient.setQueryData(migrationKeys.run(res.run.id), res.run);
      void queryClient.invalidateQueries({ queryKey: migrationKeys.all });
      if (res.replayed) toast.info('Richiesta già ricevuta: mostro il run esistente');
      else toast.success(opts.success ?? `${RUN_KIND_LABELS[res.run.kind]}: run avviato`);
      opts.onCreated?.(res);
    },
    onError: (err) => {
      tracker.current?.failed(err);
      toast.error(migrationErrorMessage(err));
    },
  });
}

/** Run per id che si aggiorna ogni 2 secondi finché è attivo. */
export function useRun<S = Record<string, unknown>>(id: string | null | undefined) {
  return useQuery({
    queryKey: migrationKeys.run(id ?? null),
    queryFn: () => migrationApi.run<S>(id as string),
    enabled: !!id,
    refetchInterval: (q) => (isRunActive(q.state.data as MigrationRunView | undefined) ? 2_000 : false),
  });
}

/** Nomi dei calendari noti allo stato (dall'anteprima o dalla verifica), per le tabelle. */
export function useCalendarNames(state: MigrationStateView | undefined): Record<string, string> {
  const planId = state?.wizard.steps.find((s) => s.id === 'anteprima')?.last_run_id ?? null;
  const plan = useRun<{ preview?: { calendars?: Array<{ calendar_id: string; name: string; slug: string }> } }>(planId);
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of plan.data?.summary?.preview?.calendars ?? []) out[c.calendar_id] = c.name ? `${c.name} (${c.slug})` : c.slug;
    return out;
  }, [plan.data]);
}

