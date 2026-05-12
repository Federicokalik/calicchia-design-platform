import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { TaskDetailPanel } from '@/components/kanban/task-detail-panel';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import type { ProjectTask, ProjectMilestone, TimeEntry, ProjectComment } from '@/types/projects';

interface TaskDetailDrawerProps {
  taskId: string | null;
  tasks: ProjectTask[];
  milestones: ProjectMilestone[];
  projectId: string;
  onClose: () => void;
  onAfterMutate?: () => void;
}

export function TaskDetailDrawer({
  taskId,
  tasks,
  milestones,
  projectId,
  onClose,
  onAfterMutate,
}: TaskDetailDrawerProps) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const open = !!taskId;
  const task = taskId ? tasks.find((t) => t.id === taskId) ?? null : null;

  // Close if taskId not in tasks list (e.g. after delete)
  useEffect(() => {
    if (taskId && !task) onClose();
  }, [taskId, task, onClose]);

  // Time entries for this task
  const { data: timeData } = useQuery<{ entries: TimeEntry[] }>({
    queryKey: ['time-entries', 'task', taskId],
    queryFn: () => apiFetch(`/api/time-entries?task_id=${taskId}`),
    enabled: !!taskId,
  });
  const timeEntries = timeData?.entries ?? [];

  // Active timer (per user)
  const { data: timerData } = useQuery<{ entry: TimeEntry | null }>({
    queryKey: ['active-timer', user?.id],
    queryFn: () => apiFetch(`/api/time-entries/timer/active?user_id=${user?.id}`),
    enabled: open && !!user?.id,
    refetchInterval: open ? 30000 : false,
  });
  const activeTimer = timerData?.entry ?? null;

  // Comments
  const { data: commentsData } = useQuery<{ comments: ProjectComment[] }>({
    queryKey: ['project-comments', 'task', taskId],
    queryFn: () => apiFetch(`/api/project-comments?task_id=${taskId}`),
    enabled: !!taskId,
  });
  const comments = commentsData?.comments ?? [];

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
    queryClient.invalidateQueries({ queryKey: ['time-entries'] });
    queryClient.invalidateQueries({ queryKey: ['active-timer'] });
    queryClient.invalidateQueries({ queryKey: ['project-comments'] });
    onAfterMutate?.();
  };

  const updateMutation = useMutation({
    mutationFn: async (patch: Partial<ProjectTask>) =>
      apiFetch(`/api/project-tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: () => {
      invalidateAll();
      toast.success('Task aggiornato');
    },
    onError: () => toast.error('Errore durante l\'aggiornamento'),
  });

  const deleteMutation = useMutation({
    mutationFn: async () =>
      apiFetch(`/api/project-tasks/${taskId}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateAll();
      toast.success('Task eliminato');
      onClose();
    },
    onError: () => toast.error('Errore durante l\'eliminazione'),
  });

  const startTimerMutation = useMutation({
    mutationFn: async (description?: string) =>
      apiFetch('/api/time-entries/timer/start', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, task_id: taskId, user_id: user?.id, description }),
      }),
    onSuccess: () => invalidateAll(),
  });

  const stopTimerMutation = useMutation({
    mutationFn: async () =>
      apiFetch('/api/time-entries/timer/stop', {
        method: 'POST',
        body: JSON.stringify({ user_id: user?.id }),
      }),
    onSuccess: () => invalidateAll(),
  });

  const addTimeEntryMutation = useMutation({
    mutationFn: async (entry: { start_time: string; end_time: string; description: string; is_billable: boolean }) =>
      apiFetch('/api/time-entries', {
        method: 'POST',
        body: JSON.stringify({ ...entry, project_id: projectId, task_id: taskId, user_id: user?.id }),
      }),
    onSuccess: () => {
      invalidateAll();
      toast.success('Tempo registrato');
    },
  });

  const deleteTimeEntryMutation = useMutation({
    mutationFn: async (id: string) =>
      apiFetch(`/api/time-entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateAll(),
  });

  const addCommentMutation = useMutation({
    mutationFn: async ({ content, isInternal }: { content: string; isInternal: boolean }) =>
      apiFetch('/api/project-comments', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          task_id: taskId,
          user_id: user?.id,
          content,
          is_internal: isInternal,
        }),
      }),
    onSuccess: () => invalidateAll(),
  });

  const deleteCommentMutation = useMutation({
    mutationFn: async (id: string) =>
      apiFetch(`/api/project-comments/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateAll(),
  });

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl p-0 overflow-hidden flex flex-col"
      >
        {task && user ? (
          <TaskDetailPanel
            task={task}
            milestones={milestones}
            timeEntries={timeEntries}
            comments={comments}
            activeTimer={activeTimer}
            currentUserId={user.id}
            onClose={onClose}
            onUpdate={(patch) => updateMutation.mutate(patch)}
            onDelete={() => deleteMutation.mutate()}
            onStartTimer={(description) => startTimerMutation.mutate(description)}
            onStopTimer={() => stopTimerMutation.mutate()}
            onAddTimeEntry={(entry) => addTimeEntryMutation.mutate(entry)}
            onDeleteTimeEntry={(id) => deleteTimeEntryMutation.mutate(id)}
            onAddComment={(content, isInternal) => addCommentMutation.mutate({ content, isInternal })}
            onDeleteComment={(id) => deleteCommentMutation.mutate(id)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
