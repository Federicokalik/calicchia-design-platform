import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowLeft, Save, Plus, Trash2, Sparkles, Loader2, Link as LinkIcon, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ImageUpload } from '@/components/ui/image-upload';
import { GalleryEditor, normalizeGalleryIncoming, type GalleryItem } from '@/components/portfolio/gallery-editor';
import { RichEditor } from '@/components/ui/rich-editor';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';
import {
  SERVICE_OPTIONS,
  parseServicesString,
  serializeServices,
} from '@/data/service-options';
import { TranslationsPanelEN } from './TranslationsPanelEN';

const schema = z.object({
  title: z.string().min(1, 'Titolo richiesto'),
  slug: z.string().min(1, 'Slug richiesto'),
  description: z.string().optional(),
  // Migration 090: `brief` sostituisce `content`/`challenge`/`solution`
  // come body unico del case study (markdown via RichEditor TipTap).
  brief: z.string().optional(),
  cover_image: z.string().optional(),
  cover_alt: z.string().max(250).optional(),
  live_url: z.string().optional(),
  repo_url: z.string().optional(),
  client: z.string().optional(),
  // `services` is managed by `serviceSlugs` state + the pill-toggle UI,
  // not bound to the form. Kept out of the schema to avoid a dead field.
  industries: z.string().optional(),
  technologies: z.string().optional(),
  // Migration 075 — case study extension
  year: z.coerce.number().int().min(1990).max(2100).optional().or(z.literal('').transform(() => undefined)),
  tags: z.string().optional(), // CSV in form, parsed to TEXT[] on submit
  outcome: z.string().optional(),
  seo_title: z.string().max(70).optional(),
  seo_description: z.string().max(160).optional(),
  is_published: z.boolean().default(false),
  is_featured: z.boolean().default(false),
  display_order: z.number().default(0),
});

type FormData = z.infer<typeof schema>;

interface MetricRow {
  label: string;
  value: string;
  before: string;
  after: string;
  unit: string;
}
const EMPTY_METRIC: MetricRow = {
  label: '',
  value: '',
  before: '',
  after: '',
  unit: '',
};

export default function PortfolioEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id || id === 'new';

  // Migration 090: challenge/solution states rimossi. Brief vive in form.brief.
  const [feedback, setFeedback] = useState({ quote: '', author: '', role: '' });
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  // Migration 075 — metrics repeater. Each row may use either {label,value}
  // or {label,before,after,unit} pattern; the frontend renders both.
  const [metrics, setMetrics] = useState<MetricRow[]>([]);

  // Services: managed as canonical-slug array; serialised to CSV on save.
  // Drives the pill-toggle multi-select that replaces the old free-text Input.
  const [serviceSlugs, setServiceSlugs] = useState<string[]>([]);
  const toggleService = (slug: string) => {
    setServiceSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    );
  };

  const topbarActions = useMemo(() => (
    <Button type="submit" form="portfolio-form" size="sm" disabled={false}>
      <Save className="h-3.5 w-3.5 mr-1.5" />
      {isNew ? 'Crea' : 'Salva'}
    </Button>
  ), [isNew]);

  useTopbar({ title: isNew ? 'Nuovo Progetto Portfolio' : 'Modifica Progetto' , actions: topbarActions });

  const { data } = useQuery({
    queryKey: ['portfolio-project', id],
    queryFn: () => apiFetch(`/api/projects/${id}`),
    enabled: !isNew,
  });

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: '',
      slug: '',
      description: '',
      brief: '',
      tags: '',
      outcome: '',
      seo_title: '',
      seo_description: '',
      is_published: false,
      is_featured: false,
      display_order: 0,
    },
  });

  useEffect(() => {
    if (data?.project) {
      const p = data.project;
      form.reset({
        title: p.title || '',
        slug: p.slug || '',
        description: p.description || '',
        brief: p.brief || '',
        cover_image: p.cover_image || '',
        cover_alt: p.cover_alt || '',
        live_url: p.live_url || '',
        repo_url: p.repo_url || '',
        client: p.client || '',
        industries: p.industries || '',
        technologies: Array.isArray(p.technologies) ? p.technologies.join(', ') : (p.technologies || ''),
        // Migration 075
        year: p.year ?? undefined,
        tags: Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || ''),
        outcome: p.outcome || '',
        seo_title: p.seo_title || '',
        seo_description: p.seo_description || '',
        is_published: p.is_published || false,
        is_featured: p.is_featured || false,
        display_order: p.display_order || 0,
      });
      if (p.feedback) setFeedback(typeof p.feedback === 'string' ? JSON.parse(p.feedback) : p.feedback);
      if (p.gallery) {
        const raw = typeof p.gallery === 'string' ? JSON.parse(p.gallery) : p.gallery;
        // Accept both legacy string[] and current {src, alt}[] shapes.
        setGallery(normalizeGalleryIncoming(raw));
      }
      if (p.metrics) {
        const parsed = typeof p.metrics === 'string' ? JSON.parse(p.metrics) : p.metrics;
        setMetrics(
          Array.isArray(parsed)
            ? parsed.map((m: any) => ({
                label: m.label ?? '',
                value: m.value ?? '',
                before: m.before ?? '',
                after: m.after ?? '',
                unit: m.unit ?? '',
              }))
            : [],
        );
      }
      // Parse legacy free-text services into canonical slugs (typo-safe).
      setServiceSlugs(parseServicesString(p.services));
    }
  }, [data]);

  const watchTitle = form.watch('title');
  useEffect(() => {
    if (isNew && watchTitle) {
      form.setValue('slug', watchTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''));
    }
  }, [watchTitle, isNew]);

  const saveMutation = useMutation({
    mutationFn: async (values: FormData) => {
      // Strip empty fields from each metric row, drop fully-empty rows.
      const metricsClean = metrics
        .map((m) => {
          const row: Record<string, string> = { label: m.label.trim() };
          if (m.value.trim()) row.value = m.value.trim();
          if (m.before.trim()) row.before = m.before.trim();
          if (m.after.trim()) row.after = m.after.trim();
          if (m.unit.trim()) row.unit = m.unit.trim();
          return row;
        })
        .filter((m) => m.label && (m.value || m.before || m.after));

      const body = {
        ...values,
        technologies: values.technologies?.split(',').map((t) => t.trim()).filter(Boolean) || [],
        services: serializeServices(serviceSlugs),
        feedback: JSON.stringify(feedback),
        gallery: JSON.stringify(gallery),
        // Migration 090 — brief unico body
        brief: values.brief || null,
        // Migration 075 — case study extension
        year: values.year || null,
        tags: values.tags?.split(',').map((t) => t.trim()).filter(Boolean) || [],
        metrics: JSON.stringify(metricsClean),
        outcome: values.outcome || null,
        seo_title: values.seo_title || null,
        seo_description: values.seo_description || null,
      };
      if (isNew) return apiFetch('/api/projects', { method: 'POST', body: JSON.stringify(body) });
      return apiFetch(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio-projects'] });
      toast.success(isNew ? 'Progetto creato' : 'Salvato');
      navigate('/portfolio');
    },
    onError: () => toast.error('Errore nel salvataggio'),
  });

  // AI: suggest seo_title + seo_description from title/description/brief.
  // Requires a saved project (uses IT canonical fields from the DB row),
  // so the button is disabled while isNew. Pre-fills the form, user reviews.
  const seoMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/projects/${id}/ai/seo`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return res as { seo_title: string; seo_description: string };
    },
    onSuccess: (data) => {
      if (data.seo_title) form.setValue('seo_title', data.seo_title, { shouldDirty: true });
      if (data.seo_description) form.setValue('seo_description', data.seo_description, { shouldDirty: true });
      toast.success('SEO suggerito da AI · rivedi e salva');
    },
    onError: (err: Error) => toast.error(`Errore SEO AI: ${err.message}`),
  });

  // Pure regex URL extraction from the brief markdown — no AI tax.
  // Handles bare URLs and markdown-link [text](url). Deduplicates.
  const briefValue = form.watch('brief') || '';
  const extractedLinks = useMemo(() => {
    const urls = new Set<string>();
    const re = /https?:\/\/[^\s)<>'"]+/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(briefValue)) !== null) {
      // Strip trailing punctuation that the regex might catch.
      const cleaned = match[0].replace(/[.,;:!?]+$/, '');
      urls.add(cleaned);
    }
    return Array.from(urls);
  }, [briefValue]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('/portfolio')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </div>

      <form id="portfolio-form" onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))}>
        <Tabs defaultValue="general" className="space-y-4">
          <TabsList>
            <TabsTrigger value="general">Generale</TabsTrigger>
            <TabsTrigger value="brief">Brief</TabsTrigger>
            <TabsTrigger value="case-study">Risultato & Feedback</TabsTrigger>
            <TabsTrigger value="media">Media</TabsTrigger>
            <TabsTrigger value="seo">SEO & Link</TabsTrigger>
          </TabsList>

          {/* === GENERALE === */}
          <TabsContent value="general" className="space-y-4">
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Titolo *</Label>
                  <Input {...form.register('title')} />
                  {form.formState.errors.title && <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Slug *</Label>
                  <Input {...form.register('slug')} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Cliente</Label>
                  <Input {...form.register('client')} placeholder="Nome cliente" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Settore</Label>
                  <Input {...form.register('industries')} placeholder="Tech, Food, Fashion..." />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Anno completamento</Label>
                  <Input
                    type="number"
                    min={1990}
                    max={2100}
                    placeholder="2024"
                    {...form.register('year', { valueAsNumber: true })}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Se &gt;1 anno fa, il sito mostra "il sito potrebbe essere cambiato o non più online".
                  </p>
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Servizi</Label>
                  <span className="text-[10px] text-muted-foreground">
                    {serviceSlugs.length === 0
                      ? 'Nessuno selezionato'
                      : `${serviceSlugs.length} selezionat${serviceSlugs.length === 1 ? 'o' : 'i'}`}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {SERVICE_OPTIONS.map((opt) => {
                    const active = serviceSlugs.includes(opt.slug);
                    return (
                      <button
                        key={opt.slug}
                        type="button"
                        onClick={() => toggleService(opt.slug)}
                        className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground'
                        }`}
                        aria-pressed={active}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Determina in quali pagine servizio del sito il progetto appare nello Showcase.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Tecnologie</Label>
                  <Input {...form.register('technologies')} placeholder="React, Astro, Tailwind..." />
                  <p className="text-[10px] text-muted-foreground">
                    Stack tecnico (separato da virgole).
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Tag filtrabili</Label>
                  <Input {...form.register('tags')} placeholder="e-commerce, b2b, wordpress..." />
                  <p className="text-[10px] text-muted-foreground">
                    Tag categoria per filtri index lavori (separati da virgole). Diversi da Tecnologie.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Switch checked={form.watch('is_published')} onCheckedChange={(v) => form.setValue('is_published', v)} />
                  <Label className="text-xs">Pubblicato</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={form.watch('is_featured')} onCheckedChange={(v) => form.setValue('is_featured', v)} />
                  <Label className="text-xs">In evidenza</Label>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* === BRIEF === Migration 090: body unico markdown.
              Sostituisce le ex sezioni Contenuto/Challenge/Solution. */}
          <TabsContent value="brief" className="space-y-4">
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Descrizione breve (per card index e SEO meta)</Label>
                <Textarea {...form.register('description')} rows={3} placeholder="Una frase secca per la card del progetto e meta description fallback." />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Brief (body del case study)</Label>
                <p className="text-[10px] text-muted-foreground">
                  Markdown unico: contesto + sfida + approccio in 300-500 parole.
                  Voice asciutto, niente "siamo riusciti". Va mostrato come
                  sezione 01 — Brief sul detail page.
                </p>
                <RichEditor
                  value={form.watch('brief') || ''}
                  onChange={(val) => form.setValue('brief', val)}
                />
              </div>
            </div>
          </TabsContent>

          {/* === RISULTATO & FEEDBACK === */}
          <TabsContent value="case-study" className="space-y-4">
            {/* Outcome + Metrics (migration 075) */}
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div>
                <h3 className="text-sm font-semibold">Risultato</h3>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Sintesi 80–150 parole "cosa è cambiato dopo il go-live". Voice factual, niente claim vuoti.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Outcome</Label>
                <Textarea
                  {...form.register('outcome')}
                  rows={5}
                  placeholder="Dopo 90 giorni: traffico organico +X%, lead form +Y, tempo medio sessione da Zs a Ws..."
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Metriche (numeri concreti)</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setMetrics([...metrics, { ...EMPTY_METRIC }])}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Aggiungi metrica
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Compila <strong>Valore</strong> per metrica singola (es. "+120%"), oppure <strong>Prima/Dopo</strong> per before→after.
                </p>
                {metrics.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">Nessuna metrica. Si possono lasciare vuote (la sezione Outcome viene nascosta su sito-v3 se non ci sono né outcome né metriche).</p>
                ) : (
                  <div className="space-y-2">
                    {metrics.map((m, i) => (
                      <div
                        key={i}
                        className="grid grid-cols-12 gap-2 items-end p-3 rounded-lg border bg-background/50"
                      >
                        <div className="col-span-3 space-y-1">
                          <Label className="text-[10px]">Label</Label>
                          <Input
                            value={m.label}
                            onChange={(e) => {
                              const next = [...metrics];
                              next[i] = { ...next[i], label: e.target.value };
                              setMetrics(next);
                            }}
                            placeholder="Lead/mese"
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-[10px]">Valore</Label>
                          <Input
                            value={m.value}
                            onChange={(e) => {
                              const next = [...metrics];
                              next[i] = { ...next[i], value: e.target.value };
                              setMetrics(next);
                            }}
                            placeholder="+120%"
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-[10px]">Prima</Label>
                          <Input
                            value={m.before}
                            onChange={(e) => {
                              const next = [...metrics];
                              next[i] = { ...next[i], before: e.target.value };
                              setMetrics(next);
                            }}
                            placeholder="3 min"
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-[10px]">Dopo</Label>
                          <Input
                            value={m.after}
                            onChange={(e) => {
                              const next = [...metrics];
                              next[i] = { ...next[i], after: e.target.value };
                              setMetrics(next);
                            }}
                            placeholder="40 sec"
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-[10px]">Unità</Label>
                          <Input
                            value={m.unit}
                            onChange={(e) => {
                              const next = [...metrics];
                              next[i] = { ...next[i], unit: e.target.value };
                              setMetrics(next);
                            }}
                            placeholder=""
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="col-span-1 flex justify-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setMetrics(metrics.filter((_, j) => j !== i))}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Feedback */}
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold">Feedback Cliente</h3>
              <div className="space-y-1.5">
                <Label className="text-xs">Citazione</Label>
                <Textarea value={feedback.quote} onChange={(e) => setFeedback({ ...feedback, quote: e.target.value })} rows={2} placeholder="&quot;Lavoro eccellente, superato le aspettative...&quot;" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Autore</Label>
                  <Input value={feedback.author} onChange={(e) => setFeedback({ ...feedback, author: e.target.value })} placeholder="Mario Rossi" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Ruolo</Label>
                  <Input value={feedback.role} onChange={(e) => setFeedback({ ...feedback, role: e.target.value })} placeholder="CEO, Rossi Srl" />
                </div>
              </div>
            </div>
          </TabsContent>

          {/* === MEDIA === */}
          <TabsContent value="media" className="space-y-4">
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold">Immagine di copertina</h3>
              <ImageUpload
                value={form.watch('cover_image') || ''}
                onChange={(url) => form.setValue('cover_image', url)}
              />
              <div className="space-y-1.5">
                <Label className="text-xs">Alt text cover</Label>
                <Input
                  {...form.register('cover_alt')}
                  placeholder="Descrizione concisa dell'immagine — usata da screen reader e SEO."
                  maxLength={250}
                />
                <p className="text-[10px] text-muted-foreground">
                  Vuoto = fallback automatico a "{form.watch('title') || 'titolo progetto'} — case study".
                </p>
              </div>
            </div>

            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div>
                <h3 className="text-sm font-semibold">Galleria</h3>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Carica le immagini, riordina con le frecce, scrivi un alt text per ciascuna (accessibilità + SEO).
                </p>
              </div>
              <GalleryEditor value={gallery} onChange={setGallery} folder="projects" max={20} />
            </div>
          </TabsContent>

          {/* === SEO & LINK === */}
          <TabsContent value="seo" className="space-y-4">
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">SEO Override</h3>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Opzionali. Se vuoti, sito-v3 cade su titolo + descrizione del progetto.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs shrink-0"
                  disabled={isNew || seoMutation.isPending}
                  onClick={() => {
                    const hasTitle = (form.getValues('seo_title') || '').trim().length > 0;
                    const hasDesc = (form.getValues('seo_description') || '').trim().length > 0;
                    if ((hasTitle || hasDesc) && !window.confirm('Sovrascrivo i campi SEO esistenti?')) return;
                    seoMutation.mutate();
                  }}
                  title={isNew ? 'Salva prima il progetto per usare la generazione AI' : 'Genera seo_title + seo_description da contenuto IT'}
                >
                  {seoMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {seoMutation.isPending ? 'Genero…' : 'Suggerisci con AI'}
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">SEO Title</Label>
                <Input
                  {...form.register('seo_title')}
                  placeholder="Es. Case study e-commerce moda · Federico Calicchia"
                  maxLength={70}
                />
                <div className="flex justify-between">
                  <p className="text-[10px] text-muted-foreground">
                    Override del &lt;title&gt; meta. Max 70 caratteri.
                  </p>
                  <span className="text-[10px] text-muted-foreground">
                    {(form.watch('seo_title') || '').length}/70
                  </span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">SEO Description</Label>
                <Textarea
                  {...form.register('seo_description')}
                  rows={3}
                  placeholder="Descrizione SERP. 150-160 caratteri. Voice factual, niente fronzoli."
                  maxLength={160}
                />
                <div className="flex justify-between">
                  <p className="text-[10px] text-muted-foreground">
                    Override del meta description. Max 160 caratteri.
                  </p>
                  <span className="text-[10px] text-muted-foreground">
                    {(form.watch('seo_description') || '').length}/160
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-xl border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold">Link</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">URL sito live</Label>
                  <Input {...form.register('live_url')} placeholder="https://example.com" />
                  <p className="text-[10px] text-muted-foreground">
                    Mostrato anche nel banner "verifica stato attuale" se &gt;1 anno fa.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">URL repository</Label>
                  <Input {...form.register('repo_url')} placeholder="https://github.com/..." />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Ordine visualizzazione</Label>
                <Input type="number" {...form.register('display_order', { valueAsNumber: true })} className="w-24" />
              </div>

              {/* Link extraction from brief markdown — pure client-side regex.
                  Each URL is clickable (apri in nuova tab) e ha "Usa come Live URL". */}
              <div className="pt-3 border-t border-muted-foreground/15">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div>
                    <h4 className="text-xs font-semibold flex items-center gap-1.5">
                      <LinkIcon className="h-3.5 w-3.5" /> Link nel brief
                    </h4>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      URL trovati nel campo brief (estrazione automatica).
                    </p>
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {extractedLinks.length} trovato{extractedLinks.length === 1 ? '' : 'i'}
                  </span>
                </div>
                {extractedLinks.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">
                    Nessun URL nel brief.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {extractedLinks.map((url) => (
                      <li key={url} className="flex items-center gap-2 text-xs">
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 truncate text-primary hover:underline inline-flex items-center gap-1"
                        >
                          <ExternalLink className="h-3 w-3 shrink-0" />
                          <span className="truncate">{url}</span>
                        </a>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => form.setValue('live_url', url, { shouldDirty: true })}
                          title="Imposta come URL sito live"
                        >
                          Usa come Live URL
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </form>

      {/* i18n EN translations panel — separato dalla form principale.
          Disponibile solo dopo il primo save (richiede project ID DB). */}
      {!isNew && id ? (
        <div className="mt-12 border-t border-muted-foreground/20 pt-8">
          <TranslationsPanelEN
            projectId={id}
            itValues={{
              title: form.watch('title'),
              description: form.watch('description'),
              brief: form.watch('brief'),
              outcome: form.watch('outcome'),
              seo_title: form.watch('seo_title'),
              seo_description: form.watch('seo_description'),
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
