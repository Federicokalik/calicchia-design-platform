/**
 * Lettura di una impostazione da site_settings, validata con lo schema di
 * lib/settings-schema.ts: valore salvato se valido, altrimenti il default.
 */
import { sql } from '../db';
import { getDefaultSettingValue, validateSettingValue, type SettingKey } from './settings-schema';

export async function loadSetting<K extends SettingKey>(key: K) {
  const rows = (await sql`
    SELECT value FROM site_settings WHERE key = ${key} LIMIT 1
  `) as Array<{ value: unknown }>;
  const raw = rows[0]?.value;
  const parsed = validateSettingValue(key, raw);
  return parsed.success ? parsed.data : getDefaultSettingValue(key);
}
