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
  MessageCircle,
  Sparkles,
  Globe,
  Receipt,
  Package,
  BarChart3,
  Settings,
  FileSignature,
  PenLine,
  Workflow,
  Brain,
  StickyNote,
  PenTool,
  GitBranch,
  Timer,
  Calculator,
  Wallet,
  Inbox,
  MailPlus,
  Megaphone,
  ShieldAlert,
  Cookie,
  HelpCircle,
  UsersRound,
  BookText,
  MapPin,
  Layers,
  Lightbulb,
  Compass,
  Briefcase,
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
      { labelKey: 'nav.whatsapp', icon: MessageCircle, path: '/whatsapp' },
    ],
  },
  {
    labelKey: 'nav.crm',
    items: [
      { labelKey: 'nav.pipeline', icon: Kanban, path: '/pipeline' },
      { labelKey: 'nav.contacts', icon: Inbox, path: '/contatti' },
      { labelKey: 'nav.clients', icon: Users, path: '/clienti' },
      { labelKey: 'nav.collaborators', icon: Handshake, path: '/collaboratori' },
    ],
  },
  {
    labelKey: 'nav.sales',
    items: [
      { labelKey: 'nav.quotes', icon: FileSignature, path: '/preventivi' },
      { labelKey: 'nav.signatures', icon: PenLine, path: '/firme' },
    ],
  },
  {
    labelKey: 'nav.projectsTime',
    items: [
      { labelKey: 'nav.projects', icon: FolderKanban, path: '/progetti' },
      { labelKey: 'nav.timeTracking', icon: Timer, path: '/time-tracking' },
      // Calendario è una singola voce: le sotto-pagine vivono come tab dentro /calendario.
      { labelKey: 'nav.calendar', icon: Calendar, path: '/calendario' },
    ],
  },
  {
    labelKey: 'nav.finance',
    items: [
      { labelKey: 'nav.billing', icon: Receipt, path: '/fatturazione' },
      { labelKey: 'nav.expenses', icon: Wallet, path: '/spese' },
      { labelKey: 'nav.taxes', icon: Calculator, path: '/tasse' },
    ],
  },
  {
    labelKey: 'nav.content',
    items: [
      { labelKey: 'nav.blog', icon: FileText, path: '/blog', end: true },
      { labelKey: 'nav.portfolio', icon: Image, path: '/portfolio' },
      { labelKey: 'nav.aiGenerator', icon: Sparkles, path: '/blog/ai' },
      // CMS pubblico — unito qui con Blog/Portfolio invece di un gruppo
      // separato in fondo alla sidebar (era nav.cms in bottomNavigation).
      { labelKey: 'nav.cmsServices', icon: Layers, path: '/cms/services' },
      { labelKey: 'nav.cmsTeam', icon: UsersRound, path: '/cms/team' },
      { labelKey: 'nav.cmsFaq', icon: HelpCircle, path: '/cms/faq' },
      { labelKey: 'nav.cmsGlossario', icon: BookText, path: '/cms/glossario' },
      { labelKey: 'nav.cmsSeoCities', icon: MapPin, path: '/cms/seo-cities' },
      { labelKey: 'nav.cmsCuriosita', icon: Lightbulb, path: '/cms/curiosita' },
      { labelKey: 'nav.cmsApproach', icon: Compass, path: '/cms/approach' },
      { labelKey: 'nav.cmsClients', icon: Briefcase, path: '/cms/clients' },
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
    labelKey: 'nav.automationsAnalytics',
    items: [
      { labelKey: 'nav.workflow', icon: Workflow, path: '/workflows' },
      { labelKey: 'nav.analytics', icon: BarChart3, path: '/analytics' },
    ],
  },
  {
    labelKey: 'nav.infrastructure',
    items: [
      { labelKey: 'nav.domains', icon: Globe, path: '/domini' },
      { labelKey: 'nav.services', icon: Package, path: '/servizi' },
    ],
  },
  {
    labelKey: 'nav.marketing',
    items: [
      { labelKey: 'nav.campaigns', icon: Megaphone, path: '/marketing/campagne' },
      { labelKey: 'nav.newsletter', icon: MailPlus, path: '/marketing/newsletter' },
    ],
  },
  {
    labelKey: 'nav.privacy',
    items: [
      { labelKey: 'nav.gdprRequests', icon: ShieldAlert, path: '/privacy/gdpr-requests' },
      { labelKey: 'nav.cookieConsent', icon: Cookie, path: '/privacy/cookie-consent' },
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
          // min-h-11 guarantees 44px touch target on mobile (lg+ shrinks via
          // override below). Below lg we keep desktop density but compliant.
          'flex items-center transition-all duration-150 min-h-11 lg:min-h-0',
          collapsed
            ? 'justify-center rounded-md p-1.5 lg:p-1.5'
            : 'gap-3 rounded-md px-3 py-2.5 lg:py-2 text-sm',
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
