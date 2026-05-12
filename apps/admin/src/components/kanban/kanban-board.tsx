import { useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import type { ProjectTask, TaskStatus } from '@/types/projects';
import { KanbanColumn } from './kanban-column';
import { TaskCard } from './task-card';

const COLUMN_ORDER: TaskStatus[] = ['todo', 'in_progress', 'review', 'done', 'blocked'];

interface KanbanBoardProps {
  tasks: ProjectTask[];
  onTaskStatusChange?: (taskId: string, newStatus: TaskStatus, newOrder: number) => void;
  onTaskReorder: (tasks: { id: string; sort_order: number; status?: string }[]) => void;
  onTaskClick: (task: ProjectTask) => void;
  onQuickAdd: (title: string, status: TaskStatus) => void;
  showProject?: boolean;
}

export function KanbanBoard({
  tasks,
  onTaskStatusChange: _onTaskStatusChange,
  onTaskReorder,
  onTaskClick,
  onQuickAdd,
  showProject,
}: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<ProjectTask | null>(null);
  const [localTasks, setLocalTasks] = useState<ProjectTask[]>(tasks);

  // Sync when tasks prop changes
  if (tasks !== localTasks && !activeTask) {
    setLocalTasks(tasks);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const getColumnTasks = useCallback(
    (status: TaskStatus) =>
      localTasks
        .filter(t => t.status === status)
        .sort((a, b) => a.sort_order - b.sort_order),
    [localTasks],
  );

  const handleDragStart = (event: DragStartEvent) => {
    const task = localTasks.find(t => t.id === event.active.id);
    if (task) setActiveTask(task);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeTaskItem = localTasks.find(t => t.id === activeId);
    if (!activeTaskItem) return;

    // Determine target column - over could be a task or a column droppable
    let targetStatus: TaskStatus;
    const overTask = localTasks.find(t => t.id === overId);

    if (overTask) {
      targetStatus = overTask.status;
    } else if (COLUMN_ORDER.includes(overId as TaskStatus)) {
      targetStatus = overId as TaskStatus;
    } else {
      return;
    }

    // If task moved to different column, update locally
    if (activeTaskItem.status !== targetStatus) {
      setLocalTasks(prev =>
        prev.map(t =>
          t.id === activeId ? { ...t, status: targetStatus } : t,
        ),
      );
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    const task = localTasks.find(t => t.id === activeId);
    if (!task) return;

    // Determine target column
    let targetStatus: TaskStatus = task.status;
    const overTask = localTasks.find(t => t.id === overId);

    if (overTask) {
      targetStatus = overTask.status;
    } else if (COLUMN_ORDER.includes(overId as TaskStatus)) {
      targetStatus = overId as TaskStatus;
    }

    // Get tasks in target column
    const columnTasks = localTasks
      .filter(t => t.status === targetStatus && t.id !== activeId)
      .sort((a, b) => a.sort_order - b.sort_order);

    // Determine new position
    let newIndex = columnTasks.length; // default: end
    if (overTask && overTask.id !== activeId) {
      const overIndex = columnTasks.findIndex(t => t.id === overId);
      if (overIndex >= 0) newIndex = overIndex;
    }

    // Insert task at new position
    columnTasks.splice(newIndex, 0, { ...task, status: targetStatus });

    // Build reorder payload
    const reorderPayload = columnTasks.map((t, i) => ({
      id: t.id,
      sort_order: i,
      ...(t.id === activeId ? { status: targetStatus } : {}),
    }));

    // Update local state
    setLocalTasks(prev => {
      const updated = [...prev];
      for (const item of reorderPayload) {
        const idx = updated.findIndex(t => t.id === item.id);
        if (idx >= 0) {
          updated[idx] = {
            ...updated[idx],
            sort_order: item.sort_order,
            ...(item.status ? { status: item.status as TaskStatus } : {}),
          };
        }
      }
      return updated;
    });

    // Fire API call
    onTaskReorder(reorderPayload);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMN_ORDER.map(status => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={getColumnTasks(status)}
            onTaskClick={onTaskClick}
            onQuickAdd={onQuickAdd}
            showProject={showProject}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask && (
          <div className="rotate-3 w-[280px]">
            <TaskCard task={activeTask} onClick={() => {}} showProject={showProject} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
