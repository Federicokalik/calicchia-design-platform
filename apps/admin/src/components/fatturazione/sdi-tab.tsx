import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FileCode2, FileCheck2, FileWarning, Search, Download, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { downloadSdiXml } from '@/lib/sdi';
import { cn } from '@/lib/utils';

type SdiStatus = 'pending' | 'generated' | 'sent' | 'accepted' | 'rejected';

type InvoiceRow = {
  id: string;
  invoice_number: string | null;
  status: string;
  total: number | string | null;
  amount_due: number | string | null;
  issue_date: string | null;
  due_date: string | null;
  sdi_status: SdiStatus | null;
  sdi_xml_generated_at: string | null;
  sdi_xml_filename: string | null;
  customers: {
    id: string;
    company_name: string | null;
    contact_name: string | null;
    email: string | null;
  } | null;
};

const INVOICE_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  open: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  paid: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  void: 'bg-zinc-100 text-zinc-500',
  uncollectible: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const SDI_STATUS_LABELS: Record<SdiStatus, string> = {
  pending: 'Da generare',
  generated: 'Generato',
  sent: 'Inviato',
  accepted: 'Accettato',
  rejected: 'Scartato',
};

const SDI_STATUS_COLORS: Record<SdiStatus, string> = {
  pending: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  generated: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  accepted: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

function customerLabel(customer: InvoiceRow['customers']): string {
  if (!customer) return '—';
  return customer.company_name || customer.contact_name || customer.email || '—';
}

function formatAmount(value: number | string | null): string {
  const n = Number(value || 0);
  return `€${n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SdiTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('non-draft');
  const [sdiFilter, setSdiFilter] = useState<string>('all');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ invoices: InvoiceRow[] }>({
    queryKey: ['invoices', 'sdi-tab'],
    queryFn: () => apiFetch('/api/invoices'),
  });

  const rows = data?.invoices || [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter === 'non-draft' && row.status === 'draft') return false;
      if (statusFilter !== 'non-draft' && statusFilter !== 'all' && row.status !== statusFilter) return false;

      const sdi = row.sdi_status ?? 'pending';
      if (sdiFilter === 'missing' && sdi !== 'pending') return false;
      if (sdiFilter === 'done' && sdi === 'pending') return false;
      if (sdiFilter !== 'all' && sdiFilter !== 'missing' && sdiFilter !== 'done' && sdi !== sdiFilter) return false;

      if (term) {
        const haystack = [
          row.invoice_number,
          customerLabel(row.customers),
          row.sdi_xml_filename,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(term)) return false;
      }

      return true;
    });
  }, [rows, search, statusFilter, sdiFilter]);

  const eligibleRows = rows.filter((r) => r.status !== 'draft');
  const generatedCount = eligibleRows.filter((r) => (r.sdi_status ?? 'pending') !== 'pending').length;
  const missingCount = eligibleRows.length - generatedCount;
  const lastGenerated = eligibleRows
    .map((r) => r.sdi_xml_generated_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();

  async function handleDownload(row: InvoiceRow) {
    setDownloadingId(row.id);
    try {
      await downloadSdiXml(row.id);
      toast.success(`XML scaricato · ${row.invoice_number || row.id}`);
      queryClient.invalidateQueries({ queryKey: ['invoices', 'sdi-tab'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore generazione XML');
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* KPI */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <FileCode2 className="h-4 w-4" />
            <span className="text-xs">Fatture emesse</span>
          </div>
          <p className="text-xl font-bold">{eligibleRows.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <FileCheck2 className="h-4 w-4" />
            <span className="text-xs">XML generati</span>
          </div>
          <p className="text-xl font-bold text-emerald-600">{generatedCount}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <FileWarning className="h-4 w-4" />
            <span className="text-xs">XML mancanti</span>
          </div>
          <p className="text-xl font-bold text-amber-600">{missingCount}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <FileCode2 className="h-4 w-4" />
            <span className="text-xs">Ultimo generato</span>
          </div>
          <p className="text-sm font-semibold">{lastGenerated ? formatDate(lastGenerated) : '—'}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cerca numero, cliente, filename…"
            className="pl-8 h-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="non-draft">Non bozze</SelectItem>
            <SelectItem value="all">Tutti gli stati</SelectItem>
            <SelectItem value="open">Aperte</SelectItem>
            <SelectItem value="paid">Pagate</SelectItem>
            <SelectItem value="void">Annullate</SelectItem>
            <SelectItem value="draft">Bozze</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sdiFilter} onValueChange={setSdiFilter}>
          <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti SDI</SelectItem>
            <SelectItem value="missing">Da generare</SelectItem>
            <SelectItem value="done">Generati</SelectItem>
            <SelectItem value="generated">Solo generated</SelectItem>
            <SelectItem value="sent">Solo sent</SelectItem>
            <SelectItem value="accepted">Solo accepted</SelectItem>
            <SelectItem value="rejected">Solo rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Nessuna fattura"
          description={
            rows.length === 0
              ? 'Non hai ancora emesso fatture. Crea una fattura da Progetti → Crea fattura milestone.'
              : 'Nessuna fattura corrisponde ai filtri.'
          }
          icon={FileCode2}
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          {filtered.map((row) => {
            const sdiStatus: SdiStatus = row.sdi_status ?? 'pending';
            const sdiGenerated = sdiStatus !== 'pending';
            const isDraft = row.status === 'draft';
            const downloading = downloadingId === row.id;

            return (
              <div
                key={row.id}
                className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{row.invoice_number || 'Bozza'}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {customerLabel(row.customers)}
                    {row.issue_date ? ` · ${formatDate(row.issue_date)}` : ''}
                    {row.sdi_xml_filename ? ` · ${row.sdi_xml_filename}` : ''}
                  </p>
                </div>

                <Badge variant="outline" className={cn('text-[10px] shrink-0', INVOICE_STATUS_COLORS[row.status] || '')}>
                  {row.status}
                </Badge>

                <Badge variant="outline" className={cn('text-[10px] shrink-0', SDI_STATUS_COLORS[sdiStatus])}>
                  SDI · {SDI_STATUS_LABELS[sdiStatus]}
                </Badge>

                <span className="text-sm font-semibold tabular-nums shrink-0 min-w-[80px] text-right">
                  {formatAmount(row.total ?? row.amount_due)}
                </span>

                <Button
                  type="button"
                  size="sm"
                  variant={sdiGenerated ? 'outline' : 'default'}
                  className="shrink-0"
                  disabled={isDraft || downloading}
                  title={
                    isDraft
                      ? 'Emetti la fattura prima di generare XML SDI'
                      : sdiGenerated
                        ? `XML già generato${row.sdi_xml_generated_at ? ` il ${formatDate(row.sdi_xml_generated_at)}` : ''} · clicca per riscaricare`
                        : 'Genera e scarica XML FatturaPA'
                  }
                  onClick={() => handleDownload(row)}
                >
                  {downloading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {sdiGenerated ? 'Riscarica' : 'Scarica XML'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
