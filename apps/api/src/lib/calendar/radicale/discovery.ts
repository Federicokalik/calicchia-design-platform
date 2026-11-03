/**
 * Discovery delle collezioni di Radicale e adozione nel sidecar (fase F2 del
 * passaggio a Radicale; design §6.3, decisione 4; contratto del control-plane
 * §3 e §4.5; contratto dei moduli f2-modules.md §4.4).
 *
 * PROPFIND Depth:1 sul principal con displayname, colore, ordine,
 * descrizione, calendar-timezone, component-set, resourcetype, sync-token e
 * le dead prop {urn:calicchia:caldes}calendar-id e role. Poi, per ogni
 * collezione:
 *  - riga del sidecar con lo stesso collection_name: presente (missing_since
 *    azzerato se era sparita), dav_props aggiornate; una riga `creating` con
 *    la dead prop calendar-id uguale al proprio id e origin diversa da device
 *    viene adottata (lifecycle → active: la MKCALENDAR dello store è riuscita
 *    ma il processo si è fermato prima di confermarla). Una calendar-id
 *    diversa o assente su una riga non device → needs_review
 *    'collection_name_conflict' (mai un'adozione per la sola dead prop: in
 *    live un device può scriverla sulle collezioni che crea);
 *  - collezione senza riga (solo in mode radicale/finalized): riga nuova con
 *    origin=device, role=user (tasks se solo VTODO), blocks_availability=true
 *    (decisione 4), needs_review 'device_new' (badge "nuovo dal dispositivo"),
 *    feed disattivato, collection_name = nome esatto, slug derivato e univoco,
 *    più la riga di stato dell'indice;
 *  - riga attiva senza collezione: missing_since e alert, MAI una
 *    cancellazione (l'indice tiene le occorrenze finché l'admin non decide).
 *
 * Dead prop come dati non fidati (contratto control-plane §4.5): le
 * `urn:calicchia:caldes` di una collezione scrivibile dai device (ruolo non in
 * sola lettura, o origin device) non entrano mai in dav_props.
 *
 * In mode postgres e cutover la discovery non scrive mai su `calendars`
 * (contratto f2-modules §1.5: listCalendars legacy mostrerebbe le righe):
 * collezioni senza riga in `unknown`, righe senza collezione in `missing`,
 * solo per la salute. Con identità del volume diversa da `ok` nessuna PROPFIND
 * e nessuna scrittura. Le collezioni di sistema (`_*`, es. `_canary`) sono
 * ignorate. Tutto sul pool calendario: la discovery può girare dentro la
 * freshness di una prenotazione, che tiene una connessione del pool principale.
 */

import { customAlphabet } from 'nanoid';
import type { Logger } from 'pino';
import { calSql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { CalendarUnavailableError } from '../errors';
import { CALENDAR_SLUG_REGEX, isValidTimeZone } from '../validation';
import { principalPath, type RadicaleClient } from './client';
import { clark, DAV_PROPS, type DavPropName, type DavResponseEntry, NS } from './dav-xml';
import { raiseIndexAlert } from './health';
import type { Db } from './policy';
import { principalDirPath, radicaleRuntime, statMtimeNs, verifyVolumeIdentity } from './sync';
import { CALDES_NAMESPACE, type CalendarRole, DEVICE_READONLY_ROLES, type IdentityStatus, isValidCollectionName, SYSTEM_COLLECTION_PREFIX } from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-discovery' });

// ─── Tipi del contratto (f2-modules §4.4) ───────────────────

export interface DiscoveredCollection {
  /** Nome della collezione (segmento di path, decodificato). */
  name: string;
  /** href come restituito da Radicale. */
  href: string;
  isCalendar: boolean;
  displayName: string | null;
  /** Colore normalizzato `#rrggbb` (null se assente o non valido). */
  color: string | null;
  order: number | null;
  description: string | null;
  /** TZID IANA del calendar-timezone (null se assente o non IANA). */
  timezone: string | null;
  /** Componenti di supported-calendar-component-set (es. ['VEVENT']). */
  components: string[];
  syncToken: string | null;
  /** Proprietà testuali lette (notazione di Clark), dead prop comprese. */
  davProps: Record<string, string>;
}

export interface DiscoveryResult {
  identity: IdentityStatus;
  collections: DiscoveredCollection[];
  /** Righe `creating` adottate per dead prop (→ active). */
  adopted: string[];
  /** Righe nuove create per collezioni nate da un device. */
  created: string[];
  /** Righe con dav_props aggiornate. */
  updated: string[];
  /** Righe attive senza collezione su Radicale. */
  missing: string[];
  /** Righe che erano sparite e sono ricomparse. */
  reappeared: string[];
  /** Collezioni senza riga non adottate (mode postgres/cutover) o non calendari. */
  unknown: string[];
}

// ─── PROPFIND ───────────────────

const DISCOVERY_PROPS: readonly DavPropName[] = [
  DAV_PROPS.displayname,
  DAV_PROPS.calendarColor,
  DAV_PROPS.calendarOrder,
  DAV_PROPS.calendarDescription,
  DAV_PROPS.calendarTimezone,
  DAV_PROPS.supportedComponents,
  DAV_PROPS.resourcetype,
  DAV_PROPS.syncToken,
  DAV_PROPS.calendarId,
  DAV_PROPS.role,
];

/** Proprietà copiate in calendars.dav_props (testo breve, niente VTIMEZONE né token). */
const MIRRORED_PROPS: readonly DavPropName[] = [
  DAV_PROPS.displayname,
  DAV_PROPS.calendarColor,
  DAV_PROPS.calendarOrder,
  DAV_PROPS.calendarDescription,
  DAV_PROPS.calendarId,
  DAV_PROPS.role,
];

const COMPONENTS = new Set(['VEVENT', 'VTODO', 'VJOURNAL']);
/** Limite per valore copiato in dav_props. */
const MAX_PROP_VALUE = 2_000;

/** `#RRGGBB` o `#RRGGBBAA` (Apple) → `#rrggbb`; altrimenti null. */
export function normalizeColor(value: string | null | undefined): string | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value?.trim() ?? '');
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** TZID IANA dal calendar-timezone (VCALENDAR con un VTIMEZONE). */
function tzidOf(vcalendar: string | null): string | null {
  if (!vcalendar) return null;
  const m = /(?:^|\n)TZID:([^\r\n]+)/.exec(vcalendar.replace(/\r\n[ \t]/g, ''));
  const tzid = m?.[1]?.trim() ?? null;
  return tzid && isValidTimeZone(tzid) ? tzid : null;
}

function parseCollection(entry: DavResponseEntry): DiscoveredCollection {
  const resourcetype = entry.element(DAV_PROPS.resourcetype);
  const isCalendar = !!resourcetype?.children.some((c) => c.ns === NS.CALDAV && c.name === 'calendar');
  const componentSet = entry.element(DAV_PROPS.supportedComponents);
  const components = (componentSet?.children ?? [])
    .filter((c) => c.ns === NS.CALDAV && c.name === 'comp')
    .map((c) => (c.attrs.name ?? '').toUpperCase())
    .filter((c) => COMPONENTS.has(c));
  const text = (p: DavPropName): string | null => {
    const v = entry.text(p);
    return v === null ? null : v.trim();
  };
  const orderText = text(DAV_PROPS.calendarOrder);
  const order = orderText !== null && /^-?\d{1,9}$/.test(orderText) ? Number(orderText) : null;
  const davProps: Record<string, string> = {};
  for (const p of MIRRORED_PROPS) {
    const v = text(p);
    if (v !== null && v !== '') davProps[clark(p)] = v.slice(0, MAX_PROP_VALUE);
  }
  return {
    name: entry.name,
    href: entry.href,
    isCalendar,
    displayName: text(DAV_PROPS.displayname) || null,
    color: normalizeColor(text(DAV_PROPS.calendarColor)),
    order,
    description: text(DAV_PROPS.calendarDescription) || null,
    timezone: tzidOf(entry.text(DAV_PROPS.calendarTimezone)),
    components: [...new Set(components)],
    syncToken: text(DAV_PROPS.syncToken) || null,
    davProps,
  };
}

/**
 * Collezioni sotto il principal (PROPFIND Depth:1, solo lettura): tutte,
 * comprese quelle di sistema e quelle che non sono calendari. Lancia gli
 * errori tipizzati del client (404 se il principal non esiste).
 */
export async function listRadicaleCollections(client: RadicaleClient, principal: string): Promise<DiscoveredCollection[]> {
  const path = principalPath(principal);
  const ms = await client.propfind(path, { props: DISCOVERY_PROPS, depth: 1 });
  const self = decodeURIComponent(path);
  return ms.responses
    .filter((r) => r.status === null || r.status === 200)
    .filter((r) => r.path.replace(/\/+$/, '/') !== self && r.path !== self.replace(/\/$/, ''))
    .map(parseCollection)
    .filter((c) => c.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Discovery ───────────────────

interface SidecarRow {
  id: string;
  slug: string;
  name: string;
  collection_name: string | null;
  role: CalendarRole;
  origin: string;
  lifecycle: string;
  dav_props: Record<string, string> | null;
  missing_since: Date | null;
  needs_review: boolean;
  sort_order: number;
}

let inflight: Promise<DiscoveryResult> | null = null;
let last: { result: DiscoveryResult; principalMtimeNs: string | null; at: Date } | null = null;
let lastMissingKey = '';

/** Esito dell'ultima discovery riuscita, con la mtime del principal osservata prima della PROPFIND. */
export function lastDiscovery(): { result: DiscoveryResult; principalMtimeNs: string | null; at: Date } | null {
  return last;
}

/** Solo test: dimentica l'ultima discovery. */
export function resetDiscoveryState(): void {
  last = null;
  lastMissingKey = '';
}

/**
 * Discovery del principal (vedi testa del file). Single-flight: chi arriva
 * durante una discovery in corso ne riceve l'esito. Lancia
 * CalendarUnavailableError('radicale_unreachable') senza client e gli errori
 * del client se la PROPFIND fallisce.
 */
export function discoverCollections(opts: { db?: Db; client?: RadicaleClient | null; signal?: AbortSignal } = {}): Promise<DiscoveryResult> {
  if (inflight) return inflight;
  inflight = runDiscovery(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runDiscovery(opts: { db?: Db; client?: RadicaleClient | null; signal?: AbortSignal }): Promise<DiscoveryResult> {
  const rt = radicaleRuntime();
  const client = opts.client ?? rt.client;
  if (!client) throw new CalendarUnavailableError('radicale_unreachable', rt.unavailableReason ?? 'Radicale non configurato');
  const db = opts.db ?? calSql;

  // mtime del principal PRIMA della PROPFIND: un cambio successivo rifà la discovery.
  let principalMtimeNs: string | null = null;
  try {
    principalMtimeNs = (await statMtimeNs(principalDirPath(rt)))?.toString() ?? null;
  } catch {
    principalMtimeNs = null;
  }

  const { state, check } = await verifyVolumeIdentity({ db });
  const result: DiscoveryResult = { identity: check.status, collections: [], adopted: [], created: [], updated: [], missing: [], reappeared: [], unknown: [] };
  if (check.status !== 'ok') {
    last = { result, principalMtimeNs, at: new Date() };
    return result;
  }
  if (opts.signal?.aborted) throw new CalendarUnavailableError('radicale_unreachable', 'discovery interrotta');

  const collections = await listRadicaleCollections(client, rt.principal);
  result.collections = collections;
  const writable = state.mode === 'radicale' || state.mode === 'finalized';

  const rows: SidecarRow[] = await db`
    SELECT id, slug, name, collection_name, role, origin, lifecycle, dav_props, missing_since, needs_review, sort_order
    FROM calendars
  `;
  const byName = new Map(rows.filter((r) => r.collection_name).map((r) => [r.collection_name as string, r]));
  const seen = new Set<string>();

  for (const col of collections) {
    if (col.name.startsWith(SYSTEM_COLLECTION_PREFIX) || col.name.startsWith('.')) continue;
    seen.add(col.name);
    const row = byName.get(col.name);
    if (!row) {
      if (!col.isCalendar || !writable || !isValidCollectionName(col.name)) {
        result.unknown.push(col.name);
        continue;
      }
      const createdId = await createDeviceRow(db, col, rows);
      if (createdId) result.created.push(col.name);
      else result.unknown.push(col.name);
      continue;
    }
    if (row.role === 'subscription') continue; // specchio sub-*: la fonte è il feed remoto
    if (row.lifecycle === 'deleting') continue; // cancellazione in corso (store): non si tocca
    if (!col.isCalendar) {
      result.unknown.push(col.name);
      continue;
    }
    await reconcileRow({ db, row, col, writable, result });
  }

  // Righe attive senza collezione: missing_since e alert, mai cancellazioni.
  const now = new Date();
  for (const row of rows) {
    const name = row.collection_name;
    if (!name || row.role === 'subscription' || row.lifecycle !== 'active' || !isValidCollectionName(name)) continue;
    if (seen.has(name)) continue;
    result.missing.push(name);
    if (writable && !row.missing_since) {
      await db`UPDATE calendars SET missing_since = ${now} WHERE id = ${row.id} AND missing_since IS NULL`;
    }
  }
  const missingKey = result.missing.slice().sort().join('\u0000');
  if (missingKey !== lastMissingKey) {
    lastMissingKey = missingKey;
    for (const name of result.missing) {
      raiseIndexAlert('collection-missing', `Collezione ${name} assente su Radicale: indice invariato, nessuna cancellazione`, { key: name, collection: name, mode: state.mode });
    }
  }

  last = { result, principalMtimeNs, at: new Date() };
  if (result.created.length || result.adopted.length || result.reappeared.length || result.missing.length) {
    log.info({ adopted: result.adopted, created: result.created, missing: result.missing, reappeared: result.reappeared, unknown: result.unknown }, 'discovery delle collezioni');
  }
  return result;
}

function sameProps(a: Record<string, string> | null, b: Record<string, string>): boolean {
  const left = a ?? {};
  const ka = Object.keys(left).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && left[k] === b[k]);
}

/** dav_props da salvare: senza le dead prop dell'applicazione se la collezione è scrivibile dai device. */
function mirroredProps(col: DiscoveredCollection, deviceWritable: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(col.davProps)) {
    if (deviceWritable && key.startsWith(`{${CALDES_NAMESPACE}}`)) continue;
    out[key] = value;
  }
  return out;
}

async function reconcileRow(input: { db: Db; row: SidecarRow; col: DiscoveredCollection; writable: boolean; result: DiscoveryResult }): Promise<void> {
  const { db, row, col, writable, result } = input;
  const deviceWritable = row.origin === 'device' || !DEVICE_READONLY_ROLES.includes(row.role);
  const deadId = col.davProps[clark(DAV_PROPS.calendarId)]?.toLowerCase() ?? null;
  const sameId = deadId !== null && deadId === String(row.id).toLowerCase();
  const adopt = row.origin !== 'device' && row.lifecycle === 'creating' && sameId;
  const conflict = row.origin !== 'device' && row.lifecycle === 'active' && !sameId && !row.needs_review;
  const props = mirroredProps(col, deviceWritable);
  const propsChanged = !sameProps(row.dav_props, props);

  if (conflict) {
    raiseIndexAlert('collection-conflict', `Collezione ${col.name}: calendar-id ${deadId ?? 'assente'} diverso dalla riga del sidecar`, { key: col.name, calendarId: row.id });
  }
  // In mode postgres e cutover nessuna scrittura (e quindi nessuna azione da riportare).
  if (!writable || (!row.missing_since && !adopt && !propsChanged && !conflict)) return;
  if (row.missing_since) result.reappeared.push(col.name);
  if (adopt) result.adopted.push(col.name);
  if (propsChanged) result.updated.push(col.name);

  await db`
    UPDATE calendars SET
      missing_since = NULL,
      lifecycle = CASE WHEN ${adopt} THEN 'active' ELSE lifecycle END,
      dav_props = CASE WHEN ${propsChanged} THEN ${db.json(props)}::jsonb ELSE dav_props END,
      needs_review = CASE WHEN ${conflict} AND NOT needs_review THEN true ELSE needs_review END,
      review_reason = CASE WHEN ${conflict} AND NOT needs_review THEN 'collection_name_conflict' ELSE review_reason END
    WHERE id = ${row.id}
  `;
}

const generateFeedToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 32);

/** Slug a-z, 0-9 e '-' da un nome libero (CALENDAR_SLUG_REGEX), univoco fra quelli dati. */
export function deriveSlug(source: string, taken: ReadonlySet<string>): string {
  const base = source
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'dispositivo';
  const start = /^[a-z0-9]/.test(base) ? base : `d-${base}`;
  if (!taken.has(start) && CALENDAR_SLUG_REGEX.test(start)) return start;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${start}-${i}`;
    if (!taken.has(candidate) && CALENDAR_SLUG_REGEX.test(candidate)) return candidate;
  }
  return `dispositivo-${generateFeedToken().slice(0, 12)}`;
}

/**
 * Riga del sidecar per una collezione creata da un device (decisione 4):
 * bloccante, da rivedere, feed spento. Nella stessa transazione la riga di
 * stato dell'indice (la sync la popola al prossimo giro del watcher o della
 * freshness). Restituisce l'id, o null se un'altra riga ha preso nel
 * frattempo il nome della collezione.
 */
async function createDeviceRow(db: Db, col: DiscoveredCollection, rows: SidecarRow[]): Promise<string | null> {
  const takenSlugs = new Set(rows.map((r) => r.slug));
  const takenNames = new Set(rows.map((r) => r.name.trim().toLowerCase()));
  let name = (col.displayName ?? '').trim() || col.name;
  if (takenNames.has(name.toLowerCase())) name = `${name} (dal dispositivo)`;
  const role: CalendarRole = col.components.length > 0 && col.components.every((c) => c === 'VTODO') ? 'tasks' : 'user';
  const components = col.components.length ? col.components : ['VEVENT'];
  const sortOrder = col.order ?? (rows.length ? Math.max(...rows.map((r) => r.sort_order ?? 0)) + 1 : 0);
  const props = mirroredProps(col, true);
  const { ensureCollectionState } = await import('./indexer');

  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = deriveSlug(attempt === 0 ? col.displayName || col.name : `${col.displayName || col.name}-${attempt + 1}`, takenSlugs);
    takenSlugs.add(slug);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js (stesso pattern di src/)
    const id = await (db as any).begin(async (tx: Db) => {
      const inserted: Array<{ id: string }> = await tx`
        INSERT INTO calendars (
          slug, name, description, color, timezone, is_default, is_system, blocks_availability,
          ics_feed_token, ics_feed_enabled, sort_order, collection_name, role, origin, lifecycle,
          device_visible, components, dav_props, needs_review, review_reason
        ) VALUES (
          ${slug}, ${name}, ${col.description}, ${col.color ?? '#7c3aed'}, ${col.timezone ?? 'Europe/Rome'}, false, false, true,
          ${generateFeedToken()}, false, ${sortOrder}, ${col.name}, ${role}, 'device', 'active',
          true, ${components}::text[], ${tx.json(props)}::jsonb, true, 'device_new'
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (!inserted.length) return null;
      await ensureCollectionState(tx, inserted[0].id, 'radicale');
      return inserted[0].id;
    });
    if (id) {
      raiseIndexAlert('collection-device-new', `Nuova collezione ${col.name} creata da un dispositivo: bloccante, da rivedere in admin`, { key: col.name, calendarId: id, collection: col.name, role });
      return id;
    }
    // Conflitto: nome della collezione preso nel frattempo (non si adotta) o slug/token occupati (si riprova).
    const [owner]: Array<{ id: string }> = await db`SELECT id FROM calendars WHERE collection_name = ${col.name}`;
    if (owner) return null;
  }
  log.error({ collection: col.name }, 'riga del sidecar per la collezione del dispositivo non creata dopo 3 tentativi');
  return null;
}
