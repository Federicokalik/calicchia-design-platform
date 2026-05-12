import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { GripVertical, Settings2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { WidgetConfig } from '@/hooks/use-widget-layout';
import { useI18n } from '@/hooks/use-i18n';

interface WidgetGridProps {
  widgets: WidgetConfig[];
  visibleWidgets: WidgetConfig[];
  onReorder: (fromId: string, toId: string) => void;
  onToggle: (id: string) => void;
  onReset: () => void;
  renderWidget: (widget: WidgetConfig) => React.ReactNode;
}

const colSpan = (w: number) =>
  w === 1 ? 'col-span-1' :
  w === 2 ? 'col-span-1 sm:col-span-2' :
  w === 3 ? 'col-span-1 sm:col-span-2 lg:col-span-3' :
  w === 4 ? 'col-span-1 sm:col-span-2 lg:col-span-4' : 'col-span-1';

const rowSpan = (h: number) =>
  h === 2 ? 'row-span-2' : h === 3 ? 'row-span-3' : '';

function SortableWidget({
  widget,
  children,
}: {
  widget: WidgetConfig;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({ id: widget.id });

  // No transforms on grid items — DragOverlay handles visual feedback.
  // This prevents layout distortion when mixed-size widgets swap.
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'group relative rounded-xl border bg-card text-card-foreground shadow-sm',
        'transition-[box-shadow,border-color,opacity] duration-300',
        isDragging && 'opacity-30 border-dashed border-primary/30',
        colSpan(widget.w), rowSpan(widget.h),
      )}
    >
      {/* Drag handle */}
      <button
        className={cn(
          'absolute top-2 right-2 z-10 transition-all cursor-grab active:cursor-grabbing p-1 rounded-md',
          isDragging ? 'opacity-100 text-primary bg-primary/10' : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:bg-muted',
        )}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}

/** Overlay clone rendered at cursor position during drag — prevents layout reflow */
function WidgetOverlay({ widget, children }: { widget: WidgetConfig; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card text-card-foreground',
        'shadow-2xl shadow-primary/15 ring-2 ring-primary/30 border-primary/40',
        'scale-[1.03] rotate-[0.5deg]',
        colSpan(widget.w), rowSpan(widget.h),
      )}
      style={{ width: '100%', pointerEvents: 'none' }}
    >
      {children}
    </div>
  );
}

export function WidgetGrid({
  widgets,
  visibleWidgets,
  onReorder,
  onToggle,
  onReset,
  renderWidget,
}: WidgetGridProps) {
  const { t } = useI18n();
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (over && active.id !== over.id) {
      onReorder(String(active.id), String(over.id));
    }
  };

  const activeWidget = activeId ? visibleWidgets.find(w => w.id === activeId) : null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <Settings2 className="h-3.5 w-3.5" />
              {t('dashboard.widgets.customize')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {widgets.map((w) => (
              <DropdownMenuCheckboxItem
                key={w.id}
                checked={w.visible}
                onCheckedChange={() => onToggle(w.id)}
              >
                {t(w.titleKey)}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onReset}>
              <RotateCcw className="mr-2 h-3.5 w-3.5" />
              {t('dashboard.widgets.resetLayout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Grid */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={visibleWidgets.map((w) => w.id)}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-[minmax(140px,auto)]">
            {visibleWidgets.map((widget) => (
              <SortableWidget key={widget.id} widget={widget}>
                {renderWidget(widget)}
              </SortableWidget>
            ))}
          </div>
        </SortableContext>

        {/* Drag overlay — renders outside grid flow so no reflow/distortion */}
        <DragOverlay dropAnimation={{
          duration: 300,
          easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}>
          {activeWidget ? (
            <WidgetOverlay widget={activeWidget}>
              {renderWidget(activeWidget)}
            </WidgetOverlay>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
