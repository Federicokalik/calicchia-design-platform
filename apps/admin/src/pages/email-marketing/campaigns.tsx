import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send, Plus, Mail, MessageCircle, Eye, MousePointerClick, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

interface Campaign {
  id: string;
  name: string;
  channel: 'email' | 'whatsapp';
  subject: string | null;
  status: string;
  total_recipients: number;
  total_sent: number;
  total_opened: number;
  total_clicked: number;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
}

const STATUS_CFG: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  draft: { label: 'Bozza', variant: 'secondary' },
  scheduled: { label: 'Pianificata', variant: 'outline' },
  queued: { label: 'In coda', variant: 'outline' },
  sending: { label: 'In invio', variant: 'default' },
  sent: { label: 'Inviata', variant: 'default' },
  paused: { label: 'In pausa', variant: 'secondary' },
  failed: { label: 'Errore', variant: 'destructive' },
  cancelled: { label: 'Annullata', variant: 'outline' },
};

export default function CampaignsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newChannel, setNewChannel] = useState<'email' | 'whatsapp'>('email');

  const { data, isLoading } = useQuery<{ campaigns: Campaign[] }>({
    queryKey: ['mkt-campaigns', statusFilter],
    queryFn: () => apiFetch(`/api/email-marketing/campaigns?status=${statusFilter}`),
  });
  const campaigns = data?.campaigns ?? [];

  const createMutation = useMutation({
    mutationFn: () => apiFetch('/api/email-marketing/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: newName, channel: newChannel }),
    }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['mkt-campaigns'] });
      setCreateOpen(false); setNewName('');
      if (res?.campaign?.id) navigate(`/email-marketing/campagne/${res.campaign.id}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Creazione fallita'),
  });

  const actions = useMemo(() => (
    <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
      <Plus className="h-4 w-4" /> Nuova campagna
    </Button>
  ), []);

  useTopbar({ title: 'Campagne', subtitle: `${campaigns.length} campagne`, actions });

  return (
    <div className="space-y-4">
      <Select value={statusFilter} onValueChange={setStatusFilter}>
        <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tutti gli stati</SelectItem>
          <SelectItem value="draft">Bozze</SelectItem>
          <SelectItem value="queued">In coda</SelectItem>
          <SelectItem value="sending">In invio</SelectItem>
          <SelectItem value="sent">Inviate</SelectItem>
        </SelectContent>
      </Select>

      {isLoading ? (
        <LoadingState />
      ) : campaigns.length === 0 ? (
        <EmptyState title="Nessuna campagna" description="Crea la prima campagna email o WhatsApp." icon={Send} />
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {campaigns.map((c) => {
            const cfg = STATUS_CFG[c.status] ?? { label: c.status, variant: 'outline' as const };
            return (
              <button
                key={c.id}
                onClick={() => navigate(`/email-marketing/campagne/${c.id}`)}
                className="w-full text-left p-3 flex items-center justify-between gap-4 hover:bg-muted/40"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {c.channel === 'email' ? <Mail className="h-3.5 w-3.5 text-muted-foreground" /> : <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />}
                    <span className="text-sm font-medium truncate">{c.name}</span>
                    <Badge variant={cfg.variant} className="text-[10px]">{cfg.label}</Badge>
                  </div>
                  {c.subject && <p className="text-xs text-muted-foreground truncate">{c.subject}</p>}
                </div>
                {(c.status === 'sent' || c.status === 'sending') && (
                  <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                    <span className="flex items-center gap-1"><Users className="h-3 w-3" />{c.total_sent}/{c.total_recipients}</span>
                    <span className="flex items-center gap-1"><Eye className="h-3 w-3" />{c.total_opened}</span>
                    <span className="flex items-center gap-1"><MousePointerClick className="h-3 w-3" />{c.total_clicked}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nuova campagna</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Nome</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="es. Newsletter giugno" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Canale</Label>
              <Select value={newChannel} onValueChange={(v) => setNewChannel(v as 'email' | 'whatsapp')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Annulla</Button>
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !newName.trim()}>Crea</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
