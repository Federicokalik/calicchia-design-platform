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

  // Import dialog state — two modes: Markdown brief (parser/AI) or hand-made HTML document
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<'md' | 'html'>('md');
  const [importMarkdown, setImportMarkdown] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [importKey, setImportKey] = useState('');
  // Custom HTML fields (the document itself isn't parsable → explicit data)
  const [htmlContent, setHtmlContent] = useState('');
  const [htmlTitle, setHtmlTitle] = useState('');
  const [htmlTotale, setHtmlTotale] = useState('');
  const [htmlAnticipato, setHtmlAnticipato] = useState('');
  const [htmlRate, setHtmlRate] = useState('');
  const [htmlVessatorie, setHtmlVessatorie] = useState('');
  const [htmlCustomerId, setHtmlCustomerId] = useState('');

  const { data: customersData } = useQuery({
    queryKey: ['customers-select'],
    queryFn: () => apiFetch('/api/customers?limit=100'),
    enabled: importOpen,
  });
  const customers = customersData?.customers || [];

  const openImportDialog = () => {
    setImportMode('md');
    setImportMarkdown('');
    setImportFileName('');
    setHtmlContent('');
    setHtmlTitle('');
    setHtmlTotale('');
    setHtmlAnticipato('');
    setHtmlRate('');
    setHtmlVessatorie('');
    setHtmlCustomerId('');
    setImportKey(crypto.randomUUID());
    setImportOpen(true);
  };

  const readImportFile = (file: File) => {
    const name = file.name.toLowerCase();
    const isHtml = name.endsWith('.html') || name.endsWith('.htm') || file.type === 'text/html';
    const isMd = name.endsWith('.md') || file.type === 'text/markdown' || file.type === 'text/plain';
    if (!isHtml && !isMd) {
      toast.error('Carica un file .md oppure .html');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      setImportFileName(file.name);
      if (isHtml) {
        setImportMode('html');
        setHtmlContent(content);
        const t = /<title>([^<]{1,200})<\/title>/i.exec(content)?.[1]?.trim();
        if (t) setHtmlTitle(t);
      } else {
        setImportMode('md');
        setImportMarkdown(content);
      }
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
      // → editor (not detail): the draft needs review, and the customer
      //   suggestion banner lives there.
      navigate(`/preventivi/${res.quote_id}/edit`, {
        state: {
          suggestedCustomers: res.suggested_customers || [],
          clientHint: res.client_hint || null,
        },
      });
    },
    onError: (err: any) => toast.error(err?.message || 'Generazione fallita'),
  });

  const importHtmlMutation = useMutation({
    mutationFn: () => {
      const totale = parseFloat(htmlTotale.replace(',', '.'));
      const pagamento: Array<{ nome: string; importo: number }> = [];
      const anticipato = parseFloat(htmlAnticipato.replace(',', '.'));
      if (Number.isFinite(anticipato) && anticipato > 0) {
        pagamento.push({ nome: 'Saldo anticipato unico', importo: anticipato });
      }
      const rateMatch = /^(\d+)\s*[x×@]?\s*([\d.,]+)?/.exec(htmlRate.trim());
      if (rateMatch) {
        const n = parseInt(rateMatch[1], 10);
        const rTot = rateMatch[2] ? parseFloat(rateMatch[2].replace(/\./g, '').replace(',', '.')) : totale;
        if (n > 1) pagamento.push({ nome: `${n} rate`, importo: rTot });
      }
      // One clause per line: "4 — Titolo" (number optional)
      const vessatorie = htmlVessatorie
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l, i) => {
          const m = /^(\d+)?\s*[—–-]?\s*(.+)$/.exec(l);
          return { numero: m?.[1] ? parseInt(m[1], 10) : i + 1, titolo: m?.[2]?.trim() || l };
        });
      return apiFetch('/api/quotes-v2/import-html', {
        method: 'POST',
        body: JSON.stringify({
          html: htmlContent,
          title: htmlTitle.trim() || undefined,
          totale,
          pagamento,
          vessatorie,
          customer_id: htmlCustomerId || undefined,
        }),
      });
    },
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['quotes-v2'] });
      setImportOpen(false);
      toast.success('Preventivo su misura creato');
      navigate(`/preventivi/${res.quote_id}`);
    },
    onError: (err: any) => toast.error(err?.message || 'Import fallito'),
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
      const failures = res.failed ? Object.values(res.failed).join(' · ') : '';
      if (failures) {
        toast.warning(`Inviato via ${res.sent_via.join(' + ')} — ma: ${failures}`, { duration: 8000 });
      } else {
        toast.success(`Preventivo inviato via ${res.sent_via.join(' + ')}`);
      }
    },
    onError: (err: any) => toast.error(err?.message || 'Invio fallito su tutti i canali', { duration: 8000 }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/quotes-v2/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quotes-v2'] });
      toast.success('Eliminato');
    },
  });

  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleChannels, setScheduleChannels] = useState('email');

  const scheduleMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiFetch(`/api/quotes-v2/${id}/schedule-send`, {
        method: 'POST',
        body: JSON.stringify({
          send_at: new Date(scheduleDate).toISOString(),
          channels: scheduleChannels === 'both' ? ['email', 'whatsapp'] : [scheduleChannels],
        }),
      }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['quotes-v2'] });
      setSendDialog(null);
      setScheduleDate('');
      toast.success(`Invio programmato per il ${new Date(res.scheduled_send_at).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
    },
    onError: (err: any) => toast.error(err?.message || 'Programmazione fallita'),
  });

  const cancelScheduleMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/quotes-v2/${id}/schedule-send`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quotes-v2'] });
      toast.success('Invio programmato annullato');
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
      if (q.scheduled_send_at) {
        items.push({
          label: 'Annulla invio programmato',
          icon: Clock,
          onClick: () => cancelScheduleMutation.mutate(q.id),
        });
      }
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
        Importa documento
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

                  {/* Scheduled send badge */}
                  {q.scheduled_send_at && (
                    <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 border-amber-400/50 text-amber-600 dark:text-amber-400">
                      <Clock className="h-2.5 w-2.5 mr-1" />
                      Invio {new Date(q.scheduled_send_at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} {new Date(q.scheduled_send_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                    </Badge>
                  )}

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

            {/* Scheduled send */}
            <div className="mt-4 border-t pt-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" /> …oppure programma l'invio
              </p>
              <div className="flex gap-2">
                <input
                  type="datetime-local"
                  className="flex-1 h-9 rounded-md border bg-background px-2 text-sm"
                  value={scheduleDate}
                  min={new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 16)}
                  onChange={(e) => setScheduleDate(e.target.value)}
                />
                <Select value={scheduleChannels} onValueChange={setScheduleChannels}>
                  <SelectTrigger className="w-[130px] h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email" disabled={!sendDialog.hasEmail}>Email</SelectItem>
                    <SelectItem value="whatsapp" disabled={!sendDialog.hasPhone}>WhatsApp</SelectItem>
                    <SelectItem value="both" disabled={!sendDialog.hasEmail || !sendDialog.hasPhone}>Entrambi</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                className="w-full"
                disabled={!scheduleDate || new Date(scheduleDate).getTime() <= Date.now() || scheduleMutation.isPending}
                onClick={() => scheduleMutation.mutate({ id: sendDialog.id })}
              >
                <Clock className="h-4 w-4 mr-2" />
                {scheduleMutation.isPending ? 'Programmazione…' : 'Programma invio'}
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
              <Sparkles className="h-4 w-4 text-primary" /> Importa preventivo (Markdown o HTML)
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <b>.md</b>: brief Markdown → bozza strutturata da rivedere nell'editor.{' '}
            <b>.html</b>: documento su misura già impaginato — indichi solo totale,
            pagamento e clausole. Nulla viene inviato al cliente.
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
              if (file) readImportFile(file);
            }}
            onClick={() => document.getElementById('md-import-input')?.click()}
          >
            <FileUp className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm font-medium">
              {importFileName || 'Trascina un file .md o .html, oppure clicca per selezionarlo'}
            </p>
            <input
              id="md-import-input"
              type="file"
              accept=".md,.html,.htm,text/markdown,text/plain,text/html"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) readImportFile(file);
                e.target.value = '';
              }}
            />
          </div>

          {importMode === 'md' && (
            <>
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">…oppure incolla il contenuto Markdown:</p>
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
            </>
          )}

          {importMode === 'html' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 space-y-1">
                  <p className="text-xs font-medium">Titolo</p>
                  <input
                    className="w-full h-8 rounded-md border bg-background px-2 text-sm"
                    value={htmlTitle}
                    onChange={(e) => setHtmlTitle(e.target.value)}
                    placeholder="Oggetto del preventivo"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium">Totale (€) *</p>
                  <input
                    className="w-full h-8 rounded-md border bg-background px-2 text-sm"
                    value={htmlTotale}
                    onChange={(e) => setHtmlTotale(e.target.value)}
                    placeholder="2748"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium">Saldo anticipato (€, opz.)</p>
                  <input
                    className="w-full h-8 rounded-md border bg-background px-2 text-sm"
                    value={htmlAnticipato}
                    onChange={(e) => setHtmlAnticipato(e.target.value)}
                    placeholder="2500"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium">Rate (opz.)</p>
                  <input
                    className="w-full h-8 rounded-md border bg-background px-2 text-sm"
                    value={htmlRate}
                    onChange={(e) => setHtmlRate(e.target.value)}
                    placeholder="3 x 916"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium">Cliente (opz.)</p>
                  <Select value={htmlCustomerId} onValueChange={setHtmlCustomerId}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Seleziona…" /></SelectTrigger>
                    <SelectContent>
                      {customers.map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>{c.contact_name}{c.company_name ? ` (${c.company_name})` : ''}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">Clausole vessatorie (una per riga: "4 — Titolo"; vuoto = nessuna)</p>
                <Textarea
                  value={htmlVessatorie}
                  onChange={(e) => setHtmlVessatorie(e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={'4 — Specifiche sul pagamento\n9 — Recesso\n15 — Foro competente'}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Firma nel documento: aggiungi <code>{'<div data-sign="cliente"></div>'}</code> dove
                va la firma e <code>{'<div data-sign="vessatorie"></div>'}</code> sul box clausole —
                alla firma digitale il PDF viene rigenerato con nome, data e immagine firma in quei punti.
              </p>
              <Button
                onClick={() => importHtmlMutation.mutate()}
                disabled={!htmlContent || !Number.isFinite(parseFloat(htmlTotale.replace(',', '.'))) || importHtmlMutation.isPending}
                className="w-full"
              >
                {importHtmlMutation.isPending
                  ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creazione in corso…</>)
                  : (<><FileUp className="h-4 w-4 mr-2" /> Crea preventivo su misura</>)}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
