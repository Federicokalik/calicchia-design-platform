import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';
import type { Service } from '@/pages/servizi';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  service?: Service;
}

interface FormState {
  name: string;
  description: string;
  price: string;
  currency: string;
  billing_interval: 'one_time' | 'month' | 'year';
  category: 'hosting' | 'domain' | 'maintenance' | 'development' | 'other';
  is_active: boolean;
}

const EMPTY: FormState = {
  name: '',
  description: '',
  price: '',
  currency: 'EUR',
  billing_interval: 'one_time',
  category: 'other',
  is_active: true,
};

export function ServiceFormDialog({ open, onOpenChange, mode, service }: Props) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY);

  useEffect(() => {
    if (!open) return;
    if (service) {
      setForm({
        name: service.name,
        description: service.description ?? '',
        price: String(service.price),
        currency: service.currency,
        billing_interval: service.billing_interval,
        category: service.category,
        is_active: service.is_active,
      });
    } else {
      setForm(EMPTY);
    }
  }, [open, service]);

  const mutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (mode === 'create') {
        return apiFetch('/api/services', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      return apiFetch(`/api/services/${service!.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (data: { warnings?: string[] }) => {
      toast.success(mode === 'create' ? 'Servizio creato' : 'Servizio aggiornato');
      data?.warnings?.forEach((w) => toast.warning(w));
      queryClient.invalidateQueries({ queryKey: ['services'] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore salvataggio'),
  });

  function handleSubmit() {
    const price = parseFloat(form.price);
    if (!form.name.trim() || !isFinite(price) || price <= 0) {
      toast.error('Inserisci nome e prezzo validi');
      return;
    }
    mutation.mutate({
      name: form.name.trim(),
      description: form.description.trim() || null,
      price,
      currency: form.currency.toUpperCase(),
      billing_interval: form.billing_interval,
      category: form.category,
      is_active: form.is_active,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'Nuovo servizio' : `Modifica: ${service?.name}`}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'I servizi sono riusabili in preventivi, fatture e abbonamenti.'
              : 'Cambiare prezzo o intervallo richiede un ri-sync con Stripe/PayPal.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="svc-name">Nome</Label>
            <Input
              id="svc-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Es. Logo design, Hosting annuale"
            />
          </div>

          <div>
            <Label htmlFor="svc-desc">Descrizione</Label>
            <Textarea
              id="svc-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Cosa include (opzionale)"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="svc-price">Prezzo</Label>
              <Input
                id="svc-price"
                type="number"
                step="0.01"
                min="0"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                placeholder="0.00"
              />
            </div>
            <div>
              <Label htmlFor="svc-currency">Valuta</Label>
              <Input
                id="svc-currency"
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                maxLength={3}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="svc-interval">Intervallo</Label>
              <Select
                value={form.billing_interval}
                onValueChange={(v) => setForm({ ...form, billing_interval: v as FormState['billing_interval'] })}
              >
                <SelectTrigger id="svc-interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="one_time">Una tantum</SelectItem>
                  <SelectItem value="month">Mensile</SelectItem>
                  <SelectItem value="year">Annuale</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="svc-cat">Categoria</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v as FormState['category'] })}
              >
                <SelectTrigger id="svc-cat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="development">Sviluppo</SelectItem>
                  <SelectItem value="hosting">Hosting</SelectItem>
                  <SelectItem value="domain">Dominio</SelectItem>
                  <SelectItem value="maintenance">Manutenzione</SelectItem>
                  <SelectItem value="other">Altro</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="svc-active" className="cursor-pointer">Servizio attivo</Label>
              <p className="text-xs text-muted-foreground">
                Disattivati non appaiono nei selettori preventivo/fattura
              </p>
            </div>
            <Switch
              id="svc-active"
              checked={form.is_active}
              onCheckedChange={(v) => setForm({ ...form, is_active: v })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? 'Salvataggio…' : mode === 'create' ? 'Crea servizio' : 'Salva modifiche'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
