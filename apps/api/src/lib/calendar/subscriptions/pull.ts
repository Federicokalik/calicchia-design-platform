/**
 * Pull delle iscrizioni ICS verso l'indice derivato (fase F2 del passaggio a
 * Radicale; design §1 invariante 1, §6.6, §9, §14 "parseIcs rotto e trappola
 * del 304"; contratto dei moduli docs/calendar-radicale/contracts/
 * f2-modules.md §1.5, §2.7 e §8.2).
 *
 * Le iscrizioni hanno come fonte il feed remoto: l'indice ne tiene solo una
 * cache (oggetti origin_store='remote' del sidecar role='subscription'), senza
 * versioni (cal_object_versions mai per le iscrizioni). Questo percorso gira
 * IN PARALLELO al pull legacy verso calendar_events (legacy/
 * subscriptions-pg.ts), che resta invariato compreso il sottoinsieme bacato di
 * parseIcs e la trappola del 304: nessuno dei due legge o scrive lo stato
 * dell'altro (etag e last_modified di calendar_subscriptions restano del
 * legacy).
 *
 * Passi di pullSubscriptionToIndex():
 *  1. solo le iscrizioni con un sidecar (collection_calendar_id, role
 *     'subscription', lifecycle 'active'); senza → 'skipped'. In mode
 *     postgres nessuno crea sidecar (enableSubscriptionIndex lo rifiuta):
 *     fino alla F3 il pull resta inerte in produzione;
 *  2. fetch con le stesse difese del pull legacy (solo http/https, SSRF con
 *     assertPublicUrl a ogni redirect, al massimo 5 redirect, 5 MB, 15 s) ma
 *     con validatori (ETag, Last-Modified) PROPRI, tenuti in memoria e usati
 *     solo se l'indice del sidecar è ancora quello che il pull ha scritto
 *     (index_version invariata): un indice svuotato o rimaterializzato non
 *     resta mai fermo dietro un 304. Il 304 si riconosce prima dei redirect
 *     (il bug di fetchIcs non si ripete). Un corpo già scaricato (`body`) si
 *     può passare per non scaricare due volte;
 *  3. anti-wipe come oggi, con gli stessi messaggi del pull legacy: un corpo
 *     senza una riga BEGIN:VCALENDAR (vuoto, pagina HTML) rifiutato; un feed
 *     senza eventi con oggetti nell'indice rifiutato salvo `force` esplicito;
 *  4. split del feed (ics-split.ts: calendar-core, un oggetto per UID,
 *     href r-<base32(sha256(UID))>.ics, fingerprint semantico);
 *  5. sotto il lock di scrittura della collezione (indexer.withCollectionWriteLock,
 *     contratto §1.3): diff per fingerprint semantico con gli oggetti del
 *     sidecar, poi prepare + apply dell'indicizzatore con versions=false,
 *     senza CAS né sync-token. Solo gli oggetti cambiati arrivano
 *     all'indicizzatore: un feed con DTSTAMP sempre nuovo non produce
 *     scritture di oggetti, componenti od occorrenze, versioni, incremento di
 *     index_version né job (resta solo la contabilità della riga di stato:
 *     last_synced_at e azzeramento dei fallimenti);
 *  6. se qualcosa è cambiato e l'iscrizione è device_visible, il job di
 *     specchio (subscriptions/mirror.ts) si accoda NELLA STESSA transazione
 *     dell'indice (outbox): esiste solo se la modifica ha fatto commit.
 *
 * Un oggetto rotto (RRULE invalida, due master, testo illeggibile) va in
 * quarantena da solo (indicizzatore), mai un errore del pull. Un UID che lo
 * split non sa comporre resta presente (in quarantena), mai cancellato. I
 * fallimenti del pull (rete, HTTP, feed rifiutato) vanno in
 * cal_collection_state con health.recordSyncFailure(): per un sidecar
 * d'iscrizione non portano mai a 'unsyncable' (dirty_since resta NULL),
 * perché nelle decisioni le iscrizioni usano l'ultimo pull completato e
 * stanno fuori dal set di freschezza (design §9).
 *
 * Non serve Radicale: il pull funziona con Radicale giù o non configurato, e
 * non dipende dall'identità del volume (la fonte è il feed remoto).
 */

import { customAlphabet } from 'nanoid';
import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { readBackendStateFresh, storeKindForMode, storeKindOverride, writesSuspendedInMode } from '../backend-mode';
import { CalendarUnavailableError, SubscriptionValidationError } from '../errors';
import { assertPublicUrl, IcsImportError } from '../ics-import';
import { IcsFeedError, type SplitFeedResult, splitIcsFeed, tolerantFingerprint } from '../ics-split';
import { targetHorizon } from '../index-model';
import { recordSyncFailure } from '../radicale/health';
import {
  type ApplyResult,
  applyPreparedChanges,
  type ChangeSetInput,
  ensureCollectionState,
  IndexAbortedError,
  loadCollectionContext,
  prepareCollectionChanges,
  type RawItem,
  withCollectionWriteLock,
} from '../radicale/indexer';
import type { Db } from '../radicale/policy';
import type { SyncResult } from '../types';
import { enqueueSubscriptionMirror } from './mirror';

const log: Logger = rootLogger.child({ scope: 'subscription-pull' });

// ─── Costanti ───────────────────────────────

/** Attore registrato dall'indicizzatore per le scritture del pull. */
export const SUBSCRIPTION_PULL_ACTOR = 'subscription-pull';

/** Stessi limiti del pull legacy (ics-import.ts): timeout, dimensione massima, redirect. */
export const FEED_FETCH_TIMEOUT_MS = 15_000;
export const FEED_MAX_BYTES = 5 * 1024 * 1024;
export const FEED_MAX_REDIRECTS = 5;

/**
 * Età massima dei validatori in cache: oltre, il pull scarica comunque il feed
 * intero (il fingerprint evita le scritture). Difesa contro un server remoto
 * che risponde 304 a torto.
 */
export const FEED_VALIDATORS_MAX_AGE_MS = 6 * 3_600_000;

/** Attesa massima del lock della collezione (un pull non è urgente). */
const PULL_LOCK_WAIT_MS = 30_000;

/** Stesso User-Agent e Accept del pull legacy (Google rifiuta le richieste senza User-Agent). */
const FEED_HEADERS = Object.freeze({
  'User-Agent': 'Caldes-Calendar-Subscriber/1.0',
  Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Tipi ───────────────────────────────

export type SubscriptionPullStatus = 'not_modified' | 'unchanged' | 'applied' | 'rejected' | 'skipped';

export interface SubscriptionPullResult {
  subscriptionId: string;
  /** Sidecar indicizzato (collection_calendar_id), null se l'iscrizione non ne ha uno. */
  calendarId: string | null;
  /**
   * not_modified: 304 dal remoto; unchanged: feed scaricato, nessun oggetto
   * cambiato (zero scritture); applied: oggetti scritti o cancellati;
   * rejected: feed rifiutato o pull fallito (`error`); skipped: niente da
   * fare (nessun sidecar, iscrizione inesistente).
   */
  status: SubscriptionPullStatus;
  /** Oggetti scritti dall'indicizzatore (nuovi o cambiati, quarantene comprese). */
  upserted: number;
  deleted: number;
  /** Oggetti invariati (fingerprint uguale). */
  unchanged: number;
  /** UID del feed che lo split non ha potuto comporre (in quarantena) e componenti senza UID (scartati). */
  errors: number;
  /** Oggetti messi in quarantena da questo pull. */
  quarantined: number;
  durationMs: number;
  error: string | null;
}

export interface PullSubscriptionOptions {
  /** Ignora i validatori in cache (scarica sempre) e ammette un feed legittimamente vuoto (anti-wipe). */
  force?: boolean;
  /** Corpo del feed già scaricato: nessuna richiesta HTTP. */
  body?: string;
  signal?: AbortSignal;
  /**
   * Solo con lo store Radicale (mai in mode postgres, contratto §1.5): riporta
   * l'esito anche su calendar_subscriptions (last_synced_at, last_error,
   * event_count), come faceva il pull legacy. etag e last_modified non si
   * toccano mai. Per RadicaleStore.syncSubscription.
   */
  updateSubscriptionRow?: boolean;
}

interface SubscriptionRow {
  id: string;
  calendar_id: string;
  ics_url: string;
  sync_enabled: boolean;
  collection_calendar_id: string | null;
  device_visible: boolean;
  sidecar_role: string | null;
  sidecar_lifecycle: string | null;
}

/** Feed rifiutato prima di toccare l'indice (vuoto, HTML, non iCalendar, anti-wipe). */
class FeedRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedRejectedError';
  }
}

/** Pull interrotto dal chiamante (AbortSignal): nessun fallimento registrato. */
class PullAbortedError extends Error {
  constructor() {
    super('pull dell\'iscrizione interrotto');
    this.name = 'PullAbortedError';
  }
}

// ─── Validatori HTTP propri dell'indice (in memoria) ───────────────────────────────

interface FeedValidators {
  url: string;
  sidecarId: string;
  etag: string | null;
  lastModified: string | null;
  /** index_version del sidecar dopo il pull che ha scaricato questa versione del feed. */
  indexVersion: string;
  savedAt: number;
}

/**
 * Validatori per iscrizione. Solo in memoria (nessuna colonna dedicata nelle
 * migrazioni 162-164, e il pull non scrive calendar_subscriptions in mode
 * postgres): dopo un riavvio il primo pull scarica il feed intero e il
 * fingerprint evita le scritture.
 */
const validators = new Map<string, FeedValidators>();

/** Validatori utilizzabili per questo pull: stesso URL e stesso sidecar, indice invariato da allora, non troppo vecchi. */
async function usableValidators(sub: SubscriptionRow, sidecarId: string): Promise<FeedValidators | null> {
  const v = validators.get(sub.id);
  if (!v || (!v.etag && !v.lastModified)) return null;
  if (v.url !== sub.ics_url || v.sidecarId !== sidecarId) return null;
  if (Date.now() - v.savedAt > FEED_VALIDATORS_MAX_AGE_MS) return null;
  return (await currentIndexVersion(sidecarId)) === v.indexVersion ? v : null;
}

/** Dimentica i validatori in memoria (tutti o di un'iscrizione): il prossimo pull scarica il feed intero. */
export function resetSubscriptionPullCache(subscriptionId?: string): void {
  if (subscriptionId) validators.delete(subscriptionId);
  else validators.clear();
}

// ─── Fetch ───────────────────────────────

interface FeedFetchResult {
  notModified: boolean;
  body: string | null;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // corpo già consumato o connessione chiusa: niente da liberare
  }
}

async function readLimitedBody(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > FEED_MAX_BYTES) {
    await discardBody(res);
    throw new IcsImportError(`Feed > ${Math.round(FEED_MAX_BYTES / 1024 / 1024)}MB — rifiutato`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new IcsImportError('Risposta senza body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > FEED_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new IcsImportError(`Feed > ${Math.round(FEED_MAX_BYTES / 1024 / 1024)}MB — rifiutato`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  // Decodifica tollerante come il legacy (U+FFFD per i byte non UTF-8); il BOM si toglie.
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * GET del feed con le difese del pull legacy (ics-import.ts: assertPublicUrl a
 * ogni hop, redirect manuali, 5 MB, 15 s) e i validatori dati. Il 304 si
 * riconosce PRIMA del ramo dei redirect.
 */
async function fetchFeed(url: string, cache: FeedValidators | null, signal?: AbortSignal): Promise<FeedFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new IcsImportError(`Feed non scaricato entro ${FEED_FETCH_TIMEOUT_MS / 1000} s`)), FEED_FETCH_TIMEOUT_MS);
  const onAbort = (): void => controller.abort(new PullAbortedError());
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const headers: Record<string, string> = { ...FEED_HEADERS };
    if (cache?.etag) headers['If-None-Match'] = cache.etag;
    if (cache?.lastModified) headers['If-Modified-Since'] = cache.lastModified;
    const conditional = Boolean(cache && (cache.etag || cache.lastModified));

    let current = url;
    await assertPublicUrl(current);
    let res: Response;
    let redirects = 0;
    for (;;) {
      res = await fetch(current, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' });
      if (res.status === 304) {
        await discardBody(res);
        if (!conditional) throw new IcsImportError('HTTP 304 a una richiesta non condizionale');
        return {
          notModified: true,
          body: null,
          etag: res.headers.get('etag') ?? cache?.etag ?? null,
          lastModified: res.headers.get('last-modified') ?? cache?.lastModified ?? null,
          contentType: null,
        };
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await discardBody(res);
        if (!location) throw new IcsImportError(`Redirect ${res.status} senza Location`);
        if (++redirects > FEED_MAX_REDIRECTS) throw new IcsImportError('Troppi redirect');
        current = new URL(location, current).toString();
        await assertPublicUrl(current);
        continue;
      }
      break;
    }
    if (!res.ok) {
      await discardBody(res);
      throw new IcsImportError(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    }
    const body = await readLimitedBody(res);
    return {
      notModified: false,
      body,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      contentType: res.headers.get('content-type'),
    };
  } catch (err) {
    if (controller.signal.aborted) {
      const reason: unknown = controller.signal.reason;
      if (reason instanceof PullAbortedError || reason instanceof IcsImportError) throw reason;
    }
    if (err instanceof IcsImportError || err instanceof PullAbortedError) throw err;
    // Errore di rete di fetch (TypeError "fetch failed" con la causa): messaggio leggibile.
    const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
    const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : (err as Error)?.message ?? String(err);
    throw new IcsImportError(`Feed non raggiungibile: ${detail}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ─── Controlli del corpo (anti-wipe come oggi) ───────────────────────────────

/** Messaggio del parser legacy (parseIcs) per un corpo che non è un VCALENDAR: lo vedono admin e MCP. */
export const NOT_VCALENDAR_MESSAGE = 'Il contenuto non è un VCALENDAR (BEGIN:VCALENDAR mancante)';

/**
 * Un corpo è un calendario se ha una riga BEGIN:VCALENDAR (dopo l'unfold),
 * lo stesso criterio del parser legacy: un corpo vuoto o una pagina HTML (login
 * scaduto, pagina d'errore) è un errore, mai un calendario vuoto; un feed valido
 * servito come text/html (CMS mal configurati) resta valido.
 */
function hasVcalendarLine(body: string): boolean {
  return body
    .replace(/^\uFEFF/, '')
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/)
    .some((line) => line.trim().toUpperCase() === 'BEGIN:VCALENDAR');
}

/** Corpo senza VCALENDAR (vuoto, HTML) → rifiutato; poi lo split (IcsFeedError → rifiutato). */
function splitBody(body: string): SplitFeedResult {
  if (!hasVcalendarLine(body)) throw new FeedRejectedError(NOT_VCALENDAR_MESSAGE);
  try {
    return splitIcsFeed(body);
  } catch (err) {
    if (err instanceof IcsFeedError) throw new FeedRejectedError(`Feed iCalendar non valido: ${err.message}`);
    throw err;
  }
}

// ─── Indice ───────────────────────────────

interface IndexOutcome {
  result: ApplyResult;
  /** Oggetti invariati scartati dal diff prima dell'indicizzatore. */
  skippedUnchanged: number;
  mirrorQueued: boolean;
}

/**
 * Sotto il lock della collezione: diff per fingerprint con gli oggetti del
 * sidecar, prepare e apply dell'indicizzatore e, se qualcosa è cambiato,
 * accodamento dello specchio nella stessa transazione. Con `split` null (304)
 * solo la contabilità della riga di stato (change set vuoto).
 */
async function indexFeed(
  sub: SubscriptionRow,
  sidecarId: string,
  split: SplitFeedResult | null,
  opts: { force: boolean; signal?: AbortSignal },
): Promise<IndexOutcome> {
  const context = await loadCollectionContext(sql, sidecarId);
  if (context.originStore !== 'remote' || context.role !== 'subscription') {
    throw new FeedRejectedError(`sidecar ${sidecarId} senza role=subscription: pull non applicabile`);
  }
  const now = new Date();
  return withCollectionWriteLock(sidecarId, async (lock) => {
    const conn = lock.conn as unknown as Db;
    // Il testo serve solo per gli oggetti in quarantena (confronto dei UID rotti).
    const existing = await conn<Array<{ href: string; semantic_fp: string | null; health: string; raw_ics: string | null }>>`
      SELECT href, semantic_fp, health, CASE WHEN health = 'quarantined' THEN raw_ics END AS raw_ics
      FROM cal_objects WHERE calendar_id = ${sidecarId}
    `;
    const [state] = await conn<Array<{ last_synced_at: Date | null; horizon_start: Date | null }>>`
      SELECT last_synced_at, horizon_start FROM cal_collection_state WHERE calendar_id = ${sidecarId}
    `;

    const upserts: RawItem[] = [];
    let deletes: string[] = [];
    let full = false;
    let skippedUnchanged = 0;
    if (split) {
      const present = new Set<string>();
      const items: RawItem[] = [];
      for (const o of split.objects) {
        present.add(o.href);
        items.push({ href: o.href, etag: null, raw: o.raw, semanticFp: o.semanticFp });
      }
      const byHref = new Map(existing.map((r) => [r.href, r]));
      // UID non componibili: restano presenti, l'indicizzatore li mette in quarantena (raw null = illeggibile).
      // Lo stesso UID rotto già in quarantena (testo con lo stesso fingerprint tollerante, o di
      // nuovo illeggibile) non si riscrive: l'indicizzatore non sa confrontare un testo che non si compone.
      for (const e of split.errors) {
        if (!e.href || present.has(e.href)) continue;
        present.add(e.href);
        const ex = byHref.get(e.href);
        if (ex && ex.health === 'quarantined' && (e.raw === null || (e.fingerprint !== null && tolerantFingerprint(ex.raw_ics) === e.fingerprint))) {
          skippedUnchanged++;
          continue;
        }
        items.push({ href: e.href, etag: null, raw: e.raw, semanticFp: null });
      }
      if (present.size === 0 && existing.length > 0 && !opts.force) {
        throw new FeedRejectedError(
          // Stesso testo del sync legacy (replaceSubscriptionEvents): lo vedono admin e MCP.
          `Feed vuoto ma ${existing.length} eventi presenti localmente: sync annullato (protezione anti-wipe). `
          + 'Se il calendario remoto è stato davvero svuotato, usa il sync manuale con force.',
        );
      }
      // Prima indicizzazione completa (o orizzonte mai materializzato): tutto il feed, full.
      full = !state || state.last_synced_at === null || state.horizon_start === null;
      for (const item of items) {
        const ex = byHref.get(item.href);
        if (!full && ex && ex.health === 'ok' && item.semanticFp && ex.semantic_fp === item.semanticFp) {
          skippedUnchanged++;
          continue;
        }
        upserts.push(item);
      }
      deletes = existing.filter((r) => !present.has(r.href)).map((r) => r.href);
    }

    const input: ChangeSetInput = {
      context,
      upserts,
      deletes,
      radicaleSkipped: [],
      pending404: [],
      full,
      horizon: targetHorizon(now),
      actor: SUBSCRIPTION_PULL_ACTOR,
    };
    const prepared = await prepareCollectionChanges(input);
    if (opts.signal?.aborted) throw new PullAbortedError();

    // Transazione dell'indicizzatore (annidata nella stessa) + outbox dello specchio.
    return lock.transaction(async (tx) => {
      const result = await applyPreparedChanges(lock, prepared, { syncedAt: now });
      let mirrorQueued = false;
      if ((result.upserted > 0 || result.deleted > 0) && sub.device_visible) {
        await enqueueSubscriptionMirror(sub.id, { indexVersion: result.indexVersion, db: tx });
        mirrorQueued = true;
      }
      return { result, skippedUnchanged, mirrorQueued };
    });
  }, { deadline: Date.now() + PULL_LOCK_WAIT_MS, signal: opts.signal });
}

// ─── Pull ───────────────────────────────

async function loadSubscription(id: string): Promise<SubscriptionRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await sql<SubscriptionRow[]>`
    SELECT s.id, s.calendar_id, s.ics_url, s.sync_enabled, s.collection_calendar_id, s.device_visible,
           c.role AS sidecar_role, c.lifecycle AS sidecar_lifecycle
    FROM calendar_subscriptions s
    LEFT JOIN calendars c ON c.id = s.collection_calendar_id
    WHERE s.id = ${id}::uuid
  `;
  return row ?? null;
}

async function currentIndexVersion(sidecarId: string): Promise<string | null> {
  const [row] = await sql<Array<{ index_version: string }>>`
    SELECT index_version::text AS index_version FROM cal_collection_state WHERE calendar_id = ${sidecarId}
  `;
  return row?.index_version ?? null;
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.replace(/[\r\n\t]+/g, ' ').trim() || 'errore sconosciuto').slice(0, 1000);
}

function emptyResult(subscriptionId: string, calendarId: string | null, status: SubscriptionPullStatus, startedAt: number, error: string | null = null): SubscriptionPullResult {
  return {
    subscriptionId,
    calendarId,
    status,
    upserted: 0,
    deleted: 0,
    unchanged: 0,
    errors: 0,
    quarantined: 0,
    durationMs: Math.round(performance.now() - startedAt),
    error,
  };
}

async function noteFailure(sidecarId: string, err: unknown): Promise<void> {
  try {
    await recordSyncFailure(sql, sidecarId, err, new Date());
  } catch (recordErr) {
    log.warn({ err: recordErr, calendarId: sidecarId }, 'fallimento del pull non registrato in cal_collection_state');
  }
}

async function pullOnce(subscriptionId: string, opts: PullSubscriptionOptions): Promise<SubscriptionPullResult> {
  const startedAt = performance.now();
  const sub = await loadSubscription(subscriptionId);
  if (!sub) return emptyResult(subscriptionId, null, 'skipped', startedAt, 'Iscrizione non trovata');
  const sidecarId = sub.collection_calendar_id;
  if (!sidecarId) return emptyResult(sub.id, null, 'skipped', startedAt);
  if (sub.sidecar_role !== 'subscription') {
    return emptyResult(sub.id, sidecarId, 'skipped', startedAt, `sidecar con role=${sub.sidecar_role ?? '?'} invece di subscription`);
  }
  if (sub.sidecar_lifecycle !== 'active') {
    return emptyResult(sub.id, sidecarId, 'skipped', startedAt, `sidecar in lifecycle ${sub.sidecar_lifecycle ?? '?'}`);
  }

  const force = opts.force === true;
  try {
    if (opts.signal?.aborted) throw new PullAbortedError();

    // 1. Corpo del feed (o 304).
    let fetched: FeedFetchResult;
    if (opts.body !== undefined) {
      validators.delete(sub.id);
      fetched = { notModified: false, body: opts.body, etag: null, lastModified: null, contentType: null };
    } else {
      const cache = force ? null : await usableValidators(sub, sidecarId);
      fetched = await fetchFeed(sub.ics_url, cache, opts.signal);
    }

    // 2. Split (o niente, con il 304).
    const split = fetched.notModified ? null : splitBody(fetched.body ?? '');

    // 3. Indice.
    const outcome = await indexFeed(sub, sidecarId, split, { force, signal: opts.signal });
    const { result } = outcome;

    if (opts.body === undefined && (fetched.etag || fetched.lastModified)) {
      const previous = validators.get(sub.id);
      validators.set(sub.id, {
        url: sub.ics_url,
        sidecarId,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        indexVersion: result.indexVersion,
        // Un 304 non rinnova l'età: dopo FEED_VALIDATORS_MAX_AGE_MS si riscarica comunque.
        savedAt: fetched.notModified && previous ? previous.savedAt : Date.now(),
      });
    } else if (!fetched.notModified) {
      validators.delete(sub.id);
    }

    const changed = result.upserted + result.deleted > 0;
    const status: SubscriptionPullStatus = fetched.notModified ? 'not_modified' : changed ? 'applied' : 'unchanged';
    const out: SubscriptionPullResult = {
      subscriptionId: sub.id,
      calendarId: sidecarId,
      status,
      upserted: result.upserted,
      deleted: result.deleted,
      unchanged: outcome.skippedUnchanged + result.unchanged,
      errors: split?.errors.length ?? 0,
      quarantined: result.quarantined,
      durationMs: Math.round(performance.now() - startedAt),
      error: null,
    };
    if (changed) {
      log.info({
        subscriptionId: sub.id,
        calendarId: sidecarId,
        upserted: out.upserted,
        deleted: out.deleted,
        unchanged: out.unchanged,
        quarantined: out.quarantined,
        errors: out.errors,
        indexVersion: result.indexVersion,
        mirrorQueued: outcome.mirrorQueued,
      }, 'iscrizione indicizzata');
    }
    return out;
  } catch (err) {
    if (err instanceof PullAbortedError || err instanceof IndexAbortedError || opts.signal?.aborted) {
      return emptyResult(sub.id, sidecarId, 'rejected', startedAt, 'pull dell\'iscrizione interrotto');
    }
    const message = errorText(err);
    await noteFailure(sidecarId, err);
    if (err instanceof FeedRejectedError || err instanceof IcsImportError) {
      log.warn({ subscriptionId: sub.id, calendarId: sidecarId, error: message }, 'feed dell\'iscrizione rifiutato: indice invariato');
    } else {
      log.error({ err, subscriptionId: sub.id, calendarId: sidecarId }, 'pull dell\'iscrizione verso l\'indice fallito');
    }
    return emptyResult(sub.id, sidecarId, 'rejected', startedAt, message);
  }
}

/** Esito sulla riga dell'iscrizione (solo store Radicale): last_synced_at, last_error, event_count. */
async function recordOnSubscriptionRow(result: SubscriptionPullResult): Promise<void> {
  if (result.status === 'skipped' || !result.calendarId) return;
  if ((await freshStoreKind()) !== 'radicale') return; // mode postgres: la riga è del pull legacy (§1.5)
  try {
    if (result.status === 'rejected') {
      await sql`
        UPDATE calendar_subscriptions SET last_synced_at = NOW(), last_error = ${result.error}
        WHERE id = ${result.subscriptionId}::uuid
      `;
      return;
    }
    // event_count con la semantica legacy: VEVENT importati, override compresi.
    await sql`
      UPDATE calendar_subscriptions SET
        last_synced_at = NOW(),
        last_error = NULL,
        event_count = (SELECT count(*) FROM cal_components WHERE calendar_id = ${result.calendarId} AND component = 'VEVENT')::int
      WHERE id = ${result.subscriptionId}::uuid
    `;
  } catch (err) {
    log.warn({ err, subscriptionId: result.subscriptionId }, 'esito del pull non riportato sull\'iscrizione');
  }
}

/** Pull in corso per iscrizione (single-flight nel processo). */
const inflight = new Map<string, Promise<SubscriptionPullResult>>();

/**
 * Pull di un'iscrizione verso l'indice (testa del file). Non lancia per gli
 * errori del feed, della rete o dell'indice: l'esito è nel risultato
 * ('rejected' con `error`), come il sync legacy, così il cron prosegue con le
 * altre. Single-flight per iscrizione: una chiamata semplice durante un pull
 * in corso ne riceve l'esito; con `force` o `body` attende la fine di quello
 * in corso e ne fa uno proprio.
 */
export async function pullSubscriptionToIndex(subscriptionId: string, opts: PullSubscriptionOptions = {}): Promise<SubscriptionPullResult> {
  const running = inflight.get(subscriptionId);
  if (running) {
    if (!opts.force && opts.body === undefined) return running;
    await running.catch(() => undefined);
  }
  const promise = (async () => {
    const result = await pullOnce(subscriptionId, opts);
    if (opts.updateSubscriptionRow) await recordOnSubscriptionRow(result);
    return result;
  })();
  inflight.set(subscriptionId, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(subscriptionId) === promise) inflight.delete(subscriptionId);
  }
}

/**
 * Pull di tutte le iscrizioni abilitate con un sidecar, una alla volta (cron
 * ogni 15 minuti, accanto al pull legacy runIcsPull). Le iscrizioni senza
 * sidecar non compaiono: in mode postgres, fino alla F3, è un giro vuoto.
 */
export async function pullAllSubscriptionsToIndex(opts: { signal?: AbortSignal } = {}): Promise<SubscriptionPullResult[]> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT s.id
    FROM calendar_subscriptions s
    JOIN calendars c ON c.id = s.collection_calendar_id
    WHERE s.sync_enabled AND c.role = 'subscription' AND c.lifecycle = 'active'
    ORDER BY s.created_at, s.id
  `;
  const results: SubscriptionPullResult[] = [];
  for (const { id } of rows) {
    if (opts.signal?.aborted) break;
    results.push(await pullSubscriptionToIndex(id, { signal: opts.signal }));
  }
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (results.length > 0) {
    log.info({
      total: results.length,
      applied: results.filter((r) => r.status === 'applied').length,
      failed,
    }, 'pull delle iscrizioni verso l\'indice completato');
  }
  return results;
}

/**
 * SyncResult legacy (facade syncSubscription) dall'esito del pull, per
 * RadicaleStore: notModified per il 304, inserted e removed = oggetti scritti
 * e cancellati nell'indice (il legacy contava l'intero feed reinserito),
 * error per un feed rifiutato o un pull fallito.
 */
export function toLegacySyncResult(result: SubscriptionPullResult): SyncResult {
  return {
    notModified: result.status === 'not_modified',
    inserted: result.upserted,
    removed: result.deleted,
    error: result.status === 'rejected' ? result.error : null,
  };
}

// ─── Sidecar ───────────────────────────────

const generateFeedToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 32);

const SIDECAR_DESCRIPTION = "Iscrizione ICS: cache del feed remoto nell'indice";

/** Store servito dal modo corrente, riletto senza cache (l'override dei test prevale). */
async function freshStoreKind(): Promise<'postgres' | 'radicale'> {
  const override = storeKindOverride();
  if (override) return override;
  return storeKindForMode((await readBackendStateFresh(sql)).mode);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/**
 * Crea il sidecar dell'iscrizione (riga di calendars con role='subscription',
 * collection_name e slug `sub-<id8>`, parent = calendario di destinazione,
 * feed ICS spento, non bloccante di suo: il busy usa i flag dell'iscrizione e
 * del padre, design §7) e la riga di stato remota, e lo collega
 * all'iscrizione. Idempotente: restituisce il sidecar già collegato.
 *
 * Solo con lo store Radicale (radicale, finalized) o dallo strumento di
 * migrazione (F3, `allowPostgresMode`): in mode postgres listCalendars legacy
 * mostrerebbe la riga (contratto §1.5, precisazione 7). Mai MKCALENDAR: la
 * collezione `sub-<id8>` di Radicale (specchio, solo per le device_visible)
 * la crea il wizard della F3. Lancia SubscriptionValidationError per
 * un'iscrizione inesistente e CalendarUnavailableError('transition') se il
 * modo non lo ammette.
 */
export async function enableSubscriptionIndex(subscriptionId: string, opts: { allowPostgresMode?: boolean } = {}): Promise<string> {
  if (!UUID_RE.test(subscriptionId)) throw new SubscriptionValidationError('Subscription non trovata');
  const state = await readBackendStateFresh(sql);
  if (writesSuspendedInMode(state.mode)) {
    throw new CalendarUnavailableError('transition', `modo ${state.mode}: scritture del calendario sospese`);
  }
  const kind = storeKindOverride() ?? storeKindForMode(state.mode);
  if (kind !== 'radicale' && !opts.allowPostgresMode) {
    throw new CalendarUnavailableError('transition', `modo ${state.mode}: il sidecar di un'iscrizione si crea solo con lo store Radicale o dallo strumento di migrazione`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- il tipo della tx di postgres-js perde la firma del template
  const sidecarId = await sql.begin(async (tx: any) => {
    const [sub] = await tx<Array<{ id: string; calendar_id: string; name: string; device_visible: boolean; collection_calendar_id: string | null }>>`
      SELECT id, calendar_id, name, device_visible, collection_calendar_id
      FROM calendar_subscriptions WHERE id = ${subscriptionId}::uuid
      FOR UPDATE
    `;
    if (!sub) throw new SubscriptionValidationError('Subscription non trovata');
    if (sub.collection_calendar_id) return sub.collection_calendar_id;

    const [parent] = await tx<Array<{ timezone: string | null; color: string | null }>>`
      SELECT timezone, color FROM calendars WHERE id = ${sub.calendar_id}
    `;
    const hex = sub.id.replace(/-/g, '').toLowerCase();
    let created: string | null = null;
    // sub-<id8> (design §5); in caso (rarissimo) di nome già preso si allunga.
    for (const len of [8, 12, 32]) {
      const name = `sub-${hex.slice(0, len)}`;
      try {
        await tx`SAVEPOINT sidecar_insert`;
        const [row] = await tx<Array<{ id: string }>>`
          INSERT INTO calendars (
            slug, name, description, color, timezone, is_default, is_system, blocks_availability,
            ics_feed_token, ics_feed_enabled, sort_order,
            collection_name, role, origin, lifecycle, parent_calendar_id, device_visible, components
          ) VALUES (
            ${name}, ${String(sub.name ?? 'Iscrizione').trim().slice(0, 200) || 'Iscrizione'},
            ${SIDECAR_DESCRIPTION}, ${parent?.color ?? '#7c3aed'}, ${parent?.timezone ?? 'Europe/Rome'},
            false, false, false,
            ${generateFeedToken()}, false, 0,
            ${name}, 'subscription', ${opts.allowPostgresMode && kind !== 'radicale' ? 'migration' : 'admin'}, 'active',
            ${sub.calendar_id}, ${sub.device_visible}, '{VEVENT}'
          )
          RETURNING id
        `;
        await tx`RELEASE SAVEPOINT sidecar_insert`;
        created = row.id;
        break;
      } catch (err) {
        await tx`ROLLBACK TO SAVEPOINT sidecar_insert`;
        if (!isUniqueViolation(err)) throw err;
      }
    }
    if (!created) throw new Error(`nome della collezione del sidecar non disponibile per l'iscrizione ${sub.id}`);
    await tx`UPDATE calendar_subscriptions SET collection_calendar_id = ${created} WHERE id = ${sub.id}`;
    await ensureCollectionState(tx as Db, created, 'remote');
    return created;
  });
  validators.delete(subscriptionId);
  log.info({ subscriptionId, calendarId: sidecarId }, 'sidecar dell\'iscrizione pronto: pull verso l\'indice attivo');
  return sidecarId as string;
}
