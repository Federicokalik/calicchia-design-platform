import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Plus, Copy, RotateCw, Trash2, Eye, EyeOff, Save, X, RefreshCw, Link as LinkIcon, Lock, Unlock,
  GripVertical, Download, Upload, ChevronDown, ChevronRight, Check, Pencil,
} from 'lucide-react';
import {
  CAL_V2_ASSIGNABLE_ROLES,
  type CalV2AssignableRole,
  type CalV2CalendarCreateRequest,
  type CalV2CalendarPatchRequest,
  type CalV2CalendarRole,
  type CalV2CalendarView,
  type CalV2Capabilities,
} from '@calicchia/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/shared/loading-state';
import { useTopbar } from '@/hooks/use-topbar';
import { useLocalizedPath } from '@/hooks/use-localized-navigation';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/hooks/use-confirm';
import { CalendarTabs } from '@/components/layout/calendar-tabs';
import { TzSelect } from '@/components/calendar/tz-select';
import { ImportDialog } from '@/components/calendar/import-dialog';
import { formatWhen } from '@/components/calendar/history-format';
import {
  CalV2ApiError,
  calV2ErrorMessage,
  calV2Keys,
  calendarExportUrl,
  createCalendarV2,
  deleteCalendarV2,
  listCalendarsV2,
  patchCalendarV2,
  reorderCalendarsV2,
  rotateCalendarTokenV2,
  useCalendarV2Capabilities,
} from '@/lib/calendar-v2-api';

interface Calendar {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  timezone: string;
  is_default: boolean;
  is_system: boolean;
  blocks_availability: boolean;
  ics_feed_token: string;
  ics_feed_enabled: boolean;
  ics_feed_url: string | null;
  sort_order: number;
  event_count: number;
}

/**
 * Con la capacità `calendar_properties` (API v2 su Radicale) la pagina mostra
 * i calendari v2; senza, resta com'è oggi (v1). Capacità in caricamento o
 * illeggibili → v1, come l'host dell'editor eventi.
 */
export default function CalendariPage() {
  const { caps } = useCalendarV2Capabilities();
  return caps?.calendar_properties ? <CalendariV2Page caps={caps} /> : <CalendariV1Page />;
}

function CalendariV1Page() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Calendar | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-calendars'],
    queryFn: () => apiFetch('/api/admin/calendar/calendars'),
  });

  const toggleFeed = useMutation({
    mutationFn: ({ id, ics_feed_enabled }: { id: string; ics_feed_enabled: boolean }) =>
      apiFetch(`/api/admin/calendar/calendars/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ ics_feed_enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
      toast.success('Feed aggiornato');
    },
  });

  const rotateToken = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/calendar/calendars/${id}/rotate-token`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
      toast.success('Token rigenerato — il vecchio link non funziona più');
    },
  });

  const toggleBlocking = useMutation({
    mutationFn: ({ id, blocks_availability }: { id: string; blocks_availability: boolean }) =>
      apiFetch(`/api/admin/calendar/calendars/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ blocks_availability }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
      toast.success('Blocco disponibilita aggiornato');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/calendar/calendars/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
      toast.success('Calendario eliminato');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  useTopbar({
    title: 'Calendari',
    subtitle: 'Caldes Calendar — multi-calendario self-hosted',
    actions: (
      <Button size="sm" onClick={() => { setEditing(null); setShowNew(true); }}>
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Nuovo calendario
      </Button>
    ),
  });

  const calendars: Calendar[] = data?.calendars || [];

  return (
    <div className="space-y-6">
      <CalendarTabs />

      {/* key: cliccando "Modifica" su un altro calendario a form aperto, lo stato del
          form restava quello del primo e veniva salvato sul secondo */}
      {showNew && <CalendarForm key={editing?.id ?? 'new'} onClose={() => { setShowNew(false); setEditing(null); }} initial={editing} />}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Caricamento…</p>
      ) : calendars.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">Nessun calendario.</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {calendars.map((cal) => (
            <div key={cal.id} className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <div className="h-3 w-3 rounded-full mt-1 shrink-0" style={{ backgroundColor: cal.color }} />
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm truncate">{cal.name}</h3>
                    <p className="text-xs text-muted-foreground truncate">/{cal.slug} · {cal.event_count} eventi</p>
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {cal.is_default && <Badge variant="default" className="text-[10px]">Default</Badge>}
                  {cal.is_system && <Badge variant="outline" className="text-[10px]">Sistema</Badge>}
                  {cal.blocks_availability && <Badge variant="outline" className="text-[10px]">Blocca slot</Badge>}
                </div>
              </div>

              {cal.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">{cal.description}</p>
              )}

              <div className="space-y-1.5 pt-2 border-t">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">ICS Feed (subscription URL)</p>
                {cal.ics_feed_enabled && cal.ics_feed_url ? (
                  <div className="flex items-center gap-1">
                    <code className="text-[11px] bg-muted px-2 py-1 rounded truncate flex-1 font-mono">
                      {cal.ics_feed_url}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => {
                        navigator.clipboard.writeText(cal.ics_feed_url!);
                        toast.success('URL copiato');
                      }}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">Feed disattivato</p>
                )}
              </div>

              <div className="flex items-center gap-1 pt-2 border-t">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => { setEditing(cal); setShowNew(true); }}
                >
                  Modifica
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => toggleFeed.mutate({ id: cal.id, ics_feed_enabled: !cal.ics_feed_enabled })}
                  title={cal.ics_feed_enabled ? 'Disattiva feed ICS' : 'Attiva feed ICS'}
                >
                  {cal.ics_feed_enabled ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => toggleBlocking.mutate({ id: cal.id, blocks_availability: !cal.blocks_availability })}
                  title={cal.blocks_availability ? 'Non bloccare slot e capacity' : 'Blocca slot e capacity'}
                >
                  {cal.blocks_availability ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={async () => {
                    if (await confirm({ title: 'Rigenerare il token?', description: 'I client che usano l\'URL attuale smetteranno di sincronizzare.', confirmText: 'Rigenera', variant: 'destructive' })) {
                      rotateToken.mutate(cal.id);
                    }
                  }}
                  title="Rigenera token feed"
                >
                  <RotateCw className="h-3 w-3" />
                </Button>
                {!cal.is_system && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-destructive ml-auto"
                    onClick={async () => {
                      if (await confirm({ title: `Eliminare "${cal.name}"?`, description: `Verranno rimossi anche i suoi ${cal.event_count} eventi. Operazione non reversibile.`, variant: 'destructive' })) {
                        remove.mutate(cal.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <SubscriptionsPanel calendars={calendars} />
    </div>
  );
}

// ============================================
// SUBSCRIPTIONS (ICS pull da Google Calendar / Apple / Outlook senza OAuth)
// ============================================

interface Subscription {
  id: string;
  calendar_id: string;
  name: string;
  ics_url: string;
  sync_enabled: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  event_count: number;
  created_at: string;
  updated_at: string;
}

/** Quel che serve ai pannelli delle iscrizioni: valido sia per i calendari v1 sia per quelli v2. */
interface CalendarOption {
  id: string;
  name: string;
}

function SubscriptionsPanel({ calendars }: { calendars: CalendarOption[] }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-calendar-subscriptions'],
    queryFn: () => apiFetch('/api/admin/calendar/subscriptions'),
  });

  const subscriptions: Subscription[] = data?.subscriptions || [];
  const calendarById = new Map(calendars.map((c) => [c.id, c]));

  const toggle = useMutation({
    mutationFn: ({ id, sync_enabled }: { id: string; sync_enabled: boolean }) =>
      apiFetch(`/api/admin/calendar/subscriptions/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ sync_enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-calendar-subscriptions'] }),
  });

  const sync = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/calendar/subscriptions/${id}/sync`, { method: 'POST' }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
      queryClient.invalidateQueries({ queryKey: calV2Keys.calendars });
      if (res?.sync?.notModified) toast.info('Nessuna modifica dall\'ultima sincronizzazione');
      else if (res?.sync?.error) toast.error(res.sync.error);
      else toast.success(`Importati ${res?.sync?.inserted ?? 0} eventi`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/calendar/subscriptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
      queryClient.invalidateQueries({ queryKey: calV2Keys.calendars });
      toast.success('Sottoscrizione eliminata');
    },
  });

  return (
    <div className="border-t pt-6 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <LinkIcon className="h-3.5 w-3.5" /> Sottoscrizioni esterne (ICS)
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Importa calendari read-only da URL ICS pubblico (es. Google Calendar &gt; Impostazioni &gt; URL segreto in formato iCal).
            Gli eventi importati bloccano gli slot di booking ma NON appaiono nel feed Caldes in uscita.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowNew(true)} disabled={calendars.length === 0}>
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Nuova sottoscrizione
        </Button>
      </div>

      {showNew && (
        <SubscriptionForm
          calendars={calendars}
          onClose={() => setShowNew(false)}
        />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Caricamento…</p>
      ) : subscriptions.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center">
          <p className="text-xs text-muted-foreground">Nessuna sottoscrizione attiva.</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {subscriptions.map((sub) => {
            const cal = calendarById.get(sub.calendar_id);
            return (
              <div key={sub.id} className="rounded-lg border bg-card p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm truncate">{sub.name}</h3>
                    <p className="text-xs text-muted-foreground truncate">
                      → {cal ? cal.name : 'calendario rimosso'} · {sub.event_count} eventi
                    </p>
                  </div>
                  {!sub.sync_enabled && <Badge variant="outline" className="text-[10px]">Pausa</Badge>}
                </div>

                <code className="block text-[10px] bg-muted px-2 py-1 rounded truncate font-mono">
                  {sub.ics_url}
                </code>

                <div className="text-[11px] text-muted-foreground">
                  {sub.last_error ? (
                    <span className="text-destructive">Errore: {sub.last_error}</span>
                  ) : sub.last_synced_at ? (
                    <span>Sincronizzato {new Date(sub.last_synced_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}</span>
                  ) : (
                    <span>Mai sincronizzato</span>
                  )}
                </div>

                <div className="flex items-center gap-1 pt-1 border-t">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => sync.mutate(sub.id)}
                    disabled={sync.isPending}
                    title="Sincronizza ora"
                  >
                    <RefreshCw className={`h-3 w-3 ${sync.isPending ? 'animate-spin' : ''}`} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => toggle.mutate({ id: sub.id, sync_enabled: !sub.sync_enabled })}
                    title={sub.sync_enabled ? 'Metti in pausa' : 'Riattiva'}
                  >
                    {sub.sync_enabled ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-destructive ml-auto"
                    onClick={async () => {
                      if (await confirm({ title: `Eliminare la sottoscrizione "${sub.name}"?`, description: `Verranno rimossi anche i ${sub.event_count} eventi importati.`, variant: 'destructive' })) {
                        remove.mutate(sub.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SubscriptionForm({ calendars, onClose }: { calendars: CalendarOption[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [icsUrl, setIcsUrl] = useState('');
  const [calendarId, setCalendarId] = useState(calendars[0]?.id || '');

  const create = useMutation({
    mutationFn: () =>
      apiFetch('/api/admin/calendar/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          ics_url: icsUrl.trim(),
          calendar_id: calendarId,
        }),
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
      queryClient.invalidateQueries({ queryKey: calV2Keys.calendars });
      if (res?.sync?.error) toast.error(`Sottoscrizione creata ma sync fallito: ${res.sync.error}`);
      else toast.success(`Sottoscrizione creata, importati ${res?.sync?.inserted ?? 0} eventi`);
      onClose();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Nuova sottoscrizione ICS</h3>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="grid gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Nome *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background"
            placeholder="Es. Google Lavoro"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">URL ICS *</label>
          <input
            type="url"
            value={icsUrl}
            onChange={(e) => setIcsUrl(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background font-mono"
            placeholder="https://calendar.google.com/calendar/ical/..."
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Su Google Calendar: Impostazioni → seleziona calendario → "URL segreto in formato iCal".
          </p>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Calendario destinazione *</label>
          <select
            value={calendarId}
            onChange={(e) => setCalendarId(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background"
          >
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="ghost" onClick={onClose}>Annulla</Button>
        <Button size="sm" onClick={() => create.mutate()} disabled={!name || !icsUrl || !calendarId || create.isPending}>
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {create.isPending ? 'Creazione…' : 'Crea e sincronizza'}
        </Button>
      </div>
    </div>
  );
}

function CalendarForm({ onClose, initial }: { onClose: () => void; initial: Calendar | null }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name || '');
  const [slug, setSlug] = useState(initial?.slug || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [color, setColor] = useState(initial?.color || '#7c3aed');
  const [timezone, setTimezone] = useState(initial?.timezone || 'Europe/Rome');
  const [isDefault, setIsDefault] = useState(initial?.is_default || false);
  const [blocksAvailability, setBlocksAvailability] = useState(initial?.blocks_availability ?? true);

  function autoSlug(value: string) {
    return value.trim().toLowerCase()
      .replace(/[àáâãä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
      .replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u')
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        slug: slug.toLowerCase(),
        name: name.trim(),
        description: description.trim() || null,
        color,
        timezone,
        is_default: isDefault,
        blocks_availability: blocksAvailability,
      });
      return initial
        ? apiFetch(`/api/admin/calendar/calendars/${initial.id}`, { method: 'PUT', body })
        : apiFetch('/api/admin/calendar/calendars', { method: 'POST', body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
      queryClient.invalidateQueries({ queryKey: calV2Keys.calendars });
      toast.success(initial ? 'Calendario aggiornato' : 'Calendario creato');
      onClose();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">{initial ? `Modifica "${initial.name}"` : 'Nuovo calendario'}</h3>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Nome *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); if (!initial && !slug) setSlug(autoSlug(e.target.value)); }}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background"
            placeholder="Es. Family"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Slug *</label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(autoSlug(e.target.value))}
            disabled={!!initial}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background font-mono disabled:opacity-50"
            placeholder="family"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Colore</label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-full h-10 px-1 py-1 rounded-md border bg-background cursor-pointer"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Timezone</label>
          <input
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background font-mono"
            placeholder="Europe/Rome"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs text-muted-foreground mb-1">Descrizione</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background"
          />
        </div>
        <div className="md:col-span-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Imposta come calendario di default
          </label>
        </div>
        <div className="md:col-span-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={blocksAvailability} onChange={(e) => setBlocksAvailability(e.target.checked)} />
            Blocca disponibilita e capacity
          </label>
          <p className="text-[11px] text-muted-foreground mt-1">
            Gli eventi confermati di questo calendario impediscono nuovi booking e pesano sul limite settimanale.
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="ghost" onClick={onClose}>Annulla</Button>
        <Button size="sm" onClick={() => save.mutate()} disabled={!name || !slug || save.isPending}>
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {save.isPending ? 'Salvataggio…' : 'Salva'}
        </Button>
      </div>
    </div>
  );
}

// ============================================
// CALENDARI v2 (Radicale; capacità `calendar_properties`, contratto F6 §9.2.3)
// ============================================

const ROLE_LABEL: Record<CalV2CalendarRole, string> = {
  user: 'Personale',
  bookings: 'Prenotazioni',
  holidays: 'Festività',
  deadlines: 'Scadenze',
  subscription: 'Iscrizione',
  tasks: 'Attività',
};

const ROLE_OPTION_LABEL: Record<CalV2AssignableRole, string> = {
  user: 'Personale',
  deadlines: 'Scadenze',
};

const READONLY_LABEL: Record<NonNullable<CalV2CalendarView['readonly_reason']>, string> = {
  subscription: 'Iscrizione (sola lettura)',
  archive: 'Archivio (sola lettura)',
};

const HEALTH_BADGE: Record<'stale' | 'unsyncable' | 'hold', string> = {
  stale: 'Non aggiornato',
  unsyncable: 'Non sincronizzabile',
  hold: 'In sospeso (hold)',
};

const WRITE_BLOCK_TEXT: Record<string, string> = {
  STORE_POSTGRES: 'il calendario usa ancora l\'archivio interno',
  WRITES_SUSPENDED: 'è in corso un cambio di modalità del calendario',
  WRITE_FREEZE: 'è attivo un blocco delle scritture di manutenzione',
  RADICALE_UNCONFIGURED: 'Radicale non è configurato',
  API_LEVEL_BLOCKED: 'il livello dell\'API non consente le scritture',
};

/** Invalidazioni dopo ogni scrittura sui calendari: query v2 toccate più quelle v1 di oggi (§9.2). */
function invalidateCalendarQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: calV2Keys.calendars });
  void queryClient.invalidateQueries({ queryKey: calV2Keys.syncState });
  void queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
  void queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
  void queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copiato`);
  } catch {
    toast.error('Impossibile copiare: selezionalo e copialo a mano');
  }
}

function slugFromName(value: string): string {
  return value.trim().toLowerCase()
    .replace(/[àáâãä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function CalendariV2Page({ caps }: { caps: CalV2Capabilities }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const localizedPath = useLocalizedPath();
  const [form, setForm] = useState<CalV2CalendarView | 'new' | null>(null);
  const [importing, setImporting] = useState<CalV2CalendarView | null>(null);

  const canWrite = caps.objects.write;
  const writeBlockedReason = canWrite ? null : caps.reasons.map((r) => WRITE_BLOCK_TEXT[r]).filter(Boolean).join('; ') || null;

  const { data, isLoading, error } = useQuery({
    queryKey: calV2Keys.calendars,
    queryFn: listCalendarsV2,
    retry: false,
  });
  const calendars = data?.calendars ?? [];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderCalendarsV2(ids),
    onSuccess: (list) => {
      queryClient.setQueryData(calV2Keys.calendars, list);
      void queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
    },
    onError: (err) => {
      toast.error(calV2ErrorMessage(err));
      void queryClient.invalidateQueries({ queryKey: calV2Keys.calendars });
    },
  });

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = calendars.findIndex((c) => c.id === active.id);
    const to = calendars.findIndex((c) => c.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(calendars, from, to);
    // Ordine mostrato subito; la risposta del server lo conferma (o lo ripristina in caso di errore).
    queryClient.setQueryData(calV2Keys.calendars, { calendars: next });
    reorder.mutate(next.map((c) => c.id));
  };

  const patch = useMutation({
    mutationFn: ({ id, req }: { id: string; req: CalV2CalendarPatchRequest }) => patchCalendarV2(id, req),
    onSuccess: () => invalidateCalendarQueries(queryClient),
    onError: (err) => toast.error(calV2ErrorMessage(err)),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => rotateCalendarTokenV2(id),
    onSuccess: () => {
      invalidateCalendarQueries(queryClient);
      toast.success('Link del feed rigenerato: il vecchio non funziona più');
    },
    onError: (err) => toast.error(calV2ErrorMessage(err)),
  });

  const removeCalendar = async (cal: CalV2CalendarView) => {
    const first = await confirm({
      title: `Eliminare "${cal.name}"?`,
      description: cal.object_count > 0
        ? `Il calendario contiene ${cal.object_count} ${cal.object_count === 1 ? 'oggetto' : 'oggetti'}. Nel passo successivo ti chiederò di confermare anche la loro eliminazione.`
        : 'Il calendario è vuoto. Operazione non reversibile.',
      confirmText: 'Elimina',
      variant: 'destructive',
    });
    if (!first) return;
    try {
      await deleteCalendarV2(cal.id);
    } catch (err) {
      if (err instanceof CalV2ApiError && err.code === 'CALENDAR_NOT_EMPTY') {
        const raw = err.details?.object_count;
        const count = typeof raw === 'number' ? raw : cal.object_count;
        const second = await confirm({
          title: `Eliminare anche ${count} ${count === 1 ? 'oggetto' : 'oggetti'}?`,
          description: `"${cal.name}" non è vuoto: eliminandolo spariscono anche i suoi ${count} ${count === 1 ? 'oggetto' : 'oggetti'}, dai dispositivi collegati. Operazione non reversibile.`,
          confirmText: `Elimina calendario e ${count} ${count === 1 ? 'oggetto' : 'oggetti'}`,
          variant: 'destructive',
        });
        if (!second) return;
        try {
          await deleteCalendarV2(cal.id, { withObjects: true });
        } catch (err2) {
          toast.error(calV2ErrorMessage(err2));
          return;
        }
      } else {
        toast.error(calV2ErrorMessage(err));
        return;
      }
    }
    invalidateCalendarQueries(queryClient);
    toast.success('Calendario eliminato');
  };

  useTopbar({
    title: 'Calendari',
    subtitle: 'Caldes Calendar — calendari sincronizzati con i dispositivi',
    actions: (
      <Button
        size="sm"
        onClick={() => setForm('new')}
        disabled={!canWrite}
        title={writeBlockedReason ? `Non disponibile: ${writeBlockedReason}` : undefined}
      >
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Nuovo calendario
      </Button>
    ),
  });

  return (
    <div className="space-y-6">
      <CalendarTabs />

      {!canWrite && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
          Le modifiche ai calendari non sono disponibili{writeBlockedReason ? `: ${writeBlockedReason}` : ''}.
        </p>
      )}

      {form && (
        <CalendarFormV2
          key={form === 'new' ? 'new' : form.id}
          initial={form === 'new' ? null : form}
          canWrite={canWrite}
          onClose={() => setForm(null)}
          onSaved={() => { invalidateCalendarQueries(queryClient); setForm(null); }}
        />
      )}

      {isLoading ? (
        <LoadingState />
      ) : error && !data ? (
        <p role="alert" className="text-sm text-destructive">{calV2ErrorMessage(error)}</p>
      ) : calendars.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">Nessun calendario.</p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={calendars.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {calendars.map((cal) => (
                <CalendarRowV2
                  key={cal.id}
                  cal={cal}
                  caps={caps}
                  canWrite={canWrite}
                  healthHref={caps.health_page ? localizedPath('/calendario/salute') : null}
                  onEdit={() => setForm(cal)}
                  onImport={() => setImporting(cal)}
                  onDelete={() => { void removeCalendar(cal); }}
                  onPatch={(req) => patch.mutate({ id: cal.id, req })}
                  onRotate={() => rotate.mutate(cal.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {importing && (
        <ImportDialog
          calendar={importing}
          canWrite={canWrite}
          writeBlockedReason={writeBlockedReason}
          onClose={() => setImporting(null)}
          onImported={() => invalidateCalendarQueries(queryClient)}
        />
      )}

      <SubscriptionsPanel calendars={calendars.filter((c) => c.readonly_reason === null)} />
    </div>
  );
}

function CalendarRowV2({ cal, caps, canWrite, healthHref, onEdit, onImport, onDelete, onPatch, onRotate }: {
  cal: CalV2CalendarView;
  caps: CalV2Capabilities;
  canWrite: boolean;
  healthHref: string | null;
  onEdit: () => void;
  onImport: () => void;
  onDelete: () => void;
  onPatch: (req: CalV2CalendarPatchRequest) => void;
  onRotate: () => void;
}) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: cal.id,
    disabled: !canWrite,
  });
  const readonly = cal.readonly_reason !== null;
  const editable = canWrite && !readonly;
  const unhealthy = cal.sync && cal.sync.health !== 'healthy' ? cal.sync.health : null;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="cal-calendar-row"
      data-calendar-id={cal.id}
      data-slug={cal.slug}
      className={cn('rounded-lg border bg-card', isDragging && 'relative z-10 opacity-80 shadow-lg')}
    >
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          disabled={!canWrite}
          aria-label={`Trascina per riordinare "${cal.name}"`}
          title={canWrite ? 'Trascina per riordinare' : 'Riordino non disponibile'}
          className="mt-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: cal.color }} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-sm font-semibold">{cal.name}</h3>
            <span className="text-xs text-muted-foreground">/{cal.slug} · {cal.object_count} {cal.object_count === 1 ? 'oggetto' : 'oggetti'}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {cal.is_default && <Badge variant="default" className="text-[10px]">Default</Badge>}
            {cal.is_system && <Badge variant="outline" className="text-[10px]">Sistema</Badge>}
            {cal.role !== 'user' && <Badge variant="outline" className="text-[10px]">{ROLE_LABEL[cal.role]}</Badge>}
            {cal.readonly_reason && <Badge variant="outline" className="text-[10px]">{READONLY_LABEL[cal.readonly_reason]}</Badge>}
            {cal.blocks_availability && <Badge variant="outline" className="text-[10px]">Blocca slot</Badge>}
            {cal.needs_review && (
              <Badge
                variant="outline"
                data-testid="cal-calendar-new-badge"
                title={cal.review_reason ?? undefined}
                className="border-sky-400 text-[10px] text-sky-700 dark:text-sky-300"
              >
                Nuovo dal dispositivo
              </Badge>
            )}
            {unhealthy && (
              healthHref ? (
                <Link to={healthHref} title="Apri la salute del calendario">
                  <Badge variant="outline" className="border-amber-400 text-[10px] text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/30">
                    {HEALTH_BADGE[unhealthy]}
                  </Badge>
                </Link>
              ) : (
                <Badge variant="outline" className="border-amber-400 text-[10px] text-amber-700 dark:text-amber-300">{HEALTH_BADGE[unhealthy]}</Badge>
              )
            )}
          </div>
          {cal.description && <p className="line-clamp-2 text-xs text-muted-foreground">{cal.description}</p>}
          {cal.sync && (
            <p className="text-[11px] text-muted-foreground">
              Ultima sincronizzazione: {formatWhen(cal.sync.last_synced_at)}
              {cal.sync.pending_deletions > 0 && ` · ${cal.sync.pending_deletions} cancellazioni sospese`}
              {cal.sync.quarantined_count > 0 && ` · ${cal.sync.quarantined_count} in quarantena`}
            </p>
          )}
          {cal.needs_review && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-200">
              <span className="min-w-0 flex-1">Un dispositivo ha creato questo calendario. Controllalo e segnalo come visto.</span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                data-testid="cal-calendar-review-ack"
                disabled={!canWrite}
                onClick={() => onPatch({ needs_review: false })}
              >
                <Check className="mr-1 h-3 w-3" /> Segna come visto
              </Button>
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 shrink-0 p-0"
          aria-expanded={open}
          aria-label={open ? 'Nascondi i dettagli' : 'Mostra i dettagli'}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
      </div>

      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Indirizzo CalDAV per i dispositivi</p>
            {cal.device_url ? (
              <div className="flex items-center gap-1">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">{cal.device_url}</code>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Copia l'indirizzo" aria-label="Copia l'indirizzo CalDAV" onClick={() => { void copyText(cal.device_url as string, 'Indirizzo'); }}>
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <p className="text-xs italic text-muted-foreground">Non visibile ai dispositivi</p>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Feed ICS (link di iscrizione)</p>
            {cal.ics_feed_enabled && cal.feed_url ? (
              <div className="flex items-center gap-1">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">{cal.feed_url}</code>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Copia il link" aria-label="Copia il link del feed" onClick={() => { void copyText(cal.feed_url as string, 'Link'); }}>
                  <Copy className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  title="Rigenera il link"
                  aria-label="Rigenera il link del feed"
                  disabled={!editable}
                  onClick={async () => {
                    if (await confirm({
                      title: 'Rigenerare il link del feed?',
                      description: 'Chi usa il link attuale smetterà di ricevere gli aggiornamenti: dovrà iscriversi di nuovo con il nuovo link.',
                      confirmText: 'Rigenera',
                      variant: 'destructive',
                    })) onRotate();
                  }}
                >
                  <RotateCw className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <p className="text-xs italic text-muted-foreground">Feed disattivato</p>
            )}
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={cal.ics_feed_enabled}
                disabled={!editable}
                onChange={(e) => onPatch({ ics_feed_enabled: e.target.checked })}
              />
              {cal.ics_feed_enabled ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />} Feed ICS attivo
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={cal.device_visible}
                disabled={!editable}
                onChange={(e) => onPatch({ device_visible: e.target.checked })}
              />
              <LinkIcon className="h-3 w-3" /> Visibile ai dispositivi
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={cal.blocks_availability}
                disabled={!editable}
                onChange={(e) => onPatch({ blocks_availability: e.target.checked })}
              />
              {cal.blocks_availability ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />} Blocca slot e capacity
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">Fuso: {cal.timezone}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid="cal-calendar-edit" disabled={!canWrite} onClick={onEdit}>
          <Pencil className="mr-1 h-3 w-3" /> Modifica
        </Button>
        {caps.import_export && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              data-testid="cal-import-open"
              disabled={!editable}
              title={readonly ? 'Calendario in sola lettura' : undefined}
              onClick={onImport}
            >
              <Upload className="mr-1 h-3 w-3" /> Importa
            </Button>
            <a
              href={calendarExportUrl(cal.id)}
              download
              data-testid="cal-export-link"
              className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
            >
              <Download className="mr-1 h-3 w-3" /> Esporta
            </a>
          </>
        )}
        {cal.deletable && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 px-2 text-xs text-destructive"
            disabled={!canWrite}
            onClick={onDelete}
            aria-label={`Elimina "${cal.name}"`}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function CalendarFormV2({ initial, canWrite, onClose, onSaved }: {
  initial: CalV2CalendarView | null;
  canWrite: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState(initial?.color ?? '#7c3aed');
  const [timezone, setTimezone] = useState(initial?.timezone ?? 'Europe/Rome');
  const [role, setRole] = useState<CalV2AssignableRole>(
    initial && (CAL_V2_ASSIGNABLE_ROLES as readonly string[]).includes(initial.role) ? (initial.role as CalV2AssignableRole) : 'user',
  );
  const [blocksAvailability, setBlocksAvailability] = useState(initial?.blocks_availability ?? true);
  const [deviceVisible, setDeviceVisible] = useState(initial?.device_visible ?? true);
  const [feedEnabled, setFeedEnabled] = useState(initial?.ics_feed_enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Iscrizioni e archivio: solo nome e colore (il server rifiuta il resto con 403).
  const limited = initial?.readonly_reason != null;
  // Il ruolo si cambia solo se quello attuale è fra gli assegnabili (contratto §9.1.4).
  const roleEditable = !initial || (CAL_V2_ASSIGNABLE_ROLES as readonly string[]).includes(initial.role);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (initial) {
        const req: CalV2CalendarPatchRequest = {};
        if (name.trim() !== initial.name) req.name = name.trim();
        if (color !== initial.color) req.color = color;
        if (!limited) {
          const desc = description.trim() || null;
          if (desc !== (initial.description ?? null)) req.description = desc;
          if (timezone !== initial.timezone) req.timezone = timezone;
          if (roleEditable && role !== initial.role) req.role = role;
          if (blocksAvailability !== initial.blocks_availability) req.blocks_availability = blocksAvailability;
          if (deviceVisible !== initial.device_visible) req.device_visible = deviceVisible;
          if (feedEnabled !== initial.ics_feed_enabled) req.ics_feed_enabled = feedEnabled;
        }
        if (Object.keys(req).length === 0) {
          onClose();
          return;
        }
        await patchCalendarV2(initial.id, req);
        toast.success('Calendario aggiornato');
      } else {
        const req: CalV2CalendarCreateRequest = {
          name: name.trim(),
          ...(slug ? { slug } : {}),
          description: description.trim() || null,
          color,
          timezone,
          role,
          blocks_availability: blocksAvailability,
          device_visible: deviceVisible,
          ics_feed_enabled: feedEnabled,
        };
        await createCalendarV2(req);
        toast.success('Calendario creato');
      }
      onSaved();
    } catch (err) {
      setError(calV2ErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{initial ? `Modifica "${initial.name}"` : 'Nuovo calendario'}</h3>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose} aria-label="Chiudi">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {limited && (
        <p className="text-xs text-muted-foreground">Questo calendario è in sola lettura: puoi cambiare solo nome e colore.</p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="cal-form-name" className="mb-1 block text-xs text-muted-foreground">Nome *</label>
          <input
            id="cal-form-name"
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); if (!initial && (!slug || slug === slugFromName(name))) setSlug(slugFromName(e.target.value)); }}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Es. Family"
          />
        </div>
        <div>
          <label htmlFor="cal-form-slug" className="mb-1 block text-xs text-muted-foreground">Slug</label>
          <input
            id="cal-form-slug"
            type="text"
            value={slug}
            onChange={(e) => setSlug(slugFromName(e.target.value))}
            disabled={!!initial}
            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm disabled:opacity-50"
            placeholder="family"
          />
        </div>
        <div>
          <label htmlFor="cal-form-color" className="mb-1 block text-xs text-muted-foreground">Colore</label>
          <input
            id="cal-form-color"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-10 w-full cursor-pointer rounded-md border bg-background px-1 py-1"
          />
        </div>
        <div>
          <label htmlFor="cal-form-tz" className="mb-1 block text-xs text-muted-foreground">Fuso orario</label>
          <TzSelect id="cal-form-tz" value={timezone} onChange={setTimezone} disabled={limited} />
        </div>
        <div className="md:col-span-2">
          <label htmlFor="cal-form-desc" className="mb-1 block text-xs text-muted-foreground">Descrizione</label>
          <input
            id="cal-form-desc"
            type="text"
            value={description}
            disabled={limited}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
          />
        </div>
        {roleEditable && (
          <div>
            <label htmlFor="cal-form-role" className="mb-1 block text-xs text-muted-foreground">Tipo di calendario</label>
            <select
              id="cal-form-role"
              value={role}
              disabled={limited}
              onChange={(e) => setRole(e.target.value as CalV2AssignableRole)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
            >
              {CAL_V2_ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_OPTION_LABEL[r]}</option>)}
            </select>
          </div>
        )}
        <div className="space-y-2 md:col-span-2">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={blocksAvailability} disabled={limited} onChange={(e) => setBlocksAvailability(e.target.checked)} />
            <span>
              Blocca disponibilità e capacity
              <span className="block text-[11px] text-muted-foreground">Gli eventi di questo calendario impediscono nuove prenotazioni e pesano sul limite settimanale.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={deviceVisible} disabled={limited} onChange={(e) => setDeviceVisible(e.target.checked)} />
            <span>
              Visibile ai dispositivi
              <span className="block text-[11px] text-muted-foreground">iPhone, Android e altri client CalDAV vedono e sincronizzano questo calendario.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={feedEnabled} disabled={limited} onChange={(e) => setFeedEnabled(e.target.checked)} />
            <span>
              Feed ICS attivo
              <span className="block text-[11px] text-muted-foreground">Un link di iscrizione in sola lettura, utile per i calendari esterni.</span>
            </span>
          </label>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Annulla</Button>
        <Button size="sm" onClick={() => { void save(); }} disabled={!name.trim() || busy || !canWrite}>
          <Save className="mr-1.5 h-3.5 w-3.5" />
          {busy ? 'Salvataggio…' : 'Salva'}
        </Button>
      </div>
    </div>
  );
}
