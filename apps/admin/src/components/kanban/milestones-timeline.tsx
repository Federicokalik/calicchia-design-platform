import { CheckCircle2, Circle, Clock, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectMilestone, MilestoneStatus } from '@/types/projects';

interface MilestonesTimelineProps {
  milestones: ProjectMilestone[];
  onEdit: (milestone: ProjectMilestone) => void;
}

const statusIcons: Record<MilestoneStatus, React.ComponentType<{ className?: string }>> = {
  pending: Circle,
  in_progress: Clock,
  completed: CheckCircle2,
  skipped: SkipForward,
};

const statusColors: Record<MilestoneStatus, string> = {
  pending: 'text-muted-foreground',
  in_progress: 'text-blue-500',
  completed: 'text-green-500',
  skipped: 'text-gray-400',
};

const statusLabels: Record<MilestoneStatus, string> = {
  pending: 'In attesa',
  in_progress: 'In corso',
  completed: 'Completata',
  skipped: 'Saltata',
};

export function MilestonesTimeline({ milestones, onEdit }: MilestonesTimelineProps) {
  if (milestones.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <p className="text-sm">Nessuna milestone definita</p>
      </div>
    );
  }

  return (
    <div className="relative">
      {milestones.map((milestone, index) => {
        const Icon = statusIcons[milestone.status];
        const isLast = index === milestones.length - 1;
        const deliverablesDone = milestone.deliverables?.filter(d => d.done).length || 0;
        const deliverablesTotal = milestone.deliverables?.length || 0;

        return (
          <div key={milestone.id} className="flex gap-4 pb-6 last:pb-0">
            {/* Timeline line + icon */}
            <div className="flex flex-col items-center">
              <div className={cn('rounded-full p-1', statusColors[milestone.status])}>
                <Icon className="h-5 w-5" />
              </div>
              {!isLast && (
                <div className="w-px flex-1 bg-border mt-1" />
              )}
            </div>

            {/* Content */}
            <div
              className="flex-1 rounded-lg border bg-card p-4 cursor-pointer hover:shadow-sm transition-shadow -mt-1"
              onClick={() => onEdit(milestone)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-medium">{milestone.name}</h4>
                  {milestone.description && (
                    <p className="text-sm text-muted-foreground mt-1">{milestone.description}</p>
                  )}
                </div>
                <span className={cn('text-xs font-medium', statusColors[milestone.status])}>
                  {statusLabels[milestone.status]}
                </span>
              </div>

              <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                {milestone.due_date && (
                  <span>
                    Scadenza: {new Date(milestone.due_date).toLocaleDateString('it-IT')}
                  </span>
                )}
                {milestone.completed_at && (
                  <span className="text-green-600">
                    Completata: {new Date(milestone.completed_at).toLocaleDateString('it-IT')}
                  </span>
                )}
                {deliverablesTotal > 0 && (
                  <span>
                    Deliverable: {deliverablesDone}/{deliverablesTotal}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
