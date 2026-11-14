/**
 * Specchio su Radicale delle iscrizioni visibili ai device (fase F2 del
 * passaggio a Radicale; design §1 invariante 1, §5 "UID e href", §6.6;
 * decisione 5; contratto dei moduli docs/calendar-radicale/contracts/
 * f2-modules.md §3 e §8.3).
 *
 * La fonte di un'iscrizione è il feed remoto e la sua cache sta nell'indice
 * (subscriptions/pull.ts). Solo per le iscrizioni con device_visible = true
 * Radicale ne riceve una copia nella collezione `sub-<id8>`, in sola lettura
 * per i device (role='subscription' nella policy) e ignorata dal watcher.
 *
 * Job `subscription_mirror` (chiave = id dell'iscrizione, source_version =
 * index_version del sidecar, priorità bassa), accodato dal pull nella stessa
 * transazione dell'indice quando qualcosa cambia. L'handler è convergente e
 * idempotente: lo stato desiderato si calcola all'esecuzione dall'indice,
 * mai dal payload:
 *  - iscrizione non visibile (o sparita) → nessuna richiesta a Radicale,
 *    nemmeno un PROPFIND;
 *  - collezione `sub-<id8>` assente → CalendarJobPermanentError e avviso:
 *    la crea solo il wizard della F3, mai MKCALENDAR da qui;
 *  - confronto per fingerprint semantico fra gli oggetti 'ok' dell'indice e
 *    il contenuto corrente della collezione (PROPFIND degli ETag, multiget
 *    solo per gli href il cui ETag non è nel registro di quanto già scritto);
 *  - PUT solo dei cambiati, con If-None-Match: * (nuovi) o If-Match (ETag
 *    letto); DELETE con If-Match delle risorse r-*.ics non più nel feed. Gli
 *    oggetti in quarantena nell'indice non si toccano (resta l'ultima copia
 *    buona); i file con un nome che lo specchio non produce non si cancellano;
 *  - al massimo 5 scritture al secondo per processo
 *    (INDEX_LIMITS.maxMirrorPutsPerSecond), ognuna dentro il gate cal-write
 *    (radicale/write-gate.ts: in cutover e rollback 503 'transition', con
 *    write_freeze sullo store Radicale 503 'write_freeze' → nuovo tentativo
 *    del job), con l'identità del volume verificata.
 * Nessun write-through: l'indice del sidecar si alimenta dal feed, non da
 * Radicale (syncCollection lo salta per role='subscription').
 *
 * Errori: CalendarUnavailableError e RadicaleError transitori → nuovo
 * tentativo con backoff (jobs.ts); collezione assente o configurazione
 * incoerente → dead letter con avviso; una singola risorsa rifiutata da
 * Radicale (400, UID in conflitto) → avviso e si prosegue con le altre.
 */

import { parseCalendarObject, semanticFingerprint } from '@calicchia/calendar-core';
import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { CalendarUnavailableError } from '../errors';
import { REMOTE_HREF_RE } from '../ics-split';
import { INDEX_LIMITS } from '../index-model';
import {
  CAL_JOB_KINDS,
  CAL_JOB_PRIORITY,
  type CalendarJob,
  type CalendarJobContext,
  type CalendarJobOutcome,
  CalendarJobPermanentError,
  enqueueCalendarJob,
  registerCalendarJobHandler,
} from '../jobs';
import { collectionPath, objectPath, type RadicaleClient } from '../radicale/client';
import { DAV_PROPS } from '../radicale/dav-xml';
import { isRadicaleError } from '../radicale/errors';
import { raiseIndexAlert } from '../radicale/health';
import type { Db } from '../radicale/policy';
import { radicaleRuntime, verifyVolumeIdentity } from '../radicale/sync';
import { withCalendarWriteGate } from '../radicale/write-gate';

const log: Logger = rootLogger.child({ scope: 'subscription-mirror' });

// ─── Costanti ───────────────────────────────

/** Lease del job: lo specchio di un feed grande a 5 scritture/s dura minuti (lease prolungato durante il lavoro). */
export const MIRROR_LEASE_MS = 300_000;
/** Ogni quanto si prolunga il lease durante il lavoro. */
const LEASE_EXTEND_EVERY_MS = 60_000;
/** Intervallo minimo fra due scritture dello specchio nel processo. */
const MIN_WRITE_INTERVAL_MS = Math.ceil(1000 / INDEX_LIMITS.maxMirrorPutsPerSecond);
/** Nome della collezione di un'iscrizione: `sub-<id8>` (design §5; più lungo solo in caso di collisione). */
const SUBSCRIPTION_COLLECTION_RE = /^sub-[0-9a-f]{8,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Tipi ───────────────────────────────

export interface MirrorResult {
  put: number;
  deleted: number;
  unchanged: number;
  /** Risorse rifiutate da Radicale (400, UID in conflitto): avviso, nessun nuovo tentativo. */
  failed: number;
  /** Motivo per cui non si è fatto nulla (iscrizione non visibile o sparita), null se lo specchio è girato. */
  skipped: string | null;
  /** index_version del sidecar a fine lavoro (versione della sorgente per jobs.ts), null se non letta. */
  indexVersion: string | null;
}

export interface MirrorContext {
  signal: AbortSignal;
  /** Prolunga il lease del job (ctx.extendLease di jobs.ts) durante i lavori lunghi. */
  extendLease?: () => Promise<boolean>;
}

interface MirrorTarget {
  id: string;
  device_visible: boolean;
  collection_calendar_id: string | null;
  collection_name: string | null;
  role: string | null;
  lifecycle: string | null;
}

interface CurrentResource {
  /** href assoluto e codificato restituito da Radicale (per il multiget). */
  href: string;
  etag: string | null;
}

// ─── Registro di quanto scritto (in memoria) ───────────────────────────────

/**
 * Registro per href (design §6.6, "ledger per href"): ETag restituito da
 * Radicale e fingerprint del testo scritto. Se l'ETag corrente coincide,
 * il contenuto è quello scritto dallo specchio (i device non scrivono le
 * `sub-*`) e non serve rileggerlo. Solo in memoria: dopo un riavvio il primo
 * giro rilegge la collezione con il multiget.
 */
const ledger = new Map<string, Map<string, { etag: string; fp: string }>>();

function ledgerOf(collection: string): Map<string, { etag: string; fp: string }> {
  let m = ledger.get(collection);
  if (!m) {
    m = new Map();
    ledger.set(collection, m);
  }
  return m;
}

/** Dimentica il registro (tutto o di una collezione): il prossimo giro rilegge il contenuto da Radicale. */
export function resetSubscriptionMirrorLedger(collectionName?: string): void {
  if (collectionName) ledger.delete(collectionName);
  else ledger.clear();
}

// ─── Utilità ───────────────────────────────

let nextWriteAt = 0;

/** Al massimo maxMirrorPutsPerSecond scritture al secondo nel processo (tutte le iscrizioni insieme). */
async function throttleWrite(signal: AbortSignal): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextWriteAt);
  nextWriteAt = at + MIN_WRITE_INTERVAL_MS;
  const wait = at - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  throwIfAborted(signal);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    throw reason instanceof Error ? reason : new Error('specchio dell\'iscrizione interrotto');
  }
}

/** Fingerprint semantico di un testo letto da Radicale (null se illeggibile: si riscrive). */
function fingerprintOfText(text: string | null): string | null {
  if (!text) return null;
  const parsed = parseCalendarObject(text, { malformedLines: 'skip' });
  if (!parsed.ok) return null;
  try {
    return semanticFingerprint(parsed.value);
  } catch {
    return null;
  }
}

function noopResult(skipped: string, indexVersion: string | null = null): MirrorResult {
  return { put: 0, deleted: 0, unchanged: 0, failed: 0, skipped, indexVersion };
}

async function loadTarget(subscriptionId: string): Promise<MirrorTarget | null> {
  if (!UUID_RE.test(subscriptionId)) return null;
  const [row] = await sql<MirrorTarget[]>`
    SELECT s.id, s.device_visible, s.collection_calendar_id, c.collection_name, c.role, c.lifecycle
    FROM calendar_subscriptions s
    LEFT JOIN calendars c ON c.id = s.collection_calendar_id
    WHERE s.id = ${subscriptionId}::uuid
  `;
  return row ?? null;
}

async function indexVersionOf(calendarId: string): Promise<string | null> {
  const [row] = await sql<Array<{ index_version: string }>>`
    SELECT index_version::text AS index_version FROM cal_collection_state WHERE calendar_id = ${calendarId}
  `;
  return row?.index_version ?? null;
}

/** Ultimo segmento decodificato di un href del server (il testo grezzo se la codifica non è valida). */
function lastSegment(href: string): string {
  const last = href.split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Contenuto corrente della collezione: nome → href ed ETag (PROPFIND Depth 1). */
async function listCollection(client: RadicaleClient, path: string): Promise<Map<string, CurrentResource>> {
  const ms = await client.propfind(path, { props: [DAV_PROPS.getetag], depth: 1 });
  const out = new Map<string, CurrentResource>();
  const self = decodeURIComponent(path).replace(/\/+$/, '');
  for (const r of ms.responses) {
    if (r.path.replace(/\/+$/, '') === self) continue; // la collezione stessa
    if (r.status !== null && r.status !== 200) continue;
    const name = r.name;
    if (!name) continue;
    out.set(name, { href: r.href, etag: r.text(DAV_PROPS.getetag) });
  }
  return out;
}

// ─── Specchio ───────────────────────────────

/**
 * Porta la collezione `sub-<id8>` di Radicale allo stato dell'indice del
 * sidecar dell'iscrizione (testa del file). Iscrizione non visibile ai device
 * → nessuna richiesta a Radicale. Lancia CalendarJobPermanentError se la
 * collezione manca o la configurazione è incoerente, CalendarUnavailableError
 * se Radicale non è utilizzabile adesso (non configurato, identità diversa da
 * ok, transizione, freeze) e gli errori del client per i guasti transitori.
 */
export async function mirrorSubscription(subscriptionId: string, ctx: MirrorContext): Promise<MirrorResult> {
  const target = await loadTarget(subscriptionId);
  if (!target) return noopResult('iscrizione inesistente');
  if (!target.device_visible) return noopResult('iscrizione non visibile ai device');

  const sidecarId = target.collection_calendar_id;
  const collection = target.collection_name;
  if (!sidecarId || target.role !== 'subscription' || !collection || !SUBSCRIPTION_COLLECTION_RE.test(collection)) {
    raiseIndexAlert('subscription-mirror-config', 'Iscrizione visibile ai device senza un sidecar sub-* valido: specchio impossibile', {
      key: subscriptionId,
      subscriptionId,
      calendarId: sidecarId ?? undefined,
    });
    throw new CalendarJobPermanentError(`iscrizione ${subscriptionId}: sidecar sub-* assente o non valido, specchio impossibile`);
  }
  if (target.lifecycle !== 'active') {
    throw new CalendarUnavailableError('transition', `sidecar ${sidecarId} in lifecycle ${target.lifecycle ?? '?'}`);
  }

  const rt = radicaleRuntime();
  const client = rt.client;
  if (!client) throw new CalendarUnavailableError('radicale_unreachable', rt.unavailableReason ?? 'Radicale non configurato');
  const { check } = await verifyVolumeIdentity();
  if (check.status !== 'ok') {
    throw new CalendarUnavailableError(
      check.status === 'mismatch' ? 'identity_mismatch' : 'identity_unverified',
      `specchio dell'iscrizione sospeso: identità del volume ${check.status}`,
    );
  }
  throwIfAborted(ctx.signal);

  // Stato desiderato: gli oggetti 'ok' dell'indice; quelli in quarantena restano com'erano in Radicale.
  const rows = await sql<Array<{ href: string; raw_ics: string | null; semantic_fp: string | null; health: string }>>`
    SELECT href, raw_ics, semantic_fp, health
    FROM cal_objects
    WHERE calendar_id = ${sidecarId} AND origin_store = 'remote'
  `;
  const desired = new Map<string, { raw: string; fp: string | null }>();
  const keep = new Set<string>();
  for (const r of rows) {
    if (r.health === 'ok' && r.raw_ics) desired.set(r.href, { raw: r.raw_ics, fp: r.semantic_fp ?? fingerprintOfText(r.raw_ics) });
    else keep.add(r.href);
  }

  // Stato corrente della collezione: mai MKCALENDAR (la crea il wizard della F3).
  const path = collectionPath(rt.principal, collection);
  let current: Map<string, CurrentResource>;
  try {
    current = await listCollection(client, path);
  } catch (err) {
    if (isRadicaleError(err, 'not_found')) {
      raiseIndexAlert('subscription-mirror-missing', `Collezione ${collection} assente in Radicale: specchio dell'iscrizione sospeso (la crea il wizard)`, {
        key: collection,
        subscriptionId,
        calendarId: sidecarId,
      });
      throw new CalendarJobPermanentError(`collezione ${collection} assente in Radicale: nessuna MKCALENDAR dallo specchio`, { cause: err });
    }
    throw err;
  }

  const known = ledgerOf(collection);
  for (const name of [...known.keys()]) if (!current.has(name)) known.delete(name);

  // Fingerprint correnti: dal registro se l'ETag coincide, altrimenti multiget.
  const currentFp = new Map<string, string | null>();
  const toRead: string[] = [];
  for (const [name, res] of current) {
    if (!desired.has(name)) continue;
    const entry = known.get(name);
    if (entry && res.etag && entry.etag === res.etag) currentFp.set(name, entry.fp);
    else toRead.push(name);
  }
  for (let i = 0; i < toRead.length; i += INDEX_LIMITS.multigetBatch) {
    throwIfAborted(ctx.signal);
    const names = toRead.slice(i, i + INDEX_LIMITS.multigetBatch);
    const got = await client.calendarMultiget(path, names.map((n) => (current.get(n) as CurrentResource).href));
    for (const obj of got.objects) {
      currentFp.set(obj.name, fingerprintOfText(obj.data));
      const res = current.get(obj.name);
      if (res && obj.etag) res.etag = obj.etag;
    }
    for (const missing of got.missing) {
      current.delete(lastSegment(missing)); // sparita fra PROPFIND e multiget: si ricrea
    }
  }

  const result: MirrorResult = { put: 0, deleted: 0, unchanged: 0, failed: 0, skipped: null, indexVersion: null };
  let lastExtend = Date.now();
  const maybeExtend = async (): Promise<void> => {
    if (ctx.extendLease && Date.now() - lastExtend >= LEASE_EXTEND_EVERY_MS) {
      lastExtend = Date.now();
      await ctx.extendLease().catch(() => false);
    }
  };

  const objectUrl = (name: string): string => objectPath(rt.principal, collection, name);

  // PUT dei nuovi e dei cambiati.
  for (const [name, want] of desired) {
    const cur = current.get(name);
    if (cur && want.fp !== null && currentFp.get(name) === want.fp) {
      result.unchanged++;
      if (cur.etag) known.set(name, { etag: cur.etag, fp: want.fp });
      continue;
    }
    await throttleWrite(ctx.signal);
    await maybeExtend();
    const outcome = await putResource(client, objectUrl(name), want.raw, cur?.etag ?? null, Boolean(cur));
    if (outcome.kind === 'rejected') {
      result.failed++;
      known.delete(name);
      raiseIndexAlert('subscription-mirror-rejected', `Radicale ha rifiutato una risorsa dello specchio dell'iscrizione (${outcome.code})`, {
        subscriptionId,
        calendarId: sidecarId,
        href: name,
      });
      continue;
    }
    result.put++;
    if (outcome.etag && want.fp) known.set(name, { etag: outcome.etag, fp: want.fp });
    else known.delete(name);
  }

  // DELETE delle risorse dello specchio non più nel feed (mai quelle in quarantena né i nomi estranei).
  for (const [name, cur] of current) {
    if (desired.has(name) || keep.has(name)) continue;
    if (!REMOTE_HREF_RE.test(name)) {
      log.warn({ subscriptionId, collection, href: name }, 'risorsa estranea nella collezione dello specchio: lasciata com\'è');
      continue;
    }
    await throttleWrite(ctx.signal);
    await maybeExtend();
    await deleteResource(client, objectUrl(name), cur.etag);
    known.delete(name);
    result.deleted++;
  }

  result.indexVersion = await indexVersionOf(sidecarId);
  if (result.put > 0 || result.deleted > 0 || result.failed > 0) {
    log.info({ subscriptionId, collection, ...result }, 'specchio dell\'iscrizione aggiornato');
  }
  return result;
}

type PutOutcome = { kind: 'written'; etag: string | null } | { kind: 'rejected'; code: string };

/**
 * PUT dentro il gate: If-None-Match: * per una risorsa nuova, If-Match con
 * l'ETag letto per una esistente. Un 412 (cambiata o comparsa nel frattempo)
 * rilegge l'ETag una volta e ripete; al secondo 412 l'errore va al job, che
 * riproverà. 400 e UID in conflitto: la risorsa è rifiutata, si prosegue.
 */
async function putResource(client: RadicaleClient, path: string, raw: string, etag: string | null, exists: boolean): Promise<PutOutcome> {
  let currentEtag = etag;
  let present = exists;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await withCalendarWriteGate(() => client.put(path, raw, present ? { ifMatch: currentEtag ?? '*' } : { ifNoneMatch: '*' }));
      return { kind: 'written', etag: res.etag };
    } catch (err) {
      if (isRadicaleError(err, 'bad_request') || isRadicaleError(err, 'uid_conflict')) {
        return { kind: 'rejected', code: (err as { code: string }).code };
      }
      if (!isRadicaleError(err, 'precondition_failed') || attempt >= 1) throw err;
      // Rilettura dell'ETag corrente (o dell'assenza) e un solo nuovo tentativo.
      try {
        const got = await client.get(path);
        present = true;
        currentEtag = got.etag;
      } catch (getErr) {
        if (!isRadicaleError(getErr, 'not_found')) throw getErr;
        present = false;
        currentEtag = null;
      }
    }
  }
}

/** DELETE dentro il gate con If-Match (ETag letto, o '*'); già sparita → ok; 412 → rilettura e un nuovo tentativo. */
async function deleteResource(client: RadicaleClient, path: string, etag: string | null): Promise<void> {
  let currentEtag = etag;
  for (let attempt = 0; ; attempt++) {
    try {
      await withCalendarWriteGate(() => client.delete(path, { ifMatch: currentEtag ?? '*' }));
      return;
    } catch (err) {
      if (isRadicaleError(err, 'not_found')) return;
      if (!isRadicaleError(err, 'precondition_failed') || attempt >= 1) throw err;
      try {
        currentEtag = (await client.get(path)).etag;
      } catch (getErr) {
        if (isRadicaleError(getErr, 'not_found')) return;
        throw getErr;
      }
    }
  }
}

// ─── Job ───────────────────────────────

/**
 * Accoda (o fonde nel pending con la stessa chiave) lo specchio di
 * un'iscrizione. Con `db` dentro la transazione del chiamante (outbox: il pull
 * lo accoda nella transazione dell'indice). source_version = index_version del
 * sidecar: se a fine lavoro l'indice è cambiato il job si riaccoda.
 */
export async function enqueueSubscriptionMirror(subscriptionId: string, opts: { indexVersion: string; db?: Db }): Promise<void> {
  await enqueueCalendarJob(
    CAL_JOB_KINDS.subscriptionMirror,
    subscriptionId,
    { indexVersion: opts.indexVersion },
    { sourceVersion: opts.indexVersion, priority: CAL_JOB_PRIORITY.low, db: opts.db },
  );
}

/**
 * Accoda lo specchio con l'index_version corrente del sidecar (per chi rende
 * visibile un'iscrizione, es. il wizard della F3). Non fa nulla se
 * l'iscrizione non è visibile o non ha un sidecar.
 */
export async function requestSubscriptionMirror(subscriptionId: string, db: Db = sql): Promise<boolean> {
  if (!UUID_RE.test(subscriptionId)) return false;
  const [row] = await db<Array<{ device_visible: boolean; index_version: string | null }>>`
    SELECT s.device_visible, st.index_version::text AS index_version
    FROM calendar_subscriptions s
    LEFT JOIN cal_collection_state st ON st.calendar_id = s.collection_calendar_id
    WHERE s.id = ${subscriptionId}::uuid AND s.collection_calendar_id IS NOT NULL
  `;
  if (!row?.device_visible) return false;
  await enqueueSubscriptionMirror(subscriptionId, { indexVersion: row.index_version ?? '0', db });
  return true;
}

/**
 * Errori del client che un nuovo tentativo non risolve (contratto §1.4: un
 * RadicaleError non transitorio va in dead letter): credenziali o permessi di
 * caldes-svc, configurazione, richiesta rifiutata. 5xx, rete, timeout e 412
 * restano ripetibili.
 */
const PERMANENT_RADICALE_CODES = new Set(['unauthorized', 'forbidden', 'configuration', 'bad_request', 'conflict']);

async function handleMirrorJob(job: CalendarJob, ctx: CalendarJobContext): Promise<CalendarJobOutcome> {
  let result: MirrorResult;
  try {
    result = await mirrorSubscription(job.key, { signal: ctx.signal, extendLease: () => ctx.extendLease() });
  } catch (err) {
    if (isRadicaleError(err) && PERMANENT_RADICALE_CODES.has(err.code) && !err.outcomeUnknown) {
      raiseIndexAlert('subscription-mirror-failed', `Specchio dell'iscrizione non eseguibile (${err.code}): job in dead letter`, {
        key: job.key,
        subscriptionId: job.key,
        status: err.status ?? undefined,
      });
      throw new CalendarJobPermanentError(`specchio dell'iscrizione ${job.key}: ${err.message}`, { cause: err });
    }
    throw err;
  }
  // Iscrizione non visibile o sparita: nessuna versione da confrontare (il job si chiude).
  return result.skipped !== null || result.indexVersion === null
    ? { result }
    : { result, currentSourceVersion: result.indexVersion };
}

/** Registra l'handler del job subscription_mirror (bootstrap, prima di startCalendarJobWorker). Idempotente. */
export function registerSubscriptionMirrorJob(): void {
  registerCalendarJobHandler(CAL_JOB_KINDS.subscriptionMirror, handleMirrorJob, { leaseMs: MIRROR_LEASE_MS });
}
