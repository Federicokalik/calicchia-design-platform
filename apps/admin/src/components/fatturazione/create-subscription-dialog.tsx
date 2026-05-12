import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';

interface Service {
  id: string;
  name: string;
  price: number;
  currency: string;
  billing_interval: 'one_time' | 'month' | 'year';
  stripe_price_id: string | null;
  paypal_plan_id: string | null;
  is_active: boolean;
}

interface Customer {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  email: string;
  stripe_customer_id: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefilledCustomerId?: string;
}

export function CreateSubscriptionDialog({ open, onOpenChange, prefilledCustomerId }: Props) {
  const queryClient = useQueryClient();
  const [customerId, setCustomerId] = useState(prefilledCustomerId ?? '');
  const [serviceId, setServiceId] = useState('');
  const [provider, setProvider] = useState<'stripe' | 'paypal'>('stripe');

  useEffect(() => {
    if (!open) {
      setCustomerId(prefilledCustomerId ?? '');
      setServiceId('');
      setProvider('stripe');
    }
  }, [open, prefilledCustomerId]);

  const { data: customersData } = useQuery<{ customers: Customer[] }>({
    queryKey: ['customers-light'],
    queryFn: () => apiFetch('/api/customers'),
    enabled: open,
  });

  const { data: servicesData } = useQuery<{ services: Service[] }>({
    queryKey: ['services-recurring'],
    queryFn: () => apiFetch('/api/services?recurring=true&active=true'),
    enabled: open,
  });

  const customers = customersData?.customers ?? [];
  const services = (servicesData?.services ?? []).filter((s) => s.is_active);
  const selectedService = services.find((s) => s.id === serviceId) ?? null;

  const canSubmitStripe = !!selectedService?.stripe_price_id;
  const canSubmitPaypal = !!selectedService?.paypal_plan_id;
  const canSubmit = provider === 'stripe' ? canSubmitStripe : canSubmitPaypal;

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/subscriptions', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (data: { approve_url?: string; subscription_id?: string }) => {
      toast.success('Abbonamento creato. Invio link al cliente…');
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      onOpenChange(false);
      if (data?.approve_url) {
        // Open approve URL in new tab so admin can verify or share
        window.open(data.approve_url, '_blank', 'noopener');
      }
    },
    onError: (err: Error) => toast.error(err.message || 'Errore creazione abbonamento'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Nuovo abbonamento</DialogTitle>
          <DialogDescription>
            Crea una sottoscrizione ricorrente per il cliente. Il provider invierà una
            mail di autorizzazione; alla conferma il cliente sarà addebitato automaticamente.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="sub-customer">Cliente</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger id="sub-customer">
                <SelectValue placeholder="Seleziona cliente…" />
              </SelectTrigger>
              <SelectContent>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.company_name || c.contact_name || c.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="sub-service">Servizio ricorrente</Label>
            <Select value={serviceId} onValueChange={setServiceId}>
              <SelectTrigger id="sub-service">
                <SelectValue placeholder="Seleziona servizio…" />
              </SelectTrigger>
              <SelectContent>
                {services.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    Nessun servizio ricorrente. Crealo prima in /servizi.
                  </div>
                ) : (
                  services.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} · {new Intl.NumberFormat('it-IT', { style: 'currency', currency: s.currency }).format(s.price)}/{s.billing_interval === 'month' ? 'mese' : 'anno'}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="sub-provider">Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as 'stripe' | 'paypal')}>
              <SelectTrigger id="sub-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stripe">Stripe (carta di credito)</SelectItem>
                <SelectItem value="paypal">PayPal</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selectedService && !canSubmit && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/50 dark:text-amber-200">
              ⚠ Questo servizio non è ancora sync con <strong>{provider === 'stripe' ? 'Stripe' : 'PayPal'}</strong>.
              Vai su <code>/servizi</code> → menu → "Sync con {provider === 'stripe' ? 'Stripe' : 'PayPal'}" prima di creare l'abbonamento.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button
            onClick={() => createMutation.mutate({
              customer_id: customerId,
              service_id: serviceId,
              provider,
            })}
            disabled={!customerId || !serviceId || !canSubmit || createMutation.isPending}
          >
            {createMutation.isPending ? 'Creazione…' : 'Crea abbonamento'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
