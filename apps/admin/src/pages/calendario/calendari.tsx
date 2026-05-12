import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Copy, RotateCw, Trash2, Eye, EyeOff, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';

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
  ics_feed_token: string;
  ics_feed_enabled: boolean;
  ics_feed_url: string | null;
  sort_order: number;
  event_count: number;
}

export default function CalendariPage() {
  const queryClient = useQueryClient();
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
    <div className="space-y-4">
      {showNew && <CalendarForm onClose={() => { setShowNew(false); setEditing(null); }} initial={editing} />}

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
                >
                  {cal.ics_feed_enabled ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    if (confirm('Rigenerare il token? I client che usano l\'URL attuale smetteranno di sincronizzare.')) {
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
                    onClick={() => {
                      if (confirm(`Eliminare "${cal.name}" e tutti i suoi ${cal.event_count} eventi? Operazione non reversibile.`)) {
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
      });
      return initial
        ? apiFetch(`/api/admin/calendar/calendars/${initial.id}`, { method: 'PUT', body })
        : apiFetch('/api/admin/calendar/calendars', { method: 'POST', body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-calendars'] });
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
