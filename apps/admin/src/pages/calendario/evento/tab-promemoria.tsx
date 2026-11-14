import type { CalV2Component } from '@calicchia/shared';
import { AlarmsEditor } from '@/components/calendar/alarms-editor';

export interface TabPromemoriaProps {
  alarms: CalV2Component[];
  onChange: (alarms: CalV2Component[]) => void;
  /** Fuso con cui mostrare i promemoria assoluti. */
  tz: string;
  disabled: boolean;
}

/** Tab "Promemoria": VALARM di tipo notifica, email e suono, relativi o assoluti. */
export function TabPromemoria({ alarms, onChange, tz, disabled }: TabPromemoriaProps) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        I promemoria vengono eseguiti dai dispositivi che sincronizzano il calendario. Le proprietà che l&apos;editor non conosce restano com&apos;erano.
      </p>
      <AlarmsEditor value={alarms} onChange={onChange} tz={tz} disabled={disabled} />
    </div>
  );
}
