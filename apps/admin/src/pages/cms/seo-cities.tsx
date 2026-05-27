import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Save, X, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';

interface CityRow {
  id: string;
  slug: string;
  nome: string;
  regione: string;
  tipo: 'capoluogo' | 'ciociaria';
  tier: 1 | 2 | 3;
  sort_order: number | null;
  is_published: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

interface DraftRow {
  id: string | null;
  slug: string;
  nome: string;
  regione: string;
  tipo: 'capoluogo' | 'ciociaria';
  tier: 1 | 2 | 3;
  sort_order: string;
  is_published: boolean;
}

const EMPTY_DRAFT: DraftRow = {
  id: null,
  slug: '',
  nome: '',
  regione: '',
  tipo: 'capoluogo',
  tier: 2,
  sort_order: '',
  is_published: true,
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export default function SeoCitiesCmsPage() {
  useTopbar({
    title: 'CMS — SEO Cities',
    subtitle: 'Comuni serviti — usati per /zone, sitemap, matrix SEO.',
  });

  const queryClient = useQueryClient();
  const [tipoFilter, setTipoFilter] = useState<'all' | 'capoluogo' | 'ciociaria'>('all');
  const [tierFilter, setTierFilter] = useState<'all' | '1' | '2' | '3'>('all');
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const { data, isLoading } = useQuery<{ rows: CityRow[] }>({
    queryKey: ['cms-seo-cities', tipoFilter, tierFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (tipoFilter !== 'all') params.set('tipo', tipoFilter);
      if (tierFilter !== 'all') params.set('tier', tierFilter);
      const qs = params.toString();
      return apiFetch(`/api/cms/seo-cities${qs ? '?' + qs : ''}`);
    },
  });
  const rows = data?.rows ?? [];

  const byRegione = useMemo(() => {
    const groups = new Map<string, CityRow[]>();
    for (const row of rows) {
      const list = groups.get(row.regione) ?? [];
      list.push(row);
      groups.set(row.regione, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b, 'it'));
  }, [rows]);

  const saveMutation = useMutation({
    mutationFn: async (d: DraftRow) => {
      const body = {
        slug: d.slug.trim(),
        nome: d.nome.trim(),
        regione: d.regione.trim(),
        tipo: d.tipo,
        tier: d.tier,
        sort_order: d.sort_order.trim() === '' ? null : Number(d.sort_order),
        is_published: d.is_published,
      };
      if (d.id) return apiFetch(`/api/cms/seo-cities/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      return apiFetch('/api/cms/seo-cities', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-seo-cities'] });
      toast.success('Salvato');
      setDraft(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cms/seo-cities/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-seo-cities'] });
      toast.success('Eliminato');
    },
  });

  const editRow = (row: CityRow) => setDraft({
    id: row.id,
    slug: row.slug,
    nome: row.nome,
    regione: row.regione,
    tipo: row.tipo,
    tier: row.tier,
    sort_order: row.sort_order?.toString() ?? '',
    is_published: row.is_published,
  });

  const togglePublish = (row: CityRow) => {
    saveMutation.mutate({
      id: row.id,
      slug: row.slug,
      nome: row.nome,
      regione: row.regione,
      tipo: row.tipo,
      tier: row.tier,
      sort_order: row.sort_order?.toString() ?? '',
      is_published: !row.is_published,
    });
  };

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Select value={tipoFilter} onValueChange={(v) => setTipoFilter(v as typeof tipoFilter)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutti i tipi</SelectItem>
              <SelectItem value="capoluogo">Capoluoghi</SelectItem>
              <SelectItem value="ciociaria">Ciociaria</SelectItem>
            </SelectContent>
          </Select>
          <Select value={tierFilter} onValueChange={(v) => setTierFilter(v as typeof tierFilter)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutti i tier</SelectItem>
              <SelectItem value="1">Tier 1 (MVP)</SelectItem>
              <SelectItem value="2">Tier 2 (expansion)</SelectItem>
              <SelectItem value="3">Tier 3 (long-tail)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          <Plus className="h-4 w-4 mr-2" /> Nuovo comune
        </Button>
      </div>

      {draft && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{draft.id ? 'Modifica comune' : 'Nuovo comune'}</h3>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}><X className="h-4 w-4" /></Button>
          </div>
          <div className="grid grid-cols-4 gap-4">
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Nome</Label>
              <Input
                value={draft.nome}
                onChange={(e) => {
                  const nome = e.target.value;
                  setDraft({ ...draft, nome, slug: draft.slug || slugify(nome) });
                }}
                placeholder="Frosinone"
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Slug (URL)</Label>
              <Input
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })}
                placeholder="frosinone"
              />
              <p className="text-[10px] text-muted-foreground">Solo a-z, 0-9, trattini. Cambiarlo rompe i link esistenti.</p>
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Regione</Label>
              <Input value={draft.regione} onChange={(e) => setDraft({ ...draft, regione: e.target.value })} placeholder="Lazio" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tipo</Label>
              <Select value={draft.tipo} onValueChange={(v) => setDraft({ ...draft, tipo: v as DraftRow['tipo'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="capoluogo">Capoluogo</SelectItem>
                  <SelectItem value="ciociaria">Ciociaria</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tier</Label>
              <Select value={String(draft.tier)} onValueChange={(v) => setDraft({ ...draft, tier: Number(v) as DraftRow['tier'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Tier 1 (MVP, indicizzata)</SelectItem>
                  <SelectItem value="2">Tier 2 (expansion)</SelectItem>
                  <SelectItem value="3">Tier 3 (long-tail, noindex)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Sort order (opzionale)</Label>
              <Input type="number" value={draft.sort_order} onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} placeholder="10" />
            </div>
            <div className="space-y-1 col-span-2">
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
          <Button onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending || !draft.nome.trim() || !draft.slug.trim() || !draft.regione.trim()}>
            <Save className="h-4 w-4 mr-2" /> {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Nessun comune"
          description="Aggiungi il primo comune. Finché la tabella è vuota, il sito usa la lista hardcoded di apps/sito-v3/src/data/seo-cities.ts (199 comuni)."
        />
      ) : (
        <div className="space-y-6">
          {byRegione.map(([regione, list]) => (
            <div key={regione} className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide">{regione}</h2>
                <Badge variant="outline">{list.length}</Badge>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {list.map((row) => (
                  <div key={row.id} className="rounded-lg border bg-card p-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <p className="font-medium text-sm">{row.nome}</p>
                        <code className="text-[10px] text-muted-foreground font-mono">/zone/{row.slug}</code>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="secondary" className="text-[10px]">{row.tipo}</Badge>
                        <Badge variant="outline" className="text-[10px]">Tier {row.tier}</Badge>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="sm" onClick={() => togglePublish(row)}>
                        {row.is_published ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => editRow(row)}>Modifica</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (window.confirm(`Eliminare "${row.nome}"?`)) deleteMutation.mutate(row.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
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
