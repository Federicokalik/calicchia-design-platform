import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Pencil, CheckCircle2,
  Shield, ListChecks, FileDown, FolderKanban,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/shared/empty-state';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { LoadingState } from '@/components/shared/loading-state';

export default function PreventivoDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['quote-v2', id],
    queryFn: () => apiFetch(`/api/quotes-v2/${id}`),
    enabled: !!id,
  });

  const materialsMutation = useMutation({
    mutationFn: (checklist: any[]) =>
      apiFetch(`/api/quotes-v2/${id}/materials`, { method: 'POST', body: JSON.stringify({ materials_checklist: checklist }) }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['quote-v2', id] });
      if (res.materials_complete) toast.success('Tutti i materiali ricevuti! Progetto creato.');
      else toast.success('Checklist aggiornata');
    },
  });

  const quote = data?.quote;
  const audit = data?.audit || [];

  useTopbar({ title: quote?.title || 'Dettaglio Preventivo', subtitle: quote ? '€' + parseFloat(quote.total || '0').toLocaleString('it-IT') : '' });

  if (isLoading) return <LoadingState />;
  if (!quote) return <EmptyState title="Preventivo non trovato" />;

  const rawItems = quote.items;
  const items = typeof rawItems === 'string' ? JSON.parse(rawItems) : (rawItems || []);
  const rawChecklist = quote.materials_checklist;
  const checklist = typeof rawChecklist === 'string' ? JSON.parse(rawChecklist) : (Array.isArray(rawChecklist) ? rawChecklist : []);

  const toggleMaterial = (index: number) => {
    const next = checklist.map((m: any, i: number) =>
      i === index ? { ...m, received: !m.received, received_at: !m.received ? new Date().toISOString() : null } : m
    );
    materialsMutation.mutate(next);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/preventivi')} className="mt-1">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">{quote.title}</h1>
            <Badge variant="outline" className="text-xs capitalize">{quote.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {quote.customer_name || 'Nessun cliente'}
            {quote.company_name ? ` · ${quote.company_name}` : ''}
            {' · '}€{parseFloat(quote.total || '0').toLocaleString('it-IT')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              toast.info('Generazione PDF...');
              const res = await apiFetch(`/api/quotes-v2/${id}/generate-pdf`, { method: 'POST' });
              if (res.pdf_url) {
                window.open(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}${res.pdf_url}`, '_blank');
                toast.success('PDF generato!');
              }
            } catch { toast.error('Errore generazione PDF'); }
          }}
        >
          <FileDown className="h-4 w-4 mr-1.5" /> PDF
        </Button>
        {['signed', 'accepted', 'sent'].includes(quote.status) && !quote.project_id && (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const res: any = await apiFetch(`/api/quotes-v2/${id}/convert-to-project`, {
                  method: 'POST',
                  body: JSON.stringify({}),
                });
                toast.success('Progetto creato dal preventivo');
                queryClient.invalidateQueries({ queryKey: ['quote-v2', id] });
                queryClient.invalidateQueries({ queryKey: ['client-projects'] });
                if (res?.project?.id) {
                  navigate(`/progetti/${res.project.id}`);
                }
              } catch (err: any) {
                toast.error(err?.message || 'Errore creazione progetto');
              }
            }}
          >
            <FolderKanban className="h-4 w-4 mr-1.5" /> Crea progetto
          </Button>
        )}
        {quote.project_id && (
          <Button variant="ghost" size="sm" onClick={() => navigate(`/progetti/${quote.project_id}`)}>
            <FolderKanban className="h-4 w-4 mr-1.5" /> Vai al progetto
          </Button>
        )}
        {quote.status === 'draft' && (
          <Button size="sm" onClick={() => navigate(`/preventivi/${id}/edit`)}>
            <Pencil className="h-4 w-4 mr-1.5" /> Modifica
          </Button>
        )}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Dettaglio</TabsTrigger>
          <TabsTrigger value="materials" className="gap-1.5">
            <ListChecks className="h-3.5 w-3.5" />
            Materiali
            {checklist.length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                {checklist.filter((m: any) => m.received).length}/{checklist.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            Audit Trail
          </TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-4">
          {/* Items table */}
          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="hidden sm:grid grid-cols-[1fr_80px_100px_100px] gap-4 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground uppercase">
              <span>Descrizione</span>
              <span>Qtà</span>
              <span>Prezzo</span>
              <span>Totale</span>
            </div>
            {items.map((item: any, i: number) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_80px_100px_100px] gap-2 sm:gap-4 px-4 py-3 border-b last:border-b-0 text-sm">
                <span>{item.description || '—'}</span>
                <span className="text-muted-foreground">{item.quantity}</span>
                <span className="text-muted-foreground">€{parseFloat(item.unit_price || 0).toFixed(2)}</span>
                <span className="font-medium">€{parseFloat(item.total || 0).toFixed(2)}</span>
              </div>
            ))}
            {/* Totals */}
            <div className="px-4 py-3 bg-muted/30 space-y-1">
              <div className="flex justify-end gap-8 text-sm">
                <span className="text-muted-foreground">Subtotale</span>
                <span className="w-24 text-right">€{parseFloat(quote.subtotal || 0).toFixed(2)}</span>
              </div>
              <div className="flex justify-end gap-8 text-sm">
                <span className="text-muted-foreground">IVA ({quote.tax_rate}%)</span>
                <span className="w-24 text-right">€{parseFloat(quote.tax_amount || 0).toFixed(2)}</span>
              </div>
              <Separator />
              <div className="flex justify-end gap-8 text-base font-semibold">
                <span>Totale</span>
                <span className="w-24 text-right">€{parseFloat(quote.total || 0).toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Signature info */}
          {quote.signed_at && (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                <span className="font-semibold text-emerald-800 dark:text-emerald-200">Firmato</span>
              </div>
              <div className="text-sm text-emerald-700 dark:text-emerald-300 space-y-0.5">
                <p>Firmato da: {quote.signer_name || quote.signer_email}</p>
                <p>Data: {new Date(quote.signed_at).toLocaleString('it-IT')}</p>
                <p>IP: {quote.signature_ip}</p>
                <p className="text-xs font-mono">Hash PDF: {quote.pdf_hash_sha256?.slice(0, 16)}...</p>
              </div>
            </div>
          )}

          {/* Notes */}
          {quote.notes && (
            <div className="rounded-lg border bg-card p-4">
              <Label className="text-xs text-muted-foreground">Note per il cliente</Label>
              <p className="text-sm mt-1">{quote.notes}</p>
            </div>
          )}
        </TabsContent>

        {/* Materials checklist */}
        <TabsContent value="materials" className="space-y-4">
          {checklist.length === 0 ? (
            <EmptyState title="Nessun materiale richiesto" description="Modifica il preventivo per aggiungere una checklist materiali" />
          ) : (
            <div className="rounded-lg border bg-card divide-y">
              {checklist.map((item: any, i: number) => (
                <div
                  key={i}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => toggleMaterial(i)}
                >
                  <div className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                    item.received ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-border'
                  )}>
                    {item.received && <CheckCircle2 className="h-3 w-3" />}
                  </div>
                  <span className={cn('text-sm flex-1', item.received && 'line-through text-muted-foreground')}>
                    {item.label}
                  </span>
                  {item.received && item.received_at && (
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(item.received_at).toLocaleDateString('it-IT')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {quote.materials_complete && quote.project_id && (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-4">
              <p className="text-sm text-emerald-700 dark:text-emerald-300">
                Tutti i materiali ricevuti. Progetto creato automaticamente.
              </p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => navigate(`/progetti/${quote.project_id}`)}>
                Vai al progetto →
              </Button>
            </div>
          )}
        </TabsContent>

        {/* Audit trail */}
        <TabsContent value="audit">
          {audit.length === 0 ? (
            <EmptyState title="Nessun evento" description="L'audit trail apparirà dopo l'invio del preventivo" icon={Shield} />
          ) : (
            <div className="rounded-lg border bg-card divide-y">
              {audit.map((entry: any) => (
                <div key={entry.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{entry.action.replace(/_/g, ' ')}</p>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {new Date(entry.created_at).toLocaleString('it-IT')}
                      {entry.ip_address && ` · IP: ${entry.ip_address}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
