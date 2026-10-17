import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { History } from 'lucide-react';
import type { CalV2VersionChangeKind, CalV2VersionSummary, CalV2WriteResult } from '@calicchia/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useConfirm } from '@/hooks/use-confirm';
import {
  CalV2ApiError,
  CalV2ConflictError,
  calV2ErrorMessage,
  calV2Keys,
  getVersionV2,
  listVersionsV2,
  restoreVersionV2,
} from '@/lib/calendar-v2-api';
import { describeTime, fieldLabel } from '@/lib/calendar-v2-model';
import { actorLabel, formatWhen } from './history-format';

const KIND_LABELS: Record<CalV2VersionChangeKind, string> = {
  create: 'Creato',
  update: 'Modificato',
  delete: 'Eliminato',
  restore: 'Ripristinato',
};

const NOT_RESTORABLE_TEXT: Record<string, string> = {
  invalid: 'la versione non è valida',
  expired: 'la versione è scaduta',
  other_object: 'la versione appartiene a un altro evento',
};

export interface HistoryDrawerProps {
  objectId: string;
  /** ETag della vista corrente dell'editor: serve al ripristino (`If-Match`). */
  etag: string | null;
  /** Fuso dell'evento, per mostrare gli orari della versione. */
  tz: string;
  /** Scrittura non ammessa ora (sola lettura, scritture sospese): il ripristino è disabilitato. */
  canRestore: boolean;
  /** Ci sono modifiche non salvate nell'editor: il ripristino le scarta. */
  formDirty: boolean;
  onClose: () => void;
  /** Versione ripristinata: l'editor ricarica la vista con il risultato. */
  onRestored: (result: CalV2WriteResult) => void;
}

/**
 * Cronologia di un evento (contratto F6 §9.2.2): elenco delle versioni
 * conservate, anteprima del testo e ripristino sull'evento vivo. Il ripristino
 * valuta prima con `dryRun`, chiede conferma e scrive con l'ETag corrente;
 * se l'evento è cambiato nel frattempo (412) ricarica l'elenco e chiede di nuovo.
 */
export function HistoryDrawer({ objectId, etag, tz, canRestore, formDirty, onClose, onRestored }: HistoryDrawerProps) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveEtag, setLiveEtag] = useState(etag);
  const [restoring, setRestoring] = useState(false);

  const listQuery = useQuery({
    queryKey: calV2Keys.versions(objectId),
    queryFn: () => listVersionsV2(objectId),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const versions = listQuery.data?.versions ?? [];
  const selected = versions.find((v) => v.id === selectedId) ?? null;

  const detailQuery = useQuery({
    queryKey: ['admin-calendar-v2-version', objectId, selectedId],
    queryFn: () => getVersionV2(objectId, selectedId!),
    enabled: !!selectedId,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const restore = async (version: CalV2VersionSummary, etagToUse: string, retried = false): Promise<void> => {
    setRestoring(true);
    try {
      const dry = await restoreVersionV2(objectId, etagToUse, { version_id: version.id, dryRun: true });
      if (!dry.valid) {
        toast.error(dry.issues.find((i) => i.severity === 'error')?.message ?? 'Questa versione non si può ripristinare');
        return;
      }
      const warnings = dry.issues.filter((i) => i.severity === 'warning').map((i) => i.message);
      const ok = await confirm({
        title: 'Ripristinare questa versione?',
        description: [
          `L'evento torna al testo del ${formatWhen(version.recorded_at)}: il ripristino è salvato come una nuova modifica e si può annullare ripristinando un'altra versione.`,
          ...warnings,
          formDirty ? 'Le modifiche non salvate dell\'editor andranno perse.' : '',
        ].filter(Boolean).join(' '),
      });
      if (!ok) return;
      const result = await restoreVersionV2(objectId, etagToUse, { version_id: version.id });
      toast.success('Versione ripristinata');
      onRestored(result);
    } catch (err) {
      if (err instanceof CalV2ConflictError) {
        // L'evento è cambiato dopo l'apertura: si ricarica l'elenco e si chiede di nuovo, una sola volta.
        const fresh = err.body.current.etag;
        setLiveEtag(fresh);
        void queryClient.invalidateQueries({ queryKey: calV2Keys.versions(objectId) });
        if (fresh && !retried) {
          toast.info('L\'evento è cambiato nel frattempo: ricontrolla e conferma di nuovo');
          await restore(version, fresh, true);
        } else {
          toast.error('L\'evento continua a cambiare: riprova tra un momento');
        }
        return;
      }
      if (err instanceof CalV2ApiError && err.code === 'VERSION_NOT_RESTORABLE') {
        const reason = typeof err.details?.reason === 'string' ? NOT_RESTORABLE_TEXT[err.details.reason] : null;
        toast.error(`Versione non ripristinabile${reason ? `: ${reason}` : ''}`);
        void queryClient.invalidateQueries({ queryKey: calV2Keys.versions(objectId) });
        return;
      }
      toast.error(calV2ErrorMessage(err));
    } finally {
      setRestoring(false);
    }
  };

  const detail = detailQuery.data;
  const component = detail?.view?.target ?? detail?.view?.master ?? null;
  const fields = component?.fields ?? null;
  const restoreDisabled = !canRestore || !liveEtag || restoring || !selected || selected.current || !selected.valid;

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="flex w-full flex-col gap-3 overflow-y-auto sm:max-w-2xl" aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" /> Cronologia</SheetTitle>
          <SheetDescription>
            {listQuery.data
              ? `Le versioni si conservano per ${listQuery.data.retention_days} giorni.`
              : 'Versioni precedenti dell\'evento.'}
          </SheetDescription>
        </SheetHeader>

        {listQuery.isLoading && <p className="text-sm text-muted-foreground">Caricamento…</p>}
        {listQuery.isError && (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{calV2ErrorMessage(listQuery.error)}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => { void listQuery.refetch(); }}>Riprova</Button>
          </div>
        )}
        {listQuery.data && versions.length === 0 && <p className="text-sm text-muted-foreground">Nessuna versione conservata.</p>}

        <ul className="space-y-1.5">
          {versions.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                data-testid="cal-history-item"
                aria-pressed={v.id === selectedId}
                onClick={() => setSelectedId(v.id)}
                className={`w-full rounded-md border p-2 text-left text-sm transition-colors hover:bg-muted/50 ${v.id === selectedId ? 'border-foreground bg-muted/40' : ''}`}
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{formatWhen(v.recorded_at)}</span>
                  <Badge variant="secondary">{KIND_LABELS[v.change_kind]}</Badge>
                  {v.current && <Badge>Corrente</Badge>}
                  {!v.valid && <Badge variant="outline">Non valida</Badge>}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {actorLabel(v.actor)}
                  {v.summary ? ` · ${v.summary}` : ''}
                </span>
                {v.changed_fields.length > 0 && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Cambiato: {v.changed_fields.map(fieldLabel).join(', ')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>

        {selected && (
          <section className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Anteprima del {formatWhen(selected.recorded_at)}</h4>
              <Button
                type="button"
                size="sm"
                data-testid="cal-history-restore"
                disabled={restoreDisabled}
                onClick={() => { if (liveEtag) void restore(selected, liveEtag); }}
              >
                {restoring ? 'Ripristino…' : 'Ripristina'}
              </Button>
            </div>
            {selected.current && <p className="text-xs text-muted-foreground">È già la versione corrente.</p>}
            {!selected.valid && <p className="text-xs text-muted-foreground">Questa versione non è valida e non si può ripristinare.</p>}
            {!canRestore && <p className="text-xs text-muted-foreground">Le scritture non sono disponibili: il ripristino è disabilitato.</p>}
            {detailQuery.isLoading && <p className="text-sm text-muted-foreground">Caricamento…</p>}
            {detailQuery.isError && <p className="text-sm text-destructive">{calV2ErrorMessage(detailQuery.error)}</p>}
            {detail && (
              <>
                {fields && (
                  <dl className="space-y-1 rounded-md bg-muted/40 p-3 text-sm">
                    <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">Titolo</dt><dd className="min-w-0 break-words">{fields.summary || '—'}</dd></div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Quando</dt>
                      <dd className="min-w-0">
                        {fields.start ? describeTime(fields.start, tz) : '—'}
                        {fields.end ? ` → ${describeTime(fields.end, tz)}` : ''}
                      </dd>
                    </div>
                    {fields.location && <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">Luogo</dt><dd className="min-w-0 break-words">{fields.location}</dd></div>}
                    {detail.view?.preview?.rrule_summary && (
                      <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">Ricorrenza</dt><dd className="min-w-0">{detail.view.preview.rrule_summary}</dd></div>
                    )}
                  </dl>
                )}
                <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-snug whitespace-pre-wrap break-all font-mono">
                  {detail.ics ?? 'Testo non disponibile'}
                </pre>
              </>
            )}
          </section>
        )}
      </SheetContent>
    </Sheet>
  );
}
