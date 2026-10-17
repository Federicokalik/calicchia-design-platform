import { useState } from 'react';
import type { CalV2FieldValues } from '@calicchia/shared';
import { Button } from '@/components/ui/button';
import { CLASS_LABELS, STATUS_LABELS } from '@/lib/calendar-v2-model';

export interface CalendarOption {
  id: string;
  name: string;
  color: string;
  timezone: string;
}

export interface TabGeneraleProps {
  fields: CalV2FieldValues;
  onChange: (patch: Partial<CalV2FieldValues>) => void;
  disabled: boolean;
  mode: 'create' | 'edit';
  calendars: CalendarOption[];
  calendarId: string;
  onCalendarChange: (id: string) => void;
  /** Motivo per cui il calendario non si può cambiare ora (in modifica: solo con scope `all`, non da un'istanza). */
  calendarLockedReason: string | null;
  /** Riapre l'editor sulla serie intera (master): serve per spostarla di calendario. */
  onOpenSeries?: () => void;
  summaryError: string | null;
}

const INPUT = 'w-full px-3 py-2 text-sm rounded-md border bg-background disabled:opacity-60';
const LABEL = 'block text-xs text-muted-foreground mb-1';

const PRIORITY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: 'Alta' },
  { value: 5, label: 'Media' },
  { value: 9, label: 'Bassa' },
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function parseCategories(text: string): string[] {
  return text.split(',').map((c) => c.trim()).filter(Boolean);
}

/** Tab "Generale": titolo, luogo, descrizione, calendario, stato, disponibilità, visibilità, categorie, colore, priorità. */
export function TabGenerale({
  fields, onChange, disabled, mode, calendars, calendarId, onCalendarChange, calendarLockedReason, onOpenSeries, summaryError,
}: TabGeneraleProps) {
  // Il testo delle categorie resta com'è digitato (virgole e spazi finali compresi); la bozza ha l'elenco.
  const [categoriesText, setCategoriesText] = useState(() => fields.categories.join(', '));
  const knownCalendar = calendars.some((c) => c.id === calendarId);
  const priority = fields.priority;
  const priorityKnown = priority === null || PRIORITY_OPTIONS.some((o) => o.value === priority);
  const classValue = fields.class ?? '';
  const classKnown = classValue === '' || classValue.toUpperCase() in CLASS_LABELS;

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="ev-summary" className={LABEL}>Titolo *</label>
        <input
          id="ev-summary"
          type="text"
          value={fields.summary ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ summary: e.target.value })}
          className={`${INPUT} ${summaryError ? 'border-destructive' : ''}`}
          autoFocus={mode === 'create'}
          aria-invalid={!!summaryError}
        />
        {summaryError && <p className="text-xs text-destructive mt-1">{summaryError}</p>}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="ev-location" className={LABEL}>Luogo</label>
          <input
            id="ev-location"
            type="text"
            value={fields.location ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ location: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="ev-url" className={LABEL}>URL</label>
          <input
            id="ev-url"
            type="url"
            value={fields.url ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ url: e.target.value })}
            className={INPUT}
            placeholder="https://"
          />
        </div>
      </div>

      <div>
        <label htmlFor="ev-description" className={LABEL}>Descrizione</label>
        <textarea
          id="ev-description"
          value={fields.description ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ description: e.target.value })}
          rows={4}
          className={INPUT}
        />
      </div>

      <div>
        <label htmlFor="ev-calendar" className={LABEL}>Calendario *</label>
        <select
          id="ev-calendar"
          value={calendarId}
          disabled={disabled || calendarLockedReason !== null}
          onChange={(e) => onCalendarChange(e.target.value)}
          className={INPUT}
        >
          {!knownCalendar && <option value={calendarId}>Calendario attuale</option>}
          {calendars.map((cal) => <option key={cal.id} value={cal.id}>{cal.name}</option>)}
        </select>
        {calendarLockedReason && (
          <p className="text-[11px] text-muted-foreground mt-1">
            {calendarLockedReason}
            {onOpenSeries && (
              <Button type="button" variant="link" size="sm" className="h-auto p-0 ml-1 text-[11px]" onClick={onOpenSeries}>
                Modifica la serie intera
              </Button>
            )}
          </p>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <label htmlFor="ev-status" className={LABEL}>Stato</label>
          <select
            id="ev-status"
            value={fields.status ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ status: (e.target.value || null) as CalV2FieldValues['status'] })}
            className={INPUT}
          >
            <option value="">Predefinito</option>
            {Object.entries(STATUS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="ev-transp" className={LABEL}>Mostra come</label>
          <select
            id="ev-transp"
            value={fields.transp ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ transp: (e.target.value || null) as CalV2FieldValues['transp'] })}
            className={INPUT}
          >
            <option value="">Predefinito (occupato; libero se tutto il giorno)</option>
            <option value="OPAQUE">Occupato</option>
            <option value="TRANSPARENT">Libero</option>
          </select>
        </div>
        <div>
          <label htmlFor="ev-class" className={LABEL}>Visibilità</label>
          <select
            id="ev-class"
            value={classValue}
            disabled={disabled}
            onChange={(e) => onChange({ class: e.target.value || null })}
            className={INPUT}
          >
            <option value="">Predefinita</option>
            {!classKnown && <option value={classValue}>{classValue}</option>}
            {Object.entries(CLASS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="md:col-span-1">
          <label htmlFor="ev-categories" className={LABEL}>Categorie</label>
          <input
            id="ev-categories"
            type="text"
            value={categoriesText}
            disabled={disabled}
            onChange={(e) => {
              setCategoriesText(e.target.value);
              onChange({ categories: parseCategories(e.target.value) });
            }}
            className={INPUT}
            placeholder="Separate da virgola"
          />
        </div>
        <div>
          <label htmlFor="ev-color" className={LABEL}>Colore</label>
          <div className="flex gap-2">
            <input
              type="color"
              value={fields.color && HEX_COLOR.test(fields.color) ? fields.color : '#7c3aed'}
              disabled={disabled}
              onChange={(e) => onChange({ color: e.target.value })}
              className="h-9 w-10 shrink-0 rounded-md border bg-background p-1 disabled:opacity-60"
              aria-label="Scegli il colore"
            />
            <input
              id="ev-color"
              type="text"
              value={fields.color ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ color: e.target.value })}
              className={INPUT}
              placeholder="Predefinito del calendario"
            />
          </div>
        </div>
        <div>
          <label htmlFor="ev-priority" className={LABEL}>Priorità</label>
          <select
            id="ev-priority"
            value={priority === null ? '' : String(priority)}
            disabled={disabled}
            onChange={(e) => onChange({ priority: e.target.value === '' ? null : Number(e.target.value) })}
            className={INPUT}
          >
            <option value="">Nessuna</option>
            {!priorityKnown && <option value={String(priority)}>Priorità {priority}</option>}
            {PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}
