import { useState } from 'react';
import { GripVertical, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SectionWrapperProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  removable?: boolean;
  onRemove?: () => void;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export function SectionWrapper({
  id,
  title,
  icon,
  removable = true,
  onRemove,
  children,
  defaultOpen = true,
}: SectionWrapperProps) {
  const [open, setOpen] = useState(defaultOpen);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-lg border bg-card transition-shadow',
        isDragging && 'shadow-lg ring-2 ring-primary/20 z-50',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-muted/30 rounded-t-lg">
        <button
          className="cursor-grab active:cursor-grabbing touch-none text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 flex-1 text-left"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {icon}
          <span className="text-sm font-semibold">{title}</span>
        </button>
        {removable && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRemove}>
            <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
          </Button>
        )}
      </div>

      {/* Content */}
      {open && <div className="p-4 space-y-3">{children}</div>}
    </div>
  );
}
