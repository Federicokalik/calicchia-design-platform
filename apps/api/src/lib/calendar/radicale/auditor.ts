/**
 * Auditor notturno del calendario (fase F2 del passaggio a Radicale; design
 * §6.8, §9 "Riconciliazione notturna", §16.5; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §5.4).
 *
 * Confronta il volume con l'indice e ripara ciò che può riparare senza mai
 * cancellare dati in automatico:
 *  1. identità del volume (volume-id/epoch) contro calendar_backend_state;
 *  2. coerenza della policy dei device su disco con policyFromState() e
 *     freschezza del heartbeat (control-plane F1); se incoerente, giro
 *     immediato del control-plane e alert;
 *  3. calendar_sidecar_reconcile() (162);
 *  4. per ogni collezione Radicale-backed, solo con identità ok: (href, etag)
 *     di Radicale (PROPFIND Depth:1) contro l'indice; una differenza produce
 *     syncCollection(full) (passando per l'interruttore anti-cancellazione) e
 *     un alert; i file .ics sul mount assenti dal listing sono item che
 *     Radicale salta (sostituisce --verify-storage): entrano nell'indice in
 *     quarantena 'radicale-skip' con il loro busy conservativo;
 *  5. prenotazioni contro la collezione bookings, in sola lettura (solo store
 *     Radicale): proiezioni mancanti o di prenotazioni non più attive → job
 *     project_booking (convergente); proiezioni senza prenotazione → alert ed
 *     elenco "prenotazioni da recuperare", mai cancellate; orari diversi →
 *     BOOKING_DRIFT; prenotazioni future sovrapposte a eventi bloccanti →
 *     cal_booking_conflicts (detected_by 'auditor'), mai annullate;
 *  6. orizzonte (garanzia statica; se manca, ensureHorizon e nuova verifica);
 *  7. quarantene, collezioni in hold, rebuild richiesto senza job (riaccodato);
 *  8. retention: versioni oltre 90 giorni e job chiusi.
 *
 * Non lancia per il fallimento di un singolo passo: ogni passo è isolato e il
 * rapporto (più gli alert) dice cosa non è andato. Radicale non configurato →
 * i passi che lo richiedono si saltano (nessun errore).
 *
 * Pool: letture sul pool principale; le scritture sulle tabelle dell'indice
 * (versioni, conflitti) sono comandi brevi in autocommit sul pool calendario
 * dedicato; quelle di oggetti e occorrenze passano dall'indicizzatore (lock
 * della collezione). Nessuna connessione del pool calendario è tenuta mentre
 * se ne attende un'altra (contratto §1.3).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { calSql, sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { storeKindForMode } from '../backend-mode';
import { CAL_JOB_KINDS, CAL_JOB_PRIORITY, enqueueCalendarJob, purgeFinishedCalendarJobs, retryDeadCalendarJob } from '../jobs';
import { requiredHorizonEnd } from '../index-model';
import { collectionPath, isValidObjectName, objectPath, type RadicaleClient, radicaleClientFromEnv } from './client';
import { DAV_PROPS, type Multistatus } from './dav-xml';
import { isRadicaleError } from './errors';
import { errorText, raiseIndexAlert, type IndexAlertCode } from './health';
import { HEARTBEAT_STALE_AFTER_MS } from './types';
import { readHeartbeatFile, requestControlPlaneSync } from './heartbeat';
import { assertHorizonCovers, ensureHorizon, maxAdvanceDays } from './horizon';
import { checkVolumeIdentity, NO_IDENTITY_SOURCE, resolveIdentitySource } from './identity';
import { quarantineIndexedObject } from './indexer';
import { controlPlaneConfigFromEnv, type ControlPlaneConfig, readBackendState, readPolicyFile, readPolicyInputs, RADICALE_DATA_DIR_DEFAULT } from './policy';
import { mountUntrusted, syncCollection } from './sync';
import {
  type CalendarBackendState,
  DEFAULT_PRINCIPAL,
  type IdentityStatus,
  isValidCollectionName,
  isValidPrincipal,
  policyFromState,
  RADICALE_COLLECTION_ROOT,
  samePolicyContent,
} from './types';
import { purgeExpiredVersions } from './versions';

const log: Logger = rootLogger.child({ scope: 'calendar-auditor' });

export interface AuditReport {
  startedAt: Date;
  finishedAt: Date;
  identity: IdentityStatus;
  policyCoherent: boolean;
  /** Righe cambiate da calendar_sidecar_reconcile(). */
  reconciled: number;
  collections: Array<{ calendarId: string; etagMismatches: number; resynced: boolean; brokenFiles: string[] }>;
  /** null in mode postgres (le proiezioni sono ancora legacy). */
  bookings: { missingProjections: string[]; orphanProjections: string[]; drift: string[] } | null;
  horizonOk: boolean;
  quarantined: number;
  held: string[];
  versionsPurged: number;
  jobsPurged: number;
  /** Saghe recurrence_split e controlli booking_conflict_check riaccodati dalla dead letter. */
  jobsRevived: number;
  alerts: string[];
}

/** Dimensione massima di un file letto dal mount (max_resource_size di Radicale, design §3.2). */
const MAX_DISK_ITEM_BYTES = 10_000_000;
/** Timeout delle richieste a Radicale dell'auditor (lavoro notturno, nessuna fretta). */
const AUDIT_RADICALE_TIMEOUT_MS = 20_000;
/** Scadenza di una resync completa lanciata dall'auditor. */
const AUDIT_SYNC_DEADLINE_MS = 5 * 60_000;
/** Le prenotazioni concluse da più di così non si riproiettano (la migrazione F3 copre lo storico). */
const BOOKING_LOOKBACK_MS = 90 * 86_400_000;
/** Scostamento oltre il quale una proiezione è "in deriva" rispetto alla prenotazione. */
const BOOKING_DRIFT_TOLERANCE_MS = 60_000;
/** Stati delle prenotazioni proiettate (design §9: le pending no, parità). */
const PROJECTED_STATUSES = ['confirmed', 'completed', 'no_show'] as const;

/** Sostituzioni per i test (Radicale del harness, mount temporaneo). */
export interface AuditOverrides {
  client?: RadicaleClient | null;
  principal?: string;
  dataDir?: string;
  /** Configurazione del control-plane (policy e heartbeat); null = non attivo. */
  controlPlane?: Pick<ControlPlaneConfig, 'policyFile' | 'heartbeatFile'> | null;
}

/**
 * Esegue l'audit notturno (cron). Vedi la testa del file. Non lancia salvo
 * stato del backend illeggibile (senza stato non si sa cosa sia autorevole).
 */
export async function runCalendarAudit(opts: { signal?: AbortSignal; now?: Date } & AuditOverrides = {}): Promise<AuditReport> {
  const startedAt = new Date();
  const now = opts.now ?? startedAt;
  const alerts: string[] = [];
  const alert = (code: IndexAlertCode, message: string, details: Record<string, unknown> = {}): void => {
    alerts.push(`${code}: ${message}`);
    raiseIndexAlert(code, message, details);
  };

  const state = await readBackendState(sql);

  // ─── Configurazione ───
  let config: ControlPlaneConfig | null = null;
  try {
    config = controlPlaneConfigFromEnv();
  } catch (err) {
    alert('audit-policy', `Configurazione del control-plane non valida: ${errorText(err)}`, { key: 'config' });
  }
  const principal = opts.principal ?? config?.principal ?? DEFAULT_PRINCIPAL;
  const dataDir = opts.dataDir ?? config?.dataDir ?? RADICALE_DATA_DIR_DEFAULT;
  let client: RadicaleClient | null = null;
  let ownClient = false;
  if (opts.client !== undefined) {
    client = opts.client;
  } else {
    try {
      client = radicaleClientFromEnv(process.env, { timeoutMs: AUDIT_RADICALE_TIMEOUT_MS, userAgent: 'caldes-api-auditor' });
      ownClient = client !== null;
    } catch (err) {
      alert('audit-identity', `Client Radicale non configurabile: ${errorText(err)}`, { key: 'client' });
    }
  }

  try {
    // ─── 1. Identità ───
    let identity: IdentityStatus = state.epoch === 0 ? 'uninitialized' : 'unverified';
    try {
      // Mount smentito dal canary (copia stantia o assente): con `auto` l'identità si legge da Radicale.
      const setting = config?.identitySource ?? 'auto';
      const source = isValidPrincipal(principal)
        ? await resolveIdentitySource(setting === 'auto' && client && mountUntrusted() ? 'remote' : setting, dataDir, client)
        : NO_IDENTITY_SOURCE;
      identity = (await checkVolumeIdentity(state, source, principal, now)).status;
    } catch (err) {
      log.warn({ err }, 'controllo d\'identità dell\'auditor non riuscito');
    }
    if (identity === 'mismatch' || identity === 'unverified') {
      alert('audit-identity', `Identità del volume di Radicale ${identity}: indice non verificabile contro il volume`, { key: identity, epoch: state.epoch });
    }

    // ─── 2. Policy e heartbeat ───
    const policyCoherent = await checkControlPlane(state, identity, principal, now, opts.controlPlane !== undefined ? opts.controlPlane : config, alert);

    // ─── 3. Sidecar ───
    let reconciled = 0;
    try {
      const rows = await sql`SELECT * FROM calendar_sidecar_reconcile()`;
      reconciled = rows.length;
      if (reconciled > 0) log.info({ reconciled }, 'sidecar dei calendari riconciliato');
    } catch (err) {
      alert('audit-drift', `calendar_sidecar_reconcile() non riuscita: ${errorText(err)}`, { key: 'reconcile' });
    }

    // ─── 4. Volume contro indice ───
    const collections: AuditReport['collections'] = [];
    if (identity === 'ok' && client && isValidPrincipal(principal)) {
      collections.push(...(await auditCollections(client, principal, dataDir, opts.signal, alert)));
    }

    // ─── 5. Prenotazioni contro collezione bookings ───
    let bookings: AuditReport['bookings'] = null;
    if (storeKindForMode(state.mode) === 'radicale') {
      try {
        bookings = await auditBookings(now, alert);
      } catch (err) {
        alert('audit-drift', `Controllo delle proiezioni delle prenotazioni non riuscito: ${errorText(err)}`, { key: 'bookings' });
      }
    }

    // ─── 6. Orizzonte (garanzia delle decisioni: conta solo con lo store Radicale) ───
    let horizonOk = true;
    if (storeKindForMode(state.mode) === 'radicale') {
      try {
        const required = requiredHorizonEnd(now, await maxAdvanceDays(sql));
        horizonOk = await horizonCovers(required);
        if (!horizonOk) {
          await ensureHorizon({ now, signal: opts.signal });
          horizonOk = await horizonCovers(required);
        }
        if (!horizonOk) alert('horizon-insufficient', 'Orizzonte dell\'indice più corto della garanzia anche dopo l\'estensione', { key: 'audit', required: required.toISOString() });
      } catch (err) {
        horizonOk = false;
        alert('horizon-insufficient', `Verifica dell'orizzonte non riuscita: ${errorText(err)}`, { key: 'audit-error' });
      }
    }

    // ─── 7. Quarantene, hold, rebuild ───
    const [{ quarantined }] = await sql<Array<{ quarantined: number }>>`
      SELECT count(*)::int AS quarantined FROM cal_objects WHERE health = 'quarantined'
    `;
    if (quarantined > 0) alert('object-quarantined', `${quarantined} oggetti in quarantena da verificare`, { key: 'audit', count: quarantined });
    const held = (await sql<Array<{ calendar_id: string }>>`
      SELECT calendar_id FROM cal_collection_state WHERE health = 'hold' ORDER BY calendar_id
    `).map((r) => r.calendar_id);
    if (held.length > 0) alert('collection-hold', `${held.length} collezioni con cancellazioni di massa sospese: scegliere "applica" o "ricostruisci"`, { key: 'audit', count: held.length });
    if (state.rebuild_required) {
      try {
        const [{ active }] = await sql<Array<{ active: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM cal_jobs WHERE kind = ${CAL_JOB_KINDS.indexRebuild} AND status IN ('pending', 'running')) AS active
        `;
        if (!active) {
          await enqueueCalendarJob(CAL_JOB_KINDS.indexRebuild, 'all', { reason: 'auditor', actor: 'auditor' }, { priority: CAL_JOB_PRIORITY.high });
          alert('rebuild-failed', 'Rebuild dell\'indice richiesto ma senza job attivo: riaccodato', { key: 'audit' });
        }
      } catch (err) {
        alert('rebuild-failed', `Riaccodamento del rebuild non riuscito: ${errorText(err)}`, { key: 'audit-error' });
      }
    }

    // ─── 7b. Job morti per indisponibilità prolungata ───
    let jobsRevived = 0;
    try {
      jobsRevived = await reviveDeadCalendarJobs();
      if (jobsRevived > 0) log.info({ jobsRevived }, 'job del calendario riaccodati dalla dead letter');
    } catch (err) {
      log.warn({ err }, 'riaccodamento dei job morti non riuscito');
    }

    // ─── 8. Retention ───
    let versionsPurged = 0;
    let jobsPurged = 0;
    try {
      versionsPurged = await purgeExpiredVersions(calSql, now);
    } catch (err) {
      log.error({ err }, 'purge delle versioni scadute non riuscita');
    }
    try {
      jobsPurged = await purgeFinishedCalendarJobs();
    } catch (err) {
      log.error({ err }, 'purge dei job chiusi non riuscita');
    }
    try {
      const [{ open }] = await sql<Array<{ open: number }>>`SELECT count(*)::int AS open FROM cal_booking_conflicts WHERE resolved_at IS NULL`;
      if (open > 0) alert('booking-conflict', `${open} conflitti fra prenotazioni ed eventi ancora aperti`, { key: 'audit-open', count: open });
    } catch (err) {
      log.warn({ err }, 'conteggio dei conflitti aperti non riuscito');
    }

    const report: AuditReport = {
      startedAt,
      finishedAt: new Date(),
      identity,
      policyCoherent,
      reconciled,
      collections,
      bookings,
      horizonOk,
      quarantined,
      held,
      versionsPurged,
      jobsPurged,
      jobsRevived,
      alerts,
    };
    log.info(
      {
        identity,
        policyCoherent,
        reconciled,
        collections: collections.length,
        resynced: collections.filter((c) => c.resynced).length,
        brokenFiles: collections.reduce((n, c) => n + c.brokenFiles.length, 0),
        horizonOk,
        quarantined,
        held: held.length,
        versionsPurged,
        jobsPurged,
        alerts: alerts.length,
        durationMs: report.finishedAt.getTime() - startedAt.getTime(),
      },
      'audit notturno del calendario concluso',
    );
    return report;
  } finally {
    if (ownClient) client?.close();
  }
}

// ─── Control-plane ───────────────────────────────

/**
 * policy.json su disco uguale a quella che policyFromState() darebbe adesso e
 * heartbeat.json fresco. Control-plane non attivo (cartella di caldes_control
 * assente) → coerente per definizione: non c'è nulla che i device leggano.
 */
async function checkControlPlane(
  state: CalendarBackendState,
  identity: IdentityStatus,
  principal: string,
  now: Date,
  config: Pick<ControlPlaneConfig, 'policyFile' | 'heartbeatFile'> & { activation?: ControlPlaneConfig['activation'] } | null,
  alert: (code: IndexAlertCode, message: string, details?: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!config || config.activation === 'off') return true;
  const dirExists = await stat(dirname(config.policyFile)).then((s) => s.isDirectory()).catch(() => false);
  if (!dirExists) return true;
  let coherent = true;
  try {
    const inputs = await readPolicyInputs(sql);
    const expected = policyFromState({ state: inputs.state, identity, collections: inputs.collections, principal, now });
    const onDisk = await readPolicyFile(config.policyFile, principal);
    if (onDisk.state !== 'ok' || !samePolicyContent(expected, onDisk.value)) {
      coherent = false;
      alert('audit-policy', `policy.json dei device ${onDisk.state === 'ok' ? 'diversa dallo stato' : onDisk.state === 'missing' ? 'assente' : 'non valida'}: riscrittura richiesta`, {
        key: onDisk.state,
        expectedMode: expected.mode,
        diskMode: onDisk.state === 'ok' ? onDisk.value.mode : undefined,
      });
      await requestControlPlaneSync().catch((err: unknown) => log.warn({ err }, 'giro del control-plane non riuscito'));
    }
  } catch (err) {
    coherent = false;
    alert('audit-policy', `Verifica della policy dei device non riuscita: ${errorText(err)}`, { key: 'error' });
  }
  try {
    const hb = await readHeartbeatFile(config.heartbeatFile);
    const age = hb.state === 'ok' ? now.getTime() - Date.parse(hb.value.ts) : Number.POSITIVE_INFINITY;
    if (hb.state !== 'ok' || !(age <= HEARTBEAT_STALE_AFTER_MS) || hb.value.mode !== state.mode || hb.value.epoch !== state.epoch) {
      coherent = false;
      alert('audit-heartbeat', `heartbeat.json ${hb.state !== 'ok' ? hb.state : age > HEARTBEAT_STALE_AFTER_MS ? 'scaduto' : 'incoerente con lo stato'}: i device vanno in frozen`, {
        key: hb.state,
      });
    }
  } catch (err) {
    coherent = false;
    alert('audit-heartbeat', `Lettura del heartbeat non riuscita: ${errorText(err)}`, { key: 'error' });
  }
  return coherent;
}

// ─── Volume contro indice ───────────────────────────────

/** Listing di una collezione: nome dell'item → etag (null se Radicale non lo dà). */
async function radicaleListing(client: RadicaleClient, principal: string, collection: string): Promise<Map<string, string | null> | null> {
  const path = collectionPath(principal, collection);
  let ms: Multistatus;
  try {
    ms = await client.propfind(path, { props: [DAV_PROPS.getetag, DAV_PROPS.resourcetype], depth: 1, timeoutMs: AUDIT_RADICALE_TIMEOUT_MS });
  } catch (err) {
    if (isRadicaleError(err, 'not_found')) return null;
    throw err;
  }
  const self = decodeURIComponent(path).replace(/\/+$/, '');
  const out = new Map<string, string | null>();
  for (const entry of ms.responses) {
    const entryPath = entry.path.replace(/\/+$/, '');
    if (entryPath === self || entry.status === 404) continue;
    const type = entry.element(DAV_PROPS.resourcetype);
    if (type && type.children.length > 0) continue; // sotto-collezioni (non previste)
    if (!entry.name) continue;
    out.set(entry.name, entry.text(DAV_PROPS.getetag));
  }
  return out;
}

async function listDiskItems(dir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && !e.name.startsWith('.') && isValidObjectName(e.name)).map((e) => e.name);
  } catch {
    return null; // mount assente o collezione non leggibile: controllo dei file rotti saltato
  }
}

async function readDiskItem(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_DISK_ITEM_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function auditCollections(
  client: RadicaleClient,
  principal: string,
  dataDir: string,
  signal: AbortSignal | undefined,
  alert: (code: IndexAlertCode, message: string, details?: Record<string, unknown>) => void,
): Promise<AuditReport['collections']> {
  const out: AuditReport['collections'] = [];
  const targets = await sql<Array<{ id: string; collection_name: string }>>`
    SELECT id, collection_name FROM calendars
    WHERE role <> 'subscription' AND lifecycle = 'active' AND missing_since IS NULL
      AND collection_name IS NOT NULL AND collection_name NOT LIKE '\\_%'
    ORDER BY sort_order, collection_name, id
  `;
  for (const target of targets) {
    if (signal?.aborted) break;
    if (!isValidCollectionName(target.collection_name)) continue;
    const entry = { calendarId: target.id, etagMismatches: 0, resynced: false, brokenFiles: [] as string[] };
    out.push(entry);
    try {
      const listing = await radicaleListing(client, principal, target.collection_name);
      if (listing === null) {
        alert('audit-drift', `Collezione ${target.collection_name} assente in Radicale`, { calendarId: target.id, key: 'missing' });
        continue;
      }
      const indexed = await sql<Array<{ href: string; etag: string | null; health: string; health_reason: string | null }>>`
        SELECT href, etag, health, health_reason FROM cal_objects
        WHERE calendar_id = ${target.id} AND origin_store = 'radicale'
      `;
      const byHref = new Map(indexed.map((r) => [r.href, r]));
      let mismatches = 0;
      for (const [name, etag] of listing) {
        const row = byHref.get(name);
        if (!row || (etag !== null && row.etag !== etag)) mismatches++;
      }
      for (const row of indexed) {
        // Le risorse che Radicale salta non sono nel listing per definizione.
        if (!listing.has(row.href) && row.health_reason !== 'radicale-skip') mismatches++;
      }
      entry.etagMismatches = mismatches;

      // File sul mount che Radicale non elenca: item rotti saltati da skip_broken_item.
      // Mai da un mount che il canary ha smentito (non è il volume vivo).
      const dir = join(dataDir, RADICALE_COLLECTION_ROOT, principal, target.collection_name);
      const onDisk = mountUntrusted() ? null : await listDiskItems(dir);
      for (const name of onDisk ?? []) {
        if (listing.has(name)) continue;
        const row = byHref.get(name);
        if (row?.health === 'quarantined' && row.health_reason === 'radicale-skip') continue;
        // Una PUT appena arrivata non è un file rotto: riprova con una GET.
        try {
          await client.get(objectPath(principal, target.collection_name, name), { timeoutMs: AUDIT_RADICALE_TIMEOUT_MS });
          continue;
        } catch (err) {
          if (!isRadicaleError(err, 'not_found')) throw err;
        }
        entry.brokenFiles.push(name);
        const raw = await readDiskItem(join(dir, name));
        await quarantineIndexedObject(target.id, name, 'radicale-skip', { actor: 'auditor', raw });
        alert('audit-broken-file', `File che Radicale non legge nella collezione ${target.collection_name}: in quarantena`, { calendarId: target.id, href: name });
      }

      if (mismatches > 0) {
        alert('audit-drift', `Indice diverso da Radicale nella collezione ${target.collection_name} (${mismatches} differenze): resync completa`, {
          calendarId: target.id,
          mismatches,
        });
        await syncCollection(target.id, { reason: 'auditor', full: true, actor: 'auditor', signal, deadline: Date.now() + AUDIT_SYNC_DEADLINE_MS });
        entry.resynced = true;
      }
    } catch (err) {
      alert('audit-drift', `Audit della collezione ${target.collection_name} non riuscito: ${errorText(err)}`, { calendarId: target.id, key: 'error' });
    }
  }
  return out;
}

// ─── Prenotazioni ───────────────────────────────

async function auditBookings(
  now: Date,
  alert: (code: IndexAlertCode, message: string, details?: Record<string, unknown>) => void,
): Promise<NonNullable<AuditReport['bookings']>> {
  const since = new Date(now.getTime() - BOOKING_LOOKBACK_MS);
  const projected = [...PROJECTED_STATUSES];
  // Proiezioni nell'indice (href booking-* nella collezione bookings → source 'booking').
  const projections = await sql<Array<{ object_id: string; uid: string; start_utc: Date | null; end_utc: Date | null }>>`
    SELECT o.id AS object_id, o.source_id AS uid, min(x.start_utc) AS start_utc, max(x.end_utc) AS end_utc
    FROM cal_objects o
    JOIN calendars c ON c.id = o.calendar_id AND c.role = 'bookings' AND c.lifecycle = 'active'
    LEFT JOIN cal_occurrences x ON x.object_id = o.id
    WHERE o.source = 'booking' AND o.source_id IS NOT NULL
    GROUP BY o.id, o.source_id
  `;
  const byUid = new Map(projections.map((p) => [p.uid, p]));
  const bookings = await sql<Array<{ uid: string; status: string; start_time: Date; end_time: Date; updated_at: Date }>>`
    SELECT uid, status, start_time, end_time, updated_at FROM calendar_bookings
    WHERE uid = ANY(${projections.map((p) => p.uid)}::text[])
       OR (status = ANY(${projected}::text[]) AND end_time > ${since})
  `;
  const bookingByUid = new Map(bookings.map((b) => [b.uid, b]));

  const missingProjections: string[] = [];
  const orphanProjections: string[] = [];
  const drift: string[] = [];
  const toProject: Array<{ uid: string; version: string }> = [];

  for (const b of bookings) {
    const active = (projected as string[]).includes(b.status);
    const p = byUid.get(b.uid);
    if (active && !p && b.end_time > since) {
      missingProjections.push(b.uid);
      toProject.push({ uid: b.uid, version: b.updated_at.toISOString() });
    } else if (!active && p) {
      // Prenotazione annullata o riprogrammata con la proiezione ancora presente: il job converge (DELETE).
      toProject.push({ uid: b.uid, version: b.updated_at.toISOString() });
    } else if (active && p && p.start_utc && p.end_utc) {
      if (Math.abs(p.start_utc.getTime() - b.start_time.getTime()) > BOOKING_DRIFT_TOLERANCE_MS
        || Math.abs(p.end_utc.getTime() - b.end_time.getTime()) > BOOKING_DRIFT_TOLERANCE_MS) {
        drift.push(b.uid);
      }
    }
  }
  for (const p of projections) {
    if (!bookingByUid.has(p.uid)) orphanProjections.push(p.uid);
  }

  for (const job of toProject) {
    await enqueueCalendarJob(CAL_JOB_KINDS.projectBooking, job.uid, { reason: 'auditor' }, { sourceVersion: job.version, priority: CAL_JOB_PRIORITY.normal });
  }
  if (missingProjections.length > 0) {
    alert('booking-missing-projection', `${missingProjections.length} prenotazioni senza proiezione nella collezione bookings: riproiettate`, { key: 'audit', count: missingProjections.length });
  }
  if (orphanProjections.length > 0) {
    alert('booking-orphan-projection', `${orphanProjections.length} proiezioni senza prenotazione ("prenotazioni da recuperare"): nessuna cancellazione automatica`, {
      key: 'audit',
      count: orphanProjections.length,
    });
  }
  if (drift.length > 0) {
    alert('booking-drift', `BOOKING_DRIFT: ${drift.length} proiezioni con orari diversi dalla prenotazione`, { key: 'audit', count: drift.length });
  }

  // Prenotazioni future sovrapposte a eventi bloccanti (design §9): conflitti per la revisione, mai annullate.
  const inserted = await calSql<Array<{ id: string }>>`
    INSERT INTO cal_booking_conflicts
      (booking_id, booking_uid, calendar_id, object_id, recurrence_key, booking_start, booking_end, event_start, event_end, detected_by)
    SELECT b.id, b.uid, o.calendar_id, o.object_id, o.recurrence_key, b.start_time, b.end_time, o.start_utc, o.end_utc, 'auditor'
    FROM calendar_bookings b
    JOIN cal_occurrences o
      ON o.blocks AND o.span && tstzrange(b.start_time, b.end_time, '[)')
    JOIN calendars c ON c.id = o.calendar_id
    LEFT JOIN calendars p ON p.id = c.parent_calendar_id
    LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
    WHERE b.status IN ('pending', 'confirmed')
      AND b.end_time > ${now}
      AND o.kind <> 'booking_projection'
      AND CASE WHEN c.role = 'subscription'
               THEN COALESCE(s.blocks_availability, false) AND COALESCE(p.blocks_availability, false)
               ELSE c.blocks_availability END
    ON CONFLICT (booking_id, object_id, recurrence_key) WHERE resolved_at IS NULL DO NOTHING
    RETURNING id
  `;
  if (inserted.length > 0) {
    alert('booking-conflict', `${inserted.length} prenotazioni sovrapposte a eventi del calendario: da rivedere`, { key: 'audit-new', count: inserted.length });
  }

  return { missingProjections, orphanProjections, drift };
}

// ─── Job morti ───────────────────────────────

/** Età massima di un job morto che l'auditor riaccoda (una notte dopo l'altra). */
const REVIVE_MAX_AGE_DAYS = 7;

/**
 * Riaccoda dalla dead letter le saghe "questa e le successive" non concluse
 * (phase ≠ done) e i controlli delle sovrapposizioni di prenotazioni ancora
 * future e attive, morti per un errore non definitivo (indisponibilità oltre
 * le 48 h di attesa, lease scaduti): senza, una saga interrotta lascia serie
 * originale e nuova entrambe intere (occorrenze doppie) finché non interviene
 * qualcuno. Gli handler rileggono lo stato all'esecuzione (convergenti), una
 * riga per (tipo, chiave), solo i job creati negli ultimi 7 giorni.
 */
export async function reviveDeadCalendarJobs(): Promise<number> {
  const rows = await calSql<Array<{ id: string }>>`
    SELECT DISTINCT ON (j.kind, j.key) j.id
    FROM cal_jobs j
    WHERE j.status = 'dead'
      AND j.kind = ANY(${[CAL_JOB_KINDS.recurrenceSplit, CAL_JOB_KINDS.bookingConflictCheck]}::text[])
      AND j.created_at > now() - ${REVIVE_MAX_AGE_DAYS} * INTERVAL '1 day'
      AND (j.last_error IS NULL OR j.last_error NOT LIKE 'CalendarJobPermanentError:%')
      AND (j.kind <> ${CAL_JOB_KINDS.recurrenceSplit} OR COALESCE(j.payload->>'phase', '') <> 'done')
      AND (j.kind <> ${CAL_JOB_KINDS.bookingConflictCheck} OR EXISTS (
        SELECT 1 FROM calendar_bookings b WHERE b.uid = j.key AND b.status IN ('pending', 'confirmed') AND b.end_time > now()
      ))
      AND NOT EXISTS (
        SELECT 1 FROM cal_jobs o WHERE o.kind = j.kind AND o.key = j.key AND o.status IN ('pending', 'running')
      )
    ORDER BY j.kind, j.key, j.created_at DESC
    LIMIT 200
  `;
  let revived = 0;
  for (const row of rows) if (await retryDeadCalendarJob(String(row.id))) revived++;
  return revived;
}

// ─── Orizzonte ───────────────────────────────

async function horizonCovers(required: Date): Promise<boolean> {
  try {
    await assertHorizonCovers(sql, required);
    return true;
  } catch (err) {
    if ((err as { reason?: unknown }).reason === 'horizon_insufficient') return false;
    throw err;
  }
}
