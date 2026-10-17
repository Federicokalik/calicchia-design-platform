import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { toast } from 'sonner';
import type { CalV2Issue, CalV2ObjectView, CalV2WriteResult } from '@calicchia/shared';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import { CalV2ApiError, CalV2ConflictError, calV2ErrorMessage, putObjectIcsV2 } from '@/lib/calendar-v2-api';

export interface RawIcsEditorProps {
  view: CalV2ObjectView;
  /** Scrittura non ammessa (iscrizione, scritture sospese, ETag assente...): il testo resta leggibile e selezionabile. */
  disabled: boolean;
  /** Motivo, in chiaro, per cui il testo non si può salvare ora (mostrato sopra l'area di testo). */
  disabledReason?: string | null;
  /** Salvato il testo: l'editor ricarica la vista con il risultato. */
  onApplied: (result: CalV2WriteResult) => void;
  /** Scarta il testo e apre la versione del server (dopo un 412). */
  onReload: (next: CalV2ObjectView) => void;
  /** Il testo è stato modificato e non ancora salvato. */
  onDirtyChange?: (dirty: boolean) => void;
}

/** Il browser normalizza i fine riga della textarea in LF: si confronta con il testo del server nella stessa forma. */
function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function IssueItems({ issues }: { issues: CalV2Issue[] }) {
  return (
    <ul className="space-y-1">
      {issues.map((i, idx) => (
        <li
          key={idx}
          className={`flex gap-1.5 rounded-md border px-2 py-1 text-xs ${
            i.severity === 'error'
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>{i.message}{i.property ? ` (${i.property})` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Editor del testo ICS completo di un oggetto (contratto F6 §9.1.2 e §9.2.2).
 * Il server valida l'intero testo e lo scrive così com'è, senza ritocchi
 * automatici di DTSTAMP, LAST-MODIFIED e SEQUENCE e senza fusione per campi:
 * se l'ETag è cambiato risponde 412 e qui si sceglie fra "Ricarica" e
 * "Sovrascrivi".
 */
export function RawIcsEditor({ view, disabled, disabledReason, onApplied, onReload, onDirtyChange }: RawIcsEditorProps) {
  const confirm = useConfirm();
  const original = toLf(view.ics);
  const [text, setText] = useState(original);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [check, setCheck] = useState<{ valid: boolean; issues: CalV2Issue[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<CalV2ObjectView | null>(null);

  const dirty = text !== original;
  const etag = view.etag;
  const canWrite = !disabled && !!etag;

  const change = (next: string) => {
    setText(next);
    setCheck(null);
    setError(null);
    onDirtyChange?.(next !== original);
  };

  /** Errori del server: i problemi di validazione vanno in elenco, il resto in un messaggio. */
  const showError = (err: unknown) => {
    if (err instanceof CalV2ApiError && err.code === 'VALIDATION_FAILED' && Array.isArray(err.details?.issues)) {
      setCheck({ valid: false, issues: err.details.issues as CalV2Issue[] });
      return;
    }
    setError(calV2ErrorMessage(err));
  };

  const runCheck = async () => {
    if (!etag) return;
    setBusy('check');
    setCheck(null);
    setError(null);
    try {
      const result = await putObjectIcsV2(view.id, etag, { ics: text, dryRun: true });
      setCheck({ valid: result.valid, issues: result.issues });
    } catch (err) {
      if (err instanceof CalV2ConflictError) setStale(err.body.current);
      else showError(err);
    } finally {
      setBusy(null);
    }
  };

  const runSave = async (useEtag: string) => {
    setBusy('save');
    setCheck(null);
    setError(null);
    try {
      const result = await putObjectIcsV2(view.id, useEtag, { ics: text });
      for (const issue of result.issues.filter((i) => i.severity === 'warning')) toast.warning(issue.message);
      toast[result.noop ? 'info' : 'success'](result.noop ? 'Nessuna modifica da salvare' : 'Testo ICS salvato');
      onApplied(result);
    } catch (err) {
      if (err instanceof CalV2ConflictError) {
        setStale(err.body.current);
        setBusy(null);
        return;
      }
      showError(err);
      setBusy(null);
    }
  };

  const overwrite = async () => {
    const currentEtag = stale?.etag;
    if (!currentEtag) return;
    if (!(await confirm({
      title: 'Sovrascrivere la versione del server?',
      description: 'Il testo che hai scritto sostituisce per intero quello attuale: le modifiche fatte altrove andranno perse.',
      variant: 'destructive',
    }))) return;
    setStale(null);
    await runSave(currentEtag);
  };

  return (
    <div className="space-y-2" data-testid="cal-raw-editor">
      <div className="flex gap-2 rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
        <span>
          Il testo viene salvato così com&apos;è: DTSTAMP, LAST-MODIFIED e SEQUENCE non si aggiornano da soli (se cambi orari o ricorrenza, porta tu SEQUENCE a +1 perché i dispositivi accettino la modifica). Deve contenere lo stesso UID e soli eventi.
        </span>
      </div>
      {disabledReason && (
        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>{disabledReason}</span>
        </div>
      )}

      <textarea
        value={text}
        onChange={(e) => change(e.target.value)}
        readOnly={!canWrite || busy === 'save'}
        spellCheck={false}
        wrap="off"
        aria-label="Testo ICS"
        className="h-72 w-full resize-y rounded-md border bg-background p-3 font-mono text-[11px] leading-snug read-only:bg-muted/40"
      />

      {stale && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200" role="alert">
          <p className="font-medium">L&apos;evento è stato modificato altrove</p>
          <p className="text-xs">
            Mentre modificavi il testo, un altro dispositivo o utente ha cambiato l&apos;evento. Puoi ricaricare la versione attuale (il tuo testo va perso) oppure sovrascriverla con il tuo.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" data-testid="cal-raw-reload" onClick={() => onReload(stale)}>Ricarica</Button>
            {stale.etag && (
              <Button type="button" size="sm" variant="destructive" data-testid="cal-raw-overwrite" onClick={() => { void overwrite(); }}>
                Sovrascrivi
              </Button>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {check && (
        <div className="space-y-1.5" role="status">
          {check.valid && (
            <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Il testo è valido.
            </p>
          )}
          <IssueItems issues={check.issues} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="cal-raw-check"
          disabled={!canWrite || !dirty || busy !== null}
          onClick={() => { void runCheck(); }}
        >
          {busy === 'check' ? 'Verifica…' : 'Verifica'}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="cal-raw-save"
          disabled={!canWrite || !dirty || busy !== null || !!stale}
          onClick={() => { if (etag) void runSave(etag); }}
        >
          {busy === 'save' ? 'Salvataggio…' : 'Salva testo'}
        </Button>
        {dirty && canWrite && (
          <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => change(original)}>
            Annulla modifiche
          </Button>
        )}
      </div>
    </div>
  );
}
