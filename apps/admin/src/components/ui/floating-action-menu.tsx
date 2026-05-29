import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { RowAction } from '@/components/ui/row-context-menu';

/**
 * Menu fluttuante posizionato a coordinate {x, y}. Stesso "linguaggio" di
 * azione di RowContextMenu (riusa `RowAction[]`), ma per contesti dove non
 * abbiamo un trigger DOM React-controllato: FullCalendar event tiles, ReactFlow
 * nodes, canvas custom, ecc. Per i casi React-nativi preferire RowContextMenu.
 *
 * Chiude su: click, scroll (capture), Escape. Il caller setta `null` per chiudere.
 */

interface FloatingActionMenuProps {
  actions: RowAction[];
  x: number;
  y: number;
  onClose: () => void;
}

export function FloatingActionMenu({ actions, x, y, onClose }: FloatingActionMenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('click', onClose);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClose);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  if (actions.length === 0) return null;

  return (
    <div
      role="menu"
      className="fixed z-[var(--z-popper)] min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      {actions.map((action, i) => {
        if ('divider' in action) {
          return <div key={`sep-${i}`} className="-mx-1 my-1 h-px bg-muted" />;
        }
        const Icon = action.icon;
        return (
          <button
            key={`${action.label}-${i}`}
            type="button"
            disabled={action.disabled}
            onClick={() => { action.onClick(); onClose(); }}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors',
              'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
              'disabled:pointer-events-none disabled:opacity-50',
              action.destructive && 'text-destructive hover:bg-destructive/10 focus:bg-destructive/10',
            )}
          >
            {Icon && <Icon className="h-3 w-3" />}
            <span className="flex-1 text-left">{action.label}</span>
            {action.shortcut && (
              <span className="ml-auto text-xs tracking-widest text-muted-foreground">
                {action.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
