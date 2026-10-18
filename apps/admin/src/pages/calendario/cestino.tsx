/**
 * Cestino del calendario (contratto F6 §9.1.3 e §9.2.2): eventi eliminati con
 * almeno una versione ancora conservata, ripristinabili con lo stesso
 * identificativo (il dispositivo rivede l'evento con lo stesso UID). Visibile
 * solo con la capacità `trash`; in mode postgres la pagina spiega che non c'è.
 */

import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import type { CalV2TrashItem, CalV2TrashNotRestorableReason } from '@calicchia/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/shared/loading-state';
import { CalendarTabs } from '@/components/layout/calendar-tabs';
import { actorLabel, formatWhen } from '@/components/calendar/history-format';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';
import {
  CalV2ApiError,
  calV2ErrorMessage,
  calV2Keys,
  listTrashV2,
  restoreTrashV2,
  useCalendarV2Capabilities,
} from '@/lib/calendar-v2-api';

interface CalendarOption {
  id: string;
  name: string;
}

const PAGE_SIZE = 50;

const REASON_TEXT: Record<CalV2TrashNotRestorableReason | 'href_taken', string> = {
  uid_exists: 'Esiste già un evento attivo con lo stesso identificativo.',
  calendar_gone: 'Il calendario di origine non esiste più: scegli dove ripristinarlo.',
  calendar_readonly: 'Il calendario di origine è in sola lettura: scegli un altro calendario.',
  no_valid_version: 'Non resta nessuna versione valida da ripristinare.',
  expired: 'Le versioni di questo evento sono scadute.',
  href_taken: 'Nel calendario c\'è già una risorsa con lo stesso indirizzo.',
};

/** Con questi motivi basta scegliere un altro calendario di destinazione. */
const FIXABLE_BY_CALENDAR = new Set<string>(['calendar_gone', 'calendar_readonly']);

function reasonText(reason: unknown): string | null {
  return typeof reason === 'string' && reason in REASON_TEXT ? REASON_TEXT[reason as keyof typeof REASON_TEXT] : null;
}

function itemTitle(item: CalV2TrashItem): string {
  return item.summary?.trim() || '(senza titolo)';
}

// ─── Ripristino ───────────────────────────────

function RestoreDialog({ item, calendars, onClose, onDone }: {
  item: CalV2TrashItem;
  calendars: CalendarOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  // '' = calendario originale; obbligatorio sceglierne un altro se non esiste più o è in sola lettura.
  const mustChoose = item.not_restorable_reason !== null && FIXABLE_BY_CALENDAR.has(item.not_restorable_reason);
  const [calendarId, setCalendarId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = !busy && (!mustChoose || calendarId !== '') && (item.restorable || mustChoose);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const req = {
      ...(item.restore_version_id ? { version_id: item.restore_version_id } : {}),
      ...(calendarId ? { calendar_id: calendarId } : {}),
    };
    try {
      const dry = await restoreTrashV2(item.object_id, { ...req, dryRun: true });
      if (!dry.valid) {
        setError(dry.issues.find((i) => i.severity === 'error')?.message ?? 'Questo evento non si può ripristinare');
        return;
      }
      const result = await restoreTrashV2(item.object_id, req);
      for (const issue of result.issues.filter((i) => i.severity === 'warning')) toast.warning(issue.message);
      toast.success('Evento ripristinato');
      onDone();
    } catch (err) {
      if (err instanceof CalV2ApiError && (err.code === 'NOT_RESTORABLE' || err.code === 'VERSION_NOT_RESTORABLE')) {
        setError(reasonText(err.details?.reason) ?? err.message);
      } else {
        setError(calV2ErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ripristinare l&apos;evento?</DialogTitle>
          <DialogDescription>
            «{itemTitle(item)}» torna nel calendario con lo stesso identificativo: i dispositivi lo rivedono alla prossima sincronizzazione.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="cal-trash-destination" className="text-sm font-medium">Calendario di destinazione</label>
          <select
            id="cal-trash-destination"
            value={calendarId}
            disabled={busy}
            onChange={(e) => setCalendarId(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
          >
            <option value="">{mustChoose ? 'Scegli un calendario…' : `Originale${item.calendar_name ? ` (${item.calendar_name})` : ''}`}</option>
            {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {item.not_restorable_reason && <p className="text-xs text-muted-foreground">{REASON_TEXT[item.not_restorable_reason]}</p>}
        </div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Annulla</Button>
          <Button type="button" data-testid="cal-trash-restore-confirm" disabled={!canSubmit} onClick={() => { void submit(); }}>
            {busy ? 'Ripristino…' : 'Ripristina'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pagina ───────────────────────────────

export default function CestinoPage() {
  const queryClient = useQueryClient();
  const { caps, isLoading: capsLoading } = useCalendarV2Capabilities();
  const [calendarFilter, setCalendarFilter] = useState('');
  const [restoring, setRestoring] = useState<CalV2TrashItem | null>(null);

  useTopbar({
    title: 'Cestino del calendario',
    subtitle: 'Eventi eliminati, ripristinabili finché le loro versioni sono conservate',
  });

  const enabled = !!caps?.trash;
  const calendarsQuery = useQuery({
    queryKey: ['admin-calendars'],
    queryFn: () => apiFetch('/api/admin/calendar/calendars'),
    enabled,
  });
  const calendars: CalendarOption[] = ((calendarsQuery.data?.calendars ?? []) as Array<Partial<CalendarOption> & { id: string }>)
    .map((c) => ({ id: c.id, name: c.name ?? c.id }));

  const trashQuery = useInfiniteQuery({
    queryKey: calV2Keys.trash(calendarFilter || null),
    queryFn: ({ pageParam }) => listTrashV2({ calendarId: calendarFilter || undefined, before: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const items = trashQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const retentionDays = trashQuery.data?.pages[0]?.retention_days ?? null;
  const writesOff = caps ? !caps.objects.write : false;

  const restored = () => {
    setRestoring(null);
    void queryClient.invalidateQueries({ queryKey: ['admin-calendar-v2-trash'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-calendar-v2-object'] });
  };

  if (capsLoading) return <div className="space-y-6"><CalendarTabs /><LoadingState /></div>;
  if (!enabled) {
    return (
      <div className="space-y-6">
        <CalendarTabs />
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          Il cestino non è disponibile: richiede il calendario su Radicale.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CalendarTabs />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {retentionDays !== null ? `Gli eventi eliminati si conservano per ${retentionDays} giorni.` : 'Eventi eliminati di recente.'}
        </p>
        <select
          value={calendarFilter}
          onChange={(e) => setCalendarFilter(e.target.value)}
          aria-label="Filtra per calendario"
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
        >
          <option value="">Tutti i calendari</option>
          {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {trashQuery.isLoading && <LoadingState />}
      {trashQuery.isError && (
        <div className="space-y-2 rounded-lg border bg-card p-4">
          <p className="text-sm text-destructive">{calV2ErrorMessage(trashQuery.error)}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => { void trashQuery.refetch(); }}>Riprova</Button>
        </div>
      )}
      {trashQuery.data && items.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">Il cestino è vuoto.</div>
      )}

      <ul className="space-y-2">
        {items.map((item) => {
          const reasonFixable = item.not_restorable_reason !== null && FIXABLE_BY_CALENDAR.has(item.not_restorable_reason);
          const canRestore = (item.restorable || reasonFixable) && !writesOff;
          return (
            <li key={item.object_id} data-testid="cal-trash-item" className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-card p-3">
              <div className="min-w-0 space-y-0.5">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  <span className="break-words">{itemTitle(item)}</span>
                  {item.recurring && <Badge variant="secondary">Serie</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.start_utc ? `Inizio ${formatWhen(item.start_utc)} · ` : ''}
                  {item.calendar_name ?? 'Calendario eliminato'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Eliminato il {formatWhen(item.deleted_at)}{item.deleted_by ? ` da ${actorLabel(item.deleted_by)}` : ''} · disponibile fino al {formatWhen(item.expires_at)}
                </p>
                {item.not_restorable_reason && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">{REASON_TEXT[item.not_restorable_reason]}</p>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="cal-trash-restore"
                disabled={!canRestore}
                title={writesOff ? 'Le scritture sul calendario non sono disponibili' : undefined}
                onClick={() => setRestoring(item)}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Ripristina
              </Button>
            </li>
          );
        })}
      </ul>

      {trashQuery.hasNextPage && (
        <div className="flex justify-center">
          <Button type="button" size="sm" variant="outline" disabled={trashQuery.isFetchingNextPage} onClick={() => { void trashQuery.fetchNextPage(); }}>
            {trashQuery.isFetchingNextPage ? 'Caricamento…' : 'Mostra altri'}
          </Button>
        </div>
      )}

      {restoring && <RestoreDialog item={restoring} calendars={calendars} onClose={() => setRestoring(null)} onDone={restored} />}
    </div>
  );
}
