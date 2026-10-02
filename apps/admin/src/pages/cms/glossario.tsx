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

// Allineate al CHECK site_glossario_category_check (mig 153) e alle label
// pubbliche in apps/sito-v3/src/data/glossario.ts.
const CATEGORIES = [
  { id: 'seo', label: 'SEO e contenuti' },
  { id: 'performance', label: 'Performance' },
  { id: 'infrastruttura', label: 'Hosting e infrastruttura' },
  { id: 'dominio-email', label: 'Dominio, DNS ed email' },
  { id: 'sviluppo', label: 'Linguaggi e sviluppo' },
  { id: 'piattaforme', label: 'Piattaforme e framework' },
  { id: 'sicurezza-legale', label: 'Sicurezza e privacy' },
  { id: 'design-ux', label: 'Design, UX e accessibilità' },
  { id: 'motion-3d', label: 'Animazione e 3D' },
] as const;

type Category = (typeof CATEGORIES)[number]['id'];
type Level = 'base' | 'tecnico';
type TermType = 'concept' | 'technology';

const NO_CATEGORY = 'none';

interface GlossarioRow {
  id: string;
  locale: 'it' | 'en';
  slug: string;
  term: string;
  full_name: string | null;
  letter: string;
  category: Category | null;
  level: Level;
  term_type: TermType;
  aliases: string[];
  related: string[];
  what_it_is: string;
  why_you_care: string | null;
  what_to_demand: string | null;
  what_for: string | null;
  when_yes: string | null;
  when_no: string | null;
  what_to_ask: string | null;
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
  category: Category | typeof NO_CATEGORY;
  level: Level;
  term_type: TermType;
  /** Liste separate da virgola nell'editor, array nel DB */
  aliases: string;
  related: string;
  what_it_is: string;
  why_you_care: string;
  what_to_demand: string;
  what_for: string;
  when_yes: string;
  when_no: string;
  what_to_ask: string;
  sort_order: string;
  is_published: boolean;
}

type TextField =
  | 'what_it_is' | 'why_you_care' | 'what_to_demand'
  | 'what_for' | 'when_yes' | 'when_no' | 'what_to_ask';

// Campi testuali per template, nell'ordine in cui il sito li mostra.
const TEMPLATE_FIELDS: Record<TermType, Array<{ key: TextField; label: string; placeholder: string }>> = {
  concept: [
    { key: 'what_it_is', label: "Cos'è", placeholder: 'Definizione asciutta.' },
    { key: 'why_you_care', label: 'Perché ti riguarda', placeholder: 'Impatto concreto sul cliente.' },
    { key: 'what_to_demand', label: 'Cosa pretendere', placeholder: 'Richiesta concreta al fornitore.' },
  ],
  technology: [
    { key: 'what_it_is', label: "Cos'è", placeholder: 'Definizione asciutta.' },
    { key: 'what_for', label: 'A cosa serve', placeholder: 'Il beneficio pratico.' },
    { key: 'when_yes', label: 'Quando conviene', placeholder: 'Progetti in cui è la scelta giusta.' },
    { key: 'when_no', label: 'Quando no', placeholder: 'Quando è sovradimensionata o rischiosa.' },
    { key: 'what_to_ask', label: 'Cosa chiedere al fornitore', placeholder: 'Domande e garanzie da pretendere.' },
  ],
};

const EMPTY_DRAFT: DraftRow = {
  id: null,
  locale: 'it',
  slug: '',
  term: '',
  full_name: '',
  letter: '',
  category: NO_CATEGORY,
  level: 'base',
  term_type: 'concept',
  aliases: '',
  related: '',
  what_it_is: '',
  why_you_care: '',
  what_to_demand: '',
  what_for: '',
  when_yes: '',
  when_no: '',
  what_to_ask: '',
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

function splitList(value: string, toSlug = false): string[] {
  return Array.from(new Set(
    value
      .split(',')
      .map((s) => (toSlug ? slugify(s) : s.trim().toLowerCase()))
      .filter(Boolean),
  ));
}

function categoryLabel(id: Category | null): string | null {
  return CATEGORIES.find((c) => c.id === id)?.label ?? null;
}

export default function GlossarioCmsPage() {
  useTopbar({
    title: 'CMS — Glossario',
    subtitle: 'Termini del glossario web design (/risorse/glossario-web-design), IT ed EN con lo stesso slug.',
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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['cms-glossario'] });

  const saveMutation = useMutation({
    mutationFn: async (d: DraftRow) => {
      const text = (v: string) => v.trim() || null;
      const isTech = d.term_type === 'technology';
      // Il template non usato viene svuotato: niente testi orfani nel DB.
      const body = {
        locale: d.locale,
        slug: d.slug.trim(),
        term: d.term.trim(),
        full_name: text(d.full_name),
        letter: d.letter.trim().toUpperCase(),
        category: d.category === NO_CATEGORY ? null : d.category,
        level: d.level,
        term_type: d.term_type,
        aliases: splitList(d.aliases),
        related: splitList(d.related, true),
        what_it_is: d.what_it_is.trim(),
        why_you_care: isTech ? null : text(d.why_you_care),
        what_to_demand: isTech ? null : text(d.what_to_demand),
        what_for: isTech ? text(d.what_for) : null,
        when_yes: isTech ? text(d.when_yes) : null,
        when_no: isTech ? text(d.when_no) : null,
        what_to_ask: isTech ? text(d.what_to_ask) : null,
        sort_order: d.sort_order.trim() === '' ? null : Number(d.sort_order),
        is_published: d.is_published,
      };
      if (d.id) return apiFetch(`/api/cms/glossario/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      return apiFetch('/api/cms/glossario', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      invalidate();
      toast.success('Salvato');
      setDraft(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore'),
  });

  const publishMutation = useMutation({
    mutationFn: (row: GlossarioRow) => apiFetch(`/api/cms/glossario/${row.id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_published: !row.is_published }),
    }),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message || 'Errore'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cms/glossario/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
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
    category: row.category ?? NO_CATEGORY,
    level: row.level,
    term_type: row.term_type,
    aliases: (row.aliases ?? []).join(', '),
    related: (row.related ?? []).join(', '),
    what_it_is: row.what_it_is,
    why_you_care: row.why_you_care ?? '',
    what_to_demand: row.what_to_demand ?? '',
    what_for: row.what_for ?? '',
    when_yes: row.when_yes ?? '',
    when_no: row.when_no ?? '',
    what_to_ask: row.what_to_ask ?? '',
    sort_order: row.sort_order?.toString() ?? '',
    is_published: row.is_published,
  });

  if (isLoading) return <LoadingState />;

  const templateFields = draft ? TEMPLATE_FIELDS[draft.term_type] : [];
  const canSave = !!draft
    && !saveMutation.isPending
    && !!draft.term.trim()
    && !!draft.slug.trim()
    && !!draft.letter.trim()
    && templateFields.every((f) => draft[f.key].trim() !== '');

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
              <Label className="text-xs">Nome completo / sottotitolo (opzionale)</Label>
              <Input value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} placeholder="Largest Contentful Paint" />
            </div>
            <div className="space-y-1 col-span-3">
              <Label className="text-xs">Slug (URL anchor)</Label>
              <Input
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })}
                placeholder="lcp"
              />
              <p className="text-[10px] text-muted-foreground">Solo a-z, 0-9, trattini. Unico per lingua, uguale tra IT ed EN.</p>
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
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Categoria</Label>
              <Select value={draft.category} onValueChange={(v) => setDraft({ ...draft, category: v as DraftRow['category'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>Nessuna</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Livello</Label>
              <Select value={draft.level} onValueChange={(v) => setDraft({ ...draft, level: v as Level })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="base">Base</SelectItem>
                  <SelectItem value="tecnico">Tecnico</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tipo</Label>
              <Select value={draft.term_type} onValueChange={(v) => setDraft({ ...draft, term_type: v as TermType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="concept">Concetto</SelectItem>
                  <SelectItem value="technology">Tecnologia</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Alias (separati da virgola)</Label>
              <Input value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} placeholder="ssl, tls, lucchetto" />
              <p className="text-[10px] text-muted-foreground">Sinonimi trovati dalla ricerca del sito.</p>
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Correlati (slug separati da virgola)</Label>
              <Input value={draft.related} onChange={(e) => setDraft({ ...draft, related: e.target.value })} placeholder="core-web-vitals, lcp" />
              <p className="text-[10px] text-muted-foreground">Gli slug inesistenti o nascosti vengono ignorati dal sito.</p>
            </div>
          </div>

          {templateFields.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs">{f.label}</Label>
              <Textarea
                value={draft[f.key]}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                rows={3}
                placeholder={f.placeholder}
              />
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground">Per andare a capo premi Invio. Testo semplice, niente HTML.</p>

          <Button onClick={() => saveMutation.mutate(draft)} disabled={!canSave}>
            <Save className="h-4 w-4 mr-2" /> {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Nessun termine"
          description="Aggiungi il primo termine. Finché la tabella è vuota, il sito usa lo snapshot di apps/sito-v3/src/data/glossario-fallback.ts."
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
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <p className="font-medium text-sm">{row.term}</p>
                          {row.full_name && <span className="text-xs text-muted-foreground">— {row.full_name}</span>}
                          <code className="text-[10px] text-muted-foreground font-mono">#{row.slug}</code>
                        </div>
                        <div className="flex items-center gap-1 mt-1 flex-wrap">
                          <Badge variant="secondary" className="text-[10px]">
                            {row.term_type === 'technology' ? 'Tecnologia' : 'Concetto'}
                          </Badge>
                          {categoryLabel(row.category) && (
                            <Badge variant="outline" className="text-[10px]">{categoryLabel(row.category)}</Badge>
                          )}
                          {row.level === 'tecnico' && <Badge variant="outline" className="text-[10px]">Tecnico</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{row.what_it_is}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {row.sort_order !== null && (
                          <Badge variant="outline" className="font-mono text-[10px]">#{row.sort_order}</Badge>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => publishMutation.mutate(row)} disabled={publishMutation.isPending}>
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
