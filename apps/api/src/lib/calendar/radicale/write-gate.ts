/**
 * Gate delle scritture del calendario `cal-write` (fase F2 del passaggio a
 * Radicale; design §8 passo 2, §13.9; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §1.3 e §6.1).
 *
 * Ogni scrittura di RadicaleStore verso Radicale (PUT, DELETE, MOVE,
 * MKCALENDAR, PROPPATCH) gira dentro withCalendarWriteGate():
 *  1. lock condiviso pg_advisory_lock_shared(hashtext('cal-write')) sul pool
 *     calendario (calSql);
 *  2. rilettura SENZA cache dello stato del backend sulla stessa connessione
 *     (readBackendStateFresh): una transizione appena committata si vede
 *     sempre, anche se la cache della facade (2 s) dice ancora il contrario;
 *  3. modo cutover o rollback → CalendarUnavailableError('transition');
 *     write_freeze con lo store Radicale → CalendarUnavailableError('write_freeze');
 *     con `expect: 'radicale'` anche un modo servito dallo store legacy →
 *     'transition' (lo store Radicale non deve scrivere mentre PG è autorevole).
 * Le transizioni di stato (F4) prendono lo stesso lock in modo esclusivo con
 * withExclusiveCalendarWriteGate(): attendono la fine delle scritture in corso
 * e nessuna scrittura nuova parte finché la transizione non ha finito.
 *
 * Connessioni (budget del contratto §1.3): una sola connessione riservata di
 * calSql per processo tiene il lock condiviso finché c'è almeno una scrittura
 * in corso (conteggio di riferimento); l'ultima che esce rilascia lock e
 * connessione. Le scritture contemporanee condividono quella connessione (le
 * query si accodano su di essa: nessuna attende un'altra connessione del pool
 * calendario mentre ne tiene una, regola 1 contro lo stallo).
 *
 * Rientranza (AsyncLocalStorage): una scrittura annidata nello stesso flusso
 * asincrono riusa il contesto del gate e non riprende il lock. Riprenderlo
 * sarebbe sbagliato: con un esclusivo in coda in Postgres la seconda
 * richiesta condivisa si metterebbe in fila dietro di lui, che a sua volta
 * attende la prima → stallo.
 *
 * Equità verso un esclusivo di un altro processo: Postgres mette in coda una
 * nuova richiesta condivisa dietro un esclusivo in attesa, ma qui le scritture
 * del processo si "agganciano" al lock già preso senza passare da Postgres.
 * Con scritture continue il lock non verrebbe mai rilasciato: oltre
 * MAX_CONTINUOUS_HOLD_MS di possesso continuativo i nuovi ingressi attendono
 * che le scritture in corso finiscano, il lock si rilascia e poi si riprende
 * passando dalla coda di Postgres.
 *
 * Il gate NON copre il write-through né l'audit: lo store lo rilascia dopo la
 * PUT e prima di syncCollection (regola 2 contro lo stallo: la sync usa a sua
 * volta una connessione riservata del pool calendario).
 *
 * In F2 PgLegacyStore non passa da qui (nessun cambio di comportamento in
 * mode postgres, precisazione 6 del contratto): il gate delle scritture
 * legacy arriva con le transizioni della F4.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';
import type { Logger } from 'pino';
import { calSql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { readBackendStateFresh, storeKindForMode, storeKindOverride, writesSuspendedInMode } from '../backend-mode';
import { CalendarUnavailableError, isCalendarUnavailable } from '../errors';
import { CAL_LOCKS } from '../index-model';
import type { Db } from './policy';
import type { CalendarBackendState } from './types';

type ReservedSql = postgres.ReservedSql;

const log: Logger = rootLogger.child({ scope: 'calendar-write-gate' });

/** Contesto di una scrittura dentro il gate: lo stato del backend riletto dopo il lock. */
export interface WriteGateContext {
  readonly state: CalendarBackendState;
}

export interface WriteGateOptions {
  /** 'radicale': il modo deve essere servito dallo store Radicale (radicale, finalized). */
  expect?: 'radicale';
  /** Attesa massima per entrare (connessione, lock, esclusivo del processo). Default 5 s. */
  timeoutMs?: number;
}

/** Attesa di default per entrare nel gate (ben sotto i timeout delle route). */
export const WRITE_GATE_TIMEOUT_MS = 5_000;
/** Attesa di default dell'esclusivo (le scritture in corso durano al più qualche secondo). */
export const EXCLUSIVE_GATE_TIMEOUT_MS = 30_000;
/** Possesso continuativo del lock condiviso oltre il quale i nuovi ingressi attendono il rilascio. */
export const MAX_CONTINUOUS_HOLD_MS = 10_000;

/** Codice Postgres di lock_timeout (lock_not_available). */
const PG_LOCK_NOT_AVAILABLE = '55P03';

interface GateScope {
  readonly ctx: WriteGateContext;
  /** Connessione su cui si rilegge lo stato dentro questo flusso. */
  readonly conn: ReservedSql;
  readonly exclusive: boolean;
}

const scope = new AsyncLocalStorage<GateScope>();

interface SharedGate {
  conn: ReservedSql | null;
  holders: number;
  /** Istante monotono dell'acquisizione del lock condiviso. */
  heldSince: number;
  /** Acquisizione del lock condiviso in corso (una sola per processo). */
  acquiring: Promise<void> | null;
  /** Il possesso continuativo ha superato il limite: nessun nuovo ingresso finché holders non torna a 0. */
  draining: boolean;
  /** Esclusivi del processo in corso o in attesa. */
  exclusive: number;
  /** Rilascio del lock condiviso in corso. */
  releasing: Promise<void> | null;
}

const gate: SharedGate = {
  conn: null,
  holders: 0,
  heldSince: 0,
  acquiring: null,
  draining: false,
  exclusive: 0,
  releasing: null,
};

const waiters = new Set<() => void>();

function monotonic(): number {
  return performance.now();
}

/** Sveglia chi attende un cambiamento dello stato del gate. */
function notify(): void {
  for (const wake of [...waiters]) wake();
}

/** Attende il prossimo cambiamento dello stato del gate o la scadenza (false). */
function waitChange(deadline: number): Promise<boolean> {
  const ms = deadline - Date.now();
  if (ms <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      waiters.delete(wake);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.delete(wake);
      resolve(false);
    }, ms);
    timer.unref?.();
    waiters.add(wake);
  });
}

function timeoutError(what: string): CalendarUnavailableError {
  return new CalendarUnavailableError('transition', `gate delle scritture del calendario non disponibile entro il tempo massimo (${what})`);
}

/** Connessione riservata del pool calendario entro la scadenza; quella arrivata dopo torna subito al pool. */
async function reserve(deadline: number): Promise<ReservedSql> {
  const pending = calSql.reserve();
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CalendarUnavailableError('state_unreadable', 'pool calendario esaurito: nessuna connessione per il gate delle scritture')),
      Math.max(0, deadline - Date.now()),
    );
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (err) {
    void pending.then((conn) => conn.release()).catch(() => undefined);
    if (isCalendarUnavailable(err)) throw err;
    throw new CalendarUnavailableError('state_unreadable', 'pool calendario non raggiungibile per il gate delle scritture', { cause: err });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Prende il lock (condiviso o esclusivo) sulla connessione entro la scadenza.
 * lock_timeout vale per gli advisory lock (sono lock pesanti): allo scadere
 * Postgres annulla l'attesa con 55P03 e la sessione resta pulita.
 */
async function lockOn(conn: ReservedSql, mode: 'shared' | 'exclusive', deadline: number): Promise<void> {
  const ms = Math.max(1, Math.floor(deadline - Date.now()));
  try {
    await conn`SELECT set_config('lock_timeout', ${`${ms}ms`}, false)`;
    if (mode === 'shared') await conn`SELECT pg_advisory_lock_shared(hashtext(${CAL_LOCKS.write}))`;
    else await conn`SELECT pg_advisory_lock(hashtext(${CAL_LOCKS.write}))`;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === PG_LOCK_NOT_AVAILABLE) {
      throw new CalendarUnavailableError(
        'transition',
        mode === 'shared' ? 'gate cal-write occupato da una transizione di stato' : 'gate cal-write occupato da scritture in corso',
      );
    }
    throw new CalendarUnavailableError('state_unreadable', 'lock cal-write non acquisibile', { cause: err });
  } finally {
    // La connessione torna al pool dopo l'uso: il timeout non deve restarle addosso.
    await conn`SELECT set_config('lock_timeout', '0', false)`.catch(() => undefined);
  }
}

/** Rilascia il lock sulla connessione; se la sessione è rotta il server lo rilascia da sé alla chiusura. */
async function unlockOn(conn: ReservedSql, mode: 'shared' | 'exclusive'): Promise<void> {
  try {
    if (mode === 'shared') await conn`SELECT pg_advisory_unlock_shared(hashtext(${CAL_LOCKS.write}))`;
    else await conn`SELECT pg_advisory_unlock(hashtext(${CAL_LOCKS.write}))`;
  } catch (err) {
    log.warn({ err, mode }, 'rilascio del lock cal-write non riuscito: provo pg_advisory_unlock_all');
    // Una connessione che torna al pool con il lock ancora preso bloccherebbe
    // per sempre le transizioni: si tolgono tutti gli advisory lock di sessione.
    await conn`SELECT pg_advisory_unlock_all()`.catch((e: unknown) => log.error({ err: e }, 'pg_advisory_unlock_all non riuscito'));
  } finally {
    conn.release();
  }
}

/**
 * Verifica che lo stato ammetta una scrittura (testa del file). Con l'override
 * di test dello store (overrideCalendarStore) vale lo store forzato: il modo
 * in DB resta quello della baseline, ma cutover, rollback e freeze contano.
 */
export function assertWritableState(state: CalendarBackendState, expect?: 'radicale'): void {
  if (writesSuspendedInMode(state.mode)) {
    throw new CalendarUnavailableError('transition', `modo ${state.mode}: scritture del calendario sospese`);
  }
  const modeKind = storeKindForMode(state.mode);
  const kind = storeKindOverride() ?? modeKind;
  if (expect === 'radicale' && kind !== 'radicale') {
    throw new CalendarUnavailableError('transition', `modo ${state.mode}: Postgres è ancora autorevole, lo store Radicale non scrive`);
  }
  // In mode postgres write_freeze non conta (contratto control-plane §6.2: vale solo con la base live).
  if (modeKind === 'radicale' && state.write_freeze) {
    throw new CalendarUnavailableError('write_freeze', 'scritture del calendario congelate (write_freeze)');
  }
}

/** Entra nel gate condiviso (conteggio di riferimento); restituisce la connessione che tiene il lock. */
async function enterShared(deadline: number): Promise<ReservedSql> {
  for (;;) {
    if (gate.exclusive > 0 || gate.draining || gate.releasing) {
      const pending = gate.releasing;
      if (pending) await pending.catch(() => undefined);
      else if (!(await waitChange(deadline))) throw timeoutError(gate.exclusive > 0 ? 'transizione del processo in corso' : 'rilascio del lock');
      continue;
    }
    if (gate.conn && gate.holders > 0) {
      if (monotonic() - gate.heldSince > MAX_CONTINUOUS_HOLD_MS) {
        // Equità verso un esclusivo in attesa altrove: si lascia scadere il possesso.
        gate.draining = true;
        continue;
      }
      gate.holders += 1;
      return gate.conn;
    }
    if (gate.acquiring) {
      const acquiring = gate.acquiring;
      const ok = await Promise.race([
        acquiring.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())).unref?.()),
      ]);
      if (!ok) throw timeoutError('acquisizione del lock');
      continue;
    }
    let acquired: ReservedSql | null = null;
    gate.acquiring = (async () => {
      const conn = await reserve(deadline);
      try {
        await lockOn(conn, 'shared', deadline);
      } catch (err) {
        conn.release();
        throw err;
      }
      acquired = conn;
    })();
    try {
      await gate.acquiring;
    } finally {
      gate.acquiring = null;
    }
    const conn = acquired as ReservedSql | null;
    if (!conn) throw timeoutError('acquisizione del lock');
    gate.conn = conn;
    gate.holders = 1;
    gate.heldSince = monotonic();
    gate.draining = false;
    notify();
    return conn;
  }
}

/** Esce dal gate condiviso: l'ultimo rilascia lock e connessione. */
function leaveShared(): void {
  gate.holders -= 1;
  if (gate.holders > 0) return;
  gate.holders = 0;
  const conn = gate.conn;
  gate.conn = null;
  if (!conn) {
    gate.draining = false;
    notify();
    return;
  }
  gate.releasing = unlockOn(conn, 'shared').finally(() => {
    gate.releasing = null;
    gate.draining = false;
    notify();
  });
}

/**
 * Esegue `fn` dentro il gate delle scritture (testa del file): lock condiviso
 * cal-write, rilettura senza cache dello stato, 503 se il modo non ammette la
 * scrittura. Rientrante: dentro un gate già aperto nello stesso flusso
 * asincrono (anche esclusivo) si rilegge lo stato sulla connessione che tiene
 * il lock, senza riprenderlo. Lancia CalendarUnavailableError
 * ('transition' | 'write_freeze' | 'state_unreadable').
 */
export async function withCalendarWriteGate<T>(fn: (ctx: WriteGateContext) => Promise<T>, opts: WriteGateOptions = {}): Promise<T> {
  const current = scope.getStore();
  if (current) {
    const state = await readBackendStateFresh(current.conn as unknown as Db);
    assertWritableState(state, opts.expect);
    const ctx: WriteGateContext = Object.freeze({ state });
    return scope.run({ ctx, conn: current.conn, exclusive: current.exclusive }, () => fn(ctx));
  }

  const deadline = Date.now() + (opts.timeoutMs ?? WRITE_GATE_TIMEOUT_MS);
  const conn = await enterShared(deadline);
  try {
    const state = await readBackendStateFresh(conn as unknown as Db);
    assertWritableState(state, opts.expect);
    const ctx: WriteGateContext = Object.freeze({ state });
    return await scope.run({ ctx, conn, exclusive: false }, () => fn(ctx));
  } finally {
    leaveShared();
  }
}

/**
 * Transizioni di stato (F4, design §13.9): lock esclusivo cal-write. Chiude
 * subito il gate ai nuovi scrittori del processo, attende che quelli in corso
 * finiscano (il lock condiviso del processo viene rilasciato), poi prende
 * l'esclusivo passando dalla coda di Postgres (attende anche gli scrittori
 * degli altri processi). Dentro `fn` una withCalendarWriteGate annidata è
 * ammessa (rientranza) e rilegge lo stato sulla connessione dell'esclusivo.
 */
export async function withExclusiveCalendarWriteGate<T>(fn: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const current = scope.getStore();
  if (current?.exclusive) return fn();
  if (current) {
    throw new Error('withExclusiveCalendarWriteGate: richiesto dentro una scrittura in corso (stallo sicuro: il lock condiviso è di questo flusso)');
  }
  const deadline = Date.now() + (opts.timeoutMs ?? EXCLUSIVE_GATE_TIMEOUT_MS);
  gate.exclusive += 1;
  notify();
  try {
    while (gate.holders > 0 || gate.conn || gate.acquiring || gate.releasing) {
      const pending = gate.releasing;
      if (pending) await pending.catch(() => undefined);
      else if (!(await waitChange(deadline))) throw timeoutError('scritture del processo ancora in corso');
    }
    const conn = await reserve(deadline);
    try {
      await lockOn(conn, 'exclusive', deadline);
    } catch (err) {
      conn.release();
      throw err;
    }
    try {
      const state = await readBackendStateFresh(conn as unknown as Db);
      return await scope.run({ ctx: Object.freeze({ state }), conn, exclusive: true }, () => fn());
    } finally {
      await unlockOn(conn, 'exclusive');
    }
  } finally {
    gate.exclusive -= 1;
    notify();
  }
}

/** Stato del gate del processo (salute, test). */
export function writeGateStatus(): { holders: number; closing: boolean; reservedConnection: boolean } {
  return {
    holders: gate.holders,
    closing: gate.exclusive > 0 || gate.draining,
    reservedConnection: gate.conn !== null,
  };
}

/** true se il flusso asincrono corrente è dentro il gate (condiviso o esclusivo). */
export function insideCalendarWriteGate(): boolean {
  return scope.getStore() !== undefined;
}
