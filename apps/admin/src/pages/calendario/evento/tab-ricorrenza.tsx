import type { CalV2FieldValues, CalV2Period, CalV2Preview, CalV2Time } from '@calicchia/shared';
import { Button } from '@/components/ui/button';
import { RecurrenceEditor } from '@/components/calendar/recurrence-editor';
import { describeTime } from '@/lib/calendar-v2-model';

export interface TabRicorrenzaProps {
  fields: CalV2FieldValues;
  onChange: (patch: Partial<CalV2FieldValues>) => void;
  /** Fuso del calendario. */
  tz: string;
  disabled: boolean;
  /** Anteprima del server (dryRun): riepilogo e prossime occorrenze. */
  preview: CalV2Preview | null;
  previewPending: boolean;
  /** Override che la nuova regola lascerebbe orfani. */
  orphanedOverrides: string[];
}

function formatOccurrence(startUtc: string, allDay: boolean, tz: string): string {
  const d = new Date(startUtc);
  if (Number.isNaN(d.getTime())) return startUtc;
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: tz,
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    ...(allDay ? {} : { hour: '2-digit', minute: '2-digit' }),
  }).format(d);
}

function describeRdate(r: CalV2Time | CalV2Period, tz: string): string {
  return r.type === 'period' ? `${describeTime(r.start, tz)} (periodo)` : describeTime(r, tz);
}

/** Tab "Ricorrenza": regola, riepilogo e prossime occorrenze, date escluse e aggiuntive. */
export function TabRicorrenza({ fields, onChange, tz, disabled, preview, previewPending, orphanedOverrides }: TabRicorrenzaProps) {
  const { rrule, exdates, rdates } = fields;
  return (
    <div className="space-y-4">
      <RecurrenceEditor
        value={rrule}
        onChange={(next) => onChange({ rrule: next })}
        start={fields.start}
        tz={tz}
        disabled={disabled}
      />

      {(rrule || rdates.length > 0) && (
        <div className="rounded-md bg-muted/60 p-3 space-y-2 text-sm" aria-live="polite">
          {preview?.rrule_summary ? <p className="font-medium">🔁 {preview.rrule_summary}</p> : (
            <p className="text-muted-foreground">{previewPending ? 'Calcolo l\'anteprima…' : 'Anteprima non disponibile.'}</p>
          )}
          {preview && preview.next.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Prossime occorrenze{previewPending ? ' (aggiorno…)' : ''}</p>
              <ul className="space-y-0.5 text-xs">
                {preview.next.map((o) => (
                  <li key={o.recurrence_key + o.start_utc}>
                    {formatOccurrence(o.start_utc, o.all_day, tz)}
                    {o.is_override && <span className="text-muted-foreground"> (personalizzata)</span>}
                  </li>
                ))}
              </ul>
              {preview.instances_in_horizon !== null && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  {preview.truncated ? 'Oltre ' : ''}{preview.instances_in_horizon} occorrenze nell&apos;orizzonte calcolato.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {orphanedOverrides.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Con questa regola {orphanedOverrides.length === 1 ? 'un\'occorrenza modificata non corrisponde' : `${orphanedOverrides.length} occorrenze modificate non corrispondono`} più a una data della serie.
        </div>
      )}

      {exdates.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">Date escluse (occorrenze eliminate)</p>
          <ul className="space-y-1">
            {exdates.map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
                <span>{describeTime(t, tz)}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={disabled}
                  onClick={() => onChange({ exdates: exdates.filter((_, j) => j !== i) })}
                >
                  Ripristina occorrenza
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rdates.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">Date aggiuntive</p>
          <ul className="space-y-1">
            {rdates.map((r, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
                <span>{describeRdate(r, tz)}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={disabled}
                  onClick={() => onChange({ rdates: rdates.filter((_, j) => j !== i) })}
                >
                  Rimuovi
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
