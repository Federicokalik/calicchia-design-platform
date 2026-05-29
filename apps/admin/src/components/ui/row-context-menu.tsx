import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';

/**
 * Helper standardizzato per right-click menu su righe/card/tile dell'admin.
 *
 * Per casi complessi (submenu, item dinamici, gruppi, checkbox/radio) importare
 * i primitive direttamente da `@/components/ui/context-menu`.
 *
 * Pattern raccomandato: estrarre `rowActions(item, mutations): Action[]` e
 * passarlo sia qui sia al DropdownMenu del kebab esistente — coesistono.
 */

export type RowAction =
  | {
      label: string;
      icon?: LucideIcon;
      onClick: () => void;
      destructive?: boolean;
      disabled?: boolean;
      shortcut?: string;
    }
  | { divider: true };

interface RowContextMenuProps {
  actions: RowAction[];
  children: React.ReactNode;
  /** Disabilita l'apertura del menu (fallback al context menu del browser). */
  disabled?: boolean;
  /** Classe applicata al ContextMenuContent. */
  contentClassName?: string;
}

export function RowContextMenu({
  actions,
  children,
  disabled,
  contentClassName,
}: RowContextMenuProps) {
  if (disabled || actions.length === 0) return <>{children}</>;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className={cn('min-w-[10rem]', contentClassName)}>
        {actions.map((action, i) => {
          if ('divider' in action) {
            return <ContextMenuSeparator key={`sep-${i}`} />;
          }
          const Icon = action.icon;
          return (
            <ContextMenuItem
              key={`${action.label}-${i}`}
              disabled={action.disabled}
              onSelect={(e) => {
                e.preventDefault();
                action.onClick();
              }}
              className={cn(
                'text-xs',
                action.destructive && 'text-destructive focus:text-destructive'
              )}
            >
              {Icon && <Icon className="h-3.5 w-3.5" />}
              <span>{action.label}</span>
              {action.shortcut && (
                <ContextMenuShortcut>{action.shortcut}</ContextMenuShortcut>
              )}
            </ContextMenuItem>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}
