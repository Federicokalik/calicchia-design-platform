import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus, Play, Trash2, MoreHorizontal, Zap,
  AlertTriangle, Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { LoadingState } from '@/components/shared/loading-state';
import { useI18n } from '@/hooks/use-i18n';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  active: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
  paused: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
  archived: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
};

export default function WorkflowsPage() {
  const { t, formatStatus } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => apiFetch('/api/workflows'),
  });

  const createMutation = useMutation({
    mutationFn: () => apiFetch('/api/workflows', { method: 'POST', body: JSON.stringify({ name: t('workflow.new') }) }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      if (res?.workflow?.id) navigate(`/workflows/${res.workflow.id}`);
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/api/workflows/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(t('workflow.statusUpdated'));
    },
  });

  const executeMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/workflows/${id}/execute`, { method: 'POST', body: '{}' }),
    onSuccess: (res: any) => {
      toast.success(t('workflow.executed', { status: formatStatus('workflow', res.status) }));
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: () => toast.error(t('workflow.executionError')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/workflows/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(t('common.delete'));
    },
  });

  const wfs = data?.workflows || [];

  const topbarActions = useMemo(() => (
    <Button size="sm" onClick={() => createMutation.mutate()}>
      <Plus className="h-4 w-4 mr-1.5" /> {t('workflow.new')}
    </Button>
  ), [t]);

  useTopbar({
    title: t('workflow.title'),
    subtitle: t('workflow.countSubtitle', { count: wfs.length, active: wfs.filter((w: any) => w.status === 'active').length }),
    actions: topbarActions,
  });

  if (isLoading) {
    return <LoadingState />;
  }

  if (wfs.length === 0) {
    return <EmptyState title={t('workflow.empty.title')} description={t('workflow.empty.description')} icon={Zap}>
      <Button size="sm" onClick={() => createMutation.mutate()}>{t('workflow.empty.action')}</Button>
    </EmptyState>;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {wfs.map((wf: any) => (
          <div key={wf.id} className="rounded-xl border bg-card p-4 space-y-3 hover:shadow-md transition-shadow">
            <div className="flex items-start justify-between">
              <div className="min-w-0 cursor-pointer" onClick={() => navigate(`/workflows/${wf.id}`)}>
                <h3 className="text-sm font-semibold truncate">{wf.name}</h3>
                {wf.description && <p className="text-xs text-muted-foreground truncate mt-0.5">{wf.description}</p>}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0"><MoreHorizontal className="h-4 w-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => navigate(`/workflows/${wf.id}`)}>{t('common.edit')}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => executeMutation.mutate(wf.id)}>
                    <Play className="h-3.5 w-3.5 mr-2" /> {t('common.runNow')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onClick={() => { if (confirm(t('workflow.confirmDelete'))) deleteMutation.mutate(wf.id); }}>
                    <Trash2 className="h-3.5 w-3.5 mr-2" /> {t('common.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn('text-[10px]', STATUS_COLORS[wf.status])}>{formatStatus('workflow', wf.status)}</Badge>
              {wf.trigger_type && <Badge variant="outline" className="text-[10px]">{wf.trigger_type}</Badge>}
              {(() => {
                const nodes = typeof wf.nodes === 'string' ? JSON.parse(wf.nodes) : (wf.nodes || []);
                const hasAI = nodes.some((n: any) => n.type?.startsWith('llm_'));
                return hasAI ? (
                  <Badge variant="outline" className="text-[10px] border-violet-500/30 text-violet-500 bg-violet-500/5 gap-0.5">
                    <Sparkles className="h-2.5 w-2.5" /> AI
                  </Badge>
                ) : null;
              })()}
              <span className="text-[10px] text-muted-foreground ml-auto">
                {t('workflow.executions', { count: wf.execution_count || 0 })}
              </span>
            </div>

            <div className="flex items-center justify-between pt-1 border-t">
              <div className="flex items-center gap-1.5">
                <Switch
                  checked={wf.status === 'active'}
                  onCheckedChange={(v) => statusMutation.mutate({ id: wf.id, status: v ? 'active' : 'paused' })}
                />
                <span className="text-[10px] text-muted-foreground">{wf.status === 'active' ? t('common.active') : t('common.inactive')}</span>
              </div>
              {wf.last_error && (
                <div className="flex items-center gap-1 text-[10px] text-red-500">
                  <AlertTriangle className="h-3 w-3" /> {t('common.error')}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
