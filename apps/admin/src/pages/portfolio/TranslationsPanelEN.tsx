import { useEffect, useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api';

const TRANSLATABLE_FIELDS = [
  { key: 'title', label: 'Titolo', type: 'input', maxChars: 200 },
  { key: 'description', label: 'Descrizione breve', type: 'textarea', maxChars: 500 },
  { key: 'content', label: 'Contenuto long-form', type: 'textarea', maxChars: 50000 },
  { key: 'outcome', label: 'Outcome (risultati)', type: 'textarea', maxChars: 1500 },
  { key: 'seo_title', label: 'SEO Title', type: 'input', maxChars: 70 },
  { key: 'seo_description', label: 'SEO Description', type: 'textarea', maxChars: 160 },
] as const;

type FieldKey = (typeof TRANSLATABLE_FIELDS)[number]['key'];
type Translations = Partial<Record<FieldKey, string>>;

interface TranslationsResponse {
  project_id: number;
  translations: {
    it?: Translations;
    en?: Translations;
  };
}

interface TranslationsPanelENProps {
  projectId: string | number;
  /** Riferimento ai valori IT correnti del form (mostrati come reference). */
  itValues: Translations;
}

/**
 * Pannello traduzioni EN per progetti portfolio.
 *
 * UX: per ogni campo translatable (6 campi) mostra a sinistra il valore IT
 * (read-only reference) e a destra l'input EN. Submit chiama
 * PATCH /api/projects/:id/translations/en.
 *
 * Indicatore "X/6 campi tradotti" calcolato in tempo reale.
 * Empty/null in un campo EN → cancella la translation row (fallback IT).
 */
export function TranslationsPanelEN({ projectId, itValues }: TranslationsPanelENProps) {
  const queryClient = useQueryClient();
  const [enValues, setEnValues] = useState<Translations>({});

  const { data, isLoading } = useQuery<TranslationsResponse>({
    queryKey: ['project-translations', projectId],
    queryFn: () => apiFetch(`/api/projects/${projectId}/translations`),
    enabled: !!projectId && projectId !== 'new',
  });

  useEffect(() => {
    if (data?.translations?.en) {
      setEnValues(data.translations.en);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (payload: Translations) => {
      // null per cancellare, empty string skippato lato API
      const body: Record<string, string | null> = {};
      for (const f of TRANSLATABLE_FIELDS) {
        const value = payload[f.key];
        body[f.key] = value && value.trim() ? value.trim() : null;
      }
      return apiFetch(`/api/projects/${projectId}/translations/en`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      toast.success('Traduzioni EN salvate');
      queryClient.invalidateQueries({ queryKey: ['project-translations', projectId] });
    },
    onError: (err: Error) => {
      toast.error(`Errore salvataggio: ${err.message}`);
    },
  });

  const filledCount = useMemo(
    () =>
      TRANSLATABLE_FIELDS.filter((f) => {
        const v = enValues[f.key];
        return v && v.trim().length > 0;
      }).length,
    [enValues],
  );

  if (projectId === 'new') {
    return (
      <div className="rounded-md border border-dashed border-muted-foreground/30 p-6 text-sm text-muted-foreground">
        <Globe className="h-4 w-4 inline-block mr-2" />
        Salva prima il progetto in italiano per abilitare le traduzioni EN.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-md border border-muted-foreground/20 p-6 text-sm text-muted-foreground">
        Caricamento traduzioni…
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between gap-4 border-b border-muted-foreground/20 pb-4">
        <div className="flex items-center gap-3">
          <Globe className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-lg font-semibold">Traduzioni EN</h2>
            <p className="text-xs text-muted-foreground">
              Italiano è il canonical. Lascia vuoto un campo EN per usare il fallback IT.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            {filledCount}/{TRANSLATABLE_FIELDS.length} tradotti
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => saveMutation.mutate(enValues)}
            disabled={saveMutation.isPending}
          >
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {saveMutation.isPending ? 'Salvataggio…' : 'Salva EN'}
          </Button>
        </div>
      </header>

      <div className="space-y-5">
        {TRANSLATABLE_FIELDS.map((f) => {
          const itVal = itValues[f.key] ?? '';
          const enVal = enValues[f.key] ?? '';

          return (
            <div key={f.key} className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  🇮🇹 {f.label} (IT — canonical)
                </Label>
                {f.type === 'input' ? (
                  <Input
                    value={itVal}
                    readOnly
                    disabled
                    className="mt-1 bg-muted/30"
                  />
                ) : (
                  <Textarea
                    value={itVal}
                    readOnly
                    disabled
                    rows={f.key === 'content' ? 8 : 3}
                    className="mt-1 bg-muted/30 font-mono text-xs"
                  />
                )}
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  🇬🇧 {f.label} (EN)
                  {f.maxChars && (
                    <span className="ml-2 normal-case text-[10px] text-muted-foreground/70">
                      {enVal.length}/{f.maxChars}
                    </span>
                  )}
                </Label>
                {f.type === 'input' ? (
                  <Input
                    value={enVal}
                    maxLength={f.maxChars}
                    onChange={(e) => setEnValues({ ...enValues, [f.key]: e.target.value })}
                    placeholder={`English ${f.label.toLowerCase()}…`}
                    className="mt-1"
                  />
                ) : (
                  <Textarea
                    value={enVal}
                    maxLength={f.maxChars}
                    rows={f.key === 'content' ? 8 : 3}
                    onChange={(e) => setEnValues({ ...enValues, [f.key]: e.target.value })}
                    placeholder={`English ${f.label.toLowerCase()}…`}
                    className="mt-1 font-mono text-xs"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
