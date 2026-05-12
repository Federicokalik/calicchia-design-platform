import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';

interface PortfolioProject {
  id: string;
  title: string;
  excerpt?: string;
  description?: string;
  cover_image?: string;
  is_published: boolean;
}

export default function PortfolioPage() {
  const queryClient = useQueryClient();

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['portfolio-projects'],
    queryFn: async () => {
      const res = await apiFetch('/api/projects');
      return res.projects as PortfolioProject[];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/projects/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio-projects'] });
      toast.success('Progetto eliminato');
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/projects/${id}/publish`, { method: 'PATCH' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio-projects'] });
      toast.success('Stato aggiornato');
    },
  });

  const topbarActions = useMemo(() => (
    <Button asChild size="sm">
      <Link to="/portfolio/new">
        <Plus className="h-4 w-4 mr-1.5" />
        Nuovo Progetto
      </Link>
    </Button>
  ), []);

  useTopbar({
    title: 'Portfolio',
    subtitle: `${projects.length} progetti showcase`,
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-lg border bg-card overflow-hidden">
              <div className="h-40 animate-pulse bg-muted" />
              <div className="p-4 space-y-2">
                <div className="h-4 w-2/3 animate-pulse bg-muted rounded" />
                <div className="h-3 w-full animate-pulse bg-muted rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState title="Nessun progetto" description="Crea il primo progetto per il portfolio">
          <Button asChild size="sm">
            <Link to="/portfolio/new">Crea progetto</Link>
          </Button>
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <div key={project.id} className="rounded-lg border bg-card overflow-hidden group hover:shadow-md transition-shadow">
              {project.cover_image ? (
                <img src={project.cover_image} alt={project.title} className="h-40 w-full object-cover" />
              ) : (
                <div className="h-40 bg-muted flex items-center justify-center">
                  <span className="text-3xl text-muted-foreground/30">📷</span>
                </div>
              )}
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold truncate">{project.title}</h3>
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    project.is_published
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  }`}>
                    {project.is_published ? 'Pubblicato' : 'Bozza'}
                  </span>
                </div>
                {(project.excerpt || project.description) && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                    {project.excerpt || project.description}
                  </p>
                )}
                <div className="flex gap-1.5 mt-3">
                  <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
                    <Link to={`/portfolio/${project.id}`}>
                      <Pencil className="h-3 w-3 mr-1" /> Modifica
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => toggleMutation.mutate(project.id)}>
                    {project.is_published ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => { if (confirm('Eliminare?')) deleteMutation.mutate(project.id); }}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
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
