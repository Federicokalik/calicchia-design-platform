import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ChevronDown, ChevronRight, CloudUpload, Play, ServerCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Backup coordinato dello stack (database più volume di Radicale) eseguito dal
 * servizio `backup` (apps/backup, migrazione 173). L'admin vede lo stato del
 * servizio e i run recenti e può chiedere un backup subito: l'API mette la
 * richiesta in coda e il servizio la esegue entro circa 30 secondi.
 */

type RunStatus = 'queued' | 'running' | 'succeeded' | 'incomplete' | 'failed' | 'skipped';

interface StackBackupRun {
  id: string;
  trigger: 'schedule' | 'admin';
  requested_by: string | null;
  status: RunStatus;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  backup_id: string | null;
  offsite: boolean | null;
  message: string | null;
  log_tail: string | null;
}

interface StackBackupStatus {
  installed: boolean;
  agent: {
    online: boolean;
    seen_at: string;
    started_at: string;
    version: string | null;
    interval_hours: number;
    next_run_at: string | null;
    s4_configured: boolean;
    alerts_configured: boolean;
  } | null;
  active: StackBackupRun | null;
  runs: StackBackupRun[];
  last_stack_backup: { id: string | null; at: string | null; complete: boolean | null; epoch: number | null } | null;
}

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'In coda',
  running: 'In corso',
  succeeded: 'Completato',
  incomplete: 'Incompleto',
  failed: 'Fallito',
  skipped: 'Saltato',
};

const STATUS_CLASSES: Record<RunStatus, string> = {
  queued: 'border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-300',
  running: 'border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-300',
  succeeded: 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300',
  incomplete: 'border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300',
  failed: 'border-red-300 text-red-700 dark:border-red-700 dark:text-red-300',
  skipped: 'text-muted-foreground',
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
}

function relative(iso: string | null): string {
  if (!iso) return '—';
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  const abs = Math.abs(minutes);
  const text = abs < 1 ? 'meno di un minuto' : abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} ore` : `${Math.round(abs / 1440)} giorni`;
  return minutes >= 0 ? `fra ${text}` : `${text} fa`;
}

function RunRow({ run }: { run: StackBackupRun }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
          disabled={!run.log_tail}
          aria-expanded={open}
          aria-label="Mostra il log del run"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <span className="tabular-nums">{formatDateTime(run.started_at ?? run.requested_at)}</span>
        <Badge variant="outline" className={cn('font-normal', STATUS_CLASSES[run.status])}>{STATUS_LABELS[run.status]}</Badge>
        <span className="text-muted-foreground">{run.trigger === 'schedule' ? 'pianificato' : 'manuale'}</span>
        {run.offsite === true && <span className="text-muted-foreground">· copia su S4</span>}
        {run.offsite === false && <span className="text-amber-700 dark:text-amber-300">· solo locale</span>}
        {run.backup_id && <code className="text-[10px] text-muted-foreground">{run.backup_id}</code>}
      </div>
      {run.message && (run.status === 'failed' || run.status === 'incomplete') && (
        <p className="mt-1 pl-5 text-[11px] text-red-700 dark:text-red-300 break-words">{run.message}</p>
      )}
      {open && run.log_tail && (
        <pre className="mt-2 ml-5 max-h-64 overflow-auto rounded-md bg-muted/60 p-2 text-[10px] leading-relaxed whitespace-pre-wrap break-all">{run.log_tail}</pre>
      )}
    </li>
  );
}

export function StackBackupSection() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<StackBackupStatus>({
    queryKey: ['backup-stack'],
    queryFn: () => apiFetch('/api/backup/stack'),
    // Con un run in coda o in corso aggiorna spesso, altrimenti ogni minuto.
    refetchInterval: (query) => (query.state.data?.active ? 5_000 : 60_000),
    meta: { skipGlobalRefetch: true },
  });

  const runMutation = useMutation({
    mutationFn: () => apiFetch('/api/backup/stack/run', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Backup in coda: parte entro circa 30 secondi');
      queryClient.invalidateQueries({ queryKey: ['backup-stack'] });
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Richiesta di backup non riuscita');
      queryClient.invalidateQueries({ queryKey: ['backup-stack'] });
    },
  });

  const agent = data?.agent ?? null;
  const active = data?.active ?? null;
  const last = data?.last_stack_backup ?? null;
  const canRun = !!agent?.online && !active && !runMutation.isPending;

  return (
    <div className="rounded-xl border bg-card p-6 space-y-4" data-testid="stack-backup-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ServerCog className="h-4 w-4 text-muted-foreground" /> Backup automatico (database e calendario)
          </div>
          <p className="text-xs text-muted-foreground max-w-prose">
            Il servizio <code>backup</code> dello stack salva insieme il database e il volume di Radicale,
            con la stessa identità, e ne manda una copia su MEGA S4. Il ripristino resta un&apos;operazione da terminale.
          </p>
        </div>
        <Button size="sm" onClick={() => runMutation.mutate()} disabled={!canRun}>
          <Play className="h-3.5 w-3.5 mr-1.5" />
          {active ? (active.status === 'running' ? 'Backup in corso…' : 'Backup in coda…') : 'Esegui backup ora'}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Caricamento…</p>
      ) : error ? (
        <p className="text-xs text-red-700 dark:text-red-300">Stato del backup non leggibile: {(error as Error).message}</p>
      ) : !data?.installed ? (
        <p className="text-xs text-muted-foreground">Servizio non ancora installato (manca la migrazione 173).</p>
      ) : (
        <>
          {!agent?.online && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600" />
              <p>
                {agent
                  ? `Il servizio di backup non risponde dal ${formatDateTime(agent.seen_at)}: i backup pianificati sono fermi. Controlla il container backup in Dockhand.`
                  : 'Il servizio di backup non è ancora partito: va aggiunto allo stack (apps/backup/README.md).'}
              </p>
            </div>
          )}

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Ultimo backup coordinato</dt>
              <dd className="font-medium">
                {last?.at ? `${formatDateTime(last.at)} (${relative(last.at)})` : 'mai registrato'}
                {last?.complete === false && <span className="text-amber-700 dark:text-amber-300"> · incompleto</span>}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Prossimo backup pianificato</dt>
              <dd className="font-medium">
                {agent?.online && agent.next_run_at ? `${formatDateTime(agent.next_run_at)} (${relative(agent.next_run_at)})` : '—'}
                {agent && <span className="text-muted-foreground font-normal"> · ogni {agent.interval_hours} ore</span>}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Copia off-site</dt>
              <dd className={cn('font-medium inline-flex items-center gap-1', agent && !agent.s4_configured && 'text-amber-700 dark:text-amber-300')}>
                <CloudUpload className="h-3.5 w-3.5" />
                {agent ? (agent.s4_configured ? 'MEGA S4 configurato' : 'S4 non configurato: backup solo sul server') : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Avvisi dei run falliti</dt>
              <dd className={cn('font-medium', agent && !agent.alerts_configured && 'text-amber-700 dark:text-amber-300')}>
                {agent ? (agent.alerts_configured ? 'Telegram' : 'nessun canale configurato') : '—'}
              </dd>
            </div>
          </dl>

          {data.runs.length > 0 && (
            <div>
              <p className="text-xs font-medium mb-1">Run recenti</p>
              <ul className="divide-y">
                {data.runs.map((run) => <RunRow key={run.id} run={run} />)}
              </ul>
            </div>
          )}
          {agent?.version && <p className="text-[10px] text-muted-foreground">Servizio {agent.version}, attivo dal {formatDateTime(agent.started_at)}</p>}
        </>
      )}
    </div>
  );
}
