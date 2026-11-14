import type { CalV2FieldValues } from '@calicchia/shared';
import { AttendeesEditor, OrganizerEditor } from '@/components/calendar/attendees-editor';

export interface TabPartecipantiProps {
  fields: CalV2FieldValues;
  onChange: (patch: Partial<CalV2FieldValues>) => void;
  disabled: boolean;
}

/** Tab "Partecipanti": organizzatore e invitati. */
export function TabPartecipanti({ fields, onChange, disabled }: TabPartecipantiProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        Radicale non invia inviti: gli invitati non ricevono nulla in automatico.
      </div>
      <div>
        <p className="text-xs text-muted-foreground mb-1">Organizzatore</p>
        <OrganizerEditor value={fields.organizer} onChange={(organizer) => onChange({ organizer })} disabled={disabled} />
      </div>
      <div>
        <p className="text-xs text-muted-foreground mb-1">Invitati</p>
        <AttendeesEditor value={fields.attendees} onChange={(attendees) => onChange({ attendees })} disabled={disabled} />
      </div>
    </div>
  );
}
