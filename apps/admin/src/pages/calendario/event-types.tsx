import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, ExternalLink, Eye, EyeOff, Settings, Clock, MapPin, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';

interface EventType {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  duration_minutes: number;
  location_type: 'google_meet' | 'custom_url' | 'in_person' | 'phone';
  location_value: string | null;
  color: string;
  is_active: boolean;
  is_public: boolean;
  sort_order: number;
}

const LOCATION_LABEL: Record<string, string> = {
  google_meet: 'Google Meet',
  custom_url: 'URL custom',
  in_person: 'In presenza',
  phone: 'Telefono',
};

const SITE_URL = (import.meta.env.VITE_SITE_URL as string) || 'http://localhost:3000';

export default function EventTypesPage() {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-event-types'],
    queryFn: () => apiFetch('/api/admin/calendar/event-types'),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      apiFetch(`/api/admin/calendar/event-types/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event-types'] });
      toast.success('Aggiornato');
    },
  });

  useTopbar({
    title: 'Event Types',
    subtitle: 'Tipologie di prenotazione',
    actions: (
      <Button size="sm" onClick={() => setShowNew(true)}>
        <Plus className="h-3.5 w-3.5 mr-1.5" />
        Nuova tipologia
      </Button>
    ),
  });

  const eventTypes: EventType[] = data?.event_types || [];

  return (
    <div className="space-y-4">
      {showNew && <NewEventTypeForm onClose={() => setShowNew(false)} />}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Caricamento…</p>
      ) : eventTypes.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">Nessun event type. Creane uno per iniziare.</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {eventTypes.map((et) => (
            <div key={et.id} className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <div className="h-3 w-3 rounded-full mt-1 shrink-0" style={{ backgroundColor: et.color }} />
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm truncate">{et.title}</h3>
                    <p className="text-xs text-muted-foreground truncate">/{et.slug}</p>
                  </div>
                </div>
                <Badge variant={et.is_active ? 'default' : 'outline'} className="text-[10px] shrink-0">
                  {et.is_active ? 'Attivo' : 'Disattivo'}
                </Badge>
              </div>

              {et.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">{et.description}</p>
              )}

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {et.duration_minutes}min</span>
                <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {LOCATION_LABEL[et.location_type]}</span>
              </div>

              <div className="flex items-center justify-between gap-1 pt-2 border-t">
                <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                  <Link to={`/calendario/event-types/${et.id}`}>
                    <Settings className="h-3 w-3 mr-1" /> Modifica
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    navigator.clipboard.writeText(`${SITE_URL}/it/prenota/${et.slug}`);
                    toast.success('Link copiato');
                  }}
                >
                  <Copy className="h-3 w-3 mr-1" /> Link
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => toggleActive.mutate({ id: et.id, is_active: !et.is_active })}
                >
                  {et.is_active ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </Button>
                <a
                  href={`${SITE_URL}/it/prenota/${et.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center h-7 px-2 rounded-md hover:bg-accent text-xs"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewEventTypeForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [duration, setDuration] = useState(30);
  const [locationType, setLocationType] = useState<'google_meet' | 'custom_url' | 'in_person' | 'phone'>('google_meet');
  const [locationValue, setLocationValue] = useState('');

  const create = useMutation({
    mutationFn: () => apiFetch('/api/admin/calendar/event-types', {
      method: 'POST',
      body: JSON.stringify({
        slug: slug.trim().toLowerCase(),
        title: title.trim(),
        duration_minutes: duration,
        location_type: locationType,
        location_value: locationValue.trim() || null,
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event-types'] });
      toast.success('Event type creato');
      onClose();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Errore'),
  });

  function autoSlug(value: string) {
    return value.trim().toLowerCase()
      .replace(/[àáâãä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
      .replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u')
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <h3 className="font-semibold text-sm">Nuovo event type</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Titolo *</label>
          <input
            type="text"
            value={title}
            onChange={(e) => { setTitle(e.target.value); if (!slug) setSlug(autoSlug(e.target.value)); }}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background"
            placeholder="Es. Consulenza 60min"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Slug URL *</label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(autoSlug(e.target.value))}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background font-mono"
            placeholder="consulenza-60min"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Durata (minuti) *</label>
          <input
            type="number"
            min={5}
            max={480}
            value={duration}
            onChange={(e) => setDuration(parseInt(e.target.value))}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Tipo location *</label>
          <select
            value={locationType}
            onChange={(e) => setLocationType(e.target.value as typeof locationType)}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background"
          >
            <option value="google_meet">Google Meet</option>
            <option value="custom_url">URL custom</option>
            <option value="in_person">In presenza</option>
            <option value="phone">Telefono</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs text-muted-foreground mb-1">
            {locationType === 'in_person' ? 'Indirizzo' :
             locationType === 'phone' ? 'Numero telefono' :
             locationType === 'custom_url' ? 'URL videocall' : 'Niente (Meet auto-generato)'}
          </label>
          <input
            type="text"
            value={locationValue}
            onChange={(e) => setLocationValue(e.target.value)}
            disabled={locationType === 'google_meet'}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background disabled:opacity-50"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="ghost" onClick={onClose}>Annulla</Button>
        <Button size="sm" onClick={() => create.mutate()} disabled={!title || !slug || create.isPending}>
          {create.isPending ? 'Creazione…' : 'Crea'}
        </Button>
      </div>
    </div>
  );
}
