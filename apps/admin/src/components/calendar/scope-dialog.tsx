import type { CalV2Scope } from '@calicchia/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ScopeDialogProps {
  open: boolean;
  action: 'edit' | 'delete';
  allowed: CalV2Scope[];
  onChoose: (scope: CalV2Scope) => void;
  onCancel: () => void;
}

const SCOPE_LABELS: Record<CalV2Scope, string> = {
  this: 'Solo questo evento',
  this_and_future: 'Questo e tutti i successivi',
  all: 'Tutti gli eventi della serie',
};

const SCOPE_HINTS: Record<'edit' | 'delete', Record<CalV2Scope, string>> = {
  edit: {
    this: 'Le altre occorrenze restano come sono.',
    this_and_future: "La serie si divide: da questa occorrenza in poi nasce una serie nuova.",
    all: 'La modifica vale per ogni occorrenza non personalizzata.',
  },
  delete: {
    this: 'Le altre occorrenze restano.',
    this_and_future: 'La serie finisce prima di questa occorrenza.',
    all: 'Viene eliminata l\'intera serie.',
  },
};

/** Scelta dell'ambito di una modifica o di un'eliminazione su un evento ricorrente (contratto §3.7 e §3.8). */
export function ScopeDialog({ open, action, allowed, onChoose, onCancel }: ScopeDialogProps) {
  const order: CalV2Scope[] = ['this', 'this_and_future', 'all'];
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{action === 'edit' ? 'Modifica evento ricorrente' : 'Elimina evento ricorrente'}</DialogTitle>
          <DialogDescription>
            {action === 'edit' ? 'Quali eventi della serie vuoi modificare?' : 'Quali eventi della serie vuoi eliminare?'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {order.filter((s) => allowed.includes(s)).map((scope) => (
            <Button
              key={scope}
              type="button"
              data-testid={`cal-scope-${scope}`}
              variant={action === 'delete' && scope === 'all' ? 'destructive' : 'outline'}
              className="h-auto flex-col items-start gap-0.5 whitespace-normal py-2 text-left"
              onClick={() => onChoose(scope)}
            >
              <span>{SCOPE_LABELS[scope]}</span>
              <span className="text-xs font-normal opacity-80">{SCOPE_HINTS[action][scope]}</span>
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>Annulla</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
