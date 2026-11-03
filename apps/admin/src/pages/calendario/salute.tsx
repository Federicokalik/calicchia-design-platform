/**
 * Salute del calendario (contratto F6 §9.1.5 e §9.2.3): modo, blocchi di
 * scrittura, identità del volume, heartbeat, canary, indice, collezioni,
 * oggetti in quarantena, job falliti, conflitti di prenotazione e ultimo
 * backup coordinato. Polling di `GET /sync-state` ogni 20 s. Per una
 * collezione in hold: "Applica cancellazioni" e "Ricostruisci dall'indice",
 * ciascuna con anteprima completa, conferma digitata e avanzamento del job.
 * Visibile solo con la capacità `health_page`; mai testo di evento nei log.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import {
  CAL_V2_HOLD_CONFIRMATIONS,
  type CalV2BackendMode,
  type CalV2CollectionState,
  type CalV2HoldActionResult,
  type CalV2HoldPlan,
  type CalV2HoldPlanItem,
  type CalV2SyncState,
} from '@calicchia/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/shared/loading-state';
import { EmptyState } from '@/components/shared/empty-state';
import { CalendarTabs } from '@/components/layout/calendar-tabs';
import { JobProgress } from '@/components/calendar/job-progress';
import { formatWhen } from '@/components/calendar/history-format';
import { useTopbar } from '@/hooks/use-topbar';
import { useLocalizedPath } from '@/hooks/use-localized-navigation';
import {
  CalV2ApiError,
  calV2ErrorMessage,
  calV2Keys,
  getSyncStateV2,
  holdCommitV2,
  holdPreviewV2,
  useCalendarV2Capabilities,
} from '@/lib/calendar-v2-api';

/** Intervallo di aggiornamento dello stato (§9.1.5). */
const SYNC_STATE_POLL_MS = 20_000;

type HoldAction = 'apply_deletions' | 'rebuild_from_index';

const MODE_LABEL: Record<CalV2BackendMode, string> = {
  postgres: 'Postgres',
  cutover: 'Passaggio a Radicale in corso',
  radicale: 'Radicale',
  rollback: 'Ritorno a Postgres in corso',
  finalized: 'Radicale (definitivo)',
};

const HOLD_REASON_LABEL: Record<NonNullable<CalV2CollectionState['hold_reason']>, string> = {
  'mass-delete': 'cancellazione di massa dal dispositivo',
  'collection-empty': 'collezione svuotata',
  'collection-missing': 'collezione mancante in Radicale',
  'restore-guard': 'guardia dopo un ripristino',
};

const HEALTH_LABEL: Record<CalV2CollectionState['health'], string> = {
  healthy: 'In ordine',
  stale: 'Non aggiornata',
  unsyncable: 'Non sincronizzabile',
  hold: 'In sospeso (hold)',
};

const HOLD_ACTION_TEXT: Record<HoldAction, { title: string; button: string; description: string; testId: string }> = {
  apply_deletions: {
    title: 'Applica cancellazioni',
    button: 'Applica cancellazioni',
    description: 'Accetta le cancellazioni fatte dal dispositivo: gli eventi sospesi escono dall\'indice. Se servono, restano recuperabili dal Cestino finché le loro versioni sono conservate.',
    testId: 'cal-hold-apply',
  },
  rebuild_from_index: {
    title: 'Ricostruisci dall\'indice',
    button: 'Ricostruisci dall\'indice',
    description: 'Riscrive in Radicale gli eventi sospesi partendo dalla loro ultima versione valida. Gli eventi senza una versione valida vengono saltati.',
    testId: 'cal-hold-rebuild',
  },
};

const PLAN_ACTION_LABEL: Record<CalV2HoldPlanItem['action'], string> = {
  remove_from_index: 'Toglie dall\'indice',
  put_to_radicale: 'Riscrive in Radicale',
  skip: 'Salta',
};

const PLAN_REASON_LABEL: Record<string, string> = {
  no_valid_version: 'nessuna versione valida',
  present_in_radicale: 'già presente in Radicale',
  expired: 'versione scaduta',
};

function planReason(reason: string | null): string {
  if (!reason) return '';
  return PLAN_REASON_LABEL[reason] ?? reason;
}

// ─── Azione su una collezione in hold ───────────────────────────────

function HoldActionDialog({ collection, action, onClose, onFinished }: {
  collection: CalV2CollectionState;
  action: HoldAction;
  onClose: () => void;
  onFinished: () => void;
}) {
  const text = HOLD_ACTION_TEXT[action];
  const expected = CAL_V2_HOLD_CONFIRMATIONS[action];
  const [plan, setPlan] = useState<CalV2HoldPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  // Stessa chiave per i nuovi tentativi dello stesso commit; cambia se il piano cambia (corpo diverso).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  // Anteprima caricata all'apertura: un solo dry_run per dialogo.
  useEffect(() => {
    let cancelled = false;
    holdPreviewV2(collection.calendar_id, action)
      .then((result) => { if (!cancelled) setPlan(result); })
      .catch((err: unknown) => { if (!cancelled) setLoadError(calV2ErrorMessage(err)); });
    return () => { cancelled = true; };
  }, [collection.calendar_id, action]);

  const confirmed = typed.trim() === expected;
  const running = jobId !== null;
  const actionable = plan ? plan.items.filter((i) => i.action !== 'skip').length : 0;

  const commit = async () => {
    if (!plan || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await holdCommitV2(
        collection.calendar_id,
        action,
        { confirm: expected, plan_hash: plan.plan_hash },
        idempotencyKey,
      );
      setJobId(accepted.job_id);
    } catch (err) {
      if (err instanceof CalV2ApiError && err.code === 'PLAN_CHANGED') {
        const fresh = err.details?.plan as CalV2HoldPlan | undefined;
        if (fresh && Array.isArray(fresh.items)) {
          setPlan(fresh);
          setIdempotencyKey(crypto.randomUUID());
        }
        setTyped('');
        setError('La situazione è cambiata dopo l\'anteprima. Controlla il piano aggiornato e conferma di nuovo.');
      } else if (err instanceof CalV2ApiError && err.code === 'NOT_IN_HOLD') {
        setError('La collezione non è più in sospeso: non serve altro.');
      } else {
        setError(calV2ErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{text.title} · {collection.calendar_name}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>

        {!running && (
          <div className="space-y-4">
            {!plan && !loadError && <LoadingState />}
            {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
            {plan && (
              <>
                <p className="text-sm">
                  <strong>{plan.total}</strong> {plan.total === 1 ? 'elemento sospeso' : 'elementi sospesi'}
                  {plan.hold_reason ? ` (${HOLD_REASON_LABEL[plan.hold_reason]})` : ''}
                  {' · '}<strong>{actionable}</strong> da {action === 'apply_deletions' ? 'togliere dall\'indice' : 'riscrivere'}
                </p>
                <div className="max-h-72 overflow-auto rounded-md border" data-testid="cal-hold-plan">
                  <div className="sticky top-0 z-10 grid grid-cols-[1fr_9rem] gap-2 border-b bg-muted/80 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                    <span>Evento</span>
                    <span>Azione</span>
                  </div>
                  {plan.items.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">Nessun elemento sospeso.</p>
                  ) : plan.items.map((item) => (
                    <div
                      key={item.href}
                      className="grid grid-cols-[1fr_9rem] gap-2 border-b px-2 py-1.5 text-xs last:border-b-0 [content-visibility:auto] [contain-intrinsic-size:auto_2.5rem]"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{item.summary?.trim() || '(senza titolo)'}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{item.uid ?? item.href}</span>
                      </span>
                      <span>
                        <span className={item.action === 'skip' ? 'text-muted-foreground' : 'font-medium'}>{PLAN_ACTION_LABEL[item.action]}</span>
                        {item.reason && <span className="block text-[11px] text-muted-foreground">{planReason(item.reason)}</span>}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="cal-hold-confirm-input" className="text-sm font-medium">
                    Per confermare digita <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{expected}</code>
                  </label>
                  <input
                    id="cal-hold-confirm-input"
                    data-testid="cal-hold-confirm-input"
                    type="text"
                    autoComplete="off"
                    value={typed}
                    disabled={busy || actionable === 0}
                    onChange={(e) => setTyped(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm disabled:opacity-60"
                  />
                </div>
              </>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {running && jobId && (
          <JobProgress jobId={jobId} testId="cal-hold-status" onFinished={onFinished}>
            {(job) => {
              if (job.status !== 'done' || !job.result || !('collection_health' in job.result)) return null;
              const result: CalV2HoldActionResult = job.result;
              return (
                <div className="space-y-2 text-sm">
                  <p>
                    <strong>{result.applied}</strong> {action === 'apply_deletions' ? 'tolti dall\'indice' : 'riscritti in Radicale'} · <strong>{result.skipped}</strong> saltati
                    {result.failed.length > 0 && <> · <strong className="text-destructive">{result.failed.length}</strong> non riusciti</>}
                  </p>
                  <p className="text-xs text-muted-foreground">Stato della collezione: {HEALTH_LABEL[result.collection_health]}.</p>
                  {result.failed.length > 0 && (
                    <div className="max-h-40 overflow-auto rounded-md border border-destructive/40">
                      {result.failed.map((f) => (
                        <div key={f.href} className="border-b px-2 py-1.5 text-xs last:border-b-0">
                          <span className="block truncate font-mono text-[11px]">{f.href}</span>
                          <span className="block text-destructive">{f.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }}
          </JobProgress>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{running ? 'Chiudi' : 'Annulla'}</Button>
          {!running && (
            <Button
              size="sm"
              variant="destructive"
              data-testid="cal-hold-confirm"
              onClick={() => { void commit(); }}
              disabled={!plan || actionable === 0 || !confirmed || busy}
            >
              {busy ? 'Avvio…' : text.button}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pagina ───────────────────────────────

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Ok({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />{yes}</span>
    : <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3.5 w-3.5" />{no}</span>;
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.round(seconds)} s fa`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min fa`;
  return `${Math.round(seconds / 3600)} ore fa`;
}

function formatBackupAge(hours: number | null): string {
  if (hours === null) return 'mai eseguito';
  if (hours < 1) return 'meno di un\'ora fa';
  if (hours < 48) return `${Math.round(hours)} ore fa`;
  return `${Math.round(hours / 24)} giorni fa`;
}

function SyncStateView({ state, canWrite }: { state: CalV2SyncState; canWrite: boolean }) {
  const localizedPath = useLocalizedPath();
  const [hold, setHold] = useState<{ collection: CalV2CollectionState; action: HoldAction } | null>(null);
  const queryClient = useQueryClient();
  const guardActive = !!state.restore_guard_until && new Date(state.restore_guard_until).getTime() > Date.now();

  const refreshAfterHold = () => {
    void queryClient.invalidateQueries({ queryKey: calV2Keys.syncState });
    void queryClient.invalidateQueries({ queryKey: calV2Keys.calendars });
    void queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Modo e scritture">
          <dl className="space-y-1.5">
            <Row label="Modo">{MODE_LABEL[state.mode]}</Row>
            <Row label="Blocco delle scritture"><Ok ok={!state.write_freeze} yes="Nessuno" no="Attivo" /></Row>
            <Row label="Scritture sospese"><Ok ok={!state.writes_suspended} yes="No" no="Sì" /></Row>
            <Row label="Guardia dopo il ripristino">
              {guardActive && state.restore_guard_until
                ? <span className="text-amber-700 dark:text-amber-400">Attiva fino al {formatWhen(state.restore_guard_until)}</span>
                : <span className="text-muted-foreground">Non attiva</span>}
            </Row>
          </dl>
        </Section>

        <Section title="Identità del volume">
          <dl className="space-y-1.5">
            <Row label="Stato">
              <Ok ok={state.identity.status === 'ok'} yes="Verificata" no={state.identity.status === 'mismatch' ? 'Non corrisponde' : 'Sconosciuta'} />
            </Row>
            <Row label="Epoca">{state.identity.epoch}</Row>
            <Row label="Ultimo controllo">{formatWhen(state.identity.checked_at)}</Row>
            {state.identity.reason && <Row label="Motivo"><span className="break-all text-xs">{state.identity.reason}</span></Row>}
          </dl>
        </Section>

        <Section title="Heartbeat e canary">
          <dl className="space-y-1.5">
            <Row label="Heartbeat"><Ok ok={state.heartbeat.ok} yes={formatAge(state.heartbeat.age_seconds)} no={state.heartbeat.last_at ? `Fermo (ultimo segnale ${formatAge(state.heartbeat.age_seconds)})` : 'Mai ricevuto'} /></Row>
            <Row label="Controllo dei file">
              {state.canary.watch_mode === 'mount' ? 'Sul volume montato' : state.canary.watch_mode === 'remote' ? 'Tramite Radicale' : 'Spento'}
            </Row>
            <Row label="Volume"><Ok ok={!state.canary.mount_untrusted} yes="Affidabile" no="Non affidabile" /></Row>
            {state.canary.reason && <Row label="Motivo"><span className="break-all text-xs">{state.canary.reason}</span></Row>}
          </dl>
        </Section>

        <Section title="Indice e backup">
          <dl className="space-y-1.5">
            <Row label="Ricostruzione richiesta"><Ok ok={!state.index.rebuild_required} yes="No" no="Sì" /></Row>
            <Row label="Orizzonte dell'indice">{formatWhen(state.index.horizon_end)}</Row>
            <Row label="Override orfani">{state.index.orphan_overrides}</Row>
            <Row label="Ultimo backup coordinato">
              <span data-testid="cal-health-backup">
                <Ok
                  ok={!state.backup.stale}
                  yes={`${formatBackupAge(state.backup.age_hours)} (${formatWhen(state.backup.last_stack_backup_at)})`}
                  no={state.backup.last_stack_backup_at ? `Obsoleto: ${formatBackupAge(state.backup.age_hours)}` : 'Mai eseguito'}
                />
              </span>
            </Row>
          </dl>
        </Section>
      </div>

      <Section title={`Collezioni (${state.collections.length})`}>
        {state.collections.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nessuna collezione.</p>
        ) : (
          <div className="space-y-2">
            {state.collections.map((c) => (
              <div
                key={c.calendar_id}
                data-testid="cal-health-collection"
                data-health={c.health}
                data-calendar-id={c.calendar_id}
                className="space-y-2 rounded-md border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{c.calendar_name}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{c.collection_name ?? 'nessuna collezione'}</p>
                  </div>
                  <Badge
                    variant="outline"
                    className={c.health === 'healthy' ? 'text-emerald-700 dark:text-emerald-300' : 'border-amber-400 text-amber-700 dark:text-amber-300'}
                  >
                    {HEALTH_LABEL[c.health]}
                  </Badge>
                </div>
                <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  <Row label="Oggetti">{c.object_count}</Row>
                  <Row label="In quarantena">{c.quarantined_count}</Row>
                  <Row label="Cancellazioni sospese">{c.pending_deletions}</Row>
                  <Row label="Ultima sincronizzazione">{formatWhen(c.last_synced_at)}</Row>
                  <Row label="Ultima sync completa">{formatWhen(c.last_full_sync_at)}</Row>
                  <Row label="Da sincronizzare dal">{formatWhen(c.dirty_since)}</Row>
                  {c.consecutive_failures > 0 && <Row label="Errori consecutivi">{c.consecutive_failures}</Row>}
                  {c.sync_in_flight && <Row label="Sincronizzazione">in corso</Row>}
                </dl>
                {c.last_error && <p className="break-all text-xs text-destructive">Ultimo errore: {c.last_error}</p>}
                {c.health === 'hold' && (
                  <div className="space-y-2 border-t pt-2">
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      In sospeso{c.hold_reason ? `: ${HOLD_REASON_LABEL[c.hold_reason]}` : ''}
                      {c.hold_since ? ` dal ${formatWhen(c.hold_since)}` : ''}. Le scritture dei dispositivi su questa collezione sono ferme finché non scegli cosa fare.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {(['apply_deletions', 'rebuild_from_index'] as const).map((action) => (
                        <Button
                          key={action}
                          size="sm"
                          variant="outline"
                          data-testid={HOLD_ACTION_TEXT[action].testId}
                          disabled={!canWrite}
                          title={canWrite ? undefined : 'Le scritture sul calendario non sono disponibili in questo momento'}
                          onClick={() => setHold({ collection: c, action })}
                        >
                          {HOLD_ACTION_TEXT[action].button}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title={`Oggetti in quarantena (${state.quarantined.length})`} testId="cal-health-quarantined">
          {state.quarantined.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nessun oggetto in quarantena.</p>
          ) : (
            <ul className="space-y-1.5">
              {state.quarantined.map((q) => (
                <li key={q.object_id} className="rounded-md border px-2.5 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[11px]">{q.uid ?? q.href}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">{q.health === 'pending_404' ? 'Assente (404)' : 'Quarantena'}</Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    Dal {formatWhen(q.since)}{q.health_reason ? ` · ${q.health_reason}` : ''}
                    {q.has_last_good_version ? ' · c\'è un\'ultima versione buona' : ''}
                  </p>
                  <Link
                    to={`${localizedPath('/calendario')}?evento=${encodeURIComponent(q.object_id)}`}
                    className="mt-1 inline-block underline underline-offset-2 hover:text-foreground"
                  >
                    Apri nell&apos;editor
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="space-y-4">
          <Section title={`Job falliti (${state.failed_jobs.length})`}>
            {state.failed_jobs.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nessun job fallito.</p>
            ) : (
              <ul className="space-y-1.5">
                {state.failed_jobs.map((j) => (
                  <li key={j.id} className="rounded-md border px-2.5 py-2 text-xs">
                    <p className="font-medium">{j.kind} · {j.attempts} {j.attempts === 1 ? 'tentativo' : 'tentativi'} · {formatWhen(j.finished_at)}</p>
                    {j.last_error && <p className="break-all text-destructive">{j.last_error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Conflitti di prenotazione (${state.booking_conflicts.length})`}>
            {state.booking_conflicts.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nessun conflitto aperto.</p>
            ) : (
              <ul className="space-y-1.5">
                {state.booking_conflicts.map((c) => (
                  <li key={c.id} className="rounded-md border px-2.5 py-2 text-xs">
                    <p className="font-medium">Prenotazione del {formatWhen(c.booking_start)}</p>
                    <p className="text-muted-foreground">
                      Rilevato il {formatWhen(c.detected_at)} · {c.detected_by === 'auditor' ? 'controllo periodico' : 'dopo la conferma'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {state.booking_conflicts.length > 0 && (
              <Link to={localizedPath('/calendario/prenotazioni')} className="text-xs underline underline-offset-2 hover:text-foreground">
                Vai alle prenotazioni
              </Link>
            )}
          </Section>
        </div>
      </div>

      {hold && (
        <HoldActionDialog
          collection={hold.collection}
          action={hold.action}
          onClose={() => { setHold(null); refreshAfterHold(); }}
          onFinished={refreshAfterHold}
        />
      )}
    </div>
  );
}

export default function SaluteCalendarioPage() {
  const { caps, isLoading: capsLoading } = useCalendarV2Capabilities();
  const enabled = caps?.health_page === true;
  const { data, isLoading, error, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: calV2Keys.syncState,
    queryFn: getSyncStateV2,
    enabled,
    refetchInterval: SYNC_STATE_POLL_MS,
    retry: false,
  });

  useTopbar({
    title: 'Salute del calendario',
    subtitle: 'Sincronizzazione con Radicale, collezioni, quarantena e backup',
    actions: enabled ? (
      <Button size="sm" variant="outline" onClick={() => { void refetch(); }} disabled={isFetching}>
        <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Aggiorna
      </Button>
    ) : undefined,
  });

  return (
    <div className="space-y-6">
      <CalendarTabs />
      {capsLoading ? (
        <LoadingState />
      ) : !enabled ? (
        <EmptyState
          title="Salute del calendario non disponibile"
          description="Questa pagina compare quando il calendario è servito da Radicale e l'API la espone."
        />
      ) : isLoading ? (
        <LoadingState />
      ) : error && !data ? (
        <p role="alert" className="text-sm text-destructive">{calV2ErrorMessage(error)}</p>
      ) : data ? (
        <>
          <p className="text-xs text-muted-foreground">
            Aggiornato il {formatWhen(new Date(dataUpdatedAt || Date.parse(data.generated_at)).toISOString())}, poi ogni 20 secondi.
            {error ? ` Ultimo aggiornamento non riuscito: ${calV2ErrorMessage(error)}.` : ''}
          </p>
          <SyncStateView state={data} canWrite={caps?.objects.write === true} />
        </>
      ) : null}
    </div>
  );
}
