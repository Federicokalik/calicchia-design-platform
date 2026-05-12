import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Flame, Sun, Clock, UserPlus, Flag, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useTopbar } from '@/hooks/use-topbar';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { TASK_STATUS_CONFIG, type TaskStatus } from '@/types/projects';
import { useI18n } from '@/hooks/use-i18n';

interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  due_date: string;
  project_id: string;
  project_name: string | null;
  days_overdue?: number;
}

interface LeadItem {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  status: string;
  estimated_value: number | null;
  updated_at: string;
  days_since_contact: number;
}

interface MyWorkPayload {
  counts: { today: number; week: number; overdue: number; recontact: number };
  today: TaskItem[];
  week: TaskItem[];
  overdue: TaskItem[];
  recontact: LeadItem[];
}

const PRIORITY_COLORS: Record<number, string> = {
  1: 'text-red-500',
  2: 'text-orange-500',
  3: 'text-amber-500',
  4: 'text-blue-500',
  5: 'text-slate-400',
};

function TaskRow({ task, extra }: { task: TaskItem; extra?: string }) {
  const navigate = useNavigate();
  const status = TASK_STATUS_CONFIG[task.status];

  return (
    <button
      type="button"
      onClick={() => navigate(`/progetti/${task.project_id}?task=${task.id}`)}
      className="group w-full flex items-center gap-2 px-3 py-2 border-b border-border/40 last:border-b-0 hover:bg-muted/50 text-left transition-colors"
    >
      <Badge variant="outline" className={cn('h-5 text-[10px] font-medium shrink-0 border-transparent', status.bgColor, status.color)}>
        {status.label}
      </Badge>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{task.title}</div>
        <div className="text-[11px] text-muted-foreground truncate">
          {task.project_name ?? '—'}
          {extra && <> · <span className="text-foreground/80">{extra}</span></>}
        </div>
      </div>
      {task.priority > 0 && (
        <Flag className={cn('h-3.5 w-3.5 shrink-0', PRIORITY_COLORS[task.priority] || 'text-muted-foreground')} />
      )}
    </button>
  );
}

function LeadRow({ lead }: { lead: LeadItem }) {
  const { t, formatCurrency } = useI18n();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate('/pipeline')}
      className="group w-full flex items-center gap-2 px-3 py-2 border-b border-border/40 last:border-b-0 hover:bg-muted/50 text-left transition-colors"
    >
      <Badge variant="outline" className="h-5 text-[10px] font-medium shrink-0">
        {lead.status}
      </Badge>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{lead.name}</div>
        <div className="text-[11px] text-muted-foreground truncate">
          {lead.company || lead.email || '—'}
          {' · '}
          <span className="text-foreground/80">
            {t('today.daysSinceContact', { days: lead.days_since_contact })}
          </span>
        </div>
      </div>
      {lead.estimated_value && (
        <span className="text-xs font-medium text-muted-foreground shrink-0">
          {formatCurrency(lead.estimated_value)}
        </span>
      )}
    </button>
  );
}

interface BucketProps {
  title: string;
  icon: typeof Sun;
  count: number;
  accent: string;
  emptyText: string;
  children: React.ReactNode;
}

function Bucket({ title, icon: Icon, count, accent, emptyText, children }: BucketProps) {
  const empty = count === 0;
  return (
    <div className="rounded-lg border bg-card overflow-hidden flex flex-col">
      <div className={cn('flex items-center gap-2 px-3 py-2.5 border-b', accent)}>
        <Icon className="h-4 w-4" />
        <h3 className="text-sm font-semibold flex-1">{title}</h3>
        <span className="text-xs font-medium tabular-nums">{count}</span>
      </div>
      <div className="flex-1 min-h-[120px] max-h-[480px] overflow-auto">
        {empty ? (
          <div className="p-6 text-center text-xs text-muted-foreground">{emptyText}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export default function OggiPage() {
  const { t, formatDate } = useI18n();
  useTopbar({ title: t('today.title'), subtitle: t('today.subtitle') });

  const { data, isLoading } = useQuery<MyWorkPayload>({
    queryKey: ['my-work'],
    queryFn: () => apiFetch('/api/my-work'),
    refetchInterval: 60_000,
  });

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return t('today.greeting.morning');
    if (h < 18) return t('today.greeting.afternoon');
    return t('today.greeting.evening');
  }, [t]);

  const totalActionable = (data?.counts.today ?? 0) + (data?.counts.overdue ?? 0);

  return (
    <div className="space-y-6">
      {/* Greeting + summary */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{greeting}, Federico</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading
            ? t('today.loading')
            : totalActionable === 0
              ? t('today.allClear')
              : t('today.actionable', { count: totalActionable })}
        </p>
      </div>

      {/* Buckets grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-4">
        <Bucket
          title={t('today.title')}
          icon={Sun}
          count={data?.counts.today ?? 0}
          accent="bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400"
          emptyText={t('today.emptyToday')}
        >
          {data?.today.map((t) => <TaskRow key={t.id} task={t} />)}
        </Bucket>

        <Bucket
          title={t('today.overdue')}
          icon={AlertTriangle}
          count={data?.counts.overdue ?? 0}
          accent="bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400"
          emptyText={t('today.emptyOverdue')}
        >
          {data?.overdue.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              extra={`-${t.days_overdue}d · ${formatDate(t.due_date, { day: 'numeric', month: 'short' })}`}
            />
          ))}
        </Bucket>

        <Bucket
          title={t('today.thisWeek')}
          icon={Clock}
          count={data?.counts.week ?? 0}
          accent="bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400"
          emptyText={t('today.emptyWeek')}
        >
          {data?.week.map((task) => <TaskRow key={task.id} task={task} extra={formatDate(task.due_date, { day: 'numeric', month: 'short' })} />)}
        </Bucket>

        <Bucket
          title={t('today.recontact')}
          icon={UserPlus}
          count={data?.counts.recontact ?? 0}
          accent="bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400"
          emptyText={t('today.emptyRecontact')}
        >
          {data?.recontact.map((l) => <LeadRow key={l.id} lead={l} />)}
        </Bucket>
      </div>

      {/* Footer hint */}
      {!isLoading && totalActionable > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Flame className="h-3 w-3 text-orange-500" />
          {t('today.tip')}
        </div>
      )}
    </div>
  );
}
