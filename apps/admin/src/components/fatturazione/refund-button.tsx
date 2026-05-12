import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';

interface Props {
  linkId: string;
  provider: 'stripe' | 'paypal' | 'revolut' | 'bank_transfer';
  linkAmount: number;
  refundedAmount: number;
  currency: string;
  disabled?: boolean;
}

function fmtEur(amount: number, currency = 'EUR') {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency }).format(amount);
}

export function RefundButton({ linkId, provider, linkAmount, refundedAmount, currency, disabled }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const remaining = Math.max(0, linkAmount - refundedAmount);
  const isFullRefund = !amount || parseFloat(amount) === remaining;

  const refundMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/payments/links/${linkId}/refund`, {
        method: 'POST',
        body: JSON.stringify({
          amount: amount ? parseFloat(amount) : undefined,
          reason: reason.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success(isFullRefund ? 'Rimborso completo eseguito' : 'Rimborso parziale eseguito');
      queryClient.invalidateQueries({ queryKey: ['payment-links'] });
      queryClient.invalidateQueries({ queryKey: ['payment-schedules'] });
      setOpen(false);
      setAmount('');
      setReason('');
    },
    onError: (err: Error) => toast.error(err.message || 'Errore rimborso'),
  });

  if (provider === 'bank_transfer' || provider === 'revolut') {
    // Bank transfer + Revolut: refund manuale, non via API
    return null;
  }

  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-300"
        disabled={disabled || remaining <= 0}
        onClick={() => setOpen(true)}
        title="Rimborsa"
      >
        <Undo2 className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rimborsa pagamento</DialogTitle>
            <DialogDescription>
              Pagato: <strong>{fmtEur(linkAmount, currency)}</strong> ·
              Rimborsato: <strong>{fmtEur(refundedAmount, currency)}</strong> ·
              Rimanente: <strong>{fmtEur(remaining, currency)}</strong>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="refund-amount">
                Importo da rimborsare (lascia vuoto per rimborso completo di {fmtEur(remaining, currency)})
              </Label>
              <Input
                id="refund-amount"
                type="number"
                step="0.01"
                min="0.01"
                max={remaining}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={`Max ${fmtEur(remaining, currency)}`}
              />
            </div>

            <div>
              <Label htmlFor="refund-reason">Motivo (opzionale, salvato nello storico)</Label>
              <Textarea
                id="refund-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Es. Cliente ha cancellato il progetto entro 7 giorni"
                rows={2}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              Il rimborso verrà processato direttamente su <strong>{provider === 'stripe' ? 'Stripe' : 'PayPal'}</strong>.
              Il cliente riceverà l'accredito secondo i tempi del provider (3-10 giorni lavorativi).
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Annulla</Button>
            <Button
              variant="destructive"
              onClick={() => refundMutation.mutate()}
              disabled={refundMutation.isPending}
            >
              {refundMutation.isPending
                ? 'Rimborso in corso…'
                : isFullRefund
                  ? `Rimborsa ${fmtEur(remaining, currency)}`
                  : `Rimborsa ${fmtEur(parseFloat(amount) || 0, currency)}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
