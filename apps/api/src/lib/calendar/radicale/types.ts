/**
 * Control-plane fra API e Radicale (fase F1 del passaggio a Radicale): stato
 * del backend, policy dei device, heartbeat dell'API e identità del volume.
 *
 * Fonte normativa: docs/calendar-radicale/contracts/control-plane.md e gli
 * schemi accanto (policy.schema.json, heartbeat.schema.json,
 * volume-identity.schema.json). I plugin di Radicale (caldes_rights e
 * caldes_auth) leggono gli stessi file con le stesse regole: una modifica va
 * fatta prima nel contratto, poi qui e nei plugin, con i casi condivisi in
 * docs/calendar-radicale/contracts/fixtures/.
 *
 * Il modulo è puro: niente I/O, niente database, niente orologio implicito
 * (l'istante corrente è sempre un argomento). Il writer della policy, il
 * riconciliatore al boot e l'auditor derivano la policy SOLO da
 * policyFromState(), così nessuno può scrivere 'live' mentre lo stato dice
 * altro (design §13.1).
 */

import { posix as pathPosix } from 'node:path';

// ─── Costanti del contratto ─────────────────────────────────

/** Versione del formato di policy.json e heartbeat.json. */
export const CONTROL_PLANE_SCHEMA = 1 as const;

/** Namespace XML delle dead prop dell'applicazione. */
export const CALDES_NAMESPACE = 'urn:calicchia:caldes' as const;

/**
 * Chiavi delle dead prop nei file `.Radicale.props`: Radicale abbrevia solo i
 * namespace noti (D:, C:, ICAL:...), quindi le nostre restano in notazione
 * Clark. I valori sono sempre stringhe.
 */
export const DEAD_PROP = {
  /** Sul principal: UUID del volume. */
  volumeId: '{urn:calicchia:caldes}volume-id',
  /** Sul principal: epoch decimale ≥ 1. */
  epoch: '{urn:calicchia:caldes}epoch',
  /** Su ogni collezione del sidecar: calendars.id. */
  calendarId: '{urn:calicchia:caldes}calendar-id',
  /** Su ogni collezione del sidecar: calendars.role. */
  role: '{urn:calicchia:caldes}role',
} as const;

/** Nomi dei file sul volume caldes_control. */
export const CONTROL_FILES = { policy: 'policy.json', heartbeat: 'heartbeat.json' } as const;

/** Mount di caldes_control nel container dell'API (scrittura). */
export const API_CONTROL_DIR_DEFAULT = '/run/caldes-control';
/** Mount di caldes_control nel container di Radicale (sola lettura). */
export const RADICALE_CONTROL_DIR_DEFAULT = '/control';
/** Sottocartella delle collezioni dentro `filesystem_folder` di Radicale. */
export const RADICALE_COLLECTION_ROOT = 'collection-root';
/** File delle proprietà di una collezione (e del principal). */
export const RADICALE_PROPS_FILE = '.Radicale.props';
/** Dimensione massima di policy.json e heartbeat.json: oltre, il file è invalido. */
export const CONTROL_FILE_MAX_BYTES = 65_536;

/** Ogni quanto l'API riscrive heartbeat.json (e riconcilia policy.json). */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Oltre questa età il heartbeat è scaduto e i device passano in frozen. */
export const HEARTBEAT_STALE_AFTER_MS = 600_000;
/** Tolleranza per un heartbeat con ts nel futuro (stesso host, stesso orologio). */
export const HEARTBEAT_MAX_FUTURE_SKEW_MS = 60_000;
/** I lettori ricontrollano policy, heartbeat e props al massimo una volta al secondo. */
export const CONTROL_RELOAD_MIN_INTERVAL_MS = 1_000;

/** Principal canonico: qualsiasi app-password valida autentica come questo utente. */
export const DEFAULT_PRINCIPAL = 'federico';
/** Prefisso riservato agli utenti di servizio: mai nel ramo device. */
export const RESERVED_USERNAME_PREFIX = 'caldes-';
/** Utente di servizio dell'API (solo dal peer di CALDES_SVC_CIDR). */
export const SERVICE_USER = 'caldes-svc';
/** Utente del probe e dell'healthcheck (CALDES_SVC_CIDR o 127.0.0.1). */
export const PROBE_USER = 'caldes-probe';
/** Collezione del canary: sempre nascosta ai device, scrivibile dal probe solo in live. */
export const CANARY_COLLECTION = '_canary';
/** Prefisso delle collezioni di sistema: sempre nascoste ai device. */
export const SYSTEM_COLLECTION_PREFIX = '_';

/** Modalità del backend (calendar_backend_state.mode, design §13.1). */
export const BACKEND_MODES = ['postgres', 'cutover', 'radicale', 'rollback', 'finalized'] as const;
export type BackendMode = (typeof BACKEND_MODES)[number];

/** Modalità dei device scritta nella policy. */
export const POLICY_MODES = ['shadow', 'live', 'frozen'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

/** Modalità base dei device per ogni modalità del backend (design §13.1). */
export const BASE_POLICY_MODE: Readonly<Record<BackendMode, PolicyMode>> = Object.freeze({
  postgres: 'shadow',
  cutover: 'frozen',
  radicale: 'live',
  rollback: 'frozen',
  finalized: 'live',
});

/** Ruoli del sidecar (calendars.role). */
export const CALENDAR_ROLES = ['user', 'bookings', 'holidays', 'deadlines', 'subscription', 'tasks'] as const;
export type CalendarRole = (typeof CALENDAR_ROLES)[number];

/** Ruoli in sola lettura per i device (matrice del design §3.4). */
export const DEVICE_READONLY_ROLES: readonly CalendarRole[] = Object.freeze([
  'bookings',
  'holidays',
  'deadlines',
  'subscription',
]);

/** Ciclo di vita della riga del sidecar (calendars.lifecycle). */
export const CALENDAR_LIFECYCLES = ['creating', 'active', 'deleting'] as const;
export type CalendarLifecycle = (typeof CALENDAR_LIFECYCLES)[number];

/** Chi ha creato la riga del sidecar (calendars.origin). */
export const CALENDAR_ORIGINS = ['admin', 'device', 'system', 'migration'] as const;
export type CalendarOrigin = (typeof CALENDAR_ORIGINS)[number];

/**
 * Esito del controllo d'identità del volume dal lato API:
 * - `uninitialized`: in PG nessun volume (epoch 0), qualunque cosa ci sia sul volume;
 * - `ok`: le dead prop del principal coincidono con volume_id ed epoch di PG;
 * - `mismatch`: PG ha un volume ma il marker manca o è diverso;
 * - `unverified`: PG ha un volume ma il controllo non è stato possibile (non
 *   ancora eseguito, mount assente, Radicale irraggiungibile in remote mode).
 */
export const IDENTITY_STATUSES = ['ok', 'uninitialized', 'mismatch', 'unverified'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/**
 * Condizioni che forzano la policy a frozen, nell'ordine fisso in cui
 * compaiono in `reasons` (contratto §6.2).
 */
export const POLICY_REASONS = [
  'write_freeze',
  'restore_guard',
  'rebuild_required',
  'identity_uninitialized',
  'identity_mismatch',
  'identity_unverified',
] as const;
export type PolicyReason = (typeof POLICY_REASONS)[number];

/** Motivi per cui la modalità effettiva dei device è diversa da quella della policy (lato rights). */
export const EFFECTIVE_MODE_REASONS = [
  'policy_missing',
  'policy_invalid',
  'heartbeat_missing',
  'heartbeat_invalid',
  'heartbeat_stale',
  'heartbeat_future',
  'heartbeat_epoch_mismatch',
  'heartbeat_mode_mismatch',
] as const;
export type EffectiveModeReason = (typeof EFFECTIVE_MODE_REASONS)[number];

// ─── Tipi ───────────────────────────────────────────────────

/**
 * Riga di calendar_backend_state (migrazione 162; la 165 aggiunge le colonne
 * di shadow, cutover, rollback, finalize e orizzonte). Solo i campi da cui
 * dipendono policy e heartbeat.
 */
export interface CalendarBackendState {
  mode: BackendMode;
  write_freeze: boolean;
  /** UUID minuscolo, null finché il volume non è inizializzato. */
  volume_id: string | null;
  /** 0 = non inizializzato, altrimenti ≥ 1. */
  epoch: number;
  credential_epoch: number;
  /** Gestito dal trigger della 162: cresce a ogni cambio delle colonne sopra. */
  policy_version: number;
  restore_guard_until: Date | null;
  rebuild_required: boolean;
}

/** Stato di un database appena migrato (anche il default della riga singleton). */
export const DEFAULT_BACKEND_STATE: Readonly<CalendarBackendState> = Object.freeze({
  mode: 'postgres',
  write_freeze: false,
  volume_id: null,
  epoch: 0,
  credential_epoch: 0,
  policy_version: 1,
  restore_guard_until: null,
  rebuild_required: false,
});

/** Le colonne del sidecar da cui dipendono readonly e hidden. */
export interface SidecarCollection {
  collection_name: string | null;
  role: CalendarRole;
  lifecycle: CalendarLifecycle;
  device_visible: boolean;
}

/** Ingressi di policyFromState(). */
export interface PolicyInput {
  state: CalendarBackendState;
  /** Esito del controllo d'identità lato API (vedi IdentityStatus). */
  identity: IdentityStatus;
  /** Tutte le righe del sidecar (calendars). */
  collections: readonly SidecarCollection[];
  /** RADICALE_PRINCIPAL. */
  principal: string;
  /** Istante corrente (per restore_guard_until e generated_at). */
  now: Date;
}

/** Contenuto di policy.json (schema 1, policy.schema.json). */
export interface CaldesPolicy {
  schema: typeof CONTROL_PLANE_SCHEMA;
  version: number;
  generated_at: string;
  backend_mode: BackendMode;
  mode: PolicyMode;
  reasons: PolicyReason[];
  principal: string;
  volume_id: string | null;
  epoch: number;
  credential_epoch: number;
  readonly: string[];
  hidden: string[];
}

/** Contenuto di heartbeat.json (schema 1, heartbeat.schema.json). */
export interface CaldesHeartbeat {
  schema: typeof CONTROL_PLANE_SCHEMA;
  api_version: string;
  mode: BackendMode;
  epoch: number;
  ts: string;
}

/** Marker d'identità letto dalle dead prop del principal. */
export interface VolumeMarker {
  volume_id: string;
  epoch: number;
}

/** Esito della lettura di un file del control-plane, come lo vedono i lettori. */
export type ControlFileRead<T> =
  | { state: 'ok'; value: T }
  | { state: 'missing' }
  | { state: 'invalid'; error: string };

/** Modalità effettiva dei device (mirror della valutazione di caldes_rights, contratto §7.3). */
export interface EffectiveDeviceMode {
  mode: PolicyMode;
  reasons: EffectiveModeReason[];
  /** Identità di riferimento per il controllo sul principal (null: nessun device sotto il principal). */
  volume_id: string | null;
  epoch: number;
  readonly: string[];
  hidden: string[];
}

/** Errore di formato di un file o di un valore del control-plane. */
export class ControlPlaneFormatError extends Error {
  readonly code = 'CONTROL_PLANE_FORMAT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ControlPlaneFormatError';
  }
}

// ─── Validazione dei nomi ──────────────────────────────────

const UUID_LOWER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_ANYCASE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINCIPAL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// '/', '\', controlli C0, DEL e C1: stessi intervalli della 162.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_SEGMENT_CHARS_RE = /[/\\\u0000-\u001f\u007f-\u009f]/;
const ISO_MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const API_VERSION_RE = /^[\x21-\x7e]{1,64}$/;
const MARKER_EPOCH_RE = /^[1-9][0-9]{0,9}$/;
const MAX_INT32 = 2_147_483_647;

/** Lunghezza in byte UTF-8, senza dipendere da Buffer. */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Segmento di path sotto il principal ammesso nella policy (readonly e
 * hidden): 1-255 byte UTF-8, niente '/', '\' né caratteri di controllo, non
 * inizia con '.'. Il prefisso '_' è ammesso (collezioni di sistema).
 */
export function isValidPathSegment(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (FORBIDDEN_SEGMENT_CHARS_RE.test(name) || name.startsWith('.')) return false;
  const bytes = utf8Length(name);
  return bytes >= 1 && bytes <= 255;
}

/**
 * Nome di collezione del sidecar: come isValidPathSegment ma senza il
 * prefisso '_' (riservato). Identica a calendar_collection_name_valid() della 162.
 */
export function isValidCollectionName(name: unknown): name is string {
  return isValidPathSegment(name) && !name.startsWith(SYSTEM_COLLECTION_PREFIX);
}

/** Nome del principal canonico: minuscole, cifre, '-' e '_', mai riservato. */
export function isValidPrincipal(name: unknown): name is string {
  return typeof name === 'string' && PRINCIPAL_RE.test(name) && !isReservedUsername(name);
}

/**
 * Username riservato agli utenti di servizio (prefisso `caldes-`, senza
 * distinzione fra maiuscole e minuscole): rifiutato da /api/caldav-tokens
 * (400) e da verify-credentials (401), mai nel ramo device del plugin.
 */
export function isReservedUsername(username: string): boolean {
  return username.toLowerCase().startsWith(RESERVED_USERNAME_PREFIX);
}

// ─── Derivazione della policy ──────────────────────────────

/** Ordina e deduplica (ordinamento di Array.prototype.sort, unità UTF-16). */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Policy dei device derivata dallo stato (design §13.1, contratto §6).
 *
 * - Modalità base da BASE_POLICY_MODE; diventa frozen se vale una delle
 *   condizioni di POLICY_REASONS (write_freeze solo quando la base è live;
 *   identity_uninitialized solo fuori da mode postgres).
 * - readonly: collezioni attive e visibili con ruolo bookings, holidays,
 *   deadlines o subscription.
 * - hidden: sempre _canary, più le collezioni con device_visible=false o
 *   lifecycle diverso da active.
 *
 * Pura e deterministica a parità di ingressi. Lancia ControlPlaneFormatError
 * solo per ingressi impossibili (principal non valido, stato incoerente):
 * sono errori di configurazione o di programmazione, non di runtime.
 */
export function policyFromState(input: PolicyInput): CaldesPolicy {
  const { state, collections, principal, now } = input;
  assertBackendState(state);
  if (!isValidPrincipal(principal)) {
    throw new ControlPlaneFormatError(`principal non valido: ${JSON.stringify(principal)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ControlPlaneFormatError('now non è una data valida');
  }

  // L'identità si normalizza sullo stato: senza volume in PG è sempre
  // "non inizializzato"; con un volume, "non inizializzato" dal lato API è
  // un'incoerenza e vale come non verificato (fail-closed).
  let identity: IdentityStatus = input.identity;
  if (!IDENTITY_STATUSES.includes(identity)) {
    throw new ControlPlaneFormatError(`stato d'identità sconosciuto: ${JSON.stringify(identity)}`);
  }
  if (state.epoch === 0) identity = 'uninitialized';
  else if (identity === 'uninitialized') identity = 'unverified';

  const base = BASE_POLICY_MODE[state.mode];
  const active = new Set<PolicyReason>();
  if (base === 'live' && state.write_freeze) active.add('write_freeze');
  if (state.restore_guard_until && state.restore_guard_until.getTime() > now.getTime()) active.add('restore_guard');
  if (state.rebuild_required) active.add('rebuild_required');
  if (identity === 'uninitialized' && state.mode !== 'postgres') active.add('identity_uninitialized');
  if (identity === 'mismatch') active.add('identity_mismatch');
  if (identity === 'unverified') active.add('identity_unverified');
  const reasons = POLICY_REASONS.filter((r) => active.has(r));

  const hidden = new Set<string>([CANARY_COLLECTION]);
  const readonly = new Set<string>();
  for (const c of collections) {
    if (!isValidCollectionName(c.collection_name)) continue;
    if (c.lifecycle !== 'active' || !c.device_visible) {
      hidden.add(c.collection_name);
    } else if (DEVICE_READONLY_ROLES.includes(c.role)) {
      readonly.add(c.collection_name);
    }
  }
  for (const name of hidden) readonly.delete(name);

  return {
    schema: CONTROL_PLANE_SCHEMA,
    version: state.policy_version,
    generated_at: now.toISOString(),
    backend_mode: state.mode,
    mode: reasons.length > 0 ? 'frozen' : base,
    reasons,
    principal,
    volume_id: state.volume_id === null ? null : state.volume_id.toLowerCase(),
    epoch: state.epoch,
    credential_epoch: state.credential_epoch,
    readonly: sortedUnique(readonly),
    hidden: sortedUnique(hidden),
  };
}

/** Heartbeat dell'API per lo stato letto in questo giro (contratto §7). */
export function heartbeatFromState(state: CalendarBackendState, apiVersion: string, now: Date): CaldesHeartbeat {
  assertBackendState(state);
  if (!API_VERSION_RE.test(apiVersion)) {
    throw new ControlPlaneFormatError(`api_version non valida: ${JSON.stringify(apiVersion)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ControlPlaneFormatError('now non è una data valida');
  }
  return {
    schema: CONTROL_PLANE_SCHEMA,
    api_version: apiVersion,
    mode: state.mode,
    epoch: state.epoch,
    ts: now.toISOString(),
  };
}

/**
 * Serializzazione canonica di policy.json e heartbeat.json: JSON indentato di
 * 2 spazi con le chiavi nell'ordine dei tipi e un a capo finale. Lancia se il
 * risultato supera CONTROL_FILE_MAX_BYTES (i lettori lo rifiuterebbero).
 */
export function serializeControlFile(doc: CaldesPolicy | CaldesHeartbeat): string {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (utf8Length(text) > CONTROL_FILE_MAX_BYTES) {
    throw new ControlPlaneFormatError(`file del control-plane oltre ${CONTROL_FILE_MAX_BYTES} byte`);
  }
  return text;
}

/**
 * Uguaglianza di due policy a meno di generated_at: il writer riscrive
 * policy.json solo se il contenuto cambia (oppure se il file manca o è invalido).
 */
export function samePolicyContent(a: CaldesPolicy, b: CaldesPolicy): boolean {
  const strip = (p: CaldesPolicy): string => JSON.stringify({ ...p, generated_at: '' });
  return strip(a) === strip(b);
}

// ─── Lettura e validazione (stesse regole dei plugin) ──────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown, min: number, max = MAX_INT32): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function fail(what: string, detail: string): never {
  throw new ControlPlaneFormatError(`${what}: ${detail}`);
}

/**
 * Timestamp del contratto: `YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|±HH:MM)` con data e
 * ora reali (niente 30 febbraio né 24:00: Date.parse li farebbe scorrere al
 * giorno dopo, mentre datetime di Python li rifiuta). Restituisce i ms epoch.
 */
function parseTimestamp(value: unknown, what: string, strict: boolean): number {
  if (typeof value !== 'string' || !(strict ? ISO_MS_UTC_RE : RFC3339_RE).test(value)) {
    fail(what, 'timestamp non valido');
  }
  const [y, mo, d, h, mi, s] = [0, 5, 8, 11, 14, 17].map((i, k) => Number(value.slice(i, i + (k === 0 ? 4 : 2))));
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    fail(what, 'timestamp non valido');
  }
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) fail(what, 'timestamp non valido');
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) fail(what, 'timestamp non valido');
  return ms;
}

function parseNameList(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) fail(what, 'non è un array');
  for (const item of value) {
    if (!isValidPathSegment(item)) fail(what, `nome di collezione non valido: ${JSON.stringify(item)}`);
  }
  return sortedUnique(value as string[]);
}

/**
 * Valida una policy già decodificata da JSON con le regole dei lettori
 * (contratto §5.4): campi richiesti e tipi rigorosi, campi sconosciuti
 * ignorati, volume_id normalizzato in minuscolo, liste ordinate e deduplicate.
 * Con `expectedPrincipal` una policy di un altro principal è invalida.
 * Lancia ControlPlaneFormatError.
 */
export function parsePolicy(value: unknown, expectedPrincipal?: string): CaldesPolicy {
  const what = 'policy';
  if (!isRecord(value)) fail(what, 'non è un oggetto JSON');
  if (value.schema !== CONTROL_PLANE_SCHEMA) fail(what, `schema non supportato: ${JSON.stringify(value.schema)}`);
  if (!isInt(value.version, 1)) fail(what, 'version non valida');
  parseTimestamp(value.generated_at, `${what}.generated_at`, false);
  if (!BACKEND_MODES.includes(value.backend_mode as BackendMode)) fail(what, 'backend_mode non valido');
  if (!POLICY_MODES.includes(value.mode as PolicyMode)) fail(what, 'mode non valido');
  if (!Array.isArray(value.reasons) || !value.reasons.every((r) => typeof r === 'string')) {
    fail(what, 'reasons non valido');
  }
  if (!isValidPrincipal(value.principal)) fail(what, 'principal non valido');
  if (expectedPrincipal !== undefined && value.principal !== expectedPrincipal) {
    fail(what, `principal ${JSON.stringify(value.principal)} diverso da quello configurato`);
  }
  if (!(value.volume_id === null || (typeof value.volume_id === 'string' && UUID_ANYCASE_RE.test(value.volume_id)))) {
    fail(what, 'volume_id non valido');
  }
  if (!isInt(value.epoch, 0)) fail(what, 'epoch non valido');
  if ((value.volume_id === null) !== (value.epoch === 0)) fail(what, 'volume_id ed epoch incoerenti');
  if (value.mode === 'live' && value.volume_id === null) fail(what, 'live senza volume');
  if (!isInt(value.credential_epoch, 0)) fail(what, 'credential_epoch non valido');
  const readonly = parseNameList(value.readonly, `${what}.readonly`);
  const hidden = parseNameList(value.hidden, `${what}.hidden`);

  return {
    schema: CONTROL_PLANE_SCHEMA,
    version: value.version,
    generated_at: value.generated_at as string,
    backend_mode: value.backend_mode as BackendMode,
    mode: value.mode as PolicyMode,
    reasons: (value.reasons as string[]).filter((r): r is PolicyReason => POLICY_REASONS.includes(r as PolicyReason)),
    principal: value.principal,
    volume_id: value.volume_id === null ? null : (value.volume_id as string).toLowerCase(),
    epoch: value.epoch,
    credential_epoch: value.credential_epoch,
    readonly,
    hidden,
  };
}

/**
 * Valida un heartbeat già decodificato da JSON con le regole dei lettori
 * (contratto §7.2). L'età NON si valuta qui ma a ogni richiesta
 * (effectiveDeviceMode). Lancia ControlPlaneFormatError.
 */
export function parseHeartbeat(value: unknown): CaldesHeartbeat {
  const what = 'heartbeat';
  if (!isRecord(value)) fail(what, 'non è un oggetto JSON');
  if (value.schema !== CONTROL_PLANE_SCHEMA) fail(what, `schema non supportato: ${JSON.stringify(value.schema)}`);
  if (typeof value.api_version !== 'string' || !API_VERSION_RE.test(value.api_version)) fail(what, 'api_version non valida');
  if (!BACKEND_MODES.includes(value.mode as BackendMode)) fail(what, 'mode non valido');
  if (!isInt(value.epoch, 0)) fail(what, 'epoch non valido');
  parseTimestamp(value.ts, `${what}.ts`, false);
  return {
    schema: CONTROL_PLANE_SCHEMA,
    api_version: value.api_version,
    mode: value.mode as BackendMode,
    epoch: value.epoch,
    ts: value.ts as string,
  };
}

/**
 * Testo di un file del control-plane → oggetto JSON, con il limite di
 * dimensione dei lettori. Lancia ControlPlaneFormatError.
 */
export function decodeControlFile(text: string): unknown {
  if (utf8Length(text) > CONTROL_FILE_MAX_BYTES) fail('file del control-plane', `oltre ${CONTROL_FILE_MAX_BYTES} byte`);
  try {
    return JSON.parse(text);
  } catch {
    return fail('file del control-plane', 'JSON non valido');
  }
}

/**
 * Modalità effettiva dei device, con la stessa valutazione di caldes_rights
 * (contratto §7.3), per la salute e per i test di conformità.
 *
 * - Policy assente o invalida → shadow, con identità e liste dell'ultima
 *   policy valida vista dal processo (`lastKnownGood`), altrimenti nessuna
 *   identità (nessun permesso sotto il principal).
 * - Heartbeat assente, invalido, più vecchio di 600 s, nel futuro di oltre
 *   60 s, con epoch diverso da quello di riferimento o, con policy live, con
 *   mode diverso da radicale/finalized → frozen.
 */
export function effectiveDeviceMode(input: {
  policy: ControlFileRead<CaldesPolicy>;
  heartbeat: ControlFileRead<CaldesHeartbeat>;
  lastKnownGood?: CaldesPolicy | null;
  now: Date;
}): EffectiveDeviceMode {
  const reasons: EffectiveModeReason[] = [];
  const valid = input.policy.state === 'ok' ? input.policy.value : null;
  if (input.policy.state === 'missing') reasons.push('policy_missing');
  if (input.policy.state === 'invalid') reasons.push('policy_invalid');

  const reference = valid ?? input.lastKnownGood ?? null;
  const base: PolicyMode = valid ? valid.mode : 'shadow';
  const epoch = reference?.epoch ?? 0;

  const hb = input.heartbeat;
  if (hb.state === 'missing') reasons.push('heartbeat_missing');
  else if (hb.state === 'invalid') reasons.push('heartbeat_invalid');
  else {
    const age = input.now.getTime() - Date.parse(hb.value.ts);
    if (age > HEARTBEAT_STALE_AFTER_MS) reasons.push('heartbeat_stale');
    if (-age > HEARTBEAT_MAX_FUTURE_SKEW_MS) reasons.push('heartbeat_future');
    if (reference === null || hb.value.epoch !== epoch) reasons.push('heartbeat_epoch_mismatch');
    if (base === 'live' && hb.value.mode !== 'radicale' && hb.value.mode !== 'finalized') {
      reasons.push('heartbeat_mode_mismatch');
    }
  }

  const heartbeatOk = !reasons.some((r) => r.startsWith('heartbeat_'));
  return {
    mode: heartbeatOk ? base : 'frozen',
    reasons,
    volume_id: reference?.volume_id ?? null,
    epoch,
    readonly: reference ? [...reference.readonly] : [],
    hidden: reference ? sortedUnique([...reference.hidden, CANARY_COLLECTION]) : [CANARY_COLLECTION],
  };
}

// ─── Permessi attesi (riferimento di caldes_rights) ────────

/** Contesto della valutazione dei permessi (contratto §8). */
export interface RightsContext {
  /** RADICALE_PRINCIPAL. */
  principal: string;
  /** Modalità effettiva dei device (effectiveDeviceMode().mode). */
  mode: PolicyMode;
  /** Marker del principal uguale all'identità di riferimento (contratto §4.3). */
  identityOk: boolean;
  readonly: readonly string[];
  hidden: readonly string[];
}

/**
 * Permessi che caldes_rights DEVE restituire per `user` sul path già ripulito
 * da Radicale (`''` per la root, `federico/f` per una collezione), con le
 * lettere di Radicale 3.7.8. Riferimento eseguibile della matrice del
 * contratto §8 e del design §3.4: lo usano i test di conformità e il
 * preflight per confrontare le risposte reali con quelle attese.
 */
export function expectedRadicaleRights(user: string, path: string, ctx: RightsContext): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  const depth = segments.length;

  if (user === SERVICE_USER) {
    if (depth === 0) return 'R';
    if (segments[0] !== ctx.principal) return '';
    if (depth === 1) return 'RW';
    return depth === 2 ? 'rwD' : '';
  }

  const isProbe = user === PROBE_USER;
  if (!isProbe && user !== ctx.principal) return '';
  if (depth === 0) return 'R';
  if (segments[0] !== ctx.principal || !ctx.identityOk) return '';
  const live = ctx.mode === 'live';
  if (depth === 1) return live ? 'RW' : 'R';
  if (depth > 2) return '';

  const name = segments[1];
  if (name === CANARY_COLLECTION) return isProbe && live ? 'rw' : '';
  if (name.startsWith(SYSTEM_COLLECTION_PREFIX) || ctx.hidden.includes(name)) return '';
  if (ctx.readonly.includes(name)) return 'r';
  return live ? 'rw' : 'r';
}

// ─── Identità del volume ───────────────────────────────────

/**
 * Marker d'identità dalle props del principal (`.Radicale.props` decodificato):
 * null se manca o non è nel formato del contratto (§4.1).
 */
export function volumeMarkerFromProps(props: unknown): VolumeMarker | null {
  if (!isRecord(props)) return null;
  const volumeId = props[DEAD_PROP.volumeId];
  const epoch = props[DEAD_PROP.epoch];
  if (typeof volumeId !== 'string' || !UUID_ANYCASE_RE.test(volumeId)) return null;
  if (typeof epoch !== 'string' || !MARKER_EPOCH_RE.test(epoch)) return null;
  const n = Number(epoch);
  if (!Number.isSafeInteger(n) || n > MAX_INT32) return null;
  return { volume_id: volumeId.toLowerCase(), epoch: n };
}

/**
 * Confronto fra lo stato in PG e il marker letto dal volume. `marker`
 * undefined vuol dire "lettura non riuscita" (→ unverified); null vuol dire
 * "letto, ma assente o malformato" (→ mismatch).
 */
export function identityStatus(state: Pick<CalendarBackendState, 'volume_id' | 'epoch'>, marker: VolumeMarker | null | undefined): IdentityStatus {
  if (state.epoch === 0 || state.volume_id === null) return 'uninitialized';
  if (marker === undefined) return 'unverified';
  if (marker === null) return 'mismatch';
  return marker.volume_id === state.volume_id.toLowerCase() && marker.epoch === state.epoch ? 'ok' : 'mismatch';
}

/**
 * Percorso del file delle props del principal sotto la cartella delle
 * collezioni (RADICALE_DATA_DIR per l'API, `filesystem_folder` per Radicale).
 */
export function principalPropsPath(collectionsDir: string, principal: string): string {
  if (!isValidPrincipal(principal)) throw new ControlPlaneFormatError(`principal non valido: ${JSON.stringify(principal)}`);
  return pathPosix.join(collectionsDir, RADICALE_COLLECTION_ROOT, principal, RADICALE_PROPS_FILE);
}

/**
 * Corpo della PROPPATCH (come caldes-svc, sul principal) che scrive il marker
 * d'identità: inizializzazione (epoch 1), cutover e rollback (epoch + 1).
 */
export function volumeMarkerProppatchBody(marker: VolumeMarker): string {
  if (!UUID_ANYCASE_RE.test(marker.volume_id)) throw new ControlPlaneFormatError('volume_id non valido');
  if (!isInt(marker.epoch, 1)) throw new ControlPlaneFormatError('epoch non valido (≥ 1)');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<D:propertyupdate xmlns:D="DAV:" xmlns:K="${CALDES_NAMESPACE}">` +
    '<D:set><D:prop>' +
    `<K:volume-id>${marker.volume_id.toLowerCase()}</K:volume-id>` +
    `<K:epoch>${marker.epoch}</K:epoch>` +
    '</D:prop></D:set></D:propertyupdate>'
  );
}

// ─── Stato dal database ────────────────────────────────────

function toDateOrNull(value: unknown, what: string): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) fail(what, 'data non valida');
  return d;
}

function toInt(value: unknown, what: string, min: number): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!isInt(n, min)) fail(what, 'intero non valido');
  return n;
}

/**
 * Riga di calendar_backend_state (come la restituisce postgres-js) →
 * CalendarBackendState validato. Lancia ControlPlaneFormatError: chi legge lo
 * stato tratta l'errore come stato sconosciuto e non scrive una policy nuova.
 */
export function normalizeBackendState(row: Record<string, unknown>): CalendarBackendState {
  const state: CalendarBackendState = {
    mode: row.mode as BackendMode,
    write_freeze: row.write_freeze as boolean,
    volume_id: row.volume_id === null || row.volume_id === undefined ? null : String(row.volume_id).toLowerCase(),
    epoch: toInt(row.epoch, 'calendar_backend_state.epoch', 0),
    credential_epoch: toInt(row.credential_epoch, 'calendar_backend_state.credential_epoch', 0),
    policy_version: toInt(row.policy_version, 'calendar_backend_state.policy_version', 1),
    restore_guard_until: toDateOrNull(row.restore_guard_until, 'calendar_backend_state.restore_guard_until'),
    rebuild_required: row.rebuild_required as boolean,
  };
  assertBackendState(state);
  return state;
}

/** Invarianti di calendar_backend_state (gli stessi CHECK della 162). */
function assertBackendState(state: CalendarBackendState): void {
  const what = 'calendar_backend_state';
  if (!BACKEND_MODES.includes(state.mode)) fail(what, `mode sconosciuto: ${JSON.stringify(state.mode)}`);
  if (typeof state.write_freeze !== 'boolean') fail(what, 'write_freeze non booleano');
  if (typeof state.rebuild_required !== 'boolean') fail(what, 'rebuild_required non booleano');
  if (!isInt(state.epoch, 0)) fail(what, 'epoch non valido');
  if (!isInt(state.credential_epoch, 0)) fail(what, 'credential_epoch non valido');
  if (!isInt(state.policy_version, 1)) fail(what, 'policy_version non valido');
  if (state.volume_id !== null && !UUID_ANYCASE_RE.test(state.volume_id)) fail(what, 'volume_id non valido');
  if ((state.volume_id === null) !== (state.epoch === 0)) fail(what, 'volume_id ed epoch incoerenti');
  if (state.mode !== 'postgres' && state.volume_id === null) fail(what, `mode ${state.mode} senza volume`);
  if (state.restore_guard_until !== null && !(state.restore_guard_until instanceof Date)) {
    fail(what, 'restore_guard_until non è una data');
  }
}

/** true se `value` è un UUID nel formato che il writer mette nella policy (minuscolo). */
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_LOWER_RE.test(value);
}
