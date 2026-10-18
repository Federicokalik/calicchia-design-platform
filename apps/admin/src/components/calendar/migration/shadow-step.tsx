/**
 * Passo 5 del wizard di migrazione: shadow mirror e prova sui device (design
 * §13.8; contratto f3-modules §9, §11 e §14.2).
 *
 * Con lo shadow acceso ogni scrittura legacy arriva su Radicale (patch per
 * campo, i device restano in sola lettura); ogni notte un apply completo con
 * la verifica V1-V5, ogni ora V4 sui prossimi 14 giorni. Servono almeno 7
 * giorni di parità verde e la matrice device superata prima del passaggio.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Power, PowerOff, Smartphone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfirm } from '@/hooks/use-confirm';
import {
  COLOR_LABELS,
  findAction,
  formatAgo,
  formatDateTime,
  MIGRATION_CONFIRMATIONS,
  migrationApi,
  migrationErrorMessage,
  migrationKeys,
  RUN_KIND_LABELS,
  RUN_TRIGGER_LABELS,
  type DeclarationValues,
  type MigrationStateView,
  type WizardStepView,
} from '@/lib/calendar-migration-api';
import { ActionButton, ActionReason, BlockingList, ColorDot, ConfirmPhraseDialog, Section, Stat, StepStatusBadge } from './shared';

interface Props {
  state: MigrationStateView;
  step: WizardStepView;
}

const DEVICES: Array<{ id: DeclarationValues['device_matrix']['devices'][number]; label: string }> = [
  { id: 'ios', label: 'iOS' },
  { id: 'macos', label: 'macOS' },
  { id: 'davx5', label: 'DAVx5 (Android)' },
  { id: 'thunderbird', label: 'Thunderbird' },
];

export function ShadowStep({ state, step }: Props) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const shadowOn = state.backend.shadow_enabled;
  const parity = useQuery({
    queryKey: migrationKeys.parity,
    queryFn: migrationApi.parity,
    refetchInterval: shadowOn ? 15_000 : false,
  });
  const [openOn, setOpenOn] = useState(false);
  const [openMatrix, setOpenMatrix] = useState(false);

  const shadow = useMutation({
    mutationFn: (vars: { enabled: boolean; confirm?: string }) => migrationApi.shadow(vars),
    onSuccess: (res) => {
      setOpenOn(false);
      void queryClient.invalidateQueries({ queryKey: migrationKeys.all });
      if (res.shadow_enabled) {
        toast.success(res.catch_up_run ? 'Shadow attivo: apply di recupero avviato' : 'Shadow attivo: il recupero lo farà il giro notturno');
      } else {
        toast.success('Shadow spento: Postgres continua da solo, Radicale non riceve più le modifiche');
      }
    },
    onError: (err) => toast.error(migrationErrorMessage(err)),
  });

  const p = parity.data;
  const matrix = state.declarations.device_matrix;

  return (
    <div className="space-y-4">
      <Section title="Shadow e prova sui device" description={step.summary} actions={<StepStatusBadge status={step.status} />}>
        <BlockingList items={step.blocking} />
        <div className="flex flex-wrap items-center gap-2">
          {shadowOn ? (
            <Badge variant="outline" className="gap-1.5 text-[11px] text-emerald-700"><ColorDot color="green" /> Shadow attivo da {formatDateTime(state.backend.shadow_since)}</Badge>
          ) : (
            <Badge variant="outline" className="text-[11px]">Shadow spento</Badge>
          )}
          <Badge variant="outline" className="text-[11px]">Coda: {state.shadow_queue.pending} in attesa · {state.shadow_queue.running} in corso · {state.shadow_queue.dead} in errore</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {!shadowOn ? (
            <ActionButton action={findAction(step, 'shadow_on')} pending={shadow.isPending} onClick={() => setOpenOn(true)}>
              <Power className="h-3.5 w-3.5" /> Attiva shadow
            </ActionButton>
          ) : (
            <ActionButton
              variant="outline"
              action={findAction(step, 'shadow_off')}
              pending={shadow.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Spegnere lo shadow mirror?',
                  description: 'Le modifiche fatte in Postgres smettono di arrivare su Radicale e il conteggio della parità riparte da zero alla prossima attivazione. Postgres resta autorevole: nessun dato si perde.',
                  confirmText: 'Spegni shadow',
                });
                if (ok) shadow.mutate({ enabled: false });
              }}
            >
              <PowerOff className="h-3.5 w-3.5" /> Disattiva shadow
            </ActionButton>
          )}
          <Button size="sm" variant="outline" onClick={() => setOpenMatrix(true)}>
            <Smartphone className="h-3.5 w-3.5" /> {matrix ? 'Aggiorna matrice device' : 'Registra matrice device'}
          </Button>
        </div>
        <ActionReason action={findAction(step, shadowOn ? 'shadow_off' : 'shadow_on')} />
      </Section>

      <Section title="Parità" description={`Servono ${p?.required_days ?? 7} giorni di giri verdi, con un giro notturno verde per ogni giorno.`}>
        {parity.isLoading && <p className="text-xs text-muted-foreground">Caricamento della parità…</p>}
        {parity.isError && <p className="text-xs text-red-600">{migrationErrorMessage(parity.error)}</p>}
        {p && (
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span>{p.days_green} di {p.required_days} giorni verdi{p.green_since ? ` (dal ${formatDateTime(p.green_since)})` : ''}</span>
                {p.satisfied ? <Badge variant="outline" className="text-[10px] text-emerald-700">Parità soddisfatta</Badge> : null}
              </div>
              <Progress value={Math.min(p.days_green, p.required_days)} max={p.required_days} className="h-1.5" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Stat
                label="Ultimo giro notturno"
                value={p.last_nightly?.color
                  ? `${COLOR_LABELS[p.last_nightly.color]}${p.last_nightly.color === 'yellow' && p.last_nightly.green ? ' (accettato)' : ''}`
                  : '—'}
                hint={p.last_nightly?.finished_at ? formatAgo(p.last_nightly.finished_at) : 'mai'}
                tone={p.last_nightly?.green ? 'ok' : p.last_nightly?.green === false ? 'bad' : undefined}
              />
              <Stat
                label="Ultimo giro orario (V4)"
                value={p.last_hourly ? COLOR_LABELS[p.last_hourly.color] : '—'}
                hint={p.last_hourly ? formatAgo(p.last_hourly.finished_at) : 'mai'}
                tone={p.last_hourly?.color === 'green' ? 'ok' : p.last_hourly ? 'bad' : undefined}
              />
              <Stat label="Conflitti aperti" value={p.open_conflicts} tone={p.open_conflicts ? 'bad' : 'ok'} />
              <Stat label="Coda" value={p.queue.pending} hint={p.queue.oldest_pending_at ? `più vecchio ${formatAgo(p.queue.oldest_pending_at)}` : `${p.queue.dead} in errore`} tone={p.queue.dead ? 'bad' : undefined} />
            </div>
            {p.recent.length > 0 && (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-2 py-1.5">Giro</th>
                      <th className="px-2 py-1.5">Origine</th>
                      <th className="px-2 py-1.5">Concluso</th>
                      <th className="px-2 py-1.5">Esito</th>
                      <th className="px-2 py-1.5 text-right">Scritture</th>
                      <th className="px-2 py-1.5 text-right">Conflitti</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.recent.map((r) => (
                      <tr key={r.run_id} className="border-t">
                        <td className="px-2 py-1.5">{RUN_KIND_LABELS[r.kind]}</td>
                        <td className="px-2 py-1.5">{RUN_TRIGGER_LABELS[r.trigger]}</td>
                        <td className="px-2 py-1.5">{formatDateTime(r.finished_at)}</td>
                        <td className="px-2 py-1.5">{r.color ? <span className="inline-flex items-center gap-1.5"><ColorDot color={r.color} />{COLOR_LABELS[r.color]}</span> : '—'}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.writes ?? ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.conflicts ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Matrice device" description="Prova in staging su iOS, macOS, DAVx5 e Thunderbird (docs/calendar-radicale/matrice-device.md): sola lettura in shadow, nessuna password invalidata, collezioni protette, If-Match, X-prop e VALARM, TRANSP degli all-day.">
        {matrix ? (
          <div className="text-xs space-y-1">
            <p>
              Esito: <span className={matrix.value.result === 'passed' ? 'text-emerald-700 font-medium' : 'text-red-600 font-medium'}>{matrix.value.result === 'passed' ? 'superata' : 'non superata'}</span>
              {' '}· {formatDateTime(matrix.at)}
            </p>
            <p className="text-muted-foreground">
              Device: {matrix.value.devices.map((d) => DEVICES.find((x) => x.id === d)?.label ?? d).join(', ')} ·
              strict_preconditions {matrix.value.strict_preconditions ? 'attivo' : 'spento'} ·
              all-day {matrix.value.allday_transp_rule === 'opaque_blocks' ? 'bloccano solo con TRANSP:OPAQUE' : 'non bloccano mai'}
            </p>
            {matrix.value.notes && <p className="text-muted-foreground">Note: {matrix.value.notes}</p>}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Esito non ancora registrato.</p>
        )}
      </Section>

      <ConfirmPhraseDialog
        open={openOn}
        onOpenChange={setOpenOn}
        title="Attiva lo shadow mirror"
        phrase={MIGRATION_CONFIRMATIONS.shadowOn}
        confirmLabel="Attiva shadow"
        pending={shadow.isPending}
        error={shadow.isError ? migrationErrorMessage(shadow.error) : null}
        onConfirm={({ phrase }) => shadow.mutate({ enabled: true, confirm: phrase })}
        description={
          <>
            <p>Da adesso ogni modifica del calendario in Postgres viene copiata su Radicale pochi secondi dopo. Postgres resta autorevole e i device restano in sola lettura.</p>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>Parte subito un apply di recupero per le modifiche precedenti.</li>
              <li>Ogni notte: apply completo e verifica V1-V5. Ogni ora: verifica del busy sui prossimi 14 giorni.</li>
              <li>Puoi spegnerlo in qualsiasi momento senza perdere dati.</li>
            </ul>
          </>
        }
      />
      <DeviceMatrixDialog key={openMatrix ? 'matrix-open' : 'matrix-closed'} open={openMatrix} onOpenChange={setOpenMatrix} initial={matrix?.value ?? null} />
    </div>
  );
}

function DeviceMatrixDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (o: boolean) => void; initial: DeclarationValues['device_matrix'] | null }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<'passed' | 'failed'>(initial?.result ?? 'passed');
  const [strict, setStrict] = useState(initial?.strict_preconditions ?? true);
  const [rule, setRule] = useState<'opaque_blocks' | 'never_block'>(initial?.allday_transp_rule ?? 'opaque_blocks');
  const [devices, setDevices] = useState<Set<DeclarationValues['device_matrix']['devices'][number]>>(new Set(initial?.devices ?? ['ios', 'macos', 'davx5', 'thunderbird']));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const save = useMutation({
    mutationFn: () => migrationApi.declare({
      key: 'device_matrix',
      value: { result, strict_preconditions: strict, allday_transp_rule: rule, devices: [...devices], notes: notes.trim() || null },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: migrationKeys.all });
      toast.success('Matrice device registrata');
      onOpenChange(false);
    },
    onError: (err) => toast.error(migrationErrorMessage(err)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Matrice device</DialogTitle>
          <DialogDescription>Esito della prova in staging e le due decisioni da documentare (strict_preconditions e TRANSP degli all-day, decisione 6).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label className="text-xs">Esito</Label>
            <div className="flex gap-4 text-xs">
              <label className="flex items-center gap-2"><input type="radio" name="matrix-result" checked={result === 'passed'} onChange={() => setResult('passed')} /> Superata</label>
              <label className="flex items-center gap-2"><input type="radio" name="matrix-result" checked={result === 'failed'} onChange={() => setResult('failed')} /> Non superata</label>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Device provati</Label>
            <div className="flex flex-wrap gap-3 text-xs">
              {DEVICES.map((d) => (
                <label key={d.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={devices.has(d.id)}
                    onChange={(e) => {
                      const next = new Set(devices);
                      if (e.target.checked) next.add(d.id); else next.delete(d.id);
                      setDevices(next);
                    }}
                  />
                  {d.label}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-md border p-2.5 text-xs">
            <span>
              <span className="font-medium">strict_preconditions di Radicale</span>
              <span className="block text-muted-foreground">If-Match obbligatorio per le modifiche dei device (consigliato se tutti i client lo mandano).</span>
            </span>
            <Switch checked={strict} onCheckedChange={setStrict} aria-label="strict_preconditions" />
          </label>
          <div className="space-y-1.5">
            <Label className="text-xs">All-day creati dai device</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={rule} onChange={(e) => setRule(e.target.value as typeof rule)}>
              <option value="opaque_blocks">Bloccano solo con "Mostra come: occupato" (TRANSP:OPAQUE)</option>
              <option value="never_block">Non bloccano mai</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Note (facoltative)</Label>
            <Textarea rows={3} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button disabled={save.isPending || devices.size === 0} onClick={() => save.mutate()}>Registra</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
