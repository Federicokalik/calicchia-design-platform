/**
 * Passo 1 del wizard di migrazione: prerequisiti e inizializzazione (design
 * §13.3; contratto f3-modules §6.1.1, §11 e §12).
 *
 * Preflight in sola lettura (con l'unica PUT del probe su `_canary`, che deve
 * ricevere 403), "Inizializza Radicale" su un volume vuoto, "Crea collezioni
 * mancanti", archivio della Fase 0, riassegnazione d'identità con il diff, e
 * le dichiarazioni esplicite che sbloccano i controlli da confermare.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileUp, Fingerprint, FolderPlus, Play, Rocket, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  ARCHIVE_MAX_BYTES,
  DECLARATION_LABELS,
  findAction,
  formatAgo,
  formatDateTime,
  IDENTITY_LABELS,
  MIGRATION_CONFIRMATIONS,
  migrationApi,
  migrationErrorMessage,
  migrationKeys,
  PREFLIGHT_CHECK_LABELS,
  type DeclarationKey,
  type DeclarationValues,
  type MigrationStateView,
  type PreflightCheck,
  type PreflightSummary,
  type WizardStepView,
} from '@/lib/calendar-migration-api';
import { ActionButton, ActionReason, BlockingList, CheckStatusBadge, ConfirmPhraseDialog, RunPanel, Section, StepStatusBadge } from './shared';
import { useRun, useRunMutation } from './hooks';

interface Props {
  state: MigrationStateView;
  step: WizardStepView;
}

export function PreflightStep({ state, step }: Props) {
  // Ultimo preflight riuscito: resta visibile mentre gira un altro run del passo.
  const candidate = step.last_run_id && step.last_run_id !== state.active_run?.id ? step.last_run_id : null;
  const [preflightRunId, setPreflightRunId] = useState<string | null>(candidate);
  useEffect(() => {
    if (candidate) setPreflightRunId(candidate);
  }, [candidate]);
  const preflight = useRun<PreflightSummary>(preflightRunId);
  const summary = preflight.data?.status === 'succeeded' ? preflight.data.summary : null;
  const [probePublic, setProbePublic] = useState(true);
  const [dialog, setDialog] = useState<null | 'initialize' | 'create' | 'archive' | 'identity'>(null);
  const [declare, setDeclare] = useState<DeclarationKey | null>(null);

  const runPreflight = useRunMutation((vars: { probe: boolean }, key) => migrationApi.preflight({ probe_public_url: vars.probe }, key), { success: 'Preflight avviato' });
  const init = useRunMutation((vars: { action: 'initialize' | 'create_missing'; confirm: string }, key) => migrationApi.init(vars, key), {
    onCreated: () => setDialog(null),
  });

  const lastPrereqRun = [state.last_runs.init, state.last_runs.archive, state.last_runs.identity, state.last_runs.preflight]
    .filter((r): r is NonNullable<typeof r> => !!r)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  return (
    <div className="space-y-4">
      <Section
        title="Prerequisiti e inizializzazione"
        description={step.summary}
        actions={<StepStatusBadge status={step.status} />}
      >
        <BlockingList items={step.blocking} />
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <ActionButton action={findAction(step, 'preflight')} pending={runPreflight.isPending} onClick={() => runPreflight.mutate({ probe: probePublic })}>
            <Play className="h-3.5 w-3.5" /> Esegui preflight
          </ActionButton>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={probePublic} onCheckedChange={setProbePublic} aria-label="Prova l'URL pubblico" />
            Prova il 401 sull'URL pubblico
          </label>
        </div>
        <ActionReason action={findAction(step, 'preflight')} />
        <div className="flex flex-wrap gap-2 border-t pt-3">
          <ActionButton variant="outline" action={findAction(step, 'initialize')} onClick={() => setDialog('initialize')}>
            <Rocket className="h-3.5 w-3.5" /> Inizializza Radicale
          </ActionButton>
          <ActionButton variant="outline" action={findAction(step, 'create_collections')} onClick={() => setDialog('create')}>
            <FolderPlus className="h-3.5 w-3.5" /> Crea collezioni mancanti
          </ActionButton>
          <ActionButton variant="outline" action={findAction(step, 'archive')} onClick={() => setDialog('archive')}>
            <FileUp className="h-3.5 w-3.5" /> Importa archivio Fase 0
          </ActionButton>
          <ActionButton variant="outline" action={findAction(step, 'identity_reassign')} onClick={() => setDialog('identity')}>
            <Fingerprint className="h-3.5 w-3.5" /> Riassegna identità
          </ActionButton>
        </div>
        {lastPrereqRun && lastPrereqRun.id !== state.active_run?.id && <RunPanel run={lastPrereqRun} compact />}
      </Section>

      <Section title="Volume e identità" description="Postgres resta autorevole: il volume di Radicale è in sola lettura per i device finché non arriva il passaggio (F4).">
        <div className="grid gap-2 sm:grid-cols-2 text-xs">
          <InfoRow label="Radicale configurato" value={state.radicale.configured ? 'Sì' : 'No'} />
          <InfoRow label="Identità del volume" value={IDENTITY_LABELS[state.identity.status] ?? state.identity.status} hint={state.identity.detail ?? undefined} />
          <InfoRow label="Volume (volume-id)" value={state.backend.volume_id ?? '—'} mono />
          <InfoRow label="Epoch" value={String(state.backend.epoch)} />
          <InfoRow label="Campanello" value={state.radicale.watch_mode === 'mount' ? 'Mount (inotify e canary)' : state.radicale.watch_mode === 'remote' ? 'Remote mode' : 'Spento'} />
          <InfoRow
            label="Ultimo backup coordinato"
            value={state.last_stack_backup ? `${formatDateTime(state.last_stack_backup.at)}${state.last_stack_backup.complete ? '' : ' (incompleto)'}` : 'Nessuno registrato'}
          />
        </div>
      </Section>

      <Section
        title="Controlli dell'ultimo preflight"
        description={preflight.data ? `Eseguito ${formatAgo(preflight.data.finished_at ?? preflight.data.created_at)}` : 'Nessun preflight eseguito'}
      >
        {summary ? <ChecksTable checks={summary.checks} onDeclare={setDeclare} /> : <p className="text-xs text-muted-foreground">Esegui il preflight per vedere i controlli.</p>}
      </Section>

      <Section title="Dichiarazioni" description="Le conferme esplicite che sbloccano i controlli che il sistema non può verificare da solo.">
        <div className="grid gap-2 sm:grid-cols-2">
          {(['phase0', 'remote_mode_accepted', 'public_401_verified', 'backup_verified'] as const).map((key) => {
            const d = state.declarations[key];
            return (
              <div key={key} className="rounded-md border p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">{DECLARATION_LABELS[key]}</p>
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setDeclare(key)}>{d ? 'Aggiorna' : 'Dichiara'}</Button>
                </div>
                <p className="text-[11px] text-muted-foreground">{d ? `${declarationSummary(key, d.value)} · ${formatDateTime(d.at)}` : 'Non dichiarato'}</p>
              </div>
            );
          })}
        </div>
      </Section>

      <ConfirmPhraseDialog
        open={dialog === 'initialize'}
        onOpenChange={(o) => setDialog(o ? 'initialize' : null)}
        title="Inizializza Radicale"
        phrase={MIGRATION_CONFIRMATIONS.initialize}
        confirmLabel="Inizializza"
        pending={init.isPending}
        error={init.isError ? migrationErrorMessage(init.error) : null}
        onConfirm={({ phrase }) => init.mutate({ action: 'initialize', confirm: phrase })}
        description={
          <>
            <p>È l'unico punto che crea collezioni. Su un volume vuoto:</p>
            <ol className="list-decimal pl-5 space-y-0.5">
              <li>crea il principal del calendario;</li>
              <li>scrive l'identità del volume (volume-id generato e salvato in Postgres, epoch 1);</li>
              <li>crea le collezioni con gli slug esatti di oggi (compresi <span className="font-mono">c</span> e <span className="font-mono">f</span>), così i percorsi dei device non cambiano;</li>
              <li>crea la collezione di controllo <span className="font-mono">_canary</span>.</li>
            </ol>
            <p>Nessun evento viene copiato: lo fa l'apply. Si rifiuta su un volume non vuoto o con un'altra identità.</p>
          </>
        }
      />
      <ConfirmPhraseDialog
        open={dialog === 'create'}
        onOpenChange={(o) => setDialog(o ? 'create' : null)}
        title="Crea collezioni mancanti"
        phrase={MIGRATION_CONFIRMATIONS.createCollections}
        confirmLabel="Crea collezioni"
        pending={init.isPending}
        error={init.isError ? migrationErrorMessage(init.error) : null}
        onConfirm={({ phrase }) => init.mutate({ action: 'create_missing', confirm: phrase })}
        description={
          <>
            <p>Crea solo le collezioni del piano che mancano sul volume già inizializzato (identità verificata). Una collezione presente con un altro calendario non viene mai toccata.</p>
            {summary && summary.missing_collections.length > 0 && (
              <p>Mancanti secondo l'ultimo preflight: <span className="font-mono">{summary.missing_collections.join(', ')}</span></p>
            )}
          </>
        }
      />
      <ArchiveDialog open={dialog === 'archive'} onOpenChange={(o) => setDialog(o ? 'archive' : null)} />
      <IdentityDialog open={dialog === 'identity'} onOpenChange={(o) => setDialog(o ? 'identity' : null)} />
      <DeclarationDialog keyName={declare} state={state} summary={summary} onClose={() => setDeclare(null)} />
    </div>
  );
}

function InfoRow({ label, value, hint, mono }: { label: string; value: string; hint?: string; mono?: boolean }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? 'font-mono text-[11px] break-all' : 'text-sm'}>{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ChecksTable({ checks, onDeclare }: { checks: PreflightCheck[]; onDeclare: (key: DeclarationKey) => void }) {
  const order: Record<string, number> = { fail: 0, confirm: 1, warn: 2, pass: 3, skip: 4 };
  const sorted = [...checks].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  return (
    <div className="divide-y rounded-md border">
      {sorted.map((c) => (
        <div key={c.code} className="flex flex-col gap-1 p-2.5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <CheckStatusBadge status={c.status} declared={c.declared} />
              <span className="text-xs font-medium">{PREFLIGHT_CHECK_LABELS[c.code] ?? c.code}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{c.message}</p>
            {c.remedy && <pre className="mt-1 max-w-full overflow-x-auto rounded bg-muted px-2 py-1 text-[10px] whitespace-pre-wrap break-all">{c.remedy}</pre>}
          </div>
          {c.declaration && (c.status === 'confirm' || c.declared) && (
            <Button size="sm" variant="outline" className="h-7 shrink-0 text-[11px]" onClick={() => onDeclare(c.declaration as DeclarationKey)}>
              <ShieldCheck className="h-3.5 w-3.5" /> {c.declared ? 'Aggiorna dichiarazione' : 'Dichiara'}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function declarationSummary(key: DeclarationKey, value: unknown): string {
  const v = (value ?? {}) as Record<string, unknown>;
  switch (key) {
    case 'phase0':
      return v.status === 'absent' ? 'Volume della Fase 0 assente' : v.status === 'archived' ? 'Archiviato nella collezione archivio-fase0' : 'Presente, non importato';
    case 'remote_mode_accepted':
      return `Accettata: ${String(v.reason ?? '')}`;
    case 'public_401_verified':
      return `Verificato (${String(v.method ?? '')})`;
    case 'backup_verified':
      return 'Backup verificato a mano';
    case 'device_matrix':
      return v.result === 'passed' ? 'Superata' : 'Non superata';
    default:
      return '';
  }
}

/** Dialog delle dichiarazioni del passo 1 (le tre che tolgono un controllo chiedono CONFERMO). */
function DeclarationDialog({ keyName, state, summary, onClose }: { keyName: DeclarationKey | null; state: MigrationStateView; summary: PreflightSummary | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [phase0, setPhase0] = useState<'absent' | 'present_not_imported'>('absent');
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'curl' | 'browser' | 'other'>('curl');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: async (vars: { confirm?: string }) => {
      if (!keyName) throw new Error('Nessuna dichiarazione');
      const value: DeclarationValues[DeclarationKey] = keyName === 'phase0' ? { status: phase0, note: note || null }
        : keyName === 'remote_mode_accepted' ? { reason }
          : keyName === 'public_401_verified' ? { method, note: note || null }
            : { note: note || null };
      return migrationApi.declare({ key: keyName, value, confirm: vars.confirm } as Parameters<typeof migrationApi.declare>[0]);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: migrationKeys.all });
      toast.success('Dichiarazione registrata: ripeti il preflight per aggiornare i controlli');
      onClose();
    },
    onError: (err) => toast.error(migrationErrorMessage(err)),
  });
  if (!keyName || keyName === 'device_matrix') return null;
  const waiver = keyName !== 'phase0';
  const remedy = summary?.checks.find((c) => c.code === 'SERVICE_PUBLIC_401')?.remedy ?? null;
  const fields = (
    <div className="space-y-3">
      {keyName === 'phase0' && (
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="radio" name="phase0" className="mt-1" checked={phase0 === 'absent'} onChange={() => setPhase0('absent')} />
            <span>Il vecchio volume <span className="font-mono">radicale_data</span> della Fase 0 non esiste (<span className="font-mono">radicale-maint.sh phase0-detect</span> non lo trova).</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="phase0" className="mt-1" checked={phase0 === 'present_not_imported'} onChange={() => setPhase0('present_not_imported')} />
            <span>Esiste ma non lo importo (resta il backup tar fatto con <span className="font-mono">phase0-backup</span>).</span>
          </label>
          <p className="text-xs text-muted-foreground">Per importarlo usa "Importa archivio Fase 0": a import riuscito la dichiarazione diventa "archiviato" da sola.</p>
        </div>
      )}
      {keyName === 'remote_mode_accepted' && (
        <div className="space-y-1.5">
          <Label className="text-xs">Perché accetti la remote mode del campanello (disponibilità ridotta, PROPFIND al posto del mount)</Label>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
        </div>
      )}
      {keyName === 'public_401_verified' && (
        <div className="space-y-2">
          {remedy && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Lancia sull'host (fuori dal container) e verifica che entrambe le risposte siano 401:</p>
              <pre className="overflow-x-auto rounded bg-muted px-2 py-1 text-[10px] whitespace-pre-wrap break-all">{remedy}</pre>
            </div>
          )}
          <Label className="text-xs">Come l'hai verificato</Label>
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="curl">curl dall'host</option>
            <option value="browser">browser</option>
            <option value="other">altro</option>
          </select>
        </div>
      )}
      {keyName !== 'remote_mode_accepted' && (
        <div className="space-y-1.5">
          <Label className="text-xs">Nota (facoltativa, senza dati personali)</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </div>
      )}
      {keyName === 'backup_verified' && (
        <p className="text-xs text-muted-foreground">
          La dichiarazione vale 24 ore. Il preflight preferisce il backup coordinato registrato da <span className="font-mono">backup-calendar-stack.sh</span>
          {state.last_stack_backup ? ` (ultimo: ${formatDateTime(state.last_stack_backup.at)})` : ''}.
        </p>
      )}
    </div>
  );
  if (waiver) {
    return (
      <ConfirmPhraseDialog
        open
        onOpenChange={(o) => { if (!o) onClose(); }}
        title={DECLARATION_LABELS[keyName]}
        description="Questa dichiarazione toglie un controllo di sicurezza: confermala solo se l'hai verificato davvero."
        phrase={MIGRATION_CONFIRMATIONS.declare}
        confirmLabel="Registra dichiarazione"
        pending={save.isPending}
        disabled={keyName === 'remote_mode_accepted' && reason.trim().length < 3}
        error={save.isError ? migrationErrorMessage(save.error) : null}
        onConfirm={({ phrase }) => save.mutate({ confirm: phrase })}
      >
        {fields}
      </ConfirmPhraseDialog>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{DECLARATION_LABELS[keyName]}</DialogTitle>
          <DialogDescription>Decisione 7: il vecchio volume non si monta mai al posto di quello nuovo.</DialogDescription>
        </DialogHeader>
        {fields}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate({})}>Registra dichiarazione</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Caricamento dell'archivio della Fase 0 (zip di phase0-export, .ics o tar di phase0-backup). */
function ArchiveDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const archive = useRunMutation((vars: { file: File; confirm: string }, key) => migrationApi.archive(vars.file, vars.confirm, key), {
    success: 'Import dell\'archivio avviato',
    onCreated: () => {
      setFile(null);
      onOpenChange(false);
    },
  });
  const tooBig = !!file && file.size > ARCHIVE_MAX_BYTES;
  return (
    <ConfirmPhraseDialog
      open={open}
      onOpenChange={(o) => { if (!o) setFile(null); onOpenChange(o); }}
      title="Importa archivio della Fase 0"
      phrase={MIGRATION_CONFIRMATIONS.archive}
      confirmLabel="Importa"
      pending={archive.isPending}
      disabled={!file || tooBig}
      error={archive.isError ? migrationErrorMessage(archive.error) : tooBig ? 'Il file supera i 20 MB' : null}
      onConfirm={({ phrase }) => { if (file) archive.mutate({ file, confirm: phrase }); }}
      description={
        <>
          <p>Gli item del vecchio volume finiscono nella collezione <span className="font-mono">archivio-fase0</span>: in sola lettura per i device, mai bloccante per le prenotazioni e fuori dal piano di migrazione (decisione 7).</p>
          <p>Prepara il file sull'host con <span className="font-mono">scripts/radicale-maint.sh phase0-export</span>. L'import è ripetibile: gli item già presenti non si riscrivono.</p>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label className="text-xs">File (.zip, .ics, .tar o .tar.gz, al più 20 MB)</Label>
        <Input type="file" accept=".zip,.ics,.tar,.gz,.tgz" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && <p className="text-[11px] text-muted-foreground">{file.name} · {(file.size / 1024).toFixed(1)} KB</p>}
      </div>
    </ConfirmPhraseDialog>
  );
}

/** Riassegnazione d'identità con il diff fra Postgres e il volume (design §13.3, §16.3). */
function IdentityDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const diff = useQuery({ queryKey: migrationKeys.identity, queryFn: migrationApi.identity, enabled: open, staleTime: 0 });
  const [direction, setDirection] = useState<'volume_to_pg' | 'pg_to_volume' | null>(null);
  const reassign = useRunMutation(
    (vars: { direction: 'volume_to_pg' | 'pg_to_volume'; confirm: string; expected: { pg_volume_id: string | null; pg_epoch: number; marker_volume_id: string | null; marker_epoch: number | null } }, key) =>
      migrationApi.identityReassign(vars, key),
    { success: 'Riassegnazione d\'identità avviata', onCreated: () => onOpenChange(false) },
  );
  const d = diff.data;
  const chosen = direction ?? (d?.allowed.length === 1 ? d.allowed[0] : null);
  return (
    <ConfirmPhraseDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Riassegna identità del volume"
      phrase={MIGRATION_CONFIRMATIONS.identityReassign}
      confirmLabel="Riassegna"
      destructive
      pending={reassign.isPending}
      disabled={!d || !chosen}
      error={reassign.isError ? migrationErrorMessage(reassign.error) : diff.isError ? migrationErrorMessage(diff.error) : null}
      onConfirm={({ phrase }) => {
        if (!d || !chosen) return;
        reassign.mutate({
          direction: chosen,
          confirm: phrase,
          expected: { pg_volume_id: d.pg.volume_id, pg_epoch: d.pg.epoch, marker_volume_id: d.volume.marker?.volume_id ?? null, marker_epoch: d.volume.marker?.epoch ?? null },
        });
      }}
      description={<p>Serve quando Postgres e il volume non si riconoscono (volume sostituito o ripristinato, database ripristinato a prima dell'inizializzazione). Dopo la riassegnazione tutte le righe del ledger vanno rivalidate: nessuna scrittura parte senza conferma.</p>}
    >
      {diff.isLoading && <p className="text-xs text-muted-foreground">Lettura del volume…</p>}
      {d && (
        <div className="space-y-3 text-xs">
          <p className="rounded-md border bg-muted/40 p-2">{d.explanation}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border p-2 space-y-0.5">
              <p className="font-medium">Postgres</p>
              <p>volume-id: <span className="font-mono break-all">{d.pg.volume_id ?? '—'}</span></p>
              <p>epoch: {d.pg.epoch}</p>
            </div>
            <div className="rounded-md border p-2 space-y-0.5">
              <p className="font-medium">Volume di Radicale</p>
              <p>volume-id: <span className="font-mono break-all">{d.volume.marker?.volume_id ?? (d.volume.principal_exists ? 'assente' : 'principal assente')}</span></p>
              <p>epoch: {d.volume.marker?.epoch ?? '—'}</p>
              {d.volume.read_error && <p className="text-red-600">{d.volume.read_error}</p>}
            </div>
          </div>
          {d.volume.collections.length > 0 && (
            <p className="text-muted-foreground">Collezioni sul volume: {d.volume.collections.map((c) => `${c.name}${c.items !== null ? ` (${c.items})` : ''}`).join(', ')}</p>
          )}
          <p className="text-muted-foreground">Ledger: {d.ledger.live} righe vive, {d.ledger.with_target_etag} con una scrittura registrata.</p>
          {d.allowed.length === 0 ? (
            <Badge variant="outline">Nessuna riassegnazione ammessa con questo stato</Badge>
          ) : (
            <div className="space-y-1.5">
              {d.allowed.includes('volume_to_pg') && (
                <label className="flex items-start gap-2">
                  <input type="radio" name="direction" className="mt-0.5" checked={chosen === 'volume_to_pg'} onChange={() => setDirection('volume_to_pg')} />
                  <span>Il volume è quello giusto: Postgres prende volume-id ed epoch del volume.</span>
                </label>
              )}
              {d.allowed.includes('pg_to_volume') && (
                <label className="flex items-start gap-2">
                  <input type="radio" name="direction" className="mt-0.5" checked={chosen === 'pg_to_volume'} onChange={() => setDirection('pg_to_volume')} />
                  <span>Postgres è quello giusto: il volume riceve volume-id ed epoch di Postgres.</span>
                </label>
              )}
            </div>
          )}
        </div>
      )}
    </ConfirmPhraseDialog>
  );
}
