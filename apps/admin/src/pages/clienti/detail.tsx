import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Building2, Mail, Phone, Globe,
  FolderKanban, Receipt, MessageSquare,
  Send, KeyRound, Copy, Check, RefreshCw, ExternalLink,
  FileBarChart, Plus, ShieldOff, Eye, EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { LoadingState } from '@/components/shared/loading-state';
import type { Customer, CustomerNote } from '@/types/customer';
import { CUSTOMER_STATUS_CONFIG, NOTE_TYPE_CONFIG } from '@/types/customer';

export default function ClienteDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Fetch customer
  const { data, isLoading } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => apiFetch(`/api/customers/${id}`),
    enabled: !!id,
  });

  // Fetch customer notes
  const { data: notesData } = useQuery({
    queryKey: ['customer-notes', id],
    queryFn: () => apiFetch(`/api/customer-notes?customer_id=${id}`),
    enabled: !!id,
  });

  // Fetch customer projects
  const { data: projectsData } = useQuery({
    queryKey: ['customer-projects', id],
    queryFn: () => apiFetch(`/api/client-projects?customer_id=${id}`),
    enabled: !!id,
  });

  // Fetch customer domains
  const { data: domainsData } = useQuery({
    queryKey: ['customer-domains', id],
    queryFn: () => apiFetch(`/api/domains?customer_id=${id}`),
    enabled: !!id,
  });

  // Fetch customer payments
  const { data: paymentsData } = useQuery({
    queryKey: ['customer-payments', id],
    queryFn: () => apiFetch(`/api/payment-tracker?customer_id=${id}`),
    enabled: !!id,
  });

  // Fetch portal preview (lazy: only when tab opens)
  const [portalTabActive, setPortalTabActive] = useState(false);
  const { data: portalPreviewData, isLoading: portalPreviewLoading } = useQuery<{
    customer: { id: string; email: string | null; contact_name: string | null; company_name: string | null };
    projects: Array<{
      id: string; name: string; status: string;
      progress_percentage: number | null; client_notes: string | null;
      project_category: string | null; visible_to_client: boolean;
    }>;
    schedules: Array<{
      id: string; title: string; schedule_type: string;
      amount: number | string; currency: string; due_date: string | null;
      status: string; paid_amount: number | string | null;
      project: { id: string; name: string } | null;
    }>;
    invoices: Array<{
      id: string; invoice_number: string | null; status: string;
      total: number | string; issue_date: string | null;
      due_date: string | null; payment_status: string | null;
    }>;
    summary: {
      projects_total: number; projects_visible: number;
      schedules_total: number; schedules_paid: number;
      invoices_total: number; invoices_total_amount: number;
    };
  }>({
    queryKey: ['portal-preview', id],
    queryFn: () => apiFetch(`/api/portal-admin/preview/${id}`),
    enabled: !!id && portalTabActive,
  });

  const customer: Customer | null = data?.customer || null;
  const notes: CustomerNote[] = notesData?.notes || [];
  const projects = projectsData?.projects || [];
  const domains = domainsData?.domains || [];
  const payments = paymentsData?.payments || [];

  useTopbar({ title: customer?.contact_name || 'Dettaglio Cliente', subtitle: customer?.company_name || '' });

  // Note form
  const [noteContent, setNoteContent] = useState('');
  const [noteType, setNoteType] = useState('note');

  const addNoteMutation = useMutation({
    mutationFn: async (data: { customer_id: string; content: string; type: string }) =>
      apiFetch('/api/customer-notes', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer-notes', id] });
      setNoteContent('');
      toast.success('Nota aggiunta');
    },
  });

  // Portal access
  const [copiedLink, setCopiedLink] = useState(false);
  const portalUrl = import.meta.env.VITE_PORTAL_URL || 'http://localhost:3000';

  const generateCodeMutation = useMutation({
    mutationFn: async () => {
      return apiFetch(`/api/customers/${id}/generate-portal-code`, { method: 'POST' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', id] });
      toast.success('Codice portale generato');
    },
  });

  const revokeSessionsMutation = useMutation({
    mutationFn: async () => {
      return apiFetch(`/api/customers/${id}/revoke-portal-sessions`, { method: 'POST' });
    },
    onSuccess: () => {
      toast.success('Sessioni portale revocate');
    },
    onError: () => toast.error('Revoca sessioni fallita'),
  });

  const copyPortalLink = () => {
    const code = (customer as any)?.portal_access_code;
    if (!code) return;
    navigator.clipboard.writeText(`${portalUrl}/clienti/p/${code}`);
    setCopiedLink(true);
    toast.success('Link copiato');
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // Reports
  const { data: reportsData } = useQuery({
    queryKey: ['portal-reports', id],
    queryFn: () => apiFetch(`/api/portal-admin/reports/${id}`),
    enabled: !!id,
  });
  const reports = reportsData?.reports || [];

  const [showReportForm, setShowReportForm] = useState(false);
  const [reportMonth, setReportMonth] = useState(String(new Date().getMonth() + 1));
  const [reportYear, setReportYear] = useState(String(new Date().getFullYear()));
  const [reportTitle, setReportTitle] = useState('');
  const [reportSummary, setReportSummary] = useState('');
  const [reportProjectId, setReportProjectId] = useState('');

  const publishReportMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) =>
      apiFetch('/api/portal-admin/reports', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-reports', id] });
      setShowReportForm(false);
      setReportTitle('');
      setReportSummary('');
      toast.success('Report pubblicato');
    },
  });

  // Update customer
  const updateMutation = useMutation({
    mutationFn: async (data: Partial<Customer>) =>
      apiFetch(`/api/customers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', id] });
      toast.success('Cliente aggiornato');
    },
  });

  if (isLoading) {
    return <LoadingState />;
  }

  if (!customer) {
    return <EmptyState title="Cliente non trovato" />;
  }

  const statusCfg = CUSTOMER_STATUS_CONFIG[customer.status];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/clienti')} className="mt-1">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight truncate">{customer.contact_name}</h1>
            <StatusBadge {...statusCfg} />
          </div>
          {customer.company_name && (
            <div className="flex items-center gap-1.5 mt-1">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{customer.company_name}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Mail className="h-3.5 w-3.5" /> {customer.email}
            </span>
            {customer.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3.5 w-3.5" /> {customer.phone}
              </span>
            )}
            <span className="font-medium text-foreground">
              Revenue: €{(customer.total_revenue || 0).toLocaleString('it-IT')}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        defaultValue="overview"
        className="space-y-4"
        onValueChange={(v) => setPortalTabActive(v === 'portal-preview')}
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="projects" className="gap-1.5">
            <FolderKanban className="h-3.5 w-3.5" />
            Progetti
            {projects.length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{projects.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="payments" className="gap-1.5">
            <Receipt className="h-3.5 w-3.5" />
            Pagamenti
          </TabsTrigger>
          <TabsTrigger value="domains" className="gap-1.5">
            <Globe className="h-3.5 w-3.5" />
            Domini
          </TabsTrigger>
          <TabsTrigger value="reports" className="gap-1.5">
            <FileBarChart className="h-3.5 w-3.5" />
            Report
            {reports.length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{reports.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="notes" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Note
            {notes.length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{notes.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="portal-preview" className="gap-1.5">
            <Eye className="h-3.5 w-3.5" />
            Anteprima portale
          </TabsTrigger>
        </TabsList>

        {/* Overview tab */}
        <TabsContent value="overview">
          <div className="rounded-lg border bg-card p-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Nome contatto</Label>
                <Input defaultValue={customer.contact_name} onBlur={(e) => {
                  if (e.target.value !== customer.contact_name) updateMutation.mutate({ contact_name: e.target.value });
                }} />
              </div>
              <div className="space-y-1.5">
                <Label>Azienda</Label>
                <Input defaultValue={customer.company_name || ''} onBlur={(e) => {
                  if (e.target.value !== (customer.company_name || '')) updateMutation.mutate({ company_name: e.target.value || null });
                }} />
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input defaultValue={customer.email} onBlur={(e) => {
                  if (e.target.value !== customer.email) updateMutation.mutate({ email: e.target.value });
                }} />
              </div>
              <div className="space-y-1.5">
                <Label>Telefono</Label>
                <Input defaultValue={customer.phone || ''} onBlur={(e) => {
                  if (e.target.value !== (customer.phone || '')) updateMutation.mutate({ phone: e.target.value || null });
                }} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Note generali</Label>
              <Textarea defaultValue={customer.notes || ''} rows={3} onBlur={(e) => {
                if (e.target.value !== (customer.notes || '')) updateMutation.mutate({ notes: e.target.value || null });
              }} />
            </div>
          </div>

          {/* Portal Access */}
          <div className="rounded-lg border bg-card p-6 space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Portale Cliente</h3>
            </div>

            {/* Portal Logo */}
            <div className="space-y-1.5">
              <Label>Logo portale (URL immagine)</Label>
              <div className="flex gap-2">
                <Input
                  defaultValue={(customer as any).portal_logo || ''}
                  placeholder="https://..."
                  onBlur={(e) => {
                    const val = e.target.value.trim() || null;
                    if (val !== ((customer as any).portal_logo || null)) {
                      updateMutation.mutate({ portal_logo: val } as any);
                    }
                  }}
                  className="flex-1"
                />
                {(customer as any).portal_logo && (
                  <img src={(customer as any).portal_logo} alt="" className="h-9 w-9 rounded object-contain border bg-muted" />
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">Logo personalizzato mostrato nel portale cliente</p>
            </div>

            {(customer as any).portal_access_code ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Codice:</span>
                  <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
                    {(customer as any).portal_access_code}
                  </code>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2 overflow-hidden">
                  <span className="truncate">{portalUrl}/clienti/p/{(customer as any).portal_access_code}</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={copyPortalLink} className="gap-1.5">
                    {copiedLink ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedLink ? 'Copiato' : 'Copia link'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => generateCodeMutation.mutate()} disabled={generateCodeMutation.isPending} className="gap-1.5">
                    <RefreshCw className={`h-3.5 w-3.5 ${generateCodeMutation.isPending ? 'animate-spin' : ''}`} />
                    Rigenera
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <a href={`${portalUrl}/clienti/p/${(customer as any).portal_access_code}`} target="_blank" rel="noopener noreferrer" className="gap-1.5">
                      <ExternalLink className="h-3.5 w-3.5" />
                      Apri
                    </a>
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-destructive hover:text-destructive"
                        disabled={revokeSessionsMutation.isPending}
                      >
                        <ShieldOff className="h-3.5 w-3.5" />
                        Revoca sessioni
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revocare tutte le sessioni portale?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Tutti i token JWT esistenti per questo cliente verranno invalidati.
                          Il cliente dovrà rifare il login (magic link o codice). Il codice di
                          accesso non viene cambiato. Operazione registrata nell'audit log.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Annulla</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => revokeSessionsMutation.mutate()}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Revoca
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <p className="text-sm text-muted-foreground">Nessun accesso portale configurato</p>
                <Button size="sm" onClick={() => generateCodeMutation.mutate()} disabled={generateCodeMutation.isPending} className="gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" />
                  Genera codice
                </Button>
              </div>
            )}
          </div>
        </TabsContent>

        {/* Projects tab */}
        <TabsContent value="projects">
          {projects.length === 0 ? (
            <EmptyState title="Nessun progetto" description="Converti un lead dalla pipeline per creare il primo progetto" icon={FolderKanban} />
          ) : (
            <div className="rounded-lg border bg-card divide-y">
              {projects.map((p: any) => (
                <div
                  key={p.id}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => navigate(`/progetti/${p.id}`)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{p.project_type} · {p.status}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">→</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Payments tab */}
        <TabsContent value="payments">
          {payments.length === 0 ? (
            <EmptyState title="Nessun pagamento" description="I pagamenti tracciati per questo cliente appariranno qui" icon={Receipt} />
          ) : (
            <div className="rounded-lg border bg-card divide-y">
              {payments.map((p: any) => (
                <div key={p.id} className="flex items-center gap-4 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{p.description}</p>
                    <p className="text-xs text-muted-foreground">{p.due_date ? new Date(p.due_date).toLocaleDateString('it-IT') : 'Nessuna scadenza'}</p>
                  </div>
                  <span className="text-sm font-medium">€{parseFloat(p.amount).toLocaleString('it-IT')}</span>
                  <Badge variant="outline" className="text-xs">{p.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Domains tab */}
        <TabsContent value="domains">
          {domains.length === 0 ? (
            <EmptyState title="Nessun dominio" description="I domini associati a questo cliente appariranno qui" icon={Globe} />
          ) : (
            <div className="rounded-lg border bg-card divide-y">
              {domains.map((d: any) => (
                <div key={d.id} className="flex items-center gap-4 px-4 py-3">
                  <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{d.domain_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Scadenza: {d.expiry_date ? new Date(d.expiry_date).toLocaleDateString('it-IT') : 'N/D'}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-xs">{d.auto_renew ? 'Auto-rinnovo' : 'Manuale'}</Badge>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Reports tab */}
        <TabsContent value="reports">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Report Portale</h3>
              <Button size="sm" onClick={() => setShowReportForm(!showReportForm)} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Pubblica report
              </Button>
            </div>

            {showReportForm && (
              <div className="rounded-lg border bg-card p-4 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="space-y-1">
                    <Label>Mese</Label>
                    <Select value={reportMonth} onValueChange={setReportMonth}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'].map((m, i) => (
                          <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Anno</Label>
                    <Input value={reportYear} onChange={(e) => setReportYear(e.target.value)} />
                  </div>
                  <div className="space-y-1 col-span-2">
                    <Label>Progetto (opzionale)</Label>
                    <Select value={reportProjectId} onValueChange={setReportProjectId}>
                      <SelectTrigger><SelectValue placeholder="Nessuno" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">Nessuno</SelectItem>
                        {projects.map((p: any) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>Titolo</Label>
                  <Input
                    value={reportTitle}
                    onChange={(e) => setReportTitle(e.target.value)}
                    placeholder={`Report ${['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'][Number(reportMonth)]} ${reportYear}`}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Riepilogo</Label>
                  <Textarea
                    value={reportSummary}
                    onChange={(e) => setReportSummary(e.target.value)}
                    placeholder="Attività svolte nel periodo..."
                    rows={3}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={publishReportMutation.isPending}
                    onClick={() => {
                      const title = reportTitle.trim() || `Report ${['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'][Number(reportMonth)]} ${reportYear}`;
                      publishReportMutation.mutate({
                        customer_id: id,
                        month: Number(reportMonth),
                        year: Number(reportYear),
                        title,
                        summary: reportSummary.trim() || undefined,
                        project_id: reportProjectId || undefined,
                      });
                    }}
                  >
                    Pubblica
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowReportForm(false)}>Annulla</Button>
                </div>
              </div>
            )}

            {reports.length === 0 && !showReportForm ? (
              <EmptyState title="Nessun report" description="Pubblica il primo report mensile per il cliente" icon={FileBarChart} />
            ) : (
              <div className="space-y-2">
                {reports.map((r: any) => (
                  <div key={r.id} className="rounded-lg border bg-card px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{r.title}</p>
                        {r.summary && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{r.summary}</p>}
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {r.published_at ? new Date(r.published_at).toLocaleDateString('it-IT') : 'Bozza'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Notes tab */}
        <TabsContent value="notes">
          <div className="space-y-4">
            {/* Add note form */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex gap-2">
                <Select value={noteType} onValueChange={setNoteType}>
                  <SelectTrigger className="w-[130px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="note">Nota</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="call">Chiamata</SelectItem>
                    <SelectItem value="meeting">Meeting</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Scrivi una nota..."
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  className="flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && noteContent.trim()) {
                      addNoteMutation.mutate({ customer_id: id!, content: noteContent.trim(), type: noteType });
                    }
                  }}
                />
                <Button
                  size="icon"
                  disabled={!noteContent.trim() || addNoteMutation.isPending}
                  onClick={() => {
                    if (noteContent.trim()) {
                      addNoteMutation.mutate({ customer_id: id!, content: noteContent.trim(), type: noteType });
                    }
                  }}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Notes list */}
            {notes.length === 0 ? (
              <EmptyState title="Nessuna nota" description="Aggiungi la prima nota per tracciare le interazioni" icon={MessageSquare} />
            ) : (
              <div className="space-y-2">
                {notes.map((note) => {
                  const typeCfg = NOTE_TYPE_CONFIG[note.type] || NOTE_TYPE_CONFIG.note;
                  return (
                    <div key={note.id} className="rounded-lg border bg-card px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="secondary" className="text-[10px]">{typeCfg.label}</Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(note.created_at).toLocaleDateString('it-IT', {
                            day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <p className="text-sm">{note.content}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Portal preview — what the customer sees when logged into /portal */}
        <TabsContent value="portal-preview">
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 border-dashed p-3 flex items-start gap-3">
              <Eye className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Vista del cliente</p>
                <p>Mostra le entità così come le vede {customer?.contact_name || 'il cliente'} nel proprio portale.
                Le voci con badge <span className="text-foreground font-medium">"nascosto"</span> sono
                presenti in admin ma non vengono mostrate al cliente.</p>
              </div>
            </div>

            {portalPreviewLoading ? (
              <LoadingState />
            ) : !portalPreviewData ? (
              <EmptyState
                title="Nessun dato"
                description="L'anteprima non è ancora stata caricata."
                icon={Eye}
              />
            ) : (
              <>
                {/* Summary KPIs */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="rounded-lg border bg-card p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Progetti visibili</p>
                    <p className="text-xl font-semibold mt-1 tabular-nums">
                      {portalPreviewData.summary.projects_visible} <span className="text-xs text-muted-foreground">/ {portalPreviewData.summary.projects_total}</span>
                    </p>
                  </div>
                  <div className="rounded-lg border bg-card p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Schedule pagate</p>
                    <p className="text-xl font-semibold mt-1 tabular-nums">
                      {portalPreviewData.summary.schedules_paid} <span className="text-xs text-muted-foreground">/ {portalPreviewData.summary.schedules_total}</span>
                    </p>
                  </div>
                  <div className="rounded-lg border bg-card p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Fatture</p>
                    <p className="text-xl font-semibold mt-1 tabular-nums">{portalPreviewData.summary.invoices_total}</p>
                  </div>
                  <div className="rounded-lg border bg-card p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Totale fatturato</p>
                    <p className="text-xl font-semibold mt-1 tabular-nums">
                      €{Number(portalPreviewData.summary.invoices_total_amount).toLocaleString('it-IT', { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                </div>

                {/* Projects */}
                <div className="rounded-lg border bg-card overflow-hidden">
                  <div className="px-4 py-2.5 border-b bg-muted/20 flex items-center gap-2">
                    <FolderKanban className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="text-xs font-semibold uppercase tracking-wider">Progetti</p>
                  </div>
                  {portalPreviewData.projects.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-4 py-3">Nessun progetto.</p>
                  ) : (
                    <div className="divide-y">
                      {portalPreviewData.projects.map((p) => (
                        <div key={p.id} className="px-4 py-2.5 flex items-center gap-3">
                          {!p.visible_to_client && (
                            <EyeOff className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className={cn(
                              'text-sm font-medium truncate',
                              !p.visible_to_client && 'text-muted-foreground italic',
                            )}>{p.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {p.status}{p.project_category ? ` · ${p.project_category}` : ''}
                            </p>
                          </div>
                          {p.progress_percentage != null && (
                            <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                              {p.progress_percentage}%
                            </span>
                          )}
                          {!p.visible_to_client && (
                            <Badge variant="outline" className="text-[10px] shrink-0">nascosto</Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Payment schedules */}
                <div className="rounded-lg border bg-card overflow-hidden">
                  <div className="px-4 py-2.5 border-b bg-muted/20 flex items-center gap-2">
                    <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="text-xs font-semibold uppercase tracking-wider">Pagamenti pianificati</p>
                  </div>
                  {portalPreviewData.schedules.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-4 py-3">Nessuna schedule attiva.</p>
                  ) : (
                    <div className="divide-y">
                      {portalPreviewData.schedules.map((s) => (
                        <div key={s.id} className="px-4 py-2.5 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{s.title}</p>
                            <p className="text-xs text-muted-foreground">
                              {s.project?.name ? `${s.project.name} · ` : ''}
                              {s.due_date ? new Date(s.due_date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }) : 'senza scadenza'}
                            </p>
                          </div>
                          <Badge variant="outline" className="text-[10px] shrink-0">{s.status}</Badge>
                          <span className="text-sm font-semibold tabular-nums shrink-0">
                            €{Number(s.amount || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Invoices */}
                <div className="rounded-lg border bg-card overflow-hidden">
                  <div className="px-4 py-2.5 border-b bg-muted/20 flex items-center gap-2">
                    <FileBarChart className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="text-xs font-semibold uppercase tracking-wider">Fatture</p>
                  </div>
                  {portalPreviewData.invoices.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-4 py-3">Nessuna fattura.</p>
                  ) : (
                    <div className="divide-y">
                      {portalPreviewData.invoices.map((i) => (
                        <div key={i.id} className="px-4 py-2.5 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{i.invoice_number || 'Bozza'}</p>
                            <p className="text-xs text-muted-foreground">
                              {i.issue_date ? new Date(i.issue_date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                            </p>
                          </div>
                          <Badge variant="outline" className="text-[10px] shrink-0">{i.status}</Badge>
                          <span className="text-sm font-semibold tabular-nums shrink-0">
                            €{Number(i.total || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
