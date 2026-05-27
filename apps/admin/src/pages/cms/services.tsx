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

interface ServiceRow {
  id: string;
  locale: 'it' | 'en';
  slug: string;
  title: string;
  lead: string;
  deliverables: string[];
  icon: string;
  category: 'matrix' | 'standalone';
  sort_order: number | null;
  is_published: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

interface DraftRow {
  id: string | null;
  locale: 'it' | 'en';
  slug: string;
  title: string;
  lead: string;
  // One deliverable per line — simpler than a JSON array editor and matches
  // the shape these always have (4-6 short strings).
  deliverablesText: string;
  icon: string;
  category: 'matrix' | 'standalone';
  sort_order: string;
  is_published: boolean;
}

const EMPTY_DRAFT: DraftRow = {
  id: null,
  locale: 'it',
  slug: '',
  title: '',
  lead: '',
  deliverablesText: '',
  icon: 'globe',
  category: 'matrix',
  sort_order: '',
  is_published: true,
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export default function ServicesCmsPage() {
  useTopbar({
    title: 'CMS — Servizi',
    subtitle: 'Catalogo servizi (matrix + standalone). NB: il dettaglio long-form di /servizi/[slug] resta in apps/sito-v3/src/data/services-content/*.',
  });

  const queryClient = useQueryClient();
  const [localeFilter, setLocaleFilter] = useState<'all' | 'it' | 'en'>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'matrix' | 'standalone'>('all');
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const { data, isLoading } = useQuery<{ rows: ServiceRow[] }>({
    queryKey: ['cms-services', localeFilter, categoryFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (localeFilter !== 'all') params.set('locale', localeFilter);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      const qs = params.toString();
      return apiFetch(`/api/cms/services${qs ? '?' + qs : ''}`);
    },
  });
  const rows = data?.rows ?? [];

  const grouped = useMemo(() => {
    const groups = new Map<string, ServiceRow[]>();
    for (const row of rows) {
      const key = `${row.locale}-${row.category}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const saveMutation = useMutation({
    mutationFn: async (d: DraftRow) => {
      const deliverables = d.deliverablesText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 20);
      const body = {
        locale: d.locale,
        slug: d.slug.trim(),
        title: d.title.trim(),
        lead: d.lead.trim(),
        deliverables,
        icon: d.icon.trim() || 'globe',
        category: d.category,
        sort_order: d.sort_order.trim() === '' ? null : Number(d.sort_order),
        is_published: d.is_published,
      };
      if (d.id) return apiFetch(`/api/cms/services/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      return apiFetch('/api/cms/services', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-services'] });
      toast.success('Salvato');
      setDraft(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cms/services/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-services'] });
      toast.success('Eliminato');
    },
  });

  const editRow = (row: ServiceRow) => setDraft({
    id: row.id,
    locale: row.locale,
    slug: row.slug,
    title: row.title,
    lead: row.lead,
    deliverablesText: (row.deliverables ?? []).join('\n'),
    icon: row.icon,
    category: row.category,
    sort_order: row.sort_order?.toString() ?? '',
    is_published: row.is_published,
  });

  const togglePublish = (row: ServiceRow) => {
    saveMutation.mutate({
      id: row.id,
      locale: row.locale,
      slug: row.slug,
      title: row.title,
      lead: row.lead,
      deliverablesText: (row.deliverables ?? []).join('\n'),
      icon: row.icon,
      category: row.category,
      sort_order: row.sort_order?.toString() ?? '',
      is_published: !row.is_published,
    });
  };

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Select value={localeFilter} onValueChange={(v) => setLocaleFilter(v as typeof localeFilter)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutte le lingue</SelectItem>
              <SelectItem value="it">Italiano</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v as typeof categoryFilter)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutte le categorie</SelectItem>
              <SelectItem value="matrix">Matrix</SelectItem>
              <SelectItem value="standalone">Standalone</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          <Plus className="h-4 w-4 mr-2" /> Nuovo servizio
        </Button>
      </div>

      {draft && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{draft.id ? 'Modifica servizio' : 'Nuovo servizio'}</h3>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}><X className="h-4 w-4" /></Button>
          </div>
          <div className="grid grid-cols-4 gap-4">
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
              <Label className="text-xs">Categoria</Label>
              <Select value={draft.category} onValueChange={(v) => setDraft({ ...draft, category: v as DraftRow['category'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="matrix">Matrix (web-design, e-commerce, sviluppo, seo)</SelectItem>
                  <SelectItem value="standalone">Standalone (manutenzione, wp, perf...)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Icon (Phosphor)</Label>
              <Input value={draft.icon} onChange={(e) => setDraft({ ...draft, icon: e.target.value })} placeholder="globe" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ordine</Label>
              <Input type="number" value={draft.sort_order} onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Titolo</Label>
              <Input
                value={draft.title}
                onChange={(e) => {
                  const title = e.target.value;
                  setDraft({ ...draft, title, slug: draft.slug || slugify(title) });
                }}
                placeholder="Web Design"
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Slug (URL)</Label>
              <Input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })} placeholder="web-design" />
              <p className="text-[10px] text-muted-foreground">URL: <code>/servizi/{draft.slug || '...'}</code>. Cambiarlo rompe i link.</p>
            </div>
            <div className="space-y-1 col-span-3">
              <Label className="text-xs">Lead (1-2 frasi, supporta \n)</Label>
              <Textarea value={draft.lead} onChange={(e) => setDraft({ ...draft, lead: e.target.value })} rows={3} />
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
            <div className="space-y-1 col-span-4">
              <Label className="text-xs">Deliverables (una per riga, max 20)</Label>
              <Textarea
                value={draft.deliverablesText}
                onChange={(e) => setDraft({ ...draft, deliverablesText: e.target.value })}
                rows={5}
                placeholder={'Design cucito sulla tua identità\nSEO tecnica già configurata\nPrivacy/cookie GDPR a posto\nUn anno di assistenza inclusa'}
              />
            </div>
          </div>

          <Button onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending || !draft.title.trim() || !draft.slug.trim() || !draft.lead.trim()}>
            <Save className="h-4 w-4 mr-2" /> {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Nessun servizio"
          description="Aggiungi il primo servizio. Finché la tabella è vuota, il sito usa il catalogo hardcoded di apps/sito-v3/src/data/services.ts. Il dettaglio long-form (awareness/process/faq/features) resta SEMPRE in services-content/*.ts."
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(([key, list]) => {
            const [locale, category] = key.split('-');
            return (
              <div key={key} className="space-y-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide">{locale === 'it' ? 'Italiano' : 'English'}</h2>
                  <Badge variant="outline">{category}</Badge>
                  <Badge variant="outline">{list.length}</Badge>
                </div>
                <div className="space-y-2">
                  {list.map((row) => (
                    <div key={row.id} className="rounded-lg border bg-card p-4 space-y-2">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <p className="font-medium text-sm">{row.title}</p>
                            <code className="text-[10px] text-muted-foreground font-mono">/servizi/{row.slug}</code>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{row.lead}</p>
                          {row.deliverables?.length > 0 && (
                            <p className="text-[10px] text-muted-foreground mt-1">{row.deliverables.length} deliverable</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
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
            );
          })}
        </div>
      )}
    </div>
  );
}
