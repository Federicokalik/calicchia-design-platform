/**
 * Hook condivisi dai passi del wizard di migrazione del calendario: run che
 * si aggiorna da solo finché è attivo, mutazione che crea un run con la
 * chiave d'idempotenza stabile, nomi dei calendari per le tabelle.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  isRunActive,
  migrationApi,
  migrationErrorMessage,
  migrationKeys,
  newIdempotencyKey,
  RUN_KIND_LABELS,
  type MigrationRunView,
  type MigrationStateView,
  type RunCreatedResponse,
} from '@/lib/calendar-migration-api';

/**
 * Mutazione che crea un run: toast con l'esito della richiesta, invalidazione
 * delle query della pagina (lo stato mostra subito il run in coda) e chiave
 * d'idempotenza stabile finché la richiesta non riesce (un nuovo tentativo
 * dopo un errore di rete non crea un secondo run).
 */
export function useRunMutation<V>(
  fn: (vars: V, idempotencyKey: string) => Promise<RunCreatedResponse>,
  opts: { success?: string; onCreated?: (res: RunCreatedResponse) => void } = {},
) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState(newIdempotencyKey);
  return useMutation({
    mutationFn: (vars: V) => fn(vars, key),
    onSuccess: (res) => {
      setKey(newIdempotencyKey());
      queryClient.setQueryData(migrationKeys.run(res.run.id), res.run);
      void queryClient.invalidateQueries({ queryKey: migrationKeys.all });
      if (res.replayed) toast.info('Richiesta già ricevuta: mostro il run esistente');
      else toast.success(opts.success ?? `${RUN_KIND_LABELS[res.run.kind]}: run avviato`);
      opts.onCreated?.(res);
    },
    onError: (err) => toast.error(migrationErrorMessage(err)),
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

