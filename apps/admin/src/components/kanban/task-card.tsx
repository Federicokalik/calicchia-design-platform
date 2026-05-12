import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Calendar, CheckSquare, Clock, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectTask } from '@/types/projects';
import { REQUEST_CATEGORY_CONFIG, SOURCE_CONFIG } from '@/types/projects';
import type { RequestCategory } from '@/types/projects';

interface TaskCardProps {
  task: ProjectTask;
  onClick: (task: ProjectTask) => void;
  showProject?: boolean;
}

const priorityColors: Record<string, string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  low: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
};

function getPriorityLabel(priority: number): { label: string; key: string } {
  if (priority >= 8) return { label: 'Alta', key: 'high' };
  if (priority >= 4) return { label: 'Media', key: 'medium' };
  return { label: 'Bassa', key: 'low' };
}

export function TaskCard({ task, onClick, showProject }: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1)',
  };

  const priority = getPriorityLabel(task.priority);
  const checklistDone = task.checklist?.filter(c => c.done).length || 0;
  const checklistTotal = task.checklist?.length || 0;
  const isOverdue = task.due_date && new Date(task.due_date) < new Date() && task.status !== 'done';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group rounded-lg border bg-card p-3 shadow-sm transition-[box-shadow,border-color,transform] duration-300 hover:shadow-md cursor-pointer',
        isDragging && 'z-50 shadow-2xl shadow-primary/15 ring-2 ring-primary/30 scale-[1.04] rotate-[1deg] border-primary/40 opacity-95',
      )}
      onClick={() => onClick(task)}
    >
      <div className="flex items-start gap-2">
        <button
          className="mt-0.5 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity touch-none"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </button>
        <div className="flex-1 min-w-0">
          {/* Project name (global view) */}
          {showProject && task.project_name && (
            <p className="text-xs text-muted-foreground mb-1 truncate">
              {task.customer_name && <span>{task.customer_name} &middot; </span>}
              {task.project_name}
            </p>
          )}

          {/* Title */}
          <p className="text-sm font-medium leading-tight">{task.title}</p>

          {/* Tags row */}
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {/* Priority */}
            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', priorityColors[priority.key])}>
              {priority.label}
            </span>

            {/* Source badge (only for client tasks) */}
            {task.source === 'client' && (
              <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', SOURCE_CONFIG.client.bgColor, SOURCE_CONFIG.client.color)}>
                {SOURCE_CONFIG.client.label}
              </span>
            )}

            {/* Request category */}
            {task.request_category && REQUEST_CATEGORY_CONFIG[task.request_category as RequestCategory] && (
              <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', REQUEST_CATEGORY_CONFIG[task.request_category as RequestCategory].bgColor, REQUEST_CATEGORY_CONFIG[task.request_category as RequestCategory].color)}>
                {REQUEST_CATEGORY_CONFIG[task.request_category as RequestCategory].label}
              </span>
            )}

            {/* Milestone */}
            {task.milestone_name && (
              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                {task.milestone_name}
              </span>
            )}
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
            {/* Due date */}
            {task.due_date && (
              <span className={cn('flex items-center gap-1', isOverdue && 'text-red-500 font-medium')}>
                <Calendar className="h-3 w-3" />
                {new Date(task.due_date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
              </span>
            )}

            {/* Checklist */}
            {checklistTotal > 0 && (
              <span className="flex items-center gap-1">
                <CheckSquare className="h-3 w-3" />
                {checklistDone}/{checklistTotal}
              </span>
            )}

            {/* Hours */}
            {task.estimated_hours && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {task.actual_hours || 0}/{task.estimated_hours}h
              </span>
            )}

            {/* Assignee */}
            {task.assignee_email && (
              <span className="flex items-center gap-1 ml-auto">
                <div className="h-5 w-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold">
                  {task.assignee_email[0].toUpperCase()}
                </div>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
