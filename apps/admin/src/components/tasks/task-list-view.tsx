import { useState } from 'react';
import { ChevronDown, ChevronRight, Flag, Calendar as CalendarIcon, User as UserIcon, Tag as TagIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ProjectTask } from '@/types/projects';
import { TASK_STATUS_CONFIG } from '@/types/projects';
import type { GroupByOption } from '@/components/entity-view/entity-view.types';
import { TaskQuickActions } from './task-quick-actions';

interface TaskListViewProps {
  tasks: ProjectTask[];
  groupedTasks?: Map<string, ProjectTask[]> | null;
  groupConfig?: GroupByOption<ProjectTask>;
  onItemClick?: (t: ProjectTask) => void;
  onUpdate?: (taskId: string, patch: Partial<ProjectTask>) => void;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: 'text-red-500',
  2: 'text-orange-500',
  3: 'text-amber-500',
  4: 'text-blue-500',
  5: 'text-slate-400',
};

function formatDate(raw: string | null): string {
  if (!raw) return '';
  const d = new Date(raw);
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

function isOverdue(raw: string | null): boolean {
  if (!raw) return false;
  return new Date(raw).getTime() < Date.now();
}

function TaskRow({
  task,
  onClick,
  onUpdate,
}: {
  task: ProjectTask;
  onClick?: (t: ProjectTask) => void;
  onUpdate?: (taskId: string, patch: Partial<ProjectTask>) => void;
}) {
  const status = TASK_STATUS_CONFIG[task.status];
  const overdue = isOverdue(task.due_date) && task.status !== 'done';

  return (
    <div
      className="group flex items-center gap-3 px-3 py-2 border-b border-border/60 hover:bg-muted/40 cursor-pointer transition-colors"
      onClick={() => onClick?.(task)}
    >
      {/* Status pill */}
      <Badge variant="outline" className={cn('h-5 text-[10px] font-medium shrink-0', status.bgColor, status.color, 'border-transparent')}>
        {status.label}
      </Badge>

      {/* Title */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-sm truncate">{task.title}</span>
        {task.checklist && task.checklist.length > 0 && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {task.checklist.filter((c) => c.done).length}/{task.checklist.length}
          </span>
        )}
      </div>

      {/* Tags */}
      {task.tags && task.tags.length > 0 && (
        <div className="hidden md:flex items-center gap-1 shrink-0">
          {task.tags.slice(0, 2).map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <TagIcon className="h-2.5 w-2.5" />
              {t}
            </span>
          ))}
          {task.tags.length > 2 && <span className="text-[10px] text-muted-foreground">+{task.tags.length - 2}</span>}
        </div>
      )}

      {/* Priority */}
      {task.priority > 0 && (
        <Flag className={cn('h-3.5 w-3.5 shrink-0', PRIORITY_COLORS[task.priority] || 'text-muted-foreground')} />
      )}

      {/* Assignee */}
      {task.assignee_email && (
        <div className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground shrink-0 max-w-[120px]">
          <UserIcon className="h-3 w-3" />
          <span className="truncate">{task.assignee_email.split('@')[0]}</span>
        </div>
      )}

      {/* Due date */}
      {task.due_date && (
        <div className={cn('flex items-center gap-1 text-xs shrink-0', overdue ? 'text-red-600' : 'text-muted-foreground')}>
          <CalendarIcon className="h-3 w-3" />
          {formatDate(task.due_date)}
        </div>
      )}

      {/* Quick actions (visible on hover) */}
      {onUpdate && <TaskQuickActions task={task} onUpdate={onUpdate} />}
    </div>
  );
}

function GroupSection({
  label,
  tasks,
  onItemClick,
  onUpdate,
  defaultOpen = true,
}: {
  label: string;
  tasks: ProjectTask[];
  onItemClick?: (t: ProjectTask) => void;
  onUpdate?: (taskId: string, patch: Partial<ProjectTask>) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:bg-muted/50 transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{label}</span>
        <span className="text-[10px] font-normal normal-case">({tasks.length})</span>
      </button>
      {open && tasks.map((t) => <TaskRow key={t.id} task={t} onClick={onItemClick} onUpdate={onUpdate} />)}
    </div>
  );
}

export function TaskListView({ tasks, groupedTasks, groupConfig, onItemClick, onUpdate }: TaskListViewProps) {
  if (groupedTasks) {
    return (
      <div className="rounded-md border bg-card overflow-hidden">
        {Array.from(groupedTasks.entries()).map(([key, list]) => {
          const label = groupConfig?.formatLabel ? groupConfig.formatLabel(key) : key;
          return (
            <GroupSection
              key={key}
              label={label === '__ungrouped__' ? 'Senza gruppo' : label}
              tasks={list}
              onItemClick={onItemClick}
              onUpdate={onUpdate}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-card overflow-hidden">
      {tasks.map((t) => <TaskRow key={t.id} task={t} onClick={onItemClick} onUpdate={onUpdate} />)}
    </div>
  );
}
