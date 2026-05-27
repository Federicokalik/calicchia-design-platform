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

interface FaqRow {
  id: string;
  locale: 'it' | 'en';
  question: string;
  answer: string;
  sort_order: number | null;
  is_published: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

interface DraftRow {
  id: string | null;
  locale: 'it' | 'en';
  question: string;
  answer: string;
  sort_order: string;
  is_published: boolean;
}

const EMPTY_DRAFT: DraftRow = {
  id: null,
  locale: 'it',
  question: '',
  answer: '',
  sort_order: '',
  is_published: true,
};

export default function FaqCmsPage() {
  useTopbar({ title: 'CMS — FAQ', subtitle: 'Domande frequenti del sito pubblico (/faq).' });

  const queryClient = useQueryClient();
  const [localeFilter, setLocaleFilter] = useState<'all' | 'it' | 'en'>('all');
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const { data, isLoading } = useQuery<{ rows: FaqRow[] }>({
    queryKey: ['cms-faqs', localeFilter],
    queryFn: () => apiFetch(`/api/cms/faqs${localeFilter !== 'all' ? `?locale=${localeFilter}` : ''}`),
  });
  const rows = data?.rows ?? [];

  const byLocale = useMemo(() => {
    const groups = new Map<string, FaqRow[]>();
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
        question: d.question.trim(),
        answer: d.answer.trim(),
        sort_order: d.sort_order.trim() === '' ? null : Number(d.sort_order),
        is_published: d.is_published,
      };
      if (d.id) return apiFetch(`/api/cms/faqs/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      return apiFetch('/api/cms/faqs', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-faqs'] });
      toast.success('Salvato');
      setDraft(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cms/faqs/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-faqs'] });
      toast.success('Eliminata');
    },
  });

  const editRow = (row: FaqRow) => setDraft({
    id: row.id,
    locale: row.locale,
    question: row.question,
    answer: row.answer,
    sort_order: row.sort_order?.toString() ?? '',
    is_published: row.is_published,
  });

  const togglePublish = (row: FaqRow) => {
    saveMutation.mutate({
      id: row.id,
      locale: row.locale,
      question: row.question,
      answer: row.answer,
      sort_order: row.sort_order?.toString() ?? '',
      is_published: !row.is_published,
    });
  };

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <Select value={localeFilter} onValueChange={(v) => setLocaleFilter(v as typeof localeFilter)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutte le lingue</SelectItem>
            <SelectItem value="it">Italiano</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setDraft({ ...EMPTY_DRAFT, locale: localeFilter === 'en' ? 'en' : 'it' })}>
          <Plus className="h-4 w-4 mr-2" /> Nuova FAQ
        </Button>
      </div>

      {draft && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{draft.id ? 'Modifica FAQ' : 'Nuova FAQ'}</h3>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              <X className="h-4 w-4" />
            </Button>
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
              <Label className="text-xs">Ordine (vuoto = in fondo)</Label>
              <Input
                type="number"
                value={draft.sort_order}
                onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })}
                placeholder="10"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Pubblicata</Label>
              <Button
                variant={draft.is_published ? 'default' : 'outline'}
                onClick={() => setDraft({ ...draft, is_published: !draft.is_published })}
                className="w-full"
              >
                {draft.is_published ? 'Visibile' : 'Nascosta'}
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Domanda</Label>
            <Input value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Risposta</Label>
            <Textarea
              value={draft.answer}
              onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
              rows={6}
            />
            <p className="text-[10px] text-muted-foreground">
              Newline interpretati come <code>\n</code>. HTML non sanitizzato — usa solo testo semplice.
            </p>
          </div>
          <Button onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending || !draft.question.trim() || !draft.answer.trim()}>
            <Save className="h-4 w-4 mr-2" /> {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Nessuna FAQ"
          description="Aggiungi la prima FAQ qui sopra. Finché la tabella è vuota, il sito usa le FAQ hardcoded di apps/sito-v3/src/data/faqs.ts."
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
                  <div key={row.id} className="rounded-lg border bg-card p-4 space-y-2">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{row.question}</p>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{row.answer}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        {row.sort_order !== null && (
                          <Badge variant="outline" className="font-mono text-[10px]">#{row.sort_order}</Badge>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => togglePublish(row)} title={row.is_published ? 'Nascondi' : 'Pubblica'}>
                          {row.is_published ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => editRow(row)}>Modifica</Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (window.confirm('Eliminare definitivamente questa FAQ?')) deleteMutation.mutate(row.id);
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
