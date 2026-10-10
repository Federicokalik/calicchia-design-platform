/**
 * Identità del volume di Radicale lato API (fase F1 del passaggio del
 * calendario a Radicale, piano T6; contratto control-plane §4; design §1
 * invariante 7, §6.3 e §13.3).
 *
 * Il principal (`/federico/`) porta due dead prop, `{urn:calicchia:caldes}
 * volume-id` ed `epoch`, che devono coincidere con volume_id ed epoch di
 * calendar_backend_state: solo allora API e rights trattano il volume come
 * quello registrato. Un volume vuoto, di un altro stack, della Fase 0 o
 * ripristinato da uno snapshot precedente all'ultimo cambio di epoch non è
 * mai verità.
 *
 * Lettura del marker (contratto §4.3):
 *  - `file`: `.Radicale.props` del principal dal mount in sola lettura
 *    (`RADICALE_DATA_DIR/collection-root/<principal>/.Radicale.props`), lo
 *    stesso file che legge caldes_rights;
 *  - `remote`: PROPFIND Depth:0 sul principal come caldes-svc delle due prop.
 * Esito (identityStatus() di types.ts): `uninitialized` con epoch 0 in PG,
 * `unverified` se la lettura non riesce, `mismatch` se il marker manca, è
 * malformato o è diverso, `ok` se coincide.
 *
 * Creazione esplicita (design §6.3): nessun componente crea collezioni in
 * modo implicito. initializeVolume(), createMissingCollections() ed
 * ensureCanaryCollection() (la collezione di sistema `_canary` del campanello,
 * aggiunta in F2) sono il passo "Inizializza Radicale" del contratto §4.4 (in
 * F1 a mano o dai test, dalla F3 dal wizard) e partono solo su richiesta, con
 * precondizioni rigide:
 * un volume non vuoto senza marker, o con un marker diverso, non viene mai
 * inizializzato né adottato.
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { collectionPath, principalPath, type RadicaleClient } from './client';
import { clark, DAV_PROPS, type DavPropValue } from './dav-xml';
import { isRadicaleError } from './errors';
import { type Db, readBackendState } from './policy';
import {
  type CalendarBackendState,
  CANARY_COLLECTION,
  identityStatus,
  type IdentityStatus,
  isCanonicalUuid,
  isValidCollectionName,
  principalPropsPath,
  type VolumeMarker,
  volumeMarkerFromProps,
  volumeMarkerProppatchBody,
} from './types';

/** Dimensione massima accettata per `.Radicale.props` del principal. */
const PROPS_FILE_MAX_BYTES = 1024 * 1024;

// ─── Lettura del marker ───────────────────────────────

/** Esito della lettura del marker dal volume. */
export type VolumeMarkerRead =
  /** Marker presente e nel formato del contratto. */
  | { state: 'ok'; marker: VolumeMarker }
  /** Volume letto, ma marker assente o malformato (→ mismatch se PG ha un volume). */
  | { state: 'absent'; detail: string }
  /** Lettura non riuscita: mount assente, I/O, Radicale irraggiungibile (→ unverified). */
  | { state: 'unreadable'; detail: string };

/** Da dove si legge il marker. */
export interface IdentitySource {
  readonly kind: 'file' | 'remote' | 'none';
  /** Descrizione per log e salute (percorso o URL, mai credenziali). */
  readonly description: string;
  read(principal: string): Promise<VolumeMarkerRead>;
}

/**
 * Marker dal `.Radicale.props` del principal sotto `dataDir` (mount ro del
 * volume delle collezioni). Cartella delle collezioni assente o illeggibile →
 * unreadable; file delle props assente, non JSON o senza marker valido →
 * absent (un volume vuoto o estraneo non è mai "non verificabile": è diverso).
 */
export async function readVolumeMarkerFromFile(dataDir: string, principal: string): Promise<VolumeMarkerRead> {
  try {
    const info = await stat(dataDir);
    if (!info.isDirectory()) return { state: 'unreadable', detail: `${dataDir} non è una cartella` };
  } catch (err) {
    return { state: 'unreadable', detail: `cartella delle collezioni non accessibile (${(err as NodeJS.ErrnoException).code ?? 'errore'})` };
  }
  const path = principalPropsPath(dataDir, principal);
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { state: 'absent', detail: 'props del principal non sono un file' };
    if (info.size > PROPS_FILE_MAX_BYTES) return { state: 'absent', detail: 'props del principal oltre il limite' };
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent', detail: 'props del principal assenti' };
    return { state: 'unreadable', detail: `props del principal illeggibili (${code ?? 'errore'})` };
  }
  let props: unknown;
  try {
    props = JSON.parse(text);
  } catch {
    return { state: 'absent', detail: 'props del principal non JSON' };
  }
  const marker = volumeMarkerFromProps(props);
  return marker ? { state: 'ok', marker } : { state: 'absent', detail: 'marker assente o malformato' };
}

/**
 * Marker con PROPFIND Depth:0 sul principal come caldes-svc. Principal
 * assente (404) o prop mancanti → absent; errori di rete, timeout, 401, 403,
 * 5xx → unreadable.
 */
export async function readVolumeMarkerRemote(client: RadicaleClient, principal: string, opts: { timeoutMs?: number } = {}): Promise<VolumeMarkerRead> {
  let props: Record<string, string> | null;
  try {
    props = await client.readProps(principalPath(principal), [DAV_PROPS.volumeId, DAV_PROPS.volumeEpoch], opts);
  } catch (err) {
    const detail = isRadicaleError(err) ? `${err.code}${err.status ? ` ${err.status}` : ''}` : (err as Error).message;
    return { state: 'unreadable', detail: `PROPFIND del principal non riuscita (${detail})` };
  }
  if (props === null) return { state: 'absent', detail: 'principal assente su Radicale' };
  const marker = volumeMarkerFromProps(props);
  return marker ? { state: 'ok', marker } : { state: 'absent', detail: 'marker assente o malformato' };
}

export function fileIdentitySource(dataDir: string): IdentitySource {
  return { kind: 'file', description: dataDir, read: (principal) => readVolumeMarkerFromFile(dataDir, principal) };
}

export function remoteIdentitySource(client: RadicaleClient, opts: { timeoutMs?: number } = {}): IdentitySource {
  return { kind: 'remote', description: client.baseUrl, read: (principal) => readVolumeMarkerRemote(client, principal, opts) };
}

/** Nessuna sorgente configurata: con un volume registrato in PG l'identità resta unverified (frozen). */
export const NO_IDENTITY_SOURCE: IdentitySource = Object.freeze({
  kind: 'none' as const,
  description: 'nessuna sorgente (RADICALE_DATA_DIR assente e RADICALE_URL non impostata)',
  read: async (): Promise<VolumeMarkerRead> => ({ state: 'unreadable', detail: 'nessuna sorgente dell\'identità configurata' }),
});

/**
 * Sorgente secondo CALDES_IDENTITY_SOURCE: `file` e `remote` esplicite;
 * `auto` sceglie il file se la cartella delle collezioni è montata, altrimenti
 * il client (se c'è), altrimenti nessuna.
 */
export async function resolveIdentitySource(setting: 'auto' | 'file' | 'remote', dataDir: string, client: RadicaleClient | null): Promise<IdentitySource> {
  if (setting === 'file') return fileIdentitySource(dataDir);
  if (setting === 'remote') return client ? remoteIdentitySource(client) : NO_IDENTITY_SOURCE;
  try {
    if ((await stat(dataDir)).isDirectory()) return fileIdentitySource(dataDir);
  } catch {
    /* mount assente: si prova il client */
  }
  return client ? remoteIdentitySource(client) : NO_IDENTITY_SOURCE;
}

// ─── Verifica ───────────────────────────────

/** Esito del controllo d'identità di un giro. */
export interface IdentityCheck {
  status: IdentityStatus;
  source: IdentitySource['kind'];
  /** Marker letto (null se assente o non letto). */
  marker: VolumeMarker | null;
  /** Dettaglio della lettura (null se il marker c'è). */
  detail: string | null;
  checkedAt: string;
}

/**
 * Confronta il marker del volume con lo stato in PG (contratto §4.3). Non
 * lancia mai: un errore della sorgente vale come lettura non riuscita.
 */
export async function checkVolumeIdentity(
  state: Pick<CalendarBackendState, 'volume_id' | 'epoch'>,
  source: IdentitySource,
  principal: string,
  now: Date = new Date(),
): Promise<IdentityCheck> {
  let read: VolumeMarkerRead;
  try {
    read = await source.read(principal);
  } catch (err) {
    read = { state: 'unreadable', detail: (err as Error).message };
  }
  const marker = read.state === 'ok' ? read.marker : read.state === 'absent' ? null : undefined;
  return {
    status: identityStatus(state, marker),
    source: source.kind,
    marker: read.state === 'ok' ? read.marker : null,
    detail: read.state === 'ok' ? null : read.detail,
    checkedAt: now.toISOString(),
  };
}

// ─── Scrittura del marker e inizializzazione esplicita ───────────────────────────────

/**
 * PROPPATCH del marker sul principal come caldes-svc (contratto §4.2). Solo
 * l'inizializzazione, il cutover, il rollback e la riassegnazione confermata
 * lo chiamano. Lancia gli errori tipizzati del client.
 */
export async function writeVolumeMarker(client: RadicaleClient, principal: string, marker: VolumeMarker): Promise<void> {
  await client.proppatchRaw(principalPath(principal), volumeMarkerProppatchBody(marker));
}

/** Motivi per cui l'inizializzazione si rifiuta di procedere. */
export type VolumeInitErrorCode =
  | 'state_not_postgres'
  | 'already_initialized'
  | 'principal_exists'
  | 'state_changed'
  | 'identity_not_ok';

export class VolumeInitError extends Error {
  constructor(readonly code: VolumeInitErrorCode, message: string) {
    super(message);
    this.name = 'VolumeInitError';
  }
}

/** Esito per collezione di createMissingCollections(). */
export interface CollectionProvisioning {
  calendarId: string;
  collectionName: string;
  /**
   * created: MKCALENDAR eseguita; exists: c'era già con la stessa
   * calendar-id; conflict: c'è una collezione con quel nome ma con
   * un'altra calendar-id (o senza): non viene toccata, decide l'admin.
   */
  status: 'created' | 'exists' | 'conflict';
  detail?: string;
}

export interface InitializeVolumeOptions {
  /** Pool principale (non una transazione: l'aggiornamento dello stato deve essere committato). */
  db: Db;
  /** Client come caldes-svc. */
  client: RadicaleClient;
  principal: string;
  /** UUID del volume (default: v4 nuovo). */
  volumeId?: string;
  /** Crea anche le collezioni del sidecar (default true). */
  createCollections?: boolean;
}

export interface InitializeVolumeResult {
  volumeId: string;
  epoch: 1;
  collections: CollectionProvisioning[];
  /** Esito della creazione di `_canary` (F2: canary del campanello); 'skipped' con createCollections false. */
  canary: CanaryProvisioning;
}

/**
 * Esito di ensureCanaryCollection(): created (MKCALENDAR eseguita), exists
 * (c'era già), skipped (non richiesta).
 */
export type CanaryProvisioning = 'created' | 'exists' | 'skipped';

/**
 * "Inizializza Radicale" (contratto §4.4), solo su richiesta esplicita:
 *  1. precondizioni: mode = postgres ed epoch = 0 in PG, principal assente su
 *     Radicale (PROPFIND 404);
 *  2. MKCOL del principal;
 *  3. PROPPATCH del marker con un UUID nuovo ed epoch 1;
 *  4. UPDATE di calendar_backend_state condizionato a mode = postgres ed
 *     epoch = 0 (0 righe = abort: il marker resta sul volume e serve la
 *     riassegnazione d'identità confermata, F3);
 *  5. MKCALENDAR delle collezioni del sidecar (createMissingCollections).
 * La riscrittura della policy la provoca il NOTIFY del passo 4 (il
 * control-plane in esecuzione la applica subito).
 */
export async function initializeVolume(opts: InitializeVolumeOptions): Promise<InitializeVolumeResult> {
  const { db, client, principal } = opts;
  const volumeId = (opts.volumeId ?? randomUUID()).toLowerCase();
  if (!isCanonicalUuid(volumeId)) throw new TypeError(`volume_id non valido: ${JSON.stringify(opts.volumeId)}`);

  const state = await readBackendState(db);
  if (state.mode !== 'postgres') throw new VolumeInitError('state_not_postgres', `inizializzazione ammessa solo in mode postgres (ora ${state.mode})`);
  if (state.epoch !== 0) throw new VolumeInitError('already_initialized', `volume già registrato in PG (epoch ${state.epoch})`);

  const path = principalPath(principal);
  const existing = await client.readProps(path, [DAV_PROPS.resourcetype]);
  if (existing !== null) {
    throw new VolumeInitError('principal_exists', `il principal ${path} esiste già su Radicale: un volume non vuoto non viene mai inizializzato né adottato`);
  }
  try {
    await client.mkcol(path);
  } catch (err) {
    // 405: creato da qualcun altro fra la PROPFIND e la MKCOL.
    if (isRadicaleError(err) && err.status === 405) {
      throw new VolumeInitError('principal_exists', `il principal ${path} è comparso durante l'inizializzazione`);
    }
    throw err;
  }
  await writeVolumeMarker(client, principal, { volume_id: volumeId, epoch: 1 });

  const updated: Array<{ epoch: number }> = await db`
    UPDATE calendar_backend_state
    SET volume_id = ${volumeId}::uuid, epoch = 1
    WHERE id = true AND mode = 'postgres' AND epoch = 0
    RETURNING epoch
  `;
  if (updated.length !== 1) {
    throw new VolumeInitError('state_changed', 'lo stato in PG è cambiato durante l\'inizializzazione: il marker è sul volume ma PG non lo registra (serve la riassegnazione d\'identità)');
  }

  const collections = opts.createCollections === false ? [] : await createMissingCollections({ db, client, principal });
  const canary = opts.createCollections === false ? 'skipped' : await ensureCanaryCollection({ db, client, principal });
  return { volumeId, epoch: 1, collections, canary };
}

/**
 * Collezione `_canary` del campanello (contratto control-plane §4.4 passo 5;
 * f2-modules §4.2): MKCALENDAR come caldes-svc, nascosta ai device dalla
 * policy (sempre in `hidden`), mai indicizzata. Fa parte dell'inizializzazione
 * esplicita: solo su richiesta e solo con l'identità del volume verificata
 * (ok) via client, come le collezioni del sidecar. Il canary non la crea mai
 * da solo: senza `_canary` il campanello resta in remote mode (dichiarata).
 */
export async function ensureCanaryCollection(opts: { db: Db; client: RadicaleClient; principal: string }): Promise<CanaryProvisioning> {
  const { db, client, principal } = opts;
  const state = await readBackendState(db);
  const identity = await checkVolumeIdentity(state, remoteIdentitySource(client), principal);
  if (identity.status !== 'ok') {
    throw new VolumeInitError('identity_not_ok', `identità del volume non verificata (${identity.status}${identity.detail ? `: ${identity.detail}` : ''}): ${CANARY_COLLECTION} non creata`);
  }
  const path = collectionPath(principal, CANARY_COLLECTION);
  if ((await client.readProps(path, [DAV_PROPS.resourcetype])) !== null) return 'exists';
  try {
    await client.mkcalendar(path, {
      displayName: 'caldes canary',
      description: 'Collezione di sistema del campanello del calendario (canary): non modificare',
      components: ['VEVENT'],
    });
    return 'created';
  } catch (err) {
    if (isRadicaleError(err, 'conflict') || (isRadicaleError(err) && err.status === 405)) return 'exists';
    throw err;
  }
}

/**
 * MKCALENDAR delle collezioni del sidecar che mancano su Radicale (righe
 * attive con collection_name valido), con displayname, colore, descrizione,
 * ordine, componenti e le dead prop `calendar-id` e `role` (contratto §4.5).
 * Solo su richiesta esplicita e solo con l'identità del volume verificata
 * (ok) via client: su un volume estraneo non crea nulla. Una collezione già
 * presente con un'altra calendar-id resta com'è ed è riportata come conflict.
 */
export async function createMissingCollections(opts: { db: Db; client: RadicaleClient; principal: string }): Promise<CollectionProvisioning[]> {
  const { db, client, principal } = opts;
  const state = await readBackendState(db);
  const identity = await checkVolumeIdentity(state, remoteIdentitySource(client), principal);
  if (identity.status !== 'ok') {
    throw new VolumeInitError('identity_not_ok', `identità del volume non verificata (${identity.status}${identity.detail ? `: ${identity.detail}` : ''}): nessuna collezione creata`);
  }

  const rows: Array<{
    id: string;
    collection_name: string | null;
    name: string;
    description: string | null;
    color: string;
    sort_order: number;
    role: string;
    components: string[];
  }> = await db`
    SELECT id, collection_name, name, description, color, sort_order, role, components
    FROM calendars
    WHERE lifecycle = 'active' AND collection_name IS NOT NULL
    ORDER BY sort_order, collection_name
  `;

  const results: CollectionProvisioning[] = [];
  for (const row of rows) {
    if (!isValidCollectionName(row.collection_name)) continue;
    const calendarId = String(row.id).toLowerCase();
    const path = collectionPath(principal, row.collection_name);
    const base = { calendarId, collectionName: row.collection_name };

    const current = await client.readProps(path, [DAV_PROPS.resourcetype, DAV_PROPS.calendarId]);
    if (current !== null) {
      const existingId = current[clark(DAV_PROPS.calendarId)];
      results.push(existingId?.toLowerCase() === calendarId
        ? { ...base, status: 'exists' }
        : { ...base, status: 'conflict', detail: existingId ? `calendar-id ${existingId}` : 'collezione senza calendar-id' });
      continue;
    }

    const deadProps: DavPropValue[] = [
      { ...DAV_PROPS.calendarId, value: calendarId },
      { ...DAV_PROPS.role, value: row.role },
    ];
    try {
      await client.mkcalendar(path, {
        displayName: row.name,
        color: row.color,
        description: row.description ?? undefined,
        order: row.sort_order,
        components: row.components?.length ? row.components : ['VEVENT'],
        props: deadProps,
      });
      results.push({ ...base, status: 'created' });
    } catch (err) {
      if (isRadicaleError(err, 'conflict')) {
        results.push({ ...base, status: 'conflict', detail: 'collezione comparsa durante la creazione' });
        continue;
      }
      throw err;
    }
  }
  return results;
}
