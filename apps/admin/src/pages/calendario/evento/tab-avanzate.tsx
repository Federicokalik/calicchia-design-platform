import { useState } from 'react';
import { Copy, Download, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  CAL_V2_RESERVED_PROPERTIES,
  type CalV2ComponentView,
  type CalV2DateTime,
  type CalV2ObjectView,
  type CalV2Param,
  type CalV2Property,
  type CalV2WriteResult,
} from '@calicchia/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RawIcsEditor } from '@/components/calendar/raw-ics-editor';
import { objectExportUrl, objectIcsUrl } from '@/lib/calendar-v2-api';
import { describeTime } from '@/lib/calendar-v2-model';

export interface TabAvanzateProps {
  mode: 'create' | 'edit';
  view: CalV2ObjectView | null;
  target: CalV2ComponentView | null;
  /** Proprietà non tipizzate della bozza (per nome). */
  extra: Record<string, CalV2Property[]>;
  onExtraChange: (next: Record<string, CalV2Property[]>) => void;
  disabled: boolean;
  /** Con `caps.raw_edit`: l'ICS diventa un editor scrivibile (contratto §9.2.2). Assente = sola lettura. */
  rawEditor?: {
    /** Scrittura del testo non ammessa ora (l'ICS resta leggibile). */
    disabled: boolean;
    disabledReason: string | null;
    onApplied: (result: CalV2WriteResult) => void;
    onReload: (next: CalV2ObjectView) => void;
    onDirtyChange: (dirty: boolean) => void;
  } | null;
  /** `caps.object_tools`: "Esporta .ics" al posto di "Scarica". */
  objectTools?: boolean;
}

const INPUT = 'px-3 py-2 text-sm rounded-md border bg-background disabled:opacity-60';
const NAME_RE = /^[A-Z][A-Z0-9-]*$/;
const MAX_PER_NAME = 50;
const RESERVED = new Set<string>(CAL_V2_RESERVED_PROPERTIES);

const PRESETS: Array<{ name: string; label: string; params: CalV2Param[] }> = [
  { name: 'CONFERENCE', label: 'CONFERENCE (link di videochiamata)', params: [{ name: 'VALUE', values: ['URI'] }] },
  { name: 'ATTACH', label: 'ATTACH (allegato per URI)', params: [] },
  { name: 'RELATED-TO', label: 'RELATED-TO (evento collegato)', params: [] },
  { name: '', label: 'Altra proprietà (X-...)', params: [] },
];

function paramLabel(p: CalV2Param): string {
  return `${p.name}=${p.values.join(',')}`;
}

/** Valore binario inline (ATTACH;ENCODING=BASE64): non si modifica come testo. */
function isBinary(p: CalV2Property): boolean {
  return p.params.some((x) => x.name.toUpperCase() === 'ENCODING');
}

function fmt(dt: CalV2DateTime | null, tz: string): string {
  return dt ? describeTime(dt, tz) : '—';
}

function ReadonlyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-xs">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono">{children}</dd>
    </div>
  );
}

/** Tab "Avanzate": proprietà non tipizzate modificabili e, in sola lettura, metadati e ICS grezzo. */
export function TabAvanzate({ mode, view, target, extra, onExtraChange, disabled, rawEditor = null, objectTools = false }: TabAvanzateProps) {
  const [preset, setPreset] = useState(PRESETS[0].name);
  const [customName, setCustomName] = useState('X-');
  const [newValue, setNewValue] = useState('');

  const name = (preset || customName).trim().toUpperCase();
  const nameError = !name
    ? null
    : !NAME_RE.test(name) ? 'Nome non valido: lettere maiuscole, cifre e trattini.'
      : RESERVED.has(name) ? 'Proprietà gestita dai campi dell\'evento o dal server.'
        : (extra[name]?.length ?? 0) >= MAX_PER_NAME ? 'Troppe proprietà con questo nome.' : null;
  const canAdd = !disabled && !!name && !nameError && newValue.trim() !== '' && (preset !== '' || name !== 'X-');

  const flat = Object.entries(extra).flatMap(([n, list]) => list.map((prop, index) => ({ name: n, index, prop })));

  const replace = (n: string, index: number, prop: CalV2Property | null) => {
    const list = (extra[n] ?? []).slice();
    if (prop) list[index] = prop;
    else list.splice(index, 1);
    const next = { ...extra };
    if (list.length) next[n] = list;
    else delete next[n];
    onExtraChange(next);
  };

  const add = () => {
    const params = PRESETS.find((p) => p.name === preset)?.params ?? [];
    const prop: CalV2Property = { name, params: params.map((p) => ({ ...p, values: [...p.values] })), value: newValue.trim() };
    onExtraChange({ ...extra, [name]: [...(extra[name] ?? []), prop] });
    setNewValue('');
  };

  const copyIcs = async () => {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(view.ics);
      toast.success('ICS copiato negli appunti');
    } catch {
      toast.error('Copia non riuscita: seleziona il testo e copialo a mano');
    }
  };

  const tz = view?.calendar_tz ?? 'Europe/Rome';
  const ro = target?.readonly;

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h4 className="text-sm font-medium">Proprietà aggiuntive</h4>
        <p className="text-xs text-muted-foreground">
          Proprietà iCalendar che l&apos;editor non gestisce con un campo proprio (X-..., CONFERENCE, ATTACH, RELATED-TO): restano nell&apos;evento e qui si possono aggiungere, cambiare o togliere.
        </p>
        {flat.length === 0 && <p className="text-sm text-muted-foreground">Nessuna proprietà aggiuntiva.</p>}
        {flat.map(({ name: n, index, prop }) => (
          <div key={`${n}-${index}`} className="rounded-md border p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <code className="text-xs font-semibold shrink-0">{n}</code>
              {isBinary(prop) ? (
                <span className="text-xs text-muted-foreground min-w-0 flex-1 truncate">Contenuto binario ({Math.ceil(prop.value.length / 1024)} KB)</span>
              ) : (
                <input
                  type="text"
                  value={prop.value}
                  disabled={disabled}
                  onChange={(e) => replace(n, index, { ...prop, value: e.target.value })}
                  className={`${INPUT} min-w-0 flex-1 py-1`}
                  aria-label={`Valore di ${n}`}
                />
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-destructive shrink-0"
                disabled={disabled}
                onClick={() => replace(n, index, null)}
                aria-label={`Rimuovi ${n}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {prop.params.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {prop.params.map((p, i) => (
                  <Badge key={i} variant="outline" className="font-mono text-[10px]">{paramLabel(p)}</Badge>
                ))}
              </div>
            )}
          </div>
        ))}

        <div className="rounded-md border border-dashed p-2 space-y-2">
          <div className="flex flex-wrap gap-2">
            <select
              value={preset}
              disabled={disabled}
              onChange={(e) => setPreset(e.target.value)}
              className={`${INPUT} py-1`}
              aria-label="Tipo di proprietà"
            >
              {PRESETS.map((p) => <option key={p.name || 'custom'} value={p.name}>{p.label}</option>)}
            </select>
            {preset === '' && (
              <input
                type="text"
                value={customName}
                disabled={disabled}
                onChange={(e) => setCustomName(e.target.value.toUpperCase())}
                className={`${INPUT} w-40 py-1 font-mono`}
                placeholder="X-NOME"
                aria-label="Nome della proprietà"
              />
            )}
            <input
              type="text"
              value={newValue}
              disabled={disabled}
              onChange={(e) => setNewValue(e.target.value)}
              className={`${INPUT} min-w-0 flex-1 py-1`}
              placeholder="Valore"
              aria-label="Valore della nuova proprietà"
            />
            <Button type="button" size="sm" variant="outline" disabled={!canAdd} onClick={add}>
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Aggiungi
            </Button>
          </div>
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
        </div>
      </section>

      {mode === 'edit' && view && (
        <>
          <section className="space-y-2">
            <h4 className="text-sm font-medium">Dati dell&apos;oggetto (sola lettura)</h4>
            <dl className="space-y-1 rounded-md bg-muted/40 p-3">
              <ReadonlyRow label="UID">{ro?.uid ?? view.uid}</ReadonlyRow>
              <ReadonlyRow label="SEQUENCE">{ro?.sequence ?? '—'}</ReadonlyRow>
              <ReadonlyRow label="DTSTAMP">{fmt(ro?.dtstamp ?? null, tz)}</ReadonlyRow>
              <ReadonlyRow label="CREATED">{fmt(ro?.created ?? null, tz)}</ReadonlyRow>
              <ReadonlyRow label="LAST-MODIFIED">{fmt(ro?.last_modified ?? null, tz)}</ReadonlyRow>
              {ro?.recurrence_id && <ReadonlyRow label="RECURRENCE-ID">{describeTime(ro.recurrence_id, tz)}</ReadonlyRow>}
              <ReadonlyRow label="Salute">
                {view.health}{view.health_reason ? ` (${view.health_reason})` : ''} · collezione: {view.collection_health}
              </ReadonlyRow>
              <ReadonlyRow label="Provenienza">
                {view.provenance.source}{view.provenance.source_id ? ` · ${view.provenance.source_id}` : ''}
              </ReadonlyRow>
              <ReadonlyRow label="Risorsa">{view.href}</ReadonlyRow>
              <ReadonlyRow label="ETag">{view.etag ?? '—'} ({view.source === 'index' ? 'dall\'indice' : 'da Radicale'})</ReadonlyRow>
              {view.timezones.length > 0 && <ReadonlyRow label="Fusi (VTIMEZONE)">{view.timezones.join(', ')}</ReadonlyRow>}
              {view.other_components.length > 0 && <ReadonlyRow label="Altri componenti">{view.other_components.join(', ')}</ReadonlyRow>}
            </dl>
          </section>

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium">{rawEditor ? 'Testo ICS' : 'ICS grezzo (sola lettura)'}</h4>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => { void copyIcs(); }}>
                  <Copy className="h-3.5 w-3.5 mr-1.5" /> Copia
                </Button>
                {view.id && (
                  <Button type="button" size="sm" variant="outline" asChild>
                    <a
                      href={objectTools ? objectExportUrl(view.id) : objectIcsUrl(view.id)}
                      download={`${view.uid}.ics`}
                      data-testid="cal-export-ics"
                    >
                      <Download className="h-3.5 w-3.5 mr-1.5" /> {objectTools ? 'Esporta .ics' : 'Scarica'}
                    </a>
                  </Button>
                )}
              </div>
            </div>
            {rawEditor && view.id ? (
              <RawIcsEditor
                view={view}
                disabled={rawEditor.disabled}
                disabledReason={rawEditor.disabledReason}
                onApplied={rawEditor.onApplied}
                onReload={rawEditor.onReload}
                onDirtyChange={rawEditor.onDirtyChange}
              />
            ) : (
              <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-snug whitespace-pre-wrap break-all font-mono">
                {view.ics}
              </pre>
            )}
          </section>
        </>
      )}
    </div>
  );
}
