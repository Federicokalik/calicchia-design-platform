/**
 * Pezzi condivisi dai passi del wizard di migrazione del calendario
 * (pagina /calendario/migrazione, fase F3): badge di stato, dialog con la
 * frase di conferma da digitare, pannello del run con avanzamento e
 * annullamento, tabella paginata delle righe di un run, pulsanti legati alle
 * azioni del wizard (abilitazione e motivo decisi dall'API).
 *
 * Lo stato si aggiorna da solo: le query del run in corso si rinnovano ogni
 * 2 secondi finché il run è attivo, e ogni azione invalida le query della
 * pagina (chiavi migrationKeys.all).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, CircleDashed, Download, Loader2, Lock, MinusCircle, Square, XCircle } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConfirm } from '@/hooks/use-confirm';
import { cn } from '@/lib/utils';
import {
  ACTION_LABELS,
  CHECK_STATUS_LABELS,
  COLOR_LABELS,
  CONFLICT_LABELS,
  DIFF_CODE_LABELS,
  EXPECTED_REASON_LABELS,
  isRunActive,
  migrationApi,
  migrationErrorMessage,
  migrationKeys,
  OUTCOME_LABELS,
  RUN_KIND_LABELS,
  RUN_STATUS_LABELS,
  RUN_TRIGGER_LABELS,
  SKIP_LABELS,
  STEP_STATUS_LABELS,
  formatAgo,
  formatDateTime,
  type MigrationItemView,
  type MigrationRunStatus,
  type MigrationRunView,
  type PreflightCheckStatus,
  type RunItemsQuery,
  type VerifyColor,
  type WizardAction,
  type WizardStepStatus,
} from '@/lib/calendar-migration-api';

// ─── Badge ───────────────────────────────

const STEP_STATUS_CLASSES: Record<WizardStepStatus, string> = {
  locked: 'bg-muted text-muted-foreground border-transparent',
  todo: 'bg-secondary text-secondary-foreground border-transparent',
  running: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-transparent',
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-transparent',
  attention: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-transparent',
  blocked: 'bg-red-500/15 text-red-700 dark:text-red-300 border-transparent',
  disabled: 'bg-muted text-muted-foreground border-dashed',
};

export function StepStatusIcon({ status, className }: { status: WizardStepStatus; className?: string }) {
  const cls = cn('h-4 w-4 shrink-0', className);
  switch (status) {
    case 'done': return <CheckCircle2 className={cn(cls, 'text-emerald-600')} />;
    case 'running': return <Loader2 className={cn(cls, 'animate-spin text-blue-600')} />;
    case 'attention': return <AlertTriangle className={cn(cls, 'text-amber-600')} />;
    case 'blocked': return <XCircle className={cn(cls, 'text-red-600')} />;
    case 'locked': return <Lock className={cn(cls, 'text-muted-foreground')} />;
    case 'disabled': return <MinusCircle className={cn(cls, 'text-muted-foreground')} />;
    default: return <CircleDashed className={cn(cls, 'text-muted-foreground')} />;
  }
}

export function StepStatusBadge({ status }: { status: WizardStepStatus }) {
  return <Badge variant="outline" className={cn('text-[10px] font-medium', STEP_STATUS_CLASSES[status])}>{STEP_STATUS_LABELS[status]}</Badge>;
}

const RUN_STATUS_CLASSES: Record<MigrationRunStatus, string> = {
  queued: 'bg-secondary text-secondary-foreground border-transparent',
  running: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-transparent',
  succeeded: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-transparent',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-300 border-transparent',
  cancelled: 'bg-muted text-muted-foreground border-transparent',
  interrupted: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-transparent',
};

export function RunStatusBadge({ status }: { status: MigrationRunStatus }) {
  return <Badge variant="outline" className={cn('text-[10px] font-medium', RUN_STATUS_CLASSES[status])}>{RUN_STATUS_LABELS[status]}</Badge>;
}

const COLOR_CLASSES: Record<VerifyColor, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-400',
  red: 'bg-red-500',
};

export function ColorDot({ color, className }: { color: VerifyColor | null | undefined; className?: string }) {
  return (
    <span
      className={cn('inline-block h-2.5 w-2.5 rounded-full shrink-0', color ? COLOR_CLASSES[color] : 'bg-muted-foreground/30', className)}
      title={color ? COLOR_LABELS[color] : 'Non verificato'}
      aria-label={color ? COLOR_LABELS[color] : 'Non verificato'}
    />
  );
}

export function ColorBadge({ color, accepted }: { color: VerifyColor | null | undefined; accepted?: boolean }) {
  if (!color) return <Badge variant="outline" className="text-[10px]">Non verificato</Badge>;
  const label = color === 'yellow' && accepted ? 'Giallo accettato' : COLOR_LABELS[color];
  return (
    <Badge variant="outline" className="text-[10px] gap-1.5">
      <ColorDot color={color} /> {label}
    </Badge>
  );
}

const CHECK_CLASSES: Record<PreflightCheckStatus, string> = {
  pass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-transparent',
  warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-transparent',
  fail: 'bg-red-500/15 text-red-700 dark:text-red-300 border-transparent',
  confirm: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-transparent',
  skip: 'bg-muted text-muted-foreground border-transparent',
};

export function CheckStatusBadge({ status, declared }: { status: PreflightCheckStatus; declared?: boolean }) {
  return (
    <Badge variant="outline" className={cn('text-[10px] font-medium whitespace-nowrap', CHECK_CLASSES[status])}>
      {declared && status === 'pass' ? 'OK (dichiarato)' : CHECK_STATUS_LABELS[status]}
    </Badge>
  );
}

// ─── Sezioni ───────────────────────────────

export function Section({ title, description, actions, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border bg-card p-4 space-y-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <div className="text-xs text-muted-foreground mt-0.5">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2 min-w-[7rem]">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone === 'ok' && 'text-emerald-600', tone === 'warn' && 'text-amber-600', tone === 'bad' && 'text-red-600')}>{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function BlockingList({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1">
      {items.map((b) => (
        <li key={b} className="flex items-start gap-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600" />
          <span>{b}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── Azioni del wizard ───────────────────────────────

/** Pulsante di un'azione del wizard: disabilitato con il motivo dell'API (mostrato sotto e al passaggio del mouse). */
export function ActionButton({ action, children, pending, onClick, disabled: extraDisabled, ...props }: { action: WizardAction | undefined; pending?: boolean; onClick: () => void; children: ReactNode } & Omit<ButtonProps, 'onClick'>) {
  const disabled = !action?.enabled || pending || extraDisabled;
  return (
    <Button size="sm" {...props} disabled={disabled} onClick={onClick} title={action && !action.enabled ? action.reason ?? undefined : undefined}>
      {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </Button>
  );
}

export function ActionReason({ action }: { action: WizardAction | undefined }) {
  if (!action || action.enabled || !action.reason) return null;
  return <p className="text-[11px] text-muted-foreground">{action.reason}</p>;
}

// ─── Conferma digitata ───────────────────────────────

/**
 * Dialog per le azioni che scrivono: spiegazione, frase da digitare
 * esattamente (maiuscole comprese), pulsante attivo solo con la frase giusta.
 * Il contenuto in più (opzioni, file, elenchi) va in `children`.
 */
export function ConfirmPhraseDialog({
  open,
  onOpenChange,
  title,
  description,
  phrase,
  confirmLabel,
  destructive,
  pending,
  error,
  disabled,
  extraPhrase,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  phrase: string;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  error?: string | null;
  disabled?: boolean;
  /** Seconda frase richiesta (per esempio FORZA quando ci sono item forzati). */
  extraPhrase?: { phrase: string; label: string } | null;
  onConfirm: (typed: { phrase: string; extra: string | null }) => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const [extraTyped, setExtraTyped] = useState('');
  useEffect(() => {
    if (!open) {
      setTyped('');
      setExtraTyped('');
    }
  }, [open]);
  const ok = typed === phrase && (!extraPhrase || extraTyped === extraPhrase.phrase);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription asChild><div className="space-y-2 text-sm text-muted-foreground">{description}</div></DialogDescription>}
        </DialogHeader>
        {children}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok && !pending && !disabled) onConfirm({ phrase: typed, extra: extraPhrase ? extraTyped : null });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="migration-confirm-phrase" className="text-xs">
              Per confermare digita <span className="font-mono font-semibold">{phrase}</span>
            </Label>
            <Input id="migration-confirm-phrase" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} placeholder={phrase} />
          </div>
          {extraPhrase && (
            <div className="space-y-1.5">
              <Label htmlFor="migration-confirm-extra" className="text-xs">
                {extraPhrase.label} <span className="font-mono font-semibold">{extraPhrase.phrase}</span>
              </Label>
              <Input id="migration-confirm-extra" value={extraTyped} onChange={(e) => setExtraTyped(e.target.value)} autoComplete="off" spellCheck={false} placeholder={extraPhrase.phrase} />
            </div>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Annulla</Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={!ok || pending || disabled}>
              {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Run ───────────────────────────────

/** Avanzamento, stato e annullamento di un run. */
export function RunPanel({ run, compact }: { run: MigrationRunView; compact?: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const cancel = useMutation({
    mutationFn: () => migrationApi.cancel(run.id),
    onSuccess: (res) => {
      queryClient.setQueryData(migrationKeys.run(run.id), res.run);
      void queryClient.invalidateQueries({ queryKey: migrationKeys.all });
      toast.success(res.run.status === 'cancelled' ? 'Run annullato' : 'Annullamento richiesto: il run si ferma al primo punto sicuro');
    },
    onError: (err) => toast.error(migrationErrorMessage(err)),
  });
  const active = isRunActive(run);
  const p = run.progress ?? {};
  const pct = typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0 ? Math.round((p.done / p.total) * 100) : null;
  return (
    <div className={cn('rounded-md border p-3 space-y-2', active ? 'border-blue-500/40 bg-blue-500/5' : 'bg-background')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {active ? <Loader2 className="h-4 w-4 animate-spin text-blue-600" /> : <StepStatusIcon status={run.status === 'succeeded' ? 'done' : run.status === 'failed' ? 'blocked' : 'attention'} />}
          <span className="text-sm font-medium">{RUN_KIND_LABELS[run.kind]}</span>
          <RunStatusBadge status={run.status} />
          {run.trigger !== 'admin' && <Badge variant="outline" className="text-[10px]">{RUN_TRIGGER_LABELS[run.trigger]}</Badge>}
          {run.attempts > 1 && <Badge variant="outline" className="text-[10px]">ripreso (tentativo {run.attempts})</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {!compact && <span className="text-[11px] text-muted-foreground">avviato {formatAgo(run.started_at ?? run.created_at)}</span>}
          {active && (
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending || run.cancel_requested}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Interrompere il run?',
                  description: 'Il run si ferma al primo punto sicuro (mai a metà di una scrittura). Quello già fatto resta registrato nel ledger e una nuova esecuzione riprende da lì.',
                  confirmText: 'Interrompi',
                });
                if (ok) cancel.mutate();
              }}
            >
              <Square className="h-3.5 w-3.5" /> {run.cancel_requested ? 'Interruzione richiesta…' : 'Interrompi'}
            </Button>
          )}
        </div>
      </div>
      {active && (
        <div className="space-y-1">
          <Progress value={pct ?? undefined} className="h-1.5" />
          <p className="text-[11px] text-muted-foreground">
            {p.message ?? (run.status === 'queued' ? 'In attesa dell\'esecutore…' : 'In corso…')}
            {typeof p.done === 'number' && typeof p.total === 'number' ? ` · ${p.done}/${p.total}` : ''}
          </p>
        </div>
      )}
      {!active && run.error && (
        <p className="text-xs text-red-600">
          <span className="font-mono">{run.error.code}</span> — {run.error.message}
        </p>
      )}
      {!active && run.kind === 'archive' && run.summary && <ArchiveRunCounts summary={run.summary} />}
      {!active && !compact && (
        <p className="text-[11px] text-muted-foreground">
          Concluso {formatDateTime(run.finished_at)} · richiesto da {run.requested_by}
        </p>
      )}
    </div>
  );
}

/**
 * Conteggi di un run dell'archivio della Fase 0 (anche nel pannello compatto):
 * senza, un archivio con tutte le voci rifiutate sembrava riuscito.
 */
export function ArchiveRunCounts({ summary }: { summary: Record<string, unknown> }) {
  const n = (key: string): number => (typeof summary[key] === 'number' ? (summary[key] as number) : 0);
  const present = n('imported') + n('updated') + n('unchanged');
  const parts = [
    `${n('imported')} importati`,
    n('updated') > 0 ? `${n('updated')} aggiornati` : null,
    `${n('unchanged')} già presenti`,
    `${n('invalid')} non validi`,
    n('duplicates') > 0 ? `${n('duplicates')} duplicati` : null,
    n('conflicts') > 0 ? `${n('conflicts')} conflitti` : null,
    n('failed') > 0 ? `${n('failed')} non riusciti` : null,
  ].filter(Boolean);
  return (
    <p className={cn('text-[11px]', present === 0 || n('conflicts') > 0 || n('failed') > 0 ? 'text-amber-700' : 'text-muted-foreground')}>
      {parts.join(' · ')}
      {present === 0 && ' — nessun item nell\'archivio'}
    </p>
  );
}

export function DownloadReportButtons({ runId }: { runId: string }) {
  const [busy, setBusy] = useState<'json' | 'csv' | null>(null);
  const download = async (format: 'json' | 'csv') => {
    setBusy(format);
    try {
      await migrationApi.downloadReport(runId, format);
    } catch (err) {
      toast.error(migrationErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => download('json')}>
        {busy === 'json' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Report JSON
      </Button>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => download('csv')}>
        {busy === 'csv' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} CSV
      </Button>
    </div>
  );
}

// ─── Righe di un run ───────────────────────────────

function codeLabel(item: MigrationItemView): string {
  const code = item.code ?? '';
  if (!code) return '—';
  return CONFLICT_LABELS[code] ?? SKIP_LABELS[code] ?? DIFF_CODE_LABELS[code] ?? code;
}

function itemTitle(item: MigrationItemView): string {
  const d = item.detail ?? {};
  const summary = typeof d.summary === 'string' && d.summary ? d.summary : null;
  return summary ?? item.href ?? item.legacy_key ?? item.collection_name ?? '—';
}

/** Tabella paginata ("Carica altre") delle righe di un run con i filtri dati. */
export function RunItemsTable({
  runId,
  filter,
  calendarNames,
  selectable,
  selected,
  onToggle,
  emptyText = 'Nessuna riga.',
  pageSize = 50,
}: {
  runId: string;
  filter: RunItemsQuery;
  calendarNames?: Record<string, string>;
  selectable?: (item: MigrationItemView) => boolean;
  selected?: ReadonlySet<string>;
  onToggle?: (item: MigrationItemView) => void;
  emptyText?: string;
  pageSize?: number;
}) {
  const q = useInfiniteQuery({
    queryKey: migrationKeys.items(runId, { ...filter, limit: pageSize }),
    queryFn: ({ pageParam }) => migrationApi.runItems(runId, { ...filter, limit: pageSize, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;
  const [open, setOpen] = useState<string | null>(null);

  if (q.isLoading) return <p className="text-xs text-muted-foreground">Caricamento righe…</p>;
  if (q.isError) return <p className="text-xs text-red-600">{migrationErrorMessage(q.error)}</p>;
  if (items.length === 0) return <p className="text-xs text-muted-foreground">{emptyText}</p>;

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">{items.length} di {total} righe</p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left">
            <tr>
              {selectable && <th className="px-2 py-1.5 w-8" />}
              <th className="px-2 py-1.5">Oggetto</th>
              <th className="px-2 py-1.5">Calendario</th>
              <th className="px-2 py-1.5">Esito</th>
              <th className="px-2 py-1.5">Codice</th>
              <th className="px-2 py-1.5 w-16" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const canSelect = selectable?.(item) ?? false;
              const expanded = open === item.id;
              const reason = typeof item.detail?.reason === 'string' ? (item.detail.reason as string) : null;
              return (
                <tr key={item.id} className="border-t align-top">
                  {selectable && (
                    <td className="px-2 py-1.5">
                      {canSelect && (
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5"
                          checked={selected?.has(item.id) ?? false}
                          onChange={() => onToggle?.(item)}
                          aria-label="Seleziona la riga"
                        />
                      )}
                    </td>
                  )}
                  <td className="px-2 py-1.5 max-w-[18rem]">
                    <div className="truncate font-medium" title={itemTitle(item)}>{itemTitle(item)}</div>
                    {item.href && <div className="truncate font-mono text-[10px] text-muted-foreground" title={item.href}>{item.href}</div>}
                    {expanded && (
                      <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-[10px] whitespace-pre-wrap break-all">
                        {JSON.stringify({ legacy_key: item.legacy_key, ...item.detail }, null, 2)}
                      </pre>
                    )}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{(item.calendar_id && calendarNames?.[item.calendar_id]) || item.collection_name || '—'}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <div className="flex flex-wrap gap-1">
                      {item.action && <Badge variant="outline" className="text-[10px]">{ACTION_LABELS[item.action]}</Badge>}
                      {item.outcome && <Badge variant="outline" className={cn('text-[10px]', item.outcome === 'failed' && 'text-red-600', item.outcome === 'conflict' && 'text-amber-600')}>{OUTCOME_LABELS[item.outcome]}</Badge>}
                      {item.level && <Badge variant="outline" className="text-[10px]">{item.level}</Badge>}
                      {item.item_type === 'diff' && (
                        item.expected
                          ? <Badge variant="outline" className="text-[10px] gap-1"><ColorDot color="yellow" />{item.accepted_at ? 'Accettata' : 'Attesa'}</Badge>
                          : <Badge variant="outline" className="text-[10px] gap-1"><ColorDot color="red" />Inattesa</Badge>
                      )}
                      {item.forced && <Badge variant="outline" className="text-[10px]">Forzato</Badge>}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="max-w-[16rem]">{codeLabel(item)}</div>
                    {reason && <div className="text-[10px] text-muted-foreground">{EXPECTED_REASON_LABELS[reason] ?? reason}</div>}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setOpen(expanded ? null : item.id)}>
                      {expanded ? 'Chiudi' : 'Dettagli'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && (
        <Button size="sm" variant="outline" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          {q.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Carica altre righe
        </Button>
      )}
    </div>
  );
}


