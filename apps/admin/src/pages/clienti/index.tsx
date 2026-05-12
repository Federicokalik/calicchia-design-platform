import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Search, Plus, Building2, Mail, Phone,
  Filter,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { LoadingState } from '@/components/shared/loading-state';
import type { Customer } from '@/types/customer';
import { CUSTOMER_STATUS_CONFIG } from '@/types/customer';

export default function ClientiPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newForm, setNewForm] = useState({ contact_name: '', email: '', phone: '', company_name: '' });

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, string | null>) =>
      apiFetch('/api/customers', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setShowNewDialog(false);
      setNewForm({ contact_name: '', email: '', phone: '', company_name: '' });
      toast.success('Cliente creato');
      if (data?.customer?.id) navigate(`/clienti/${data.customer.id}`);
    },
    onError: () => toast.error('Errore nella creazione'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['customers', search, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      return apiFetch(`/api/customers?${params}`);
    },
  });

  const customers: Customer[] = data?.customers || [];
  const stats = data?.stats || { total: 0, active: 0, inactive: 0, suspended: 0 };

  const topbarActions = useMemo(() => (
    <Button onClick={() => setShowNewDialog(true)} size="sm">
      <Plus className="h-4 w-4 mr-1.5" />
      Nuovo Cliente
    </Button>
  ), []);

  useTopbar({
    title: 'Clienti',
    subtitle: `${stats.total} clienti · ${stats.active} attivi`,
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Cerca per nome, azienda, email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <Filter className="h-3.5 w-3.5 mr-1.5" />
            <SelectValue placeholder="Stato" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti</SelectItem>
            <SelectItem value="active">Attivi</SelectItem>
            <SelectItem value="inactive">Inattivi</SelectItem>
            <SelectItem value="suspended">Sospesi</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* List */}
      {isLoading ? (
        <LoadingState />
      ) : customers.length === 0 ? (
        <EmptyState
          title="Nessun cliente"
          description={search ? 'Prova con una ricerca diversa' : 'I clienti convertiti dalla pipeline appariranno qui'}
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          {/* Table header */}
          <div className="hidden sm:grid grid-cols-[1fr_1fr_140px_120px_80px] gap-4 px-4 py-2.5 border-b bg-muted/50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <span>Cliente</span>
            <span>Contatto</span>
            <span>Revenue</span>
            <span>Stato</span>
            <span></span>
          </div>

          {/* Rows */}
          {customers.map((customer) => {
            const statusCfg = CUSTOMER_STATUS_CONFIG[customer.status];
            return (
              <div
                key={customer.id}
                onClick={() => navigate(`/clienti/${customer.id}`)}
                className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_140px_120px_80px] gap-2 sm:gap-4 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors items-center"
              >
                {/* Name + Company */}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{customer.contact_name}</p>
                  {customer.company_name && (
                    <div className="flex items-center gap-1 mt-0.5">
                      <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground truncate">{customer.company_name}</span>
                    </div>
                  )}
                </div>

                {/* Contact info */}
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-1">
                    <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{customer.email}</span>
                  </div>
                  {customer.phone && (
                    <div className="flex items-center gap-1">
                      <Phone className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground">{customer.phone}</span>
                    </div>
                  )}
                </div>

                {/* Revenue */}
                <div>
                  <span className="text-sm font-medium">
                    €{(customer.total_revenue || 0).toLocaleString('it-IT')}
                  </span>
                </div>

                {/* Status */}
                <div>
                  <StatusBadge {...statusCfg} />
                </div>

                {/* Arrow */}
                <div className="hidden sm:flex justify-end">
                  <span className="text-muted-foreground text-xs">→</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New customer dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nuovo Cliente</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!newForm.contact_name.trim() || !newForm.email.trim()) return;
              createMutation.mutate({
                contact_name: newForm.contact_name.trim(),
                email: newForm.email.trim(),
                phone: newForm.phone || null,
                company_name: newForm.company_name || null,
              });
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label>Nome contatto *</Label>
              <Input
                value={newForm.contact_name}
                onChange={(e) => setNewForm({ ...newForm, contact_name: e.target.value })}
                placeholder="Mario Rossi"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label>Email *</Label>
              <Input
                type="email"
                value={newForm.email}
                onChange={(e) => setNewForm({ ...newForm, email: e.target.value })}
                placeholder="mario@example.com"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Telefono</Label>
                <Input
                  value={newForm.phone}
                  onChange={(e) => setNewForm({ ...newForm, phone: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Azienda</Label>
                <Input
                  value={newForm.company_name}
                  onChange={(e) => setNewForm({ ...newForm, company_name: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNewDialog(false)}>
                Annulla
              </Button>
              <Button type="submit" disabled={!newForm.contact_name.trim() || !newForm.email.trim() || createMutation.isPending}>
                Crea Cliente
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
