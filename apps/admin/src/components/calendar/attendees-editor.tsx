import { Plus, Trash2 } from 'lucide-react';
import type { CalV2Property } from '@calicchia/shared';
import { Button } from '@/components/ui/button';
import {
  addressFromForm,
  addressToForm,
  ATTENDEE_PARTSTATS,
  ATTENDEE_ROLES,
  isLikelyAddress,
  newAddressForm,
  type AddressForm,
} from '@/lib/calendar-v2-model';

export interface AttendeesEditorProps {
  /** ATTENDEE grezzi dell'evento. */
  value: CalV2Property[];
  onChange: (attendees: CalV2Property[]) => void;
  disabled?: boolean;
}

export interface OrganizerEditorProps {
  value: CalV2Property | null;
  onChange: (organizer: CalV2Property | null) => void;
  disabled?: boolean;
}

const MAX_ATTENDEES = 200;
const INPUT = 'px-2 py-1 text-sm rounded-md border bg-background disabled:opacity-60';

function selectOptions(labels: Record<string, string>, current: string) {
  return (
    <>
      <option value="">Non indicato</option>
      {current && !(current in labels) && <option value={current}>{current}</option>}
      {Object.entries(labels).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
    </>
  );
}

/**
 * Elenco degli invitati (ATTENDEE): email, nome, ruolo, stato di risposta e
 * RSVP. Ogni modifica riparte dalla proprietà grezza (`addressFromForm`): gli
 * altri parametri (DELEGATED-FROM, SENT-BY, X-...) restano; le righe non
 * toccate si rimandano identiche.
 */
export function AttendeesEditor({ value, onChange, disabled }: AttendeesEditorProps) {
  const update = (index: number, patch: Partial<AddressForm>) => {
    const raw = value[index];
    onChange(value.map((p, i) => (i === index ? addressFromForm({ ...addressToForm(raw), ...patch }, raw, 'ATTENDEE') : p)));
  };

  return (
    <div className="space-y-3">
      {value.length === 0 && <p className="text-sm text-muted-foreground">Nessun invitato.</p>}
      {value.map((raw, index) => {
        const form = addressToForm(raw);
        const invalid = !isLikelyAddress(form.email);
        return (
          <div key={index} className="rounded-md border p-3 space-y-2">
            <div className="grid gap-2 md:grid-cols-2">
              <input
                type="text"
                value={form.email}
                disabled={disabled}
                onChange={(e) => update(index, { email: e.target.value })}
                className={`${INPUT} w-full ${invalid ? 'border-destructive' : ''}`}
                placeholder="Email"
                aria-label="Email dell'invitato"
                aria-invalid={invalid}
              />
              <input
                type="text"
                value={form.cn}
                disabled={disabled}
                onChange={(e) => update(index, { cn: e.target.value })}
                className={`${INPUT} w-full`}
                placeholder="Nome"
                aria-label="Nome dell'invitato"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={form.role}
                disabled={disabled}
                onChange={(e) => update(index, { role: e.target.value })}
                className={INPUT}
                aria-label="Ruolo"
              >
                {selectOptions(ATTENDEE_ROLES, form.role)}
              </select>
              <select
                value={form.partstat}
                disabled={disabled}
                onChange={(e) => update(index, { partstat: e.target.value })}
                className={INPUT}
                aria-label="Stato di risposta"
              >
                {selectOptions(ATTENDEE_PARTSTATS, form.partstat)}
              </select>
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={form.rsvp === true}
                  disabled={disabled}
                  onChange={(e) => update(index, { rsvp: e.target.checked ? true : form.rsvp === null ? null : false })}
                />
                Richiede risposta (RSVP)
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto h-7 w-7 p-0 text-destructive"
                disabled={disabled}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                aria-label="Rimuovi invitato"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {invalid && <p className="text-xs text-destructive">Indirizzo email non valido.</p>}
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || value.length >= MAX_ATTENDEES}
        onClick={() => onChange([...value, addressFromForm(newAddressForm(), null, 'ATTENDEE')])}
      >
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Aggiungi invitato
      </Button>
    </div>
  );
}

/** Organizzatore (ORGANIZER): email e nome; ruolo e stato eventualmente presenti restano. */
export function OrganizerEditor({ value, onChange, disabled }: OrganizerEditorProps) {
  if (!value) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange(addressFromForm({ email: '', cn: '', role: '', partstat: '', rsvp: null }, null, 'ORGANIZER'))}
      >
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Aggiungi organizzatore
      </Button>
    );
  }
  const form = addressToForm(value);
  const invalid = !isLikelyAddress(form.email);
  const update = (patch: Partial<AddressForm>) => onChange(addressFromForm({ ...form, ...patch }, value, 'ORGANIZER'));
  return (
    <div className="space-y-2">
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
        <input
          type="text"
          value={form.email}
          disabled={disabled}
          onChange={(e) => update({ email: e.target.value })}
          className={`${INPUT} w-full ${invalid ? 'border-destructive' : ''}`}
          placeholder="Email dell'organizzatore"
          aria-label="Email dell'organizzatore"
          aria-invalid={invalid}
        />
        <input
          type="text"
          value={form.cn}
          disabled={disabled}
          onChange={(e) => update({ cn: e.target.value })}
          className={`${INPUT} w-full`}
          placeholder="Nome"
          aria-label="Nome dell'organizzatore"
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0 text-destructive"
          disabled={disabled}
          onClick={() => onChange(null)}
          aria-label="Rimuovi organizzatore"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {invalid && <p className="text-xs text-destructive">Indirizzo email non valido.</p>}
    </div>
  );
}
