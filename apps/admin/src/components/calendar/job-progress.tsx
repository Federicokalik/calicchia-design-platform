/**
 * Avanzamento di un job asincrono del calendario (import, applica
 * cancellazioni, ricostruisci dall'indice; contratto F6 §9.1.4-§9.1.5):
 * polling ogni 2 s di `GET /jobs/:jobId` fino allo stato finale. Il risultato
 * lo disegna il chiamante, perché dipende dal tipo di job.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { CalV2JobView } from '@calicchia/shared';
import { Progress } from '@/components/ui/progress';
import { calV2ErrorMessage, isJobFinishedV2, useJobV2 } from '@/lib/calendar-v2-api';

const STATUS_TEXT: Record<CalV2JobView['status'], string> = {
  pending: 'In coda…',
  running: 'In corso…',
  done: 'Completato',
  dead: 'Non riuscito',
  superseded: 'Sostituito da un altro lavoro',
};

export function JobProgress({ jobId, testId, onFinished, children }: {
  jobId: string;
  /** `data-testid` del contenitore di stato (porta anche `data-status`). */
  testId: string;
  /** Chiamata una sola volta, quando il job raggiunge lo stato finale. */
  onFinished?: (job: CalV2JobView) => void;
  /** Risultato, mostrato solo a job terminato. */
  children?: (job: CalV2JobView) => ReactNode;
}) {
  const { data: job, error } = useJobV2(jobId);
  const notified = useRef(false);

  useEffect(() => {
    if (job && isJobFinishedV2(job) && !notified.current) {
      notified.current = true;
      onFinished?.(job);
    }
  }, [job, onFinished]);

  if (!job) {
    return (
      <div data-testid={testId} data-status={error ? 'error' : 'pending'} className="space-y-2 text-sm">
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Avvio…
        </p>
        {error && <p className="text-xs text-destructive">{calV2ErrorMessage(error)}. Riprovo tra un momento.</p>}
      </div>
    );
  }

  const finished = isJobFinishedV2(job);
  const failedStatus = job.status === 'dead' || job.status === 'superseded';
  const progress = job.progress;
  return (
    <div data-testid={testId} data-status={job.status} className="space-y-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        {!finished && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {job.status === 'done' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
        {failedStatus && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
        {STATUS_TEXT[job.status]}
      </p>
      {progress && progress.total > 0 && (
        <div className="space-y-1">
          <Progress value={finished && job.status === 'done' ? progress.total : progress.done} max={progress.total} />
          <p className="text-xs text-muted-foreground">
            {progress.done} di {progress.total}
            {progress.failed > 0 ? ` · ${progress.failed} non riusciti` : ''}
          </p>
        </div>
      )}
      {job.status === 'dead' && job.error && <p className="text-xs text-destructive">{job.error}</p>}
      {error && !finished && <p className="text-xs text-amber-700 dark:text-amber-400">{calV2ErrorMessage(error)}. Riprovo tra un momento.</p>}
      {finished && children?.(job)}
    </div>
  );
}
