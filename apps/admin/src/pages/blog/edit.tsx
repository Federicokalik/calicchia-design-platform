import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowLeft, ImageIcon, Loader2, Sparkles, Save } from 'lucide-react';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ImageUpload } from '@/components/ui/image-upload';
import { RichEditor } from '@/components/ui/rich-editor';
import { apiFetch } from '@/lib/api';
import { TranslationsPanelEN } from './TranslationsPanelEN';

const postSchema = z.object({
  title: z.string().min(1, 'Titolo richiesto'),
  slug: z.string().min(1, 'Slug richiesto'),
  content: z.string().min(1, 'Contenuto richiesto'),
  excerpt: z.string().optional(),
  cover_image: z.string().url().optional().or(z.literal('')),
  category: z.string().optional(),
  tags: z.string().optional(),
  is_published: z.boolean().default(false),
  allow_comments: z.boolean().default(true),
});

type PostFormData = z.infer<typeof postSchema>;

export default function BlogEditPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;

  const { data: post, isLoading } = useQuery({
    queryKey: ['post', id],
    queryFn: async () => {
      if (!id) return null;
      const data = await apiFetch(`/api/blog/posts/${id}`) as { post: Record<string, unknown> };
      return data.post;
    },
    enabled: !!id,
  });

  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<PostFormData>({
    resolver: zodResolver(postSchema),
    defaultValues: { is_published: false, allow_comments: true },
  });

  useEffect(() => {
    if (post) {
      reset({
        ...(post as PostFormData),
        tags: Array.isArray(post.tags) ? (post.tags as string[]).join(', ') : '',
      });
    }
  }, [post, reset]);

  const title = watch('title');
  useEffect(() => {
    if (isNew && title) {
      const slug = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
      setValue('slug', slug);
    }
  }, [title, isNew, setValue]);

  const saveMutation = useMutation({
    mutationFn: async (data: PostFormData) => {
      const content = data.content;
      const wordCount = content.trim().split(/\s+/).length;
      const reading_time = Math.ceil(wordCount / 200);

      const postData = {
        ...data,
        tags: data.tags?.split(',').map((t) => t.trim()).filter(Boolean) || [],
        cover_image: data.cover_image || null,
        reading_time,
        published_at: data.is_published ? new Date().toISOString() : null,
      };

      if (isNew) {
        await apiFetch('/api/blog/posts', { method: 'POST', body: JSON.stringify(postData) });
      } else {
        await apiFetch(`/api/blog/posts/${id}`, { method: 'PUT', body: JSON.stringify(postData) });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      toast.success(isNew ? 'Articolo creato' : 'Articolo aggiornato');
      navigate('/blog');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Errore');
    },
  });

  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isGeneratingTags, setIsGeneratingTags] = useState(false);
  const [isGeneratingCategory, setIsGeneratingCategory] = useState(false);

  const generateTags = async () => {
    if (!id) return;
    setIsGeneratingTags(true);
    try {
      const data = await apiFetch(`/api/blog/${id}/generate-tags`, {
        method: 'POST',
        body: JSON.stringify({}),
      }) as { tags: string[] | string };
      const { tags } = data;
      setValue('tags', Array.isArray(tags) ? tags.join(', ') : tags);
      toast.success('Tag generati');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore generazione tag');
    } finally {
      setIsGeneratingTags(false);
    }
  };

  const generateCategory = async () => {
    if (!id) return;
    setIsGeneratingCategory(true);
    try {
      const data = await apiFetch(`/api/blog/${id}/generate-category`, {
        method: 'POST',
        body: JSON.stringify({}),
      }) as { category: string };
      const { category } = data;
      setValue('category', category);
      toast.success('Categoria generata');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore generazione categoria');
    } finally {
      setIsGeneratingCategory(false);
    }
  };

  const regenerateCover = async () => {
    if (!id) return;
    setIsRegenerating(true);
    try {
      const data = await apiFetch(`/api/blog/${id}/regenerate-cover`, {
        method: 'POST',
        body: JSON.stringify({ provider: 'zimage', model: 'z-image' }),
      }) as { coverImage: { url: string } };
      const { coverImage } = data;
      setValue('cover_image', coverImage.url);
      toast.success('Copertina rigenerata');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore rigenerazione');
    } finally {
      setIsRegenerating(false);
    }
  };

  const topbarActions = useMemo(() => (
    <Button type="submit" form="blog-form" size="sm" disabled={saveMutation.isPending}>
      {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
      {isNew ? 'Pubblica' : 'Salva'}
    </Button>
  ), [saveMutation.isPending, isNew]);

  useTopbar({
    title: isNew ? 'Nuovo Articolo' : 'Modifica Articolo',
    actions: topbarActions,
  });

  if (!isNew && isLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('/blog')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </div>

      <form id="blog-form" onSubmit={handleSubmit((data) => saveMutation.mutate(data))}>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader><CardTitle>Contenuto</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Titolo *</Label>
                  <Input id="title" {...register('title')} />
                  {errors.title && <p className="text-sm text-destructive">{errors.title.message}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="slug">Slug *</Label>
                  <Input id="slug" {...register('slug')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="excerpt">Riassunto</Label>
                  <Input id="excerpt" {...register('excerpt')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="content">Contenuto *</Label>
                  <RichEditor
                    value={watch('content') || ''}
                    onChange={(value) => setValue('content', value || '', { shouldValidate: true, shouldDirty: true })}
                    minHeight="450px"
                    placeholder="Scrivi, incolla testo plain o Markdown generato dall'AI..."
                  />
                  {errors.content && <p className="text-sm text-destructive">{errors.content.message}</p>}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle>Pubblicazione</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="is_published" className="h-4 w-4" {...register('is_published')} />
                  <Label htmlFor="is_published">Pubblicato</Label>
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="allow_comments" className="h-4 w-4" {...register('allow_comments')} />
                  <Label htmlFor="allow_comments">Consenti commenti</Label>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Metadata</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Immagine Cover</Label>
                  <ImageUpload
                    value={watch('cover_image') || ''}
                    onChange={(url) => setValue('cover_image', url)}
                    folder="blog"
                    aspectRatio="video"
                  />
                  {!isNew && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full gap-2"
                      disabled={isRegenerating}
                      onClick={regenerateCover}
                    >
                      {isRegenerating
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generazione...</>
                        : <><ImageIcon className="h-3.5 w-3.5" /> Rigenera con AI</>
                      }
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="category">Categoria</Label>
                  <div className="flex gap-2">
                    <Input id="category" {...register('category')} />
                    {!isNew && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="shrink-0"
                        disabled={isGeneratingCategory}
                        onClick={generateCategory}
                        title="Genera categoria con AI"
                      >
                        {isGeneratingCategory
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Sparkles className="h-3.5 w-3.5" />
                        }
                      </Button>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tags">Tags (separati da virgola)</Label>
                  <div className="flex gap-2">
                    <Input id="tags" placeholder="react, typescript" {...register('tags')} />
                    {!isNew && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="shrink-0"
                        disabled={isGeneratingTags}
                        onClick={generateTags}
                        title="Genera tag con AI"
                      >
                        {isGeneratingTags
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Sparkles className="h-3.5 w-3.5" />
                        }
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
            <Button type="submit" className="w-full" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
            </Button>
          </div>
        </div>
      </form>

      {/* i18n EN translations panel — pattern identico a portfolio.
          Disponibile solo dopo il primo save (richiede post ID DB). */}
      {!isNew && id ? (
        <div className="mt-12 border-t border-muted-foreground/20 pt-8">
          <TranslationsPanelEN
            postId={id}
            itValues={{
              title: watch('title'),
              excerpt: watch('excerpt'),
              content: watch('content'),
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

export { BlogEditPage };
