import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Calendar, Mail, Phone, Building, X, CheckCircle2, AlertCircle, Send, Video, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';
import { useConfirm } from '@/hooks/use-confirm';
import { useI18n } from '@/hooks/use-i18n';
import { CalendarTabs } from '@/components/layout/calendar-tabs';

interface BookingRow {
  id: string;
  uid: string;
  status: string;
  attendee_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  attendee_company: string | null;
  attendee_message: string | null;
  start_time: string;
  end_time: string;
  location_type: string;
  location_value: string | null;
  source: string;
  event_type_title: string;
  event_type_slug: string;
  event_type_color: string;
  event_type_duration: number;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
}

/** Nome del servizio di videocall dal link (stesse regole di lib/calendar/meeting-url.ts nell'API). */
function meetingProvider(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const is = (d: string) => host === d || host.endsWith(`.${d}`);
  if (is('meet.google.com')) return 'Google Meet';
  if (is('mega.nz') || is('mega.io') || is('mega.co.nz')) return 'MEGA';
  if (is('zoom.us') || is('zoom.com')) return 'Zoom';
  if (is('teams.microsoft.com') || is('teams.live.com')) return 'Microsoft Teams';
  if (is('meet.jit.si') || host.includes('jitsi')) return 'Jitsi';
  if (is('whereby.com')) return 'Whereby';
  if (is('webex.com')) return 'Webex';
  return null;
}

const isUrl = (value: string | null | undefined): value is string => !!value && /^https?:\/\//i.test(value);

const STATUS_VARIANT: Record<string, 'default' | 'outline' | 'secondary' | 'destructive'> = {
  pending: 'outline',
  confirmed: 'default',
  cancelled: 'destructive',
  rescheduled: 'outline',
  no_show: 'destructive',
  completed: 'secondary',
};

export default function PrenotazioniPage() {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<'all' | 'pending' | 'confirmed' | 'cancelled' | 'completed'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<BookingRow | null>(null);
  // Editor del link videocall nel pannello di dettaglio.
  const [linkEditing, setLinkEditing] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const [linkNotify, setLinkNotify] = useState(false);

  const selectBooking = (b: BookingRow | null) => {
    setSelected(b);
    setLinkEditing(false);
    setLinkDraft(b && isUrl(b.location_value) ? b.location_value : '');
    setLinkNotify(false);
  };

  const { data, isLoading } = useQuery({
    queryKey: ['admin-bookings', filter, search],
    queryFn: () => {
      const params = new URLSearchParams({
        status: filter === 'all' ? 'all' : filter,
        ...(search ? { search } : {}),
        limit: '100',
      });
      return apiFetch(`/api/admin/calendar/bookings?${params}`);
    },
  });

  const cancel = useMutation({
    mutationFn: (uid: string) => apiFetch(`/api/admin/calendar/bookings/${uid}/cancel`, {
      method: 'POST', body: JSON.stringify({ notify: true }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
      // Il cancel lato server cancella anche il calendar_event proiettato:
      // senza questa invalidation il calendario mostrava ancora l'evento.
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      toast.success(t('calendar.bookings.cancelled'));
      selectBooking(null);
    },
  });

  const mark = useMutation({
    mutationFn: ({ uid, status }: { uid: string; status: 'completed' | 'no_show' }) =>
      apiFetch(`/api/admin/calendar/bookings/${uid}/mark`, {
        method: 'POST', body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      // `selected` è una copia della riga: restava su 'Confermata' con le azioni attive
      selectBooking(null);
      toast.success(t('common.updated'));
    },
  });

  const updateLink = useMutation({
    mutationFn: async ({ uid, url, notify }: { uid: string; url: string; notify: boolean }) => {
      const res = await apiFetch(`/api/admin/calendar/bookings/${uid}/location`, {
        method: 'PATCH', body: JSON.stringify({ meeting_url: url }),
      });
      if (notify) {
        await apiFetch(`/api/admin/calendar/bookings/${uid}/resend-confirmation`, { method: 'POST' });
      }
      return { booking: (res?.booking ?? {}) as Partial<BookingRow>, notify };
    },
    onSuccess: ({ booking, notify }) => {
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      // `selected` è una copia della riga: aggiornala subito col nuovo luogo.
      setSelected((prev) => (prev
        ? { ...prev, location_type: booking.location_type ?? prev.location_type, location_value: booking.location_value ?? null }
        : prev));
      setLinkEditing(false);
      setLinkNotify(false);
      toast.success(t(notify ? 'calendar.bookings.meetingLinkSavedNotified' : 'calendar.bookings.meetingLinkSaved'));
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  const resend = useMutation({
    mutationFn: (uid: string) => apiFetch(`/api/admin/calendar/bookings/${uid}/resend-confirmation`, { method: 'POST' }),
    onSuccess: () => toast.success(t('calendar.bookings.emailResent')),
  });

  const approve = useMutation({
    mutationFn: (uid: string) => apiFetch(`/api/admin/calendar/bookings/${uid}/approve`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      toast.success(t('calendar.bookings.approved'));
      selectBooking(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  const reject = useMutation({
    mutationFn: (uid: string) => apiFetch(`/api/admin/calendar/bookings/${uid}/reject`, {
      method: 'POST', body: JSON.stringify({ notify: true }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      toast.success(t('calendar.bookings.rejected'));
      selectBooking(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  useTopbar({
    title: t('calendar.bookings'),
    subtitle: t('calendar.bookings.subtitle'),
  });

  const bookings: BookingRow[] = data?.bookings || [];
  const canEditLink = selected?.status === 'confirmed' || selected?.status === 'pending';
  const draftProvider = linkDraft.trim() ? meetingProvider(linkDraft.trim()) : null;
  const stats = data?.stats || {};

  return (
    <div className="space-y-4">
      <CalendarTabs />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {(['pending', 'confirmed', 'cancelled', 'completed', 'no_show'] as const).map((k) => (
          <div key={k} className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">{t(`booking.status.${k}`)}</p>
            <p className="text-2xl font-semibold mt-0.5">{stats[k] || 0}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        {(['all', 'pending', 'confirmed', 'cancelled', 'completed'] as const).map((k) => (
          <Button
            key={k}
            size="sm"
            variant={filter === k ? 'default' : 'outline'}
            onClick={() => setFilter(k)}
          >
            {k === 'all' ? t('common.all') : t(`booking.status.${k}`)}
          </Button>
        ))}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('calendar.bookings.search')}
          className="ml-auto px-3 py-2 text-sm rounded-md border bg-background min-w-[240px]"
        />
      </div>

      {/* List */}
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="rounded-lg border bg-card divide-y">
          {isLoading ? (
            <p className="text-sm text-muted-foreground p-4">{t('common.loading')}</p>
          ) : bookings.length === 0 ? (
            <p className="text-sm text-muted-foreground p-8 text-center">{t('calendar.bookings.empty')}</p>
          ) : (
            bookings.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`w-full text-left p-3 hover:bg-accent/50 transition flex items-center gap-3 ${selected?.id === b.id ? 'bg-accent' : ''}`}
                onClick={() => selectBooking(b)}
              >
                <div className="h-10 w-1 rounded-full shrink-0" style={{ backgroundColor: b.event_type_color }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-sm truncate">{b.attendee_name}</span>
                    <Badge variant={STATUS_VARIANT[b.status]} className="text-[10px] shrink-0">
                      {t(`booking.status.${b.status}`)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="truncate">{b.event_type_title}</span>
                    <span className="shrink-0">
                      {formatDateTime(b.start_time, {
                        day: 'numeric', month: 'short',
                        hour: '2-digit', minute: '2-digit',
                        timeZone: 'Europe/Rome',
                      })}
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail panel */}
        <div className="space-y-3">
          {selected ? (
            <div className="rounded-lg border bg-card p-4 space-y-3 sticky top-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-base">{selected.attendee_name}</h3>
                  <p className="text-xs text-muted-foreground font-mono">{selected.uid}</p>
                </div>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => selectBooking(null)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              <Badge variant={STATUS_VARIANT[selected.status]} className="text-[10px]">
                {t(`booking.status.${selected.status}`)}
              </Badge>

              <div className="space-y-2 pt-2 border-t text-sm">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <div className="font-medium">{selected.event_type_title}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateTime(selected.start_time, {
                        weekday: 'short', day: 'numeric', month: 'long',
                        hour: '2-digit', minute: '2-digit',
                        timeZone: 'Europe/Rome',
                      })} · {selected.event_type_duration} min
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <a href={`mailto:${selected.attendee_email}`} className="text-xs hover:underline">{selected.attendee_email}</a>
                </div>
                {selected.attendee_phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <a href={`tel:${selected.attendee_phone}`} className="text-xs hover:underline">{selected.attendee_phone}</a>
                  </div>
                )}
                {selected.attendee_company && (
                  <div className="flex items-center gap-2">
                    <Building className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs">{selected.attendee_company}</span>
                  </div>
                )}
                {selected.location_value && !isUrl(selected.location_value) && (
                  <div className="text-xs text-muted-foreground border-t pt-2 mt-2">
                    📍 {selected.location_value}
                  </div>
                )}
                {/* Link videocall della singola prenotazione (MEGA, Zoom, Meet...): vince sul tipo evento */}
                {(canEditLink || isUrl(selected.location_value)) && (
                  <div className="border-t pt-2 mt-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <Video className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-xs font-medium">{t('calendar.bookings.meetingLink')}</span>
                      {canEditLink && !linkEditing && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 ml-auto text-xs"
                          onClick={() => {
                            setLinkDraft(isUrl(selected.location_value) ? selected.location_value : '');
                            setLinkEditing(true);
                          }}
                        >
                          <Pencil className="h-3 w-3 mr-1" />
                          {isUrl(selected.location_value) ? t('calendar.bookings.meetingLinkEdit') : t('calendar.bookings.meetingLinkAdd')}
                        </Button>
                      )}
                    </div>
                    {!linkEditing && (isUrl(selected.location_value) ? (
                      <a
                        href={selected.location_value}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs text-primary hover:underline break-all"
                      >
                        {meetingProvider(selected.location_value) ? `${meetingProvider(selected.location_value)} — ` : ''}
                        {selected.location_value}
                      </a>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('calendar.bookings.meetingLinkNone')}</p>
                    ))}
                    {linkEditing && (
                      <form
                        className="space-y-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const url = linkDraft.trim();
                          if (!/^https:\/\/[^\s]+$/i.test(url)) {
                            toast.error(t('calendar.bookings.meetingLinkInvalid'));
                            return;
                          }
                          updateLink.mutate({ uid: selected.uid, url, notify: linkNotify });
                        }}
                      >
                        <Input
                          type="url"
                          inputMode="url"
                          autoFocus
                          value={linkDraft}
                          onChange={(e) => setLinkDraft(e.target.value)}
                          placeholder="https://mega.nz/... · https://meet.google.com/..."
                          className="h-8 text-xs"
                          aria-label={t('calendar.bookings.meetingLink')}
                        />
                        {draftProvider && (
                          <p className="text-[11px] text-muted-foreground">{draftProvider}</p>
                        )}
                        <label className="flex items-start gap-2 text-xs cursor-pointer">
                          <Checkbox
                            checked={linkNotify}
                            onCheckedChange={(v) => setLinkNotify(v === true)}
                            className="mt-0.5"
                          />
                          <span>{t('calendar.bookings.meetingLinkNotify')}</span>
                        </label>
                        <p className="text-[11px] text-muted-foreground">{t('calendar.bookings.meetingLinkHint')}</p>
                        <div className="flex gap-1.5">
                          <Button type="submit" size="sm" disabled={updateLink.isPending || !linkDraft.trim()}>
                            {updateLink.isPending ? t('common.saving') : t('common.save')}
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setLinkEditing(false)} disabled={updateLink.isPending}>
                            {t('common.cancel')}
                          </Button>
                        </div>
                      </form>
                    )}
                  </div>
                )}
                {selected.attendee_message && (
                  <div className="text-xs bg-muted rounded p-2 mt-2 whitespace-pre-wrap">{selected.attendee_message}</div>
                )}
                {selected.cancellation_reason && (
                  <div className="text-xs text-destructive border-t pt-2 mt-2">
                    {t('calendar.bookings.reason')}: {selected.cancellation_reason}
                  </div>
                )}
              </div>

              {/* Actions — pending: approva/rifiuta */}
              {selected.status === 'pending' && (
                <div className="border-t pt-3 flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => approve.mutate(selected.uid)} disabled={approve.isPending}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" /> {t('calendar.bookings.approve')}
                  </Button>
                  <Button size="sm" variant="destructive" className="ml-auto" onClick={async () => {
                    if (await confirm({ title: t('calendar.bookings.confirmReject'), variant: 'destructive' })) {
                      reject.mutate(selected.uid);
                    }
                  }} disabled={reject.isPending}>
                    <X className="h-3.5 w-3.5 mr-1.5" /> {t('calendar.bookings.reject')}
                  </Button>
                </div>
              )}

              {/* Actions */}
              {selected.status === 'confirmed' && (
                <div className="border-t pt-3 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => mark.mutate({ uid: selected.uid, status: 'completed' })}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" /> {t('booking.status.completed')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => mark.mutate({ uid: selected.uid, status: 'no_show' })}>
                    <AlertCircle className="h-3.5 w-3.5 mr-1.5" /> No-show
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => resend.mutate(selected.uid)}>
                    <Send className="h-3.5 w-3.5 mr-1.5" /> {t('calendar.bookings.resend')}
                  </Button>
                  <Button size="sm" variant="destructive" className="ml-auto" onClick={async () => {
                    if (await confirm({ title: t('calendar.bookings.confirmCancel'), variant: 'destructive' })) {
                      cancel.mutate(selected.uid);
                    }
                  }}>
                    <X className="h-3.5 w-3.5 mr-1.5" /> {t('common.cancel')}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
              {t('calendar.bookings.select')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
