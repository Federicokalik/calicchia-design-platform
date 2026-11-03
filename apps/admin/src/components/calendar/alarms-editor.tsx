import { Plus, Trash2 } from 'lucide-react';
import type { CalV2Component, CalV2DateTime, CalV2Duration } from '@calicchia/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ALARM_ACTIONS,
  alarmFromForm,
  alarmToForm,
  amountUnitToDuration,
  durationToAmountUnit,
  isAppleDefaultAlarm,
  newAlarmForm,
  unitLabel,
  utcMsToWall,
  wallToUtcMs,
  type AlarmForm,
  type DurationUnit,
} from '@/lib/calendar-v2-model';

export interface AlarmsEditorProps {
  /** VALARM grezzi: sostituiscono tutti quelli del componente. */
  value: CalV2Component[];
  onChange: (alarms: CalV2Component[]) => void;
  /** Fuso con cui mostrare i promemoria assoluti (quello dell'evento). */
  tz: string;
  disabled?: boolean;
}

const MAX_ALARMS = 20;
const INPUT = 'px-2 py-1 text-sm rounded-md border bg-background disabled:opacity-60';
const UNITS: DurationUnit[] = ['minutes', 'hours', 'days', 'weeks'];

type TriggerMode = 'start' | 'end' | 'absolute';

function modeOf(form: AlarmForm): TriggerMode {
  if (form.trigger.kind === 'absolute') return 'absolute';
  return form.trigger.related === 'END' ? 'end' : 'start';
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function absoluteToInputs(at: CalV2DateTime, tz: string): { date: string; time: string } {
  const w = utcMsToWall(Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second), tz);
  return { date: `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`, time: `${pad(w.hour)}:${pad(w.minute)}` };
}

function inputsToAbsolute(date: string, time: string, tz: string): CalV2DateTime | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})/.exec(time);
  if (!d || !t) return null;
  const utc = new Date(wallToUtcMs(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])), tz));
  return {
    type: 'date-time',
    year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate(),
    hour: utc.getUTCHours(), minute: utc.getUTCMinutes(), second: 0,
    zone: { kind: 'utc' },
  };
}

/**
 * Editor dei promemoria (VALARM): DISPLAY, EMAIL e AUDIO, relativi all'inizio
 * o alla fine oppure assoluti. Ogni modifica riparte dal VALARM grezzo
 * (`alarmFromForm`): proprietà e parametri sconosciuti restano, e un
 * promemoria non toccato si rimanda identico.
 */
export function AlarmsEditor({ value, onChange, tz, disabled }: AlarmsEditorProps) {
  const update = (index: number, patch: Partial<AlarmForm>) => {
    const raw = value[index];
    onChange(value.map((a, i) => (i === index ? alarmFromForm({ ...alarmToForm(raw), ...patch }, raw) : a)));
  };

  const setOffset = (index: number, form: AlarmForm, offset: CalV2Duration) => {
    update(index, { trigger: { kind: 'relative', related: form.trigger.kind === 'relative' ? form.trigger.related : 'START', offset } });
  };

  const setMode = (index: number, mode: TriggerMode) => {
    const form = alarmToForm(value[index]);
    if (mode === 'absolute') {
      const now = utcMsToWall(Date.now(), tz);
      const at = inputsToAbsolute(`${pad(now.year, 4)}-${pad(now.month)}-${pad(now.day)}`, '09:00', tz);
      if (at) update(index, { trigger: { kind: 'absolute', at } });
      return;
    }
    const offset = form.trigger.kind === 'relative' ? form.trigger.offset : amountUnitToDuration(15, 'minutes', true);
    update(index, { trigger: { kind: 'relative', related: mode === 'end' ? 'END' : 'START', offset } });
  };

  return (
    <div className="space-y-3">
      {value.length === 0 && <p className="text-sm text-muted-foreground">Nessun promemoria.</p>}
      {value.map((raw, index) => {
        const form = alarmToForm(raw);
        const mode = modeOf(form);
        const rel = form.trigger.kind === 'relative' ? durationToAmountUnit(form.trigger.offset) : null;
        const abs = form.trigger.kind === 'absolute' ? absoluteToInputs(form.trigger.at, tz) : null;
        return (
          <div key={index} className="rounded-md border p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={form.action}
                disabled={disabled}
                onChange={(e) => update(index, { action: e.target.value })}
                className={INPUT}
                aria-label="Tipo di promemoria"
              >
                {!(form.action in ALARM_ACTIONS) && <option value={form.action}>{form.action}</option>}
                {Object.entries(ALARM_ACTIONS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <select
                value={mode}
                disabled={disabled}
                onChange={(e) => setMode(index, e.target.value as TriggerMode)}
                className={INPUT}
                aria-label="Riferimento temporale"
              >
                <option value="start">Rispetto all&apos;inizio</option>
                <option value="end">Rispetto alla fine</option>
                <option value="absolute">In un momento preciso</option>
              </select>
              {isAppleDefaultAlarm(raw) && <Badge variant="secondary">Promemoria predefinito del dispositivo</Badge>}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto h-7 w-7 p-0 text-destructive"
                disabled={disabled}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                aria-label="Rimuovi promemoria"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            {rel && form.trigger.kind === 'relative' && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <input
                  type="number"
                  min={0}
                  value={rel.amount}
                  disabled={disabled}
                  onChange={(e) => setOffset(index, form, amountUnitToDuration(Number(e.target.value) || 0, rel.unit, rel.negative))}
                  className={`${INPUT} w-20`}
                  aria-label="Quantità"
                />
                <select
                  value={rel.unit}
                  disabled={disabled}
                  onChange={(e) => setOffset(index, form, amountUnitToDuration(rel.amount, e.target.value as DurationUnit, rel.negative))}
                  className={INPUT}
                  aria-label="Unità"
                >
                  {UNITS.map((u) => <option key={u} value={u}>{unitLabel(u, rel.amount)}</option>)}
                </select>
                <select
                  value={rel.negative ? 'before' : 'after'}
                  disabled={disabled}
                  onChange={(e) => setOffset(index, form, amountUnitToDuration(rel.amount, rel.unit, e.target.value === 'before'))}
                  className={INPUT}
                  aria-label="Prima o dopo"
                >
                  <option value="before">prima</option>
                  <option value="after">dopo</option>
                </select>
                <span className="text-muted-foreground">{mode === 'end' ? 'della fine' : "dell'inizio"}</span>
              </div>
            )}

            {abs && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <input
                  type="date"
                  value={abs.date}
                  disabled={disabled}
                  onChange={(e) => {
                    const at = inputsToAbsolute(e.target.value, abs.time, tz);
                    if (at) update(index, { trigger: { kind: 'absolute', at } });
                  }}
                  className={INPUT}
                  aria-label="Data del promemoria"
                />
                <input
                  type="time"
                  value={abs.time}
                  disabled={disabled}
                  onChange={(e) => {
                    const at = inputsToAbsolute(abs.date, e.target.value, tz);
                    if (at) update(index, { trigger: { kind: 'absolute', at } });
                  }}
                  className={INPUT}
                  aria-label="Ora del promemoria"
                />
                <span className="text-xs text-muted-foreground">({tz})</span>
              </div>
            )}

            {form.action === 'EMAIL' && (
              <div className="grid gap-2 md:grid-cols-2">
                <input
                  type="text"
                  value={form.summary}
                  disabled={disabled}
                  onChange={(e) => update(index, { summary: e.target.value })}
                  className={`${INPUT} w-full`}
                  placeholder="Oggetto dell'email"
                  aria-label="Oggetto"
                />
                <input
                  key={`dest-${index}-${form.attendees.join(',')}`}
                  type="text"
                  defaultValue={form.attendees.join(', ')}
                  disabled={disabled}
                  onBlur={(e) => {
                    const next = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
                    if (next.join(',') !== form.attendees.join(',')) update(index, { attendees: next });
                  }}
                  className={`${INPUT} w-full`}
                  placeholder="Destinatari, separati da virgola"
                  aria-label="Destinatari"
                />
              </div>
            )}
            {(form.action === 'DISPLAY' || form.action === 'EMAIL') && (
              <input
                type="text"
                value={form.description}
                disabled={disabled}
                onChange={(e) => update(index, { description: e.target.value })}
                className={`${INPUT} w-full`}
                placeholder="Testo del promemoria"
                aria-label="Testo"
              />
            )}
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || value.length >= MAX_ALARMS}
        onClick={() => onChange([...value, alarmFromForm(newAlarmForm(), null)])}
      >
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Aggiungi promemoria
      </Button>
    </div>
  );
}
