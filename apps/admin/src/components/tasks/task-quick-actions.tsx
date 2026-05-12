import { useState } from 'react';
import { Flag, Calendar as CalendarIcon, CircleDashed } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ProjectTask, TaskStatus } from '@/types/projects';
import { TASK_STATUS_CONFIG } from '@/types/projects';

interface TaskQuickActionsProps {
  task: ProjectTask;
  onUpdate: (taskId: string, patch: Partial<ProjectTask>) => void;
}

const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'review', 'done', 'blocked'];

const PRIORITY_OPTIONS: Array<{ value: number; label: string; color: string }> = [
  { value: 1, label: 'Urgente', color: 'text-red-500' },
  { value: 2, label: 'Alta', color: 'text-orange-500' },
  { value: 3, label: 'Media', color: 'text-amber-500' },
  { value: 4, label: 'Bassa', color: 'text-blue-500' },
  { value: 5, label: 'Nessuna', color: 'text-slate-400' },
];

function stop(e: React.MouseEvent | React.PointerEvent) {
  e.stopPropagation();
}

export function TaskQuickActions({ task, onUpdate }: TaskQuickActionsProps) {
  const [dateOpen, setDateOpen] = useState(false);

  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={stop}>
      {/* Status */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Cambia stato"
            onClick={stop}
          >
            <CircleDashed className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1" align="end" onClick={stop}>
          {STATUS_ORDER.map((s) => {
            const cfg = TASK_STATUS_CONFIG[s];
            const active = task.status === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onUpdate(task.id, { status: s })}
                className={cn(
                  'w-full flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted text-left',
                  active && 'bg-muted font-medium'
                )}
              >
                <span className={cn('h-2 w-2 rounded-full', cfg.bgColor.split(' ')[0])} />
                <span>{cfg.label}</span>
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

      {/* Priority */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Cambia priorità"
            onClick={stop}
          >
            <Flag className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1" align="end" onClick={stop}>
          {PRIORITY_OPTIONS.map((p) => {
            const active = task.priority === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => onUpdate(task.id, { priority: p.value })}
                className={cn(
                  'w-full flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted text-left',
                  active && 'bg-muted font-medium'
                )}
              >
                <Flag className={cn('h-3 w-3', p.color)} />
                <span>{p.label}</span>
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

      {/* Due date */}
      <Popover open={dateOpen} onOpenChange={setDateOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Imposta scadenza"
            onClick={stop}
          >
            <CalendarIcon className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end" onClick={stop}>
          <Calendar
            mode="single"
            selected={task.due_date ? new Date(task.due_date) : undefined}
            onSelect={(d) => {
              onUpdate(task.id, { due_date: d ? d.toISOString().slice(0, 10) : null });
              setDateOpen(false);
            }}
            initialFocus
          />
          {task.due_date && (
            <div className="border-t p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 text-xs"
                onClick={() => {
                  onUpdate(task.id, { due_date: null });
                  setDateOpen(false);
                }}
              >
                Rimuovi scadenza
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
