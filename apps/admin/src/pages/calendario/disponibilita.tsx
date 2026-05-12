import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';

interface SlotRow { id?: string; day_of_week: number; start_time: string; end_time: string }
interface Override { id: string; override_date: string; is_unavailable: boolean; start_time: string | null; end_time: string | null; note: string | null }

const DAYS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

export default function DisponibilitaPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-schedule'],
    queryFn: () => apiFetch('/api/admin/calendar/schedule'),
  });

  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [tz, setTz] = useState('Europe/Rome');

  useEffect(() => {
    if (data?.slots) {
      setSlots(data.slots.map((s: SlotRow) => ({
        day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time,
      })));
    }
    if (data?.schedule?.timezone) setTz(data.schedule.timezone);
  }, [data]);

  const saveSlots = useMutation({
    mutationFn: () => apiFetch('/api/admin/calendar/schedule/slots', {
      method: 'PUT', body: JSON.stringify({ slots }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-schedule'] });
      toast.success('Disponibilità salvata');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  const saveTz = useMutation({
    mutationFn: () => apiFetch('/api/admin/calendar/schedule', {
      method: 'PUT', body: JSON.stringify({ timezone: tz }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-schedule'] });
      toast.success('Timezone salvato');
    },
  });

  useTopbar({
    title: 'Disponibilità',
    subtitle: 'Orari ricorrenti e override',
    actions: (
      <Button size="sm" onClick={() => saveSlots.mutate()} disabled={saveSlots.isPending}>
        <Save className="h-3.5 w-3.5 mr-1.5" />
        Salva orari
      </Button>
    ),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Caricamento…</p>;

  function addSlot(dow: number) {
    setSlots((prev) => [...prev, { day_of_week: dow, start_time: '09:00', end_time: '13:00' }]);
  }

  function removeSlot(index: number) {
    setSlots((prev) => prev.filter((_, i) => i !== index));
  }

  function updateSlot(index: number, field: 'start_time' | 'end_time', value: string) {
    setSlots((prev) => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">Timezone</h3>
        <div className="flex gap-2 items-center">
          <input type="text" value={tz} onChange={(e) => setTz(e.target.value)} className="px-3 py-2 text-sm rounded-md border bg-background flex-1" placeholder="Europe/Rome" />
          <Button size="sm" variant="outline" onClick={() => saveTz.mutate()}>Salva</Button>
        </div>
        <p className="text-xs text-muted-foreground">IANA timezone (es. Europe/Rome, Europe/London). Influenza la conversione degli slot per i partecipanti.</p>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="font-semibold text-sm">Orari ricorrenti settimanali</h3>
          <p className="text-xs text-muted-foreground">{slots.length} slot totali</p>
        </div>
        {DAYS.map((dayName, dow) => (
          <div key={dow} className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium">{dayName}</span>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => addSlot(dow)}>
                <Plus className="h-3 w-3 mr-1" /> Aggiungi
              </Button>
            </div>
            <div className="space-y-1.5 ml-4">
              {slots.map((s, i) => s.day_of_week !== dow ? null : (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <input type="time" value={s.start_time.slice(0, 5)} onChange={(e) => updateSlot(i, 'start_time', e.target.value)} className="px-2 py-1 rounded border bg-background" />
                  <span className="text-muted-foreground">→</span>
                  <input type="time" value={s.end_time.slice(0, 5)} onChange={(e) => updateSlot(i, 'end_time', e.target.value)} className="px-2 py-1 rounded border bg-background" />
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => removeSlot(i)}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              {!slots.some((s) => s.day_of_week === dow) && (
                <p className="text-xs text-muted-foreground italic">Non disponibile</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <OverridesSection overrides={data?.overrides || []} />
    </div>
  );
}

function OverridesSection({ overrides }: { overrides: Override[] }) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState('');
  const [isUnavail, setIsUnavail] = useState(true);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('13:00');
  const [note, setNote] = useState('');

  const create = useMutation({
    mutationFn: () => apiFetch('/api/admin/calendar/schedule/overrides', {
      method: 'POST',
      body: JSON.stringify({
        override_date: date,
        is_unavailable: isUnavail,
        start_time: isUnavail ? null : start,
        end_time: isUnavail ? null : end,
        note: note || null,
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-schedule'] });
      toast.success('Override creato');
      setDate(''); setNote('');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/admin/calendar/schedule/overrides/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-schedule'] });
      toast.success('Override rimosso');
    },
  });

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <h3 className="font-semibold text-sm">Override per data (ferie, festivi, orari speciali)</h3>

      <div className="grid gap-2 md:grid-cols-[140px_120px_1fr_auto] items-end">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Data</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border bg-background" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Tipo</label>
          <select value={isUnavail ? 'unavail' : 'custom'} onChange={(e) => setIsUnavail(e.target.value === 'unavail')} className="w-full px-3 py-2 text-sm rounded-md border bg-background">
            <option value="unavail">Bloccato</option>
            <option value="custom">Orari custom</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Note</label>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Es. Ferie, riunione team..." className="w-full px-3 py-2 text-sm rounded-md border bg-background" />
        </div>
        <Button size="sm" onClick={() => create.mutate()} disabled={!date || create.isPending}>
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Aggiungi
        </Button>
      </div>

      {!isUnavail && (
        <div className="flex gap-2 items-center text-sm pt-1">
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="px-2 py-1 rounded border bg-background" />
          <span className="text-muted-foreground">→</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="px-2 py-1 rounded border bg-background" />
        </div>
      )}

      <div className="space-y-1.5 pt-2 border-t">
        {overrides.length === 0 && (
          <p className="text-xs text-muted-foreground italic">Nessun override.</p>
        )}
        {overrides.map((o) => (
          <div key={o.id} className="flex items-center justify-between text-sm py-1">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs">{o.override_date}</span>
              {o.is_unavailable
                ? <span className="text-destructive text-xs uppercase tracking-wide">Bloccato</span>
                : <span className="text-xs">{o.start_time?.slice(0, 5)} → {o.end_time?.slice(0, 5)}</span>}
              {o.note && <span className="text-xs text-muted-foreground">— {o.note}</span>}
            </div>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => remove.mutate(o.id)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
