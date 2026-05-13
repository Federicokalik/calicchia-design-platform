/**
 * dimensions.ts — Hardcoded allowlist of breakdown dimensions.
 *
 * Endpoints that accept ?dimension=... validate against this map and look up
 * the actual SQL column to GROUP BY. Anything not in the map → 400.
 * This is the only sanctioned way to translate a user-supplied dimension
 * key into a column name — never string-interpolate the parameter.
 */

export type DimensionKey =
  | 'page'
  | 'referrer'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'utm_term'
  | 'utm_content'
  | 'browser'
  | 'os'
  | 'device'
  | 'country'
  | 'city'
  | 'event_name'
  | 'website';

type DimensionDef = {
  column: string;        // exact column name in `analytics` table
  label: string;         // human label used in tooltips / fallback
  nullPlaceholder?: string; // shown when the column is NULL
};

const DIMENSIONS: Record<DimensionKey, DimensionDef> = {
  page:         { column: 'page_path',       label: 'Pagina' },
  referrer:     { column: 'referrer_domain', label: 'Sorgente', nullPlaceholder: 'Diretto' },
  utm_source:   { column: 'utm_source',      label: 'UTM source' },
  utm_medium:   { column: 'utm_medium',      label: 'UTM medium' },
  utm_campaign: { column: 'utm_campaign',    label: 'UTM campaign' },
  utm_term:     { column: 'utm_term',        label: 'UTM term' },
  utm_content:  { column: 'utm_content',     label: 'UTM content' },
  browser:      { column: 'browser',         label: 'Browser', nullPlaceholder: 'Sconosciuto' },
  os:           { column: 'os',              label: 'Sistema operativo', nullPlaceholder: 'Sconosciuto' },
  device:       { column: 'device_type',     label: 'Dispositivo', nullPlaceholder: 'Sconosciuto' },
  country:      { column: 'country',         label: 'Paese', nullPlaceholder: 'Sconosciuto' },
  city:         { column: 'city',            label: 'Città', nullPlaceholder: 'Sconosciuta' },
  event_name:   { column: 'event_name',      label: 'Evento' },
  website:      { column: 'website_id',      label: 'Sito' },
};

export function resolveDimension(key: string | undefined | null): DimensionDef | null {
  if (!key) return null;
  return DIMENSIONS[key as DimensionKey] ?? null;
}

export function listDimensions(): Array<{ key: DimensionKey; label: string }> {
  return (Object.keys(DIMENSIONS) as DimensionKey[]).map((k) => ({
    key: k,
    label: DIMENSIONS[k].label,
  }));
}
