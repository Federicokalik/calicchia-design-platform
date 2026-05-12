import { Menu, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { InboxDropdown } from '@/components/layout/inbox-dropdown';
import { CopyLinkButton } from '@/components/shared/copy-link-button';
import { useTopbarState } from '@/hooks/use-topbar';
import { cn } from '@/lib/utils';
import { LanguageToggle } from './language-toggle';

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
        'fixed top-0 right-0 z-30 flex h-12 items-center gap-3 topbar-island px-4',
        sidebarCollapsed ? 'left-[60px]' : 'left-[264px]',
        'max-lg:left-0'
      )}
      style={{ transition: 'left 200ms ease-in-out' }}
    >
      {/* Mobile menu */}
      <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8" onClick={onMenuClick}>
        <Menu className="h-4 w-4" />
      </Button>

      {/* Title + subtitle */}
      <div className="flex items-baseline gap-2 min-w-0 flex-1">
        <h1 className="text-sm font-semibold text-foreground shrink-0">{title}</h1>
        {subtitle && (
          <span className="text-xs text-muted-foreground truncate hidden sm:inline">{subtitle}</span>
        )}
      </div>

      {/* Page actions (injected by each page) */}
      {actions && (
        <div className="flex items-center gap-1.5 shrink-0">
          {actions}
        </div>
      )}

      {/* Global actions */}
      <div className="flex items-center gap-1 shrink-0 border-l pl-2 ml-1">
        <Button
          variant="ghost"
          size="sm"
          className="hidden sm:flex items-center gap-2 text-muted-foreground h-8 px-2.5"
          onClick={onSearchClick}
        >
          <Search className="h-3.5 w-3.5" />
          <kbd className="pointer-events-none inline-flex h-5 select-none items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </Button>
        <Button variant="ghost" size="icon" className="sm:hidden h-8 w-8" onClick={onSearchClick}>
          <Search className="h-4 w-4" />
        </Button>
        <CopyLinkButton />
        <InboxDropdown />
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}
