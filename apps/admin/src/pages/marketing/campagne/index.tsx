import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Kanban, List, Plus, Search, Filter, Megaphone, ImageOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Campaign, CampaignStatus, CampaignType, CampaignChannel } from '@/types/marketing';
import {
  CAMPAIGN_STATUS_ORDER, CAMPAIGN_STATUS_LABELS, CAMPAIGN_TYPE_LABELS, CAMPAIGN_CHANNEL_LABELS,
} from '@/types/marketing';

type ViewMode = 'kanban' | 'list';

const STATUS_DOT: Record<CampaignStatus, string> = {
  brief: 'bg-zinc-400',
  planning: 'bg-sky-400',
  creative: 'bg-violet-400',
  review: 'bg-amber-400',
  approved: 'bg-emerald-400',
  active: 'bg-green-500',
  paused: 'bg-orange-400',
  completed: 'bg-blue-500',
  cancelled: 'bg-red-400',
};

function formatBudget(value: number | string | null): string {
  const n = Number(value || 0);
  if (!n) return '—';
  return `€${n.toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export default function CampagnePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<ViewMode>('kanban');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({
    campaign_name: '', campaign_type: 'social_media' as CampaignType,
    channel: 'instagram' as CampaignChannel, customer_id: '', project_id: '', objective: '',
  });
  const [dragId, setDragId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', statusFilter, channelFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (channelFilter !== 'all') params.set('channel', channelFilter);
      return apiFetch(`/api/marketing/campaigns?${params}`);
    },
  });

  const { data: customersData } = useQuery({
    queryKey: ['customers-select'],
    queryFn: () => apiFetch('/api/customers?limit=100'),
  });
  const { data: projectsData } = useQuery({
    queryKey: ['client-projects-select'],
    queryFn: () => apiFetch('/api/client-projects'),
  });

  const createMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      apiFetch('/api/marketing/campaigns', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res: { campaign?: { id?: string } }) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setShowNew(false);
      setNewForm({ campaign_name: '', campaign_type: 'social_media', channel: 'instagram', customer_id: '', project_id: '', objective: '' });
      toast.success('Campagna creata');
      if (res?.campaign?.id) navigate(`/marketing/campagne/${res.campaign.id}`);
    },
    onError: (e: Error) => toast.error(e.message || 'Errore nella creazione'),
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: CampaignStatus }) =>
      apiFetch(`/api/marketing/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
    onError: (e: Error) => toast.error(e.message || 'Errore aggiornamento stato'),
  });

  const allCampaigns: Campaign[] = data?.campaigns || [];
  const customers = customersData?.customers || [];
  const projects = projectsData?.projects || [];

  const campaigns = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return allCampaigns;
    return allCampaigns.filter((c) =>
      [c.campaign_name, c.customer_name, c.customer_company, c.objective]
        .filter(Boolean).join(' ').toLowerCase().includes(term)
    );
  }, [allCampaigns, search]);

  const stats = useMemo(() => ({
    total: allCampaigns.length,
    active: allCampaigns.filter((c) => c.status === 'active').length,
    pending: allCampaigns.reduce((sum, c) => sum + (c.pending_approval_count || 0), 0),
  }), [allCampaigns]);

  const topbarActions = useMemo(() => (
    <Button onClick={() => setShowNew(true)} size="sm">
      <Plus className="h-4 w-4 mr-1.5" />
      Nuova Campagna
    </Button>
  ), []);

  useTopbar({
    title: 'Campagne',
    subtitle: `${stats.total} campagne · ${stats.active} attive · ${stats.pending} asset da approvare`,
    actions: topbarActions,
  });

  function handleDrop(status: CampaignStatus) {
    if (dragId) {
      const camp = allCampaigns.find((c) => c.id === dragId);
      if (camp && camp.status !== status) statusMutation.mutate({ id: dragId, status });
    }
    setDragId(null);
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Cerca campagna, cliente..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[150px]">
            <Filter className="h-3.5 w-3.5 mr-1.5" />
            <SelectValue placeholder="Stato" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti gli stati</SelectItem>
            {CAMPAIGN_STATUS_ORDER.map((s) => (
              <SelectItem key={s} value={s}>{CAMPAIGN_STATUS_LABELS[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="w-[150px]"><SelectValue placeholder="Canale" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti i canali</SelectItem>
            {Object.entries(CAMPAIGN_CHANNEL_LABELS).map(([key, label]) => (
              <SelectItem key={key} value={key}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-1 rounded-lg border p-0.5">
          {([['kanban', Kanban], ['list', List]] as const).map(([v, Icon]) => (
            <Button
              key={v}
              variant={view === v ? 'default' : 'ghost'}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setView(v)}
            >
              <Icon className="h-3.5 w-3.5" />
            </Button>
          ))}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <LoadingState />
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Nessuna campagna"
          description="Crea la prima campagna marketing per un cliente o un progetto."
        />
      ) : view === 'kanban' ? (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {CAMPAIGN_STATUS_ORDER.map((status) => {
            const col = campaigns.filter((c) => c.status === status);
            return (
              <div
                key={status}
                className="flex flex-col rounded-lg border bg-muted/30 min-w-[240px] w-[240px]"
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={() => handleDrop(status)}
              >
                <div className="flex items-center gap-2 px-3 py-2 border-b rounded-t-lg">
                  <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />
                  <span className="text-sm font-semibold">{CAMPAIGN_STATUS_LABELS[status]}</span>
                  <span className="ml-auto rounded-full bg-background/80 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{col.length}</span>
                </div>
                <div className="flex-1 p-2 space-y-2 max-h-[calc(100vh-320px)] overflow-y-auto scrollbar-thin">
                  {col.map((c) => (
                    <div
                      key={c.id}
                      draggable
                      onDragStart={() => setDragId(c.id)}
                      onDragEnd={() => setDragId(null)}
                      className={cn(
                        'rounded-lg border bg-card p-3 shadow-sm hover:shadow-md cursor-pointer transition-shadow',
                        dragId === c.id && 'opacity-50'
                      )}
                      onClick={() => navigate(`/marketing/campagne/${c.id}`)}
                    >
                      <p className="text-sm font-medium truncate">{c.campaign_name}</p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {c.customer_company || c.customer_name || c.project_name || 'Nessun cliente'}
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
                        <span className="rounded bg-muted px-1.5 py-0.5">{CAMPAIGN_CHANNEL_LABELS[c.channel]}</span>
                        <span>{formatBudget(c.budget_planned)}</span>
                        {!!c.pending_approval_count && (
                          <span className="ml-auto rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                            {c.pending_approval_count} da approvare
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {col.length === 0 && (
                    <div className="py-6 text-center text-xs text-muted-foreground">—</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="hidden sm:grid grid-cols-[1fr_1fr_120px_110px_90px] gap-4 px-4 py-2.5 border-b bg-muted/50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <span>Campagna</span>
            <span>Cliente / Progetto</span>
            <span>Canale</span>
            <span>Stato</span>
            <span className="text-right">Budget</span>
          </div>
          {campaigns.map((c) => (
            <div
              key={c.id}
              className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_120px_110px_90px] gap-2 sm:gap-4 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors items-center"
              onClick={() => navigate(`/marketing/campagne/${c.id}`)}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{c.campaign_name}</p>
                <p className="text-xs text-muted-foreground">{CAMPAIGN_TYPE_LABELS[c.campaign_type]}</p>
              </div>
              <p className="text-sm text-muted-foreground truncate">{c.customer_company || c.customer_name || c.project_name || '—'}</p>
              <span className="text-sm text-muted-foreground">{CAMPAIGN_CHANNEL_LABELS[c.channel]}</span>
              <span className="flex items-center gap-1.5 text-sm">
                <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[c.status])} />
                {CAMPAIGN_STATUS_LABELS[c.status]}
              </span>
              <span className="text-sm tabular-nums text-right">{formatBudget(c.budget_planned)}</span>
            </div>
          ))}
        </div>
      )}

      {/* New campaign dialog */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Nuova Campagna</DialogTitle></DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!newForm.campaign_name.trim()) return;
              createMutation.mutate({
                campaign_name: newForm.campaign_name.trim(),
                campaign_type: newForm.campaign_type,
                channel: newForm.channel,
                customer_id: newForm.customer_id || null,
                project_id: newForm.project_id || null,
                objective: newForm.objective || null,
              });
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label>Nome campagna *</Label>
              <Input value={newForm.campaign_name} onChange={(e) => setNewForm({ ...newForm, campaign_name: e.target.value })} autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Tipo</Label>
                <Select value={newForm.campaign_type} onValueChange={(v) => setNewForm({ ...newForm, campaign_type: v as CampaignType })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CAMPAIGN_TYPE_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Canale</Label>
                <Select value={newForm.channel} onValueChange={(v) => setNewForm({ ...newForm, channel: v as CampaignChannel })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CAMPAIGN_CHANNEL_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Cliente</Label>
              <Select value={newForm.customer_id || 'none'} onValueChange={(v) => setNewForm({ ...newForm, customer_id: v === 'none' ? '' : v })}>
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
              <Select value={newForm.project_id || 'none'} onValueChange={(v) => setNewForm({ ...newForm, project_id: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue placeholder="Nessuno" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nessuno</SelectItem>
                  {projects.map((p: { id: string; name: string }) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Obiettivo</Label>
              <Input value={newForm.objective} onChange={(e) => setNewForm({ ...newForm, objective: e.target.value })} placeholder="Es. aumentare follower del 20%" />
            </div>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ImageOff className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Collega un cliente o un progetto per poter inviare gli asset all'approvazione nel portale.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNew(false)}>Annulla</Button>
              <Button type="submit" disabled={!newForm.campaign_name.trim() || createMutation.isPending}>Crea</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
