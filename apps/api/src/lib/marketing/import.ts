/**
 * CSV import mapping — turns an arbitrary scraped row (Apify/Maps export, any
 * column names) into our canonical ImportRow, preserving unmapped columns as
 * metadata so no data is lost. Shared by the /import/preview (dry-run) and
 * /import/commit endpoints.
 */
import { importRowSchema, IMPORT_FIELD_ALIASES, type ImportRow } from '@calicchia/shared';

export type FieldMapping = Record<string, keyof ImportRow | 'ignore'>;

export interface MappedRow {
  canonical: ImportRow;
  metadata: Record<string, unknown>;
  email_norm: string | null;
  error: string | null;
}

const norm = (h: string) => h.trim().toLowerCase();

/** Infer canonical-field mapping for a set of CSV headers via the alias table. */
export function inferMapping(headers: string[]): FieldMapping {
  const mapping: FieldMapping = {};
  for (const h of headers) {
    const canonical = IMPORT_FIELD_ALIASES[norm(h)];
    mapping[h] = canonical ?? 'ignore';
  }
  return mapping;
}

/** Map one raw row to canonical + metadata, validating the canonical fields. */
export function mapRow(raw: Record<string, unknown>, mapping: FieldMapping): MappedRow {
  const canonicalInput: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};

  for (const [header, value] of Object.entries(raw)) {
    const target = mapping[header];
    if (!target || target === 'ignore') {
      // keep non-empty unmapped columns as metadata (don't bloat with blanks)
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        metadata[header] = value;
      }
      continue;
    }
    // last non-empty value wins if two headers map to the same field
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      canonicalInput[target] = value;
    }
  }

  const parsed = importRowSchema.safeParse(canonicalInput);
  if (!parsed.success) {
    return { canonical: {} as ImportRow, metadata, email_norm: null, error: parsed.error.issues[0]?.message ?? 'Riga non valida' };
  }
  const canonical = parsed.data;
  if (!canonical.email && !canonical.phone) {
    return { canonical, metadata, email_norm: null, error: 'Manca email o telefono' };
  }
  return {
    canonical,
    metadata,
    email_norm: canonical.email ? canonical.email.toLowerCase().trim() : null,
    error: null,
  };
}
