import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import type { CampaignReport, CampaignChannel, ReportPeriod } from '@/types/marketing';
import { metricsForChannel, deriveKpis, DERIVED_KPI_LABELS, type DerivedKpis } from '@/lib/marketing-metrics';

const PERIOD_LABELS: Record<ReportPeriod, string> = {
  daily: 'Giornaliero',
  weekly: 'Settimanale',
  monthly: 'Mensile',
  quarterly: 'Trimestrale',
  final: 'Finale',
};

function formatKpi(key: keyof DerivedKpis, value: number | null): string {
  if (value === null) return '—';
  if (key === 'ctr' || key === 'conversionRate') return `${value.toFixed(1)}%`;
  if (key === 'cpl' || key === 'cpc') return `€${value.toFixed(2)}`;
  if (key === 'roas') return `${value.toFixed(2)}×`;
  return String(value);
}

export function ReportSection({ campaignId, channel }: { campaignId: string; channel: CampaignChannel }) {
  const queryClient = useQueryClient();
  const fields = metricsForChannel(channel);
  const [showAdd, setShowAdd] = useState(false);
  const [reportDate, setReportDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [period, setPeriod] = useState<ReportPeriod>('weekly');
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['campaign-reports', campaignId],
    queryFn: () => apiFetch(`/api/marketing/campaigns/${campaignId}/reports`),
  });
  const reports: CampaignReport[] = data?.reports || [];

  const createMutation = useMutation({
    mutationFn: async () => {
      const metrics_json: Record<string, number> = {};
      for (const [k, v] of Object.entries(metrics)) {
        if (v !== '' && v != null) metrics_json[k] = Number(v);
      }
      return apiFetch(`/api/marketing/campaigns/${campaignId}/reports`, {
        method: 'POST',
        body: JSON.stringify({ report_date: reportDate, report_period: period, metrics_json, summary: summary || null }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign-reports', campaignId] });
      setShowAdd(false);
      setMetrics({});
      setSummary('');
      toast.success('Report salvato');
    },
    onError: (e: Error) => toast.error(e.message || 'Errore'),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" /> Nuovo report
        </Button>
      </div>

      {isLoading ? null : reports.length === 0 ? (
        <EmptyState icon={BarChart3} title="Nessun report" description="Inserisci le metriche periodiche per calcolare CPL, CTR, conversione e ROAS." />
      ) : (
        <div className="space-y-3">
          {reports.map((r) => {
            const kpis = deriveKpis(r.metrics_json);
            return (
              <div key={r.id} className="rounded-lg border bg-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium">
                    {new Date(r.report_date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                  <span className="text-xs text-muted-foreground">{PERIOD_LABELS[r.report_period]}</span>
                </div>
                {/* Raw metrics */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {fields.map((f) => {
                    const val = r.metrics_json?.[f.key];
                    if (val === undefined || val === null || val === '') return null;
                    return <span key={f.key}>{f.label}: <span className="font-medium text-foreground">{String(val)}</span></span>;
                  })}
                </div>
                {/* Derived KPIs */}
                <div className="flex flex-wrap gap-2 mt-3">
                  {(Object.keys(DERIVED_KPI_LABELS) as Array<keyof DerivedKpis>).map((k) => (
                    <div key={k} className="rounded-md bg-muted px-2 py-1 text-xs">
                      <span className="text-muted-foreground">{DERIVED_KPI_LABELS[k]}: </span>
                      <span className="font-semibold tabular-nums">{formatKpi(k, kpis[k])}</span>
                    </div>
                  ))}
                </div>
                {r.summary && <p className="text-sm text-muted-foreground mt-3 whitespace-pre-wrap">{r.summary}</p>}
              </div>
            );
          })}
        </div>
      )}

      {/* Add report dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Nuovo report</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Data</Label>
                <Input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Periodo</Label>
                <Select value={period} onValueChange={(v) => setPeriod(v as ReportPeriod)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(PERIOD_LABELS).map(([k, l]) => (
                      <SelectItem key={k} value={k}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label>{f.label}{f.kind === 'currency' ? ' (€)' : ''}</Label>
                  <Input
                    type="number" inputMode="decimal" step="any"
                    value={metrics[f.key] ?? ''}
                    onChange={(e) => setMetrics({ ...metrics, [f.key]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label>Note / sintesi</Label>
              <Textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Annulla</Button>
            <Button disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>Salva</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
