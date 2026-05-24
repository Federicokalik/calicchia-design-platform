import { Menu, Search, MoreVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ThemeToggle } from '@/components/theme-toggle';
import { InboxDropdown } from '@/components/layout/inbox-dropdown';
import { CopyLinkButton } from '@/components/shared/copy-link-button';
import { useTopbarState } from '@/hooks/use-topbar';
import { cn } from '@/lib/utils';
import { LanguageToggle } from './language-toggle';
import { TimerWidget } from './timer-widget';

interface TopbarProps {
  onMenuClick: () => void;
  onSearchClick: () => void;
  sidebarCollapsed: boolean;
}

export function Topbar({ onMenuClick, onSearchClick, sidebarCollapsed }: TopbarProps) {
  const { title, subtitle, actions } = useTopbarState();

  return (
    <header
      className={cn(
        // Mobile: 56px (h-14) per touch comfort. Desktop: 48px (h-12).
        'fixed top-0 right-0 flex h-14 lg:h-12 items-center gap-3 topbar-island px-3 lg:px-4 z-[var(--z-topbar)]',
        sidebarCollapsed ? 'left-[60px]' : 'left-[264px]',
        'max-lg:left-0'
      )}
      style={{ transition: 'left 200ms ease-in-out' }}
    >
      {/* Mobile menu — 44px tap target. */}
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden h-11 w-11"
        onClick={onMenuClick}
        aria-label="Apri menu"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* Title + subtitle */}
      <div className="flex items-baseline gap-2 min-w-0 flex-1">
        <h1 className="text-sm font-semibold text-foreground shrink-0 truncate">{title}</h1>
        {subtitle && (
          <span className="text-xs text-muted-foreground truncate hidden sm:inline">{subtitle}</span>
        )}
      </div>

      {/* Page actions (injected by each page) — kept visible at all sizes since they are page-specific. */}
      {actions && (
        <div className="flex items-center gap-1.5 shrink-0">
          {actions}
        </div>
      )}

      {/* Global actions — desktop & sm+ tablet: inline strip. */}
      <div className="hidden sm:flex items-center gap-1 shrink-0 border-l pl-2 ml-1">
        <Button
          variant="ghost"
          size="sm"
          className="flex items-center gap-2 text-muted-foreground h-8 px-2.5"
          onClick={onSearchClick}
        >
          <Search className="h-3.5 w-3.5" />
          <kbd className="pointer-events-none inline-flex h-5 select-none items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </Button>
        <CopyLinkButton />
        <TimerWidget />
        <InboxDropdown />
        <LanguageToggle />
        <ThemeToggle />
      </div>

      {/* Phone overflow: search always visible, others in a popover.
          Each child component keeps its own dropdown behavior (Radix supports
          nested popovers); they render full-size inside, not as menu items. */}
      <div className="flex sm:hidden items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          onClick={onSearchClick}
          aria-label="Cerca"
        >
          <Search className="h-5 w-5" />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              aria-label="Altre azioni"
            >
              <MoreVertical className="h-5 w-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            className="w-auto p-2 flex flex-col items-stretch gap-1"
          >
            <CopyLinkButton />
            <TimerWidget />
            <InboxDropdown />
            <LanguageToggle />
            <ThemeToggle />
          </PopoverContent>
        </Popover>
      </div>
    </header>
  );
}
