import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Sun,
  Mail,
  Kanban,
  Users,
  Handshake,
  FolderKanban,
  Calendar,
  FileText,
  Image,
  Sparkles,
  Globe,
  Receipt,
  Package,
  BarChart3,
  Settings,
  FileSignature,
  Workflow,
  Brain,
  StickyNote,
  PenTool,
  GitBranch,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/use-i18n';
import { useLocalizedPath } from '@/hooks/use-localized-navigation';

interface NavItem {
  labelKey: string;
  icon: LucideIcon;
  path: string;
  end?: boolean;
}

interface NavGroup {
  labelKey: string | null;
  items: NavItem[];
}

const navigation: NavGroup[] = [
  {
    labelKey: null,
    items: [
      { labelKey: 'nav.today', icon: Sun, path: '/oggi' },
      { labelKey: 'nav.dashboard', icon: LayoutDashboard, path: '/', end: true },
      { labelKey: 'nav.mail', icon: Mail, path: '/posta' },
    ],
  },
  {
    labelKey: 'nav.crm',
    items: [
      { labelKey: 'nav.pipeline', icon: Kanban, path: '/pipeline' },
      { labelKey: 'nav.clients', icon: Users, path: '/clienti' },
      { labelKey: 'nav.collaborators', icon: Handshake, path: '/collaboratori' },
    ],
  },
  {
    labelKey: 'nav.sales',
    items: [
      { labelKey: 'nav.quotes', icon: FileSignature, path: '/preventivi' },
    ],
  },
  {
    labelKey: 'nav.work',
    items: [
      { labelKey: 'nav.projects', icon: FolderKanban, path: '/progetti' },
      { labelKey: 'nav.calendar', icon: Calendar, path: '/calendario', end: true },
      { labelKey: 'nav.calendar.calendars', icon: Calendar, path: '/calendario/calendari' },
      { labelKey: 'nav.calendar.bookings', icon: Calendar, path: '/calendario/prenotazioni' },
      { labelKey: 'nav.calendar.availability', icon: Calendar, path: '/calendario/disponibilita' },
      { labelKey: 'nav.calendar.eventTypes', icon: Calendar, path: '/calendario/event-types' },
    ],
  },
  {
    labelKey: 'nav.content',
    items: [
      { labelKey: 'nav.blog', icon: FileText, path: '/blog', end: true },
      { labelKey: 'nav.portfolio', icon: Image, path: '/portfolio' },
      { labelKey: 'nav.aiGenerator', icon: Sparkles, path: '/blog/ai' },
    ],
  },
];

const brainItems: NavItem[] = [
  { labelKey: 'nav.overview', icon: Brain, path: '/brain' },
  { labelKey: 'nav.notes', icon: StickyNote, path: '/notes' },
  { labelKey: 'nav.sketch', icon: PenTool, path: '/boards/sketch' },
  { labelKey: 'nav.mindMaps', icon: GitBranch, path: '/boards/mindmap' },
];

const bottomNavigation: NavGroup[] = [
  {
    labelKey: 'nav.automations',
    items: [
      { labelKey: 'nav.workflow', icon: Workflow, path: '/workflows' },
    ],
  },
  {
    labelKey: 'nav.tools',
    items: [
      { labelKey: 'nav.domains', icon: Globe, path: '/domini' },
      { labelKey: 'nav.billing', icon: Receipt, path: '/fatturazione' },
      { labelKey: 'nav.services', icon: Package, path: '/servizi' },
      { labelKey: 'nav.analytics', icon: BarChart3, path: '/analytics' },
    ],
  },
];

const settingsItem: NavItem = {
  labelKey: 'nav.settings',
  icon: Settings,
  path: '/impostazioni',
};

function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { t } = useI18n();
  const localizedPath = useLocalizedPath();
  const label = t(item.labelKey);
  const to = localizedPath(item.path);
  const linkContent = (
    <NavLink
      to={to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          'flex items-center transition-all duration-150',
          collapsed
            ? 'justify-center rounded-md p-1.5'
            : 'gap-3 rounded-md px-3 py-2 text-sm',
          isActive
            ? collapsed ? 'bg-primary/15 text-primary' : 'nav-item-active'
            : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground font-normal'
        )
      }
    >
      <item.icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return linkContent;
}

export function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col">
      <nav className={cn(
        'flex-1 overflow-y-auto scrollbar-auto',
        collapsed ? 'py-1.5 flex flex-col items-center space-y-0.5' : 'p-3 space-y-5'
      )}>
        {navigation.map((group, i) => (
          <div key={i} className={collapsed ? 'w-full flex flex-col items-center' : ''}>
            {group.labelKey && !collapsed && (
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50">
                {t(group.labelKey)}
              </p>
            )}
            <div className={cn(collapsed ? 'space-y-0.5 flex flex-col items-center' : 'space-y-1')}>
              {group.items.map((item) => (
                <NavItemLink key={item.path} item={item} collapsed={collapsed} />
              ))}
            </div>
          </div>
        ))}

        <div className={collapsed ? 'w-full flex flex-col items-center' : ''}>
          {!collapsed && (
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50">
              {t('nav.secondBrain')}
            </p>
          )}
          <div className={cn(collapsed ? 'space-y-0.5 flex flex-col items-center' : 'space-y-1')}>
            {brainItems.map((item) => (
              <NavItemLink key={item.path} item={item} collapsed={collapsed} />
            ))}
          </div>
        </div>

        {bottomNavigation.map((group, i) => (
          <div key={`b${i}`} className={collapsed ? 'w-full flex flex-col items-center' : ''}>
            {group.labelKey && !collapsed && (
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50">
                {t(group.labelKey)}
              </p>
            )}
            <div className={cn(collapsed ? 'space-y-0.5 flex flex-col items-center' : 'space-y-1')}>
              {group.items.map((item) => (
                <NavItemLink key={item.path} item={item} collapsed={collapsed} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className={cn('border-t border-foreground/5 flex', collapsed ? 'py-1.5 justify-center' : 'p-3')}>
        <NavItemLink item={settingsItem} collapsed={collapsed} />
      </div>
    </div>
  );
}
