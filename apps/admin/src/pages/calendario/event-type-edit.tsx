import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Save, Trash2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';

const SITE_URL = (import.meta.env.VITE_SITE_URL as string) || 'http://localhost:3000';

interface EventTypeForm {
  slug: string;
  title: string;
  description: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  slot_increment_minutes: number;
  min_notice_hours: number;
  max_advance_days: number;
  location_type: 'google_meet' | 'custom_url' | 'in_person' | 'phone';
  location_value: string;
  color: string;
  is_active: boolean;
  is_public: boolean;
  workflow_event_key: string;
  sort_order: number;
}

export default function EventTypeEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-event-type', id],
    queryFn: () => apiFetch(`/api/admin/calendar/event-types/${id}`),
    enabled: !!id,
  });

  const [form, setForm] = useState<EventTypeForm | null>(null);

  useEffect(() => {
    if (data?.event_type) {
      const et = data.event_type;
      setForm({
        slug: et.slug,
        title: et.title,
        description: et.description || '',
        duration_minutes: et.duration_minutes,
        buffer_before_minutes: et.buffer_before_minutes,
        buffer_after_minutes: et.buffer_after_minutes,
        slot_increment_minutes: et.slot_increment_minutes,
        min_notice_hours: et.min_notice_hours,
        max_advance_days: et.max_advance_days,
        location_type: et.location_type,
        location_value: et.location_value || '',
        color: et.color,
        is_active: et.is_active,
        is_public: et.is_public,
        workflow_event_key: et.workflow_event_key || '',
        sort_order: et.sort_order,
      });
    }
  }, [data]);

  const update = useMutation({
    mutationFn: () => apiFetch(`/api/admin/calendar/event-types/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...form,
        location_value: form?.location_value || null,
        workflow_event_key: form?.workflow_event_key || null,
        description: form?.description || null,
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event-types'] });
      queryClient.invalidateQueries({ queryKey: ['admin-event-type', id] });
      toast.success('Salvato');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  const remove = useMutation({
    mutationFn: () => apiFetch(`/api/admin/calendar/event-types/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Disattivato');
      navigate('/calendario/event-types');
    },
  });

  useTopbar({
    title: form?.title || 'Event type',
    subtitle: form?.slug ? `/${form.slug}` : '',
    actions: (
      <div className="flex gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/calendario/event-types">
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Indietro
          </Link>
        </Button>
        {form && (
          <Button asChild size="sm" variant="outline">
            <a href={`${SITE_URL}/it/prenota/${form.slug}`} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Apri
            </a>
          </Button>
        )}
        <Button size="sm" onClick={() => update.mutate()} disabled={update.isPending}>
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {update.isPending ? 'Salvataggio…' : 'Salva'}
        </Button>
      </div>
    ),
  });

  if (isLoading || !form) return <p className="text-sm text-muted-foreground">Caricamento…</p>;

  function set<K extends keyof EventTypeForm>(key: K, value: EventTypeForm[K]) {
    setForm((prev) => prev ? { ...prev, [key]: value } : prev);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Section title="Generale">
        <Field label="Titolo">
          <input type="text" value={form.title} onChange={(e) => set('title', e.target.value)} className="input" />
        </Field>
        <Field label="Slug URL (immutabile dopo creazione, ma editabile)">
          <input type="text" value={form.slug} onChange={(e) => set('slug', e.target.value)} className="input font-mono" />
        </Field>
        <Field label="Descrizione (markdown)">
          <textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} className="input" />
        </Field>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Colore">
            <input type="color" value={form.color} onChange={(e) => set('color', e.target.value)} className="input h-10 cursor-pointer" />
          </Field>
          <Field label="Sort order">
            <input type="number" value={form.sort_order} onChange={(e) => set('sort_order', parseInt(e.target.value))} className="input" />
          </Field>
          <Field label="Visibilità">
            <div className="flex gap-3 items-center pt-2">
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
                Attivo
              </label>
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={form.is_public} onChange={(e) => set('is_public', e.target.checked)} />
                Pubblico
              </label>
            </div>
          </Field>
        </div>
      </Section>

      <Section title="Durata e disponibilità">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Durata (min)">
            <input type="number" min={5} max={480} value={form.duration_minutes} onChange={(e) => set('duration_minutes', parseInt(e.target.value))} className="input" />
          </Field>
          <Field label="Granularità slot (min)">
            <input type="number" min={5} value={form.slot_increment_minutes} onChange={(e) => set('slot_increment_minutes', parseInt(e.target.value))} className="input" />
          </Field>
          <Field label="Buffer prima (min)">
            <input type="number" min={0} value={form.buffer_before_minutes} onChange={(e) => set('buffer_before_minutes', parseInt(e.target.value))} className="input" />
          </Field>
          <Field label="Buffer dopo (min)">
            <input type="number" min={0} value={form.buffer_after_minutes} onChange={(e) => set('buffer_after_minutes', parseInt(e.target.value))} className="input" />
          </Field>
          <Field label="Preavviso minimo (ore)">
            <input type="number" min={0} value={form.min_notice_hours} onChange={(e) => set('min_notice_hours', parseInt(e.target.value))} className="input" />
          </Field>
          <Field label="Anticipo massimo (giorni)">
            <input type="number" min={1} max={365} value={form.max_advance_days} onChange={(e) => set('max_advance_days', parseInt(e.target.value))} className="input" />
          </Field>
        </div>
      </Section>

      <Section title="Location">
        <Field label="Tipo">
          <select value={form.location_type} onChange={(e) => set('location_type', e.target.value as EventTypeForm['location_type'])} className="input">
            <option value="custom_url">URL videocall (Meet, Zoom, ecc.)</option>
            <option value="in_person">In presenza (indirizzo)</option>
            <option value="phone">Telefonata</option>
            <option value="google_meet">Google Meet (link da inviare manualmente)</option>
          </select>
        </Field>
        <Field label={
          form.location_type === 'in_person' ? 'Indirizzo' :
          form.location_type === 'phone' ? 'Numero di telefono' :
          form.location_type === 'google_meet' ? 'Link Meet (incollalo dopo averlo creato su meet.google.com)' :
          'URL meeting'
        }>
          <input
            type="text"
            value={form.location_value}
            onChange={(e) => set('location_value', e.target.value)}
            className="input"
            placeholder={
              form.location_type === 'in_person' ? 'Via Roma 1, Milano' :
              form.location_type === 'phone' ? '+39 ...' :
              'https://meet.google.com/abc-defg-hij'
            }
          />
        </Field>
        {form.location_type === 'google_meet' && (
          <p className="text-xs text-muted-foreground">
            Workspace disdetto: il link Meet va creato manualmente su <a href="https://meet.google.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">meet.google.com</a> e incollato qui sopra. Se preferisci automatizzare, considera <a href="https://meet.jit.si" target="_blank" rel="noreferrer" className="text-primary hover:underline">Jitsi</a> o <a href="https://whereby.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">Whereby</a> con URL custom.
          </p>
        )}
      </Section>

      <Section title="Workflow integration (opzionale)">
        <Field label="Event key per fireEvent (default: booking_creato)">
          <input
            type="text"
            value={form.workflow_event_key}
            onChange={(e) => set('workflow_event_key', e.target.value)}
            placeholder="booking_creato_consulenza"
            className="input"
          />
        </Field>
      </Section>

      <div className="border-t pt-4 flex justify-between items-center">
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            if (confirm('Disattivare questo event type? I bookings storici restano accessibili.')) {
              remove.mutate();
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Disattiva
        </Button>
      </div>

      <style>{`
        .input {
          width: 100%;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          border-radius: 0.375rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
        }
        .input:focus { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }
      `}</style>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <h3 className="font-semibold text-sm">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">{label}</label>
      {children}
    </div>
  );
}
