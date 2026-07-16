import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus, Filter, Send, Eye, CheckCircle2, Clock, XCircle,
  FileSignature, MoreHorizontal, Trash2, Mail, MessageSquare,
  FileUp, Loader2, Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { RowContextMenu, type RowAction } from '@/components/ui/row-context-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { useConfirm } from '@/hooks/use-confirm';
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
  const confirm = useConfirm();
  const [statusFilter, setStatusFilter] = useState('all');
  const [sendDialog, setSendDialog] = useState<{ id: string; title: string; hasEmail: boolean; hasPhone: boolean } | null>(null);

  // Import-from-Markdown dialog state
  const [importOpen, setImportOpen] = useState(false);
  const [importMarkdown, setImportMarkdown] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [importKey, setImportKey] = useState('');

  const openImportDialog = () => {
    setImportMarkdown('');
    setImportFileName('');
    setImportKey(crypto.randomUUID());
    setImportOpen(true);
  };

  const readMarkdownFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.md') && file.type !== 'text/markdown' && file.type !== 'text/plain') {
      toast.error('Carica un file .md');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImportMarkdown(String(reader.result || ''));
      setImportFileName(file.name);
    };
    reader.readAsText(file);
  };

  const importMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/quotes-v2/generate-from-markdown', {
        method: 'POST',
        headers: { 'Idempotency-Key': importKey },
        body: JSON.stringify({ markdown: importMarkdown }),
      }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['quotes-v2'] });
      setImportOpen(false);
      toast.success('Bozza generata — rivedila prima di inviare');
      navigate(`/preventivi/${res.quote_id}`, {
        state: { suggestedCustomers: res.suggested_customers || [] },
      });
    },
    onError: (err: any) => toast.error(err?.message || 'Generazione fallita'),
  });

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

  // Azioni shared per riga: usate sia dal kebab DropdownMenu sia dal RowContextMenu (right-click).
  const rowActions = (q: any): RowAction[] => {
    const items: RowAction[] = [
      { label: 'Dettaglio', icon: Eye, onClick: () => navigate(`/preventivi/${q.id}`) },
    ];
    if (q.status !== 'signed') {
      items.push({
        label: 'Invia',
        icon: Send,
        onClick: () => setSendDialog({
          id: q.id, title: q.title,
          hasEmail: !!q.customer_email, hasPhone: !!q.customer_phone,
        }),
      });
      items.push({ divider: true });
      items.push({
        label: 'Elimina',
        icon: Trash2,
        destructive: true,
        onClick: async () => { if (await confirm({ title: 'Eliminare preventivo?', variant: 'destructive' })) deleteMutation.mutate(q.id); },
      });
    }
    return items;
  };

  const topbarActions = useMemo(() => (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={openImportDialog}>
        <FileUp className="h-4 w-4 mr-1.5" />
        Importa da Markdown
      </Button>
      <Button size="sm" onClick={() => navigate('/preventivi/new')}>
        <Plus className="h-4 w-4 mr-1.5" />
        Nuovo Preventivo
      </Button>
    </div>
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
            const actions = rowActions(q);
            return (
              <RowContextMenu key={q.id} actions={actions}>
                <div className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors">
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
                      {actions.map((action, i) => {
                        if ('divider' in action) {
                          return <DropdownMenuSeparator key={`sep-${i}`} />;
                        }
                        const Icon = action.icon;
                        return (
                          <DropdownMenuItem
                            key={`${action.label}-${i}`}
                            disabled={action.disabled}
                            onClick={action.onClick}
                            className={action.destructive ? 'text-destructive' : undefined}
                          >
                            {Icon && <Icon className="h-3.5 w-3.5 mr-2" />}
                            {action.label}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </RowContextMenu>
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

      {/* Import from Markdown dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Importa preventivo da Markdown
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Carica o incolla un brief in Markdown (frontmatter + testo): l'AI lo trasforma
            in una bozza strutturata da rivedere nell'editor. Nulla viene inviato al cliente.
          </p>
          <div
            className={cn(
              'border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors',
              isDraggingFile ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50',
            )}
            onDragOver={(e) => { e.preventDefault(); setIsDraggingFile(true); }}
            onDragLeave={() => setIsDraggingFile(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingFile(false);
              const file = e.dataTransfer.files?.[0];
              if (file) readMarkdownFile(file);
            }}
            onClick={() => document.getElementById('md-import-input')?.click()}
          >
            <FileUp className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm font-medium">
              {importFileName || 'Trascina un file .md oppure clicca per selezionarlo'}
            </p>
            <input
              id="md-import-input"
              type="file"
              accept=".md,text/markdown,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) readMarkdownFile(file);
                e.target.value = '';
              }}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">…oppure incolla il contenuto:</p>
            <Textarea
              value={importMarkdown}
              onChange={(e) => { setImportMarkdown(e.target.value); setImportFileName(''); }}
              rows={8}
              className="font-mono text-xs"
              placeholder={'---\ncliente: Nome Cliente\noggetto: Sito web\n---\n\n## Cosa include\n…'}
            />
          </div>
          <Button
            onClick={() => importMutation.mutate()}
            disabled={importMarkdown.trim().length < 30 || importMutation.isPending}
            className="w-full"
          >
            {importMutation.isPending
              ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generazione bozza in corso…</>)
              : (<><Sparkles className="h-4 w-4 mr-2" /> Genera bozza con AI</>)}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
