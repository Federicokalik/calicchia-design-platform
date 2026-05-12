import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectTask, TaskStatus } from '@/types/projects';
import { TASK_STATUS_CONFIG } from '@/types/projects';
import { TaskCard } from './task-card';
import { TaskQuickAdd } from './task-quick-add';
import { useState } from 'react';

interface KanbanColumnProps {
  status: TaskStatus;
  tasks: ProjectTask[];
  onTaskClick: (task: ProjectTask) => void;
  onQuickAdd: (title: string, status: TaskStatus) => void;
  showProject?: boolean;
}

export function KanbanColumn({ status, tasks, onTaskClick, onQuickAdd, showProject }: KanbanColumnProps) {
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const config = TASK_STATUS_CONFIG[status];

  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-muted/30 min-w-[280px] w-[280px] max-h-[calc(100vh-220px)]',
        isOver && 'ring-2 ring-primary/30 bg-primary/5',
      )}
    >
      {/* Column header */}
      <div className={cn('flex items-center justify-between px-3 py-2.5 border-b rounded-t-lg', config.bgColor)}>
        <div className="flex items-center gap-2">
          <span className={cn('text-sm font-semibold', config.color)}>{config.label}</span>
          <span className="rounded-full bg-background/80 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {tasks.length}
          </span>
        </div>
        <button
          onClick={() => setShowQuickAdd(true)}
          className="rounded p-1 hover:bg-background/50 text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Tasks list */}
      <div ref={setNodeRef} className="flex-1 overflow-y-auto p-2 space-y-2 scrollbar-thin">
        <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              onClick={onTaskClick}
              showProject={showProject}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 && !showQuickAdd && (
          <div className="py-8 text-center text-xs text-muted-foreground">
            Trascina qui un task
          </div>
        )}

        {/* Quick add */}
        {showQuickAdd && (
          <TaskQuickAdd
            onAdd={(title) => {
              onQuickAdd(title, status);
              setShowQuickAdd(false);
            }}
            onCancel={() => setShowQuickAdd(false)}
          />
        )}
      </div>
    </div>
  );
}
