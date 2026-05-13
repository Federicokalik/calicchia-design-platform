import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Eye, Users, Activity, MousePointer2, Clock, Smartphone,
  Trash2, Download, Plus, Target, Zap, FileBarChart, Layers, MapPin, Gauge,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch, API_BASE } from '@/lib/api';
import { StatCard } from '@/components/analytics/stat-card';
import { PeriodSelector, type PeriodValue } from '@/components/analytics/period-selector';
import { TimeseriesChart } from '@/components/analytics/timeseries-chart';
import { BreakdownTable } from '@/components/analytics/breakdown-table';
import { RealtimePanel } from '@/components/analytics/realtime-panel';
import { FunnelView } from '@/components/analytics/funnel-view';

type OverviewKpis = {
  pageviews: number;
  visitors: number;
  sessions: number;
  bounce_rate: number;
  avg_duration_ms: number;
};

type Overview = {
  current: OverviewKpis;
  previous: OverviewKpis | null;
  delta: Record<string, number | null> | null;
};

function formatDuration(ms: number): string {
  if (!ms) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
}

function granularityFor(period: PeriodValue): 'hour' | 'day' {
  return period === '24h' ? 'hour' : 'day';
}

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<PeriodValue>('30d');
  const [compare, setCompare] = useState(false);
  const granularity = granularityFor(period);

  useTopbar({
    title: 'Analytics',
    subtitle: 'Statistiche cookieless di prima parte',
    actions: (
      <PeriodSelector period={period} onPeriodChange={setPeriod} compare={compare} onCompareChange={setCompare} />
    ),
  });

  const periodKey = [period, compare];

  const { data: overview, isLoading: ovLoading } = useQuery<Overview>({
    queryKey: ['analytics-overview', ...periodKey],
    queryFn: () => apiFetch(`/api/analytics/overview?period=${period}&compare=${compare}`),
  });

  const { data: ts } = useQuery<{ series: Array<{ bucket: string; value: number }>; seriesPrev: Array<{ bucket: string; value: number }> | null }>({
    queryKey: ['analytics-timeseries', ...periodKey, granularity, 'pageviews'],
    queryFn: () => apiFetch(`/api/analytics/timeseries?period=${period}&granularity=${granularity}&metric=pageviews&compare=${compare}`),
  });

  const tsData = useMemo(() => {
    const cur = ts?.series ?? [];
    const prev = ts?.seriesPrev ?? null;
    return cur.map((p, i) => ({
      bucket: p.bucket,
      value: p.value,
      valuePrev: prev?.[i]?.value ?? null,
    }));
  }, [ts]);

  const cur = overview?.current;
  const delta = overview?.delta;

  return (
    <div className="space-y-6">
      <Tabs defaultValue="overview" className="space-y-5">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview" className="gap-1.5"><Activity className="h-3.5 w-3.5" />Overview</TabsTrigger>
          <TabsTrigger value="pages" className="gap-1.5"><FileBarChart className="h-3.5 w-3.5" />Pagine</TabsTrigger>
          <TabsTrigger value="sources" className="gap-1.5"><Layers className="h-3.5 w-3.5" />Sorgenti</TabsTrigger>
          <TabsTrigger value="tech" className="gap-1.5"><Smartphone className="h-3.5 w-3.5" />Tecnologia</TabsTrigger>
          <TabsTrigger value="geo" className="gap-1.5"><MapPin className="h-3.5 w-3.5" />Geo</TabsTrigger>
          <TabsTrigger value="events" className="gap-1.5"><MousePointer2 className="h-3.5 w-3.5" />Eventi</TabsTrigger>
          <TabsTrigger value="perf" className="gap-1.5"><Gauge className="h-3.5 w-3.5" />Performance</TabsTrigger>
          <TabsTrigger value="goals" className="gap-1.5"><Target className="h-3.5 w-3.5" />Goals</TabsTrigger>
          <TabsTrigger value="realtime" className="gap-1.5"><Zap className="h-3.5 w-3.5" />Real-time</TabsTrigger>
        </TabsList>

        {/* ─── OVERVIEW ────────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-5">
          {ovLoading ? <LoadingState /> : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
                <StatCard title="Visualizzazioni" value={(cur?.pageviews ?? 0).toLocaleString('it-IT')} icon={Eye} deltaPercent={delta?.pageviews} />
                <StatCard title="Visitatori" value={(cur?.visitors ?? 0).toLocaleString('it-IT')} icon={Users} deltaPercent={delta?.visitors} />
                <StatCard title="Sessioni" value={(cur?.sessions ?? 0).toLocaleString('it-IT')} icon={Activity} deltaPercent={delta?.sessions} />
                <StatCard title="Bounce rate" value={`${cur?.bounce_rate ?? 0}%`} icon={MousePointer2} deltaPercent={delta?.bounce_rate} inverse />
                <StatCard title="Durata media" value={formatDuration(cur?.avg_duration_ms ?? 0)} icon={Clock} deltaPercent={delta?.avg_duration_ms} />
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Visualizzazioni nel tempo</CardTitle>
                </CardHeader>
                <CardContent>
                  <TimeseriesChart data={tsData} granularity={granularity} metricLabel="Visualizzazioni" showCompare={compare} />
                </CardContent>
              </Card>

              <OverviewBreakdowns period={period} />
            </>
          )}
        </TabsContent>

        {/* ─── PAGINE ────────────────────────────────────────────────────────── */}
        <TabsContent value="pages">
          <BreakdownCard dimension="page" period={period} title="Top pagine" limit={50} />
        </TabsContent>

        {/* ─── SORGENTI ──────────────────────────────────────────────────────── */}
        <TabsContent value="sources">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <BreakdownCard dimension="referrer" period={period} title="Top referrer" limit={20} />
            <BreakdownCard dimension="utm_source" period={period} title="UTM source" limit={20} />
            <BreakdownCard dimension="utm_medium" period={period} title="UTM medium" limit={20} />
            <BreakdownCard dimension="utm_campaign" period={period} title="UTM campaign" limit={20} />
          </div>
        </TabsContent>

        {/* ─── TECNOLOGIA ────────────────────────────────────────────────────── */}
        <TabsContent value="tech">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <BreakdownCard dimension="browser" period={period} title="Browser" limit={20} />
            <BreakdownCard dimension="os" period={period} title="Sistema operativo" limit={20} />
            <BreakdownCard dimension="device" period={period} title="Dispositivo" limit={10} />
          </div>
        </TabsContent>

        {/* ─── GEO ───────────────────────────────────────────────────────────── */}
        <TabsContent value="geo">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <BreakdownCard dimension="country" period={period} title="Paesi" limit={30} />
            <BreakdownCard dimension="city" period={period} title="Città" limit={30} />
          </div>
        </TabsContent>

        {/* ─── EVENTI ─────────────────────────────────────────────────────────── */}
        <TabsContent value="events">
          <EventsTab period={period} />
        </TabsContent>

        {/* ─── PERFORMANCE (Web Vitals) ──────────────────────────────────────── */}
        <TabsContent value="perf">
          <WebVitalsTab period={period} />
        </TabsContent>

        {/* ─── GOALS ─────────────────────────────────────────────────────────── */}
        <TabsContent value="goals">
          <GoalsTab period={period} />
        </TabsContent>

        {/* ─── REAL-TIME ─────────────────────────────────────────────────────── */}
        <TabsContent value="realtime">
          <RealtimePanel />
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`${API_BASE}/api/analytics/export?period=${period}&format=csv`, '_blank')}
        >
          <Download className="h-3.5 w-3.5 mr-1.5" /> Esporta CSV
        </Button>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function OverviewBreakdowns({ period }: { period: PeriodValue }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <BreakdownCard dimension="page" period={period} title="Top pagine" limit={8} compact />
      <BreakdownCard dimension="referrer" period={period} title="Sorgenti" limit={8} compact />
      <BreakdownCard dimension="country" period={period} title="Paesi" limit={8} compact />
    </div>
  );
}

function BreakdownCard({ dimension, period, title, limit = 20, compact }: {
  dimension: string; period: PeriodValue; title: string; limit?: number; compact?: boolean;
}) {
  const { data } = useQuery<{ rows: Array<{ key: string | null; label: string; pageviews: number; visitors: number; sessions: number }> }>({
    queryKey: ['analytics-breakdown', dimension, period, limit],
    queryFn: () => apiFetch(`/api/analytics/breakdown?dimension=${dimension}&period=${period}&limit=${limit}`),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <BreakdownTable rows={data?.rows ?? []} emptyText="Nessun dato per il periodo" />
        {!compact && data && data.rows.length === limit && (
          <p className="text-[10px] text-muted-foreground mt-2 text-center">Limite {limit} righe</p>
        )}
      </CardContent>
    </Card>
  );
}

function EventsTab({ period }: { period: PeriodValue }) {
  const { data } = useQuery<{ events: Array<{ name: string; count: number; unique_visitors: number; last_seen: string }> }>({
    queryKey: ['analytics-events', period],
    queryFn: () => apiFetch(`/api/analytics/events?period=${period}`),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Eventi custom</CardTitle>
      </CardHeader>
      <CardContent>
        {(!data?.events || data.events.length === 0) ? (
          <EmptyState
            title="Nessun evento custom"
            description='Usa il payload type:"event" e event_name dal sito per tracciare eventi.'
            icon={MousePointer2}
          />
        ) : (
          <div className="divide-y divide-border/50">
            {data.events.map((e) => (
              <div key={e.name} className="flex items-center gap-3 py-2 text-xs">
                <span className="flex-1 truncate font-medium">{e.name}</span>
                <Badge variant="outline" className="text-[10px] h-5">{e.unique_visitors} visitatori unici</Badge>
                <span className="tabular-nums font-semibold w-16 text-right">{e.count.toLocaleString('it-IT')}</span>
                <span className="text-muted-foreground w-32 text-right">
                  {new Date(e.last_seen).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WebVitalsTab({ period }: { period: PeriodValue }) {
  const { data } = useQuery<{ metrics: Array<{ metric: string; count: number; p75: number; p95: number; rating: string }> }>({
    queryKey: ['analytics-web-vitals', period],
    queryFn: () => apiFetch(`/api/analytics/web-vitals?period=${period}`),
  });

  const ratingColor = (r: string) =>
    r === 'good' ? 'text-emerald-600 bg-emerald-500/10' :
    r === 'needs_improvement' ? 'text-amber-600 bg-amber-500/10' :
    r === 'poor' ? 'text-red-600 bg-red-500/10' :
    'text-muted-foreground bg-muted';

  const fmtValue = (metric: string, v: number) => {
    if (metric === 'CLS') return v.toFixed(3);
    return `${Math.round(v)}ms`;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Core Web Vitals (p75)</CardTitle>
      </CardHeader>
      <CardContent>
        {(!data?.metrics || data.metrics.length === 0) ? (
          <EmptyState
            title="Nessuna metrica Web Vitals"
            description="Le metriche LCP/CLS/INP arrivano dal sito tramite WebVitalsTracker."
            icon={Gauge}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {data.metrics.map((m) => (
              <div key={m.metric} className="rounded-lg border bg-card p-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-muted-foreground">{m.metric}</span>
                  <span className={`text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${ratingColor(m.rating)}`}>
                    {m.rating.replace('_', ' ')}
                  </span>
                </div>
                <div className="text-2xl font-bold">{fmtValue(m.metric, m.p75)}</div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  p95 {fmtValue(m.metric, m.p95)} · {m.count} sample
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GoalsTab({ period }: { period: PeriodValue }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<'pageview' | 'event'>('pageview');
  const [path, setPath] = useState('');
  const [eventName, setEventName] = useState('');

  const { data } = useQuery<{ goals: Array<{ id: string; name: string; type: string; conditions: any; active: boolean; conversions: number }> }>({
    queryKey: ['analytics-goals', period],
    queryFn: () => apiFetch(`/api/analytics/goals?period=${period}`),
  });

  const createGoal = useMutation({
    mutationFn: () => apiFetch('/api/analytics/goals', {
      method: 'POST',
      body: JSON.stringify({
        name,
        type,
        conditions: type === 'pageview' ? { type: 'pageview', path } : { type: 'event', event_name: eventName },
        active: true,
      }),
    }),
    onSuccess: () => {
      toast.success('Goal creato');
      setOpen(false);
      setName(''); setPath(''); setEventName('');
      queryClient.invalidateQueries({ queryKey: ['analytics-goals'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Errore'),
  });

  const deleteGoal = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/analytics/goals/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['analytics-goals'] });
      toast.success('Goal eliminato');
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Definisci obiettivi di conversione e monitorane il rate.</p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-3.5 w-3.5 mr-1.5" /> Nuovo goal</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Nuovo goal</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Nome</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Es. Contatti compilato" />
              </div>
              <div>
                <Label className="text-xs">Tipo</Label>
                <Select value={type} onValueChange={(v) => setType(v as 'pageview' | 'event')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pageview">Visita pagina</SelectItem>
                    <SelectItem value="event">Evento custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {type === 'pageview' ? (
                <div>
                  <Label className="text-xs">Path della pagina</Label>
                  <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/it/contatti" />
                </div>
              ) : (
                <div>
                  <Label className="text-xs">Nome evento</Label>
                  <Input value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="cta_click" />
                </div>
              )}
              <Button
                onClick={() => createGoal.mutate()}
                disabled={!name || (type === 'pageview' ? !path : !eventName) || createGoal.isPending}
              >
                Crea goal
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {(!data?.goals || data.goals.length === 0) ? (
        <EmptyState title="Nessun goal" description="Crea il primo goal per misurare le conversioni" icon={Target} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.goals.map((g) => (
            <Card key={g.id}>
              <CardHeader className="pb-2 flex flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-sm font-medium">{g.name}</CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-0.5 capitalize">{g.type}</p>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7 -mt-1" onClick={() => {
                  if (confirm('Eliminare questo goal?')) deleteGoal.mutate(g.id);
                }}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{g.conversions.toLocaleString('it-IT')}</div>
                <p className="text-[10px] text-muted-foreground mt-1">conversioni nel periodo</p>
                {g.type === 'funnel' && (
                  <FunnelPreview goalId={g.id} period={period} />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function FunnelPreview({ goalId, period }: { goalId: string; period: PeriodValue }) {
  const { data } = useQuery<{ steps: Array<{ step: number; count: number }> }>({
    queryKey: ['analytics-funnel', goalId, period],
    queryFn: () => apiFetch(`/api/analytics/goals/${goalId}/funnel?period=${period}`),
  });
  if (!data?.steps?.length) return null;
  return (
    <div className="mt-3 pt-3 border-t">
      <FunnelView steps={data.steps} />
    </div>
  );
}

