/**
 * Inizializzazione del volume di Radicale, collezioni, identità e archivio
 * della Fase 0 (fase F3 del passaggio del calendario a Radicale; design §6.3,
 * §13.2, §13.3, §16.3; decisione 7; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §1.4, §2.1, §6.1 e §12).
 *
 * È l'UNICO punto del codice dell'API che fa MKCOL e MKCALENDAR (insieme a
 * radicale/identity.ts, che usa, e a radicale/store.ts per la creazione di un
 * calendario in mode radicale della F2). Apply, shadow, specchio delle
 * iscrizioni e archivio non creano mai una collezione per conto proprio: una
 * collezione mancante è il conflitto COLLECTION_MISSING e il wizard propone
 * "Crea collezioni mancanti" (questo modulo, action 'create_missing').
 *
 * Regole:
 *  - mai su un volume non vuoto senza marker, né con un marker diverso: un
 *    volume della Fase 0, di un altro stack o ripristinato non è mai verità;
 *  - journal crash-resistente: il volume_id scelto si salva nei params del run
 *    PRIMA della MKCOL; una ripresa (lease scaduto, riavvio) che trova sul
 *    volume il proprio marker, o il proprio principal ancora vuoto, prosegue
 *    dall'aggiornamento dello stato invece di trattarlo come estraneo;
 *  - identità riletta da Radicale (mai dalla cache del campanello) prima di
 *    ogni collezione;
 *  - le collezioni nascono con il nome esatto di collection_name (= slug per i
 *    calendari esistenti, compresi `c` e `f`) e le dead prop calendar-id e
 *    role: i percorsi dei device e le app-password restano quelli di oggi;
 *  - una collezione presente con un'altra calendar-id (o senza) non si tocca
 *    mai: esito `conflict`, decide l'admin;
 *  - nessun cambio di mode: epoch passa solo da 0 a 1 (inizializzazione) o
 *    avanza con la riassegnazione confermata, mai all'indietro.
 *
 * Archivio della Fase 0 (decisione 7): lo zip prodotto sull'host da
 * scripts/radicale-maint.sh phase0-export, il tar (o tar.gz) del vecchio
 * volume di phase0-backup, o un singolo .ics, si importa nella
 * collezione `archivio-fase0` (riga di calendars con origin 'migration',
 * invisibile al legacy, non bloccante, in sola lettura per i device con la
 * policy shadow). Il vecchio volume non viene mai montato al posto del nuovo.
 * Ogni item passa dal protocollo del ledger (riga d'intento prima della PUT
 * con If-None-Match: *), quindi una seconda esecuzione è tutta `unchanged`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';
import { customAlphabet } from 'nanoid';
import {
  type CalendarObject,
  calendarToObject,
  parseCalendarObject,
  parseIcs,
  semanticFingerprint,
  serializeObject,
  splitCalendar,
  validateObject,
} from '@calicchia/calendar-core';
import { logger as rootLogger } from '../../logger';
import { completeIntent, clearIntent, migrationThrottle, readLedger, recordIntent } from './apply';
import { loadMigrationCalendars } from './inventory';
import {
  createIdentityGuard,
  describeRadicaleError,
  type IdentityGuard,
  identityExplanation,
  preconditionError,
  readMigrationStateFresh,
  requireRadicale,
} from './preflight';
import { legacyHash } from './serialize';
import {
  type ArchiveParams,
  type ArchiveSnapshot,
  type ArchiveSummary,
  type ConflictCode,
  type IdentityDiffView,
  type IdentityParams,
  type IdentityReassignDirection,
  type IdentityReassignSummary,
  type InitParams,
  type InitSummary,
  type LedgerRow,
  type LegacyKey,
  legacyKey,
  MIGRATION_LIMITS,
  MigrationError,
  type MigrationItemInput,
  type MigrationRunContext,
  type PlannedCollection,
} from './types';
import { collectionPath, objectPath, principalPath, type RadicaleClient, isValidObjectName } from '../radicale/client';
import { clark, DAV_PROPS, type DavPropValue, NS } from '../radicale/dav-xml';
import { isRadicaleError, type RadicaleError } from '../radicale/errors';
import { requestControlPlaneSync } from '../radicale/heartbeat';
import {
  type CanaryProvisioning,
  type CollectionProvisioning,
  checkVolumeIdentity,
  ensureCanaryCollection,
  type IdentityCheck,
  remoteIdentitySource,
  VolumeInitError,
  type VolumeInitErrorCode,
  writeVolumeMarker,
} from '../radicale/identity';
import { type Db, readBackendState } from '../radicale/policy';
import { invalidateIdentityCache, radicaleRuntime } from '../radicale/sync';
import {
  CALENDAR_ROLES,
  type CalendarBackendState,
  type CalendarRole,
  CANARY_COLLECTION,
  identityStatus,
  isCanonicalUuid,
  isValidCollectionName,
  type VolumeMarker,
  volumeMarkerFromProps,
} from '../radicale/types';

const log = rootLogger.child({ scope: 'calendar-migration-init' });

/** Collezione dell'archivio della Fase 0 (decisione 7). */
export const ARCHIVE_COLLECTION_NAME = 'archivio-fase0';
/** Nome visibile dell'archivio. */
export const ARCHIVE_CALENDAR_NAME = 'Archivio Fase 0';
/** Componenti ammessi nell'archivio: la Fase 0 era un Radicale qualsiasi, nessun dato si scarta per tipo. */
const ARCHIVE_COMPONENTS = ['VEVENT', 'VTODO', 'VJOURNAL'] as const;

const READ_TIMEOUT_MS = 10_000;
const generateFeedToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 32);

// ─── Lettura del volume ───────────────────────────────

/** Collezione trovata sotto il principal. */
export interface VolumeCollectionInfo {
  name: string;
  calendar_id_prop: string | null;
  role_prop: string | null;
  /** Calendario CalDAV (resourcetype calendar); false per una collezione semplice. */
  is_calendar: boolean;
}

/** Principal, marker e collezioni del volume letti come caldes-svc. */
export interface VolumeRead {
  principal_exists: boolean;
  marker: VolumeMarker | null;
  collections: VolumeCollectionInfo[];
}

function trimSlashes(path: string): string {
  return path.replace(/\/+$/, '');
}

/**
 * PROPFIND Depth:1 del principal come caldes-svc: esistenza, marker
 * d'identità e collezioni con le dead prop calendar-id e role. Principal
 * assente (404) → `principal_exists: false`. Gli altri errori si propagano.
 */
export async function readVolumeCollections(client: RadicaleClient, principal: string, opts: { timeoutMs?: number } = {}): Promise<VolumeRead> {
  const path = principalPath(principal);
  let ms;
  try {
    ms = await client.propfind(path, {
      props: [DAV_PROPS.resourcetype, DAV_PROPS.calendarId, DAV_PROPS.role, DAV_PROPS.volumeId, DAV_PROPS.volumeEpoch],
      depth: 1,
      timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS,
    });
  } catch (err) {
    if (isRadicaleError(err, 'not_found')) return { principal_exists: false, marker: null, collections: [] };
    throw err;
  }
  const own = trimSlashes(decodeURIComponent(path));
  const self = ms.responses.find((r) => trimSlashes(r.path) === own);
  const marker = self && self.status !== 404 ? volumeMarkerFromProps(self.textProps()) : null;
  const collections: VolumeCollectionInfo[] = [];
  for (const entry of ms.responses) {
    if (entry === self || entry.status === 404) continue;
    const segments = entry.path.split('/').filter(Boolean);
    if (segments.length !== 2) continue;
    const rt = entry.element(DAV_PROPS.resourcetype);
    const kinds = new Set((rt?.children ?? []).map((c) => `${c.ns}|${c.name}`));
    if (!kinds.has(`${NS.DAV}|collection`)) continue;
    const props = entry.textProps();
    collections.push({
      name: segments[1],
      calendar_id_prop: props[clark(DAV_PROPS.calendarId)]?.trim() || null,
      role_prop: props[clark(DAV_PROPS.role)]?.trim() || null,
      is_calendar: kinds.has(`${NS.CALDAV}|calendar`),
    });
  }
  collections.sort((a, b) => a.name.localeCompare(b.name));
  return { principal_exists: Boolean(self && self.status !== 404), marker, collections };
}

/** Numero di risorse in una collezione (PROPFIND Depth:1 con getetag); null se non leggibile. */
async function countItems(client: RadicaleClient, principal: string, collection: string): Promise<number | null> {
  try {
    const ms = await client.propfind(collectionPath(principal, collection), { props: [DAV_PROPS.getetag], depth: 1, timeoutMs: READ_TIMEOUT_MS });
    return ms.responses.filter((r) => r.path.split('/').filter(Boolean).length === 3).length;
  } catch {
    return null;
  }
}

/** Etag delle risorse di una collezione per nome (PROPFIND Depth:1); collezione assente → null. */
async function readCollectionEtags(client: RadicaleClient, principal: string, collection: string): Promise<Map<string, string | null> | null> {
  let ms;
  try {
    ms = await client.propfind(collectionPath(principal, collection), { props: [DAV_PROPS.getetag], depth: 1, timeoutMs: READ_TIMEOUT_MS });
  } catch (err) {
    if (isRadicaleError(err, 'not_found')) return null;
    throw err;
  }
  const out = new Map<string, string | null>();
  for (const r of ms.responses) {
    if (r.path.split('/').filter(Boolean).length !== 3) continue;
    out.set(r.name, r.text(DAV_PROPS.getetag)?.trim() || null);
  }
  return out;
}

// ─── Collezioni del piano ───────────────────────────────

/** Collezioni che l'init creerebbe o verifica adesso (preflight, wizard). */
export async function plannedCollections(db: Db): Promise<PlannedCollection[]> {
  const calendars = await loadMigrationCalendars(db);
  const out: PlannedCollection[] = calendars
    .filter((c) => c.included && c.collection_name)
    .map((c) => ({ calendar_id: c.id, collection_name: c.collection_name as string, kind: 'calendar' as const, role: c.role }));

  // Iscrizioni visibili ai device: collezione sub-* del sidecar (lo specchio la popola, F2).
  const subs: Array<{ id: string; collection_name: string | null; role: string }> = await db`
    SELECT c.id, c.collection_name, c.role
    FROM calendar_subscriptions s
    JOIN calendars c ON c.id = s.collection_calendar_id
    WHERE s.device_visible AND c.role = 'subscription' AND c.lifecycle = 'active' AND c.collection_name IS NOT NULL
    ORDER BY c.collection_name
  `;
  for (const s of subs) {
    if (!isValidCollectionName(s.collection_name)) continue;
    out.push({ calendar_id: String(s.id).toLowerCase(), collection_name: s.collection_name, kind: 'subscription', role: 'subscription' });
  }

  // Archivio della Fase 0, se la riga esiste.
  const archive: Array<{ id: string; role: string }> = await db`
    SELECT id, role FROM calendars
    WHERE collection_name = ${ARCHIVE_COLLECTION_NAME} AND lifecycle = 'active'
    LIMIT 1
  `;
  if (archive[0]) {
    out.push({ calendar_id: String(archive[0].id).toLowerCase(), collection_name: ARCHIVE_COLLECTION_NAME, kind: 'archive', role: archive[0].role as CalendarRole });
  }

  out.push({ calendar_id: null, collection_name: CANARY_COLLECTION, kind: 'system', role: null });
  return out;
}

/** Proprietà della MKCALENDAR di una collezione del piano (dal sidecar di calendars). */
interface CollectionSpec {
  calendar_id: string;
  collection_name: string;
  kind: PlannedCollection['kind'];
  role: CalendarRole;
  name: string;
  description: string | null;
  color: string;
  sort_order: number;
  components: string[];
}

async function collectionSpecs(db: Db, planned: readonly PlannedCollection[]): Promise<CollectionSpec[]> {
  const ids = planned.filter((p) => p.calendar_id).map((p) => p.calendar_id as string);
  if (ids.length === 0) return [];
  const rows: Array<{ id: string; name: string; description: string | null; color: string | null; sort_order: number | null; role: string; components: string[] | null }> = await db`
    SELECT id, name, description, color, sort_order, role, components
    FROM calendars WHERE id = ANY(${ids}::uuid[])
  `;
  const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
  const out: CollectionSpec[] = [];
  for (const p of planned) {
    if (!p.calendar_id) continue;
    const row = byId.get(p.calendar_id.toLowerCase());
    if (!row) continue;
    const role = (CALENDAR_ROLES as readonly string[]).includes(row.role) ? (row.role as CalendarRole) : 'user';
    out.push({
      calendar_id: p.calendar_id.toLowerCase(),
      collection_name: p.collection_name,
      kind: p.kind,
      role,
      name: row.name,
      description: row.description,
      color: row.color || '#7c3aed',
      sort_order: row.sort_order ?? 0,
      components: row.components?.length ? row.components : ['VEVENT'],
    });
  }
  return out;
}

/**
 * MKCALENDAR di una collezione del piano con displayname, colore,
 * descrizione, ordine, componenti e dead prop calendar-id e role. Presente
 * con la stessa calendar-id → exists; con un'altra (o senza) → conflict, mai
 * toccata. Chi chiama ha già riverificato l'identità del volume.
 */
async function provisionCollection(client: RadicaleClient, principal: string, spec: CollectionSpec): Promise<CollectionProvisioning> {
  const path = collectionPath(principal, spec.collection_name);
  const base = { calendarId: spec.calendar_id, collectionName: spec.collection_name };
  const compare = (props: Record<string, string>): CollectionProvisioning => {
    const existingId = props[clark(DAV_PROPS.calendarId)]?.trim();
    return existingId?.toLowerCase() === spec.calendar_id
      ? { ...base, status: 'exists' }
      : { ...base, status: 'conflict', detail: existingId ? `calendar-id ${existingId}` : 'collezione senza calendar-id' };
  };
  const current = await client.readProps(path, [DAV_PROPS.resourcetype, DAV_PROPS.calendarId]);
  if (current !== null) return compare(current);
  const deadProps: DavPropValue[] = [
    { ...DAV_PROPS.calendarId, value: spec.calendar_id },
    { ...DAV_PROPS.role, value: spec.role },
  ];
  try {
    await client.mkcalendar(path, {
      displayName: spec.name,
      color: spec.color,
      description: spec.description ?? undefined,
      order: spec.sort_order,
      components: spec.components,
      props: deadProps,
    });
    return { ...base, status: 'created' };
  } catch (err) {
    if (isRadicaleError(err, 'conflict') || (isRadicaleError(err) && err.status === 405)) {
      const again = await client.readProps(path, [DAV_PROPS.resourcetype, DAV_PROPS.calendarId]);
      if (again !== null) return compare(again);
      return { ...base, status: 'conflict', detail: 'collezione comparsa durante la creazione' };
    }
    throw err;
  }
}

// ─── Inizializzazione del volume (MKCOL del principal, marker, stato) ───────────────────────────────

/** Esito dell'inizializzazione dell'identità. */
export interface VolumeIdentityInit {
  volumeId: string;
  epoch: number;
  /**
   * none: inizializzazione completa adesso; marker: ripresa con il marker già
   * sul volume (crash fra PROPPATCH e UPDATE); principal: ripresa con il
   * principal vuoto senza marker (crash fra MKCOL e PROPPATCH); state: stato
   * già aggiornato (crash dopo l'UPDATE).
   */
  resumed: 'none' | 'marker' | 'principal' | 'state';
}

/**
 * Principal, marker ed epoch 1 (contratto control-plane §4.4 passi 1-4) con
 * il journal della F3. `resumable` dice che `volumeId` era già nel journal
 * prima di questo tentativo: solo allora un principal vuoto senza marker o un
 * marker uguale a `volumeId` sono il lavoro interrotto di un tentativo
 * precedente. Lancia VolumeInitError per le precondizioni.
 */
export async function initializeVolumeIdentity(opts: { db: Db; client: RadicaleClient; principal: string; volumeId: string; resumable: boolean }): Promise<VolumeIdentityInit> {
  const { db, client, principal } = opts;
  const volumeId = opts.volumeId.toLowerCase();
  if (!isCanonicalUuid(volumeId)) throw new TypeError(`volume_id non valido: ${JSON.stringify(opts.volumeId)}`);

  const state = await readBackendState(db);
  if (state.mode !== 'postgres') throw new VolumeInitError('state_not_postgres', `inizializzazione ammessa solo in mode postgres (ora ${state.mode})`);
  if (state.epoch !== 0) {
    if (opts.resumable && state.volume_id === volumeId && state.epoch === 1) {
      const check = await checkVolumeIdentity(state, remoteIdentitySource(client), principal);
      if (check.status === 'ok') return { volumeId, epoch: 1, resumed: 'state' };
      throw new VolumeInitError('identity_not_ok', `stato già inizializzato da questo run ma identità ${check.status}${check.detail ? ` (${check.detail})` : ''}`);
    }
    throw new VolumeInitError('already_initialized', `volume già registrato in PG (epoch ${state.epoch})`);
  }

  const path = principalPath(principal);
  const props = await client.readProps(path, [DAV_PROPS.resourcetype, DAV_PROPS.volumeId, DAV_PROPS.volumeEpoch]);
  let resumed: VolumeIdentityInit['resumed'] = 'none';
  if (props === null) {
    try {
      await client.mkcol(path);
    } catch (err) {
      if (isRadicaleError(err) && err.status === 405) {
        throw new VolumeInitError('principal_exists', `il principal ${path} è comparso durante l'inizializzazione`);
      }
      throw err;
    }
    await writeVolumeMarker(client, principal, { volume_id: volumeId, epoch: 1 });
  } else {
    const marker = volumeMarkerFromProps(props);
    if (opts.resumable && marker && marker.volume_id === volumeId && marker.epoch === 1) {
      resumed = 'marker';
    } else if (opts.resumable && !marker && (await principalIsEmpty(client, principal))) {
      await writeVolumeMarker(client, principal, { volume_id: volumeId, epoch: 1 });
      resumed = 'principal';
    } else {
      throw new VolumeInitError('principal_exists', `il principal ${path} esiste già su Radicale${marker ? ` con il marker ${marker.volume_id} (epoch ${marker.epoch})` : ' senza marker'}: un volume non vuoto non viene mai inizializzato né adottato`);
    }
  }

  const updated: Array<{ epoch: number }> = await db`
    UPDATE calendar_backend_state
    SET volume_id = ${volumeId}::uuid, epoch = 1
    WHERE id = true AND mode = 'postgres' AND epoch = 0
    RETURNING epoch
  `;
  if (updated.length !== 1) {
    throw new VolumeInitError('state_changed', 'lo stato in PG è cambiato durante l\'inizializzazione: il marker è sul volume ma PG non lo registra (serve la riassegnazione d\'identità)');
  }
  return { volumeId, epoch: 1, resumed };
}

/** Principal senza figli (nessuna collezione né risorsa). */
async function principalIsEmpty(client: RadicaleClient, principal: string): Promise<boolean> {
  const ms = await client.propfind(principalPath(principal), { props: [DAV_PROPS.resourcetype], depth: 1, timeoutMs: READ_TIMEOUT_MS });
  const own = trimSlashes(decodeURIComponent(principalPath(principal)));
  return ms.responses.every((r) => trimSlashes(r.path) === own);
}

/** VolumeInitError → MigrationError con i motivi del contratto. */
function initErrorToMigration(err: VolumeInitError): MigrationError {
  switch (err.code) {
    case 'state_not_postgres':
      return preconditionError(err.message, ['MODE_NOT_POSTGRES'], 'MODE_CHANGED');
    case 'already_initialized':
      return preconditionError(err.message, ['IDENTITY_NOT_UNINITIALIZED']);
    case 'principal_exists':
      return preconditionError(err.message, ['PRINCIPAL_EXISTS'], 'PRINCIPAL_EXISTS');
    case 'state_changed':
      return preconditionError(err.message, ['IDENTITY_NOT_UNINITIALIZED'], 'STATE_CHANGED');
    case 'identity_not_ok':
    default:
      return preconditionError(err.message, ['IDENTITY_NOT_OK'], 'IDENTITY_NOT_OK');
  }
}

/** Dopo un cambio d'identità del processo: identità da rileggere e policy da riscrivere subito (il NOTIFY lo fa comunque). */
async function afterIdentityChange(): Promise<void> {
  invalidateIdentityCache();
  try {
    await Promise.race([requestControlPlaneSync(), new Promise((r) => setTimeout(r, 5_000).unref())]);
  } catch (err) {
    log.warn({ err }, 'giro del control-plane dopo il cambio d\'identità non riuscito (lo provoca comunque il NOTIFY)');
  }
}

// ─── Inizializzazione: piano ed esecuzione (wizard e script) ───────────────────────────────

/** Che cosa farebbe l'inizializzazione adesso (prova a vuoto dello script, wizard). */
export interface InitializationPlan {
  action: 'initialize' | 'create_missing' | 'refuse';
  refused: { code: VolumeInitErrorCode; message: string } | null;
  state: CalendarBackendState;
  principal_exists: boolean;
  identity: IdentityCheck;
  collections: PlannedCollection[];
}

/** Precondizioni dell'inizializzazione (contratto control-plane §4.4), senza scrivere nulla. */
export async function planInitialization(opts: { db: Db; client: RadicaleClient; principal: string }): Promise<InitializationPlan> {
  const { db, client, principal } = opts;
  const state = await readBackendState(db);
  const props = await client.readProps(principalPath(principal), [DAV_PROPS.resourcetype]);
  const identity = await checkVolumeIdentity(state, remoteIdentitySource(client), principal);
  const collections = await plannedCollections(db);
  const plan: InitializationPlan = { action: 'refuse', refused: null, state, principal_exists: props !== null, identity, collections };
  if (state.mode !== 'postgres') {
    plan.refused = { code: 'state_not_postgres', message: `inizializzazione ammessa solo in mode postgres (ora ${state.mode})` };
  } else if (state.epoch === 0) {
    if (plan.principal_exists) {
      plan.refused = {
        code: 'principal_exists',
        message: `il principal /${principal}/ esiste già su Radicale ma PG non registra alcun volume: un volume non vuoto non viene mai adottato (serve la riassegnazione d'identità dal wizard)`,
      };
    } else {
      plan.action = 'initialize';
    }
  } else if (identity.status === 'ok') {
    plan.action = 'create_missing';
  } else {
    plan.refused = {
      code: 'identity_not_ok',
      message: `volume già registrato in PG (epoch ${state.epoch}) ma identità ${identity.status}${identity.detail ? ` (${identity.detail})` : ''}: nessuna modifica`,
    };
  }
  return plan;
}

/** Opzioni dell'esecuzione dell'inizializzazione. */
export interface ExecuteInitializationOptions {
  db: Db;
  client: RadicaleClient;
  principal: string;
  action: 'initialize' | 'create_missing';
  /** Volume da registrare (initialize): dal journal del run o nuovo. */
  volumeId?: string;
  /** volumeId era già nel journal prima di questo tentativo (ripresa). */
  resumable?: boolean;
  /** Fra una collezione e l'altra (annullamento del run). */
  beforeCollection?: () => void;
  onProgress?: (done: number, total: number, collection: string) => Promise<void>;
}

/**
 * Inizializzazione (initialize) o collezioni mancanti (create_missing): unico
 * percorso usato dal wizard (runInit) e da scripts/radicale-init.ts. Lancia
 * VolumeInitError per le precondizioni e MigrationError per l'identità
 * cambiata durante l'esecuzione.
 */
export async function executeInitialization(opts: ExecuteInitializationOptions): Promise<InitSummary & { resumed: VolumeIdentityInit['resumed'] | null }> {
  const { db, client, principal } = opts;
  let resumed: VolumeIdentityInit['resumed'] | null = null;
  if (opts.action === 'initialize') {
    const init = await initializeVolumeIdentity({
      db, client, principal,
      volumeId: opts.volumeId ?? randomUUID(),
      resumable: opts.resumable === true,
    });
    resumed = init.resumed;
    await afterIdentityChange();
  }

  let guard: IdentityGuard;
  try {
    guard = await createIdentityGuard({ db, client, principal });
  } catch (err) {
    if (err instanceof MigrationError) {
      const reasons = (err.details?.reasons as string[] | undefined) ?? [];
      throw new VolumeInitError(reasons.includes('MODE_NOT_POSTGRES') ? 'state_not_postgres' : 'identity_not_ok', err.message);
    }
    throw err;
  }

  const planned = await plannedCollections(db);
  const specs = await collectionSpecs(db, planned);
  const collections: CollectionProvisioning[] = [];
  const total = specs.length + 1;
  let done = 0;
  for (const spec of specs) {
    opts.beforeCollection?.();
    await guard.recheck({ force: true });
    collections.push(await provisionCollection(client, principal, spec));
    done++;
    await opts.onProgress?.(done, total, spec.collection_name);
  }
  opts.beforeCollection?.();
  await guard.recheck({ force: true });
  let canary: CanaryProvisioning;
  try {
    canary = await ensureCanaryCollection({ db, client, principal });
  } catch (err) {
    if (err instanceof VolumeInitError) throw initErrorToMigration(err);
    throw err;
  }
  await opts.onProgress?.(total, total, CANARY_COLLECTION);
  return { action: opts.action, volume_id: guard.state.volume_id as string, epoch: guard.state.epoch, collections, canary, resumed };
}

/**
 * Journal dell'inizializzazione: il volume_id scelto finisce nei params del
 * run PRIMA della MKCOL. Restituisce l'id e se c'era già (ripresa).
 */
async function journalVolumeId(ctx: MigrationRunContext<InitParams>): Promise<{ volumeId: string; preexisting: boolean }> {
  const fromParams = typeof ctx.params?.volume_id === 'string' ? ctx.params.volume_id.toLowerCase() : null;
  if (fromParams && isCanonicalUuid(fromParams)) return { volumeId: fromParams, preexisting: true };
  const candidate = randomUUID();
  const rows: Array<{ volume_id: string | null }> = await ctx.db`
    UPDATE cal_migration_runs
    SET params = CASE WHEN params ? 'volume_id' THEN params ELSE params || jsonb_build_object('volume_id', ${candidate}::text) END
    WHERE id = ${ctx.runId}::uuid
    RETURNING params->>'volume_id' AS volume_id
  `;
  const stored = rows[0]?.volume_id?.toLowerCase() ?? null;
  if (!stored || !isCanonicalUuid(stored)) {
    throw new MigrationError('INTERNAL', 'journal dell\'inizializzazione non scritto: run inesistente o params non validi');
  }
  return { volumeId: stored, preexisting: stored !== candidate };
}

function collectionItems(summary: InitSummary, planned: readonly PlannedCollection[]): MigrationItemInput[] {
  const kinds = new Map(planned.map((p) => [p.collection_name, p]));
  const items: MigrationItemInput[] = summary.collections.map((c) => ({
    item_type: 'collection' as const,
    calendar_id: c.calendarId,
    collection_name: c.collectionName,
    code: c.status.toUpperCase(),
    severity: c.status === 'conflict' ? 'error' as const : 'info' as const,
    detail: { status: c.status, kind: kinds.get(c.collectionName)?.kind ?? null, role: kinds.get(c.collectionName)?.role ?? null, ...(c.detail ? { detail: c.detail } : {}) },
  }));
  items.push({
    item_type: 'collection',
    calendar_id: null,
    collection_name: CANARY_COLLECTION,
    code: summary.canary.toUpperCase(),
    severity: 'info',
    detail: { status: summary.canary, kind: 'system', role: null },
  });
  return items;
}

/**
 * action 'initialize': precondizioni del contratto control-plane §4.4 (mode postgres, epoch 0, principal assente),
 * journal crash-resistente (InitParams.volume_id scritto nei params del run PRIMA della MKCOL; una ripresa che trova
 * sul volume il proprio marker prosegue dall'UPDATE dello stato), poi collezioni del piano, sub-* visibili, archivio
 * se c'è la riga, _canary. action 'create_missing': identità 'ok', solo le collezioni mancanti.
 * Collezione presente con un'altra calendar-id → 'conflict' (mai toccata). Mai su un volume non vuoto senza marker.
 */
export async function runInit(ctx: MigrationRunContext<InitParams>): Promise<InitSummary> {
  const action = ctx.params?.action;
  if (action !== 'initialize' && action !== 'create_missing') {
    throw new MigrationError('VALIDATION_FAILED', 'Azione dell\'inizializzazione non valida (initialize o create_missing)');
  }
  const { client, principal } = requireRadicale();
  ctx.throwIfCancelled();
  await ctx.progress({ phase: 'identity', message: action === 'initialize' ? 'Inizializzazione del volume' : 'Verifica dell\'identità del volume' });

  let journal: { volumeId: string; preexisting: boolean } | null = null;
  if (action === 'initialize') journal = await journalVolumeId(ctx);

  let summary: InitSummary & { resumed: VolumeIdentityInit['resumed'] | null };
  try {
    summary = await executeInitialization({
      db: ctx.db,
      client,
      principal,
      action,
      volumeId: journal?.volumeId,
      resumable: journal?.preexisting ?? false,
      beforeCollection: () => ctx.throwIfCancelled(),
      onProgress: (done, total, collection) => ctx.progress({ phase: 'collections', done, total, message: `Collezione ${collection}` }),
    });
  } catch (err) {
    if (err instanceof VolumeInitError) throw initErrorToMigration(err);
    throw err;
  }
  const planned = await plannedCollections(ctx.db);
  await ctx.addItems(collectionItems(summary, planned));
  const conflicts = summary.collections.filter((c) => c.status === 'conflict').length;
  ctx.log.info({
    action, volumeId: summary.volume_id, epoch: summary.epoch, resumed: summary.resumed,
    created: summary.collections.filter((c) => c.status === 'created').length, conflicts, canary: summary.canary,
  }, 'inizializzazione di Radicale conclusa');
  const { resumed: _resumed, ...result } = summary;
  void _resumed;
  return result;
}

// ─── Identità: diff e riassegnazione ───────────────────────────────

/** Volume letto o errore di lettura. */
async function tryReadVolume(client: RadicaleClient | null, principal: string): Promise<{ volume: VolumeRead | null; error: string | null }> {
  if (!client) return { volume: null, error: 'Radicale non configurato' };
  try {
    return { volume: await readVolumeCollections(client, principal), error: null };
  } catch (err) {
    return { volume: null, error: `lettura del volume non riuscita (${describeRadicaleError(err)})` };
  }
}

function sameMarker(a: VolumeMarker | null, volumeId: string | null, epoch: number): boolean {
  return a !== null && volumeId !== null && a.volume_id === volumeId.toLowerCase() && a.epoch === epoch;
}

function allowedDirections(state: CalendarBackendState, volume: VolumeRead | null): IdentityReassignDirection[] {
  if (state.mode !== 'postgres' || !volume) return [];
  const out: IdentityReassignDirection[] = [];
  if (state.epoch === 0 && volume.marker) out.push('volume_to_pg');
  if (state.epoch >= 1 && state.volume_id && !sameMarker(volume.marker, state.volume_id, state.epoch)) out.push('pg_to_volume');
  return out;
}

/** GET /identity: PG contro marker e collezioni del volume, azioni ammesse. Sola lettura. */
export async function readIdentityDiff(db: Db): Promise<IdentityDiffView> {
  const state = await readMigrationStateFresh(db);
  const rt = radicaleRuntime();
  const { volume, error } = await tryReadVolume(rt.client, rt.principal);
  const status = identityStatus(state, volume ? volume.marker : undefined);
  const collections: IdentityDiffView['volume']['collections'] = [];
  if (volume && rt.client) {
    for (const c of volume.collections.slice(0, 100)) {
      collections.push({ name: c.name, calendar_id_prop: c.calendar_id_prop, role_prop: c.role_prop, items: await countItems(rt.client, rt.principal, c.name) });
    }
  }
  const [ledger]: Array<{ live: number; with_target_etag: number }> = await db`
    SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS live,
           count(*) FILTER (WHERE deleted_at IS NULL AND written_etag IS NOT NULL)::int AS with_target_etag
    FROM cal_migration_ledger
  `;
  const allowed = allowedDirections(state, volume);
  let explanation: string;
  if (!volume) explanation = `Identità non verificabile: ${error ?? 'volume non letto'}.`;
  else if (status === 'ok') explanation = `Identità verificata: il volume ha il marker ${state.volume_id} (epoch ${state.epoch}) registrato nel database.`;
  else explanation = identityExplanation(state, volume);
  return {
    status,
    pg: { mode: state.mode, volume_id: state.volume_id, epoch: state.epoch },
    volume: {
      principal_exists: volume ? volume.principal_exists : null,
      marker: volume?.marker ?? null,
      collections,
      read_error: error,
    },
    ledger: { live: ledger?.live ?? 0, with_target_etag: ledger?.with_target_etag ?? 0 },
    allowed,
    explanation,
  };
}

function expectedOf(state: CalendarBackendState, marker: VolumeMarker | null): IdentityParams['expected'] {
  return { pg_volume_id: state.volume_id, pg_epoch: state.epoch, marker_volume_id: marker?.volume_id ?? null, marker_epoch: marker?.epoch ?? null };
}

function sameExpected(a: IdentityParams['expected'], b: IdentityParams['expected']): boolean {
  const norm = (v: string | null) => (v ? v.toLowerCase() : null);
  return norm(a.pg_volume_id) === norm(b.pg_volume_id) && a.pg_epoch === b.pg_epoch
    && norm(a.marker_volume_id) === norm(b.marker_volume_id) && (a.marker_epoch ?? null) === (b.marker_epoch ?? null);
}

function validateIdentityParams(params: IdentityParams | undefined): IdentityParams {
  if (!params || (params.direction !== 'volume_to_pg' && params.direction !== 'pg_to_volume')) {
    throw new MigrationError('VALIDATION_FAILED', 'Direzione della riassegnazione non valida (volume_to_pg o pg_to_volume)');
  }
  const e = params.expected;
  const uuidOrNull = (v: unknown) => v === null || (typeof v === 'string' && isCanonicalUuid(v.toLowerCase()));
  const intOrNull = (v: unknown) => v === null || v === undefined || (Number.isInteger(v) && (v as number) >= 0);
  if (!e || !uuidOrNull(e.pg_volume_id) || !Number.isInteger(e.pg_epoch) || e.pg_epoch < 0 || !uuidOrNull(e.marker_volume_id) || !intOrNull(e.marker_epoch)) {
    throw new MigrationError('VALIDATION_FAILED', 'Diff d\'identità atteso (expected) non valido');
  }
  return params;
}

/**
 * Riassegnazione confermata (design §13.2, §16.3), solo in mode postgres e solo se il diff è ancora quello visto
 * (IdentityParams.expected, altrimenti PRECONDITION_FAILED IDENTITY_DIFF_CHANGED):
 *  - volume_to_pg: PG epoch 0 e marker valido sul volume (PG ripristinato a prima dell'inizializzazione, o crash
 *    fra marker e UPDATE): volume_id/epoch di PG := marker;
 *  - pg_to_volume: PG epoch ≥ 1 e marker assente o diverso (volume sostituito o ripristinato): MKCOL del principal se
 *    manca, PROPPATCH del marker di PG.
 * Mai un epoch che torna indietro. Poi rivalidazione del ledger ('identity-reassign'); la policy la riscrive il NOTIFY.
 */
export async function runIdentityReassign(ctx: MigrationRunContext<IdentityParams>): Promise<IdentityReassignSummary> {
  const params = validateIdentityParams(ctx.params);
  const { client, principal } = requireRadicale();
  ctx.throwIfCancelled();
  await ctx.progress({ phase: 'identity', message: 'Confronto dell\'identità di database e volume' });

  const state = await readMigrationStateFresh(ctx.db);
  if (state.mode !== 'postgres') throw preconditionError(`Riassegnazione ammessa solo in mode postgres (ora ${state.mode})`, ['MODE_NOT_POSTGRES'], 'MODE_CHANGED');
  let volume: VolumeRead;
  try {
    volume = await readVolumeCollections(client, principal);
  } catch (err) {
    throw preconditionError(`Volume non leggibile: ${describeRadicaleError(err)}`, ['IDENTITY_NOT_OK'], 'RADICALE_UNREACHABLE');
  }
  const before = expectedOf(state, volume.marker);

  // Ripresa idempotente: il passaggio è già stato fatto da un tentativo precedente di questo run.
  const target = params.direction === 'volume_to_pg'
    ? (params.expected.marker_volume_id && params.expected.marker_epoch ? { volume_id: params.expected.marker_volume_id.toLowerCase(), epoch: params.expected.marker_epoch } : null)
    : (params.expected.pg_volume_id ? { volume_id: params.expected.pg_volume_id.toLowerCase(), epoch: Math.max(params.expected.pg_epoch, params.expected.marker_volume_id ? params.expected.marker_epoch ?? 0 : 0) } : null);
  const alreadyDone = ctx.attempt > 1 && target !== null
    && state.volume_id === target.volume_id && state.epoch === target.epoch && sameMarker(volume.marker, target.volume_id, target.epoch);

  let after: { volume_id: string; epoch: number };
  if (alreadyDone && target) {
    after = target;
  } else {
    if (!sameExpected(before, params.expected)) {
      throw preconditionError('Il diff d\'identità è cambiato rispetto a quello confermato: rileggilo e conferma di nuovo.', ['IDENTITY_DIFF_CHANGED'], undefined, { current: before });
    }
    ctx.throwIfCancelled();
    if (params.direction === 'volume_to_pg') {
      if (state.epoch !== 0 || !volume.marker) {
        throw preconditionError('volume_to_pg richiede il database non inizializzato (epoch 0) e un marker valido sul volume.', ['IDENTITY_DIFF_CHANGED']);
      }
      const marker = volume.marker;
      const updated: Array<{ epoch: number }> = await ctx.db`
        UPDATE calendar_backend_state
        SET volume_id = ${marker.volume_id}::uuid, epoch = ${marker.epoch}
        WHERE id = true AND mode = 'postgres' AND epoch = 0 AND volume_id IS NULL
        RETURNING epoch
      `;
      if (updated.length !== 1) throw preconditionError('Lo stato del database è cambiato durante la riassegnazione.', ['IDENTITY_DIFF_CHANGED'], 'STATE_CHANGED');
      after = { volume_id: marker.volume_id, epoch: marker.epoch };
    } else {
      if (state.epoch < 1 || !state.volume_id) {
        throw preconditionError('pg_to_volume richiede un volume registrato nel database (epoch ≥ 1).', ['IDENTITY_DIFF_CHANGED']);
      }
      if (sameMarker(volume.marker, state.volume_id, state.epoch)) {
        throw preconditionError('Il volume ha già il marker del database: niente da riassegnare.', ['IDENTITY_DIFF_CHANGED']);
      }
      // Mai un epoch che torna indietro: né sul volume né nel database.
      const epoch = Math.max(state.epoch, volume.marker?.epoch ?? 0);
      if (!volume.principal_exists) {
        try {
          await client.mkcol(principalPath(principal));
        } catch (err) {
          if (!(isRadicaleError(err) && err.status === 405)) throw err;
        }
      }
      await writeVolumeMarker(client, principal, { volume_id: state.volume_id, epoch });
      if (epoch !== state.epoch) {
        const updated: Array<{ epoch: number }> = await ctx.db`
          UPDATE calendar_backend_state
          SET epoch = ${epoch}
          WHERE id = true AND mode = 'postgres' AND volume_id = ${state.volume_id}::uuid AND epoch = ${state.epoch}
          RETURNING epoch
        `;
        if (updated.length !== 1) throw preconditionError('Lo stato del database è cambiato durante la riassegnazione.', ['IDENTITY_DIFF_CHANGED'], 'STATE_CHANGED');
      }
      after = { volume_id: state.volume_id, epoch };
    }
  }

  const [reval]: Array<{ n: number }> = await ctx.db`SELECT cal_migration_ledger_require_revalidation('identity-reassign') AS n`;
  await afterIdentityChange();

  // Verifica finale dal marker su Radicale.
  const now = await readBackendState(ctx.db);
  const verify = await checkVolumeIdentity(now, remoteIdentitySource(client), principal);
  if (verify.status !== 'ok') {
    throw preconditionError(`Riassegnazione eseguita ma identità ${verify.status}${verify.detail ? ` (${verify.detail})` : ''}.`, ['IDENTITY_NOT_OK'], 'IDENTITY_NOT_OK');
  }

  const summary: IdentityReassignSummary = {
    direction: params.direction,
    before,
    after,
    ledger_revalidation: Number(reval?.n ?? 0),
  };
  await ctx.addItems([{
    item_type: 'check',
    code: 'IDENTITY',
    severity: 'info',
    detail: { status: 'pass', message: `Identità riassegnata (${params.direction}).`, ...summary },
  }]);
  ctx.log.info({ direction: params.direction, before, after, ledgerRevalidation: summary.ledger_revalidation }, 'identità del volume riassegnata');
  return summary;
}

// ─── Archivio della Fase 0 (decisione 7) ───────────────────────────────

/** Cartella dei file caricati per l'archivio (0700): CAL_MIGRATION_UPLOAD_DIR, altrimenti sotto PRIVATE_UPLOAD_DIR. */
export function migrationUploadDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CAL_MIGRATION_UPLOAD_DIR?.trim();
  if (explicit) return resolve(explicit);
  return resolve(env.PRIVATE_UPLOAD_DIR || './private-uploads', 'calendar-migration');
}

/**
 * Cartelle da cui l'archivio accetta un file: quella di migrationUploadDir()
 * e, per compatibilità con il default del contratto (§15), quella sotto
 * UPLOAD_DIR (`<UPLOAD_DIR>/private/calendar-migration`).
 */
export function acceptedUploadDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = new Set<string>([migrationUploadDir(env)]);
  if (!env.CAL_MIGRATION_UPLOAD_DIR?.trim()) dirs.add(resolve(env.UPLOAD_DIR || './uploads', 'private', 'calendar-migration'));
  return [...dirs];
}

function insideDir(path: string, dir: string): boolean {
  const p = resolve(path);
  return p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Un item dell'archivio pronto per l'import. */
interface ArchiveItem {
  /** Nome originale (entry dello zip, o `<file>#<uid>` per un .ics con più UID). */
  source_name: string;
  /** Nome della risorsa nella collezione dell'archivio. */
  href: string;
  uid: string;
  ics: string;
  fingerprint: string;
  sha256: string;
}

/** Item scartato (non valido o duplicato). */
interface ArchiveRejected {
  source_name: string;
  reason: 'invalid' | 'duplicate';
  code: string;
  message: string;
  uid?: string | null;
}

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Nome di risorsa sicuro dal nome originale: lo stesso se valido, altrimenti `item-<sha256[0..32]>.ics`. */
function archiveHref(sourceName: string, used: Set<string>): string {
  const base = basename(sourceName.replace(/\\/g, '/')).replace(/#.*/, '');
  let name = base.toLowerCase().endsWith('.ics') ? base : `${base}.ics`;
  if (sourceName.includes('#')) name = `${name.replace(/\.ics$/i, '')}-${sha256Hex(sourceName).slice(0, 12)}.ics`;
  if (!isValidObjectName(name) || name.length > 200 || /[\s%?#]/.test(name)) name = `item-${sha256Hex(sourceName).slice(0, 32)}.ics`;
  if (used.has(name)) name = `item-${sha256Hex(`${sourceName}#${used.size}`).slice(0, 32)}.ics`;
  used.add(name);
  return name;
}

// ── Lettura dello zip (senza dipendenze: zip "stored" o "deflate", come lo produce radicale-maint.sh) ──

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
/** Dimensione massima decompressa di un item (Radicale accetta fino a 10 MB, calendar-core valida 1 MiB). */
const ZIP_MAX_ENTRY_BYTES = 10 * 1024 * 1024;
/** Dimensione massima decompressa complessiva (difesa dagli zip bomb). */
const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

interface ZipEntry { name: string; data: Buffer }

class ArchiveFormatError extends Error {}

/** Entry `.ics` di uno zip (cartelle, file nascosti, manifest e __MACOSX esclusi). Lancia ArchiveFormatError. */
export function readZipIcsEntries(buf: Buffer, opts: { maxEntries?: number } = {}): { entries: ZipEntry[]; skipped: Array<{ name: string; reason: string }> } {
  const maxEntries = opts.maxEntries ?? MIGRATION_LIMITS.archiveMaxItems;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveFormatError('zip non valido: fine della directory centrale non trovata');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ArchiveFormatError('zip64 non supportato');
  if (cdOffset + cdSize > buf.length) throw new ArchiveFormatError('zip non valido: directory centrale fuori dal file');
  if (count > maxEntries * 2 + 10) throw new ArchiveFormatError(`zip con troppe voci (${count})`);

  const entries: ZipEntry[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== ZIP_CENTRAL) throw new ArchiveFormatError('zip non valido: voce della directory centrale illeggibile');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    const base = basename(name.replace(/\\/g, '/'));
    if (name.endsWith('/') || base.startsWith('.') || name.startsWith('__MACOSX/')) continue;
    if (!base.toLowerCase().endsWith('.ics')) {
      if (!/^manifest/i.test(base)) skipped.push({ name: base, reason: 'non .ics' });
      continue;
    }
    if (flags & 0x1) {
      skipped.push({ name: base, reason: 'cifrato' });
      continue;
    }
    if (size > ZIP_MAX_ENTRY_BYTES) {
      skipped.push({ name: base, reason: 'troppo grande' });
      continue;
    }
    if (entries.length >= maxEntries) throw new ArchiveFormatError(`archivio oltre ${maxEntries} item`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== ZIP_LOCAL) throw new ArchiveFormatError(`zip non valido: intestazione locale di ${base} illeggibile`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compSize > buf.length) throw new ArchiveFormatError(`zip non valido: dati di ${base} fuori dal file`);
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
      } catch {
        skipped.push({ name: base, reason: 'decompressione non riuscita' });
        continue;
      }
    } else {
      skipped.push({ name: base, reason: `compressione ${method} non supportata` });
      continue;
    }
    if (data.length !== size || (typeof crc32 === 'function' && crc32(data) >>> 0 !== crc >>> 0)) {
      skipped.push({ name: base, reason: 'contenuto corrotto (dimensione o CRC)' });
      continue;
    }
    total += data.length;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new ArchiveFormatError('archivio decompresso oltre il limite');
    entries.push({ name, data });
  }
  return { entries, skipped };
}

// ── Lettura del tar del volume (scripts/radicale-maint.sh phase0-backup: tar o tar.gz in sola lettura) ──

const TAR_BLOCK = 512;

/** Campo di testo di un'intestazione tar (terminato da NUL). */
function tarField(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
}

/** Record PAX (`<len> <chiave>=<valore>\n`): solo `path`. */
function paxPath(data: Buffer): string | null {
  let p = 0;
  let path: string | null = null;
  while (p < data.length) {
    const space = data.indexOf(0x20, p);
    if (space < 0) break;
    const len = Number.parseInt(data.subarray(p, space).toString('latin1'), 10);
    if (!Number.isInteger(len) || len <= 0 || p + len > data.length) break;
    const record = data.subarray(space + 1, p + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    p += len;
  }
  return path;
}

/**
 * Item `.ics` del tar del volume della Fase 0 (layout di Radicale:
 * `collection-root/<principal>/<collezione>/<item>.ics`), con il nome
 * `<collezione>__<item>.ics` dello zip di phase0-export: lo stesso item
 * importato dal tar o dallo zip ha la stessa chiave del ledger. Cartelle e
 * file nascosti (`.Radicale.props`, `.Radicale.cache`), link e voci fuori
 * dal layout sono esclusi. Lancia ArchiveFormatError.
 */
export function readTarIcsEntries(buf: Buffer, opts: { maxEntries?: number } = {}): { entries: ZipEntry[]; skipped: Array<{ name: string; reason: string }> } {
  const maxEntries = opts.maxEntries ?? MIGRATION_LIMITS.archiveMaxItems;
  const entries: ZipEntry[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const used = new Set<string>();
  let total = 0;
  let off = 0;
  let longName: string | null = null;
  while (off + TAR_BLOCK <= buf.length) {
    const header = buf.subarray(off, off + TAR_BLOCK);
    if (header.every((b) => b === 0)) break;
    // Somma di controllo: byte dell'intestazione con il campo della somma letto come spazi.
    const expected = Number.parseInt(tarField(header, 148, 8).trim() || 'NaN', 8);
    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (sum !== expected) throw new ArchiveFormatError('tar non valido: somma di controllo dell\'intestazione errata');
    if (header[124] & 0x80) throw new ArchiveFormatError('tar con dimensioni in base 256 non supportato');
    const size = Number.parseInt(tarField(header, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new ArchiveFormatError('tar non valido: dimensione illeggibile');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const start = off + TAR_BLOCK;
    const end = start + size;
    if (end > buf.length) throw new ArchiveFormatError('tar troncato');
    off = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    const data = buf.subarray(start, end);
    if (type === 'L') {
      longName = tarField(Buffer.concat([data, Buffer.alloc(1)]), 0, data.length + 1);
      continue;
    }
    if (type === 'x') {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === 'g') continue;
    // Il prefisso del percorso esiste solo nel formato POSIX ('ustar\0'); nel formato GNU ('ustar  ') quei byte sono altro.
    const posix = header.subarray(257, 263).toString('latin1') === 'ustar\0';
    const prefix = posix ? tarField(header, 345, 155) : '';
    const path = longName ?? (prefix ? `${prefix}/${tarField(header, 0, 100)}` : tarField(header, 0, 100));
    longName = null;
    if (type !== '0' && type !== '7') continue;

    const segments = path.split('/').filter((s) => s && s !== '.');
    const base = segments[segments.length - 1] ?? '';
    if (segments.some((s) => s.startsWith('.') || s === '..') || !base.toLowerCase().endsWith('.ics')) continue;
    if (segments.length < 2) {
      skipped.push({ name: base, reason: 'fuori dal layout delle collezioni' });
      continue;
    }
    if (size > ZIP_MAX_ENTRY_BYTES) {
      skipped.push({ name: base, reason: 'troppo grande' });
      continue;
    }
    // <collezione>__<item>.ics come phase0-export; con due principal la stessa coppia prende anche il principal.
    let name = `${segments[segments.length - 2]}__${base}`;
    if (used.has(name) && segments.length >= 3) name = `${segments[segments.length - 3]}__${name}`;
    if (used.has(name)) {
      skipped.push({ name, reason: 'nome già presente nell\'archivio' });
      continue;
    }
    if (entries.length >= maxEntries) throw new ArchiveFormatError(`archivio oltre ${maxEntries} item`);
    total += size;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new ArchiveFormatError('archivio decompresso oltre il limite');
    used.add(name);
    entries.push({ name, data: Buffer.from(data) });
  }
  return { entries, skipped };
}

/**
 * Item dell'archivio dal file caricato: zip di phase0-export (un item per
 * entry `.ics`), tar o tar.gz del volume di phase0-backup (un item per
 * risorsa `.ics` delle collezioni, con lo stesso nome dello zip) o un singolo
 * .ics (un item per UID). Parse e validateObject di calendar-core; UID
 * duplicati → si tiene il primo (in ordine di nome).
 */
export function readArchiveItems(input: Buffer, originalName: string, now: Date): { items: ArchiveItem[]; rejected: ArchiveRejected[] } {
  const rejected: ArchiveRejected[] = [];
  const candidates: Array<{ source_name: string; obj: CalendarObject; raw: Uint8Array }> = [];
  const isGzip = input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b;
  let buf = input;
  if (isGzip) {
    try {
      buf = gunzipSync(input, { maxOutputLength: ZIP_MAX_TOTAL_BYTES });
    } catch {
      throw new ArchiveFormatError('gzip non leggibile o decompresso oltre il limite');
    }
  }
  const isZip = buf.length >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL;
  const isTar = buf.length >= TAR_BLOCK && buf.subarray(257, 262).toString('latin1') === 'ustar';
  if (isGzip && !isTar) throw new ArchiveFormatError('file gzip che non contiene un tar');
  if (isZip || isTar) {
    const { entries, skipped } = isZip ? readZipIcsEntries(buf) : readTarIcsEntries(buf);
    for (const s of skipped) rejected.push({ source_name: s.name, reason: 'invalid', code: 'INVALID_OBJECT', message: `Voce scartata: ${s.reason}` });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const parsed = parseCalendarObject(e.data);
      if (!parsed.ok) {
        rejected.push({ source_name: e.name, reason: 'invalid', code: 'INVALID_OBJECT', message: `iCalendar non leggibile (${parsed.error.code})` });
        continue;
      }
      candidates.push({ source_name: e.name, obj: parsed.value, raw: e.data });
    }
  } else {
    const cal = parseIcs(buf);
    if (!cal.ok) throw new ArchiveFormatError(`file né zip né iCalendar leggibile (${cal.error.code})`);
    const split = splitCalendar(cal.value, { duplicateMasters: 'keep-first' });
    for (const err of split.errors) {
      rejected.push({ source_name: `${basename(originalName)}#${err.uid ?? `posizione-${err.index}`}`, reason: 'invalid', code: 'INVALID_OBJECT', message: `oggetto non leggibile (${err.error.code})`, uid: err.uid });
    }
    for (const obj of split.objects) {
      const text = serializeObject(obj, { prodid: 'preserve', timezones: 'preserve' });
      candidates.push({ source_name: `${basename(originalName)}#${obj.uid}`, obj, raw: Buffer.from(text, 'utf8') });
    }
    // Un .ics con un solo oggetto vale come l'item omonimo dell'export.
    if (candidates.length === 1 && rejected.length === 0) candidates[0].source_name = basename(originalName);
  }

  const items: ArchiveItem[] = [];
  const seenUids = new Map<string, string>();
  const usedHrefs = new Set<string>();
  for (const c of candidates) {
    const check = validateObject(c.obj, { tz: 'Europe/Rome', allowedComponents: ARCHIVE_COMPONENTS, now });
    if (!check.ok) {
      const codes = [...new Set(check.issues.filter((i) => i.severity === 'error').map((i) => i.code))];
      rejected.push({ source_name: c.source_name, reason: 'invalid', code: 'INVALID_OBJECT', message: `oggetto non valido (${codes.join(', ')})`, uid: c.obj.uid });
      continue;
    }
    const first = seenUids.get(c.obj.uid);
    if (first) {
      rejected.push({ source_name: c.source_name, reason: 'duplicate', code: 'POSSIBLE_DUPLICATE', message: `UID già presente in ${first}: si tiene il primo`, uid: c.obj.uid });
      continue;
    }
    seenUids.set(c.obj.uid, c.source_name);
    let ics: string;
    try {
      ics = serializeObject(c.obj, { prodid: 'preserve', timezones: 'preserve' });
    } catch (err) {
      rejected.push({ source_name: c.source_name, reason: 'invalid', code: 'INVALID_OBJECT', message: `serializzazione non riuscita (${(err as Error).message.slice(0, 80)})`, uid: c.obj.uid });
      continue;
    }
    items.push({
      source_name: c.source_name,
      href: archiveHref(c.source_name, usedHrefs),
      uid: c.obj.uid,
      ics,
      fingerprint: semanticFingerprint(c.obj),
      sha256: sha256Hex(c.raw),
    });
  }
  return { items, rejected };
}

/** Riga dell'archivio in calendars (origin 'migration', invisibile al legacy, non bloccante, feed spento). */
async function ensureArchiveCalendar(db: Db, retry = true): Promise<{ id: string; created: boolean }> {
  const existing: Array<{ id: string; origin: string; lifecycle: string }> = await db`
    SELECT id, origin, lifecycle FROM calendars WHERE collection_name = ${ARCHIVE_COLLECTION_NAME} OR slug = ${ARCHIVE_COLLECTION_NAME}
  `;
  if (existing.length > 0) {
    const row = existing[0];
    if (existing.length > 1 || row.origin !== 'migration') {
      throw new MigrationError('PRECONDITION_FAILED', `Il nome ${ARCHIVE_COLLECTION_NAME} è già usato da un altro calendario: rinominalo prima di importare l'archivio.`, {
        reasons: [], run_error_code: 'ARCHIVE_INVALID',
      });
    }
    if (row.lifecycle !== 'active') {
      await db`UPDATE calendars SET lifecycle = 'active' WHERE id = ${row.id}`;
    }
    return { id: String(row.id).toLowerCase(), created: false };
  }
  const [row]: Array<{ id: string }> = await db`
    INSERT INTO calendars (
      slug, name, description, color, timezone, is_default, is_system, blocks_availability,
      ics_feed_token, ics_feed_enabled, sort_order,
      collection_name, role, origin, lifecycle, device_visible, components
    ) VALUES (
      ${ARCHIVE_COLLECTION_NAME}, ${ARCHIVE_CALENDAR_NAME},
      ${'Eventi importati dal volume Radicale della Fase 0 (decisione 7): in sola lettura, non bloccanti.'},
      ${'#64748b'}, ${'Europe/Rome'}, false, false, false,
      ${generateFeedToken()}, false, 1000,
      ${ARCHIVE_COLLECTION_NAME}, 'user', 'migration', 'active', true, ${[...ARCHIVE_COMPONENTS]}::text[]
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (!row) {
    // Inserimento concorrente (o token del feed già usato): si rilegge una volta.
    if (retry) return ensureArchiveCalendar(db, false);
    throw new MigrationError('INTERNAL', `riga del calendario ${ARCHIVE_COLLECTION_NAME} non creata`);
  }
  return { id: String(row.id).toLowerCase(), created: true };
}

/** Esito di un item dell'archivio. */
type ArchiveOutcome = 'imported' | 'updated' | 'unchanged' | 'conflict' | 'failed';

interface ArchiveItemResult {
  outcome: ArchiveOutcome;
  action: 'create' | 'update' | 'noop' | 'adopt' | 'conflict';
  code: ConflictCode | null;
  etag: string | null;
  http_status: number | null;
  error: string | null;
}

/** Stato della destinazione: etag e fingerprint semantico (fingerprint null se il testo non si legge). */
interface ArchiveTarget { etag: string | null; fingerprint: string | null }

/** GET della destinazione (null se assente). */
async function readTarget(client: RadicaleClient, path: string): Promise<ArchiveTarget | null> {
  try {
    const res = await client.get(path);
    const parsed = parseCalendarObject(res.body);
    return { etag: res.etag, fingerprint: parsed.ok ? semanticFingerprint(parsed.value) : null };
  } catch (err) {
    if (isRadicaleError(err, 'not_found')) return null;
    throw err;
  }
}

const conflict = (code: ConflictCode, etag: string | null): ArchiveItemResult => ({ outcome: 'conflict', action: 'conflict', code, etag, http_status: null, error: null });
const unchanged = (action: 'noop' | 'adopt', etag: string | null): ArchiveItemResult => ({ outcome: 'unchanged', action, code: null, etag, http_status: null, error: null });

/**
 * Un item dell'archivio con la semantica del ledger (contratto §4.3, §4.5 e
 * tabella del §7.2) attraverso le primitive di apply.ts:
 *  - intento pendente di un tentativo interrotto → GET: contenuto
 *    dell'intento → adozione; contenuto dell'ultima scrittura o risorsa
 *    assente → intento azzerato e si prosegue; altro → UNTRACKED_TARGET;
 *  - nessuna scrittura precedente: risorsa assente → PUT con
 *    If-None-Match: * (412 = già importata da altri: adozione se ha lo stesso
 *    contenuto); presente con lo stesso contenuto → adozione; altrimenti
 *    UNTRACKED_TARGET;
 *  - già scritta: etag e hash invariati → noop senza richieste; contenuto
 *    voluto già presente → adozione; sorgente cambiata e destinazione
 *    invariata → PUT con If-Match; destinazione cambiata → TARGET_NEWER (o
 *    BOTH_CHANGED); destinazione sparita → DELETED_IN_TARGET, mai ricreata
 *    senza conferma;
 *  - riga da rivalidare (import di un backup, riassegnazione d'identità):
 *    ogni scrittura diventa REVALIDATION_REQUIRED, un noop o un'adozione la
 *    smarcano (transazione d'esito senza richiesta).
 */
async function importArchiveItem(opts: {
  db: Db;
  client: RadicaleClient;
  principal: string;
  calendarId: string;
  item: ArchiveItem;
  ledger: LedgerRow | undefined;
  /** Etag dal PROPFIND della collezione: undefined = risorsa assente, null = presente senza etag. */
  targetEtag: string | null | undefined;
  runId: string;
  throttle: () => Promise<void>;
}): Promise<ArchiveItemResult> {
  const { db, client, principal, calendarId, item, runId } = opts;
  const path = objectPath(principal, ARCHIVE_COLLECTION_NAME, item.href);
  const key = legacyKey('archive', item.source_name);
  const snapshot: ArchiveSnapshot = { v: 1, kind: 'archive', source_name: item.source_name, sha256: item.sha256 };
  const hash = legacyHash(snapshot);
  let row = opts.ledger && !opts.ledger.deleted_at ? opts.ledger : undefined;

  // Destinazione letta al più una volta (null = assente).
  let target: ArchiveTarget | null | undefined = opts.targetEtag === undefined ? null : undefined;
  const readOnce = async (): Promise<ArchiveTarget | null> => {
    if (target === undefined) {
      await opts.throttle();
      target = await readTarget(client, path);
    }
    return target;
  };

  // Chiusura senza richiesta (adozione o noop che smarca la rivalidazione): intento e transazione d'esito.
  const adopt = async (t: ArchiveTarget): Promise<ArchiveItemResult> => {
    const intent = await recordIntent(db, {
      ledgerId: row?.id ?? null, calendar_id: calendarId, collection_name: ARCHIVE_COLLECTION_NAME, href: item.href, kind: 'archive',
      legacy_key: key, legacy_event_id: null, uid: item.uid, op: row?.written_etag ? 'update' : 'create', fingerprint: item.fingerprint, legacy_hash: hash,
      snapshot, if_match: row?.written_etag ? t.etag : null, runId, objectIds: [], legacy_uid: null,
    });
    await completeIntent(db, intent.id, { etag: t.etag, runId, adopted: true });
    return unchanged('adopt', t.etag);
  };

  // 1. Intento pendente di un tentativo interrotto.
  if (row?.intent_op) {
    const t = await readOnce();
    if (t && t.fingerprint !== null && t.fingerprint === row.intent_fingerprint) {
      await completeIntent(db, row.id, { etag: t.etag, runId, adopted: true });
      return unchanged('adopt', t.etag);
    }
    // Mai applicato: risorsa assente (per un update sparita: lo dice il passo 3) o con il contenuto dell'ultima scrittura.
    const neverApplied = !t || (row.intent_op !== 'create' && row.written_fingerprint !== null && t.fingerprint === row.written_fingerprint);
    if (!neverApplied) return conflict('UNTRACKED_TARGET', t?.etag ?? null);
    await clearIntent(db, row.id);
    row = { ...row, intent_op: null, intent_fingerprint: null, intent_legacy_hash: null, intent_snapshot: null, intent_etag: null, intent_at: null, intent_run_id: null };
  }

  const revalidate = row?.revalidate_reason ? 'REVALIDATION_REQUIRED' as const : null;

  // 2. Nessuna scrittura precedente (riga assente, o rimasta senza scritture dopo un intento azzerato).
  if (!row?.written_etag) {
    const t = await readOnce();
    if (t) return t.fingerprint === item.fingerprint ? adopt(t) : conflict(revalidate ?? 'UNTRACKED_TARGET', t.etag);
    if (revalidate) return conflict(revalidate, null);
    return writeArchiveItem({ ...opts, row, path, key, snapshot, hash, op: 'create', ifMatch: null });
  }

  // 3. Già scritta.
  if (opts.targetEtag === undefined) return conflict(revalidate ?? 'DELETED_IN_TARGET', null);
  const sourceChanged = row.legacy_hash !== hash;
  if (opts.targetEtag === row.written_etag && !sourceChanged) {
    if (!revalidate) return unchanged('noop', row.written_etag);
    const t = await readOnce();
    if (!t) return conflict(revalidate, null);
    return t.fingerprint === row.written_fingerprint || t.fingerprint === item.fingerprint ? adopt(t) : conflict(revalidate, t.etag);
  }
  const t = await readOnce();
  if (!t) return conflict(revalidate ?? 'DELETED_IN_TARGET', null);
  if (t.fingerprint !== null && t.fingerprint === item.fingerprint) return adopt(t);
  const targetChanged = t.etag !== row.written_etag && (t.fingerprint === null || t.fingerprint !== row.written_fingerprint);
  if (targetChanged) return conflict(sourceChanged ? 'BOTH_CHANGED' : 'TARGET_NEWER', t.etag);
  if (!sourceChanged) return adopt(t);
  if (revalidate) return conflict(revalidate, t.etag);
  return writeArchiveItem({ ...opts, row, path, key, snapshot, hash, op: 'update', ifMatch: t.etag });
}

/** PUT di un item dell'archivio con la riga d'intento committata prima (create con If-None-Match: *, update con If-Match). */
async function writeArchiveItem(opts: {
  db: Db;
  client: RadicaleClient;
  calendarId: string;
  item: ArchiveItem;
  row: LedgerRow | undefined;
  path: string;
  key: LegacyKey;
  snapshot: ArchiveSnapshot;
  hash: string;
  op: 'create' | 'update';
  ifMatch: string | null;
  runId: string;
  throttle: () => Promise<void>;
}): Promise<ArchiveItemResult> {
  const { db, client, item, path, runId } = opts;
  if (opts.op === 'update' && !opts.ifMatch) return conflict('TARGET_NEWER', null);
  const intent = await recordIntent(db, {
    ledgerId: opts.row?.id ?? null, calendar_id: opts.calendarId, collection_name: ARCHIVE_COLLECTION_NAME, href: item.href, kind: 'archive',
    legacy_key: opts.key, legacy_event_id: null, uid: item.uid, op: opts.op, fingerprint: item.fingerprint, legacy_hash: opts.hash,
    snapshot: opts.snapshot, if_match: opts.ifMatch, runId, objectIds: [], legacy_uid: null,
  });
  await opts.throttle();
  try {
    const put = await client.put(path, item.ics, opts.op === 'create' ? { ifNoneMatch: '*' } : { ifMatch: opts.ifMatch as string });
    let etag = put.etag;
    if (!etag) etag = (await client.readProps(path, [DAV_PROPS.getetag]))?.[clark(DAV_PROPS.getetag)]?.trim() ?? null;
    await completeIntent(db, intent.id, { etag, runId });
    return { outcome: opts.op === 'create' ? 'imported' : 'updated', action: opts.op, code: null, etag, http_status: put.created ? 201 : 204, error: null };
  } catch (err) {
    if (isRadicaleError(err, 'precondition_failed')) {
      // 412: creata nel frattempo (adozione con lo stesso contenuto) o cambiata dopo la lettura.
      const t = await readTarget(client, path);
      if (t && t.fingerprint !== null && t.fingerprint === item.fingerprint) {
        await completeIntent(db, intent.id, { etag: t.etag, runId, adopted: true });
        return unchanged('adopt', t.etag);
      }
      await clearIntent(db, intent.id);
      return conflict(opts.op === 'create' ? 'UNTRACKED_TARGET' : 'TARGET_NEWER', t?.etag ?? null);
    }
    if (isRadicaleError(err, 'uid_conflict')) {
      await clearIntent(db, intent.id);
      return conflict('UID_AT_OTHER_HREF', null);
    }
    const e = err as RadicaleError;
    // Rifiuto certo: l'intento si azzera. Esito sconosciuto (rete, timeout): resta pendente e lo risolve la prossima esecuzione.
    if (isRadicaleError(err) && !e.outcomeUnknown && !e.transient) await clearIntent(db, intent.id);
    return { outcome: 'failed', action: opts.op, code: null, etag: null, http_status: isRadicaleError(err) ? e.status ?? null : null, error: describeRadicaleError(err) };
  }
}

/** Esito dell'archivio con i conteggi in più (conflitti, fallimenti) rispetto al riassunto del contratto. */
export interface ArchiveRunSummary extends ArchiveSummary {
  /** Item già importati con un contenuto diverso nella sorgente, riscritti con If-Match (destinazione invariata). */
  updated: number;
  conflicts: number;
  failed: number;
  skipped_entries: number;
}

async function validateUpload(params: ArchiveParams | undefined): Promise<{ path: string; buf: Buffer }> {
  if (!params || typeof params.upload_path !== 'string' || !params.upload_path || typeof params.upload_sha256 !== 'string') {
    throw new MigrationError('VALIDATION_FAILED', 'Parametri dell\'archivio incompleti');
  }
  const path = resolve(params.upload_path);
  if (!isAbsolute(params.upload_path) || !acceptedUploadDirs().some((dir) => insideDir(path, dir))) {
    throw new MigrationError('VALIDATION_FAILED', 'File dell\'archivio fuori dalla cartella dei caricamenti della migrazione', { run_error_code: 'ARCHIVE_INVALID' });
  }
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new MigrationError('PRECONDITION_FAILED', 'File dell\'archivio non trovato (scaduto o già importato): ricaricalo.', { reasons: [], run_error_code: 'ARCHIVE_INVALID' });
  }
  if (!info.isFile()) throw new MigrationError('VALIDATION_FAILED', 'Il file dell\'archivio non è un file regolare', { run_error_code: 'ARCHIVE_INVALID' });
  if (info.size > MIGRATION_LIMITS.archiveMaxBytes) throw new MigrationError('PAYLOAD_TOO_LARGE', `Archivio oltre ${MIGRATION_LIMITS.archiveMaxBytes} byte`, { run_error_code: 'ARCHIVE_INVALID' });
  const buf = await readFile(path);
  if (sha256Hex(buf) !== params.upload_sha256.toLowerCase()) {
    throw new MigrationError('VALIDATION_FAILED', 'Il file dell\'archivio non corrisponde a quello caricato (sha256 diverso)', { run_error_code: 'ARCHIVE_INVALID' });
  }
  return { path, buf };
}

async function removeUpload(path: string | null): Promise<void> {
  if (!path) return;
  await unlink(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') log.warn({ err: err.code }, 'file caricato dell\'archivio non rimosso (lo rimuove la retention)');
  });
}

/** Archivio della Fase 0 (§12). */
export async function runArchiveImport(ctx: MigrationRunContext<ArchiveParams>): Promise<ArchiveSummary> {
  const { client, principal } = requireRadicale();
  let uploadPath: string | null = null;
  let removeAtEnd = false;
  try {
    let upload: { path: string; buf: Buffer };
    try {
      upload = await validateUpload(ctx.params);
    } catch (err) {
      // File non valido (sha256, dimensione, tipo): una ripresa non lo correggerebbe, si rimuove.
      // Mai fuori dalle cartelle dei caricamenti della migrazione.
      const candidate = typeof ctx.params?.upload_path === 'string' ? resolve(ctx.params.upload_path) : null;
      if (err instanceof MigrationError && err.details?.run_error_code === 'ARCHIVE_INVALID' && candidate
        && acceptedUploadDirs().some((dir) => insideDir(candidate, dir))) {
        uploadPath = candidate;
        removeAtEnd = true;
      }
      throw err;
    }
    uploadPath = upload.path;
    ctx.throwIfCancelled();
    await ctx.progress({ phase: 'read-archive', message: 'Lettura dell\'archivio' });

    const now = new Date();
    let parsed: { items: ArchiveItem[]; rejected: ArchiveRejected[] };
    try {
      parsed = readArchiveItems(upload.buf, ctx.params.original_name || basename(upload.path), now);
    } catch (err) {
      removeAtEnd = true;
      if (err instanceof ArchiveFormatError) throw new MigrationError('VALIDATION_FAILED', `Archivio non valido: ${err.message}`, { run_error_code: 'ARCHIVE_INVALID' });
      throw err;
    }
    const total = parsed.items.length + parsed.rejected.length;
    if (total === 0) {
      removeAtEnd = true;
      throw new MigrationError('VALIDATION_FAILED', 'Archivio vuoto: nessun item .ics trovato', { run_error_code: 'ARCHIVE_INVALID' });
    }

    const guard = await createIdentityGuard({ db: ctx.db, client, principal });
    ctx.throwIfCancelled();
    await ctx.progress({ phase: 'collection', message: `Collezione ${ARCHIVE_COLLECTION_NAME}` });
    const calendar = await ensureArchiveCalendar(ctx.db);
    await guard.recheck({ force: true });
    const [spec] = await collectionSpecs(ctx.db, [{ calendar_id: calendar.id, collection_name: ARCHIVE_COLLECTION_NAME, kind: 'archive', role: 'user' }]);
    if (!spec) throw new MigrationError('INTERNAL', 'riga dell\'archivio non trovata dopo la creazione');
    const provisioning = await provisionCollection(client, principal, spec);
    if (provisioning.status === 'conflict') {
      throw new MigrationError('PRECONDITION_FAILED', `La collezione ${ARCHIVE_COLLECTION_NAME} esiste già con un'altra calendar-id (${provisioning.detail ?? ''}): non viene toccata.`, {
        reasons: ['COLLECTIONS_MISSING'], run_error_code: 'ARCHIVE_INVALID',
      });
    }

    // Ledger e destinazione letti una volta: la seconda esecuzione non fa richieste per gli item già importati.
    const ledgerRows = await readLedger(ctx.db, { calendarIds: [calendar.id] });
    const byKey = new Map(ledgerRows.filter((r) => !r.deleted_at).map((r) => [r.legacy_key, r]));
    const byUid = new Map(ledgerRows.filter((r) => !r.deleted_at && r.uid).map((r) => [r.uid as string, r]));
    const etags = (await readCollectionEtags(client, principal, ARCHIVE_COLLECTION_NAME)) ?? new Map<string, string | null>();
    const throttle = migrationThrottle();

    const objectItems: MigrationItemInput[] = [];
    const anomalyItems: MigrationItemInput[] = parsed.rejected.map((r) => ({
      item_type: 'anomaly' as const,
      calendar_id: calendar.id,
      collection_name: ARCHIVE_COLLECTION_NAME,
      legacy_key: legacyKey('archive', r.source_name.slice(0, 480)),
      code: r.code,
      severity: r.reason === 'invalid' ? 'warning' as const : 'info' as const,
      detail: { source_name: r.source_name, reason: r.reason, message: r.message, uid: r.uid ?? null },
    }));
    const counts = { imported: 0, updated: 0, unchanged: 0, conflicts: 0, failed: 0, duplicates: parsed.rejected.filter((r) => r.reason === 'duplicate').length };

    let done = 0;
    for (const item of parsed.items) {
      ctx.throwIfCancelled();
      await guard.recheck();
      const key = legacyKey('archive', item.source_name);
      if (Buffer.byteLength(key, 'utf8') > 512) {
        anomalyItems.push({ item_type: 'anomaly', calendar_id: calendar.id, collection_name: ARCHIVE_COLLECTION_NAME, code: 'INVALID_OBJECT', severity: 'warning', detail: { source_name: item.source_name.slice(0, 200), reason: 'invalid', message: 'nome originale troppo lungo' } });
        continue;
      }
      const sameUid = byUid.get(item.uid);
      if (sameUid && sameUid.legacy_key !== key) {
        counts.duplicates++;
        anomalyItems.push({
          item_type: 'anomaly', calendar_id: calendar.id, collection_name: ARCHIVE_COLLECTION_NAME, legacy_key: key, code: 'POSSIBLE_DUPLICATE', severity: 'info',
          detail: { source_name: item.source_name, reason: 'duplicate', message: `UID già importato come ${sameUid.legacy_key}`, uid: item.uid },
        });
        continue;
      }
      const result = await importArchiveItem({
        db: ctx.db, client, principal, calendarId: calendar.id, item,
        ledger: byKey.get(key), targetEtag: etags.has(item.href) ? etags.get(item.href) ?? null : undefined,
        runId: ctx.runId, throttle,
      });
      if (result.outcome === 'imported') counts.imported++;
      else if (result.outcome === 'updated') counts.updated++;
      else if (result.outcome === 'unchanged') counts.unchanged++;
      else if (result.outcome === 'conflict') counts.conflicts++;
      else counts.failed++;
      objectItems.push({
        item_type: 'object',
        calendar_id: calendar.id,
        collection_name: ARCHIVE_COLLECTION_NAME,
        href: item.href,
        legacy_key: key,
        action: result.action,
        outcome: result.outcome === 'imported' || result.outcome === 'updated' ? 'done' : result.outcome === 'unchanged' ? (result.action === 'adopt' ? 'adopted' : 'noop') : result.outcome,
        code: result.code,
        severity: result.outcome === 'failed' || result.outcome === 'conflict' ? 'warning' : 'info',
        detail: { kind: 'archive', uid: item.uid, source_name: item.source_name, planned_fingerprint: item.fingerprint, etag_after: result.etag, http_status: result.http_status, error: result.error },
      });
      done++;
      if (done % 25 === 0 || done === parsed.items.length) {
        await ctx.progress({ phase: 'write', done, total: parsed.items.length, calendar_id: calendar.id, message: `Import in ${ARCHIVE_COLLECTION_NAME}` });
      }
    }

    const all = [...anomalyItems, ...objectItems];
    for (let i = 0; i < all.length; i += 500) await ctx.addItems(all.slice(i, i + 500));

    const summary: ArchiveRunSummary = {
      calendar_id: calendar.id,
      collection_name: ARCHIVE_COLLECTION_NAME,
      created_collection: provisioning.status === 'created',
      total,
      imported: counts.imported,
      updated: counts.updated,
      unchanged: counts.unchanged,
      invalid: parsed.rejected.filter((r) => r.reason === 'invalid').length,
      duplicates: counts.duplicates,
      conflicts: counts.conflicts,
      failed: counts.failed,
      skipped_entries: parsed.rejected.length,
    };
    if (counts.failed === 0 && counts.conflicts === 0) {
      await writePhase0Archived(ctx.db, ctx.runId, ctx.actor, summary);
      removeAtEnd = true;
    }
    ctx.log.info({ ...summary }, 'archivio della Fase 0 importato');
    return summary;
  } catch (err) {
    if (err instanceof MigrationError && err.code === 'CANCELLED') removeAtEnd = true;
    throw err;
  } finally {
    if (removeAtEnd) await removeUpload(uploadPath);
  }
}

/** Dichiarazione phase0 = archived dopo un archivio riuscito (contratto §1.2: INIT scrive solo questa). */
async function writePhase0Archived(db: Db, runId: string, actor: string, summary: ArchiveRunSummary): Promise<void> {
  const declaration = {
    value: { status: 'archived', archive_run_id: runId, note: `${summary.imported + summary.updated + summary.unchanged} item nell'archivio ${ARCHIVE_COLLECTION_NAME}` },
    at: new Date().toISOString(),
    by: actor,
  };
  await db`
    UPDATE calendar_backend_state
    SET migration_declarations = migration_declarations || jsonb_build_object('phase0', ${db.json(declaration)}::jsonb)
    WHERE id = true
  `;
}

/** Percorso di un file caricato per l'archivio nella cartella della migrazione (per le route). */
export function uploadPathFor(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(name)) throw new TypeError('nome del file caricato non valido');
  return join(migrationUploadDir(env), name);
}
