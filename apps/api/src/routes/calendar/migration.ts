/**
 * API REST dello strumento di migrazione del calendario a Radicale
 * `/api/admin/calendar/migration` (fase F3 del piano; design §13.2, §13.13;
 * contratto docs/calendar-radicale/contracts/f3-modules.md §10).
 *
 * Protetta dal JWT admin come il resto di /api/admin/calendar (protectedPaths
 * di app.ts); montata PRIMA di /api/admin/calendar. Regole comuni:
 *  - corpo e risposte JSON (tranne l'archivio della Fase 0, multipart, e il
 *    download del report); errori `{ error, code, details? }` con lo stato di
 *    MIGRATION_ERROR_STATUS, CalendarUnavailableError → 503
 *    CALENDAR_UNAVAILABLE;
 *  - le azioni che fanno lavoro creano un run asincrono (202 con il run
 *    queued, 200 con replayed = true se la stessa chiave d'idempotenza è già
 *    stata usata per la stessa richiesta) e il wizard ne interroga lo stato
 *    (GET /runs/:id, GET /state);
 *  - chiave d'idempotenza solo nell'header Idempotency-Key (un header
 *    custom: da un'altra origine forza il preflight CORS, anche per il
 *    multipart), obbligatoria per i run che scrivono; request_hash = sha256
 *    del JSON canonico di { path, body };
 *  - difesa CSRF delle richieste che scrivono (POST, PATCH, PUT, DELETE):
 *    Sec-Fetch-Site diverso da same-origin/none o Origin estranea → 403;
 *    corpo solo application/json (multipart/form-data solo per
 *    /phase0/archive) → altrimenti 415: una pagina dello stesso sito non può
 *    mandare una richiesta "semplice" (text/plain) con il cookie dell'admin;
 *  - conferme digitate esatte (MIGRATION_CONFIRMATIONS) per le azioni che
 *    scrivono, altrimenti 400 CONFIRMATION_REQUIRED con details.expected;
 *  - ogni POST/PATCH che cambia qualcosa scrive una riga in audit_logs
 *    (table_name 'calendar_migration', metadata senza dati personali).
 *
 * Fase F4 (contratto docs/calendar-radicale/contracts/f4-modules.md §6.1):
 * passaggio (cutover), annullamento, ripresa, anteprima del rollback,
 * rollback, chiusura della finestra (finalize), ri-baseline di riparazione e
 * salute della proiezione inversa. Ogni transizione è un run asincrono che
 * richiede la conferma digitata e la chiave d'idempotenza; mentre una
 * transizione è attiva (anche ferma dopo un crash) le altre ricevono 409
 * TRANSITION_IN_PROGRESS con details.transition. Postgres resta autorevole
 * finché il run di cutover non supera il passo d'epoch: le route non cambiano
 * mai lo stato da sole.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { sameOriginWrites } from '../../lib/http/same-origin-writes';
import { bodyLimit } from 'hono/body-limit';
import { sql, jsonb } from '../../db';
import { logger } from '../../lib/logger';
import { isCalendarUnavailable } from '../../lib/calendar/errors';
import { radicaleRuntime, verifyVolumeIdentity } from '../../lib/calendar/radicale/sync';
import { readIdentityDiff, uploadPathFor } from '../../lib/calendar/migration/init';
import { preflightItems, preflightWithoutRadicale } from '../../lib/calendar/migration/preflight';
import { acceptDiffs, buildRunReport } from '../../lib/calendar/migration/report';
import { canonicalJson } from '../../lib/calendar/migration/serialize';
import { getParity, listSubscriptionsForMigration, setShadowEnabled, setSubscriptionMigrationFlags } from '../../lib/calendar/migration/shadow';
import { assertCutoverReady, defaultRollbackWindowDays } from '../../lib/calendar/migration/cutover';
import { readReverseProjectionHealth } from '../../lib/calendar/migration/reverse-projector';
import {
  activeMigrationRun,
  applyParamsFromPlan,
  buildMigrationStateView,
  createMigrationRun,
  currentTransitionView,
  finalizeBlockersOf,
  rollbackPreviewValidity,
  getMigrationRun,
  listMigrationRuns,
  listRunItems,
  normalizeDeclaration,
  readMigrationState,
  recordCompletedRun,
  replayMigrationRun,
  requestRunCancel,
  type RunItemsFilter,
  writeDeclaration,
} from '../../lib/calendar/migration/runs';
import {
  type ConflictCode,
  type CutoverParams,
  DECLARATION_KEYS,
  type DeclarationKey,
  F4_LIMITS,
  F4_WRITING_RUN_KINDS,
  type FinalizeParams,
  FORCEABLE_CONFLICTS,
  type IdentityParams,
  type InitParams,
  isMigrationError,
  type ItemSeverity,
  MIGRATION_CONFIRMATIONS,
  MIGRATION_LIMITS,
  MigrationError,
  type MigrationItemType,
  type MigrationRunKind,
  type MigrationRunStatus,
  type MigrationScope,
  type PlanAction,
  type PlanParams,
  type PlanSummary,
  type PreconditionReason,
  type PreflightParams,
  type PreflightSummary,
  type RebaselineParams,
  resolveMigrationOptions,
  type RollbackParams,
  type RollbackPreviewParams,
  type RunCreatedResponse,
  type TransitionKind,
  type TransitionView,
  VERIFY_LEVELS,
  type VerifyLevel,
  type VerifyParams,
  WAIVER_DECLARATIONS,
  WRITING_RUN_KINDS,
  confirmationMatches,
} from '../../lib/calendar/migration/types';

const log = logger.child({ scope: 'calendar-migration-routes' });

interface AdminUser { id: string; email?: string | null; role?: string | null }
type Env = { Variables: { user: AdminUser | undefined } };
type Ctx = Context<Env>;

export const calendarMigration = new Hono<Env>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID_RE = /^[0-9]{1,19}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
/** Estensioni accettate per l'archivio della Fase 0 (zip di phase0-export, .ics singolo, tar di phase0-backup). */
const ARCHIVE_EXTENSIONS = ['.zip', '.ics', '.tar.gz', '.tgz', '.tar'] as const;
/** Margine per l'involucro multipart oltre la dimensione massima del file. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

// ─── Errori ───────────────────────────────

calendarMigration.onError((err, c) => {
  if (isMigrationError(err)) {
    if (err.status >= 500) log.error({ code: err.code, url: c.req.path, method: c.req.method }, `migrazione: ${err.message}`);
    return c.json(err.toBody(), err.status as 400 | 404 | 409 | 413 | 500 | 503);
  }
  if (isCalendarUnavailable(err)) {
    log.warn({ reason: err.reason, url: c.req.path, method: c.req.method }, 'migrazione: calendario non disponibile');
    return c.json({ error: err.message, code: 'CALENDAR_UNAVAILABLE' }, 503);
  }
  throw err;
});

// Difesa in profondità: il JWT admin lo verifica già authMiddleware (protectedPaths di app.ts).
calendarMigration.use('*', async (c, next) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: 'Autenticazione richiesta', code: 'VALIDATION_FAILED' }, 401);
  await next();
});

// Difesa CSRF (contratto §10.1): vedi lib/http/same-origin-writes.ts. Multipart solo per l'archivio della Fase 0, che in
// più richiede l'header Idempotency-Key.
calendarMigration.use('*', sameOriginWrites({ multipartPaths: (p) => p.endsWith('/phase0/archive'), log }));

// ─── Utilità ───────────────────────────────

function adminUser(c: Ctx): AdminUser {
  const user = c.get('user');
  if (!user?.id) throw new MigrationError('VALIDATION_FAILED', 'Utente admin mancante');
  return user;
}

/** Attore dei run, del ledger e dell'audit: `admin:<id utente>`. */
function actorOf(c: Ctx): string {
  return `admin:${adminUser(c).id}`.slice(0, 200);
}

async function readJsonBody(c: Ctx): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MigrationError('VALIDATION_FAILED', 'Corpo della richiesta non è JSON valido');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MigrationError('VALIDATION_FAILED', 'Corpo della richiesta: atteso un oggetto JSON');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Chiave d'idempotenza, solo dall'header Idempotency-Key: un header custom
 * forza il preflight CORS da un'altra origine (anche per il multipart),
 * mentre un campo del corpo lo manderebbe anche una pagina estranea.
 */
function idempotencyKeyOf(c: Ctx, body: Record<string, unknown> | null): string | null {
  if (body && body.idempotency_key !== undefined && body.idempotency_key !== null) {
    throw new MigrationError('VALIDATION_FAILED', 'La chiave d\'idempotenza va nell\'header Idempotency-Key, non nel corpo');
  }
  const key = c.req.header('Idempotency-Key')?.trim() || null;
  if (key !== null && !IDEMPOTENCY_KEY_RE.test(key)) {
    throw new MigrationError('VALIDATION_FAILED', 'Chiave d\'idempotenza non valida: 8-200 caratteri [A-Za-z0-9._:-]');
  }
  return key;
}

/** sha256 del JSON canonico di { path, body } (senza la chiave d'idempotenza). */
function requestHashOf(path: string, body: Record<string, unknown>): string {
  const { idempotency_key: _ignored, ...rest } = body;
  void _ignored;
  return createHash('sha256').update(canonicalJson({ path, body: rest })).digest('hex');
}

function requireConfirmation(value: unknown, expected: string): void {
  if (!confirmationMatches(value, expected)) {
    throw new MigrationError('CONFIRMATION_REQUIRED', `Conferma richiesta: digita esattamente "${expected}"`, { expected });
  }
}

function requireRadicaleConfigured(): void {
  const rt = radicaleRuntime();
  if (!rt.client) {
    throw new MigrationError('RADICALE_NOT_CONFIGURED', `Radicale non configurato: ${rt.unavailableReason ?? 'RADICALE_URL assente'}`);
  }
}

function precondition(message: string, reasons: PreconditionReason[], extra: Record<string, unknown> = {}): MigrationError {
  return new MigrationError('PRECONDITION_FAILED', message, { reasons, ...extra });
}

async function requireNoActiveRun(): Promise<void> {
  const active = await activeMigrationRun(sql);
  if (active) throw new MigrationError('MIGRATION_BUSY', `È già in corso un run di migrazione (${active.kind}).`, { active_run: active });
}

async function requirePostgresMode(): Promise<Awaited<ReturnType<typeof readMigrationState>>> {
  const state = await readMigrationState(sql);
  if (state.mode !== 'postgres') {
    throw precondition('Lo strumento di migrazione della F3 lavora solo in mode postgres', ['MODE_NOT_POSTGRES'], { mode: state.mode });
  }
  return state;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new MigrationError('VALIDATION_FAILED', `${name}: atteso un booleano`);
  return value;
}

function parseScope(value: unknown): MigrationScope {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new MigrationError('VALIDATION_FAILED', 'scope: atteso un oggetto');
  const ids = (value as { calendar_ids?: unknown }).calendar_ids;
  if (ids === undefined || ids === null) return {};
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    throw new MigrationError('VALIDATION_FAILED', 'scope.calendar_ids: attesi id di calendario UUID');
  }
  const unique = [...new Set((ids as string[]).map((id) => id.toLowerCase()))].sort();
  return unique.length ? { calendar_ids: unique } : {};
}

/** Riga in audit_logs (contratto §10.1): mai dati personali nei metadata. */
async function audit(c: Ctx, operation: string, recordId: string | null, metadata: Record<string, unknown> = {}, verb: 'INSERT' | 'UPDATE' | 'DELETE' = 'UPDATE'): Promise<void> {
  const user = adminUser(c);
  await sql`
    INSERT INTO audit_logs (user_email, user_role, action, table_name, record_id, user_agent, metadata)
    VALUES (
      ${user.email ?? null}, ${user.role ?? 'admin'}, ${verb}, 'calendar_migration', ${recordId},
      ${(c.req.header('User-Agent') ?? '').slice(0, 300) || null},
      ${jsonb({ operation, actor: actorOf(c), ...metadata })}
    )
  `.catch((err: unknown) => log.error({ err: err instanceof Error ? err.message : String(err), operation }, 'audit della migrazione non scritto'));
}

/** Risposta di un run creato: 202 nuovo, 200 replay; audit solo per i run nuovi. */
async function respondRun(c: Ctx, created: RunCreatedResponse, operation: string, metadata: Record<string, unknown> = {}) {
  if (!created.replayed) await audit(c, operation, created.run.id, { kind: created.run.kind, ...metadata }, 'INSERT');
  return c.json(created, created.replayed ? 200 : 202);
}

interface RunRequest {
  kind: MigrationRunKind;
  path: string;
  body: Record<string, unknown>;
  params: object;
  planRunId?: string | null;
  planHash?: string | null;
  /**
   * Transizioni della F4: controllo della transizione attiva dopo il replay e
   * prima del run attivo (409 TRANSITION_IN_PROGRESS anche se un run la sta
   * eseguendo: il messaggio giusto è "transizione in corso", non "run").
   */
  transition?: () => Promise<void>;
  /** Controlli dopo il replay e il run attivo, prima della creazione. */
  preconditions?: () => Promise<void>;
}

/**
 * Creazione di un run con le regole comuni: chiave obbligatoria per i run
 * che scrivono, replay anticipato, Radicale configurato, nessun run attivo,
 * precondizioni, poi createMigrationRun (che ricontrolla run attivo e chiave
 * in modo atomico).
 */
async function startRun(c: Ctx, req: RunRequest): Promise<RunCreatedResponse> {
  const key = idempotencyKeyOf(c, req.body);
  if ((WRITING_RUN_KINDS.has(req.kind) || F4_WRITING_RUN_KINDS.has(req.kind)) && !key) {
    throw new MigrationError('IDEMPOTENCY_KEY_REQUIRED', 'Chiave d\'idempotenza obbligatoria (header Idempotency-Key) per le azioni che scrivono');
  }
  const requestHash = requestHashOf(req.path, req.body);
  if (key) {
    const replay = await replayMigrationRun(key, requestHash);
    if (replay) return replay;
  }
  requireRadicaleConfigured();
  if (req.transition) await req.transition();
  await requireNoActiveRun();
  if (req.preconditions) await req.preconditions();
  return createMigrationRun({
    kind: req.kind,
    trigger: 'admin',
    requestedBy: actorOf(c),
    params: req.params,
    idempotencyKey: key,
    requestHash,
    planRunId: req.planRunId ?? null,
    planHash: req.planHash ?? null,
  });
}

interface SucceededRunRow { id: string; kind: MigrationRunKind; params: Record<string, unknown> | null; summary: Record<string, unknown> | null; finished_at: Date | null }

async function lastSucceededRun(kind: MigrationRunKind): Promise<SucceededRunRow | null> {
  const [row] = await sql<SucceededRunRow[]>`
    SELECT id::text AS id, kind, params, summary, finished_at FROM cal_migration_runs
    WHERE kind = ${kind} AND status = 'succeeded'
    ORDER BY finished_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

/** Identità del volume per le precondizioni (cache breve della sync; il modulo la riverifica da Radicale). */
async function currentIdentityStatus(state: Awaited<ReturnType<typeof readMigrationState>>): Promise<string> {
  try {
    const { check } = await verifyVolumeIdentity({ state });
    return check.status;
  } catch {
    return 'unverified';
  }
}

// ─── Stato ───────────────────────────────

calendarMigration.get('/state', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await buildMigrationStateView());
});

// ─── Preflight ───────────────────────────────

calendarMigration.post('/preflight', async (c) => {
  const body = await readJsonBody(c);
  const probe = optionalBoolean(body.probe_public_url, 'probe_public_url');
  const params: PreflightParams = { probe_public_url: probe ?? true };
  if (!radicaleRuntime().client) {
    // Senza Radicale il worker dei job è spento: run chiuso subito con RADICALE_CONFIGURED fallito (contratto §5.2.5).
    const key = idempotencyKeyOf(c, body);
    const requestHash = requestHashOf('/preflight', body);
    if (key) {
      const replay = await replayMigrationRun(key, requestHash);
      if (replay) return respondRun(c, replay, 'preflight');
    }
    const summary: PreflightSummary = await preflightWithoutRadicale(sql);
    const created = await recordCompletedRun(
      { kind: 'preflight', trigger: 'admin', requestedBy: actorOf(c), params, idempotencyKey: key, requestHash },
      {
        summary,
        items: preflightItems(summary.checks),
        progress: { phase: 'done', done: summary.checks.length, total: summary.checks.length, message: 'Radicale non configurato' },
      },
    );
    return respondRun(c, created, 'preflight', { radicale_configured: false });
  }
  const created = await startRun(c, { kind: 'preflight', path: '/preflight', body, params });
  return respondRun(c, created, 'preflight');
});

// ─── Inizializzazione e identità ───────────────────────────────

calendarMigration.post('/init', async (c) => {
  const body = await readJsonBody(c);
  const actionValue = body.action;
  if (actionValue !== 'initialize' && actionValue !== 'create_missing') {
    throw new MigrationError('VALIDATION_FAILED', 'action: ammessi initialize o create_missing');
  }
  requireConfirmation(body.confirm, actionValue === 'initialize' ? MIGRATION_CONFIRMATIONS.initialize : MIGRATION_CONFIRMATIONS.createCollections);
  const params: InitParams = { action: actionValue };
  const created = await startRun(c, {
    kind: 'init',
    path: '/init',
    body,
    params,
    preconditions: async () => {
      await requirePostgresMode();
      const diff = await readIdentityDiff(sql);
      if (actionValue === 'initialize') {
        if (diff.status !== 'uninitialized') {
          throw precondition('Il volume è già inizializzato: usa "Crea collezioni mancanti" o la riassegnazione d\'identità', ['IDENTITY_NOT_UNINITIALIZED'], { identity: diff.status });
        }
        if (diff.volume.principal_exists === true) {
          throw precondition('Sul volume esiste già il principal: non è un volume vuoto (serve la riassegnazione d\'identità)', ['PRINCIPAL_EXISTS'], {
            identity: diff.status,
            allowed: diff.allowed,
          });
        }
      } else if (diff.status !== 'ok') {
        throw precondition('Identità del volume non verificata: le collezioni si creano solo su un volume riconosciuto', ['IDENTITY_NOT_OK'], { identity: diff.status });
      }
    },
  });
  return respondRun(c, created, actionValue === 'initialize' ? 'init_initialize' : 'init_create_missing', { action: actionValue });
});

calendarMigration.get('/identity', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await readIdentityDiff(sql));
});

function parseIdentityExpected(value: unknown): IdentityParams['expected'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MigrationError('VALIDATION_FAILED', 'expected: atteso il diff d\'identità visto nel wizard');
  const v = value as Record<string, unknown>;
  const uuidOrNull = (x: unknown, name: string): string | null => {
    if (x === null || x === undefined) return null;
    if (typeof x !== 'string' || !UUID_RE.test(x)) throw new MigrationError('VALIDATION_FAILED', `expected.${name}: atteso un UUID o null`);
    return x.toLowerCase();
  };
  const intOrNull = (x: unknown, name: string, nullable: boolean): number | null => {
    if ((x === null || x === undefined) && nullable) return null;
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) throw new MigrationError('VALIDATION_FAILED', `expected.${name}: atteso un intero ≥ 0`);
    return x;
  };
  return {
    pg_volume_id: uuidOrNull(v.pg_volume_id, 'pg_volume_id'),
    pg_epoch: intOrNull(v.pg_epoch, 'pg_epoch', false) as number,
    marker_volume_id: uuidOrNull(v.marker_volume_id, 'marker_volume_id'),
    marker_epoch: intOrNull(v.marker_epoch, 'marker_epoch', true),
  };
}

calendarMigration.post('/identity/reassign', async (c) => {
  const body = await readJsonBody(c);
  const direction = body.direction;
  if (direction !== 'volume_to_pg' && direction !== 'pg_to_volume') {
    throw new MigrationError('VALIDATION_FAILED', 'direction: ammessi volume_to_pg o pg_to_volume');
  }
  requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.identityReassign);
  const params: IdentityParams = { direction, expected: parseIdentityExpected(body.expected) };
  const created = await startRun(c, {
    kind: 'identity',
    path: '/identity/reassign',
    body,
    params,
    preconditions: async () => {
      await requirePostgresMode();
      const diff = await readIdentityDiff(sql);
      if (!diff.allowed.includes(direction)) {
        throw precondition('La riassegnazione richiesta non è ammessa con l\'identità attuale: rileggi il diff', ['IDENTITY_DIFF_CHANGED'], {
          identity: diff.status,
          allowed: diff.allowed,
        });
      }
    },
  });
  return respondRun(c, created, 'identity_reassign', { direction });
});

// ─── Archivio della Fase 0 ───────────────────────────────

calendarMigration.post(
  '/phase0/archive',
  bodyLimit({
    maxSize: MIGRATION_LIMITS.archiveMaxBytes + MULTIPART_OVERHEAD_BYTES,
    onError: (c) => c.json({ error: `Archivio oltre ${MIGRATION_LIMITS.archiveMaxBytes / (1024 * 1024)} MB`, code: 'PAYLOAD_TOO_LARGE' }, 413),
  }),
  async (c) => {
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw new MigrationError('VALIDATION_FAILED', 'Corpo multipart non leggibile: invia il file nel campo "file"');
    }
    const file = form.file;
    if (!(file instanceof File)) throw new MigrationError('VALIDATION_FAILED', 'Campo "file" mancante: carica lo zip della Fase 0 (o un .ics)');
    requireConfirmation(form.confirm, MIGRATION_CONFIRMATIONS.archive);
    const originalName = (file.name || 'archivio').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200);
    const lower = originalName.toLowerCase();
    const ext = ARCHIVE_EXTENSIONS.find((e) => lower.endsWith(e));
    if (!ext) throw new MigrationError('VALIDATION_FAILED', `Formato non ammesso: ${ARCHIVE_EXTENSIONS.join(', ')}`);
    if (file.size > MIGRATION_LIMITS.archiveMaxBytes) {
      throw new MigrationError('PAYLOAD_TOO_LARGE', `Archivio oltre ${MIGRATION_LIMITS.archiveMaxBytes / (1024 * 1024)} MB`);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length === 0) throw new MigrationError('VALIDATION_FAILED', 'Archivio vuoto');
    if (buf.length > MIGRATION_LIMITS.archiveMaxBytes) {
      throw new MigrationError('PAYLOAD_TOO_LARGE', `Archivio oltre ${MIGRATION_LIMITS.archiveMaxBytes / (1024 * 1024)} MB`);
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    if (form.idempotency_key !== undefined) {
      throw new MigrationError('VALIDATION_FAILED', 'La chiave d\'idempotenza va nell\'header Idempotency-Key, non nel modulo');
    }
    const hashBody: Record<string, unknown> = { sha256, size: buf.length, name: originalName };
    const key = idempotencyKeyOf(c, hashBody);
    if (!key) throw new MigrationError('IDEMPOTENCY_KEY_REQUIRED', 'Chiave d\'idempotenza obbligatoria (header Idempotency-Key) per l\'import dell\'archivio');
    const requestHash = requestHashOf('/phase0/archive', hashBody);
    const replay = await replayMigrationRun(key, requestHash);
    if (replay) return respondRun(c, replay, 'phase0_archive');
    requireRadicaleConfigured();
    await requireNoActiveRun();
    await requirePostgresMode();

    // File privato (0600 in una cartella 0700), cancellato dal run a fine import (e dalla retention dopo 24 ore).
    const path = uploadPathFor(`phase0-${randomUUID()}${ext}`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => undefined);
    await writeFile(path, buf, { mode: 0o600, flag: 'wx' });
    let created: RunCreatedResponse;
    try {
      created = await createMigrationRun({
        kind: 'archive',
        trigger: 'admin',
        requestedBy: actorOf(c),
        params: { upload_path: path, upload_sha256: sha256, original_name: originalName },
        idempotencyKey: key,
        requestHash,
      });
    } catch (err) {
      await unlink(path).catch(() => undefined);
      throw err;
    }
    if (created.replayed) await unlink(path).catch(() => undefined);
    return respondRun(c, created, 'phase0_archive', { size: buf.length, sha256 });
  },
);

// ─── Dichiarazioni ───────────────────────────────

calendarMigration.post('/declarations', async (c) => {
  const body = await readJsonBody(c);
  const key = body.key;
  if (typeof key !== 'string' || !(DECLARATION_KEYS as readonly string[]).includes(key)) {
    throw new MigrationError('VALIDATION_FAILED', `key: ammesse ${DECLARATION_KEYS.join(', ')}`);
  }
  const declKey = key as DeclarationKey;
  if (WAIVER_DECLARATIONS.has(declKey)) requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.declare);
  const value = normalizeDeclaration(declKey, body.value);
  const declarations = await writeDeclaration(declKey, value, actorOf(c));
  const summary = declKey === 'phase0' ? { status: (value as { status: string }).status }
    : declKey === 'device_matrix' ? { result: (value as { result: string }).result }
      : {};
  await audit(c, 'declare', null, { key: declKey, ...summary });
  return c.json({ declarations });
});

// ─── Inventario, anteprima, apply, verifica ───────────────────────────────

calendarMigration.post('/inventory', async (c) => {
  const body = await readJsonBody(c);
  const created = await startRun(c, { kind: 'inventory', path: '/inventory', body, params: { scope: parseScope(body.scope) } });
  return respondRun(c, created, 'inventory');
});

calendarMigration.post('/plan', async (c) => {
  const body = await readJsonBody(c);
  if (body.options !== undefined && body.options !== null && (typeof body.options !== 'object' || Array.isArray(body.options))) {
    throw new MigrationError('VALIDATION_FAILED', 'options: atteso un oggetto');
  }
  const params: PlanParams = { scope: parseScope(body.scope), options: resolveMigrationOptions((body.options ?? null) as never) };
  const created = await startRun(c, {
    kind: 'plan',
    path: '/plan',
    body,
    params,
    preconditions: async () => {
      await requirePostgresMode();
      const preflight = await lastSucceededRun('preflight');
      if (!preflight) throw precondition('Esegui prima il preflight', ['PREFLIGHT_REQUIRED']);
      const summary = preflight.summary as unknown as PreflightSummary | null;
      if (!summary?.ready) {
        throw precondition('L\'ultimo preflight ha controlli bloccanti: risolvili e ripetilo', ['PREFLIGHT_BLOCKING'], {
          preflight_run_id: preflight.id,
          blocking: summary?.blocking ?? [],
        });
      }
    },
  });
  return respondRun(c, created, 'plan', { options: params.options, scope: params.scope });
});

function parseForceItemIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !ITEM_ID_RE.test(id))) {
    throw new MigrationError('VALIDATION_FAILED', 'force_item_ids: attesi id di righe dell\'anteprima');
  }
  if (value.length > 10_000) throw new MigrationError('VALIDATION_FAILED', 'force_item_ids: al più 10000 righe');
  return [...new Set(value as string[])];
}

function parseForceCodes(value: unknown): ConflictCode[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((code) => typeof code !== 'string' || !FORCEABLE_CONFLICTS.has(code as ConflictCode))) {
    throw new MigrationError('VALIDATION_FAILED', `force_codes: ammessi ${[...FORCEABLE_CONFLICTS].join(', ')}`);
  }
  return [...new Set(value as ConflictCode[])];
}

calendarMigration.post('/apply', async (c) => {
  const body = await readJsonBody(c);
  const planRunId = body.plan_run_id;
  if (typeof planRunId !== 'string' || !UUID_RE.test(planRunId)) throw new MigrationError('VALIDATION_FAILED', 'plan_run_id: atteso l\'id del run d\'anteprima');
  const expect = body.expect_plan_hash;
  if (expect !== undefined && expect !== null && (typeof expect !== 'string' || !HASH_RE.test(expect))) {
    throw new MigrationError('VALIDATION_FAILED', 'expect_plan_hash: atteso uno sha256 esadecimale');
  }
  const forceItemIds = parseForceItemIds(body.force_item_ids);
  const forceCodes = parseForceCodes(body.force_codes);
  requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.apply);
  const forcing = forceItemIds.length > 0 || forceCodes.length > 0;
  if (forcing) requireConfirmation(body.confirm_force, MIGRATION_CONFIRMATIONS.force);

  // Anteprima di riferimento: run 'plan' riuscito (opzioni e ambito dell'apply sono i suoi).
  const [plan] = await sql<Array<{ id: string; kind: string; status: MigrationRunStatus; params: Record<string, unknown> | null; summary: Record<string, unknown> | null; finished_at: Date | null }>>`
    SELECT id::text AS id, kind, status, params, summary, finished_at FROM cal_migration_runs WHERE id = ${planRunId.toLowerCase()}::uuid
  `;
  const planSummary = (plan?.summary ?? null) as unknown as (PlanSummary & { preview?: { blocking?: string[] } }) | null;
  const planHash = planSummary && typeof planSummary.plan_hash === 'string' && HASH_RE.test(planSummary.plan_hash) ? planSummary.plan_hash : null;
  const expected = (typeof expect === 'string' ? expect : null) ?? planHash;
  const options = resolveMigrationOptions(((plan?.params?.options ?? null) as never));
  const params = applyParamsFromPlan(plan?.params ?? null, { expected_plan_hash: expected, force_item_ids: forceItemIds, force_codes: forceCodes });
  params.options = options;

  const created = await startRun(c, {
    kind: 'apply',
    path: '/apply',
    body,
    params,
    planRunId: plan?.id ?? null,
    planHash,
    preconditions: async () => {
      const state = await requirePostgresMode();
      if (!plan || plan.kind !== 'plan' || plan.status !== 'succeeded' || !planHash) {
        throw precondition('Serve un\'anteprima riuscita: genera l\'anteprima e riprova', ['PLAN_REQUIRED'], { plan_run_id: planRunId });
      }
      const ageHours = (Date.now() - (plan.finished_at?.getTime() ?? 0)) / 3_600_000;
      if (ageHours > MIGRATION_LIMITS.planMaxAgeHours) {
        throw precondition(`Anteprima di più di ${MIGRATION_LIMITS.planMaxAgeHours} ore fa: rigenerala prima di applicare`, ['PLAN_STALE'], { plan_run_id: plan.id });
      }
      const blocking = Array.isArray(planSummary?.preview?.blocking) ? planSummary.preview.blocking : [];
      if (blocking.length) {
        throw precondition(`Anomalie bloccanti da risolvere in PG: ${blocking.join(', ')}`, ['PREFLIGHT_BLOCKING'], { anomalies: blocking });
      }
      const identity = await currentIdentityStatus(state);
      if (identity !== 'ok') throw precondition('Identità del volume non verificata: l\'apply scrive solo su un volume riconosciuto', ['IDENTITY_NOT_OK'], { identity });
    },
  });
  return respondRun(c, created, 'apply', {
    plan_run_id: plan?.id ?? null,
    forced_items: forceItemIds.length,
    forced_codes: forceCodes,
  });
});

calendarMigration.post('/verify', async (c) => {
  const body = await readJsonBody(c);
  let levels: VerifyLevel[] = [...VERIFY_LEVELS];
  if (body.levels !== undefined && body.levels !== null) {
    if (!Array.isArray(body.levels) || body.levels.length === 0 || body.levels.some((l) => !(VERIFY_LEVELS as readonly string[]).includes(l as string))) {
      throw new MigrationError('VALIDATION_FAILED', `levels: sottoinsieme non vuoto di ${VERIFY_LEVELS.join(', ')}`);
    }
    levels = VERIFY_LEVELS.filter((l) => (body.levels as string[]).includes(l));
  }
  let v4Days: number = MIGRATION_LIMITS.v4Days;
  if (body.v4_days !== undefined && body.v4_days !== null) {
    if (typeof body.v4_days !== 'number' || !Number.isInteger(body.v4_days) || body.v4_days < 1 || body.v4_days > 366) {
      throw new MigrationError('VALIDATION_FAILED', 'v4_days: intero da 1 a 366');
    }
    v4Days = body.v4_days;
  }
  const params: VerifyParams = { scope: parseScope(body.scope), levels, v4_days: v4Days };
  const created = await startRun(c, { kind: 'verify', path: '/verify', body, params, preconditions: async () => { await requirePostgresMode(); } });
  return respondRun(c, created, 'verify', { levels, v4_days: v4Days });
});

// ─── Run ───────────────────────────────

const RUN_KINDS_QUERY = new Set<string>(['preflight', 'init', 'archive', 'identity', 'inventory', 'plan', 'apply', 'verify', 'cutover', 'rollback_preview', 'rollback', 'rebaseline', 'finalize']);

function queryInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^[0-9]{1,6}$/.test(value)) throw new MigrationError('VALIDATION_FAILED', `${name}: atteso un intero positivo`);
  return Number(value);
}

calendarMigration.get('/runs', async (c) => {
  const kind = c.req.query('kind');
  if (kind !== undefined && !RUN_KINDS_QUERY.has(kind)) throw new MigrationError('VALIDATION_FAILED', 'kind non valido');
  const result = await listMigrationRuns({
    kind: kind as MigrationRunKind | undefined,
    status: c.req.query('status') as MigrationRunStatus | undefined,
    limit: queryInt(c.req.query('limit'), 'limit'),
    cursor: c.req.query('cursor') ?? null,
  });
  c.header('Cache-Control', 'no-store');
  return c.json(result);
});

calendarMigration.get('/runs/:id', async (c) => {
  const run = await getMigrationRun(c.req.param('id'));
  if (!run) throw new MigrationError('RUN_NOT_FOUND', 'Run di migrazione non trovato');
  c.header('Cache-Control', 'no-store');
  return c.json(run);
});

calendarMigration.get('/runs/:id/items', async (c) => {
  const q = (name: string): string | undefined => {
    const v = c.req.query(name);
    return v === undefined || v === '' ? undefined : v;
  };
  const expectedRaw = q('expected');
  if (expectedRaw !== undefined && expectedRaw !== 'true' && expectedRaw !== 'false') {
    throw new MigrationError('VALIDATION_FAILED', 'expected: true o false');
  }
  const filter: RunItemsFilter = {
    item_type: q('item_type') as MigrationItemType | undefined,
    code: q('code'),
    calendar_id: q('calendar_id'),
    action: q('action') as PlanAction | undefined,
    outcome: q('outcome') as RunItemsFilter['outcome'],
    level: q('level') as VerifyLevel | undefined,
    expected: expectedRaw === undefined ? undefined : expectedRaw === 'true',
    severity: q('severity') as ItemSeverity | undefined,
    cursor: q('cursor') ?? null,
    limit: queryInt(q('limit'), 'limit'),
  };
  c.header('Cache-Control', 'no-store');
  return c.json(await listRunItems(c.req.param('id'), filter));
});

calendarMigration.get('/runs/:id/report', async (c) => {
  const format = c.req.query('format') ?? 'json';
  if (format !== 'json' && format !== 'csv') throw new MigrationError('VALIDATION_FAILED', 'format: json o csv');
  const report = await buildRunReport(sql, c.req.param('id'), format);
  return new Response(report.body, {
    status: 200,
    headers: {
      'Content-Type': report.contentType,
      'Content-Disposition': `attachment; filename="${report.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

calendarMigration.post('/runs/:id/cancel', async (c) => {
  const run = await requestRunCancel(c.req.param('id'), actorOf(c));
  await audit(c, 'cancel', run.id, { kind: run.kind, status: run.status });
  return c.json({ run });
});

calendarMigration.post('/runs/:id/accept', async (c) => {
  const id = c.req.param('id');
  const body = await readJsonBody(c);
  requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.accept);
  const run = await getMigrationRun(id);
  if (!run) throw new MigrationError('RUN_NOT_FOUND', 'Run di migrazione non trovato');
  if (run.kind !== 'verify') {
    throw precondition('Le differenze si accettano solo su un run di verifica', ['RUN_KIND_NOT_VERIFY'], { kind: run.kind });
  }
  const itemIds = body.item_ids;
  if (itemIds !== undefined && itemIds !== null && (!Array.isArray(itemIds) || itemIds.some((x) => typeof x !== 'string' || !ITEM_ID_RE.test(x)))) {
    throw new MigrationError('VALIDATION_FAILED', 'item_ids: attesi id di righe');
  }
  const calendarId = body.calendar_id;
  if (calendarId !== undefined && calendarId !== null && (typeof calendarId !== 'string' || !UUID_RE.test(calendarId))) {
    throw new MigrationError('VALIDATION_FAILED', 'calendar_id: atteso un UUID');
  }
  const allExpected = optionalBoolean(body.all_expected, 'all_expected');
  const result = await acceptDiffs(sql, {
    runId: run.id,
    itemIds: (itemIds ?? undefined) as string[] | undefined,
    calendarId: (calendarId ?? undefined) as string | undefined,
    allExpected,
    actor: actorOf(c),
  });
  await audit(c, 'accept', run.id, {
    accepted: result.accepted,
    calendar_id: calendarId ?? null,
    all_expected: allExpected === true,
    items: Array.isArray(itemIds) ? itemIds.length : 0,
  });
  return c.json(result);
});

// ─── Shadow, parità e iscrizioni ───────────────────────────────

calendarMigration.post('/shadow', async (c) => {
  const body = await readJsonBody(c);
  if (typeof body.enabled !== 'boolean') throw new MigrationError('VALIDATION_FAILED', 'enabled: atteso un booleano');
  if (body.enabled) {
    requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.shadowOn);
    requireRadicaleConfigured();
  }
  const result = await setShadowEnabled({ enabled: body.enabled, actor: actorOf(c) });
  await audit(c, body.enabled ? 'shadow_on' : 'shadow_off', result.catch_up_run?.id ?? null, {
    shadow_enabled: result.shadow_enabled,
    catch_up_run_id: result.catch_up_run?.id ?? null,
  });
  return c.json(result);
});

calendarMigration.get('/parity', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await getParity(sql));
});

calendarMigration.get('/subscriptions', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ subscriptions: await listSubscriptionsForMigration(sql) });
});

calendarMigration.patch('/subscriptions/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw new MigrationError('VALIDATION_FAILED', 'Iscrizione non valida');
  const body = await readJsonBody(c);
  const flags = {
    blocks_availability: optionalBoolean(body.blocks_availability, 'blocks_availability'),
    device_visible: optionalBoolean(body.device_visible, 'device_visible'),
  };
  if (flags.blocks_availability === undefined && flags.device_visible === undefined) {
    throw new MigrationError('VALIDATION_FAILED', 'Indica almeno un flag (blocks_availability o device_visible)');
  }
  const result = await setSubscriptionMigrationFlags(id.toLowerCase(), flags, actorOf(c));
  await audit(c, 'subscription_flags', id.toLowerCase(), {
    blocks_availability: flags.blocks_availability ?? null,
    device_visible: flags.device_visible ?? null,
    collection_missing: result.collection_missing,
  });
  return c.json(result);
});

// ─── Transizioni della F4 ───────────────────────────────

/** Frase da digitare per riprendere una transizione del tipo dato (contratto f4-modules §6.1). */
const RESUME_CONFIRMATIONS: Readonly<Record<TransitionKind, string>> = Object.freeze({
  cutover: MIGRATION_CONFIRMATIONS.cutover,
  rollback: MIGRATION_CONFIRMATIONS.rollback,
  finalize: MIGRATION_CONFIRMATIONS.finalize,
});

const TRANSITION_LABELS: Readonly<Record<TransitionKind, string>> = Object.freeze({
  cutover: 'passaggio a Radicale',
  rollback: 'ritorno a Postgres',
  finalize: 'chiusura della finestra di rollback',
});

/** 409 TRANSITION_IN_PROGRESS se una transizione è attiva (anche ferma, da riprendere o annullare). */
async function requireNoActiveTransition(): Promise<void> {
  const view = await currentTransitionView(sql);
  if (view && view.status === 'active') throw transitionInProgress(view);
}

function transitionInProgress(view: TransitionView): MigrationError {
  const how = view.resumable ? (view.abortable ? 'riprendila o annullala' : 'riprendila') : 'attendi che il run finisca';
  return new MigrationError(
    'TRANSITION_IN_PROGRESS',
    `È attiva una transizione (${TRANSITION_LABELS[view.kind]}${view.next_step ? `, passo ${view.next_step}` : ''}): ${how} prima di avviarne un'altra.`,
    { transition: view, reasons: ['TRANSITION_ACTIVE'] },
  );
}

/** Transizione attiva del tipo richiesto (PRECONDITION_FAILED NO_ACTIVE_TRANSITION altrimenti). */
/** Messaggio dell'annullamento rifiutato con il passo d'epoch iniziato ma non concluso (null se non è il caso). */
function epochStartedNotDone(view: TransitionView): string | null {
  const epoch = view.steps.find((s) => s.step === 'epoch');
  return epoch && epoch.status !== 'done' ? 'passo d\'epoch iniziato: riprendi il passaggio' : null;
}

async function requireActiveTransition(kinds: readonly TransitionKind[]): Promise<TransitionView> {
  const view = await currentTransitionView(sql);
  if (!view || view.status !== 'active' || !kinds.includes(view.kind)) {
    throw precondition(
      kinds.length === 1 ? `Nessuna transizione di ${TRANSITION_LABELS[kinds[0]]} attiva` : 'Nessuna transizione attiva da riprendere',
      ['NO_ACTIVE_TRANSITION'],
      { transition: view },
    );
  }
  return view;
}

async function requireRadicaleMode(): Promise<Awaited<ReturnType<typeof readMigrationState>>> {
  const state = await readMigrationState(sql);
  if (state.mode !== 'radicale') {
    throw precondition(`Serve il backend in mode radicale (ora ${state.mode})`, ['MODE_NOT_RADICALE'], { mode: state.mode });
  }
  return state;
}

function requireRollbackWindowOpen(state: Awaited<ReturnType<typeof readMigrationState>>, now: Date = new Date()): void {
  const until = state.rollback_until ? state.rollback_until.getTime() : 0;
  if (until <= now.getTime()) {
    throw precondition(
      state.rollback_until ? `Finestra di rollback scaduta il ${state.rollback_until.toISOString()}` : 'Nessuna finestra di rollback aperta',
      ['ROLLBACK_WINDOW_EXPIRED'],
      { rollback_until: state.rollback_until ? state.rollback_until.toISOString() : null },
    );
  }
}

function parseWindowDays(value: unknown): number {
  if (value === undefined || value === null) return defaultRollbackWindowDays();
  if (typeof value !== 'number' || !Number.isInteger(value) || value < F4_LIMITS.rollbackWindowMinDays || value > F4_LIMITS.rollbackWindowMaxDays) {
    throw new MigrationError('VALIDATION_FAILED', `rollback_window_days: intero da ${F4_LIMITS.rollbackWindowMinDays} a ${F4_LIMITS.rollbackWindowMaxDays}`);
  }
  return value;
}

function optionalRunId(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new MigrationError('VALIDATION_FAILED', `${name}: atteso l'id (UUID) di un run`);
  return value.toLowerCase();
}

function optionalHash(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new MigrationError('VALIDATION_FAILED', `${name}: atteso uno sha256 esadecimale`);
  return value;
}

function stringFrom(data: Record<string, unknown>, key: string, re: RegExp): string | null {
  const v = data[key];
  return typeof v === 'string' && re.test(v) ? v.toLowerCase() : null;
}

/** Stato della transizione attiva o dell'ultima conclusa (null se non ce n'è mai stata una). */
calendarMigration.get('/transition', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await currentTransitionView(sql));
});

/** Salute della proiezione inversa (Radicale → calendar_events) durante la finestra di rollback. */
calendarMigration.get('/reverse', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await readReverseProjectionHealth(sql));
});

calendarMigration.post('/cutover', async (c) => {
  const body = await readJsonBody(c);
  requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.cutover);
  const params: CutoverParams = {
    action: 'start',
    rollback_window_days: parseWindowDays(body.rollback_window_days),
    verify_run_id: optionalRunId(body.verify_run_id, 'verify_run_id'),
  };
  const created = await startRun(c, {
    kind: 'cutover',
    path: '/cutover',
    body,
    params,
    transition: requireNoActiveTransition,
    preconditions: async () => {
      await requirePostgresMode();
      // Stessi criteri del passo di preflight del run (che li ricontrolla dopo un giro del control-plane).
      await assertCutoverReady(sql, { verifyRunId: params.verify_run_id });
    },
  });
  return respondRun(c, created, 'cutover_start', { rollback_window_days: params.rollback_window_days, verify_run_id: params.verify_run_id });
});

calendarMigration.post('/cutover/abort', async (c) => {
  const body = await readJsonBody(c);
  requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.cutoverAbort);
  let transitionId: string | null = null;
  const created = await startRun(c, {
    kind: 'cutover',
    path: '/cutover/abort',
    body,
    params: { action: 'abort', rollback_window_days: defaultRollbackWindowDays(), verify_run_id: null } satisfies CutoverParams,
    preconditions: async () => {
      const view = await requireActiveTransition(['cutover']);
      transitionId = view.id;
      if (!view.abortable) {
        throw precondition(epochStartedNotDone(view) ?? 'Il passaggio ha superato il passo d\'epoch: non si annulla più, resta solo il rollback', ['TRANSITION_NOT_ABORTABLE'], { transition: view });
      }
    },
  });
  return respondRun(c, created, 'cutover_abort', { transition_id: transitionId });
});

calendarMigration.post('/transition/resume', async (c) => {
  const body = await readJsonBody(c);
  // Replay anticipato (F4R3-05): se il primo invio è riuscito ma la risposta si è persa e la transizione si è conclusa
  // prima del nuovo tentativo, la stessa chiave con lo stesso corpo riceve il run già creato, non 412.
  const resumeKey = idempotencyKeyOf(c, body);
  if (resumeKey) {
    const replay = await replayMigrationRun(resumeKey, requestHashOf('/transition/resume', body));
    if (replay) {
      const latest = await currentTransitionView(sql);
      return respondRun(c, replay, 'transition_resume', { transition_id: latest?.id ?? null, transition_kind: latest?.kind ?? null, next_step: null });
    }
  }
  const view = await currentTransitionView(sql);
  if (!view || view.status !== 'active') {
    throw precondition('Nessuna transizione attiva da riprendere', ['NO_ACTIVE_TRANSITION'], { transition: view });
  }
  requireConfirmation(body.confirm, RESUME_CONFIRMATIONS[view.kind]);
  const data = view.data ?? {};
  let params: CutoverParams | RollbackParams | FinalizeParams;
  if (view.kind === 'cutover') {
    const days = typeof data.rollback_window_days === 'number' && Number.isInteger(data.rollback_window_days)
      && data.rollback_window_days >= F4_LIMITS.rollbackWindowMinDays && data.rollback_window_days <= F4_LIMITS.rollbackWindowMaxDays
      ? data.rollback_window_days : defaultRollbackWindowDays();
    params = { action: 'resume', rollback_window_days: days, verify_run_id: stringFrom(data, 'verify_run_id', UUID_RE) };
  } else if (view.kind === 'rollback') {
    params = {
      action: 'resume',
      preview_run_id: stringFrom(data, 'preview_run_id', UUID_RE),
      expect_preview_hash: stringFrom(data, 'expect_preview_hash', HASH_RE),
      emergency: data.emergency === true,
    };
  } else {
    params = { action: 'resume' };
  }
  const created = await startRun(c, {
    kind: view.kind,
    path: '/transition/resume',
    body,
    params,
    preconditions: async () => {
      // La transizione può essere cambiata fra la lettura e la creazione del run.
      const now = await requireActiveTransition([view.kind]);
      if (now.id !== view.id) throw precondition('La transizione attiva è cambiata: ricarica il wizard', ['NO_ACTIVE_TRANSITION'], { transition: now });
    },
  });
  return respondRun(c, created, 'transition_resume', { transition_id: view.id, transition_kind: view.kind, next_step: view.next_step });
});

calendarMigration.post('/rollback/preview', async (c) => {
  const body = await readJsonBody(c);
  const params: RollbackPreviewParams = { scope: parseScope(body.scope) };
  const created = await startRun(c, {
    kind: 'rollback_preview',
    path: '/rollback/preview',
    body,
    params,
    transition: requireNoActiveTransition,
    preconditions: async () => {
      const state = await requireRadicaleMode();
      requireRollbackWindowOpen(state);
    },
  });
  return respondRun(c, created, 'rollback_preview', { scope: params.scope });
});

calendarMigration.post('/rollback', async (c) => {
  const body = await readJsonBody(c);
  const previewRunId = optionalRunId(body.preview_run_id, 'preview_run_id');
  if (!previewRunId) throw new MigrationError('VALIDATION_FAILED', 'preview_run_id: atteso l\'id del run d\'anteprima del rollback');
  const expect = optionalHash(body.expect_preview_hash, 'expect_preview_hash');
  const emergency = optionalBoolean(body.emergency, 'emergency') === true;
  requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.rollback);
  if (emergency) requireConfirmation(body.confirm_emergency, MIGRATION_CONFIRMATIONS.rollbackEmergency);

  const preview = await rollbackPreviewValidity(sql, previewRunId);
  const params: RollbackParams = {
    action: 'start',
    preview_run_id: previewRunId,
    expect_preview_hash: expect ?? preview.preview_hash,
    emergency,
  };
  const created = await startRun(c, {
    kind: 'rollback',
    path: '/rollback',
    body,
    params,
    transition: requireNoActiveTransition,
    preconditions: async () => {
      const state = await requireRadicaleMode();
      requireRollbackWindowOpen(state);
      if (!preview.ok) throw precondition(preview.message ?? 'Serve un\'anteprima del rollback riuscita', [preview.reason ?? 'PREVIEW_REQUIRED'], { preview_run_id: previewRunId });
      if (expect && preview.preview_hash && expect !== preview.preview_hash) {
        throw precondition('L\'anteprima confermata non corrisponde al run indicato: rigenerala e riprova', ['PREVIEW_STALE'], { preview_run_id: previewRunId });
      }
      const identity = await currentIdentityStatus(state);
      if (identity !== 'ok') throw precondition('Identità del volume non verificata: il rollback parte solo da un volume riconosciuto', ['IDENTITY_NOT_OK'], { identity });
    },
  });
  return respondRun(c, created, 'rollback_start', { preview_run_id: previewRunId, emergency });
});

calendarMigration.post('/rollback/abort', async (c) => {
  const body = await readJsonBody(c);
  requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.cutoverAbort);
  let transitionId: string | null = null;
  const created = await startRun(c, {
    kind: 'rollback',
    path: '/rollback/abort',
    body,
    params: { action: 'abort', preview_run_id: null, expect_preview_hash: null, emergency: false } satisfies RollbackParams,
    preconditions: async () => {
      const view = await requireActiveTransition(['rollback']);
      transitionId = view.id;
      if (!view.abortable) {
        throw precondition(epochStartedNotDone(view) ?? 'Il rollback ha superato il passo d\'epoch: non si annulla più, va ripreso fino in fondo', ['TRANSITION_NOT_ABORTABLE'], { transition: view });
      }
    },
  });
  return respondRun(c, created, 'rollback_abort', { transition_id: transitionId });
});

calendarMigration.post('/finalize', async (c) => {
  const body = await readJsonBody(c);
  requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.finalize);
  const params: FinalizeParams = { action: 'start' };
  const created = await startRun(c, {
    kind: 'finalize',
    path: '/finalize',
    body,
    params,
    transition: requireNoActiveTransition,
    preconditions: async () => {
      await requireRadicaleMode();
      const blockers = await finalizeBlockersOf(sql);
      if (blockers.length) {
        throw precondition(`La finestra di rollback non si può ancora chiudere (${blockers.join(', ')})`, blockers);
      }
    },
  });
  return respondRun(c, created, 'finalize');
});

calendarMigration.post('/rebaseline', async (c) => {
  const body = await readJsonBody(c);
  requireConfirmation(body.confirm, MIGRATION_CONFIRMATIONS.apply);
  const params: RebaselineParams = { scope: parseScope(body.scope), reason: 'manual' };
  const created = await startRun(c, {
    kind: 'rebaseline',
    path: '/rebaseline',
    body,
    params,
    transition: requireNoActiveTransition,
    preconditions: async () => {
      const state = await requirePostgresMode();
      const identity = await currentIdentityStatus(state);
      if (identity !== 'ok') throw precondition('Identità del volume non verificata: la ri-baseline legge solo un volume riconosciuto', ['IDENTITY_NOT_OK'], { identity });
    },
  });
  return respondRun(c, created, 'rebaseline', { scope: params.scope });
});
