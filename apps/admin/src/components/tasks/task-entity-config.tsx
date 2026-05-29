import { LayoutList, Kanban as KanbanIcon, Calendar as CalendarIcon, BarChart3, ExternalLink, ArrowRight, Trash2 } from 'lucide-react';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { TaskListView } from './task-list-view';
import { TaskCalendarView } from './task-calendar-view';
import { TaskGanttView } from './task-gantt-view';
import type { EntityViewConfig, GroupByOption } from '@/components/entity-view';
import type { RowAction } from '@/components/ui/row-context-menu';
import type { ProjectTask, ProjectMilestone, TaskStatus } from '@/types/projects';
import { TASK_STATUS_CONFIG } from '@/types/projects';

const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'review', 'done', 'blocked'];
const PRIORITY_LABELS: Record<number, string> = {
  1: 'Urgente',
  2: 'Alta',
  3: 'Media',
  4: 'Bassa',
  5: 'Nessuna',
};

interface BuildOptions {
  tasks: ProjectTask[];
  milestones?: ProjectMilestone[];
  projectStart?: string | null;
  projectEnd?: string | null;
  onCreate: (title: string, ctx: { status?: string }) => void;
  onReorder: (payload: Array<{ id: string; sort_order: number; status?: string }>) => void;
  onItemClick: (task: ProjectTask) => void;
  onUpdate?: (taskId: string, patch: Partial<ProjectTask>) => void;
  onDelete?: (task: ProjectTask) => void;
}

export function buildTasksConfig(opts: BuildOptions): EntityViewConfig<ProjectTask> {
  const { tasks, milestones = [], projectStart, projectEnd, onCreate, onReorder, onItemClick, onUpdate, onDelete } = opts;

  // Azioni shared usate dal context menu (right-click) di tutte le view: Kanban, List, Gantt, Calendar.
  // Submenu non sono ancora supportati nell'helper RowContextMenu, quindi i cambi status sono flat.
  const buildTaskActions = (task: ProjectTask): RowAction[] => {
    const items: RowAction[] = [
      { label: 'Apri', icon: ExternalLink, onClick: () => onItemClick(task) },
    ];
    if (onUpdate) {
      const otherStatuses = STATUS_ORDER.filter((s) => s !== task.status);
      if (otherStatuses.length > 0) {
        items.push({ divider: true });
        for (const s of otherStatuses) {
          items.push({
            label: `Sposta in “${TASK_STATUS_CONFIG[s]?.label ?? s}”`,
            icon: ArrowRight,
            onClick: () => onUpdate(task.id, { status: s }),
          });
        }
      }
    }
    if (onDelete) {
      items.push({ divider: true });
      items.push({
        label: 'Elimina',
        icon: Trash2,
        destructive: true,
        onClick: () => onDelete(task),
      });
    }
    return items;
  };

  const milestoneMap = new Map<string, string>();
  milestones.forEach((m) => milestoneMap.set(m.id, m.name));

  const statusGroup: GroupByOption<ProjectTask> = {
    key: 'status',
    label: 'Stato',
    getValue: (t) => t.status,
    formatLabel: (v) => TASK_STATUS_CONFIG[v as TaskStatus]?.label ?? v,
    sortOrder: STATUS_ORDER,
  };

  const milestoneGroup: GroupByOption<ProjectTask> = {
    key: 'milestone',
    label: 'Milestone',
    getValue: (t) => t.milestone_id ?? null,
    formatLabel: (v) => (v ? milestoneMap.get(v) ?? 'Milestone' : 'Senza milestone'),
  };

  const priorityGroup: GroupByOption<ProjectTask> = {
    key: 'priority',
    label: 'Priorità',
    getValue: (t) => (t.priority > 0 ? String(t.priority) : null),
    formatLabel: (v) => PRIORITY_LABELS[Number(v)] ?? `Priorità ${v}`,
    sortOrder: ['1', '2', '3', '4', '5'],
  };

  const assigneeGroup: GroupByOption<ProjectTask> = {
    key: 'assignee',
    label: 'Assegnatario',
    getValue: (t) => t.assignee_email ?? null,
    formatLabel: (v) => (v ? v.split('@')[0] : 'Non assegnato'),
  };

  return {
    entityType: 'task',
    items: tasks,
    getId: (t) => t.id,
    getTitle: (t) => t.title,
    getStatus: (t) => t.status,
    isClosed: (t) => t.status === 'done',
    getAssignee: (t) => t.assignee_email ?? null,
    getAssigneeLabel: (t) => (t.assignee_email ? t.assignee_email.split('@')[0] : null),
    searchKeys: ['title', 'description' as keyof ProjectTask],
    groupByOptions: [statusGroup, milestoneGroup, priorityGroup, assigneeGroup],
    sortOptions: [
      { key: 'title', label: 'Titolo', compare: (a, b) => a.title.localeCompare(b.title) },
      {
        key: 'due_date',
        label: 'Scadenza',
        compare: (a, b) => {
          const av = a.due_date ? new Date(a.due_date).getTime() : Number.POSITIVE_INFINITY;
          const bv = b.due_date ? new Date(b.due_date).getTime() : Number.POSITIVE_INFINITY;
          return av - bv;
        },
      },
      { key: 'priority', label: 'Priorità', compare: (a, b) => (a.priority || 99) - (b.priority || 99) },
      {
        key: 'created',
        label: 'Creazione',
        compare: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      },
    ],
    views: [
      {
        key: 'list',
        label: 'Lista',
        icon: LayoutList,
        render: (ctx) => {
          const groupConfig = ctx.state.group
            ? ctx.config.groupByOptions?.find((g) => g.key === ctx.state.group)
            : undefined;
          return (
            <TaskListView
              tasks={ctx.items}
              groupedTasks={ctx.groupedItems}
              groupConfig={groupConfig}
              onItemClick={onItemClick}
              onUpdate={onUpdate}
              getTaskActions={buildTaskActions}
            />
          );
        },
      },
      {
        key: 'board',
        label: 'Bacheca',
        icon: KanbanIcon,
        render: (ctx) => (
          <KanbanBoard
            tasks={ctx.items}
            onTaskReorder={onReorder}
            onTaskClick={onItemClick}
            onQuickAdd={(title, status) => onCreate(title, { status })}
            getTaskActions={buildTaskActions}
          />
        ),
      },
      {
        key: 'calendar',
        label: 'Calendario',
        icon: CalendarIcon,
        render: (ctx) => (
          <TaskCalendarView tasks={ctx.items} onItemClick={onItemClick} />
        ),
      },
      {
        key: 'gantt',
        label: 'Gantt',
        icon: BarChart3,
        render: (ctx) => (
          <TaskGanttView
            tasks={ctx.items}
            projectStart={projectStart}
            projectEnd={projectEnd}
            onItemClick={onItemClick}
            getTaskActions={buildTaskActions}
          />
        ),
      },
    ],
    availableViews: ['list', 'board', 'calendar', 'gantt'],
    defaultView: 'board',
    onCreate,
    onItemClick,
    createPlaceholder: 'Nuovo task…',
  };
}
