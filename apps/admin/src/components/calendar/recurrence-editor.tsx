import { useMemo, useState } from 'react';
import type { CalV2Time } from '@calicchia/shared';
import { Button } from '@/components/ui/button';
import {
  buildRecurrenceRule,
  defaultRecurrenceForm,
  parseRecurrenceForm,
  shiftTimeDays,
  timeToForm,
  WEEKDAYS,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  type RecurrenceForm,
  type RecurrenceFreq,
} from '@/lib/calendar-v2-model';

export interface RecurrenceEditorProps {
  /** RRULE grezza senza prefisso; null = nessuna ricorrenza. */
  value: string | null;
  onChange: (rrule: string | null) => void;
  /** Inizio dell'evento (giorno della settimana, giorno del mese e formato dell'UNTIL). */
  start: CalV2Time;
  /** Fuso del calendario, per la fine a "fine giornata locale". */
  tz: string;
  disabled?: boolean;
}

const FREQ_OPTIONS: Array<{ value: RecurrenceFreq | 'NONE'; label: string }> = [
  { value: 'NONE', label: 'Mai' },
  { value: 'DAILY', label: 'Ogni giorno' },
  { value: 'WEEKLY', label: 'Ogni settimana' },
  { value: 'MONTHLY', label: 'Ogni mese' },
  { value: 'YEARLY', label: 'Ogni anno' },
];

const INTERVAL_UNITS: Record<RecurrenceFreq, [string, string]> = {
  DAILY: ['giorno', 'giorni'],
  WEEKLY: ['settimana', 'settimane'],
  MONTHLY: ['mese', 'mesi'],
  YEARLY: ['anno', 'anni'],
};

const SETPOS_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: 'Primo' },
  { value: 2, label: 'Secondo' },
  { value: 3, label: 'Terzo' },
  { value: 4, label: 'Quarto' },
  { value: -1, label: 'Ultimo' },
];

const INPUT = 'px-2 py-1 text-sm rounded-md border bg-background disabled:opacity-60';

/**
 * Editor della RRULE: FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYSETPOS e fine
 * (mai, COUNT, UNTIL a fine giornata locale). Una regola non rappresentabile
 * dal form si mostra come testo modificabile e non viene toccata finché
 * l'utente non la cambia.
 */
export function RecurrenceEditor({ value, onChange, start, tz, disabled }: RecurrenceEditorProps) {
  const parsed = useMemo(() => (value ? parseRecurrenceForm(value, start, tz) : null), [value, start, tz]);
  const unrepresentable = !!value && parsed === null;
  const [advanced, setAdvanced] = useState(unrepresentable);
  const rawMode = advanced || unrepresentable;
  const form: RecurrenceForm | null = value ? parsed : null;

  const emit = (next: RecurrenceForm) => onChange(buildRecurrenceRule(next, start, tz));

  const setFreq = (freq: RecurrenceFreq | 'NONE') => {
    if (freq === 'NONE') {
      onChange(null);
      return;
    }
    emit({ ...(form ?? defaultRecurrenceForm(start, freq)), freq });
  };

  const setEnd = (end: RecurrenceForm['end']) => {
    if (!form) return;
    if (end === 'until') {
      const fallback = timeToForm(shiftTimeDays(start, 30)).date;
      emit({ ...form, end, untilDate: form.untilDate || fallback, untilRaw: form.untilDate ? form.untilRaw : null });
    } else {
      emit({ ...form, end });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Frequenza">
        {FREQ_OPTIONS.map((o) => {
          const active = o.value === 'NONE' ? !value : form?.freq === o.value;
          return (
            <Button
              key={o.value}
              type="button"
              size="sm"
              variant={active ? 'default' : 'outline'}
              className="text-xs"
              disabled={disabled || (unrepresentable && o.value !== 'NONE')}
              onClick={() => setFreq(o.value)}
            >
              {o.label}
            </Button>
          );
        })}
      </div>

      {form && !rawMode && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Ogni</span>
            <input
              type="number"
              min={1}
              max={999}
              value={form.interval}
              disabled={disabled}
              onChange={(e) => emit({ ...form, interval: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
              className={`${INPUT} w-20`}
              aria-label="Intervallo"
            />
            <span>{INTERVAL_UNITS[form.freq][form.interval === 1 ? 0 : 1]}</span>
          </div>

          {form.freq === 'WEEKLY' && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Giorni della settimana</p>
              <div className="flex flex-wrap gap-1">
                {WEEKDAYS.map((d) => (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={form.byDay.includes(d) ? 'default' : 'outline'}
                    className="text-xs h-7 w-10 px-0"
                    disabled={disabled}
                    onClick={() => {
                      const next = form.byDay.includes(d) ? form.byDay.filter((x) => x !== d) : [...form.byDay, d];
                      if (next.length) emit({ ...form, byDay: next });
                    }}
                  >
                    {WEEKDAY_SHORT[d]}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {form.freq === 'MONTHLY' && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={form.monthlyMode === 'monthday' ? 'default' : 'outline'}
                  className="text-xs"
                  disabled={disabled}
                  onClick={() => emit({ ...form, monthlyMode: 'monthday' })}
                >
                  Per giorno del mese
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.monthlyMode === 'weekday' ? 'default' : 'outline'}
                  className="text-xs"
                  disabled={disabled}
                  onClick={() => emit({ ...form, monthlyMode: 'weekday' })}
                >
                  Per posizione
                </Button>
              </div>
              {form.monthlyMode === 'monthday' ? (
                <div className="flex items-center gap-2 text-sm">
                  <span>Il giorno</span>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={form.byMonthDay}
                    disabled={disabled}
                    onChange={(e) => emit({ ...form, byMonthDay: Math.min(31, Math.max(1, Math.round(Number(e.target.value)) || 1)) })}
                    className={`${INPUT} w-20`}
                    aria-label="Giorno del mese"
                  />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={form.setPos}
                    disabled={disabled}
                    onChange={(e) => emit({ ...form, setPos: Number(e.target.value) })}
                    className={`${INPUT} w-full`}
                    aria-label="Posizione nel mese"
                  >
                    {SETPOS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <select
                    value={form.setPosDay}
                    disabled={disabled}
                    onChange={(e) => emit({ ...form, setPosDay: e.target.value as RecurrenceForm['setPosDay'] })}
                    className={`${INPUT} w-full`}
                    aria-label="Giorno della settimana"
                  >
                    {WEEKDAYS.map((d) => <option key={d} value={d}>{WEEKDAY_LONG[d]}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Fine</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <label className="inline-flex items-center gap-1.5">
                <input type="radio" name="rec-end" checked={form.end === 'never'} disabled={disabled} onChange={() => setEnd('never')} />
                Mai
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input type="radio" name="rec-end" checked={form.end === 'count'} disabled={disabled} onChange={() => setEnd('count')} />
                Dopo
                <input
                  type="number"
                  min={1}
                  value={form.count}
                  disabled={disabled || form.end !== 'count'}
                  onChange={(e) => emit({ ...form, end: 'count', count: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
                  className={`${INPUT} w-20`}
                  aria-label="Numero di occorrenze"
                />
                occorrenze
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input type="radio" name="rec-end" checked={form.end === 'until'} disabled={disabled} onChange={() => setEnd('until')} />
                Fino al
                <input
                  type="date"
                  value={form.untilDate}
                  disabled={disabled || form.end !== 'until'}
                  onChange={(e) => {
                    if (!e.target.value) emit({ ...form, end: 'never', untilDate: '', untilRaw: null });
                    else emit({ ...form, end: 'until', untilDate: e.target.value, untilRaw: null });
                  }}
                  className={INPUT}
                  aria-label="Data di fine"
                />
              </label>
            </div>
            {form.end === 'until' && (
              <p className="text-[11px] text-muted-foreground">L&apos;ultima occorrenza è quella che inizia entro la fine di quel giorno.</p>
            )}
          </div>
        </div>
      )}

      {value && (
        <div className="space-y-1">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rawMode}
              disabled={disabled || unrepresentable}
              onChange={(e) => setAdvanced(e.target.checked)}
            />
            RRULE avanzata
          </label>
          {unrepresentable && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Ricorrenza personalizzata: il form non la rappresenta, resta modificabile solo come testo.
            </p>
          )}
          {rawMode && (
            <div>
              <textarea
                value={value}
                disabled={disabled}
                rows={2}
                onChange={(e) => onChange(e.target.value.replace(/^RRULE:/i, '').trim() || null)}
                className="w-full px-3 py-2 text-sm rounded-md border bg-background font-mono disabled:opacity-60"
                placeholder="FREQ=WEEKLY;BYDAY=MO,TU,TH,FR"
                aria-label="RRULE"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Esempio: FREQ=WEEKLY;BYDAY=MO,TU,TH,FR. Senza il prefisso RRULE:.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
