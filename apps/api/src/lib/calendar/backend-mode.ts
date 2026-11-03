/**
 * Modo del backend calendario per la facade e per il busy (fase F2 del
 * passaggio a Radicale; design §12 "Facade", §13.1; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §1.2).
 *
 * Il modo sta in calendar_backend_state (162) e decide lo store:
 *
 * | mode      | store      | scritture calendario                      |
 * |-----------|------------|-------------------------------------------|
 * | postgres  | postgres   | ammesse (comportamento di oggi)           |
 * | cutover   | postgres   | 503 (transizione, design §13.1)           |
 * | radicale  | radicale   | ammesse, 503 se write_freeze              |
 * | rollback  | radicale   | 503 (transizione)                         |
 * | finalized | radicale   | ammesse, 503 se write_freeze              |
 *
 * Regole d'accesso (design §12, contratto control-plane §2):
 *  - letture per la sola visualizzazione: cache di 2 s (orologio monotono,
 *    non Date: i test fermano Date con freezeTime), invalidata dal NOTIFY
 *    calendar_policy_changed se il listener è attivo e da
 *    invalidateBackendModeCache() dopo una transizione del processo;
 *  - scritture e decisioni: rilettura senza cache (resolveWriteStoreKind,
 *    readBackendStateFresh).
 *
 * Modulo foglia: non importa store.ts né la facade, così busy.ts e
 * RadicaleStore possono usarlo senza cicli di import.
 */

import type { Logger } from 'pino';
import { sql } from '../../db';
import { logger as rootLogger } from '../logger';
import { CalendarUnavailableError } from './errors';
import { CAL_CHANNELS } from './index-model';
import { type Db, readBackendState } from './radicale/policy';
import type { BackendMode, CalendarBackendState } from './radicale/types';

/** Store che serve un modo del backend. */
export type CalendarStoreKind = 'postgres' | 'radicale';

/** Durata della cache del modo per le letture di sola visualizzazione (design §12). */
export const BACKEND_MODE_CACHE_MS = 2_000;

const log: Logger = rootLogger.child({ scope: 'calendar-backend-mode' });

/** Store per un modo del backend (tabella in testa al file). */
export function storeKindForMode(mode: BackendMode): CalendarStoreKind {
  return mode === 'postgres' || mode === 'cutover' ? 'postgres' : 'radicale';
}

/** Modi in cui le scritture calendario rispondono 503 (design §13.1: cutover e rollback). */
export function writesSuspendedInMode(mode: BackendMode): boolean {
  return mode === 'cutover' || mode === 'rollback';
}

// ─── Cache ───────────────────────────────

interface CachedState {
  state: CalendarBackendState;
  /** Istante monotono della lettura (performance.now()). */
  at: number;
}

let cached: CachedState | null = null;
let inflight: Promise<CalendarBackendState> | null = null;
/** Sale a ogni invalidazione: una lettura partita prima non riempie più la cache. */
let generation = 0;
let lastReadFailed = false;
let kindOverride: CalendarStoreKind | null = null;

function now(): number {
  return performance.now();
}

function remember(state: CalendarBackendState, gen: number): void {
  if (gen === generation) cached = { state, at: now() };
}

/**
 * Stato del backend per le letture di visualizzazione: dalla cache se ha meno
 * di 2 s, altrimenti riletto (una sola lettura alla volta, le altre la
 * attendono). Se la lettura fallisce si usa l'ultimo stato noto, se c'è,
 * altrimenti CalendarUnavailableError('state_unreadable').
 */
export async function readBackendStateCached(db: Db = sql): Promise<CalendarBackendState> {
  const hit = cached;
  if (hit && now() - hit.at < BACKEND_MODE_CACHE_MS) return hit.state;
  if (!inflight) {
    const gen = generation;
    inflight = (async () => {
      try {
        const state = await readBackendState(db);
        remember(state, gen);
        if (lastReadFailed) {
          lastReadFailed = false;
          log.info({ mode: state.mode }, 'stato del backend calendario di nuovo leggibile');
        }
        return state;
      } finally {
        inflight = null;
      }
    })();
  }
  try {
    return await inflight;
  } catch (err) {
    if (!lastReadFailed) {
      lastReadFailed = true;
      log.error({ err }, 'stato del backend calendario illeggibile');
    }
    if (cached) return cached.state;
    throw new CalendarUnavailableError('state_unreadable', 'calendar_backend_state non leggibile', { cause: err });
  }
}

/**
 * Stato del backend senza cache, per scritture e decisioni (design §8 passo 2,
 * §9). Aggiorna anche la cache. Lancia CalendarUnavailableError se lo stato
 * non si legge: senza stato non si sa quale store sia autorevole.
 */
export async function readBackendStateFresh(db: Db = sql): Promise<CalendarBackendState> {
  const gen = generation;
  try {
    const state = await readBackendState(db);
    remember(state, gen);
    return state;
  } catch (err) {
    throw new CalendarUnavailableError('state_unreadable', 'calendar_backend_state non leggibile', { cause: err });
  }
}

/** Ultimo stato letto (senza I/O), per la salute; null se mai letto. */
export function peekBackendState(): { state: CalendarBackendState; ageMs: number } | null {
  return cached ? { state: cached.state, ageMs: Math.max(0, now() - cached.at) } : null;
}

/** Svuota la cache: la prossima lettura va sul database. Da chiamare dopo ogni transizione del processo. */
export function invalidateBackendModeCache(): void {
  generation += 1;
  cached = null;
}

// ─── Selezione ───────────────────────────────

/** Store per le letture di visualizzazione (modo dalla cache di 2 s). */
export async function readStoreKind(db: Db = sql): Promise<CalendarStoreKind> {
  if (kindOverride) return kindOverride;
  return storeKindForMode((await readBackendStateCached(db)).mode);
}

/**
 * Store per una scrittura: modo riletto senza cache. Lancia
 * CalendarUnavailableError in cutover e rollback ('transition') e, per lo
 * store Radicale, con write_freeze ('write_freeze'). In mode postgres
 * write_freeze non conta (contratto control-plane §6.2: vale solo con la base
 * live). Il gate cal-write con l'advisory lock è di radicale/write-gate.ts e
 * lo prende lo store stesso, che rilegge il modo dopo il lock.
 */
export async function resolveWriteStoreKind(db: Db = sql): Promise<CalendarStoreKind> {
  if (kindOverride) return kindOverride;
  const state = await readBackendStateFresh(db);
  if (writesSuspendedInMode(state.mode)) {
    throw new CalendarUnavailableError('transition', `modo ${state.mode}: scritture del calendario sospese`);
  }
  const kind = storeKindForMode(state.mode);
  if (kind === 'radicale' && state.write_freeze) {
    throw new CalendarUnavailableError('write_freeze', 'scritture del calendario congelate (write_freeze)');
  }
  return kind;
}

// ─── Override per i test ───────────────────────────────

/**
 * Forza lo store indipendentemente dal modo (solo test: la matrice
 * CALENDAR_BACKEND=postgres|radicale del design §15). null lo toglie. Vietato
 * con NODE_ENV=production.
 */
export function overrideStoreKind(kind: CalendarStoreKind | null): void {
  if (kind !== null && process.env.NODE_ENV === 'production') {
    throw new Error('overrideStoreKind: override dello store vietato in produzione');
  }
  kindOverride = kind;
}

/** Override attivo, se c'è. */
export function storeKindOverride(): CalendarStoreKind | null {
  return kindOverride;
}

// ─── Listener ───────────────────────────────

/**
 * Invalida la cache a ogni NOTIFY calendar_policy_changed (cambio di modo,
 * freeze, identità...). Facoltativo: senza, la cache scade comunque in 2 s.
 * Lo avvia il bootstrap dell'API (src/index.ts); restituisce la funzione che
 * smette di ascoltare. postgres-js usa una connessione dedicata e la riapre
 * da solo dopo una caduta; alla riconnessione la cache si invalida.
 */
export async function startBackendModeListener(db: Db = sql): Promise<() => Promise<void>> {
  const sub = await db.listen(
    CAL_CHANNELS.policy,
    () => invalidateBackendModeCache(),
    () => invalidateBackendModeCache(),
  );
  return async () => {
    await sub.unlisten();
  };
}
