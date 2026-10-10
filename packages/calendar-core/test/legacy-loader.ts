/**
 * Caricamento facoltativo dell'espansione legacy dell'API (rrule.js) per i
 * test di parità: il pacchetto non dipende da apps/api, quindi senza il
 * sorgente (o senza le sue dipendenze installate) restituisce null e i casi
 * "dal vivo" vengono saltati con il motivo.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './helpers';
import type { ExpandRRuleFn } from './legacy-parity-cases';

export const LEGACY_RRULE_PATH = resolve(REPO_ROOT, 'apps/api/src/lib/calendar/legacy/rrule-legacy.ts');

export async function loadLegacyExpandRRule(): Promise<ExpandRRuleFn | null> {
  if (!existsSync(LEGACY_RRULE_PATH)) return null;
  // Logger dell'API (pino) senza transport di sviluppo né output: il processo del test termina pulito.
  process.env.NODE_ENV ??= 'production';
  process.env.LOG_LEVEL ??= 'silent';
  try {
    const mod = (await import(pathToFileURL(LEGACY_RRULE_PATH).href)) as { expandRRule?: ExpandRRuleFn };
    return typeof mod.expandRRule === 'function' ? mod.expandRRule : null;
  } catch {
    return null;
  }
}
