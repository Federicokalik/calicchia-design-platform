import { Clock, CheckCircle2, AlertTriangle, DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ClientProjectView } from '@/types/projects';
import { PROJECT_STATUS_CONFIG } from '@/types/projects';

interface ProjectStatsBarProps {
  project: ClientProjectView;
}

export function ProjectStatsBar({ project }: ProjectStatsBarProps) {
  const statusConfig = PROJECT_STATUS_CONFIG[project.status];
  const hoursPercentage = project.estimated_hours
    ? Math.min(100, Math.round((project.actual_hours / project.estimated_hours) * 100))
    : 0;
  const budgetUsed = project.hourly_rate && project.actual_hours
    ? project.actual_hours * project.hourly_rate
    : 0;

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card p-4">
      {/* Status */}
      <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', statusConfig.color)}>
        {statusConfig.label}
      </span>

      {/* Progress */}
      <div className="flex items-center gap-2">
        <div className="h-2 w-24 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${project.progress_percentage}%` }}
          />
        </div>
        <span className="text-sm font-medium">{project.progress_percentage}%</span>
      </div>

      {/* Tasks */}
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4" />
        <span>{project.completed_tasks}/{project.total_tasks} task</span>
      </div>

      {/* Hours */}
      {project.estimated_hours && (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span className={cn(hoursPercentage > 90 && 'text-amber-600 font-medium')}>
            {project.actual_hours || 0}/{project.estimated_hours}h
          </span>
        </div>
      )}

      {/* Budget */}
      {project.budget_amount && (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <DollarSign className="h-4 w-4" />
          <span>
            {budgetUsed.toLocaleString('it-IT', { minimumFractionDigits: 0 })} / {project.budget_amount.toLocaleString('it-IT', { minimumFractionDigits: 0 })} {project.currency}
          </span>
        </div>
      )}

      {/* Overdue warning */}
      {project.is_overdue && (
        <div className="flex items-center gap-1.5 text-sm text-red-500 font-medium">
          <AlertTriangle className="h-4 w-4" />
          In ritardo
        </div>
      )}

      {/* Customer */}
      <div className="ml-auto text-sm text-muted-foreground">
        {project.customer_company || project.customer_name}
      </div>
    </div>
  );
}
