import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink, Mail, Globe, Building2, Phone, FileText, Receipt, Loader2 } from 'lucide-react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { formatPhoneE164 } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Customer {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  status: string | null;
}

interface Lead {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: string | null;
  source: string | null;
  estimated_value: number | null;
}

interface Quote {
  id: string;
  quote_number: string | null;
  title: string | null;
  status: string;
  total: number | null;
  issue_date: string | null;
}

interface Invoice {
  id: string;
  invoice_number: string | null;
  status: string;
  total: number | null;
  issue_date: string | null;
  due_date: string | null;
}

interface CustomerPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string | null;
  leadId: string | null;
}

function fmtMoney(n: number | null | undefined) {
  if (n == null) return '—';
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n);
}

function fmtDate(s: string | null | undefined) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

const QUOTE_STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  sent: 'bg-blue-100 text-blue-700',
  viewed: 'bg-blue-100 text-blue-700',
  accepted: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-rose-100 text-rose-700',
  expired: 'bg-amber-100 text-amber-700',
  converted: 'bg-violet-100 text-violet-700',
};

const INVOICE_STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  open: 'bg-blue-100 text-blue-700',
  paid: 'bg-emerald-100 text-emerald-700',
  void: 'bg-rose-100 text-rose-700',
  overdue: 'bg-amber-100 text-amber-700',
};

export function CustomerPanel({ open, onOpenChange, customerId, leadId }: CustomerPanelProps) {
  const isCustomer = Boolean(customerId);
  // Audit J-K-02: no /leads/:id route exists — leads live in the pipeline
  // kanban. Same for invoices (no /fatture/:id, billing is a single page).
  // Surface the linked entity via the existing pages with a query param so the
  // user lands close to the right card instead of getting catch-all redirected.
  const entityHref = isCustomer
    ? `/clienti/${customerId}`
    : leadId
      ? `/pipeline?lead=${leadId}`
      : null;

  const { data: customerData, isLoading: loadingCustomer } = useQuery<{ customer: Customer }>({
    queryKey: ['wa-panel-customer', customerId],
    queryFn: () => apiFetch(`/api/customers/${customerId}`),
    enabled: open && Boolean(customerId),
  });
  const customer = customerData?.customer;

  const { data: leadData, isLoading: loadingLead } = useQuery<{ lead: Lead }>({
    queryKey: ['wa-panel-lead', leadId],
    queryFn: () => apiFetch(`/api/leads/${leadId}`),
    enabled: open && Boolean(leadId) && !isCustomer,
  });
  const lead = leadData?.lead;

  const { data: quotesData } = useQuery<{ quotes: Quote[] }>({
    queryKey: ['wa-panel-quotes', customerId],
    queryFn: () => apiFetch(`/api/quotes?customer_id=${customerId}`),
    enabled: open && Boolean(customerId),
  });
  const quotes = (quotesData?.quotes ?? []).slice(0, 5);

  const { data: invoicesData } = useQuery<{ invoices: Invoice[] }>({
    queryKey: ['wa-panel-invoices', customerId],
    queryFn: () => apiFetch(`/api/invoices?customer_id=${customerId}`),
    enabled: open && Boolean(customerId),
  });
  const invoices = (invoicesData?.invoices ?? []).slice(0, 5);

  const isLoading = (isCustomer && loadingCustomer) || (!isCustomer && loadingLead);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">
            {isCustomer ? 'Scheda cliente' : 'Scheda lead'}
            {entityHref && (
              <Link to={entityHref} className="ml-auto">
                <Button size="sm" variant="outline">
                  <ExternalLink className="h-3.5 w-3.5 mr-1" /> Apri scheda
                </Button>
              </Link>
            )}
          </SheetTitle>
          <SheetDescription>
            Lettura rapida di anagrafica e ultimi documenti senza lasciare la chat.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : isCustomer ? (
            <CustomerBody customer={customer} quotes={quotes} invoices={invoices} />
          ) : lead ? (
            <LeadBody lead={lead} />
          ) : (
            <p className="text-sm text-muted-foreground">Nessuno scheda collegata a questa conversazione.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CustomerBody({ customer, quotes, invoices }: { customer: Customer | undefined; quotes: Quote[]; invoices: Invoice[] }) {
  if (!customer) return <p className="text-sm text-muted-foreground">Cliente non trovato.</p>;
  return (
    <Tabs defaultValue="profile" className="w-full">
      <TabsList className="grid grid-cols-3 w-full">
        <TabsTrigger value="profile">Anagrafica</TabsTrigger>
        <TabsTrigger value="quotes">
          Preventivi {quotes.length > 0 && <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{quotes.length}</Badge>}
        </TabsTrigger>
        <TabsTrigger value="invoices">
          Fatture {invoices.length > 0 && <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{invoices.length}</Badge>}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="profile" className="space-y-2 pt-4">
        <ProfileRow icon={Building2} label="Azienda" value={customer.company_name} />
        <ProfileRow icon={undefined} label="Contatto" value={customer.contact_name} />
        <ProfileRow icon={Mail} label="Email" value={customer.email} />
        <ProfileRow icon={Phone} label="Telefono" value={customer.phone ? formatPhoneE164(customer.phone) : null} />
        <ProfileRow icon={Globe} label="Sito" value={customer.website} link={customer.website ?? undefined} />
        {customer.status && (
          <div className="pt-2">
            <Badge variant="outline">{customer.status}</Badge>
          </div>
        )}
      </TabsContent>

      <TabsContent value="quotes" className="pt-4">
        {quotes.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Nessun preventivo.</p>
        ) : (
          <ul className="space-y-2">
            {quotes.map((q) => (
              <li key={q.id} className="rounded-md border bg-card p-2.5">
                <Link to={`/preventivi/${q.id}`} className="block hover:underline">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        <FileText className="h-3.5 w-3.5 inline mr-1 opacity-50" />
                        {q.quote_number || q.title || q.id.slice(0, 8)}
                      </p>
                      {q.title && q.quote_number && (
                        <p className="text-xs text-muted-foreground truncate">{q.title}</p>
                      )}
                    </div>
                    <Badge variant="outline" className={cn('text-[10px]', QUOTE_STATUS_BADGE[q.status] || '')}>
                      {q.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1 text-xs text-muted-foreground">
                    <span>{fmtDate(q.issue_date)}</span>
                    <span className="font-mono">{fmtMoney(q.total)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </TabsContent>

      <TabsContent value="invoices" className="pt-4">
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Nessuna fattura.</p>
        ) : (
          <ul className="space-y-2">
            {invoices.map((i) => (
              <li key={i.id} className="rounded-md border bg-card p-2.5">
                <Link to={`/fatturazione?invoice=${i.id}`} className="block hover:underline">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium truncate">
                      <Receipt className="h-3.5 w-3.5 inline mr-1 opacity-50" />
                      {i.invoice_number || i.id.slice(0, 8)}
                    </p>
                    <Badge variant="outline" className={cn('text-[10px]', INVOICE_STATUS_BADGE[i.status] || '')}>
                      {i.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1 text-xs text-muted-foreground">
                    <span>{fmtDate(i.issue_date)}</span>
                    <span className="font-mono">{fmtMoney(i.total)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </TabsContent>
    </Tabs>
  );
}

function LeadBody({ lead }: { lead: Lead | undefined }) {
  if (!lead) return <p className="text-sm text-muted-foreground">Lead non trovato.</p>;
  return (
    <div className="space-y-2">
      <ProfileRow icon={undefined} label="Nome" value={lead.name} />
      <ProfileRow icon={Building2} label="Azienda" value={lead.company} />
      <ProfileRow icon={Mail} label="Email" value={lead.email} />
      <ProfileRow icon={Phone} label="Telefono" value={lead.phone ? formatPhoneE164(lead.phone) : null} />
      <div className="flex gap-2 pt-2">
        {lead.status && <Badge variant="outline">{lead.status}</Badge>}
        {lead.source && <Badge variant="secondary">{lead.source}</Badge>}
      </div>
      {lead.estimated_value != null && (
        <p className="text-sm pt-1">
          <span className="text-muted-foreground">Valore stimato:</span> <span className="font-mono">{fmtMoney(lead.estimated_value)}</span>
        </p>
      )}
    </div>
  );
}

function ProfileRow({ icon: Icon, label, value, link }: { icon?: typeof Mail; label: string; value: string | null; link?: string }) {
  if (!value) return null;
  const content = link ? (
    <a href={link.startsWith('http') ? link : `https://${link}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
      {value}
    </a>
  ) : value;
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-muted-foreground inline-flex items-center gap-1 w-24 shrink-0">
        {Icon && <Icon className="h-3.5 w-3.5" />} {label}:
      </span>
      <span className="truncate">{content}</span>
    </div>
  );
}
