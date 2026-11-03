/**
 * GDPR del calendario: cancellazione dei dati di una persona e retention
 * (fase F3 del passaggio a Radicale; design §16.4; decisione 3; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §3.6, §6.4 e §13).
 *
 * calendarErase(email), agganciata a DELETE /api/gdpr-requests/erase/:email:
 *  1. prenotazioni con quell'email anonimizzate (nome "Dato cancellato
 *     (GDPR)", email `erased-<id>@deleted.invalid`, telefono, azienda,
 *     messaggio, risposte e consenso tolti): la riga resta per lo storico e
 *     per il vincolo EXCLUDE; i destinatari dei promemoria inviati
 *     (calendar_booking_reminders.sent_to) redatti allo stesso modo;
 *  2. righe legacy delle proiezioni di quelle prenotazioni ridotte a
 *     "Prenotazione" (descrizione, luogo e link a NULL); nelle altre righe di
 *     calendar_events (e calendar_events_legacy, dopo il finalize della F7)
 *     l'email sostituita da "[dato rimosso]". In mode postgres senza GUC, così
 *     lo shadow mirror propaga; negli altri modi dentro
 *     `set_config('caldes.reverse_sync', txid_current()::text, true)` (guardia 166 della F4);
 *  3. audit_logs di calendar_events e calendar_bookings delle righe toccate,
 *     o che contengono l'email (anche quelli delle chiamate MCP, table_name
 *     'mcp_call', con gli argomenti dei tool di calendario), redatti in
 *     old_data, new_data e metadata (il trigger 118 salva to_jsonb della riga,
 *     DESCRIPTION compresa): comprese le righe scritte dalle UPDATE dei passi 1
 *     e 2, che stanno nella stessa transazione;
 *  4. ledger della migrazione: righe delle chiavi toccate (o con l'email negli
 *     snapshot) con legacy_snapshot, intent_snapshot e legacy_hash a NULL (il
 *     piano successivo riscrive la destinazione); righe dei run
 *     (cal_migration_items.detail) e run (params, summary, progress, error)
 *     che contengono l'email: email sostituita, righe e run restano. Mai
 *     cancellate per chiave: le differenze delle verifiche e gli esiti degli
 *     oggetti non contengono dati personali e da loro si ricalcolano i
 *     verdetti (gate dello shadow e del cutover) e i conflitti aperti;
 *  5. destinazione: in mode postgres con il volume inizializzato, job
 *     shadow_mirror con `payload.erasure = true` per le chiavi toccate
 *     (eseguiti anche con lo shadow spento: patch dei campi redatti, proiezioni
 *     minimizzate); con lo store Radicale, project_booking per le prenotazioni
 *     (la risorsa minimizzata si riscrive con If-Match) e update dalla facade
 *     per gli altri eventi indicizzati che contengono l'email, dopo la COMMIT;
 *  6. indice: versioni degli oggetti toccati cancellate (purgeVersionsForErasure,
 *     f2-modules §5.6); raw_ics si aggiorna con la sync dopo la riscrittura;
 *  7. cal_jobs conclusi o morti: quelli di project_booking e
 *     booking_conflict_check delle prenotazioni e quelli che contengono
 *     l'email, cancellati (i risultati dello shadow_mirror delle chiavi toccate
 *     restano: contengono solo chiavi, href ed esiti);
 *  8. seguito manuale nella risposta: purge della cache degli item di
 *     Radicale sul server, backup ordinari fino alla scadenza, copie
 *     conservate senza scadenza (snapshot "pinned", file e volume della Fase
 *     0), item dell'archivio della Fase 0, eventi Google collegati.
 * L'email si cerca con i confini (erasureEmailPattern): cancellare
 * mario@example.com non tocca anna.mario@example.com né
 * mario@example.com.au.
 * Passi 1-7 in una sola transazione (gli accodamenti sono outbox: i job
 * esistono solo dopo la COMMIT). Idempotente: una seconda esecuzione non trova
 * più l'email e non tocca nulla.
 *
 * Retention (cron data-retention):
 *  - purgeMigrationArtifacts: run e righe dello strumento oltre 30 giorni
 *    (tranne l'ultimo run riuscito di ogni tipo) e file caricati per
 *    l'archivio della Fase 0 oltre 24 ore;
 *  - enqueueExpiredProjectionRewrites: proiezioni la cui fine ha appena
 *    superato i 24 mesi (decisione 3), più quelle che l'indice o il ledger
 *    mostrano ancora non minimizzate: project_booking con lo store Radicale,
 *    shadow_mirror in mode postgres con lo shadow acceso.
 *
 * Mai dati personali nei log, nelle righe dei run e nel report: solo
 * conteggi, id e codici.
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { sql } from '../../db';
import { logger as rootLogger } from '../logger';
import { storeKindForMode, storeKindOverride, writesSuspendedInMode } from './backend-mode';
import { ANONYMIZED_ATTENDEE_NAME, PROJECTED_BOOKING_STATUSES, RETAINED_PROJECTION_SUMMARY } from './radicale/booking-projection';
import { CAL_JOB_KINDS, CAL_JOB_PRIORITY, enqueueCalendarJob } from './jobs';
import { acceptedUploadDirs } from './migration/init';
import { readMigrationStateFresh } from './migration/preflight';
import { GDPR_ERASURE_INCOMPLETE_ALERT } from './migration/shadow';
import { raiseIndexAlert } from './radicale/health';
import { MIGRATION_LIMITS, parseLegacyKey, SHADOW_MIRROR_JOB_KIND, type LegacyKey } from './migration/types';
import type { Db } from './radicale/policy';
import { purgeVersionsForErasure } from './radicale/versions';
import { calendarStoreForWrite } from './store';
import type { UpdateEventInput } from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-gdpr' });

// ─── Costanti ───────────────────────────────

/** Testo che sostituisce l'email (e i campi personali interi) nei testi del calendario e negli audit. */
export const ERASURE_REDACTED_TEXT = '[dato rimosso]';

/** Campi personali di calendar_bookings sostituiti per intero negli audit (old_data, new_data). */
const BOOKING_PERSONAL_KEYS = [
  'attendee_name', 'attendee_email', 'attendee_phone', 'attendee_company', 'attendee_message',
  'custom_responses', 'consent_ip', 'consent_user_agent', 'cancellation_reason',
] as const;

/** Campi di testo di una proiezione legacy (decisione 3: nome e telefono) sostituiti per intero negli audit. */
const PROJECTION_TEXT_KEYS = ['summary', 'description', 'location', 'url'] as const;

/** Tabelle di calendar_events in cui cercare l'email (la seconda esiste solo dopo il finalize della F7). */
const EVENT_TABLES = ['calendar_events', 'calendar_events_legacy'] as const;

/**
 * table_name degli audit in cui cercare l'email (design §16.4): le tabelle del
 * calendario e le chiamate MCP (writeMcpAudit salva in new_data.args_summary
 * gli argomenti dei tool, come attendee_email di create_booking o la
 * descrizione di create_event).
 */
const AUDIT_EMAIL_TABLES = ['calendar_events', 'calendar_bookings', 'calendar_events_legacy', 'mcp_call'] as const;

/**
 * Chiavi personali annidate di calendar_bookings sostituite per intero (nelle
 * righe e negli audit): source_metadata.user_agent è lo stesso dato di
 * consent_user_agent (la pagina pubblica lo salva in entrambi).
 */
const BOOKING_NESTED_PERSONAL_KEYS: Readonly<Record<string, readonly string[]>> = { source_metadata: ['user_agent'] };

/** Debounce dei job di cancellazione: raccoglie le UPDATE della stessa transazione. */
const ERASURE_JOB_DELAY_MS = MIGRATION_LIMITS.shadowDebounceMs;

/** Retention delle proiezioni: finestra di "appena superato i 24 mesi" (il cron gira ogni giorno). */
export const PROJECTION_RETENTION_SWEEP_DAYS = 7;

/** File caricati per l'archivio della Fase 0: cancellati comunque dopo 24 ore (contratto f3 §3.6). */
export const MIGRATION_UPLOAD_MAX_AGE_MS = 24 * 3_600_000;

/** Controllo minimo dell'email da cancellare: mai una ricerca su una stringa vuota o generica. */
const ERASURE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Tipi ───────────────────────────────

export interface CalendarErasureReport {
  /** Prenotazioni anonimizzate. */
  bookings: number;
  /** Righe legacy delle proiezioni ridotte a "Prenotazione". */
  projections_legacy: number;
  /** Altre righe di calendar_events (e degli eventi indicizzati, con lo store Radicale) con l'email redatta. */
  events_redacted: number;
  audit_logs_redacted: number;
  ledger_redacted: number;
  /** Righe dei run (cal_migration_items) con l'email sostituita nel dettaglio: le righe restano. */
  migration_items_redacted: number;
  /** Run dello strumento (cal_migration_runs) con l'email sostituita in params, summary, progress o error. */
  migration_runs_redacted: number;
  versions_purged: number;
  /** Job accodati per la destinazione (shadow_mirror o project_booking). */
  jobs_enqueued: number;
  /** Destinatari dei promemoria delle prenotazioni redatti (calendar_booking_reminders.sent_to). */
  reminders_redacted: number;
  /** Job conclusi o morti delle chiavi toccate cancellati. */
  jobs_deleted: number;
  manual_followup: string[];
}

// ─── Utilità ───────────────────────────────

/**
 * Email normalizzata per la cancellazione (trim, minuscole), o null se non è
 * un'email plausibile: una stringa vuota o generica farebbe corrispondere
 * qualsiasi testo.
 */
export function normalizeErasureEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > 255 || !ERASURE_EMAIL_RE.test(email)) return null;
  return email;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pattern (regex ARE di Postgres) che trova l'email in un testo, senza
 * distinzione di maiuscole con il flag 'i', solo come email intera: prima non
 * deve esserci un carattere che possa stare nella parte locale (lettere,
 * cifre, `.`, `_`, `%`, `+`, `-`), tranne l'escape `\n` di iCalendar e JSON;
 * dopo non deve continuare il dominio (lettera, cifra, `_`, `-`, oppure `.`
 * seguito da una lettera o una cifra: il punto di fine frase va bene).
 * Cancellare mario@example.com non tocca anna.mario@example.com né
 * mario@example.com.au.
 */
export function erasureEmailPattern(email: string): string {
  return `(?:(?<![[:alnum:]._%+-])|(?<=\\\\[nN]))${escapeRegex(email)}(?![[:alnum:]_-]|\\.[[:alnum:]])`;
}

/** Lo stesso pattern di erasureEmailPattern per JavaScript (flag g, i, u). */
export function erasureEmailRegex(email: string): RegExp {
  return new RegExp(`(?:(?<![\\p{L}\\p{N}._%+\\-])|(?<=\\\\[nN]))${escapeRegex(email)}(?![\\p{L}\\p{N}_\\-]|\\.[\\p{L}\\p{N}])`, 'giu');
}

/** Il testo contiene l'email (stesse regole di erasureEmailRegex). */
function textHasEmail(text: string | null | undefined, re: RegExp): boolean {
  if (typeof text !== 'string' || text === '') return false;
  re.lastIndex = 0;
  const found = text.search(re) >= 0;
  re.lastIndex = 0;
  return found;
}

/**
 * Redazione di un valore JSON (old_data/new_data/metadata degli audit,
 * dettagli e riassunti dei run, source_metadata): nelle stringhe, a ogni
 * livello, l'email diventa "[dato rimosso]"; le chiavi di primo livello in
 * `fullKeys` con un valore non nullo diventano "[dato rimosso]" per intero;
 * `nested` indica, per una chiave di primo livello che contiene un oggetto,
 * le sue chiavi da sostituire per intero. Il resto (struttura, codici,
 * numeri, chiavi) resta com'è. Restituisce un valore nuovo.
 */
export function redactErasureJson(
  value: unknown,
  opts: { re: RegExp; fullKeys?: readonly string[]; nested?: Readonly<Record<string, readonly string[]>> },
): unknown {
  const walk = (v: unknown, top: boolean, fullKeys: readonly string[], nested: Readonly<Record<string, readonly string[]>>): unknown => {
    if (typeof v === 'string') {
      opts.re.lastIndex = 0;
      return v.replace(opts.re, ERASURE_REDACTED_TEXT);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, false, [], {}));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (top && fullKeys.includes(k) && x !== null && x !== undefined) out[k] = ERASURE_REDACTED_TEXT;
        else if (top && nested[k] && x !== null && typeof x === 'object' && !Array.isArray(x)) out[k] = walk(x, true, nested[k], {});
        else out[k] = walk(x, false, [], {});
      }
      return out;
    }
    return v;
  };
  return walk(value, true, opts.fullKeys ?? [], opts.nested ?? {});
}

/** Il valore JSON contiene l'email in una stringa, a qualsiasi livello. */
function jsonHasEmail(value: unknown, re: RegExp): boolean {
  if (value === null || value === undefined) return false;
  return JSON.stringify(redactErasureJson(value, { re })) !== JSON.stringify(value);
}

function jsonChanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/** Esegue `fn` in una transazione (o direttamente se `db` è già una transazione). */
async function inTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const begin = (db as unknown as { begin?: unknown }).begin;
  if (typeof begin !== 'function') return fn(db);
  return (await db.begin(async (trx) => fn(trx as unknown as Db))) as T;
}

function uniq<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Chiave del job shadow_mirror di una riga di calendar_events (stessa regola di cal_shadow_event_key della 165). */
function shadowKeyOf(row: {
  id: string; recurrence_master_id: string | null; source: string; source_id: string | null;
  caldes_derived?: boolean | null; caldes_object_id?: string | null;
}): LegacyKey | null {
  if (row.source === 'ics_pull') return null;
  const sourceId = (row.source_id ?? '').trim();
  if (row.source === 'booking' && sourceId) return `booking:${sourceId}` as LegacyKey;
  // Righe derivate dalla proiezione inversa: l'oggetto è la risorsa Radicale (166, cal_shadow_event_key a sei argomenti).
  if (row.caldes_derived && row.caldes_object_id) return `event:${row.caldes_object_id.toLowerCase()}` as LegacyKey;
  return `event:${String(row.recurrence_master_id ?? row.id).toLowerCase()}` as LegacyKey;
}

/** Righe ripiegate di un testo iCalendar (folding a 75 ottetti, RFC 5545 §3.1) da riunire prima di cercare l'email. */
const ICS_UNFOLD_RE = '\\r?\\n[ \\t]';

// ─── Cancellazione ───────────────────────────────

interface EventRowRef {
  id: string;
  recurrence_master_id: string | null;
  source: string;
  source_id: string | null;
  caldes_derived: boolean;
  caldes_object_id: string | null;
}

interface ErasureTxResult {
  report: CalendarErasureReport;
  facadeUpdates: boolean;
  googleEvents: number;
  archiveObjects: number;
  /** Transizione in corso (cutover o rollback): la destinazione si riscrive a transizione conclusa. */
  transition: string | null;
  /** Mode postgres: chiavi con job shadow_mirror di cancellazione accodati. */
  shadowJobs: number;
  /** Chiavi accodate che hanno già un conflitto aperto o un intento pendente: il job potrebbe non riscriverle. */
  blockedKeys: string[];
  /** Risorse Radicale espanse dalla proiezione inversa (righe caldes_derived toccate): il wizard non le riscrive. */
  derivedObjectIds: string[];
  /** In mode postgres: href e calendario delle risorse derivate (per il follow-up manuale, senza dati personali). */
  derivedHrefs: Array<{ object_id: string; href: string | null; collection: string | null }>;
  /** La cancellazione è avvenuta in mode postgres (dopo un rollback): le risorse derivate restano su Radicale. */
  postgresMode: boolean;
  /**
   * Fuori da mode postgres: dati per ripetere la redazione di calendar_events e audit_logs dopo la riscrittura dalla
   * facade (una proiezione inversa col piano calcolato prima della COMMIT può aver riscritto i testi, F4R-ROLL-04).
   */
  recheck: { bookingIds: string[]; bookingUids: string[]; projectionIds: string[] } | null;
}

/**
 * Cancellazione dei dati del calendario di una persona (testa del file).
 * Lancia TypeError per un'email non plausibile (controllo a monte nella
 * route: normalizeErasureEmail).
 */
export async function calendarErase(email: string, opts: { actor: string; db?: Db }): Promise<CalendarErasureReport> {
  const normalized = normalizeErasureEmail(email);
  if (!normalized) throw new TypeError('email non valida per la cancellazione dei dati del calendario');
  const db = opts.db ?? sql;
  const pattern = erasureEmailPattern(normalized);
  const re = erasureEmailRegex(normalized);

  const txResult = await inTx(db, (tx) => eraseInTransaction(tx, normalized, pattern, re));
  const report = txResult.report;

  // Store Radicale: gli eventi indicizzati che contengono l'email si riscrivono dalla facade (gate, If-Match, versioni).
  if (txResult.facadeUpdates) {
    const outcome = await redactIndexedEventsViaFacade(db, normalized, pattern, re);
    report.events_redacted += outcome.updated;
    if (outcome.failed.length > 0) {
      report.manual_followup.push(
        `Eventi del calendario con l'email non riscritti su Radicale (${outcome.failed.length}): ripetere la cancellazione o correggerli dall'admin (id: ${outcome.failed.slice(0, 20).join(', ')}).`,
      );
    }
  }

  // Fuori da mode postgres la proiezione inversa può aver riscritto in calendar_events (e quindi in audit_logs) i testi non
  // redatti con un piano calcolato prima della COMMIT: seconda transazione breve, idempotente, con lo stesso GUC.
  if (txResult.recheck) {
    const again = await inTx(db, async (tx) => {
      await tx`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;
      let events = 0;
      for (const table of EVENT_TABLES) {
        const [exists] = await tx<Array<{ ok: boolean }>>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS ok`;
        if (!exists?.ok) continue;
        events += (await redactEventRows(tx, table, normalized, pattern)).length;
      }
      const audit = await redactAuditLogs(tx, { email: normalized, re, ...txResult.recheck! });
      return { events, audit };
    });
    report.events_redacted += again.events;
    report.audit_logs_redacted += again.audit;
  }

  report.manual_followup.push(...erasureBackupFollowup());
  if (txResult.googleEvents > 0) {
    report.manual_followup.push(
      `Eventi Google Calendar collegati alle prenotazioni (${txResult.googleEvents}): contengono l'email dell'invitato, eliminarli o anonimizzarli da Google Calendar.`,
    );
  }
  if (txResult.transition) {
    report.manual_followup.push(
      `Transizione del calendario in corso (${txResult.transition}): ripetere la cancellazione a transizione conclusa per riscrivere anche Radicale.`,
    );
  }
  if (txResult.shadowJobs > 0) {
    // Il rimedio del wizard (anteprima e apply) vale per gli oggetti con un oggetto legacy; le risorse espanse dalla
    // proiezione inversa (derived) non si riscrivono mai: per loro vale il follow-up dedicato più sotto.
    const rewritable = txResult.shadowJobs - txResult.derivedObjectIds.length;
    report.manual_followup.push(
      `Riscrittura su Radicale accodata per ${txResult.shadowJobs} oggetti (job shadow_mirror di cancellazione): l'esito arriva dopo questa risposta. Un oggetto in conflitto o un job in dead letter alza l'avviso "${GDPR_ERASURE_INCOMPLETE_ALERT}" (log, Bugsink, Telegram) e lascia nome e telefono sul volume finché non si risolve.`
      + (rewritable > 0 ? ' Per gli oggetti non derivati il conflitto si risolve dal wizard della migrazione (anteprima e apply, che riscrive il contenuto già redatto in PG).' : ''),
    );
  }
  if (txResult.derivedObjectIds.length > 0 && txResult.postgresMode) {
    const where = txResult.derivedHrefs.map((h) => `${h.collection ?? '?'}/${h.href ?? '?'}`).slice(0, 20).join(', ');
    report.manual_followup.push(
      `Risorse Radicale espanse dalla proiezione inversa (${txResult.derivedObjectIds.length}): il wizard non le riscrive. Redigere a mano su Radicale PRIMA di un nuovo cutover (id: ${txResult.derivedObjectIds.slice(0, 20).join(', ')}; href: ${where || 'non risolti'}).`,
    );
    raiseIndexAlert(GDPR_ERASURE_INCOMPLETE_ALERT, 'Cancellazione GDPR: risorse derived non riscrivibili su Radicale', { objects: txResult.derivedObjectIds.slice(0, 20) });
  }
  if (txResult.blockedKeys.length > 0) {
    report.manual_followup.push(
      `Oggetti con un conflitto aperto o un intento pendente su Radicale (${txResult.blockedKeys.length}): la riscrittura accodata probabilmente non li toccherà, risolverli dal wizard della migrazione (chiavi: ${txResult.blockedKeys.slice(0, 20).join(', ')}).`,
    );
  }
  if (txResult.archiveObjects > 0) {
    report.manual_followup.push(
      `Item dell'archivio della Fase 0 (o di collezioni senza sorgente legacy) che contengono l'email (${txResult.archiveObjects}): nessuna riscrittura automatica li tocca, rimuoverli o redigerli a mano dalla collezione su Radicale.`,
    );
  }

  log.info({
    actor: opts.actor,
    bookings: report.bookings,
    projections_legacy: report.projections_legacy,
    events_redacted: report.events_redacted,
    audit_logs_redacted: report.audit_logs_redacted,
    ledger_redacted: report.ledger_redacted,
    migration_items_redacted: report.migration_items_redacted,
    migration_runs_redacted: report.migration_runs_redacted,
    versions_purged: report.versions_purged,
    jobs_enqueued: report.jobs_enqueued,
  }, 'cancellazione GDPR dei dati del calendario completata');
  return report;
}

/**
 * Seguito manuale sui backup (contratto f3 §13.1 passo 8): i run ordinari
 * scadono con la retention, le copie conservate no.
 */
export function erasureBackupFollowup(): string[] {
  return [
    'Sul server del calendario: eseguire scripts/radicale-maint.sh purge-cache per svuotare la cache degli item di Radicale (si ricostruisce da sola).',
    'I backup ordinari (run di backups/calendar-stack/<AAAAMMGGTHHMMSSZ>/ e dump caldes-*.sql.gz, in locale e su S4) contengono ancora i dati fino alla scadenza della loro retention (30 giorni).',
    'Copie SENZA scadenza che contengono ancora i dati: snapshot conservati da radicale-maint.sh snapshot in backups/calendar-stack/pinned/ (elenco: scripts/radicale-maint.sh pinned-list; cancellazione dopo la conferma del passaggio: scripts/radicale-maint.sh pinned-purge --yes), tar.gz e zip della Fase 0 in backups/phase0/ (scripts/radicale-maint.sh phase0-purge --yes) e il volume Docker della Fase 0 (radicale_data, conservato in sola lettura per la decisione 7: scripts/radicale-maint.sh phase0-detect). Cancellarle o registrare il motivo della conservazione.',
  ];
}

/** Redazione dell'email nel testo delle righe di una tabella degli eventi (passo 2). Idempotente. */
async function redactEventRows(tx: Db, table: (typeof EVENT_TABLES)[number], email: string, pattern: string): Promise<EventRowRef[]> {
  return tx<EventRowRef[]>`
    UPDATE ${tx(table)} SET
      summary = regexp_replace(summary, ${pattern}, ${ERASURE_REDACTED_TEXT}, 'gi'),
      description = CASE WHEN description IS NULL THEN NULL ELSE regexp_replace(description, ${pattern}, ${ERASURE_REDACTED_TEXT}, 'gi') END,
      location = CASE WHEN location IS NULL THEN NULL ELSE regexp_replace(location, ${pattern}, ${ERASURE_REDACTED_TEXT}, 'gi') END,
      url = CASE WHEN url IS NULL THEN NULL ELSE regexp_replace(url, ${pattern}, ${ERASURE_REDACTED_TEXT}, 'gi') END
    WHERE strpos(lower(concat_ws(' ', summary, description, location, url)), ${email}) > 0
      AND (coalesce(summary, '') ~* ${pattern} OR coalesce(description, '') ~* ${pattern}
           OR coalesce(location, '') ~* ${pattern} OR coalesce(url, '') ~* ${pattern})
    RETURNING id::text AS id, recurrence_master_id::text AS recurrence_master_id, source, source_id, caldes_derived, caldes_object_id::text AS caldes_object_id
  `;
}

/**
 * Redazione di audit_logs (passo 3): righe delle prenotazioni e delle proiezioni toccate (campi personali per intero) e
 * righe che contengono l'email (calendario e chiamate MCP). Redazione in JS, valore per valore: l'email di un'altra
 * persona che la contiene come sottostringa resta. Idempotente: si ripete dopo la riscrittura da Radicale
 * (F4R-ROLL-04). Restituisce le righe modificate.
 */
async function redactAuditLogs(
  tx: Db,
  p: { email: string; re: RegExp; bookingIds: string[]; bookingUids: string[]; projectionIds: string[] },
): Promise<number> {
  const { email, re, bookingIds, bookingUids, projectionIds } = p;
  let redacted = 0;
  const auditRows = await tx<Array<{
    id: string; old_data: unknown; new_data: unknown; metadata: unknown; booking_match: boolean; projection_match: boolean;
  }>>`
    SELECT id::text AS id, old_data, new_data, metadata,
           (table_name = 'calendar_bookings'
            AND (record_id = ANY(${[...bookingIds, ...bookingUids]}::text[])
                 OR old_data->>'uid' = ANY(${bookingUids}::text[]) OR new_data->>'uid' = ANY(${bookingUids}::text[]))) AS booking_match,
           (table_name IN ('calendar_events', 'calendar_events_legacy')
            AND (record_id = ANY(${projectionIds}::text[])
                 OR (old_data->>'source' = 'booking' AND old_data->>'source_id' = ANY(${bookingUids}::text[]))
                 OR (new_data->>'source' = 'booking' AND new_data->>'source_id' = ANY(${bookingUids}::text[])))) AS projection_match
    FROM audit_logs
    WHERE (table_name = 'calendar_bookings'
           AND (record_id = ANY(${[...bookingIds, ...bookingUids]}::text[])
                OR old_data->>'uid' = ANY(${bookingUids}::text[]) OR new_data->>'uid' = ANY(${bookingUids}::text[])))
       OR (table_name IN ('calendar_events', 'calendar_events_legacy')
           AND (record_id = ANY(${projectionIds}::text[])
                OR (old_data->>'source' = 'booking' AND old_data->>'source_id' = ANY(${bookingUids}::text[]))
                OR (new_data->>'source' = 'booking' AND new_data->>'source_id' = ANY(${bookingUids}::text[]))))
       OR (table_name = ANY(${[...AUDIT_EMAIL_TABLES]}::text[])
           AND strpos(lower(concat_ws(' ', old_data::text, new_data::text, metadata::text)), ${email}) > 0)
    ORDER BY id
    FOR UPDATE
  `;
  for (const row of auditRows) {
    const opts = row.booking_match
      ? { re, fullKeys: BOOKING_PERSONAL_KEYS, nested: BOOKING_NESTED_PERSONAL_KEYS }
      : row.projection_match
        ? { re, fullKeys: PROJECTION_TEXT_KEYS }
        : { re };
    const oldData = row.old_data === null ? null : redactErasureJson(row.old_data, opts);
    const newData = row.new_data === null ? null : redactErasureJson(row.new_data, opts);
    const metadata = row.metadata === null ? null : redactErasureJson(row.metadata, { re });
    if (!jsonChanged(oldData, row.old_data) && !jsonChanged(newData, row.new_data) && !jsonChanged(metadata, row.metadata)) continue;
    await tx`
      UPDATE audit_logs SET
        old_data = ${oldData === null ? null : tx.json(oldData as never)}::jsonb,
        new_data = ${newData === null ? null : tx.json(newData as never)}::jsonb,
        metadata = ${metadata === null ? null : tx.json(metadata as never)}::jsonb
      WHERE id = ${row.id}::uuid
    `;
    redacted += 1;
  }
  return redacted;
}

async function eraseInTransaction(tx: Db, email: string, pattern: string, re: RegExp): Promise<ErasureTxResult> {
  const report: CalendarErasureReport = {
    bookings: 0, projections_legacy: 0, events_redacted: 0, audit_logs_redacted: 0, ledger_redacted: 0,
    migration_items_redacted: 0, migration_runs_redacted: 0, versions_purged: 0, jobs_enqueued: 0, reminders_redacted: 0, jobs_deleted: 0,
    manual_followup: [],
  };
  const state = await readMigrationStateFresh(tx);
  const storeKind = storeKindOverride() ?? storeKindForMode(state.mode);
  // Fuori da mode postgres le scritture legacy passano dalla guardia della F4 solo con il GUC (contratto f3 §13.1).
  if (state.mode !== 'postgres') await tx`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;

  // 1. Prenotazioni.
  const bookings = await tx<Array<{ id: string; uid: string; google_event_id: string | null; source_metadata: unknown }>>`
    SELECT id::text AS id, uid, google_event_id, source_metadata
    FROM calendar_bookings
    WHERE lower(attendee_email) = ${email}
    ORDER BY id
    FOR UPDATE
  `;
  const bookingIds = bookings.map((b) => b.id);
  const bookingUids = bookings.map((b) => b.uid);
  let anonymized: Array<{ id: string; uid: string; updated_at: Date }> = [];
  if (bookingIds.length > 0) {
    // source_metadata: user_agent tolto (è lo stesso dato di consent_user_agent), l'email sostituita dove compare.
    const metadata = bookings.map((b) => ({
      id: b.id,
      value: b.source_metadata === null || b.source_metadata === undefined
        ? null
        : redactErasureJson(b.source_metadata, { re, fullKeys: BOOKING_NESTED_PERSONAL_KEYS.source_metadata }),
    }));
    anonymized = await tx<Array<{ id: string; uid: string; updated_at: Date }>>`
      UPDATE calendar_bookings b SET
        attendee_name = ${ANONYMIZED_ATTENDEE_NAME},
        attendee_email = 'erased-' || b.id::text || '@deleted.invalid',
        attendee_phone = NULL,
        attendee_company = NULL,
        attendee_message = NULL,
        custom_responses = '{}'::jsonb,
        consent_ip = NULL,
        consent_user_agent = NULL,
        cancellation_reason = NULL,
        source_metadata = COALESCE(m.value, '{}'::jsonb)
      FROM (
        SELECT (e->>'id')::uuid AS id, CASE WHEN jsonb_typeof(e->'value') = 'object' THEN e->'value' END AS value
        FROM jsonb_array_elements(${tx.json(metadata as never)}::jsonb) e
      ) m
      WHERE b.id = m.id
      RETURNING b.id::text AS id, b.uid, b.updated_at
    `;
    const reminders = await tx`
      UPDATE calendar_booking_reminders SET sent_to = 'erased-' || id::text || '@deleted.invalid'
      WHERE booking_id = ANY(${bookingIds}::uuid[]) AND strpos(lower(sent_to), ${email}) > 0
      RETURNING id
    `;
    report.reminders_redacted = reminders.length;
  }
  report.bookings = anonymized.length;
  const googleEvents = bookings.filter((b) => (b.google_event_id ?? '').trim() !== '').length;

  // 2. Righe legacy: proiezioni delle prenotazioni e altre righe con l'email (con i confini: mai l'email di un'altra persona).
  const touchedRows: EventRowRef[] = [];
  const projectionRowIds: string[] = [];
  for (const table of EVENT_TABLES) {
    const [exists] = await tx<Array<{ ok: boolean }>>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS ok`;
    if (!exists?.ok) continue;
    if (bookingUids.length > 0) {
      const projections = await tx<EventRowRef[]>`
        UPDATE ${tx(table)} SET summary = ${RETAINED_PROJECTION_SUMMARY}, description = NULL, location = NULL, url = NULL
        WHERE source = 'booking' AND source_id = ANY(${bookingUids}::text[])
          AND (summary IS DISTINCT FROM ${RETAINED_PROJECTION_SUMMARY} OR description IS NOT NULL OR location IS NOT NULL OR url IS NOT NULL)
        RETURNING id::text AS id, recurrence_master_id::text AS recurrence_master_id, source, source_id, caldes_derived, caldes_object_id::text AS caldes_object_id
      `;
      report.projections_legacy += projections.length;
      touchedRows.push(...projections);
      projectionRowIds.push(...projections.map((r) => r.id));
      // Anche le righe già ridotte contano come proiezioni toccate per audit, ledger e indice.
      const already = await tx<Array<{ id: string }>>`
        SELECT id::text AS id FROM ${tx(table)} WHERE source = 'booking' AND source_id = ANY(${bookingUids}::text[])
      `;
      projectionRowIds.push(...already.map((r) => r.id));
    }
    const redacted = await redactEventRows(tx, table, email, pattern);
    report.events_redacted += redacted.length;
    touchedRows.push(...redacted);
  }

  // Chiavi toccate: proiezioni (booking:<uid>), eventi (event:<master>) e override staccati (detached:<id>).
  const jobKeys = new Set<LegacyKey>(bookingUids.map((uid) => `booking:${uid}` as LegacyKey));
  const ledgerKeys = new Set<LegacyKey>(jobKeys);
  const masterIds = new Set<string>();
  const touchedEventIds = new Set<string>();
  for (const row of touchedRows) {
    touchedEventIds.add(row.id.toLowerCase());
    const key = shadowKeyOf(row);
    if (!key) continue;
    jobKeys.add(key);
    ledgerKeys.add(key);
    if (key.startsWith('event:')) masterIds.add(key.slice('event:'.length));
    if (row.recurrence_master_id && row.source !== 'booking') ledgerKeys.add(`detached:${row.id.toLowerCase()}` as LegacyKey);
  }

  // Righe derivate (caldes_derived): la chiave del ledger e del job è la risorsa Radicale, event:<caldes_object_id>, non la
  // riga. Così la redazione dello snapshot del ledger colpisce la riga giusta. Il piano non riscrive mai un oggetto derived
  // (DERIVED_EDITED): l'avviso e il follow-up manuale sono in calendarErase.
  const derivedObjectIds = touchedEventIds.size > 0
    ? (await tx<Array<{ oid: string }>>`
        SELECT DISTINCT caldes_object_id::text AS oid FROM calendar_events
        WHERE id = ANY(${[...touchedEventIds]}::uuid[]) AND caldes_derived AND caldes_object_id IS NOT NULL
      `).map((r) => r.oid.toLowerCase())
    : [];
  for (const oid of derivedObjectIds) {
    jobKeys.add(`event:${oid}` as LegacyKey);
    ledgerKeys.add(`event:${oid}` as LegacyKey);
  }
  let derivedHrefs: ErasureTxResult['derivedHrefs'] = [];
  if (derivedObjectIds.length > 0 && state.mode === 'postgres') {
    derivedHrefs = (await tx<Array<{ object_id: string; href: string | null; collection: string | null }>>`
      SELECT o.id::text AS object_id, o.href, c.collection_name AS collection
      FROM cal_object_ids o LEFT JOIN calendars c ON c.id = o.calendar_id
      WHERE o.id::text = ANY(${derivedObjectIds}::text[]) AND o.recurrence_key = ''
      ORDER BY o.id
    `).map((r) => ({ ...r }));
  }

  // 3. Audit: righe delle prenotazioni e delle proiezioni toccate (campi personali per intero) e righe che contengono
  //    l'email (calendario e chiamate MCP), anche quelle scritte dalle UPDATE qui sopra. Redazione in JS, valore per
  //    valore: l'email di un'altra persona che la contiene come sottostringa resta.
  const projectionIds = uniq(projectionRowIds);
  report.audit_logs_redacted += await redactAuditLogs(tx, { email, re, bookingIds, bookingUids, projectionIds });

  // 4. Ledger della migrazione: snapshot delle chiavi toccate o che contengono l'email a NULL.
  const ledgerCandidates = await tx<Array<{ id: string; key_match: boolean; legacy_snapshot: unknown; intent_snapshot: unknown }>>`
    SELECT id::text AS id,
           (legacy_key = ANY(${[...ledgerKeys]}::text[])
            OR (kind = 'detached' AND legacy_snapshot->>'master_id' = ANY(${[...masterIds]}::text[]))) AS key_match,
           legacy_snapshot, intent_snapshot
    FROM cal_migration_ledger
    WHERE (legacy_snapshot IS NOT NULL OR intent_snapshot IS NOT NULL OR legacy_hash IS NOT NULL)
      AND (legacy_key = ANY(${[...ledgerKeys]}::text[])
           OR (kind = 'detached' AND legacy_snapshot->>'master_id' = ANY(${[...masterIds]}::text[]))
           OR strpos(lower(concat_ws(' ', legacy_snapshot::text, intent_snapshot::text)), ${email}) > 0)
    FOR UPDATE
  `;
  const ledgerIds = ledgerCandidates
    .filter((r) => r.key_match || jsonHasEmail(r.legacy_snapshot, re) || jsonHasEmail(r.intent_snapshot, re))
    .map((r) => r.id);
  const ledger = ledgerIds.length === 0 ? [] : await tx<Array<{ id: string; legacy_key: string; calendar_id: string; href: string }>>`
    UPDATE cal_migration_ledger SET legacy_snapshot = NULL, intent_snapshot = NULL, legacy_hash = NULL
    WHERE id = ANY(${ledgerIds}::bigint[])
    RETURNING id::text AS id, legacy_key, calendar_id::text AS calendar_id, href
  `;
  report.ledger_redacted = ledger.length;
  for (const row of ledger) {
    const parsed = parseLegacyKey(row.legacy_key);
    if (!parsed || parsed.kind === 'archive') continue;
    ledgerKeys.add(row.legacy_key as LegacyKey);
    if (parsed.kind === 'detached') continue; // lo shadow di event:<master> comprende i suoi staccati
    jobKeys.add(row.legacy_key as LegacyKey);
  }
  // Gli staccati redatti tornano al loro master per il job.
  const detachedMasters = await tx<Array<{ master_id: string | null }>>`
    SELECT DISTINCT o.recurrence_master_id::text AS master_id
    FROM calendar_events o
    WHERE o.id::text = ANY(${[...ledgerKeys].filter((k) => k.startsWith('detached:')).map((k) => k.slice('detached:'.length))}::text[])
  `;
  for (const r of detachedMasters) if (r.master_id) jobKeys.add(`event:${r.master_id.toLowerCase()}` as LegacyKey);

  // Righe dei run e run: l'email sostituita nei valori JSON (titoli degli eventi nei dettagli e nell'anteprima salvata).
  // Le righe restano: differenze ed esiti non contengono dati personali e da loro si ricalcolano verdetti e conflitti.
  const itemRows = await tx<Array<{ id: string; detail: unknown }>>`
    SELECT id::text AS id, detail FROM cal_migration_items
    WHERE strpos(lower(detail::text), ${email}) > 0
    ORDER BY id
    FOR UPDATE
  `;
  for (const row of itemRows) {
    const detail = redactErasureJson(row.detail, { re });
    if (!jsonChanged(detail, row.detail)) continue;
    await tx`UPDATE cal_migration_items SET detail = ${tx.json(detail as never)}::jsonb WHERE id = ${row.id}::bigint`;
    report.migration_items_redacted += 1;
  }
  const runRows = await tx<Array<{ id: string; params: unknown; summary: unknown; progress: unknown; error: string | null }>>`
    SELECT id::text AS id, params, summary, progress, error FROM cal_migration_runs
    WHERE strpos(lower(concat_ws(' ', params::text, summary::text, progress::text, error)), ${email}) > 0
    ORDER BY id
    FOR UPDATE
  `;
  for (const row of runRows) {
    const params = redactErasureJson(row.params, { re });
    const summary = row.summary === null ? null : redactErasureJson(row.summary, { re });
    const progress = redactErasureJson(row.progress, { re });
    const error = row.error === null ? null : (redactErasureJson(row.error, { re }) as string);
    if (!jsonChanged(params, row.params) && !jsonChanged(summary, row.summary) && !jsonChanged(progress, row.progress) && error === row.error) continue;
    await tx`
      UPDATE cal_migration_runs SET
        params = ${tx.json(params as never)}::jsonb,
        summary = ${summary === null ? null : tx.json(summary as never)}::jsonb,
        progress = ${tx.json(progress as never)}::jsonb,
        error = ${error}
      WHERE id = ${row.id}::uuid
    `;
    report.migration_runs_redacted += 1;
  }

  // 6. Versioni dell'indice degli oggetti toccati (testo iCalendar con le righe ripiegate riunite).
  const ledgerTargets = ledger.map((l) => `${l.calendar_id}|${l.href}`);
  const objectRows = await tx<Array<{ id: string }>>`
    SELECT DISTINCT r.id::text AS id
    FROM cal_object_ids r
    WHERE r.recurrence_key = '' AND (
      (r.calendar_id::text || '|' || r.href) = ANY(${ledgerTargets}::text[])
      OR EXISTS (
        SELECT 1 FROM cal_object_ids o
        WHERE o.calendar_id = r.calendar_id AND o.href = r.href
          AND o.legacy_event_id::text = ANY(${[...touchedEventIds, ...projectionRowIds.map((id) => id.toLowerCase())]}::text[])
      )
      OR (r.href = ANY(${bookingUids.map((uid) => `booking-${uid}.ics`)}::text[])
          AND EXISTS (SELECT 1 FROM calendars c WHERE c.id = r.calendar_id AND c.role = 'bookings'))
      OR EXISTS (SELECT 1 FROM cal_objects ob WHERE ob.id = r.id
                 AND regexp_replace(coalesce(ob.raw_ics, ''), ${ICS_UNFOLD_RE}, '', 'g') ~* ${pattern})
      OR EXISTS (SELECT 1 FROM cal_object_versions v WHERE v.object_id = r.id
                 AND regexp_replace(coalesce(v.raw_ics, ''), ${ICS_UNFOLD_RE}, '', 'g') ~* ${pattern})
    )
  `;
  report.versions_purged = await purgeVersionsForErasure(tx, { objectIds: objectRows.map((r) => r.id) });

  // Oggetti indicizzati con l'email che nessuna riscrittura automatica tocca, con qualsiasi store: l'archivio della
  // Fase 0 (origin 'migration': escluso da piano, shadow e facade) e, in mode postgres, le collezioni senza una riga
  // del ledger non di archivio (con lo store Radicale le riscrive la facade).
  const [archiveRow] = await tx<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM cal_objects ob
    JOIN calendars c ON c.id = ob.calendar_id
    WHERE c.role <> 'subscription'
      AND regexp_replace(coalesce(ob.raw_ics, ''), ${ICS_UNFOLD_RE}, '', 'g') ~* ${pattern}
      AND (
        c.origin = 'migration'
        OR (${storeKind === 'postgres'} AND NOT EXISTS (
          SELECT 1 FROM cal_migration_ledger l
          WHERE l.calendar_id = ob.calendar_id AND l.href = ob.href AND l.deleted_at IS NULL AND l.kind <> 'archive'
        ))
      )
  `;
  const archiveObjects = archiveRow?.n ?? 0;

  // 7. Job conclusi o morti: quelli delle prenotazioni e quelli che contengono l'email. I risultati dello shadow_mirror
  //    delle chiavi toccate restano (solo chiavi, href ed esiti): da loro si contano i conflitti aperti.
  const jobCandidates = await tx<Array<{ id: string; payload: unknown; result: unknown; last_error: string | null }>>`
    SELECT id::text AS id, payload, result, last_error FROM cal_jobs
    WHERE status IN ('done', 'dead', 'superseded')
      AND strpos(lower(concat_ws(' ', payload::text, result::text, last_error)), ${email}) > 0
  `;
  const emailJobIds = jobCandidates
    .filter((j) => jsonHasEmail(j.payload, re) || jsonHasEmail(j.result, re) || textHasEmail(j.last_error, re))
    .map((j) => j.id);
  const deletedJobs = await tx`
    DELETE FROM cal_jobs
    WHERE status IN ('done', 'dead', 'superseded')
      AND (
        (kind IN (${CAL_JOB_KINDS.projectBooking}, ${CAL_JOB_KINDS.bookingConflictCheck}) AND key = ANY(${bookingUids}::text[]))
        OR id = ANY(${emailJobIds}::bigint[])
      )
    RETURNING id
  `;
  report.jobs_deleted = deletedJobs.length;

  // 5. Destinazione (outbox: i job esistono solo dopo la COMMIT).
  let facadeUpdates = false;
  let shadowJobs = 0;
  let blockedKeys: string[] = [];
  if (state.mode === 'postgres') {
    if (state.volume_id) {
      blockedKeys = await erasureBlockedKeys(tx, [...jobKeys]);
      shadowJobs = jobKeys.size;
      for (const key of [...jobKeys].sort()) {
        await enqueueCalendarJob(SHADOW_MIRROR_JOB_KIND, key, { legacy_key: key, erasure: true }, {
          db: tx,
          priority: CAL_JOB_PRIORITY.high,
          delayMs: ERASURE_JOB_DELAY_MS,
        });
        report.jobs_enqueued += 1;
      }
    }
  } else if (storeKind === 'radicale') {
    // Anche le prenotazioni non proiettate: il job calcola lo stato desiderato all'esecuzione e toglie una risorsa rimasta.
    for (const b of anonymized) {
      await enqueueCalendarJob(CAL_JOB_KINDS.projectBooking, b.uid, {}, {
        db: tx,
        sourceVersion: new Date(b.updated_at).toISOString(),
      });
      report.jobs_enqueued += 1;
    }
    facadeUpdates = true;
  }

  return {
    report, facadeUpdates, googleEvents, archiveObjects, transition: writesSuspendedInMode(state.mode) ? state.mode : null, shadowJobs, blockedKeys,
    derivedObjectIds, derivedHrefs, postgresMode: state.mode === 'postgres',
    recheck: state.mode === 'postgres' ? null : { bookingIds, bookingUids, projectionIds },
  };
}

/**
 * Chiavi della cancellazione che lo shadow mirror probabilmente non riscriverà
 * (contratto f3 §13.1 passo 5): intento pendente nel ledger (esito ignoto) o
 * ultimo job shadow_mirror concluso con un conflitto. Solo chiavi (nessun dato
 * personale), ordinate.
 */
async function erasureBlockedKeys(tx: Db, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await tx<Array<{ legacy_key: string }>>`
    SELECT legacy_key FROM cal_migration_ledger
    WHERE legacy_key = ANY(${keys}::text[]) AND deleted_at IS NULL AND intent_op IS NOT NULL
    UNION
    SELECT key AS legacy_key FROM (
      SELECT DISTINCT ON (j.key) j.key, j.result
      FROM cal_jobs j
      WHERE j.kind = ${SHADOW_MIRROR_JOB_KIND} AND j.status = 'done' AND j.key = ANY(${keys}::text[])
      ORDER BY j.key, j.finished_at DESC NULLS LAST
    ) last
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(last.result->'items') = 'array' THEN last.result->'items' ELSE '[]'::jsonb END
      ) it WHERE it->>'outcome' = 'conflict'
    )
    ORDER BY 1
  `;
  return rows.map((r) => r.legacy_key);
}

/**
 * Store Radicale: componenti indicizzati (escluse iscrizioni, proiezioni e
 * archivio) che contengono l'email nel titolo, nella descrizione, nel luogo o
 * nel link, riscritti dalla facade con l'email sostituita (gate cal-write,
 * If-Match, versioni). Restituisce quanti ne ha aggiornati e gli id non
 * riusciti.
 */
async function redactIndexedEventsViaFacade(db: Db, email: string, pattern: string, re: RegExp): Promise<{ updated: number; failed: string[] }> {
  const rows = await db<Array<{ id: string; summary: string | null; description: string | null; location: string | null; url: string | null }>>`
    SELECT cc.id::text AS id, cc.summary, cc.description, cc.location, cc.url
    FROM cal_components cc
    JOIN cal_objects ob ON ob.id = cc.object_id
    JOIN calendars c ON c.id = cc.calendar_id
    WHERE c.role <> 'subscription' AND c.origin <> 'migration'
      AND NOT (c.role = 'bookings' AND ob.href LIKE 'booking-%')
      AND strpos(lower(concat_ws(' ', cc.summary, cc.description, cc.location, cc.url)), ${email}) > 0
      AND (coalesce(cc.summary, '') ~* ${pattern} OR coalesce(cc.description, '') ~* ${pattern}
           OR coalesce(cc.location, '') ~* ${pattern} OR coalesce(cc.url, '') ~* ${pattern})
    ORDER BY cc.calendar_id, cc.object_id, cc.recurrence_key
  `;
  if (rows.length === 0) return { updated: 0, failed: [] };
  const redact = (v: string | null): string | null => (v === null ? null : (redactErasureJson(v, { re }) as string));
  let store: Awaited<ReturnType<typeof calendarStoreForWrite>>;
  try {
    store = await calendarStoreForWrite();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.name : 'errore' }, 'redazione GDPR degli eventi indicizzati rimandata: scritture del calendario sospese');
    return { updated: 0, failed: rows.map((r) => r.id) };
  }
  let updated = 0;
  const failed: string[] = [];
  for (const row of rows) {
    const input: UpdateEventInput = {};
    const summary = redact(row.summary);
    if (summary !== row.summary && summary !== null) input.summary = summary;
    const description = redact(row.description);
    if (description !== row.description) input.description = description;
    const location = redact(row.location);
    if (location !== row.location) input.location = location;
    const url = redact(row.url);
    if (url !== row.url) input.url = url;
    if (Object.keys(input).length === 0) continue;
    try {
      const res = await store.updateEvent(row.id, input);
      if (res) updated += 1;
      else failed.push(row.id);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.name : 'errore', eventId: row.id }, 'redazione GDPR di un evento indicizzato non riuscita');
      failed.push(row.id);
    }
  }
  return { updated, failed };
}

// ─── Retention ───────────────────────────────

/**
 * Retention dello strumento di migrazione (design §16.4, contratto f3 §3.6):
 * run conclusi da oltre 30 giorni con le loro righe (CASCADE), tranne l'ultimo
 * run riuscito di ogni tipo (l'anteprima e la verifica di riferimento);
 * file caricati per l'archivio della Fase 0 oltre 24 ore, tranne quelli di un
 * run attivo.
 */
export async function purgeMigrationArtifacts(opts: { now?: Date } = {}): Promise<{ runs: number; uploads: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - MIGRATION_LIMITS.runRetentionDays * 86_400_000);
  const runs = await sql<Array<{ id: string }>>`
    DELETE FROM cal_migration_runs r
    WHERE r.status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
      AND r.finished_at IS NOT NULL AND r.finished_at < ${cutoff}
      AND r.id NOT IN (
        SELECT DISTINCT ON (kind) id FROM cal_migration_runs
        WHERE status = 'succeeded'
        ORDER BY kind, finished_at DESC NULLS LAST, created_at DESC
      )
    RETURNING r.id::text AS id
  `;

  const active = await sql<Array<{ path: string | null }>>`
    SELECT params->>'upload_path' AS path FROM cal_migration_runs
    WHERE kind = 'archive' AND status IN ('queued', 'running')
  `;
  const keep = new Set(active.map((r) => (r.path ? resolve(r.path) : '')).filter(Boolean));
  let uploads = 0;
  for (const dir of acceptedUploadDirs()) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      log.warn({ err: (err as Error).message, dir }, 'cartella dei file caricati per la migrazione non leggibile');
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (keep.has(resolve(path))) continue;
      try {
        const st = await stat(path);
        if (!st.isFile() || now.getTime() - st.mtimeMs < MIGRATION_UPLOAD_MAX_AGE_MS) continue;
        await unlink(path);
        uploads += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn({ err: (err as Error).message, file: name }, 'file caricato per la migrazione non cancellato');
      }
    }
  }
  if (runs.length > 0 || uploads > 0) log.info({ runs: runs.length, uploads }, 'retention dello strumento di migrazione');
  return { runs: runs.length, uploads };
}

/**
 * Retention delle proiezioni (decisione 3, contratto f3 §6.4 e §13.2): per le
 * prenotazioni proiettate la cui fine ha appena superato i 24 mesi (ultimi
 * PROJECTION_RETENTION_SWEEP_DAYS giorni), più quelle che risultano ancora non
 * minimizzate nella destinazione (indice con lo store Radicale, snapshot del
 * ledger in mode postgres), accoda la riscrittura: project_booking con lo
 * store Radicale (il job riscrive la risorsa con If-Match quando la
 * minimizzazione cambia stato), shadow_mirror con `payload.erasure = true` in
 * mode postgres con il volume inizializzato (con lo shadow acceso, e con lo
 * shadow spento per le sole risorse già scritte dallo strumento: il job non
 * crea mai oggetti nuovi). Negli altri casi nessun job (in mode postgres il
 * feed ricompone già le proiezioni da calendar_bookings). Restituisce quanti
 * job ha accodato.
 */
export async function enqueueExpiredProjectionRewrites(opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const state = await readMigrationStateFresh(sql);
  const storeKind = storeKindOverride() ?? storeKindForMode(state.mode);
  const statuses = [...PROJECTED_BOOKING_STATUSES];
  const sweepFrom = new Date(now.getTime() - PROJECTION_RETENTION_SWEEP_DAYS * 86_400_000);

  if (storeKind === 'radicale') {
    const rows = await sql<Array<{ uid: string; updated_at: Date }>>`
      SELECT b.uid, b.updated_at
      FROM calendar_bookings b
      WHERE b.status = ANY(${statuses}::text[])
        AND b.end_time + INTERVAL '24 months' <= ${now}
        AND (
          b.end_time + INTERVAL '24 months' > ${sweepFrom}
          OR EXISTS (
            SELECT 1
            FROM cal_objects ob
            JOIN calendars c ON c.id = ob.calendar_id AND c.role = 'bookings'
            JOIN cal_components cc ON cc.object_id = ob.id AND cc.recurrence_key = ''
            WHERE ob.href = 'booking-' || b.uid || '.ics'
              AND (cc.summary IS DISTINCT FROM ${RETAINED_PROJECTION_SUMMARY}
                   OR cc.description IS NOT NULL OR cc.location IS NOT NULL OR cc.url IS NOT NULL)
          )
        )
      ORDER BY b.end_time, b.uid
    `;
    for (const r of rows) {
      await enqueueCalendarJob(CAL_JOB_KINDS.projectBooking, r.uid, {}, { sourceVersion: new Date(r.updated_at).toISOString() });
    }
    if (rows.length > 0) log.info({ jobs: rows.length, store: 'radicale' }, 'proiezioni oltre i 24 mesi da minimizzare');
    return rows.length;
  }

  // Mode postgres: solo con il volume inizializzato. Con lo shadow acceso tutte quelle appena scadute; con lo
  // shadow spento solo le risorse già scritte dallo strumento (il job, come quelli dell'erasure, non crea nulla).
  if (state.mode !== 'postgres' || !state.volume_id) return 0;
  const rows = await sql<Array<{ uid: string }>>`
    SELECT b.uid
    FROM calendar_bookings b
    LEFT JOIN LATERAL (
      SELECT (l.legacy_snapshot->>'minimized') IS NOT DISTINCT FROM 'true' AS minimized
      FROM cal_migration_ledger l
      WHERE l.legacy_key = 'booking:' || b.uid AND l.kind = 'booking' AND l.deleted_at IS NULL AND l.written_etag IS NOT NULL
      LIMIT 1
    ) tracked ON true
    WHERE b.status = ANY(${statuses}::text[])
      AND b.end_time + INTERVAL '24 months' <= ${now}
      AND (
        (b.end_time + INTERVAL '24 months' > ${sweepFrom} AND (${state.shadow_enabled} OR tracked.minimized IS NOT NULL))
        OR tracked.minimized = false
      )
    ORDER BY b.end_time, b.uid
  `;
  for (const r of rows) {
    const key = `booking:${r.uid}`;
    // erasure: true (contratto f3 §9.1): il job gira anche se lo shadow si spegne nel frattempo, solo sugli oggetti tracciati.
    await enqueueCalendarJob(SHADOW_MIRROR_JOB_KIND, key, { legacy_key: key, erasure: true, reason: 'retention' }, {
      priority: CAL_JOB_PRIORITY.low,
    });
  }
  if (rows.length > 0) log.info({ jobs: rows.length, store: 'postgres' }, 'proiezioni oltre i 24 mesi da minimizzare (shadow)');
  return rows.length;
}
