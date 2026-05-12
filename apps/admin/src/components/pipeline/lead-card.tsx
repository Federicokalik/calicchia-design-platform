import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Mail, Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Lead } from '@/types/lead';
import { LEAD_SOURCE_CONFIG } from '@/types/lead';
import { useI18n } from '@/hooks/use-i18n';

interface LeadCardProps {
  lead: Lead;
  onClick: (lead: Lead) => void;
}

export function LeadCard({ lead, onClick }: LeadCardProps) {
  const { t, formatCurrency, formatRelativeTime } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: lead.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1)',
  };

  const sourceConfig = LEAD_SOURCE_CONFIG[lead.source];
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group rounded-lg border bg-card p-3 shadow-sm transition-[box-shadow,border-color,transform] duration-300 hover:shadow-md cursor-pointer',
        isDragging && 'z-50 shadow-2xl shadow-primary/15 ring-2 ring-primary/30 scale-[1.04] rotate-[1deg] border-primary/40 opacity-95',
      )}
      onClick={() => onClick(lead)}
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
          {/* Name */}
          <p className="text-sm font-medium leading-tight">{lead.name}</p>

          {/* Company */}
          {lead.company && (
            <div className="flex items-center gap-1 mt-1">
              <Building2 className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground truncate">{lead.company}</span>
            </div>
          )}

          {/* Tags row */}
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {/* Source */}
            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-muted', sourceConfig.color)}>
              {t(sourceConfig.labelKey)}
            </span>

            {/* Value */}
            {lead.estimated_value && (
              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                {formatCurrency(lead.estimated_value)}
              </span>
            )}

            {/* Tags */}
            {lead.tags?.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
            {lead.email && (
              <span className="flex items-center gap-1 truncate">
                <Mail className="h-3 w-3 shrink-0" />
                <span className="truncate">{lead.email}</span>
              </span>
            )}
            <span className="ml-auto shrink-0">
              {formatRelativeTime(lead.created_at)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
