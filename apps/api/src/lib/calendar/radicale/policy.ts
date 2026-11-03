/**
 * Writer di policy.json e I/O dei file del control-plane (fase F1 del
 * passaggio del calendario a Radicale, piano T6; contratto control-plane §2,
 * §5 e §6; design §3.3 e §13.1).
 *
 * - La policy dei device è SOLO il risultato di policyFromState() (types.ts)
 *   sullo stato di calendar_backend_state e sul sidecar di calendars, letti in
 *   un'unica istantanea; nessuna impostazione a sé.
 * - Scrittura atomica sul volume caldes_control: temporaneo
 *   `.<nome>.<pid>.<casuale>.tmp` nella stessa cartella (O_EXCL, 0644),
 *   fsync, rename sopra il file definitivo, fsync della cartella (best
 *   effort). Mai scritture in place: caldes_rights apre solo i nomi definitivi
 *   e vede sempre un file completo, il vecchio o il nuovo.
 * - Si riscrive solo se il contenuto a meno di generated_at cambia
 *   (samePolicyContent), o se il file manca o è invalido.
 * - Se lo stato non si legge (DB giù, riga assente, valori fuori contratto)
 *   la funzione lancia e il chiamante NON scrive nulla in quel giro: la policy
 *   già scritta resta e, senza heartbeat, dopo 10 minuti i device vanno in
 *   frozen da soli (contratto §2).
 *
 * Il giro periodico (heartbeat, NOTIFY, avvio) sta in heartbeat.ts.
 */

import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Sql } from 'postgres';
import {
  API_CONTROL_DIR_DEFAULT,
  CALENDAR_LIFECYCLES,
  CALENDAR_ROLES,
  type CalendarBackendState,
  type CalendarLifecycle,
  type CalendarRole,
  type CaldesPolicy,
  CONTROL_FILE_MAX_BYTES,
  CONTROL_FILES,
  type ControlFileRead,
  ControlPlaneFormatError,
  decodeControlFile,
  DEFAULT_PRINCIPAL,
  type IdentityStatus,
  isValidPrincipal,
  normalizeBackendState,
  parsePolicy,
  policyFromState,
  samePolicyContent,
  serializeControlFile,
  type SidecarCollection,
} from './types';

/**
 * Pool di postgres-js, oppure la tx di `sql.begin()` (stesso oggetto
 * chiamabile, senza `begin` né `listen`; i tipi 3.4 di TransactionSql
 * perdono la firma di chiamata, quindi una tx si passa come `any`, lo stesso
 * schema già usato in src/).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tipi generici di postgres-js (stesso pattern di src/)
export type Db = Sql<any>;

/** Permessi dei file del control-plane: l'API (root) scrive, Radicale (uid 2999) legge. */
export const CONTROL_FILE_MODE = 0o644;

/** Cartella di default delle collezioni montate in sola lettura nell'API. */
export const RADICALE_DATA_DIR_DEFAULT = '/radicale-data/collections';

// ─── Configurazione ───────────────────────────────

/**
 * Attivazione del control-plane nel processo API (CALDES_CONTROL_PLANE):
 * - `auto` (default): attivo solo se la cartella di policy.json esiste, cioè
 *   se il volume caldes_control è montato (in sviluppo e negli ambienti senza
 *   Radicale non parte e non crea nulla);
 * - `on`: sempre attivo; una cartella assente è un errore visibile nei log e
 *   nello stato, a ogni giro;
 * - `off`: mai (per esempio su un'API di sola lettura).
 */
export type ControlPlaneActivation = 'auto' | 'on' | 'off';

/** Sorgente dell'identità del volume (CALDES_IDENTITY_SOURCE, vedi identity.ts). */
export type IdentitySourceSetting = 'auto' | 'file' | 'remote';

export interface ControlPlaneConfig {
  activation: ControlPlaneActivation;
  /** CALDES_POLICY_FILE, default /run/caldes-control/policy.json. */
  policyFile: string;
  /** CALDES_HEARTBEAT_FILE, default /run/caldes-control/heartbeat.json. */
  heartbeatFile: string;
  /** RADICALE_PRINCIPAL, default federico. */
  principal: string;
  /** RADICALE_DATA_DIR, default /radicale-data/collections. */
  dataDir: string;
  /** Identificativo della build per heartbeat.json (api_version). */
  apiVersion: string;
  identitySource: IdentitySourceSetting;
}

const API_VERSION_SAFE_RE = /[^\x21-\x7e]/g;

/**
 * api_version del heartbeat: CALDES_API_VERSION (es. `sha-1a2b3c4`, da
 * impostare nella build dell'immagine), altrimenti uno sha di commit noto
 * (GIT_COMMIT_SHA, GIT_SHA, SOURCE_COMMIT) come `sha-<7 caratteri>`,
 * altrimenti `unversioned`. Ridotto ad ASCII stampabile senza spazi, al
 * massimo 64 caratteri (contratto §1.3).
 */
export function resolveApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CALDES_API_VERSION?.trim();
  if (explicit) {
    const cleaned = explicit.replace(API_VERSION_SAFE_RE, '-').slice(0, 64);
    if (cleaned) return cleaned;
  }
  for (const key of ['GIT_COMMIT_SHA', 'GIT_SHA', 'SOURCE_COMMIT']) {
    const sha = env[key]?.trim();
    if (sha && /^[0-9a-f]{7,64}$/i.test(sha)) return `sha-${sha.slice(0, 7).toLowerCase()}`;
  }
  return 'unversioned';
}

/** Configurazione del control-plane dalle variabili d'ambiente (contratto §1.3). Lancia se i valori sono invalidi. */
export function controlPlaneConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const rawActivation = (env.CALDES_CONTROL_PLANE?.trim().toLowerCase() || 'auto') as ControlPlaneActivation;
  if (!['auto', 'on', 'off'].includes(rawActivation)) {
    throw new ControlPlaneFormatError(`CALDES_CONTROL_PLANE non valida: ${JSON.stringify(env.CALDES_CONTROL_PLANE)} (auto, on, off)`);
  }
  const rawSource = (env.CALDES_IDENTITY_SOURCE?.trim().toLowerCase() || 'auto') as IdentitySourceSetting;
  if (!['auto', 'file', 'remote'].includes(rawSource)) {
    throw new ControlPlaneFormatError(`CALDES_IDENTITY_SOURCE non valida: ${JSON.stringify(env.CALDES_IDENTITY_SOURCE)} (auto, file, remote)`);
  }
  const principal = env.RADICALE_PRINCIPAL?.trim() || DEFAULT_PRINCIPAL;
  if (!isValidPrincipal(principal)) {
    throw new ControlPlaneFormatError(`RADICALE_PRINCIPAL non valido: ${JSON.stringify(principal)}`);
  }
  const absolute = (value: string | undefined, fallback: string, name: string): string => {
    const v = value?.trim() || fallback;
    if (!v.startsWith('/')) throw new ControlPlaneFormatError(`${name} deve essere un percorso assoluto: ${JSON.stringify(v)}`);
    return v;
  };
  const policyFile = absolute(env.CALDES_POLICY_FILE, join(API_CONTROL_DIR_DEFAULT, CONTROL_FILES.policy), 'CALDES_POLICY_FILE');
  const heartbeatFile = absolute(env.CALDES_HEARTBEAT_FILE, join(API_CONTROL_DIR_DEFAULT, CONTROL_FILES.heartbeat), 'CALDES_HEARTBEAT_FILE');
  if (policyFile === heartbeatFile) throw new ControlPlaneFormatError('CALDES_POLICY_FILE e CALDES_HEARTBEAT_FILE coincidono');
  return {
    activation: rawActivation,
    policyFile,
    heartbeatFile,
    principal,
    dataDir: absolute(env.RADICALE_DATA_DIR, RADICALE_DATA_DIR_DEFAULT, 'RADICALE_DATA_DIR'),
    apiVersion: resolveApiVersion(env),
    identitySource: rawSource,
  };
}

// ─── File del control-plane ───────────────────────────────

/**
 * Scrive `content` in `path` in modo atomico (vedi testa del file). Il file
 * temporaneo viene rimosso anche in caso di errore. Lancia l'errore di
 * sistema (cartella assente, disco pieno, permessi).
 */
export async function writeControlFileAtomic(path: string, content: string, opts: { mode?: number } = {}): Promise<void> {
  const mode = opts.mode ?? CONTROL_FILE_MODE;
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmp, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    // open() rispetta la umask del processo: i permessi si fissano esplicitamente.
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, path);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  // Il rename è atomico; l'fsync della cartella lo rende anche durevole
  // (best effort: non tutti i filesystem lo permettono).
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    /* best effort */
  }
}

/**
 * Legge e valida un file del control-plane con le regole dei lettori
 * (contratto §5.3 e §7.2): assente → missing; illeggibile, oltre 64 KiB, non
 * UTF-8, non JSON o non conforme a `parse` → invalid.
 */
export async function readControlFile<T>(path: string, parse: (value: unknown) => T): Promise<ControlFileRead<T>> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', error: `lettura non riuscita (${code ?? (err as Error).message})` };
  }
  let bytes: Buffer;
  try {
    // Al massimo CONTROL_FILE_MAX_BYTES + 1 byte: basta per sapere se il file è oltre il limite.
    const buffer = Buffer.alloc(CONTROL_FILE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    bytes = buffer.subarray(0, total);
  } catch (err) {
    return { state: 'invalid', error: `lettura non riuscita (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes.length > CONTROL_FILE_MAX_BYTES) return { state: 'invalid', error: `file oltre ${CONTROL_FILE_MAX_BYTES} byte` };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { state: 'invalid', error: 'file non UTF-8' };
  }
  try {
    return { state: 'ok', value: parse(decodeControlFile(text)) };
  } catch (err) {
    return { state: 'invalid', error: (err as Error).message };
  }
}

/** policy.json letto con le regole di parsePolicy() e il principal configurato. */
export function readPolicyFile(path: string, principal: string): Promise<ControlFileRead<CaldesPolicy>> {
  return readControlFile(path, (value) => parsePolicy(value, principal));
}

// ─── Stato dal database ───────────────────────────────

/**
 * Riga singleton di calendar_backend_state, letta senza cache (contratto §2)
 * e validata con normalizeBackendState(). Lancia ControlPlaneFormatError se
 * la riga manca o è fuori contratto, oppure l'errore del database.
 */
export async function readBackendState(db: Db): Promise<CalendarBackendState> {
  const rows: Array<Record<string, unknown>> = await db`
    SELECT mode, write_freeze, volume_id, epoch, credential_epoch, policy_version,
           restore_guard_until, rebuild_required
    FROM calendar_backend_state
    WHERE id = true
  `;
  if (rows.length !== 1) throw new ControlPlaneFormatError('calendar_backend_state: riga singleton assente');
  return normalizeBackendState(rows[0]);
}

/**
 * Colonne del sidecar da cui dipendono readonly e hidden, per tutte le righe
 * di calendars. Un ruolo o un ciclo di vita fuori contratto (impossibile con i
 * CHECK della 162) rende lo stato illeggibile invece di produrre una policy
 * con una collezione classificata a caso.
 */
export async function readSidecarCollections(db: Db): Promise<SidecarCollection[]> {
  const rows: Array<{ collection_name: string | null; role: string; lifecycle: string; device_visible: boolean }> = await db`
    SELECT collection_name, role, lifecycle, device_visible
    FROM calendars
    ORDER BY collection_name NULLS LAST, id
  `;
  return rows.map((row) => {
    if (!CALENDAR_ROLES.includes(row.role as CalendarRole)) {
      throw new ControlPlaneFormatError(`calendars.role fuori contratto: ${JSON.stringify(row.role)}`);
    }
    if (!CALENDAR_LIFECYCLES.includes(row.lifecycle as CalendarLifecycle)) {
      throw new ControlPlaneFormatError(`calendars.lifecycle fuori contratto: ${JSON.stringify(row.lifecycle)}`);
    }
    if (typeof row.device_visible !== 'boolean') throw new ControlPlaneFormatError('calendars.device_visible non booleano');
    return {
      collection_name: row.collection_name,
      role: row.role as CalendarRole,
      lifecycle: row.lifecycle as CalendarLifecycle,
      device_visible: row.device_visible,
    };
  });
}

/** Ingressi della policy letti dal database. */
export interface PolicyInputs {
  state: CalendarBackendState;
  collections: SidecarCollection[];
}

/**
 * Stato e sidecar in un'unica istantanea (transazione REPEATABLE READ READ
 * ONLY sul pool; dentro una transazione già aperta si usa quella).
 */
export async function readPolicyInputs(db: Db): Promise<PolicyInputs> {
  const read = async (tx: Db): Promise<PolicyInputs> => ({
    state: await readBackendState(tx),
    collections: await readSidecarCollections(tx),
  });
  // La tx di sql.begin() non ha begin(): si legge dentro la transazione già aperta.
  if (typeof (db as Partial<Db>).begin === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js (vedi Db)
    return (await db.begin('isolation level repeatable read read only', (tx: any) => read(tx))) as PolicyInputs;
  }
  return read(db);
}

// ─── Sincronizzazione di policy.json ───────────────────────────────

/** Stato del file su disco prima della sincronizzazione. */
export type PolicyFileStatus = 'missing' | 'invalid' | 'same' | 'changed';

export interface PolicySyncInput extends PolicyInputs {
  /** Percorso di policy.json. */
  file: string;
  /** Esito del controllo d'identità lato API (identity.ts). */
  identity: IdentityStatus;
  principal: string;
  now: Date;
}

export interface PolicySyncResult {
  /** Policy derivata ora da policyFromState(). */
  derived: CaldesPolicy;
  /** Policy che si trova su disco dopo la sincronizzazione (quella vista da caldes_rights). */
  onDisk: CaldesPolicy;
  /** true se il file è stato (ri)scritto. */
  written: boolean;
  previous: PolicyFileStatus;
  /** Motivo dell'invalidità del file precedente (solo con previous = invalid). */
  previousError: string | null;
}

/**
 * Deriva la policy con policyFromState() e la scrive se il file manca, è
 * invalido o ha un contenuto diverso (a meno di generated_at). Lancia gli
 * errori di derivazione (stato incoerente) e di scrittura (volume assente,
 * disco pieno): il chiamante li registra e salta il heartbeat del giro.
 */
export async function syncPolicyFile(input: PolicySyncInput): Promise<PolicySyncResult> {
  const derived = policyFromState({
    state: input.state,
    identity: input.identity,
    collections: input.collections,
    principal: input.principal,
    now: input.now,
  });
  const current = await readPolicyFile(input.file, input.principal);
  let previous: PolicyFileStatus;
  if (current.state === 'missing') previous = 'missing';
  else if (current.state === 'invalid') previous = 'invalid';
  else previous = samePolicyContent(current.value, derived) ? 'same' : 'changed';

  const previousError = current.state === 'invalid' ? current.error : null;
  if (previous === 'same' && current.state === 'ok') {
    return { derived, onDisk: current.value, written: false, previous, previousError };
  }
  await writeControlFileAtomic(input.file, serializeControlFile(derived));
  return { derived, onDisk: derived, written: true, previous, previousError };
}
