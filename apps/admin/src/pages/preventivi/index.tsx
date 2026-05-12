import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus, Filter, Send, Eye, CheckCircle2, Clock, XCircle,
  FileSignature, MoreHorizontal, Trash2, Mail, MessageSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { LoadingState } from '@/components/shared/loading-state';

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  draft: { label: 'Bozza', color: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400', icon: Clock },
  sent: { label: 'Inviato', color: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400', icon: Send },
  viewed: { label: 'Visualizzato', color: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-400', icon: Eye },
  signed: { label: 'Firmato', color: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400', icon: CheckCircle2 },
  rejected: { label: 'Rifiutato', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400', icon: XCircle },
  expired: { label: 'Scaduto', color: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400', icon: Clock },
};

export default function PreventiviPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('all');
  const [sendDialog, setSendDialog] = useState<{ id: string; title: string; hasEmail: boolean; hasPhone: boolean } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['quotes-v2', statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      return apiFetch(`/api/quotes-v2?${params}`);
    },
  });

  const sendMutation = useMutation({
    mutationFn: ({ id, channels }: { id: string; channels: string[] }) =>
      apiFetch(`/api/quotes-v2/${id}/send`, { method: 'POST', body: JSON.stringify({ channels }) }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['quotes-v2'] });
      setSendDialog(null);
      toast.success(`Preventivo inviato via ${res.sent_via?.join(' + ') || 'email'}`);
    },
    onError: () => toast.error('Errore invio'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/quotes-v2/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quotes-v2'] });
      toast.success('Eliminato');
    },
  });

  const quotes = data?.quotes || [];
  const stats = data?.stats || { total: 0, draft: 0, sent: 0, signed: 0, totalValue: 0 };

  const topbarActions = useMemo(() => (
    <Button size="sm" onClick={() => navigate('/preventivi/new')}>
      <Plus className="h-4 w-4 mr-1.5" />
      Nuovo Preventivo
    </Button>
  ), [navigate]);

  useTopbar({
    title: 'Preventivi',
    subtitle: `${stats.total} preventivi · ${stats.signed} firmati · €${stats.totalValue.toLocaleString('it-IT')} valore totale`,
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <Filter className="h-3.5 w-3.5 mr-1.5" />
            <SelectValue placeholder="Stato" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti</SelectItem>
            {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
              <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* List */}
      {isLoading ? (
        <LoadingState />
      ) : quotes.length === 0 ? (
        <EmptyState title="Nessun preventivo" description="Crea il primo preventivo per un cliente" icon={FileSignature}>
          <Button size="sm" onClick={() => navigate('/preventivi/new')}>Crea preventivo</Button>
        </EmptyState>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          {quotes.map((q: any) => {
            const statusCfg = STATUS_CONFIG[q.status] || STATUS_CONFIG.draft;
            const StatusIcon = statusCfg.icon;
            return (
              <div
                key={q.id}
                className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors"
              >
                {/* Status icon */}
                <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', statusCfg.color)}>
                  <StatusIcon className="h-4 w-4" />
                </div>

                {/* Info */}
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => navigate(`/preventivi/${q.id}`)}
                >
                  <p className="text-sm font-medium truncate">{q.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {q.customer_name || 'Nessun cliente'}
                    {q.company_name ? ` · ${q.company_name}` : ''}
                    {' · '}
                    {new Date(q.created_at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                  </p>
                </div>

                {/* Amount */}
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold">€{parseFloat(q.total || '0').toLocaleString('it-IT')}</p>
                  {q.valid_until && (
                    <p className="text-[10px] text-muted-foreground">
                      Valido fino: {new Date(q.valid_until).toLocaleDateString('it-IT')}
                    </p>
                  )}
                </div>

                {/* Status badge */}
                <Badge variant="outline" className={cn('shrink-0 text-[10px] px-1.5', statusCfg.color)}>
                  {statusCfg.label}
                </Badge>

                {/* Actions */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => navigate(`/preventivi/${q.id}`)}>
                      <Eye className="h-3.5 w-3.5 mr-2" /> Dettaglio
                    </DropdownMenuItem>
                    {q.status !== 'signed' && (
                      <DropdownMenuItem onClick={() => setSendDialog({
                        id: q.id, title: q.title,
                        hasEmail: !!q.customer_email, hasPhone: !!q.customer_phone,
                      })}>
                        <Send className="h-3.5 w-3.5 mr-2" /> Invia
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    {q.status !== 'signed' && (
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => { if (confirm('Eliminare?')) deleteMutation.mutate(q.id); }}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" /> Elimina
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      )}

      {/* Send dialog */}
      {sendDialog && (
        <Dialog open onOpenChange={() => setSendDialog(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Invia preventivo</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Invia "{sendDialog.title}" al cliente. Scegli il canale:
            </p>
            <div className="flex flex-col gap-2 mt-2">
              <Button
                variant="outline"
                disabled={!sendDialog.hasEmail}
                onClick={() => sendMutation.mutate({ id: sendDialog.id, channels: ['email'] })}
              >
                <Mail className="h-4 w-4 mr-2" /> Invia via Email
              </Button>
              <Button
                variant="outline"
                disabled={!sendDialog.hasPhone}
                onClick={() => sendMutation.mutate({ id: sendDialog.id, channels: ['whatsapp'] })}
              >
                <MessageSquare className="h-4 w-4 mr-2" /> Invia via WhatsApp
              </Button>
              <Button
                disabled={!sendDialog.hasEmail || !sendDialog.hasPhone}
                onClick={() => sendMutation.mutate({ id: sendDialog.id, channels: ['email', 'whatsapp'] })}
              >
                <Send className="h-4 w-4 mr-2" /> Invia Entrambi
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
