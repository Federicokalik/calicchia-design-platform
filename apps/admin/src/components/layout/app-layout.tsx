import { Outlet, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useSidebar } from '@/hooks/use-sidebar';
import { useCommandPalette } from '@/hooks/use-command-palette';
import { useSessionWarning } from '@/hooks/use-session-warning';
import { TopbarProvider } from '@/hooks/use-topbar';
import { AiEntityContextProvider } from '@/hooks/use-ai-entity-context';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { CommandPalette } from './command-palette';
import { AiBar } from '@/components/ai/ai-bar';

export function AppLayout() {
  const sidebar = useSidebar();
  const commandPalette = useCommandPalette();
  const location = useLocation();
  useSessionWarning();
  const hideAiBar = /^\/(boards\/(sketch|mindmap))\//.test(location.pathname);

  return (
    <TopbarProvider>
    <AiEntityContextProvider>
    <TooltipProvider>
      <div className="min-h-screen bg-muted/40">
        <Sidebar
          collapsed={sidebar.collapsed}
          onToggle={sidebar.toggle}
          mobileOpen={sidebar.mobileOpen}
          onCloseMobile={sidebar.closeMobile}
        />

        <Topbar
          onMenuClick={sidebar.toggleMobile}
          onSearchClick={commandPalette.toggle}
          sidebarCollapsed={sidebar.collapsed}
        />

        <div
          className={cn(
            'transition-all duration-200 ease-in-out',
            sidebar.collapsed ? 'lg:ml-[60px]' : 'lg:ml-[264px]'
          )}
        >
          <main className="px-4 lg:px-5 pb-4" style={{ paddingTop: '5rem' }}>
            <Outlet />
          </main>
        </div>

        {/* AI Chatbot bubble — hidden on canvas pages */}
        {!hideAiBar && <AiBar />}

        <CommandPalette
          open={commandPalette.open}
          onOpenChange={commandPalette.setOpen}
        />
      </div>
    </TooltipProvider>
    </AiEntityContextProvider>
    </TopbarProvider>
  );
}
