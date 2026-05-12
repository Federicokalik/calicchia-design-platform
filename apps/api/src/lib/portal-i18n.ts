import type { Context } from 'hono';
import { sql } from '../db';

export type SupportedLocale = 'it' | 'en';
const SUPPORTED: SupportedLocale[] = ['it', 'en'];

/**
 * Reads the active locale for a portal request, in priority order:
 *   1. Explicit query param `?locale=en` (debug / SSR override).
 *   2. Cookie `NEXT_LOCALE` (set by sito-v3 LanguageSwitcher via /api/locale).
 *   3. Accept-Language header (light parsing, exact match only).
 *   4. Default 'it'.
 */
export function getRequestLocale(c: Context): SupportedLocale {
  const queryLocale = c.req.query('locale');
  if (queryLocale && (SUPPORTED as string[]).includes(queryLocale)) {
    return queryLocale as SupportedLocale;
  }

  const cookieHeader = c.req.header('cookie') ?? '';
  const cookieMatch = cookieHeader.match(/NEXT_LOCALE=(it|en)/);
  if (cookieMatch) return cookieMatch[1] as SupportedLocale;

  const accept = c.req.header('accept-language') ?? '';
  if (/^en\b/i.test(accept)) return 'en';

  return 'it';
}

/**
 * Mapping table → primary-key column for entities with translation sidecars.
 * Keep in sync with migration 078.
 */
const PK_COLUMN: Record<TranslationTable, string> = {
  client_projects_translations: 'project_id',
  timeline_events_translations: 'event_id',
  project_milestones_translations: 'milestone_id',
  project_deliverables_translations: 'deliverable_id',
  portal_reports_translations: 'report_id',
  subscriptions_translations: 'subscription_id',
};

export type TranslationTable =
  | 'client_projects_translations'
  | 'timeline_events_translations'
  | 'project_milestones_translations'
  | 'project_deliverables_translations'
  | 'portal_reports_translations'
  | 'subscriptions_translations';

/**
 * Loads translations for a set of entity IDs from the given sidecar table.
 * Returns a Map<entityId, Map<fieldName, value>>. For locale='it' this is a
 * no-op shortcut returning empty map (callers fall back to legacy IT column).
 */
export async function loadTranslations(
  table: TranslationTable,
  entityIds: string[],
  locale: SupportedLocale,
  fields: string[]
): Promise<Map<string, Record<string, string>>> {
  const result = new Map<string, Record<string, string>>();
  if (locale === 'it' || entityIds.length === 0 || fields.length === 0) {
    return result;
  }

  const pk = PK_COLUMN[table];
  const rows = (await sql`
    SELECT ${sql(pk)} AS entity_id, field_name, field_value
    FROM ${sql(table)}
    WHERE ${sql(pk)} = ANY(${entityIds}::uuid[])
      AND locale = ${locale}
      AND field_name = ANY(${fields}::text[])
  `) as Array<{ entity_id: string; field_name: string; field_value: string }>;

  for (const r of rows) {
    const slot = result.get(r.entity_id) ?? {};
    slot[r.field_name] = r.field_value;
    result.set(r.entity_id, slot);
  }
  return result;
}

/**
 * Mutates `rows` in place, replacing translatable fields with their localized
 * value when available. Untranslated fields are left as their original IT
 * legacy value. Returns the same array for ergonomics.
 *
 * Example:
 *   await applyTranslations(projects, 'client_projects_translations',
 *     'id', ['name', 'description'], 'en');
 */
export async function applyTranslations<
  TRow extends Record<string, unknown>,
  TIdKey extends keyof TRow,
>(
  rows: TRow[],
  table: TranslationTable,
  idKey: TIdKey,
  fields: Array<keyof TRow & string>,
  locale: SupportedLocale
): Promise<TRow[]> {
  if (locale === 'it' || rows.length === 0) return rows;
  const ids = rows.map((r) => String(r[idKey])).filter(Boolean);
  if (ids.length === 0) return rows;

  const map = await loadTranslations(table, ids, locale, fields);
  if (map.size === 0) return rows;

  for (const row of rows) {
    const translations = map.get(String(row[idKey]));
    if (!translations) continue;
    for (const field of fields) {
      const value = translations[field];
      if (value !== undefined) {
        (row as Record<string, unknown>)[field] = value;
      }
    }
  }
  return rows;
}
