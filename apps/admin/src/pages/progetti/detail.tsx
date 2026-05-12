import { useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
// Inline vertical-only modifier (avoids @dnd-kit/modifiers dependency)
const restrictToVerticalAxis = ({ transform }: { transform: { x: number; y: number; scaleX: number; scaleY: number } }) => ({
  ...transform, x: 0,
});
import {
  ArrowLeft, CheckSquare, Milestone, StickyNote,
  Plus, Calendar, Clock, User, LayoutList, X, GripVertical,
  Activity, Send, Languages,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { EntityView } from '@/components/entity-view';
import { buildTasksConfig } from '@/components/tasks/task-entity-config';
import { TaskDetailDrawer } from '@/components/tasks/task-detail-drawer';
import { useTopbar } from '@/hooks/use-topbar';
import { useSetAiEntityContext } from '@/hooks/use-ai-entity-context';
import { apiFetch } from '@/lib/api';
import { LoadingState } from '@/components/shared/loading-state';
import type { ProjectTask, ProjectMilestone, TaskStatus } from '@/types/projects';
import { PROJECT_STATUS_CONFIG } from '@/types/projects';

function SortablePipelineStep({ id, step, index, currentStep, onRemove }: {
  id: number; step: string; index: number; currentStep: number; onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 250ms cubic-bezier(0.34, 1.56, 0.64, 1)',
    zIndex: isDragging ? 50 : undefined,
    position: 'relative' as const,
  };

  return (
    <div ref={setNodeRef} style={style} className={`flex items-center gap-2 group ${isDragging ? 'opacity-90' : ''}`}>
      <button
        {...attributes}
        {...listeners}
        className={`cursor-grab active:cursor-grabbing p-1 rounded transition-colors ${isDragging ? 'text-orange-500' : 'text-muted-foreground/40 hover:text-muted-foreground'}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className={`flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-all duration-200 ${
        isDragging ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/30 shadow-lg shadow-orange-500/10 scale-[1.02]' :
        index === currentStep ? 'border-orange-300 bg-orange-50 dark:bg-orange-950/20' : ''
      }`}>
        <span className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
          index < currentStep ? 'bg-emerald-500 text-white' :
          index === currentStep ? 'bg-orange-500 text-white' :
          'bg-muted text-muted-foreground'
        }`}>{index + 1}</span>
        <span className="flex-1">{step}</span>
        {index === currentStep && <Badge className="text-[9px] h-4">Attuale</Badge>}
      </div>
      <Button
        variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100"
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export default function ProgettoDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  const openTask = (taskId: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (taskId) next.set('task', taskId);
      else next.delete('task');
      return next;
    }, { replace: true });
  };

  const { data, isLoading } = useQuery({
    queryKey: ['project-detail', id],
    queryFn: () => apiFetch(`/api/client-projects/${id}`),
    enabled: !!id,
  });

  const resData = data as any;
  const project = resData?.project;
  const tasks: ProjectTask[] = resData?.tasks || [];
  const milestones: ProjectMilestone[] = resData?.milestones || [];

  useTopbar({ title: project?.name || 'Dettaglio Progetto', subtitle: project?.customer_name || '' });
  useSetAiEntityContext(
    project
      ? {
          kind: 'progetto',
          id: project.id,
          title: project.name,
          summary: `stato ${project.status}${project.customer_name ? `, cliente ${project.customer_name}` : ''}${tasks.length ? `, ${tasks.length} task` : ''}`,
        }
      : null,
  );

  // Task mutations
  const reorderMutation = useMutation({
    mutationFn: async (payload: { id: string; sort_order: number; status?: string }[]) =>
      apiFetch('/api/project-tasks/reorder', { method: 'PATCH', body: JSON.stringify({ tasks: payload }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-detail', id] }),
  });

  const createTaskMutation = useMutation({
    mutationFn: async (data: { title: string; status: string }) =>
      apiFetch('/api/project-tasks', {
        method: 'POST',
        body: JSON.stringify({ ...data, project_id: id }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-detail', id] });
      toast.success('Task creato');
    },
  });

  const updateTaskMutation = useMutation({
    mutationFn: async ({ taskId, patch }: { taskId: string; patch: Partial<ProjectTask> }) =>
      apiFetch(`/api/project-tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-detail', id] }),
    onError: () => toast.error('Aggiornamento fallito'),
  });

  // Timeline
  const { data: timelineData } = useQuery({
    queryKey: ['project-timeline', id],
    queryFn: () => apiFetch(`/api/portal-admin/timeline/${id}`),
    enabled: !!id,
  });
  const timelineEvents = timelineData?.events || [];

  // Translations (bilingual portal content)
  const { data: translationsData } = useQuery<{
    it?: Record<string, string>;
    en?: Record<string, string>;
  }>({
    queryKey: ['project-translations', id],
    queryFn: () => apiFetch(`/api/portal-admin/translations/client_projects/${id}`),
    enabled: !!id,
  });
  const enT = translationsData?.en ?? {};

  const saveTranslationsMutation = useMutation({
    mutationFn: async (fields: Record<string, string | null>) =>
      apiFetch(`/api/portal-admin/translations/client_projects/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ locale: 'en', fields }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-translations', id] });
      toast.success('Traduzioni EN salvate');
    },
    onError: () => toast.error('Salvataggio traduzioni fallito'),
  });

  // Update project
  const updateProjectMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      apiFetch(`/api/client-projects/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-detail', id] });
      toast.success('Progetto aggiornato');
    },
  });

  // Add timeline event
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventType, setNewEventType] = useState('note');
  const addEventMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      apiFetch('/api/portal-admin/timeline-event', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-timeline', id] });
      setNewEventTitle('');
      toast.success('Evento aggiunto alla timeline');
    },
  });

  // Pipeline steps state
  const [newStep, setNewStep] = useState('');
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handlePipelineDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const steps = Array.isArray(project?.pipeline_steps) ? [...project.pipeline_steps] as string[] : [];
    const oldIndex = Number(active.id);
    const newIndex = Number(over.id);
    const reordered = arrayMove(steps, oldIndex, newIndex);
    // Adjust current_step if it moved
    let curStep = Number(project?.current_step || 0);
    if (curStep === oldIndex) curStep = newIndex;
    else if (oldIndex < curStep && newIndex >= curStep) curStep--;
    else if (oldIndex > curStep && newIndex <= curStep) curStep++;
    updateProjectMutation.mutate({ pipeline_steps: reordered, current_step: curStep });
  };

  if (isLoading) {
    return <LoadingState />;
  }

  if (!project) return <EmptyState title="Progetto non trovato" />;

  const statusCfg = PROJECT_STATUS_CONFIG[project.status as keyof typeof PROJECT_STATUS_CONFIG];
  const completedTasks = tasks.filter((t) => t.status === 'done').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/progetti')} className="mt-1">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight truncate">{project.name}</h1>
            {statusCfg && <StatusBadge {...statusCfg} bgColor={statusCfg.color.replace('text-', 'bg-').replace('-700', '-100')} />}
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-muted-foreground">
            {project.customer_name && (
              <span className="flex items-center gap-1">
                <User className="h-3.5 w-3.5" /> {project.customer_name}
              </span>
            )}
            {project.start_date && (
              <span className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {new Date(project.start_date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                {project.target_end_date && ` → ${new Date(project.target_end_date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`}
              </span>
            )}
            {project.estimated_hours && (
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" /> {project.actual_hours || 0}/{project.estimated_hours}h
              </span>
            )}
          </div>
          {/* Progress */}
          <div className="flex items-center gap-3 mt-3 max-w-md">
            <Progress value={project.progress_percentage} className="h-2 flex-1" />
            <span className="text-sm font-medium">{project.progress_percentage}%</span>
            <span className="text-xs text-muted-foreground">{completedTasks}/{tasks.length} task</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="tasks" className="space-y-4">
        <TabsList>
          <TabsTrigger value="tasks" className="gap-1.5">
            <CheckSquare className="h-3.5 w-3.5" />
            Tasks
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{tasks.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="milestones" className="gap-1.5">
            <Milestone className="h-3.5 w-3.5" />
            Milestone
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{milestones.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="portal" className="gap-1.5">
            <LayoutList className="h-3.5 w-3.5" />
            Portale
          </TabsTrigger>
          <TabsTrigger value="timeline" className="gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            Timeline
            {timelineEvents.length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{timelineEvents.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="notes" className="gap-1.5">
            <StickyNote className="h-3.5 w-3.5" />
            Note
          </TabsTrigger>
          <TabsTrigger value="translations" className="gap-1.5">
            <Languages className="h-3.5 w-3.5" />
            Traduzioni
            {Object.keys(enT).length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">EN</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Tasks — EntityView (list/board switchable) */}
        <TabsContent value="tasks">
          {tasks.length === 0 ? (
            <EmptyState title="Nessun task" description="Aggiungi il primo task per questo progetto" icon={CheckSquare}>
              <Button
                size="sm"
                onClick={() => createTaskMutation.mutate({ title: 'Nuovo task', status: 'todo' })}
              >
                <Plus className="h-4 w-4 mr-1.5" /> Aggiungi Task
              </Button>
            </EmptyState>
          ) : (
            <EntityView<ProjectTask>
              scope="tasks"
              config={buildTasksConfig({
                tasks,
                milestones,
                projectStart: project.start_date,
                projectEnd: project.target_end_date,
                onCreate: (title, ctx) =>
                  createTaskMutation.mutate({ title, status: (ctx.status as TaskStatus) || 'todo' }),
                onReorder: (payload) => reorderMutation.mutate(payload),
                onItemClick: (t) => openTask(t.id),
                onUpdate: (taskId, patch) => updateTaskMutation.mutate({ taskId, patch }),
              })}
            />
          )}
        </TabsContent>

        {/* Milestones */}
        <TabsContent value="milestones">
          {milestones.length === 0 ? (
            <EmptyState title="Nessuna milestone" description="Le milestone verranno aggiunte qui" icon={Milestone} />
          ) : (
            <div className="space-y-3">
              {milestones.map((m) => (
                <div key={m.id} className="rounded-lg border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{m.name}</p>
                      {m.description && <p className="text-xs text-muted-foreground mt-0.5">{m.description}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {m.due_date && (
                        <span className="text-xs text-muted-foreground">
                          {new Date(m.due_date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                        </span>
                      )}
                      <Badge variant="outline" className="text-xs">
                        {m.status === 'completed' ? 'Completata' : m.status === 'in_progress' ? 'In corso' : 'In attesa'}
                      </Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Portal — Pipeline Steps + Current Step */}
        <TabsContent value="portal">
          <div className="space-y-6">
            {/* Pipeline Steps Editor */}
            <div className="rounded-lg border bg-card p-6 space-y-4">
              <h3 className="text-sm font-semibold">Pipeline Steps</h3>
              <p className="text-xs text-muted-foreground">Fasi del progetto visibili al cliente nel portale.</p>

              {/* Current steps — sortable */}
              <DndContext
                sensors={dndSensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis]}
                onDragEnd={handlePipelineDragEnd}
              >
                <SortableContext
                  items={(Array.isArray(project.pipeline_steps) ? project.pipeline_steps : []).map((_: string, i: number) => i)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {(Array.isArray(project.pipeline_steps) ? project.pipeline_steps : []).map((step: string, i: number) => (
                      <SortablePipelineStep
                        key={`step-${i}`}
                        id={i}
                        step={step}
                        index={i}
                        currentStep={Number(project.current_step || 0)}
                        onRemove={() => {
                          const steps = [...(project.pipeline_steps as string[])];
                          steps.splice(i, 1);
                          const curStep = Math.min(Number(project.current_step || 0), Math.max(steps.length - 1, 0));
                          updateProjectMutation.mutate({ pipeline_steps: steps, current_step: curStep });
                        }}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              {/* Add step */}
              <div className="flex gap-2">
                <Input
                  placeholder="Nuova fase (es. Design, Sviluppo...)"
                  value={newStep}
                  onChange={(e) => setNewStep(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newStep.trim()) {
                      const steps = [...(Array.isArray(project.pipeline_steps) ? project.pipeline_steps : []), newStep.trim()];
                      updateProjectMutation.mutate({ pipeline_steps: steps });
                      setNewStep('');
                    }
                  }}
                  className="flex-1"
                />
                <Button
                  size="sm"
                  disabled={!newStep.trim()}
                  onClick={() => {
                    const steps = [...(Array.isArray(project.pipeline_steps) ? project.pipeline_steps : []), newStep.trim()];
                    updateProjectMutation.mutate({ pipeline_steps: steps });
                    setNewStep('');
                  }}
                >
                  <Plus className="h-4 w-4 mr-1" /> Aggiungi
                </Button>
              </div>
            </div>

            {/* Current Step Selector */}
            {Array.isArray(project.pipeline_steps) && project.pipeline_steps.length > 0 && (
              <div className="rounded-lg border bg-card p-6 space-y-3">
                <h3 className="text-sm font-semibold">Fase attuale</h3>
                <Select
                  value={String(project.current_step ?? 0)}
                  onValueChange={(val) => updateProjectMutation.mutate({ current_step: Number(val) })}
                >
                  <SelectTrigger className="w-full max-w-xs">
                    <SelectValue placeholder="Seleziona fase" />
                  </SelectTrigger>
                  <SelectContent>
                    {(project.pipeline_steps as string[]).map((step: string, i: number) => (
                      <SelectItem key={i} value={String(i)}>{i + 1}. {step}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Visibility */}
            <div className="rounded-lg border bg-card p-6 space-y-3">
              <h3 className="text-sm font-semibold">Visibilità portale</h3>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={project.visible_to_client ?? true}
                    onChange={(e) => updateProjectMutation.mutate({ visible_to_client: e.target.checked })}
                    className="rounded"
                  />
                  Visibile al cliente nel portale
                </label>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* Timeline */}
        <TabsContent value="timeline">
          <div className="space-y-4">
            {/* Add event */}
            <div className="rounded-lg border bg-card p-4">
              <div className="flex gap-2">
                <Select value={newEventType} onValueChange={setNewEventType}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="note">Nota</SelectItem>
                    <SelectItem value="status_change">Cambio stato</SelectItem>
                    <SelectItem value="message">Messaggio</SelectItem>
                    <SelectItem value="file_requested">Richiesta file</SelectItem>
                    <SelectItem value="deliverable_added">Deliverable</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Titolo evento..."
                  value={newEventTitle}
                  onChange={(e) => setNewEventTitle(e.target.value)}
                  className="flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newEventTitle.trim()) {
                      addEventMutation.mutate({
                        project_id: id,
                        customer_id: project.customer_id,
                        type: newEventType,
                        title: newEventTitle.trim(),
                      });
                    }
                  }}
                />
                <Button
                  size="icon"
                  disabled={!newEventTitle.trim() || addEventMutation.isPending}
                  onClick={() => {
                    if (newEventTitle.trim()) {
                      addEventMutation.mutate({
                        project_id: id,
                        customer_id: project.customer_id,
                        type: newEventType,
                        title: newEventTitle.trim(),
                      });
                    }
                  }}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Events list */}
            {timelineEvents.length === 0 ? (
              <EmptyState title="Nessun evento" description="Aggiungi il primo evento alla timeline del progetto" icon={Activity} />
            ) : (
              <div className="space-y-2">
                {timelineEvents.map((event: any) => (
                  <div key={event.id} className="rounded-lg border bg-card px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{event.title}</p>
                        {event.description && <p className="text-xs text-muted-foreground mt-0.5">{event.description}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="outline" className="text-[10px]">{event.type}</Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(event.created_at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Translations — bilingual portal content (EN) */}
        <TabsContent value="translations">
          <div className="rounded-lg border bg-card p-6 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold">Versione EN del progetto</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-xl">
                  Compila i campi qui sotto per mostrare il progetto in inglese ai clienti che hanno
                  il locale EN nel portal. Se vuoti, il portal EN mostra il valore italiano legacy.
                </p>
              </div>
            </div>

            <Tabs defaultValue="en" className="space-y-3">
              <TabsList>
                <TabsTrigger value="it" className="text-xs">IT (originale)</TabsTrigger>
                <TabsTrigger value="en" className="text-xs">EN (traduzione)</TabsTrigger>
              </TabsList>

              <TabsContent value="it" className="space-y-4">
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Nome</p>
                  <p className="text-sm">{project.name || '—'}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Descrizione</p>
                  <p className="text-sm whitespace-pre-wrap">{project.description || '—'}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Note cliente</p>
                  <p className="text-sm whitespace-pre-wrap">{project.client_notes || '—'}</p>
                </div>
              </TabsContent>

              <TabsContent value="en" className="space-y-4">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    saveTranslationsMutation.mutate({
                      name: String(fd.get('name') || ''),
                      description: String(fd.get('description') || ''),
                      client_notes: String(fd.get('client_notes') || ''),
                    });
                  }}
                  className="space-y-4"
                >
                  <div className="space-y-1.5">
                    <label htmlFor="t-name" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Name (EN)
                    </label>
                    <Input
                      id="t-name"
                      name="name"
                      defaultValue={enT.name ?? ''}
                      placeholder={project.name || 'Project name'}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="t-desc" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Description (EN)
                    </label>
                    <textarea
                      id="t-desc"
                      name="description"
                      defaultValue={enT.description ?? ''}
                      placeholder={project.description || 'Project description'}
                      className="w-full min-h-[100px] rounded-md border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="t-notes" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Client notes (EN)
                    </label>
                    <textarea
                      id="t-notes"
                      name="client_notes"
                      defaultValue={enT.client_notes ?? ''}
                      placeholder={project.client_notes || 'Notes visible to the client'}
                      className="w-full min-h-[120px] rounded-md border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={saveTranslationsMutation.isPending}>
                      {saveTranslationsMutation.isPending ? 'Salvataggio…' : 'Salva traduzioni EN'}
                    </Button>
                    <p className="text-xs text-muted-foreground self-center">
                      Campi vuoti → portal EN cade su IT (fallback).
                    </p>
                  </div>
                </form>
              </TabsContent>
            </Tabs>
          </div>
        </TabsContent>

        {/* Notes */}
        <TabsContent value="notes">
          <div className="rounded-lg border bg-card p-6">
            <p className="text-xs text-muted-foreground mb-3">Appunti interni per questo progetto.</p>
            <textarea
              className="w-full min-h-[200px] rounded-md border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Scrivi le tue note qui..."
              defaultValue={project.client_notes || ''}
              onBlur={(e) => {
                if (e.target.value !== (project.client_notes || '')) {
                  updateProjectMutation.mutate({ client_notes: e.target.value || null });
                }
              }}
            />
          </div>
        </TabsContent>
      </Tabs>

      <TaskDetailDrawer
        taskId={openTaskId}
        tasks={tasks}
        milestones={milestones}
        projectId={id!}
        onClose={() => openTask(null)}
      />
    </div>
  );
}
