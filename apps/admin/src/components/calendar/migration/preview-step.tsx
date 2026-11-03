/**
 * Passo 2 del wizard di migrazione: anteprima e opzioni (design §13.4;
 * contratto f3-modules §7 e §11).
 *
 * Inventario (conteggi, anomalie, impatto delle iscrizioni, app-password,
 * stima) e anteprima del piano per calendario con le opzioni del design:
 * UNTIL "fino al", eccezioni DST, override orfani, eventi non di prenotazione
 * del calendario Prenotazioni da spostare uno per uno (decisione 8), flag per
 * singola iscrizione (decisione 5) con l'impatto mostrato prima.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ClipboardList, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useConfirm } from '@/hooks/use-confirm';
import { cn } from '@/lib/utils';
import {
  ACTION_LABELS,
  ANOMALY_DESCRIPTIONS,
  CONFLICT_LABELS,
  DEFAULT_MIGRATION_OPTIONS,
  findAction,
  formatAgo,
  formatDuration,
  migrationApi,
  migrationErrorMessage,
  migrationKeys,
  shortHash,
  SKIP_LABELS,
  type InventorySummary,
  type MigrationOptions,
  type MigrationStateView,
  type PlanAction,
  type PlanSummary,
  type SubscriptionMigrationView,
  type WizardStepView,
} from '@/lib/calendar-migration-api';
import { ActionButton, ActionReason, BlockingList, RunItemsTable, RunPanel, Section, Stat, StepStatusBadge } from './shared';
import { useCalendarNames, useRun, useRunMutation } from './hooks';

interface Props {
  state: MigrationStateView;
  step: WizardStepView;
}

const ACTIONS: PlanAction[] = ['create', 'update', 'delete', 'adopt', 'noop', 'skip', 'conflict'];

export function PreviewStep({ state, step }: Props) {
  // Anteprima mostrata: l'ultima riuscita (resta visibile mentre ne gira una nuova).
  const candidate = step.last_run_id && step.last_run_id !== state.active_run?.id ? step.last_run_id : null;
  const [shownPlanId, setShownPlanId] = useState<string | null>(candidate);
  useEffect(() => {
    if (candidate) setShownPlanId(candidate);
  }, [candidate]);
  const planId = candidate ?? shownPlanId;
  const plan = useRun<PlanSummary>(planId);
  const latestPlan = state.last_runs.plan ?? null;
  const inventoryRun = useRun<InventorySummary>(state.last_runs.inventory?.id ?? null);
  const planSummary = plan.data?.status === 'succeeded' ? plan.data.summary : null;
  const preview = planSummary?.preview ?? null;
  const calendarNames = useCalendarNames(state);

  const [options, setOptions] = useState<MigrationOptions>({ ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] });
  const [touched, setTouched] = useState(false);
  // Le opzioni partono da quelle dell'ultima anteprima (finché l'utente non le cambia).
  useEffect(() => {
    if (!touched && planSummary?.options) setOptions({ ...planSummary.options, bookings_move_event_ids: [...planSummary.options.bookings_move_event_ids] });
  }, [planSummary?.options, touched]);
  const update = (patch: Partial<MigrationOptions>) => {
    setTouched(true);
    setOptions((o) => ({ ...o, ...patch }));
  };

  const runInventory = useRunMutation((_: void, key) => migrationApi.inventory({}, key), { success: 'Inventario avviato' });
  const runPlan = useRunMutation((vars: MigrationOptions, key) => migrationApi.plan({ options: vars }, key), {
    success: 'Anteprima avviata',
    onCreated: () => setTouched(false),
  });
  const [filter, setFilter] = useState<PlanAction | 'all'>('conflict');

  const moveCandidates = preview?.bookings_move_candidates ?? [];
  const targetCalendars = (preview?.calendars ?? []).filter((c) => c.included && c.role === 'user');
  const conflicts = planSummary ? Object.entries(planSummary.conflicts).filter(([, n]) => (n ?? 0) > 0) : [];
  const skips = planSummary ? Object.entries(planSummary.skips).filter(([, n]) => (n ?? 0) > 0) : [];

  return (
    <div className="space-y-4">
      <Section title="Anteprima e opzioni" description={step.summary} actions={<StepStatusBadge status={step.status} />}>
        <BlockingList items={step.blocking} />
        <div className="grid gap-3 md:grid-cols-2">
          <OptionSwitch
            label='Correggi UNTIL "fino al"'
            hint="Le serie create dall'admin finiscono a fine giornata di Roma invece che a mezzanotte UTC."
            checked={options.fix_until_admin_pattern}
            onChange={(v) => update({ fix_until_admin_pattern: v })}
            affected={preview?.options.find((o) => o.key === 'fix_until_admin_pattern')?.affected}
          />
          <OptionSwitch
            label="Riallinea le eccezioni DST"
            hint="EXDATE e override salvati prima della correzione dell'ora legale tornano sull'occorrenza giusta."
            checked={options.realign_dst_exceptions}
            onChange={(v) => update({ realign_dst_exceptions: v })}
            affected={preview?.options.find((o) => o.key === 'realign_dst_exceptions')?.affected}
          />
          <div className="rounded-md border p-3 space-y-1.5">
            <Label className="text-xs font-medium">Override orfani</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={options.orphans} onChange={(e) => update({ orphans: e.target.value as MigrationOptions['orphans'] })}>
              <option value="convert">Convertiti in eventi singoli (consigliato)</option>
              <option value="discard">Scartati</option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              Override il cui RECURRENCE-ID non appartiene più alla regola.
              {preview ? ` Interessati: ${preview.options.find((o) => o.key === 'orphans')?.affected ?? 0}.` : ''}
            </p>
          </div>
          <div className="rounded-md border p-3 space-y-1.5">
            <Label className="text-xs font-medium">Regole fisse</Label>
            <ul className="text-[11px] text-muted-foreground space-y-0.5">
              {(preview?.fixed_rules ?? [
                { key: 'cancelled_masters', label: 'Master cancellati: non migrati', affected: 0 },
                { key: 'subscriptions_not_copied', label: 'Iscrizioni ICS: mai copiate nel volume', affected: 0 },
              ]).map((r) => <li key={r.key}>{r.label}{preview ? ` (${r.affected})` : ''}</li>)}
            </ul>
          </div>
        </div>

        {moveCandidates.length > 0 && (
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-xs font-medium">Eventi non di prenotazione nel calendario Prenotazioni (decisione 8)</p>
            <p className="text-[11px] text-muted-foreground">Restano lì di default (parità con oggi). Spunta quelli da spostare nella destinazione Radicale: Postgres non cambia.</p>
            <div className="space-y-1">
              {moveCandidates.map((c) => (
                <label key={c.event_id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={options.bookings_move_event_ids.includes(c.event_id)}
                    onChange={(e) => update({
                      bookings_move_event_ids: e.target.checked
                        ? [...options.bookings_move_event_ids, c.event_id]
                        : options.bookings_move_event_ids.filter((id) => id !== c.event_id),
                    })}
                  />
                  <span className="truncate">{c.summary ?? c.event_id}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span>Sposta in</span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={options.bookings_move_target_calendar_id ?? ''}
                onChange={(e) => update({ bookings_move_target_calendar_id: e.target.value || null })}
              >
                <option value="">Calendario di default</option>
                {targetCalendars.map((c) => <option key={c.calendar_id} value={c.calendar_id}>{c.name || c.slug}</option>)}
              </select>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <ActionButton action={findAction(step, 'plan')} pending={runPlan.isPending} onClick={() => runPlan.mutate(options)}>
            <Eye className="h-3.5 w-3.5" /> Genera anteprima
          </ActionButton>
          <ActionButton variant="outline" action={findAction(step, 'inventory')} pending={runInventory.isPending} onClick={() => runInventory.mutate()}>
            <ClipboardList className="h-3.5 w-3.5" /> Inventario
          </ActionButton>
          {touched && <span className="text-[11px] text-amber-600">Opzioni cambiate: rigenera l'anteprima</span>}
        </div>
        <ActionReason action={findAction(step, 'plan')} />
        {latestPlan && latestPlan.status !== 'succeeded' && latestPlan.id !== state.active_run?.id && <RunPanel run={latestPlan} compact />}
      </Section>

      {planSummary && plan.data && (
        <Section
          title="Piano"
          description={`Generato ${formatAgo(plan.data.finished_at)} · hash ${shortHash(planSummary.plan_hash)} · stima ${formatDuration(planSummary.estimate_seconds * 1000)}`}
        >
          <div className="flex flex-wrap gap-2">
            <Stat label="Scritture" value={planSummary.writes} />
            <Stat label="Da creare" value={planSummary.totals.create} />
            <Stat label="Da aggiornare" value={planSummary.totals.update} />
            <Stat label="Da eliminare" value={planSummary.totals.delete} tone={planSummary.totals.delete ? 'warn' : undefined} />
            <Stat label="Invariati" value={planSummary.totals.noop + planSummary.totals.adopt} />
            <Stat label="Saltati" value={planSummary.totals.skip} />
            <Stat label="Conflitti" value={planSummary.totals.conflict} tone={planSummary.totals.conflict ? 'bad' : 'ok'} />
          </div>
          {planSummary.revalidation_pending > 0 && (
            <p className="text-xs text-amber-600">{planSummary.revalidation_pending} righe del ledger da rivalidare (dopo un ripristino): diventano conflitti REVALIDATION_REQUIRED da forzare consapevolmente.</p>
          )}
          {(conflicts.length > 0 || skips.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {conflicts.map(([code, n]) => <Badge key={code} variant="outline" className="text-[10px] text-amber-700">{CONFLICT_LABELS[code] ?? code}: {n}</Badge>)}
              {skips.map(([code, n]) => <Badge key={code} variant="outline" className="text-[10px]">{SKIP_LABELS[code] ?? code}: {n}</Badge>)}
            </div>
          )}
          {preview && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-2 py-1.5">Calendario</th>
                    <th className="px-2 py-1.5">Collezione</th>
                    <th className="px-2 py-1.5 text-right">Oggetti</th>
                    {ACTIONS.map((a) => <th key={a} className="px-2 py-1.5 text-right">{ACTION_LABELS[a]}</th>)}
                    <th className="px-2 py-1.5">Anomalie</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.calendars.map((c) => (
                    <tr key={c.calendar_id} className={cn('border-t', !c.included && 'text-muted-foreground')}>
                      <td className="px-2 py-1.5">
                        <div className="font-medium">{c.name || c.slug}</div>
                        {!c.included && <div className="text-[10px]">Escluso: {c.excluded_reason}</div>}
                      </td>
                      <td className="px-2 py-1.5 font-mono">{c.collection_name ?? '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.objects}</td>
                      {ACTIONS.map((a) => (
                        <td key={a} className={cn('px-2 py-1.5 text-right tabular-nums', a === 'conflict' && c.counts[a] > 0 && 'text-red-600 font-medium')}>{c.counts[a] || ''}</td>
                      ))}
                      <td className="px-2 py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(c.anomalies).map(([code, n]) => <Badge key={code} variant="outline" className="text-[10px]" title={ANOMALY_DESCRIPTIONS[code]?.description}>{code} {n}</Badge>)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {preview && preview.anomalies.length > 0 && (
        <Section title="Anomalie" description="Classificate dal serializer: le bloccanti vanno corrette in Postgres prima dell'apply.">
          <div className="space-y-2">
            {preview.anomalies.map((a) => (
              <div key={a.code} className={cn('rounded-md border p-2.5 space-y-1', a.blocking && 'border-red-500/50 bg-red-500/5')}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn('text-[10px]', a.severity === 'error' && 'text-red-600', a.severity === 'warning' && 'text-amber-600')}>
                    {a.blocking ? 'Bloccante' : a.severity === 'error' ? 'Errore' : a.severity === 'warning' ? 'Avviso' : 'Informazione'}
                  </Badge>
                  <span className="font-mono text-xs">{a.code}</span>
                  <span className="text-xs text-muted-foreground">× {a.count}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">{a.description}</p>
                {a.examples.length > 0 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-muted-foreground">Esempi</summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[10px] whitespace-pre-wrap break-all">{JSON.stringify(a.examples, null, 2)}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      <SubscriptionsSection />

      {planId && planSummary && (
        <Section
          title="Oggetti del piano"
          description="Drill-down sulle righe dell'anteprima."
          actions={(
            <select className="h-8 rounded-md border bg-background px-2 text-xs" value={filter} onChange={(e) => setFilter(e.target.value as PlanAction | 'all')}>
              <option value="all">Tutte le azioni</option>
              {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
            </select>
          )}
        >
          <RunItemsTable
            key={`${planId}-${filter}`}
            runId={planId}
            filter={{ item_type: 'object', ...(filter === 'all' ? {} : { action: filter }) }}
            calendarNames={calendarNames}
            emptyText={filter === 'conflict' ? 'Nessun conflitto nel piano.' : 'Nessuna riga con questo filtro.'}
          />
        </Section>
      )}

      {inventoryRun.data?.status === 'succeeded' && inventoryRun.data.summary && (
        <InventorySection inventory={inventoryRun.data.summary} finishedAt={inventoryRun.data.finished_at} />
      )}
    </div>
  );
}

function OptionSwitch({ label, hint, checked, onChange, affected }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; affected?: number }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border p-3">
      <div className="space-y-0.5">
        <p className="text-xs font-medium">{label}</p>
        <p className="text-[11px] text-muted-foreground">{hint}{affected !== undefined ? ` Interessati: ${affected}.` : ''}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function InventorySection({ inventory, finishedAt }: { inventory: InventorySummary; finishedAt: string | null }) {
  const t = inventory.totals;
  return (
    <Section title="Inventario" description={`Eseguito ${formatAgo(finishedAt)} · stima dell'apply ${formatDuration(inventory.estimate.seconds * 1000)} per ${inventory.estimate.objects} oggetti`}>
      <div className="flex flex-wrap gap-2">
        <Stat label="Righe" value={t.rows} />
        <Stat label="Singoli" value={t.singles_timed + t.singles_all_day} hint={`${t.singles_all_day} tutto il giorno`} />
        <Stat label="Serie" value={t.series} />
        <Stat label="Override" value={t.overrides_modified} hint={`${t.overrides_cancelled} cancellati → EXDATE`} />
        <Stat label="Proiezioni" value={t.projections} />
        <Stat label="Festività" value={t.holidays_system} hint={`${t.closures} chiusure`} />
        <Stat label="App-password" value={inventory.app_passwords.active} hint={`${inventory.app_passwords.non_canonical} con altro username`} tone={inventory.app_passwords.reserved ? 'bad' : undefined} />
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-2 py-1.5">Calendario</th>
              <th className="px-2 py-1.5 text-right">Righe</th>
              <th className="px-2 py-1.5 text-right">Singoli</th>
              <th className="px-2 py-1.5 text-right">Serie</th>
              <th className="px-2 py-1.5 text-right">Override</th>
              <th className="px-2 py-1.5 text-right">EXDATE</th>
              <th className="px-2 py-1.5">Anomalie</th>
            </tr>
          </thead>
          <tbody>
            {inventory.calendars.map((c) => (
              <tr key={c.calendar_id} className={cn('border-t', !c.included && 'text-muted-foreground')}>
                <td className="px-2 py-1.5">{c.name || c.slug} <span className="font-mono text-[10px] text-muted-foreground">/{c.collection_name ?? c.slug}</span></td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.counts.rows}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.counts.singles_timed + c.counts.singles_all_day}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.counts.series}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.counts.overrides_modified + c.counts.overrides_cancelled}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.counts.exdates}</td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(c.anomalies).map(([code, n]) => <Badge key={code} variant="outline" className="text-[10px]" title={ANOMALY_DESCRIPTIONS[code]?.description}>{code} {n}</Badge>)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Iscrizioni ICS con l'impatto di "blocca disponibilità" e i flag per singola iscrizione (decisione 5). */
function SubscriptionsSection() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const subs = useQuery({ queryKey: migrationKeys.subscriptions, queryFn: migrationApi.subscriptions });
  const flags = useMutation({
    mutationFn: (vars: { id: string; blocks_availability?: boolean; device_visible?: boolean }) =>
      migrationApi.subscriptionFlags(vars.id, { blocks_availability: vars.blocks_availability, device_visible: vars.device_visible }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: migrationKeys.subscriptions });
      void queryClient.invalidateQueries({ queryKey: migrationKeys.state });
      toast.success(res.collection_missing
        ? 'Flag salvati. La collezione sub-* non esiste ancora: usa "Crea collezioni mancanti" al passo 1'
        : 'Flag dell\'iscrizione salvati');
    },
    onError: (err) => toast.error(migrationErrorMessage(err)),
  });
  const list: SubscriptionMigrationView[] = useMemo(() => subs.data?.subscriptions ?? [], [subs.data]);
  if (subs.isLoading) return null;
  if (subs.isError) return <Section title="Iscrizioni ICS"><p className="text-xs text-red-600">{migrationErrorMessage(subs.error)}</p></Section>;
  if (list.length === 0) return null;

  const toggleBlocks = async (s: SubscriptionMigrationView, value: boolean) => {
    if (value) {
      const lost = s.impact ? Object.values(s.impact.slots_lost_per_week).reduce((a, b) => a + b, 0) : 0;
      const ok = await confirm({
        title: `Bloccare la disponibilità con "${s.name}"?`,
        description: s.impact
          ? `Sulle prossime ${s.impact.weeks} settimane: circa ${s.impact.busy_hours_per_week.toFixed(1)} ore occupate e ${lost} slot pubblici persi a settimana. Vale dopo il passaggio: in modalità Postgres il busy non cambia.`
          : 'L\'impatto non è stato calcolato. Vale dopo il passaggio: in modalità Postgres il busy non cambia.',
        confirmText: 'Blocca disponibilità',
        variant: 'default',
      });
      if (!ok) return;
    }
    flags.mutate({ id: s.subscription_id, blocks_availability: value });
  };

  return (
    <Section title="Iscrizioni ICS" description="Mai copiate nel volume. Per ognuna decidi se bloccherà la disponibilità e se i device la vedranno (default: nascosta e non bloccante).">
      <div className="space-y-2">
        {list.map((s) => (
          <div key={s.subscription_id} className="flex flex-col gap-2 rounded-md border p-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs font-medium">{s.name} {s.url_host && <span className="font-mono text-[10px] text-muted-foreground">({s.url_host})</span>}</p>
              <p className="text-[11px] text-muted-foreground">
                {s.events_legacy} eventi · {s.impact ? `impatto se bloccasse: ${s.impact.busy_hours_per_week.toFixed(1)} h/settimana, slot persi ${Object.entries(s.impact.slots_lost_per_week).map(([k, v]) => `${k} ${v}`).join(', ') || '0'}` : 'impatto non calcolato'}
                {s.device_visible && s.collection_exists === false ? ' · collezione sub-* mancante' : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-2">
                <Switch checked={s.blocks_availability} disabled={flags.isPending} onCheckedChange={(v) => toggleBlocks(s, v)} aria-label="Blocca disponibilità" />
                Blocca disponibilità
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={s.device_visible} disabled={flags.isPending} onCheckedChange={(v) => flags.mutate({ id: s.subscription_id, device_visible: v })} aria-label="Visibile sui device" />
                Visibile sui device
              </label>
            </div>
          </div>
        ))}
      </div>
      <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => subs.refetch()}>Aggiorna impatto</Button>
    </Section>
  );
}
