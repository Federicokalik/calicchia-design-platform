import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Kanban, Users, FolderKanban, Calendar,
  FileText, Image, Sparkles, Globe, Receipt, BarChart3, Settings,
  FileSignature, Plus, User,
  StickyNote, PenTool, GitBranch, Workflow, Brain,
  type LucideIcon,
} from 'lucide-react';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command';
import { useI18n } from '@/hooks/use-i18n';
import { useLocalizedNavigate } from '@/hooks/use-localized-navigation';
import { apiFetch } from '@/lib/api';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CommandLink {
  labelKey: string;
  icon: LucideIcon;
  path: string;
}

const pages: CommandLink[] = [
  { labelKey: 'nav.dashboard', icon: LayoutDashboard, path: '/' },
  { labelKey: 'nav.pipeline', icon: Kanban, path: '/pipeline' },
  { labelKey: 'nav.clients', icon: Users, path: '/clienti' },
  { labelKey: 'nav.quotes', icon: FileSignature, path: '/preventivi' },
  { labelKey: 'nav.projects', icon: FolderKanban, path: '/progetti' },
  { labelKey: 'nav.calendar', icon: Calendar, path: '/calendario' },
  { labelKey: 'nav.blog', icon: FileText, path: '/blog' },
  { labelKey: 'nav.portfolio', icon: Image, path: '/portfolio' },
  { labelKey: 'nav.aiGenerator', icon: Sparkles, path: '/blog/ai' },
  { labelKey: 'nav.secondBrain', icon: Brain, path: '/brain' },
  { labelKey: 'nav.notes', icon: StickyNote, path: '/notes' },
  { labelKey: 'nav.sketch', icon: PenTool, path: '/boards/sketch' },
  { labelKey: 'nav.mindMaps', icon: GitBranch, path: '/boards/mindmap' },
  { labelKey: 'nav.workflow', icon: Workflow, path: '/workflows' },
  { labelKey: 'nav.domains', icon: Globe, path: '/domini' },
  { labelKey: 'nav.billing', icon: Receipt, path: '/fatturazione' },
  { labelKey: 'nav.analytics', icon: BarChart3, path: '/analytics' },
  { labelKey: 'nav.settings', icon: Settings, path: '/impostazioni' },
];

const quickActions: CommandLink[] = [
  { labelKey: 'command.newQuote', icon: Plus, path: '/preventivi/new' },
  { labelKey: 'command.newBlogPost', icon: Plus, path: '/blog/new' },
  { labelKey: 'command.newPortfolioProject', icon: Plus, path: '/portfolio/new' },
  { labelKey: 'command.newNote', icon: Plus, path: '/notes' },
  { labelKey: 'command.newSketch', icon: Plus, path: '/boards/sketch' },
  { labelKey: 'command.newMindMap', icon: Plus, path: '/boards/mindmap' },
];

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const localizedNavigate = useLocalizedNavigate();
  const { t } = useI18n();
  const [search, setSearch] = useState('');

  const { data: customerResults } = useQuery({
    queryKey: ['cmd-customers', search],
    queryFn: () => apiFetch(`/api/customers?search=${search}&limit=5`),
    enabled: open && search.length >= 2,
  });

  const { data: _leadResults } = useQuery({
    queryKey: ['cmd-leads', search],
    queryFn: () => apiFetch(`/api/leads?search=${search}`),
    enabled: open && search.length >= 2,
  });

  const { data: noteResults } = useQuery({
    queryKey: ['cmd-notes', search],
    queryFn: () => apiFetch(`/api/notes?search=${search}&limit=5`),
    enabled: open && search.length >= 2,
  });

  const customers = customerResults?.customers || [];
  const searchedNotes = noteResults?.notes || [];

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const runAction = (path: string) => {
    localizedNavigate(path);
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={t('command.placeholder')}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>{t('command.empty')}</CommandEmpty>

        {customers.length > 0 && (
          <>
            <CommandGroup heading={t('command.customers')}>
              {customers.map((c: any) => (
                <CommandItem key={c.id} value={`cliente ${c.contact_name} ${c.company_name || ''}`} onSelect={() => runAction(`/clienti/${c.id}`)}>
                  <User className="mr-2 h-4 w-4" />
                  <span>{c.contact_name}</span>
                  {c.company_name && <span className="ml-2 text-muted-foreground text-xs">{c.company_name}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {searchedNotes.length > 0 && (
          <>
            <CommandGroup heading={t('command.notes')}>
              {searchedNotes.map((n: any) => (
                <CommandItem key={n.id} value={`nota ${n.title}`} onSelect={() => runAction(`/notes/${n.id}`)}>
                  <StickyNote className="mr-2 h-4 w-4" />
                  <span>{n.title}</span>
                  {n.tags?.length > 0 && <span className="ml-2 text-muted-foreground text-[10px]">{n.tags.slice(0, 2).join(', ')}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading={t('command.pages')}>
          {pages.map((page) => {
            const label = t(page.labelKey);
            return (
              <CommandItem key={page.path} value={label} onSelect={() => runAction(page.path)}>
                <page.icon className="mr-2 h-4 w-4" />
                {label}
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t('command.quickActions')}>
          {quickActions.map((action) => {
            const label = t(action.labelKey);
            return (
              <CommandItem key={action.path} value={label} onSelect={() => runAction(action.path)}>
                <action.icon className="mr-2 h-4 w-4" />
                {label}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
