import type { CalV2FieldValues, CalV2Time } from '@calicchia/shared';
import { Switch } from '@/components/ui/switch';
import { TzSelect } from '@/components/calendar/tz-select';
import {
  amountUnitToDuration,
  durationToAmountUnit,
  formToTime,
  isTimeFormValid,
  setAllDay,
  shiftTimeDays,
  shiftTimeMinutes,
  timeToForm,
  unitLabel,
  wallDiffMinutes,
  type DurationUnit,
} from '@/lib/calendar-v2-model';

export interface TabTempoProps {
  fields: CalV2FieldValues;
  onChange: (patch: Partial<CalV2FieldValues>) => void;
  /** Fuso del calendario: predefinito del TZID. */
  tz: string;
  disabled: boolean;
  /** Errore di coerenza fra inizio, fine e durata. */
  error: string | null;
}

const INPUT = 'w-full px-3 py-2 text-sm rounded-md border bg-background disabled:opacity-60';
const LABEL = 'block text-xs text-muted-foreground mb-1';

type Shape = 'end' | 'duration' | 'none';

/** Tab "Tempo": giornata intera, inizio, fine o durata (si conserva la forma dell'evento) e fuso. */
export function TabTempo({ fields, onChange, tz, disabled, error }: TabTempoProps) {
  const { start, end, duration } = fields;
  const allDay = start.type === 'date';
  const shape: Shape = end ? 'end' : duration ? 'duration' : 'none';
  const startForm = timeToForm(start);
  const endForm = end ? timeToForm(end) : null;
  const sameZone = !!endForm && endForm.tzid === startForm.tzid && endForm.floating === startForm.floating;
  const zoneValue = startForm.floating ? '' : startForm.tzid ?? tz;

  // Giornata intera: la fine salvata è esclusiva, nel form si mostra l'ultimo giorno incluso.
  const lastDay = allDay ? timeToForm(end ? shiftTimeDays(end, -1) : start).date : '';

  const onToggleAllDay = (next: boolean) => onChange(setAllDay(fields, next, tz));

  const onStart = (patch: { date?: string; time?: string }) => {
    const next = { ...startForm, ...patch };
    if (!isTimeFormValid(next)) return;
    const newStart = formToTime(next);
    const change: Partial<CalV2FieldValues> = { start: newStart };
    // La durata nominale resta quella: spostando l'inizio si sposta anche la fine.
    if (end && shape === 'end') change.end = shiftTimeMinutes(end, wallDiffMinutes(start, newStart));
    onChange(change);
  };

  const onEnd = (patch: { date?: string; time?: string }) => {
    const base = endForm ?? startForm;
    const next = { ...base, ...patch };
    if (!isTimeFormValid(next)) return;
    onChange({ end: formToTime(next) });
  };

  const onLastDay = (date: string) => {
    const probe = { date, time: null, tzid: null, floating: false };
    if (!isTimeFormValid(probe)) return;
    const picked = formToTime(probe);
    if (shape === 'none' && date === startForm.date) return; // un solo giorno: resta senza fine
    onChange({ end: shiftTimeDays(picked, 1) });
  };

  const onZone = (value: string) => {
    const floating = value === '';
    const retime = (t: CalV2Time): CalV2Time => {
      if (t.type === 'date') return t;
      const f = timeToForm(t);
      return formToTime({ ...f, tzid: floating ? null : value, floating });
    };
    const change: Partial<CalV2FieldValues> = { start: retime(start) };
    if (end && end.type === 'date-time' && sameZone) change.end = retime(end);
    onChange(change);
  };

  const onEndZone = (value: string) => {
    if (!end || end.type !== 'date-time') return;
    const floating = value === '';
    onChange({ end: formToTime({ ...timeToForm(end), tzid: floating ? null : value, floating }) });
  };

  const dur = duration ? durationToAmountUnit(duration) : null;
  const durationUnits: DurationUnit[] = allDay ? ['days', 'weeks'] : ['minutes', 'hours', 'days'];

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={allDay} disabled={disabled} onCheckedChange={onToggleAllDay} aria-label="Tutto il giorno" />
        Tutto il giorno
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <span className={LABEL}>Inizio *</span>
          <div className="flex gap-2">
            <input
              type="date"
              value={startForm.date}
              disabled={disabled}
              onChange={(e) => onStart({ date: e.target.value })}
              className={INPUT}
              aria-label="Data di inizio"
            />
            {!allDay && (
              <input
                type="time"
                value={startForm.time ?? ''}
                disabled={disabled}
                onChange={(e) => onStart({ time: e.target.value })}
                className={INPUT}
                aria-label="Ora di inizio"
              />
            )}
          </div>
        </div>

        {shape !== 'duration' ? (
          <div>
            <span className={LABEL}>Fine{shape === 'none' && !allDay ? ' (assente)' : ''}</span>
            {allDay ? (
              <input
                type="date"
                value={lastDay}
                disabled={disabled}
                onChange={(e) => onLastDay(e.target.value)}
                className={INPUT}
                aria-label="Ultimo giorno"
              />
            ) : (
              <div className="flex gap-2">
                <input
                  type="date"
                  value={(endForm ?? startForm).date}
                  disabled={disabled}
                  onChange={(e) => onEnd({ date: e.target.value })}
                  className={INPUT}
                  aria-label="Data di fine"
                />
                <input
                  type="time"
                  value={(endForm ?? startForm).time ?? ''}
                  disabled={disabled}
                  onChange={(e) => onEnd({ time: e.target.value })}
                  className={INPUT}
                  aria-label="Ora di fine"
                />
              </div>
            )}
          </div>
        ) : (
          dur && (
            <div>
              <span className={LABEL}>Durata</span>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  value={dur.amount}
                  disabled={disabled}
                  onChange={(e) => onChange({ duration: amountUnitToDuration(Number(e.target.value) || 0, dur.unit, false) })}
                  className={INPUT}
                  aria-label="Durata"
                />
                <select
                  value={dur.unit}
                  disabled={disabled}
                  onChange={(e) => onChange({ duration: amountUnitToDuration(dur.amount, e.target.value as DurationUnit, false) })}
                  className={INPUT}
                  aria-label="Unità della durata"
                >
                  {!durationUnits.includes(dur.unit) && <option value={dur.unit}>{unitLabel(dur.unit, dur.amount)}</option>}
                  {durationUnits.map((u) => <option key={u} value={u}>{unitLabel(u, dur.amount)}</option>)}
                </select>
              </div>
            </div>
          )
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!allDay && (
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label htmlFor="ev-tz" className={LABEL}>Fuso orario</label>
            <TzSelect id="ev-tz" value={zoneValue} onChange={onZone} allowFloating={startForm.floating} disabled={disabled} />
            <p className="text-[11px] text-muted-foreground mt-1">
              Cambiando fuso l&apos;ora indicata resta la stessa: cambia l&apos;istante in cui l&apos;evento avviene.
            </p>
          </div>
          {end && end.type === 'date-time' && !sameZone && endForm && (
            <div>
              <label htmlFor="ev-tz-end" className={LABEL}>Fuso orario della fine</label>
              <TzSelect
                id="ev-tz-end"
                value={endForm.floating ? '' : endForm.tzid ?? tz}
                onChange={onEndZone}
                allowFloating={endForm.floating}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      )}
      {allDay && (
        <p className="text-[11px] text-muted-foreground">
          Un evento di giornata intera non ha fuso orario: dura dall&apos;inizio del primo all&apos;ultimo giorno indicato.
        </p>
      )}
      {allDay && shape === 'duration' && <p className="text-[11px] text-muted-foreground">La durata è espressa in giorni.</p>}
    </div>
  );
}
