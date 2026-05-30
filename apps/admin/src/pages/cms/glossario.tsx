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
import { useConfirm } from '@/hooks/use-confirm';
import { LoadingState } from '@/components/shared/loading-state';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';

interface GlossarioRow {
  id: string;
  locale: 'it' | 'en';
  slug: string;
  term: string;
  full_name: string | null;
  letter: string;
  what_it_is: string;
  why_you_care: string;
  what_to_demand: string;
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
  term: string;
  full_name: string;
  letter: string;
  what_it_is: string;
  why_you_care: string;
  what_to_demand: string;
  sort_order: string;
  is_published: boolean;
}

const EMPTY_DRAFT: DraftRow = {
  id: null,
  locale: 'it',
  slug: '',
  term: '',
  full_name: '',
  letter: '',
  what_it_is: '',
  why_you_care: '',
  what_to_demand: '',
  sort_order: '',
  is_published: true,
};

// Lightweight slugify so the editor can pre-fill slug from term — admin
// can still override. Matches the regex CHECK on the column.
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export default function GlossarioCmsPage() {
  useTopbar({
    title: 'CMS — Glossario',
    subtitle: 'Termini del glossario web design (/glossario-web-design).',
  });

  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [localeFilter, setLocaleFilter] = useState<'all' | 'it' | 'en'>('all');
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const { data, isLoading } = useQuery<{ rows: GlossarioRow[] }>({
    queryKey: ['cms-glossario', localeFilter],
    queryFn: () => apiFetch(`/api/cms/glossario${localeFilter !== 'all' ? `?locale=${localeFilter}` : ''}`),
  });
  const rows = data?.rows ?? [];

  // Group by locale then by letter — admin scans A-Z like the public page.
  const byLocaleByLetter = useMemo(() => {
    const groups = new Map<string, Map<string, GlossarioRow[]>>();
    for (const row of rows) {
      const localeMap = groups.get(row.locale) ?? new Map<string, GlossarioRow[]>();
      const list = localeMap.get(row.letter) ?? [];
      list.push(row);
      localeMap.set(row.letter, list);
      groups.set(row.locale, localeMap);
    }
    return groups;
  }, [rows]);

  const saveMutation = useMutation({
    mutationFn: async (d: DraftRow) => {
      const body = {
        locale: d.locale,
        slug: d.slug.trim(),
        term: d.term.trim(),
        full_name: d.full_name.trim() || null,
        letter: d.letter.trim().toUpperCase(),
        what_it_is: d.what_it_is.trim(),
        why_you_care: d.why_you_care.trim(),
        what_to_demand: d.what_to_demand.trim(),
        sort_order: d.sort_order.trim() === '' ? null : Number(d.sort_order),
        is_published: d.is_published,
      };
      if (d.id) return apiFetch(`/api/cms/glossario/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      return apiFetch('/api/cms/glossario', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-glossario'] });
      toast.success('Salvato');
      setDraft(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cms/glossario/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-glossario'] });
      toast.success('Eliminato');
    },
  });

  const editRow = (row: GlossarioRow) => setDraft({
    id: row.id,
    locale: row.locale,
    slug: row.slug,
    term: row.term,
    full_name: row.full_name ?? '',
    letter: row.letter,
    what_it_is: row.what_it_is,
    why_you_care: row.why_you_care,
    what_to_demand: row.what_to_demand,
    sort_order: row.sort_order?.toString() ?? '',
    is_published: row.is_published,
  });

  const togglePublish = (row: GlossarioRow) => {
    saveMutation.mutate({
      id: row.id,
      locale: row.locale,
      slug: row.slug,
      term: row.term,
      full_name: row.full_name ?? '',
      letter: row.letter,
      what_it_is: row.what_it_is,
      why_you_care: row.why_you_care,
      what_to_demand: row.what_to_demand,
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
          <Plus className="h-4 w-4 mr-2" /> Nuovo termine
        </Button>
      </div>

      {draft && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{draft.id ? 'Modifica termine' : 'Nuovo termine'}</h3>
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
              <Label className="text-xs">Lettera</Label>
              <Input
                value={draft.letter}
                onChange={(e) => setDraft({ ...draft, letter: e.target.value.toUpperCase().slice(0, 1) })}
                maxLength={1}
                placeholder="A"
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Ordine intra-lettera (vuoto = alfabetico)</Label>
              <Input
                type="number"
                value={draft.sort_order}
                onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })}
                placeholder="10"
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Termine</Label>
              <Input
                value={draft.term}
                onChange={(e) => {
                  const term = e.target.value;
                  setDraft({
                    ...draft,
                    term,
                    // Auto-fill slug from term ONLY when the slug is empty
                    // (don't trample an admin edit, but help the new-entry case).
                    slug: draft.slug || slugify(term),
                    letter: draft.letter || term.trim().charAt(0).toUpperCase(),
                  });
                }}
                placeholder="LCP"
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Nome completo (opzionale)</Label>
              <Input value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} placeholder="Largest Contentful Paint" />
            </div>
            <div className="space-y-1 col-span-3">
              <Label className="text-xs">Slug (URL anchor)</Label>
              <Input
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })}
                placeholder="lcp"
              />
              <p className="text-[10px] text-muted-foreground">Solo a-z, 0-9, trattini. Unico per lingua.</p>
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
            <Label className="text-xs">Cos'è</Label>
            <Textarea value={draft.what_it_is} onChange={(e) => setDraft({ ...draft, what_it_is: e.target.value })} rows={3} placeholder="Definizione asciutta, max 30 parole." />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Perché ti riguarda</Label>
            <Textarea value={draft.why_you_care} onChange={(e) => setDraft({ ...draft, why_you_care: e.target.value })} rows={3} placeholder="Impatto sul cliente, max 35 parole." />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Cosa pretendere</Label>
            <Textarea value={draft.what_to_demand} onChange={(e) => setDraft({ ...draft, what_to_demand: e.target.value })} rows={3} placeholder="Richiesta concreta al fornitore, max 35 parole." />
          </div>

          <Button onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending || !draft.term.trim() || !draft.slug.trim() || !draft.letter.trim() || !draft.what_it_is.trim() || !draft.why_you_care.trim() || !draft.what_to_demand.trim()}>
            <Save className="h-4 w-4 mr-2" /> {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Nessun termine"
          description="Aggiungi il primo termine. Finché la tabella è vuota, il sito usa il glossario hardcoded di apps/sito-v3/src/data/glossario.ts."
        />
      ) : (
        <div className="space-y-8">
          {Array.from(byLocaleByLetter.entries()).map(([locale, byLetter]) => (
            <div key={locale} className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide">{locale === 'it' ? 'Italiano' : 'English'}</h2>
                <Badge variant="outline">{Array.from(byLetter.values()).reduce((s, l) => s + l.length, 0)}</Badge>
              </div>
              {Array.from(byLetter.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([letter, list]) => (
                <div key={letter} className="space-y-1">
                  <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">— {letter} ({list.length})</p>
                  {list.map((row) => (
                    <div key={row.id} className="rounded-lg border bg-card p-3 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <p className="font-medium text-sm">{row.term}</p>
                          {row.full_name && <span className="text-xs text-muted-foreground">— {row.full_name}</span>}
                          <code className="text-[10px] text-muted-foreground font-mono">#{row.slug}</code>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{row.what_it_is}</p>
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
                          onClick={async () => {
                            if (await confirm({ title: `Eliminare "${row.term}"?`, variant: 'destructive' })) deleteMutation.mutate(row.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
