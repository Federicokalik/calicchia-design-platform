/**
 * Capacità dell'API admin del calendario v2 per modo (F6, contratto
 * docs/calendar-radicale/contracts/f6-modules.md §2, §5.1).
 *
 * `readCalendarV2Capabilities` risponde sempre (anche in mode postgres e con il
 * livello API insufficiente): è la sola route che l'admin chiama in mode
 * postgres, e un errore qui lo fa tornare all'editor v1. Il modo si legge con
 * readBackendStateCached (cache di 2 s). I flag della tranche C (§9.7) li accende
 * ciascun passo, sempre in AND con `objects.read`.
 */

import {
  CAL_V2_API_VERSION,
  CAL_V2_SCOPES,
  type CalV2Capabilities,
  type CalV2CapabilityReason,
} from '@calicchia/shared';
import { sql } from '../../../db';
import { assertCalendarApiLevel, calendarApiLevelBlocked } from '../api-level';
import { readBackendStateCached, storeKindForMode, storeKindOverride } from '../backend-mode';
import type { Db } from '../radicale/policy';
import { radicaleRuntime } from '../radicale/sync';
import type { CalendarBackendState } from '../radicale/types';
import { CalendarV2Error } from './errors';

/** Store che serve la v2: l'override di test, altrimenti quello del modo. */
function storeOf(state: CalendarBackendState): 'postgres' | 'radicale' {
  return storeKindOverride() ?? storeKindForMode(state.mode);
}

/**
 * Capacità correnti. Mode postgres e cutover: nessuna operazione sugli
 * oggetti; rollback: lettura e anteprima ma niente scritture; radicale e
 * finalized: tutto, tranne le scritture con write_freeze. Radicale non
 * configurato → niente lettura né scrittura; livello API insufficiente →
 * tutto false.
 */
export async function readCalendarV2Capabilities(db: Db = sql): Promise<CalV2Capabilities> {
  const state = await readBackendStateCached(db);
  const store = storeOf(state);
  const reasons: CalV2CapabilityReason[] = [];
  let read = store === 'radicale';
  let write = read;
  if (!read) reasons.push('STORE_POSTGRES');
  if (state.mode === 'cutover' || state.mode === 'rollback') {
    write = false;
    reasons.push('WRITES_SUSPENDED');
  }
  if (storeKindForMode(state.mode) === 'radicale' && state.write_freeze) {
    write = false;
    reasons.push('WRITE_FREEZE');
  }
  if (read && !radicaleRuntime().client) {
    read = false;
    write = false;
    reasons.push('RADICALE_UNCONFIGURED');
  }
  if (calendarApiLevelBlocked()) {
    read = false;
    write = false;
    reasons.push('API_LEVEL_BLOCKED');
  }
  return {
    api_version: CAL_V2_API_VERSION,
    mode: state.mode,
    store,
    objects: { read, write, dry_run: read, scopes: read ? [...CAL_V2_SCOPES] : [] },
    // Tranche C (contratto §9.7): ogni passo accende il proprio flag, sempre
    // in AND con `read`.
    raw_edit: false,
    object_tools: false,
    history: false,
    trash: false,
    import_export: false,
    calendar_properties: false,
    health_page: false,
    occurrences: false,
    reasons,
  };
}

/**
 * Le route `objects` lavorano solo sullo store Radicale: con lo store postgres
 * → CalendarV2Error('STORE_MODE_UNSUPPORTED', 409) senza toccare nulla; con il
 * livello API insufficiente → CalendarStoreUnavailableError (503). Restituisce
 * lo stato del backend letto (cache di 2 s).
 */
export async function assertV2ObjectsAvailable(): Promise<CalendarBackendState> {
  assertCalendarApiLevel();
  const state = await readBackendStateCached();
  const store = storeOf(state);
  if (store !== 'radicale') {
    throw new CalendarV2Error('STORE_MODE_UNSUPPORTED', 409, 'Il calendario è ancora sul database: l\'editor completo non è disponibile in questa modalità', { mode: state.mode, store });
  }
  return state;
}
