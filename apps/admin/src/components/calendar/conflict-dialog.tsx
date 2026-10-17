import { useState } from 'react';
import type { CalV2Op, CalV2PreconditionFailedBody } from '@calicchia/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describeFieldValue, fieldLabel, opKey } from '@/lib/calendar-v2-model';

export interface ConflictDialogProps {
  open: boolean;
  body: CalV2PreconditionFailedBody;
  pendingOps: CalV2Op[];
  /** Campi per cui rimandare il proprio valore; gli altri prendono quello del server. */
  onResolve: (keepMine: Set<string>) => void;
  /** Scarta le proprie modifiche e apre la versione del server. */
  onReload: () => void;
  onCancel: () => void;
}

/** Fuso in cui mostrare gli orari: quello dell'inizio dell'evento se è un TZID, altrimenti quello del calendario. */
function eventTimeZone(body: CalV2PreconditionFailedBody): string {
  const start = body.current.target?.fields.start ?? body.current.master?.fields.start;
  if (start && start.type === 'date-time' && start.zone.kind === 'tzid') return start.zone.tzid;
  return body.current.calendar_tz || 'Europe/Rome';
}

/**
 * Conflitto di versione (412): l'evento è cambiato sul server mentre lo
 * modificavi. Per ogni campo in conflitto si sceglie fra il proprio valore e
 * quello attuale; le modifiche degli altri campi vengono applicate sopra la
 * versione del server. Senza conflitti per campo (eliminazione, o base
 * assente) offre "Ricarica" e "Applica comunque".
 */
export function ConflictDialog({ open, body, pendingOps, onResolve, onReload, onCancel }: ConflictDialogProps) {
  const tz = eventTimeZone(body);
  // Predefinito: il proprio valore (l'utente è venuto a salvare le sue modifiche); i valori sono ben visibili.
  const [mine, setMine] = useState<Record<string, boolean>>({});
  const hasConflicts = body.conflicts.length > 0;
  const conflictKeys = new Set(body.conflicts.map((c) => c.field));
  const merged = pendingOps.map(opKey).filter((k) => !conflictKeys.has(k));

  const keepOf = (field: string) => mine[field] ?? true;
  const resolve = () => {
    const keep = new Set<string>();
    for (const c of body.conflicts) if (keepOf(c.field)) keep.add(c.field);
    onResolve(keep);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>L&apos;evento è stato modificato altrove</DialogTitle>
          <DialogDescription>
            {hasConflicts
              ? 'Mentre lo modificavi, un altro dispositivo o utente ha cambiato gli stessi campi. Scegli quale valore tenere per ognuno.'
              : 'Mentre lo modificavi, un altro dispositivo o utente ha cambiato l\'evento. Puoi ricaricare la versione attuale oppure applicare comunque la tua operazione sopra di essa.'}
          </DialogDescription>
        </DialogHeader>

        {hasConflicts && (
          <div className="space-y-3">
            {body.conflicts.map((c) => (
              <fieldset key={c.field} className="rounded-md border p-3 space-y-2">
                <legend className="px-1 text-sm font-medium">{fieldLabel(c.field)}</legend>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name={`conflict-${c.field}`}
                    checked={keepOf(c.field)}
                    onChange={() => setMine((m) => ({ ...m, [c.field]: true }))}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-xs text-muted-foreground">Il tuo valore</span>
                    <span className="break-words whitespace-pre-wrap">{describeFieldValue(c.field, c.yours, tz)}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name={`conflict-${c.field}`}
                    checked={!keepOf(c.field)}
                    onChange={() => setMine((m) => ({ ...m, [c.field]: false }))}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-xs text-muted-foreground">Valore attuale</span>
                    <span className="break-words whitespace-pre-wrap">{describeFieldValue(c.field, c.theirs, tz)}</span>
                  </span>
                </label>
              </fieldset>
            ))}
          </div>
        )}

        {merged.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Verranno applicate sopra la versione attuale anche queste modifiche, senza conflitto: {merged.map(fieldLabel).join(', ')}.
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" onClick={onCancel}>Annulla</Button>
          <Button type="button" variant="outline" onClick={onReload}>Ricarica</Button>
          {hasConflicts
            ? <Button type="button" onClick={resolve}>Salva con queste scelte</Button>
            : <Button type="button" onClick={() => onResolve(new Set())}>Applica comunque</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
