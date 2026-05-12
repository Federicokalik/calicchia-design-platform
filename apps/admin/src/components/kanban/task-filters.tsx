import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { ProjectMilestone } from '@/types/projects';

interface TaskFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  milestoneFilter: string | null;
  onMilestoneChange: (value: string | null) => void;
  priorityFilter: string | null;
  onPriorityChange: (value: string | null) => void;
  sourceFilter?: string | null;
  onSourceChange?: (value: string | null) => void;
  milestones: ProjectMilestone[];
}

export function TaskFilters({
  search,
  onSearchChange,
  milestoneFilter,
  onMilestoneChange,
  priorityFilter,
  onPriorityChange,
  sourceFilter,
  onSourceChange,
  milestones,
}: TaskFiltersProps) {
  const hasFilters = search || milestoneFilter || priorityFilter || sourceFilter;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Cerca task..."
          className="pl-9 h-9 w-[200px]"
        />
      </div>

      {/* Milestone filter */}
      {milestones.length > 0 && (
        <select
          value={milestoneFilter || ''}
          onChange={(e) => onMilestoneChange(e.target.value || null)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">Tutte le milestone</option>
          {milestones.map(m => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      )}

      {/* Priority filter */}
      <select
        value={priorityFilter || ''}
        onChange={(e) => onPriorityChange(e.target.value || null)}
        className="h-9 rounded-md border bg-background px-3 text-sm"
      >
        <option value="">Tutte le priorità</option>
        <option value="high">Alta (8-10)</option>
        <option value="medium">Media (4-7)</option>
        <option value="low">Bassa (1-3)</option>
      </select>

      {/* Source filter */}
      {onSourceChange && (
        <select
          value={sourceFilter || ''}
          onChange={(e) => onSourceChange(e.target.value || null)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">Tutte le origini</option>
          <option value="admin">Solo Admin</option>
          <option value="client">Solo Richieste Cliente</option>
        </select>
      )}

      {/* Clear filters */}
      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9"
          onClick={() => {
            onSearchChange('');
            onMilestoneChange(null);
            onPriorityChange(null);
            onSourceChange?.(null);
          }}
        >
          <X className="h-4 w-4 mr-1" />
          Pulisci
        </Button>
      )}
    </div>
  );
}
