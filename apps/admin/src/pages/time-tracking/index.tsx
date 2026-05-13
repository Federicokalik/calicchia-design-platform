import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Timer, Activity } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

interface TimeEntry {
  id: string;
  project_id: string;
  project_name?: string | null;
  task_id?: string | null;
  task_title?: string | null;
  user_id: string;
  start_time: string;
  end_time: string | null;
  duration_minutes: number | null;
  is_billable: boolean;
  description: string | null;
}

interface ProjectListItem {
  id: string;
  name: string;
  customer_name?: string | null;
}

type BillableFilter = 'all' | 'billable' | 'non_billable';

function formatHM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function isoToDayKey(iso: string): string {
  // Local-day grouping (Europe/Rome). Use toLocaleDateString with en-CA → YYYY-MM-DD.
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
}

function formatDayLabel(dayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  return d.toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export default function TimeTrackingPage() {
  useTopbar({
    title: 'Time tracking',
    subtitle: 'Ore lavorate per progetto, fatturabili e non',
  });

  const [projectId, setProjectId] = useState<string>('all');
  const [billable, setBillable] = useState<BillableFilter>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  const { data: projectsData } = useQuery<{ projects: ProjectListItem[] }>({
    queryKey: ['client-projects', 'time-tracking-filter'],
    queryFn: () => apiFetch('/api/client-projects?limit=100'),
  });

  const projects = projectsData?.projects ?? [];

  const queryKey = ['time-entries', projectId, billable, dateFrom, dateTo] as const;
  const { data: entriesData, isLoading } = useQuery<{
    entries: TimeEntry[];
    count: number;
    totalMinutes: number;
    billableMinutes: number;
  }>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (projectId !== 'all') params.set('project_id', projectId);
      return apiFetch(`/api/time-entries?${params.toString()}`);
    },
  });

  const rawEntries = entriesData?.entries ?? [];

  // Filtraggio client-side per billable + date range (l'endpoint non li supporta nativamente).
  const filtered = useMemo(() => {
    return rawEntries.filter((e) => {
      if (billable === 'billable' && !e.is_billable) return false;
      if (billable === 'non_billable' && e.is_billable) return false;
      if (dateFrom && e.start_time < dateFrom) return false;
      if (dateTo && e.start_time > `${dateTo}T23:59:59`) return false;
      return true;
    });
  }, [rawEntries, billable, dateFrom, dateTo]);

  const grouped = useMemo(() => {
    const map = new Map<string, TimeEntry[]>();
    for (const e of filtered) {
      const key = isoToDayKey(e.start_time);
      const list = map.get(key);
      if (list) list.push(e);
      else map.set(key, [e]);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const totals = useMemo(() => {
    let total = 0;
    let billableMin = 0;
    let running = 0;
    for (const e of filtered) {
      if (e.end_time === null) {
        running++;
        continue;
      }
      const m = e.duration_minutes ?? 0;
      total += m;
      if (e.is_billable) billableMin += m;
    }
    return {
      totalMinutes: total,
      billableMinutes: billableMin,
      nonBillableMinutes: total - billableMin,
      runningCount: running,
    };
  }, [filtered]);

  return (
    <div className="space-y-6">
      {/* Filtri */}
      <div className="rounded-xl border bg-card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1">
            <Label className="text-xs font-medium">Progetto</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Tutti i progetti" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tutti i progetti</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.customer_name ? ` · ${p.customer_name}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">Fatturabile</Label>
            <Select value={billable} onValueChange={(v) => setBillable(v as BillableFilter)}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tutte</SelectItem>
                <SelectItem value="billable">Solo fatturabili</SelectItem>
                <SelectItem value="non_billable">Solo non fatturabili</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">Dal</Label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-9 text-sm"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">Al</Label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Totali */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Totale ore</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{formatHM(totals.totalMinutes)}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Fatturabili</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatHM(totals.billableMinutes)}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Non fatturabili</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums text-muted-foreground">
            {formatHM(totals.nonBillableMinutes)}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Timer in corso</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums flex items-center gap-2">
            {totals.runningCount}
            {totals.runningCount > 0 && <Activity className="h-4 w-4 text-red-500" />}
          </p>
        </div>
      </div>

      {/* Lista raggruppata per giorno */}
      {isLoading ? (
        <LoadingState />
      ) : grouped.length === 0 ? (
        <EmptyState
          title="Nessuna voce di tempo"
          description="Avvia il timer dal topbar o aggiungi voci manuali per popolare questa lista."
          icon={Timer}
        />
      ) : (
        <div className="space-y-5">
          {grouped.map(([dayKey, entries]) => {
            const dayTotal = entries.reduce((s, e) => s + (e.duration_minutes ?? 0), 0);
            return (
              <div key={dayKey} className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-semibold capitalize">{formatDayLabel(dayKey)}</h2>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatHM(dayTotal)}
                  </span>
                </div>
                <div className="rounded-lg border bg-card divide-y">
                  {entries.map((e) => {
                    const running = e.end_time === null;
                    const startTime = new Date(e.start_time).toLocaleTimeString('it-IT', {
                      hour: '2-digit',
                      minute: '2-digit',
                    });
                    const endTime = e.end_time
                      ? new Date(e.end_time).toLocaleTimeString('it-IT', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—';
                    return (
                      <div key={e.id} className="px-4 py-3 flex items-center gap-3">
                        <span
                          className={cn(
                            'shrink-0 inline-block size-1.5 rounded-full',
                            running ? 'bg-red-500 animate-pulse' : e.is_billable ? 'bg-emerald-500' : 'bg-muted-foreground/50',
                          )}
                          aria-hidden
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {e.project_name || 'Progetto sconosciuto'}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {e.task_title && <span className="mr-2">· {e.task_title}</span>}
                            {e.description || (running ? 'Timer in corso' : '')}
                          </p>
                        </div>
                        <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {startTime} → {endTime}
                          </span>
                          <span className="text-sm font-semibold tabular-nums">
                            {running ? 'in corso' : formatHM(e.duration_minutes ?? 0)}
                          </span>
                        </div>
                        {!e.is_billable && (
                          <Badge variant="outline" className="text-[10px] shrink-0">non fatt.</Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
