import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import { useConfirm } from '@/hooks/use-confirm';
import { apiFetch } from '@/lib/api';
import { AssetSection } from '@/components/marketing/asset-section';
import { ReportSection } from '@/components/marketing/report-section';
import { metricsForChannel } from '@/lib/marketing-metrics';
import type {
  Campaign, CampaignType, CampaignChannel, CampaignStatus,
} from '@/types/marketing';
import {
  CAMPAIGN_TYPE_LABELS, CAMPAIGN_CHANNEL_LABELS, CAMPAIGN_STATUS_LABELS, CAMPAIGN_STATUS_ORDER,
} from '@/types/marketing';

type Kpis = Record<string, string>;

interface OverviewForm {
  campaign_name: string;
  campaign_type: CampaignType;
  channel: CampaignChannel;
  status: CampaignStatus;
  currency: string;
  budget_planned: string;
  budget_actual: string;
  start_date: string;
  end_date: string;
  objective: string;
  target_audience: string;
  notes: string;
  project_id: string;
  customer_id: string;
  kpi_target: Kpis;
  kpi_actual: Kpis;
}

function toKpiStrings(obj: Record<string, number | string> | null | undefined): Kpis {
  const out: Kpis = {};
  if (obj) for (const [k, v] of Object.entries(obj)) out[k] = String(v ?? '');
  return out;
}

export default function CampagnaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState<OverviewForm | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => apiFetch(`/api/marketing/campaigns/${id}`),
  });
  const campaign: Campaign | undefined = data?.campaign;

  const { data: customersData } = useQuery({
    queryKey: ['customers-select'],
    queryFn: () => apiFetch('/api/customers?limit=100'),
  });
  const { data: projectsData } = useQuery({
    queryKey: ['client-projects-select'],
    queryFn: () => apiFetch('/api/client-projects'),
  });
  const customers = customersData?.customers || [];
  const projects = projectsData?.projects || [];

  useEffect(() => {
    if (!campaign) return;
    setForm({
      campaign_name: campaign.campaign_name || '',
      campaign_type: campaign.campaign_type,
      channel: campaign.channel,
      status: campaign.status,
      currency: campaign.currency || 'EUR',
      budget_planned: campaign.budget_planned != null ? String(campaign.budget_planned) : '',
      budget_actual: campaign.budget_actual != null ? String(campaign.budget_actual) : '',
      start_date: campaign.start_date ? campaign.start_date.slice(0, 10) : '',
      end_date: campaign.end_date ? campaign.end_date.slice(0, 10) : '',
      objective: campaign.objective || '',
      target_audience: campaign.target_audience || '',
      notes: campaign.notes || '',
      project_id: campaign.project_id || '',
      customer_id: campaign.customer_id || '',
      kpi_target: toKpiStrings(campaign.kpi_target),
      kpi_actual: toKpiStrings(campaign.kpi_actual),
    });
  }, [campaign]);

  const saveMutation = useMutation({
    mutationFn: async (f: OverviewForm) => {
      const toKpiNumbers = (k: Kpis) => {
        const out: Record<string, number> = {};
        for (const [key, v] of Object.entries(k)) if (v !== '') out[key] = Number(v);
        return out;
      };
      return apiFetch(`/api/marketing/campaigns/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          campaign_name: f.campaign_name,
          campaign_type: f.campaign_type,
          channel: f.channel,
          status: f.status,
          budget_planned: f.budget_planned === '' ? null : Number(f.budget_planned),
          budget_actual: f.budget_actual === '' ? null : Number(f.budget_actual),
          start_date: f.start_date || null,
          end_date: f.end_date || null,
          objective: f.objective || null,
          target_audience: f.target_audience || null,
          notes: f.notes || null,
          project_id: f.project_id || null,
          customer_id: f.customer_id || null,
          kpi_target: toKpiNumbers(f.kpi_target),
          kpi_actual: toKpiNumbers(f.kpi_actual),
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign', id] });
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      toast.success('Campagna salvata');
    },
    onError: (e: Error) => toast.error(e.message || 'Errore nel salvataggio'),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => apiFetch(`/api/marketing/campaigns/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      toast.success('Campagna eliminata');
      navigate('/marketing/campagne');
    },
    onError: (e: Error) => toast.error(e.message || 'Errore'),
  });

  const topbarActions = useMemo(() => (
    <Button variant="ghost" size="sm" onClick={() => navigate('/marketing/campagne')}>
      <ArrowLeft className="h-4 w-4 mr-1.5" /> Campagne
    </Button>
  ), [navigate]);

  useTopbar({
    title: campaign?.campaign_name || 'Campagna',
    subtitle: campaign ? (campaign.customer_company || campaign.customer_name || campaign.project_name || '') : '',
    actions: topbarActions,
  });

  if (isLoading || !form) return <LoadingState />;
  if (!campaign) return <div className="p-6 text-muted-foreground">Campagna non trovata.</div>;

  const kpiFields = metricsForChannel(form.channel);

  return (
    <Tabs defaultValue="overview" className="space-y-4">
      <TabsList>
        <TabsTrigger value="overview">Panoramica</TabsTrigger>
        <TabsTrigger value="assets">Asset {campaign.assets?.length ? `(${campaign.assets.length})` : ''}</TabsTrigger>
        <TabsTrigger value="reports">Report</TabsTrigger>
      </TabsList>

      {/* ── Panoramica ── */}
      <TabsContent value="overview" className="space-y-4 max-w-3xl">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Nome campagna</Label>
            <Input value={form.campaign_name} onChange={(e) => setForm({ ...form, campaign_name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Tipo</Label>
            <Select value={form.campaign_type} onValueChange={(v) => setForm({ ...form, campaign_type: v as CampaignType })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(CAMPAIGN_TYPE_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Canale</Label>
            <Select value={form.channel} onValueChange={(v) => setForm({ ...form, channel: v as CampaignChannel })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(CAMPAIGN_CHANNEL_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Stato</Label>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as CampaignStatus })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CAMPAIGN_STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{CAMPAIGN_STATUS_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Budget previsto (€)</Label>
              <Input type="number" step="any" value={form.budget_planned} onChange={(e) => setForm({ ...form, budget_planned: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Budget effettivo (€)</Label>
              <Input type="number" step="any" value={form.budget_actual} onChange={(e) => setForm({ ...form, budget_actual: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Inizio</Label>
            <Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Fine</Label>
            <Input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Cliente</Label>
            <Select value={form.customer_id || 'none'} onValueChange={(v) => setForm({ ...form, customer_id: v === 'none' ? '' : v })}>
              <SelectTrigger><SelectValue placeholder="Nessuno" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nessuno</SelectItem>
                {customers.map((c: { id: string; contact_name: string; company_name?: string }) => (
                  <SelectItem key={c.id} value={c.id}>{c.contact_name}{c.company_name ? ` (${c.company_name})` : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Progetto</Label>
            <Select value={form.project_id || 'none'} onValueChange={(v) => setForm({ ...form, project_id: v === 'none' ? '' : v })}>
              <SelectTrigger><SelectValue placeholder="Nessuno" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nessuno</SelectItem>
                {projects.map((p: { id: string; name: string }) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Obiettivo</Label>
            <Input value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Target audience</Label>
            <Input value={form.target_audience} onChange={(e) => setForm({ ...form, target_audience: e.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Note</Label>
            <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>

        {/* KPI per canale */}
        <div className="rounded-lg border p-4">
          <p className="text-sm font-semibold mb-3">KPI ({CAMPAIGN_CHANNEL_LABELS[form.channel]})</p>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-2 items-center">
            <span className="text-xs text-muted-foreground">Metrica</span>
            <span className="text-xs text-muted-foreground w-28 text-center">Target</span>
            <span className="text-xs text-muted-foreground w-28 text-center">Effettivo</span>
            {kpiFields.map((f) => (
              <FragmentRow
                key={f.key}
                label={f.label}
                target={form.kpi_target[f.key] ?? ''}
                actual={form.kpi_actual[f.key] ?? ''}
                onTarget={(v) => setForm({ ...form, kpi_target: { ...form.kpi_target, [f.key]: v } })}
                onActual={(v) => setForm({ ...form, kpi_actual: { ...form.kpi_actual, [f.key]: v } })}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <Button
            variant="ghost" size="sm" className="text-destructive"
            onClick={async () => {
              if (await confirm({ title: 'Eliminare la campagna?', description: 'Verranno eliminati anche asset e report collegati.', variant: 'destructive' })) {
                deleteMutation.mutate();
              }
            }}
          >
            <Trash2 className="h-4 w-4 mr-1.5" /> Elimina
          </Button>
          <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(form)}>
            <Save className="h-4 w-4 mr-1.5" /> Salva
          </Button>
        </div>
      </TabsContent>

      {/* ── Asset ── */}
      <TabsContent value="assets">
        <AssetSection campaignId={id!} assets={campaign.assets || []} />
      </TabsContent>

      {/* ── Report ── */}
      <TabsContent value="reports">
        <ReportSection campaignId={id!} channel={campaign.channel} />
      </TabsContent>
    </Tabs>
  );
}

function FragmentRow({
  label, target, actual, onTarget, onActual,
}: {
  label: string; target: string; actual: string;
  onTarget: (v: string) => void; onActual: (v: string) => void;
}) {
  return (
    <>
      <span className="text-sm">{label}</span>
      <Input type="number" step="any" className="w-28 h-8" value={target} onChange={(e) => onTarget(e.target.value)} />
      <Input type="number" step="any" className="w-28 h-8" value={actual} onChange={(e) => onActual(e.target.value)} />
    </>
  );
}
