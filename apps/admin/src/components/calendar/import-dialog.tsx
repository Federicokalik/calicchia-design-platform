/**
 * Importazione di un file `.ics` in un calendario (contratto F6 §9.2.3):
 * il file si legge nel browser e si invia come JSON; l'anteprima è il
 * `dry_run` del server (piano completo, senza troncamento), il commit è un
 * job asincrono seguito con polling ogni 2 s fino all'esito.
 */

import { useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import {
  CAL_V2_IMPORT_CONFLICT_MODES,
  type CalV2ImportConflictMode,
  type CalV2ImportPlan,
  type CalV2ImportPlanItem,
  type CalV2ImportResult,
} from '@calicchia/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { JobProgress } from '@/components/calendar/job-progress';
import { formatWhen } from '@/components/calendar/history-format';
import {
  CalV2ApiError,
  calV2ErrorMessage,
  importCommitV2,
  importPreviewV2,
} from '@/lib/calendar-v2-api';

/** Limite del file (contratto §9.1.4): oltre il server risponde 413. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const CONFLICT_LABEL: Record<CalV2ImportConflictMode, { title: string; hint: string }> = {
  skip: { title: 'Salta', hint: 'Gli eventi con un UID già presente nel calendario restano come sono.' },
  replace: { title: 'Sostituisci', hint: 'Gli eventi con un UID già presente vengono sostituiti dalla versione del file.' },
  new_uid: { title: 'Importa come nuovi', hint: 'Gli eventi con un UID già presente vengono importati come eventi nuovi, con un UID diverso.' },
};

const ACTION_LABEL: Record<CalV2ImportPlanItem['action'], string> = {
  create: 'Crea',
  replace: 'Sostituisce',
  skip: 'Salta',
  new_uid: 'Nuovo UID',
  invalid: 'Non valido',
};

const REASON_LABEL: Record<string, string> = {
  uid_exists: 'UID già presente nel calendario',
  uid_in_other_calendar: 'UID presente in un altro calendario',
  component_unsupported: 'Componente non supportato (solo eventi)',
  parse_error: 'Testo non interpretabile',
  too_large: 'Oggetto troppo grande',
};

function reasonLabel(reason: string | null): string {
  if (!reason) return '';
  return REASON_LABEL[reason] ?? reason;
}

function actionBadgeClass(action: CalV2ImportPlanItem['action']): string {
  switch (action) {
    case 'create': return 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300';
    case 'replace':
    case 'new_uid': return 'border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300';
    case 'invalid': return 'border-destructive/50 text-destructive';
    default: return 'text-muted-foreground';
  }
}

type ActionFilter = 'all' | CalV2ImportPlanItem['action'];

function PlanTable({ plan }: { plan: CalV2ImportPlan }) {
  const [filter, setFilter] = useState<ActionFilter>('all');
  const [query, setQuery] = useState('');
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plan.items.filter((item) => {
      if (filter !== 'all' && item.action !== filter) return false;
      if (!q) return true;
      return (item.summary ?? '').toLowerCase().includes(q) || (item.uid ?? '').toLowerCase().includes(q);
    });
  }, [plan.items, filter, query]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filtra per azione"
          value={filter}
          onChange={(e) => setFilter(e.target.value as ActionFilter)}
          className="rounded-md border bg-background px-2 py-1.5 text-xs"
        >
          <option value="all">Tutte le azioni ({plan.total})</option>
          <option value="create">Crea ({plan.create})</option>
          <option value="replace">Sostituisce ({plan.replace})</option>
          <option value="new_uid">Nuovo UID ({plan.new_uid})</option>
          <option value="skip">Salta ({plan.skip})</option>
          <option value="invalid">Non valido ({plan.invalid})</option>
        </select>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cerca per titolo o UID"
          aria-label="Cerca nell'anteprima"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-xs"
        />
        <span className="text-xs text-muted-foreground">{items.length} di {plan.total}</span>
      </div>
      <div className="max-h-72 overflow-auto rounded-md border" data-testid="cal-import-plan">
        <div className="sticky top-0 z-10 grid grid-cols-[3rem_6.5rem_1fr_9rem] gap-2 border-b bg-muted/80 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
          <span>N.</span>
          <span>Azione</span>
          <span>Evento</span>
          <span>Inizio</span>
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">Nessun oggetto corrisponde al filtro.</p>
        ) : items.map((item) => {
          const errors = item.issues.filter((i) => i.severity === 'error');
          const warnings = item.issues.filter((i) => i.severity === 'warning');
          return (
            // content-visibility: con migliaia di righe il browser disegna solo quelle visibili.
            <div
              key={item.index}
              className="grid grid-cols-[3rem_6.5rem_1fr_9rem] gap-2 border-b px-2 py-1.5 text-xs last:border-b-0 [content-visibility:auto] [contain-intrinsic-size:auto_2.5rem]"
            >
              <span className="tabular-nums text-muted-foreground">{item.index + 1}</span>
              <span><Badge variant="outline" className={`text-[10px] ${actionBadgeClass(item.action)}`}>{ACTION_LABEL[item.action]}</Badge></span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{item.summary?.trim() || '(senza titolo)'}{item.recurring ? ' · ricorrente' : ''}</span>
                {(item.reason || item.uid) && (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {reasonLabel(item.reason)}{item.reason && item.uid ? ' · ' : ''}{item.uid ?? ''}
                  </span>
                )}
                {errors.map((issue, i) => <span key={`e${i}`} className="block text-[11px] text-destructive">{issue.message}</span>)}
                {warnings.map((issue, i) => <span key={`w${i}`} className="block text-[11px] text-amber-700 dark:text-amber-400">{issue.message}</span>)}
              </span>
              <span className="tabular-nums text-muted-foreground">{formatWhen(item.start_utc)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ImportResultView({ result }: { result: CalV2ImportResult }) {
  return (
    <div className="space-y-2 text-sm">
      <p>
        <strong>{result.created}</strong> creati · <strong>{result.replaced}</strong> sostituiti · <strong>{result.skipped}</strong> saltati
        {result.failed.length > 0 && <> · <strong className="text-destructive">{result.failed.length}</strong> non riusciti</>}
      </p>
      {result.failed.length > 0 && (
        <div className="max-h-48 overflow-auto rounded-md border border-destructive/40" data-testid="cal-import-failed">
          {result.failed.map((f) => (
            <div key={`${f.index}-${f.code}`} className="border-b px-2 py-1.5 text-xs last:border-b-0">
              <span className="tabular-nums text-muted-foreground">N. {f.index + 1}</span>
              {f.uid && <span className="ml-2 font-mono text-[11px]">{f.uid}</span>}
              <span className="block text-destructive">{f.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ImportDialog({ calendar, canWrite, writeBlockedReason, onClose, onImported }: {
  calendar: { id: string; name: string };
  canWrite: boolean;
  /** Motivo per cui non si può scrivere (mostrato quando `canWrite` è falso). */
  writeBlockedReason?: string | null;
  onClose: () => void;
  /** Il job è terminato: il chiamante aggiorna gli elenchi. */
  onImported: () => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [ics, setIcs] = useState<string | null>(null);
  const [onConflict, setOnConflict] = useState<CalV2ImportConflictMode>('skip');
  const [plan, setPlan] = useState<CalV2ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  // La chiave resta la stessa per i nuovi tentativi dello stesso commit; cambia con ogni nuova anteprima
  // (un corpo diverso con la stessa chiave darebbe 409 IDEMPOTENCY_CONFLICT).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const running = jobId !== null;
  const importable = plan ? plan.create + plan.replace + plan.new_uid : 0;

  const resetPlan = () => {
    setPlan(null);
    setError(null);
  };

  const onFile = async (file: File | undefined) => {
    resetPlan();
    if (!file) {
      setFileName(null);
      setIcs(null);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileName(null);
      setIcs(null);
      setError('Il file supera il limite di 10 MB.');
      return;
    }
    try {
      const text = await file.text();
      setFileName(file.name);
      setIcs(text);
    } catch {
      setFileName(null);
      setIcs(null);
      setError('Impossibile leggere il file.');
    }
  };

  const preview = async () => {
    if (!ics) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importPreviewV2(calendar.id, { ics, on_conflict: onConflict });
      setPlan(result);
      setIdempotencyKey(crypto.randomUUID());
    } catch (err) {
      setPlan(null);
      setError(calV2ErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!ics || !plan) return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await importCommitV2(calendar.id, { ics, on_conflict: onConflict, plan_hash: plan.plan_hash }, idempotencyKey);
      setJobId(accepted.job_id);
    } catch (err) {
      if (err instanceof CalV2ApiError && err.code === 'PLAN_CHANGED') {
        // Il calendario è cambiato dopo l'anteprima: si mostra il piano aggiornato e si chiede di ricontrollarlo.
        const fresh = err.details?.plan as CalV2ImportPlan | undefined;
        if (fresh && Array.isArray(fresh.items)) {
          setPlan(fresh);
          setIdempotencyKey(crypto.randomUUID());
        } else {
          setPlan(null);
        }
        setError('Il calendario è cambiato dopo l\'anteprima. Controlla il piano aggiornato e conferma di nuovo.');
      } else {
        setError(calV2ErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="cal-import-dialog">
        <DialogHeader>
          <DialogTitle>Importa in «{calendar.name}»</DialogTitle>
          <DialogDescription>
            Scegli un file .ics (anche l&apos;export di Google Calendar, Apple o Outlook). Prima dell&apos;importazione vedrai cosa succederà a ogni evento.
          </DialogDescription>
        </DialogHeader>

        {!canWrite && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
            Al momento non si può importare{writeBlockedReason ? `: ${writeBlockedReason}` : ''}.
          </p>
        )}

        {!running && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="cal-import-file" className="text-sm font-medium">File .ics</label>
              <div className="flex items-center gap-2">
                <input
                  id="cal-import-file"
                  data-testid="cal-import-file"
                  type="file"
                  accept=".ics,text/calendar"
                  disabled={busy}
                  onChange={(e) => { void onFile(e.target.files?.[0]); }}
                  className="min-w-0 flex-1 text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-xs"
                />
              </div>
              {fileName && <p className="text-xs text-muted-foreground">{fileName}</p>}
            </div>

            <fieldset className="space-y-1.5" disabled={busy}>
              <legend className="text-sm font-medium">Se un evento esiste già (stesso UID)</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {CAL_V2_IMPORT_CONFLICT_MODES.map((mode) => (
                  <label
                    key={mode}
                    className={`cursor-pointer rounded-md border p-2.5 text-xs ${onConflict === mode ? 'border-foreground bg-muted/50' : 'hover:bg-muted/30'}`}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <input
                        type="radio"
                        name="cal-import-conflict"
                        value={mode}
                        checked={onConflict === mode}
                        onChange={() => { setOnConflict(mode); resetPlan(); }}
                      />
                      {CONFLICT_LABEL[mode].title}
                    </span>
                    <span className="mt-1 block text-muted-foreground">{CONFLICT_LABEL[mode].hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {plan && (
              <div className="space-y-3" data-testid="cal-import-summary">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <span><strong>{plan.total}</strong> oggetti nel file</span>
                  <span className="text-emerald-700 dark:text-emerald-300"><strong>{plan.create}</strong> da creare</span>
                  <span className="text-amber-700 dark:text-amber-300"><strong>{plan.replace}</strong> da sostituire</span>
                  <span className="text-amber-700 dark:text-amber-300"><strong>{plan.new_uid}</strong> con nuovo UID</span>
                  <span className="text-muted-foreground"><strong>{plan.skip}</strong> saltati</span>
                  <span className="text-destructive"><strong>{plan.invalid}</strong> non validi</span>
                </div>
                {plan.warnings.length > 0 && (
                  <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
                    {plan.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
                <PlanTable plan={plan} />
              </div>
            )}

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {running && jobId && (
          <div className="space-y-3">
            <JobProgress jobId={jobId} testId="cal-import-status" onFinished={onImported}>
              {(job) => (job.status === 'done' && job.result && 'created' in job.result
                ? <ImportResultView result={job.result} />
                : null)}
            </JobProgress>
            <p className="text-xs text-muted-foreground">Puoi chiudere questa finestra: l&apos;importazione continua sul server.</p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{running ? 'Chiudi' : 'Annulla'}</Button>
          {!running && (
            <>
              <Button
                variant="outline"
                size="sm"
                data-testid="cal-import-preview"
                onClick={() => { void preview(); }}
                disabled={!ics || busy}
              >
                {busy && !plan ? 'Analisi…' : 'Anteprima'}
              </Button>
              <Button
                size="sm"
                data-testid="cal-import-commit"
                onClick={() => { void commit(); }}
                disabled={!plan || importable === 0 || busy || !canWrite}
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {plan && importable > 0 ? `Importa ${importable} ${importable === 1 ? 'evento' : 'eventi'}` : 'Importa'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
