import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FolderKanban } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/use-i18n';

const statusColors: Record<string, string> = {
  in_progress: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  review: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  on_hold: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20',
  draft: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
};

export function WidgetProjects() {
  const { t, formatStatus } = useI18n();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['widget-projects'],
    queryFn: () => apiFetch('/api/client-projects?limit=5'),
  });

  const projects = (data?.projects || []).filter((p: any) => p.status !== 'completed' && p.status !== 'cancelled');

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <FolderKanban className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('dashboard.widgets.projects.title')}</h3>
        <span className="text-xs text-muted-foreground ml-auto">{projects.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-4">
        <div className="space-y-3">
          {projects.map((p: any) => (
            <div key={p.id} className="rounded-lg p-3 hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => navigate(`/progetti/${p.id}`)}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.customer_name || '—'}</p>
                </div>
                <Badge variant="outline" className={cn('shrink-0 text-[10px] px-1.5 py-0', statusColors[p.status] || '')}>
                  {formatStatus('project', p.status)}
                </Badge>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Progress value={p.progress_percentage || 0} className="h-1.5 flex-1" />
                <span className="text-xs text-muted-foreground w-8 text-right">{p.progress_percentage || 0}%</span>
              </div>
            </div>
          ))}
          {projects.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">{t('dashboard.widgets.projects.empty')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
