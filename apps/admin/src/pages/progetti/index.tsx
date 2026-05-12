import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  GanttChart as GanttIcon, Kanban, List, Plus, Search, Filter,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { useTopbar } from '@/hooks/use-topbar';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { GanttChart } from '@/components/projects/gantt-chart';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { LoadingState } from '@/components/shared/loading-state';
import type { ClientProjectView, ProjectStatus } from '@/types/projects';
import { PROJECT_STATUS_CONFIG, PROJECT_TYPE_LABELS } from '@/types/projects';

type ViewMode = 'gantt' | 'kanban' | 'list';

const VIEW_ICONS: Record<ViewMode, typeof GanttIcon> = {
  gantt: GanttIcon,
  kanban: Kanban,
  list: List,
};

const KANBAN_COLUMNS: ProjectStatus[] = ['draft', 'proposal', 'approved', 'in_progress', 'review', 'completed'];

export default function ProgettiPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<ViewMode>('gantt');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ name: '', customer_id: '', project_type: 'website' });

  const { data, isLoading } = useQuery({
    queryKey: ['client-projects', search, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      return apiFetch(`/api/client-projects?${params}`);
    },
  });

  const { data: customersData } = useQuery({
    queryKey: ['customers-select'],
    queryFn: () => apiFetch('/api/customers?limit=100'),
  });

  const createMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      apiFetch('/api/client-projects', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['client-projects'] });
      setShowNew(false);
      setNewForm({ name: '', customer_id: '', project_type: 'website' });
      toast.success('Progetto creato');
      if (res?.project?.id) navigate(`/progetti/${res.project.id}`);
    },
    onError: () => toast.error('Errore nella creazione'),
  });

  const projects: ClientProjectView[] = data?.projects || [];
  const stats = data?.stats || { total: 0, in_progress: 0, completed: 0, overdue: 0 };
  const customers = customersData?.customers || [];

  const topbarActions = useMemo(() => (
    <Button onClick={() => setShowNew(true)} size="sm">
      <Plus className="h-4 w-4 mr-1.5" />
      Nuovo Progetto
    </Button>
  ), []);

  useTopbar({
    title: 'Progetti',
    subtitle: `${stats.total} progetti · ${stats.in_progress} in corso · ${stats.overdue} in ritardo`,
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Cerca progetto..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <Filter className="h-3.5 w-3.5 mr-1.5" />
            <SelectValue placeholder="Stato" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti</SelectItem>
            {Object.entries(PROJECT_STATUS_CONFIG).map(([key, cfg]) => (
              <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* View toggle */}
        <div className="flex gap-1 rounded-lg border p-0.5">
          {(Object.keys(VIEW_ICONS) as ViewMode[]).map((v) => {
            const Icon = VIEW_ICONS[v];
            return (
              <Button
                key={v}
                variant={view === v ? 'default' : 'ghost'}
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setView(v)}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <LoadingState />
      ) : projects.length === 0 ? (
        <EmptyState title="Nessun progetto" description="Crea il primo progetto o converti un lead dalla pipeline" />
      ) : (
        <>
          {/* Gantt View */}
          {view === 'gantt' && <GanttChart projects={projects} />}

          {/* Kanban View */}
          {view === 'kanban' && (
            <div className="flex gap-3 overflow-x-auto pb-4">
              {KANBAN_COLUMNS.map((status) => {
                const cfg = PROJECT_STATUS_CONFIG[status];
                const colProjects = projects.filter((p) => p.status === status);
                return (
                  <div key={status} className="flex flex-col rounded-lg border bg-muted/30 min-w-[260px] w-[260px]">
                    <div className={cn('flex items-center gap-2 px-3 py-2 border-b rounded-t-lg', cfg.color.replace('text-', 'bg-').replace('-700', '-100'))}>
                      <span className={cn('text-sm font-semibold', cfg.color)}>{cfg.label}</span>
                      <span className="rounded-full bg-background/80 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{colProjects.length}</span>
                    </div>
                    <div className="flex-1 p-2 space-y-2 max-h-[calc(100vh-320px)] overflow-y-auto scrollbar-thin">
                      {colProjects.map((p) => (
                        <div
                          key={p.id}
                          className="rounded-lg border bg-card p-3 shadow-sm hover:shadow-md cursor-pointer transition-shadow"
                          onClick={() => navigate(`/progetti/${p.id}`)}
                        >
                          <p className="text-sm font-medium truncate">{p.name}</p>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{p.customer_name || 'Nessun cliente'}</p>
                          <div className="flex items-center gap-2 mt-2">
                            <Progress value={p.progress_percentage} className="h-1.5 flex-1" />
                            <span className="text-[10px] text-muted-foreground">{p.progress_percentage}%</span>
                          </div>
                        </div>
                      ))}
                      {colProjects.length === 0 && (
                        <div className="py-6 text-center text-xs text-muted-foreground">Nessun progetto</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* List View */}
          {view === 'list' && (
            <div className="rounded-lg border bg-card overflow-hidden">
              <div className="hidden sm:grid grid-cols-[1fr_1fr_120px_100px_80px] gap-4 px-4 py-2.5 border-b bg-muted/50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <span>Progetto</span>
                <span>Cliente</span>
                <span>Progresso</span>
                <span>Stato</span>
                <span></span>
              </div>
              {projects.map((p) => {
                const cfg = PROJECT_STATUS_CONFIG[p.status];
                return (
                  <div
                    key={p.id}
                    className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_120px_100px_80px] gap-2 sm:gap-4 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors items-center"
                    onClick={() => navigate(`/progetti/${p.id}`)}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{PROJECT_TYPE_LABELS[p.project_type] || p.project_type}</p>
                    </div>
                    <p className="text-sm text-muted-foreground truncate">{p.customer_name || '—'}</p>
                    <div className="flex items-center gap-2">
                      <Progress value={p.progress_percentage} className="h-1.5 flex-1" />
                      <span className="text-xs text-muted-foreground w-8 text-right">{p.progress_percentage}%</span>
                    </div>
                    <StatusBadge label={cfg?.label || p.status} color={cfg?.color || ''} bgColor="" />
                    <span className="hidden sm:block text-muted-foreground text-xs text-right">→</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* New project dialog */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Nuovo Progetto</DialogTitle></DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!newForm.name.trim()) return;
              createMutation.mutate({
                name: newForm.name.trim(),
                customer_id: newForm.customer_id || null,
                project_type: newForm.project_type,
                status: 'draft',
                priority: 5,
              });
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label>Nome progetto *</Label>
              <Input value={newForm.name} onChange={(e) => setNewForm({ ...newForm, name: e.target.value })} autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Cliente</Label>
              <Select value={newForm.customer_id} onValueChange={(v) => setNewForm({ ...newForm, customer_id: v })}>
                <SelectTrigger><SelectValue placeholder="Seleziona cliente..." /></SelectTrigger>
                <SelectContent>
                  {customers.map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>{c.contact_name}{c.company_name ? ` (${c.company_name})` : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select value={newForm.project_type} onValueChange={(v) => setNewForm({ ...newForm, project_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PROJECT_TYPE_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNew(false)}>Annulla</Button>
              <Button type="submit" disabled={!newForm.name.trim() || createMutation.isPending}>Crea</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
