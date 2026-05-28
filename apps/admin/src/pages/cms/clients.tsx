import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Save, X, Eye, EyeOff, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';

interface ClientRow {
  id: string;
  name: string;
  url: string;
  industry: string | null;
  logo_url: string | null;
  sort_order: number | null;
  is_published: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

interface DraftRow {
  id: string | null;
  name: string;
  url: string;
  industry: string;
  logo_url: string;
  sort_order: string;
  is_published: boolean;
}

const EMPTY_DRAFT: DraftRow = {
  id: null,
  name: '',
  url: '#',
  industry: '',
  logo_url: '',
  sort_order: '',
  is_published: true,
};

export default function ClientsCmsPage() {
  useTopbar({ title: 'CMS — Clients', subtitle: 'Logo TrustBento + back-link case-study (single-locale, i nomi non si traducono).' });

  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const { data, isLoading } = useQuery<{ rows: ClientRow[] }>({
    queryKey: ['cms-clients'],
    queryFn: () => apiFetch('/api/cms/clients'),
  });
  const rows = data?.rows ?? [];

  const saveMutation = useMutation({
    mutationFn: async (d: DraftRow) => {
      const body = {
        name: d.name.trim(),
        url: d.url.trim() || '#',
        industry: d.industry.trim() || null,
        logo_url: d.logo_url.trim() || null,
        sort_order: d.sort_order.trim() === '' ? null : Number(d.sort_order),
        is_published: d.is_published,
      };
      if (d.id) return apiFetch(`/api/cms/clients/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      return apiFetch('/api/cms/clients', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-clients'] });
      toast.success('Salvato');
      setDraft(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cms/clients/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-clients'] });
      toast.success('Eliminato');
    },
  });

  const editRow = (row: ClientRow) => setDraft({
    id: row.id,
    name: row.name,
    url: row.url,
    industry: row.industry ?? '',
    logo_url: row.logo_url ?? '',
    sort_order: row.sort_order?.toString() ?? '',
    is_published: row.is_published,
  });

  const togglePublish = (row: ClientRow) => {
    saveMutation.mutate({
      id: row.id,
      name: row.name,
      url: row.url,
      industry: row.industry ?? '',
      logo_url: row.logo_url ?? '',
      sort_order: row.sort_order?.toString() ?? '',
      is_published: !row.is_published,
    });
  };

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-end">
        <Button onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          <Plus className="h-4 w-4 mr-2" /> Nuovo cliente
        </Button>
      </div>

      {draft && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{draft.id ? 'Modifica cliente' : 'Nuovo cliente'}</h3>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}><X className="h-4 w-4" /></Button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Nome</Label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Acme S.r.l." />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Settore</Label>
              <Input value={draft.industry} onChange={(e) => setDraft({ ...draft, industry: e.target.value })} placeholder="Edilizia, E-Commerce, Personal Brand…" />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">URL sito cliente</Label>
              <Input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://cliente.it/  oppure  #" />
              <p className="text-[10px] text-muted-foreground">Usa <code>#</code> se il cliente non vuole essere linkato.</p>
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Logo URL</Label>
              <Input value={draft.logo_url} onChange={(e) => setDraft({ ...draft, logo_url: e.target.value })} placeholder="/img/works/nome-cliente.webp" />
              <p className="text-[10px] text-muted-foreground">Path relativo a /public/img/works/ o URL assoluto. Preferire webp.</p>
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
          <Button onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending || !draft.name.trim()}>
            <Save className="h-4 w-4 mr-2" /> {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Nessun cliente"
          description="Aggiungi il primo cliente. Finché la tabella è vuota, il sito usa la lista hardcoded di apps/sito-v3/src/data/clients.ts."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {rows.map((row) => (
            <div key={row.id} className="rounded-lg border bg-card p-4 flex gap-4 items-start">
              {row.logo_url && (
                <img src={row.logo_url} alt={row.name} className="h-12 w-12 rounded-md object-contain bg-muted p-1" />
              )}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm flex items-center gap-1.5">
                  {row.name}
                  {row.url && row.url !== '#' && (
                    <a href={row.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </p>
                {row.industry && <p className="text-xs text-muted-foreground">{row.industry}</p>}
              </div>
              <div className="flex flex-col items-end gap-1">
                {row.sort_order !== null && (
                  <Badge variant="outline" className="font-mono text-[10px]">#{row.sort_order}</Badge>
                )}
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => togglePublish(row)}>
                    {row.is_published ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => editRow(row)}>Modifica</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(`Eliminare ${row.name}?`)) deleteMutation.mutate(row.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
