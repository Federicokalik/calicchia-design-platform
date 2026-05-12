import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Eye, EyeOff, Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useTopbar } from '@/hooks/use-topbar';

export default function BlogPage() {
  const queryClient = useQueryClient();

  const { data: posts, isLoading } = useQuery({
    queryKey: ['posts'],
    queryFn: async () => {
      const data = await apiFetch('/api/blog/posts');
      return data.posts || [];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/api/blog/posts/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      toast.success('Articolo eliminato');
    },
  });

  const togglePublishMutation = useMutation({
    mutationFn: async ({ id, is_published }: { id: string; is_published: boolean }) => {
      await apiFetch(`/api/blog/posts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          is_published: !is_published,
          published_at: !is_published ? new Date().toISOString() : null,
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      toast.success('Stato aggiornato');
    },
  });

  const generateRandomMutation = useMutation({
    mutationFn: async () => {
      return apiFetch('/api/blog/generate/random', {
        method: 'POST',
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      toast.success(`Articolo "${data.post.title}" generato!`);
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const topbarActions = useMemo(() => (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => generateRandomMutation.mutate()}
        disabled={generateRandomMutation.isPending}
      >
        {generateRandomMutation.isPending ? (
          <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Generazione...</>
        ) : (
          <><Sparkles className="h-3.5 w-3.5 mr-1.5" />Genera Ora</>
        )}
      </Button>
      <Button asChild size="sm">
        <Link to="/blog/new"><Plus className="h-4 w-4 mr-1.5" />Nuovo Articolo</Link>
      </Button>
    </>
  ), [generateRandomMutation.isPending]);

  useTopbar({
    title: 'Blog',
    subtitle: `${posts?.length || 0} articoli`,
    actions: topbarActions,
  });

  return (
    <div className="space-y-6">

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="h-20 animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : posts && posts.length > 0 ? (
        <div className="space-y-4">
          {posts.map((post: any) => (
            <Card key={post.id}>
              <CardContent className="flex items-center justify-between p-6">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold">{post.title}</h3>
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${
                        post.is_published
                          ? 'bg-green-100 text-green-700'
                          : 'bg-yellow-100 text-yellow-700'
                      }`}
                    >
                      {post.is_published ? 'Pubblicato' : 'Bozza'}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {post.category && <span className="mr-2">{post.category}</span>}
                    {post.reading_time && <span>{post.reading_time} min di lettura</span>}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/blog/${post.id}`}>
                      <Pencil className="h-4 w-4" />
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      togglePublishMutation.mutate({
                        id: post.id,
                        is_published: post.is_published,
                      })
                    }
                  >
                    {post.is_published ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (confirm('Eliminare questo articolo?')) {
                        deleteMutation.mutate(post.id);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">Nessun articolo trovato</p>
            <Button asChild>
              <Link to="/blog/new">Scrivi il primo articolo</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export { BlogPage };
