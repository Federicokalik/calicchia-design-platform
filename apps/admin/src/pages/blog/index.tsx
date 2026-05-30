import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Pencil, Trash2, Eye, EyeOff, Sparkles, Loader2,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { useConfirm } from '@/hooks/use-confirm';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { RowContextMenu, type RowAction } from '@/components/ui/row-context-menu';
import { useTopbar } from '@/hooks/use-topbar';

const PAGE_SIZE = 25;

interface BlogPost {
  id: string;
  title: string;
  category: string | null;
  reading_time: number | null;
  is_published: boolean;
}

interface BlogListPayload {
  posts: BlogPost[];
  count: number;
}

export default function BlogPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  // Audit D-010: was loading every post in one shot. Added a status filter +
  // cursor-less pagination consuming the server's existing limit/offset/count
  // (routes/blog.ts already supports them — the admin just wasn't passing).
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft'>('all');
  const [page, setPage] = useState(0);

  const queryKey = ['posts', statusFilter, page] as const;

  const { data, isLoading } = useQuery<BlogListPayload>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (statusFilter === 'published') params.set('is_published', 'true');
      if (statusFilter === 'draft') params.set('is_published', 'false');
      return apiFetch(`/api/blog/posts?${params.toString()}`);
    },
  });
  const posts = data?.posts ?? [];
  const total = data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
    subtitle: `${total} articoli totali · pagina ${page + 1}/${totalPages}`,
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select
          value={statusFilter}
          onValueChange={(v) => { setStatusFilter(v as typeof statusFilter); setPage(0); }}
        >
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti</SelectItem>
            <SelectItem value="published">Solo pubblicati</SelectItem>
            <SelectItem value="draft">Solo bozze</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            disabled={page === 0 || isLoading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            aria-label="Pagina precedente"
            className="h-8 w-8"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {page + 1} / {totalPages}
          </span>
          <Button
            size="icon"
            variant="outline"
            disabled={page + 1 >= totalPages || isLoading}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Pagina successiva"
            className="h-8 w-8"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

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
      ) : posts.length > 0 ? (
        <div className="space-y-4">
          {posts.map((post) => {
            const actions: RowAction[] = [
              { label: 'Modifica', icon: Pencil, onClick: () => navigate(`/blog/${post.id}`) },
              {
                label: post.is_published ? 'Metti in bozza' : 'Pubblica',
                icon: post.is_published ? EyeOff : Eye,
                onClick: () => togglePublishMutation.mutate({ id: post.id, is_published: post.is_published }),
              },
              { divider: true },
              {
                label: 'Elimina',
                icon: Trash2,
                destructive: true,
                onClick: async () => { if (await confirm({ title: 'Eliminare questo articolo?', variant: 'destructive' })) deleteMutation.mutate(post.id); },
              },
            ];
            return (
            <RowContextMenu key={post.id} actions={actions}>
            <Card>
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
                    onClick={async () => {
                      if (await confirm({ title: 'Eliminare questo articolo?', variant: 'destructive' })) {
                        deleteMutation.mutate(post.id);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
            </RowContextMenu>
            );
          })}
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
