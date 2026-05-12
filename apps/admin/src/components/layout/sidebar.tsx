import { useNavigate } from 'react-router-dom';
import {
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  ExternalLink,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAuth } from '@/hooks/use-auth';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { SidebarNav } from './sidebar-nav';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({ collapsed, onToggle, mobileOpen, onCloseMobile }: SidebarProps) {
  const { user, signOut } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onCloseMobile}
        />
      )}

      <aside
        className={cn(
          'fixed left-0 top-0 z-50 flex flex-col sidebar-island transition-all duration-200 ease-in-out overflow-hidden',
          collapsed ? 'w-[44px]' : 'w-[248px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Header */}
        <div className={cn(
          'flex items-center border-b border-foreground/5',
          collapsed ? 'h-12 justify-center px-1' : 'h-14 justify-between px-3'
        )}>
          {!collapsed && (
            <>
              <img src="/img/logo.png" alt="Logo" className="h-7 dark:hidden" />
              <img src="/img/logo-white.png" alt="Logo" className="h-7 hidden dark:block" />
              <Button variant="ghost" size="icon" className="hidden lg:flex h-7 w-7" onClick={onToggle}>
                <ChevronsLeft className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="lg:hidden h-7 w-7" onClick={onCloseMobile}>
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
          {collapsed && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggle}>
              <ChevronsRight className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-hidden">
          <SidebarNav collapsed={collapsed} />
        </div>

        {/* User section */}
        <div className={cn('border-t border-foreground/5', collapsed ? 'py-1.5 flex flex-col items-center' : 'p-3')}>
          {!collapsed ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
                  {user?.email?.[0].toUpperCase() || 'A'}
                </div>
                <div className="flex-1 truncate">
                  <p className="text-sm font-medium truncate">{user?.email}</p>
                </div>
              </div>
              <div className="flex gap-1">
                <a
                  href="/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t('app.site')}
                </a>
                <button
                  onClick={handleSignOut}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <LogOut className="h-3 w-3" />
                  {t('app.signOut')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-0.5">
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-medium cursor-default">
                    {user?.email?.[0].toUpperCase() || 'A'}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right">{user?.email}</TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleSignOut}
                    className="flex h-5 w-5 items-center justify-center rounded text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <LogOut className="h-2.5 w-2.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{t('app.signOut')}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
