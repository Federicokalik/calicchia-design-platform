import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Save, X, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';

interface ApproachRow {
  id: string;
  locale: 'it' | 'en';
  title: string;
  description: string;
  phosphor_icon: string;
  sort_order: number | null;
  is_published: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

interface DraftRow {
  id: string | null;
  locale: 'it' | 'en';
  title: string;
  description: string;
  phosphor_icon: string;
  sort_order: string;
  is_published: boolean;
}

const EMPTY_DRAFT: DraftRow = {
  id: null,
  locale: 'it',
  title: '',
  description: '',
  phosphor_icon: 'ph-circle',
  sort_order: '',
  is_published: true,
};

export default function ApproachCmsPage() {
  useTopbar({ title: 'CMS — Approach', subtitle: 'Pilastri metodologici mostrati in /perche-scegliere-me.' });

  const queryClient = useQueryClient();
  const [localeFilter, setLocaleFilter] = useState<'all' | 'it' | 'en'>('all');
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const { data, isLoading } = useQuery<{ rows: ApproachRow[] }>({
    queryKey: ['cms-approach', localeFilter],
    queryFn: () => apiFetch(`/api/cms/approach${localeFilter !== 'all' ? `?locale=${localeFilter}` : ''}`),
  });
  const rows = data?.rows ?? [];

  const byLocale = useMemo(() => {
    const groups = new Map<string, ApproachRow[]>();
    for (const row of rows) {
      const list = groups.get(row.locale) ?? [];
      list.push(row);
      groups.set(row.locale, list);
    }
    return groups;
  }, [rows]);

  const saveMutation = useMutation({
    mutationFn: async (d: DraftRow) => {
      const body = {
        locale: d.locale,
        title: d.title.trim(),
        description: d.description.trim(),
        phosphor_icon: d.phosphor_icon.trim() || 'ph-circle',
        sort_order: d.sort_order.trim() === '' ? null : Number(d.sort_order),
        is_published: d.is_published,
      };
      if (d.id) return apiFetch(`/api/cms/approach/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      return apiFetch('/api/cms/approach', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-approach'] });
      toast.success('Salvato');
      setDraft(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cms/approach/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-approach'] });
      toast.success('Eliminato');
    },
  });

  const editRow = (row: ApproachRow) => setDraft({
    id: row.id,
    locale: row.locale,
    title: row.title,
    description: row.description,
    phosphor_icon: row.phosphor_icon,
    sort_order: row.sort_order?.toString() ?? '',
    is_published: row.is_published,
  });

  const togglePublish = (row: ApproachRow) => {
    saveMutation.mutate({
      id: row.id,
      locale: row.locale,
      title: row.title,
      description: row.description,
      phosphor_icon: row.phosphor_icon,
      sort_order: row.sort_order?.toString() ?? '',
      is_published: !row.is_published,
    });
  };

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <Select value={localeFilter} onValueChange={(v) => setLocaleFilter(v as typeof localeFilter)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutte le lingue</SelectItem>
            <SelectItem value="it">Italiano</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setDraft({ ...EMPTY_DRAFT, locale: localeFilter === 'en' ? 'en' : 'it' })}>
          <Plus className="h-4 w-4 mr-2" /> Nuovo pillar
        </Button>
      </div>

      {draft && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{draft.id ? 'Modifica pillar' : 'Nuovo pillar'}</h3>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}><X className="h-4 w-4" /></Button>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Lingua</Label>
              <Select value={draft.locale} onValueChange={(v) => setDraft({ ...draft, locale: v as 'it' | 'en' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="it">Italiano</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ordine</Label>
              <Input type="number" value={draft.sort_order} onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Pubblicato</Label>
              <Button
                variant={draft.is_published ? 'default' : 'outline'}
                onClick={() => setDraft({ ...draft, is_published: !draft.is_published })}
                className="w-full"
              >
                {draft.is_published ? 'Visibile' : 'Nascosto'}
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Titolo</Label>
            <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Ossessione per i dettagli" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Descrizione</Label>
            <Textarea
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={5}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Icona Phosphor (es. <code>ph-rocket-launch</code>)</Label>
            <Input
              value={draft.phosphor_icon}
              onChange={(e) => setDraft({ ...draft, phosphor_icon: e.target.value })}
              placeholder="ph-rocket-launch"
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Formato <code>ph-[a-z0-9-]+</code>. Icone disponibili: <a href="https://phosphoricons.com" target="_blank" rel="noreferrer" className="underline">phosphoricons.com</a>.
            </p>
          </div>
          <Button onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending || !draft.title.trim() || !draft.description.trim()}>
            <Save className="h-4 w-4 mr-2" /> {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Nessun pillar"
          description="Aggiungi il primo pillar metodologico. Finché la tabella è vuota, il sito usa quelli hardcoded di apps/sito-v3/src/data/approach.ts."
        />
      ) : (
        <div className="space-y-6">
          {Array.from(byLocale.entries()).map(([locale, list]) => (
            <div key={locale} className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide">{locale === 'it' ? 'Italiano' : 'English'}</h2>
                <Badge variant="outline">{list.length}</Badge>
              </div>
              <div className="space-y-2">
                {list.map((row) => (
                  <div key={row.id} className="rounded-lg border bg-card p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{row.title}</p>
                          <Badge variant="outline" className="font-mono text-[10px]">{row.phosphor_icon}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-line">{row.description}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        {row.sort_order !== null && (
                          <Badge variant="outline" className="font-mono text-[10px]">#{row.sort_order}</Badge>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => togglePublish(row)}>
                          {row.is_published ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => editRow(row)}>Modifica</Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (window.confirm(`Eliminare "${row.title}"?`)) deleteMutation.mutate(row.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
