import { useState } from 'react';
import {
  X,
  Calendar,
  Flag,
  Tag,
  Milestone,
  CheckSquare,
  Clock,
  MessageSquare,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type {
  ProjectTask,
  TaskStatus,
  ProjectMilestone,
  TimeEntry,
  ProjectComment,
  ChecklistItem,
} from '@/types/projects';
import { TASK_STATUS_CONFIG } from '@/types/projects';
import { TimeTracker } from './time-tracker';
import { CommentsThread } from './comments-thread';

interface TaskDetailPanelProps {
  task: ProjectTask;
  milestones: ProjectMilestone[];
  timeEntries: TimeEntry[];
  comments: ProjectComment[];
  activeTimer: TimeEntry | null;
  currentUserId: string;
  onClose: () => void;
  onUpdate: (updates: Partial<ProjectTask>) => void;
  onDelete: () => void;
  onStartTimer: (description?: string) => void;
  onStopTimer: () => void;
  onAddTimeEntry: (entry: { start_time: string; end_time: string; description: string; is_billable: boolean }) => void;
  onDeleteTimeEntry: (id: string) => void;
  onAddComment: (content: string, isInternal: boolean) => void;
  onDeleteComment: (id: string) => void;
}

type Tab = 'details' | 'checklist' | 'time' | 'comments';

export function TaskDetailPanel({
  task,
  milestones,
  timeEntries,
  comments,
  activeTimer,
  currentUserId,
  onClose,
  onUpdate,
  onDelete,
  onStartTimer,
  onStopTimer,
  onAddTimeEntry,
  onDeleteTimeEntry,
  onAddComment,
  onDeleteComment,
}: TaskDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('details');
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDescription, setEditDescription] = useState(task.description || '');
  const [newCheckItem, setNewCheckItem] = useState('');

  const tabs: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'details', label: 'Dettagli', icon: Flag },
    { id: 'checklist', label: `Checklist (${task.checklist?.length || 0})`, icon: CheckSquare },
    { id: 'time', label: 'Tempo', icon: Clock },
    { id: 'comments', label: `Commenti (${comments.length})`, icon: MessageSquare },
  ];

  const handleSaveDetails = () => {
    const updates: Partial<ProjectTask> = {};
    if (editTitle !== task.title) updates.title = editTitle;
    if (editDescription !== (task.description || '')) updates.description = editDescription || null;
    if (Object.keys(updates).length) onUpdate(updates);
  };

  const toggleCheckItem = (itemId: string) => {
    const updated = (task.checklist || []).map(item =>
      item.id === itemId ? { ...item, done: !item.done } : item,
    );
    onUpdate({ checklist: updated });
  };

  const addCheckItem = () => {
    if (!newCheckItem.trim()) return;
    const item: ChecklistItem = {
      id: crypto.randomUUID(),
      text: newCheckItem.trim(),
      done: false,
    };
    onUpdate({ checklist: [...(task.checklist || []), item] });
    setNewCheckItem('');
  };

  const removeCheckItem = (itemId: string) => {
    onUpdate({ checklist: (task.checklist || []).filter(i => i.id !== itemId) });
  };

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[460px] max-w-full border-l bg-background shadow-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <select
            value={task.status}
            onChange={(e) => onUpdate({ status: e.target.value as TaskStatus })}
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium border-0 cursor-pointer',
              TASK_STATUS_CONFIG[task.status].bgColor,
              TASK_STATUS_CONFIG[task.status].color,
            )}
          >
            {Object.entries(TASK_STATUS_CONFIG).map(([key, conf]) => (
              <option key={key} value={key}>{conf.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b px-4 gap-1">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors',
              activeTab === tab.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'details' && (
          <div className="space-y-4">
            {/* Title */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Titolo</label>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={handleSaveDetails}
                className="mt-1 font-medium"
              />
            </div>

            {/* Description */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Descrizione</label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                onBlur={handleSaveDetails}
                className="mt-1 w-full rounded-md border bg-background p-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
                rows={4}
                placeholder="Aggiungi una descrizione..."
              />
            </div>

            {/* Priority */}
            <div>
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Flag className="h-3.5 w-3.5" />
                Priorità
              </label>
              <select
                value={task.priority}
                onChange={(e) => onUpdate({ priority: parseInt(e.target.value) })}
                className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>
                    {n} {n >= 8 ? '(Alta)' : n >= 4 ? '(Media)' : '(Bassa)'}
                  </option>
                ))}
              </select>
            </div>

            {/* Milestone */}
            <div>
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Milestone className="h-3.5 w-3.5" />
                Milestone
              </label>
              <select
                value={task.milestone_id || ''}
                onChange={(e) => onUpdate({ milestone_id: e.target.value || null })}
                className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
              >
                <option value="">Nessuna</option>
                {milestones.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>

            {/* Due date */}
            <div>
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                Scadenza
              </label>
              <Input
                type="date"
                value={task.due_date || ''}
                onChange={(e) => onUpdate({ due_date: e.target.value || null })}
                className="mt-1"
              />
            </div>

            {/* Estimated hours */}
            <div>
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Ore stimate
              </label>
              <Input
                type="number"
                step="0.5"
                min="0"
                value={task.estimated_hours || ''}
                onChange={(e) => onUpdate({ estimated_hours: parseFloat(e.target.value) || null })}
                className="mt-1"
                placeholder="0"
              />
            </div>

            {/* Tags */}
            <div>
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5" />
                Tag
              </label>
              <Input
                value={(task.tags || []).join(', ')}
                onChange={(e) => onUpdate({ tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}
                className="mt-1"
                placeholder="tag1, tag2, ..."
              />
            </div>
          </div>
        )}

        {activeTab === 'checklist' && (
          <div className="space-y-2">
            {/* Progress */}
            {(task.checklist?.length || 0) > 0 && (
              <div className="flex items-center gap-2 mb-4">
                <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all"
                    style={{
                      width: `${(task.checklist!.filter(c => c.done).length / task.checklist!.length) * 100}%`,
                    }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {task.checklist!.filter(c => c.done).length}/{task.checklist!.length}
                </span>
              </div>
            )}

            {/* Items */}
            {(task.checklist || []).map(item => (
              <div key={item.id} className="flex items-center gap-2 group">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => toggleCheckItem(item.id)}
                  className="rounded"
                />
                <span className={cn('flex-1 text-sm', item.done && 'line-through text-muted-foreground')}>
                  {item.text}
                </span>
                <button
                  onClick={() => removeCheckItem(item.id)}
                  className="opacity-0 group-hover:opacity-100 text-destructive/60 hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            {/* Add item */}
            <div className="flex gap-2 pt-2">
              <Input
                value={newCheckItem}
                onChange={(e) => setNewCheckItem(e.target.value)}
                placeholder="Nuovo elemento..."
                className="h-8 text-sm"
                onKeyDown={(e) => e.key === 'Enter' && addCheckItem()}
              />
              <Button size="sm" className="h-8" onClick={addCheckItem} disabled={!newCheckItem.trim()}>
                Aggiungi
              </Button>
            </div>
          </div>
        )}

        {activeTab === 'time' && (
          <TimeTracker
            projectId={task.project_id}
            taskId={task.id}
            userId={currentUserId}
            activeTimer={activeTimer}
            entries={timeEntries}
            onStartTimer={onStartTimer}
            onStopTimer={onStopTimer}
            onAddManual={onAddTimeEntry}
            onDeleteEntry={onDeleteTimeEntry}
          />
        )}

        {activeTab === 'comments' && (
          <CommentsThread
            comments={comments}
            currentUserId={currentUserId}
            onAdd={onAddComment}
            onDelete={onDeleteComment}
          />
        )}
      </div>
    </div>
  );
}
