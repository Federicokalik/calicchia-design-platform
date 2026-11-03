import { useMemo } from 'react';
import { listTimeZones } from '@/lib/calendar-v2-model';
import { cn } from '@/lib/utils';

export interface TzSelectProps {
  /** TZID IANA (o `UTC`); stringa vuota = fluttuante, se ammesso. */
  value: string;
  onChange: (tzid: string) => void;
  /** Mostra "Fluttuante": solo per un evento che lo è già (contratto §6.3). */
  allowFloating?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

let cachedZones: string[] | null = null;

/** Fusi da `Intl.supportedValuesOf('timeZone')`, più il TZID corrente se non è IANA. */
export function TzSelect({ value, onChange, allowFloating = false, disabled, id, className }: TzSelectProps) {
  const zones = useMemo(() => {
    cachedZones ??= listTimeZones();
    return cachedZones;
  }, []);
  const custom = value !== '' && !zones.includes(value);
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn('w-full px-3 py-2 text-sm rounded-md border bg-background disabled:opacity-60', className)}
    >
      {allowFloating && <option value="">Fluttuante (senza fuso)</option>}
      {custom && <option value={value}>{value} (personalizzato)</option>}
      {zones.map((z) => (
        <option key={z} value={z}>{z}</option>
      ))}
    </select>
  );
}
