import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { X, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';

interface Calendar {
  id: string;
  name: string;
  color: string;
  is_default: boolean;
}

interface CalendarEvent {
  id?: string;
  uid?: string;
  calendar_id: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  rrule?: string | null;
  source?: string;
  source_id?: string | null;
}

interface Props {
  initial?: CalendarEvent | null;
  initialStart?: string; // se nuovo evento da slot click
  initialEnd?: string;
  onClose: () => void;
  onSaved: () => void;
}

type RecurrenceType = 'none' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const tzOffset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
}

function localInputToIso(input: string): string {
  return new Date(input).toISOString();
}

function parseRRule(rrule: string | null): { type: RecurrenceType; count?: number; until?: string; byDay?: string[] } {
  if (!rrule) return { type: 'none' };
  const parts = Object.fromEntries(rrule.split(';').map((p) => p.split('=')));
  const freq = parts.FREQ as RecurrenceType;
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return { type: 'none' };
  return {
    type: freq,
    count: parts.COUNT ? parseInt(parts.COUNT) : undefined,
    until: parts.UNTIL,
    byDay: parts.BYDAY ? parts.BYDAY.split(',') : undefined,
  };
}

function buildRRule(opts: { type: RecurrenceType; count?: number; until?: string; byDay?: string[] }): string | null {
  if (opts.type === 'none') return null;
  const parts: string[] = [`FREQ=${opts.type}`];
  if (opts.byDay && opts.byDay.length) parts.push(`BYDAY=${opts.byDay.join(',')}`);
  if (opts.count) parts.push(`COUNT=${opts.count}`);
  if (opts.until) {
    const d = new Date(opts.until);
    if (!isNaN(d.getTime())) parts.push(`UNTIL=${d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  }
  return parts.join(';');
}

const DAYS_OF_WEEK = [
  { value: 'MO', label: 'Lun' },
  { value: 'TU', label: 'Mar' },
  { value: 'WE', label: 'Mer' },
  { value: 'TH', label: 'Gio' },
  { value: 'FR', label: 'Ven' },
  { value: 'SA', label: 'Sab' },
  { value: 'SU', label: 'Dom' },
];

export default function EventoEditModal({ initial, initialStart, initialEnd, onClose, onSaved }: Props) {
  const queryClient = useQueryClient();
  const isEdit = !!initial?.id;

  const { data: calData } = useQuery({
    queryKey: ['admin-calendars'],
    queryFn: () => apiFetch('/api/admin/calendar/calendars'),
  });
  const calendars: Calendar[] = calData?.calendars || [];

  const defaultCalId = calendars.find((c) => c.is_default)?.id || calendars[0]?.id || '';

  const [calendarId, setCalendarId] = useState(initial?.calendar_id || defaultCalId);
  const [summary, setSummary] = useState(initial?.summary || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [location, setLocation] = useState(initial?.location || '');
  const [url, setUrl] = useState(initial?.url || '');
  const [startInput, setStartInput] = useState(
    initial?.start_time ? isoToLocalInput(initial.start_time) :
    initialStart ? isoToLocalInput(initialStart) :
    isoToLocalInput(new Date(Date.now() + 60 * 60_000).toISOString())
  );
  const [endInput, setEndInput] = useState(
    initial?.end_time ? isoToLocalInput(initial.end_time) :
    initialEnd ? isoToLocalInput(initialEnd) :
    isoToLocalInput(new Date(Date.now() + 2 * 60 * 60_000).toISOString())
  );
  const [allDay, setAllDay] = useState(initial?.all_day || false);
  const [recurrence, setRecurrence] = useState(parseRRule(initial?.rrule || null));

  useEffect(() => {
    if (!initial && defaultCalId && !calendarId) setCalendarId(defaultCalId);
  }, [defaultCalId, initial, calendarId]);

  const isBookingAuto = initial?.source === 'booking';

  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        calendar_id: calendarId,
        summary: summary.trim(),
        description: description.trim() || null,
        location: location.trim() || null,
        url: url.trim() || null,
        start_time: localInputToIso(startInput),
        end_time: localInputToIso(endInput),
        all_day: allDay,
        rrule: buildRRule(recurrence),
      });
      return isEdit
        ? apiFetch(`/api/admin/calendar/events/${initial!.id}`, { method: 'PUT', body })
        : apiFetch('/api/admin/calendar/events', { method: 'POST', body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      toast.success(isEdit ? 'Evento aggiornato' : 'Evento creato');
      onSaved();
      onClose();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  const remove = useMutation({
    mutationFn: () => apiFetch(`/api/admin/calendar/events/${initial!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendar-events'] });
      toast.success('Evento eliminato');
      onSaved();
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-card border rounded-lg shadow-lg max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold">{isEdit ? 'Modifica evento' : 'Nuovo evento'}</h3>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="p-4 space-y-3">
          {isBookingAuto && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-xs text-amber-900">
              Questo evento è stato creato automaticamente da una prenotazione (UID: <code>{initial?.source_id}</code>). Modifiche manuali non aggiornano la prenotazione originale.
            </div>
          )}

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Titolo *</label>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border bg-background"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Calendario *</label>
            <select
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border bg-background"
            >
              {calendars.map((cal) => (
                <option key={cal.id} value={cal.id}>{cal.name}</option>
              ))}
            </select>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Inizio *</label>
              <input
                type="datetime-local"
                value={startInput}
                onChange={(e) => setStartInput(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-md border bg-background"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Fine *</label>
              <input
                type="datetime-local"
                value={endInput}
                onChange={(e) => setEndInput(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-md border bg-background"
              />
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            Tutto il giorno
          </label>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Luogo</label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border bg-background"
              placeholder="Indirizzo, sala, ecc."
            />
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">URL meeting</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border bg-background"
              placeholder="https://meet.google.com/..."
            />
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Descrizione</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm rounded-md border bg-background"
            />
          </div>

          <div className="border-t pt-3 space-y-2">
            <label className="block text-xs text-muted-foreground">Ricorrenza</label>
            <div className="flex gap-2">
              {(['none', 'DAILY', 'WEEKLY', 'MONTHLY'] as RecurrenceType[]).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={recurrence.type === t ? 'default' : 'outline'}
                  className="text-xs"
                  onClick={() => setRecurrence({ type: t })}
                >
                  {t === 'none' ? 'Mai' : t === 'DAILY' ? 'Giornaliero' : t === 'WEEKLY' ? 'Settimanale' : 'Mensile'}
                </Button>
              ))}
            </div>

            {recurrence.type === 'WEEKLY' && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Giorni della settimana</p>
                <div className="flex flex-wrap gap-1">
                  {DAYS_OF_WEEK.map((d) => (
                    <Button
                      key={d.value}
                      size="sm"
                      variant={recurrence.byDay?.includes(d.value) ? 'default' : 'outline'}
                      className="text-xs h-7 w-10"
                      onClick={() => {
                        const cur = recurrence.byDay || [];
                        const next = cur.includes(d.value) ? cur.filter((v) => v !== d.value) : [...cur, d.value];
                        setRecurrence({ ...recurrence, byDay: next });
                      }}
                    >
                      {d.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {recurrence.type !== 'none' && (
              <div className="grid gap-2 md:grid-cols-2">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Numero occorrenze</label>
                  <input
                    type="number"
                    min={1}
                    value={recurrence.count || ''}
                    onChange={(e) => setRecurrence({ ...recurrence, count: e.target.value ? parseInt(e.target.value) : undefined })}
                    className="w-full px-2 py-1 text-sm rounded-md border bg-background"
                    placeholder="Lascia vuoto per illimitato"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">O fino a</label>
                  <input
                    type="date"
                    value={recurrence.until ? recurrence.until.slice(0, 10) : ''}
                    onChange={(e) => setRecurrence({ ...recurrence, until: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
                    className="w-full px-2 py-1 text-sm rounded-md border bg-background"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 p-4 border-t">
          {isEdit && !isBookingAuto && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => {
                if (confirm('Eliminare questo evento?')) remove.mutate();
              }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Elimina
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
            <Button size="sm" variant="ghost" onClick={onClose}>Annulla</Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={!summary || !calendarId || save.isPending}>
              {save.isPending ? 'Salvataggio…' : 'Salva'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
