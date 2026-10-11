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
 *     `SET LOCAL caldes.reverse_sync = 'on'` (guardia 166 della F4);
 *  3. audit_logs di calendar_events e calendar_bookings delle righe toccate,
 *     o che contengono l'email, redatti in old_data e new_data (il trigger
 *     118 salva to_jsonb della riga, DESCRIPTION compresa): comprese le righe
 *     scritte dalle UPDATE dei passi 1 e 2, che stanno nella stessa
 *     transazione;
 *  4. ledger della migrazione: righe delle chiavi toccate (o con l'email negli
 *     snapshot) con legacy_snapshot, intent_snapshot e legacy_hash a NULL (il
 *     piano successivo riscrive la destinazione); righe dei run
 *     (cal_migration_items) che citano le chiavi o l'email cancellate;
 *  5. destinazione: in mode postgres con il volume inizializzato, job
 *     shadow_mirror con `payload.erasure = true` per le chiavi toccate
 *     (eseguiti anche con lo shadow spento: patch dei campi redatti, proiezioni
 *     minimizzate); con lo store Radicale, project_booking per le prenotazioni
 *     (la risorsa minimizzata si riscrive con If-Match) e update dalla facade
 *     per gli altri eventi indicizzati che contengono l'email, dopo la COMMIT;
 *  6. indice: versioni degli oggetti toccati cancellate (purgeVersionsForErasure,
 *     f2-modules §5.6); raw_ics si aggiorna con la sync dopo la riscrittura;
 *  7. cal_jobs conclusi o morti delle chiavi toccate: cancellati;
 *  8. seguito manuale nella risposta: purge della cache degli item di
 *     Radicale sul server, scadenza dei backup, eventi Google collegati.
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

/** Tabelle degli audit da redigere (design §16.4). */
const AUDITED_TABLES = ['calendar_events', 'calendar_bookings'] as const;

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
  migration_items_deleted: number;
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

/** Pattern (regex ARE di Postgres) che trova l'email in un testo, senza distinzione di maiuscole con il flag 'i'. */
export function erasureEmailPattern(email: string): string {
  return email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
function shadowKeyOf(row: { id: string; recurrence_master_id: string | null; source: string; source_id: string | null }): LegacyKey | null {
  if (row.source === 'ics_pull') return null;
  const sourceId = (row.source_id ?? '').trim();
  if (row.source === 'booking' && sourceId) return `booking:${sourceId}` as LegacyKey;
  return `event:${String(row.recurrence_master_id ?? row.id).toLowerCase()}` as LegacyKey;
}

/**
 * Espressione SQL che redige un oggetto JSONB (old_data/new_data degli audit,
 * source_metadata): le chiavi in `fullKeys` con un valore non nullo diventano
 * "[dato rimosso]", nelle stringhe l'email si sostituisce, un valore annidato
 * (oggetto o array) che contiene l'email diventa "[dato rimosso]".
 */
function redactJsonExpr(tx: Db, column: string, opts: { email: string; pattern: string; fullKeys: readonly string[] }) {
  const col = tx(column);
  return tx`
    CASE WHEN ${col} IS NULL OR jsonb_typeof(${col}) <> 'object' THEN ${col} ELSE (
      SELECT COALESCE(jsonb_object_agg(e.key, CASE
        WHEN e.key = ANY(${[...opts.fullKeys]}::text[]) AND e.value <> 'null'::jsonb THEN to_jsonb(${ERASURE_REDACTED_TEXT}::text)
        WHEN jsonb_typeof(e.value) = 'string' THEN to_jsonb(regexp_replace(e.value #>> '{}', ${opts.pattern}, ${ERASURE_REDACTED_TEXT}, 'gi'))
        WHEN jsonb_typeof(e.value) IN ('object', 'array') AND strpos(lower(e.value::text), ${opts.email}) > 0 THEN to_jsonb(${ERASURE_REDACTED_TEXT}::text)
        ELSE e.value END), '{}'::jsonb)
      FROM jsonb_each(${col}) e
    ) END
  `;
}

// ─── Cancellazione ───────────────────────────────

interface EventRowRef {
  id: string;
  recurrence_master_id: string | null;
  source: string;
  source_id: string | null;
}

interface ErasureTxResult {
  report: CalendarErasureReport;
  facadeUpdates: boolean;
  googleEvents: number;
  archiveObjects: number;
  /** Transizione in corso (cutover o rollback): la destinazione si riscrive a transizione conclusa. */
  transition: string | null;
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

  const txResult = await inTx(db, (tx) => eraseInTransaction(tx, normalized, pattern));
  const report = txResult.report;

  // Store Radicale: gli eventi indicizzati che contengono l'email si riscrivono dalla facade (gate, If-Match, versioni).
  if (txResult.facadeUpdates) {
    const outcome = await redactIndexedEventsViaFacade(db, normalized, pattern);
    report.events_redacted += outcome.updated;
    if (outcome.failed.length > 0) {
      report.manual_followup.push(
        `Eventi del calendario con l'email non riscritti su Radicale (${outcome.failed.length}): ripetere la cancellazione o correggerli dall'admin (id: ${outcome.failed.slice(0, 20).join(', ')}).`,
      );
    }
  }

  report.manual_followup.push(
    'Sul server del calendario: eseguire scripts/radicale-maint.sh purge-cache per svuotare la cache degli item di Radicale (si ricostruisce da sola).',
    'I backup dello stack del calendario e del database contengono ancora i dati fino alla loro scadenza (30 giorni).',
  );
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
  if (txResult.archiveObjects > 0) {
    report.manual_followup.push(
      `Item dell'archivio della Fase 0 (o di collezioni senza sorgente legacy) che contengono l'email (${txResult.archiveObjects}): rimuoverli a mano dalla collezione su Radicale.`,
    );
  }

  log.info({
    actor: opts.actor,
    bookings: report.bookings,
    projections_legacy: report.projections_legacy,
    events_redacted: report.events_redacted,
    audit_logs_redacted: report.audit_logs_redacted,
    ledger_redacted: report.ledger_redacted,
    migration_items_deleted: report.migration_items_deleted,
    versions_purged: report.versions_purged,
    jobs_enqueued: report.jobs_enqueued,
  }, 'cancellazione GDPR dei dati del calendario completata');
  return report;
}

async function eraseInTransaction(tx: Db, email: string, pattern: string): Promise<ErasureTxResult> {
  const report: CalendarErasureReport = {
    bookings: 0, projections_legacy: 0, events_redacted: 0, audit_logs_redacted: 0, ledger_redacted: 0,
    migration_items_deleted: 0, versions_purged: 0, jobs_enqueued: 0, reminders_redacted: 0, jobs_deleted: 0,
    manual_followup: [],
  };
  const state = await readMigrationStateFresh(tx);
  const storeKind = storeKindOverride() ?? storeKindForMode(state.mode);
  // Fuori da mode postgres le scritture legacy passano dalla guardia della F4 solo con il GUC (contratto f3 §13.1).
  if (state.mode !== 'postgres') await tx`SELECT set_config('caldes.reverse_sync', 'on', true)`;

  // 1. Prenotazioni.
  const bookings = await tx<Array<{ id: string; uid: string; google_event_id: string | null }>>`
    SELECT id::text AS id, uid, google_event_id
    FROM calendar_bookings
    WHERE lower(attendee_email) = ${email}
    ORDER BY id
    FOR UPDATE
  `;
  const bookingIds = bookings.map((b) => b.id);
  const bookingUids = bookings.map((b) => b.uid);
  let anonymized: Array<{ id: string; uid: string; updated_at: Date }> = [];
  if (bookingIds.length > 0) {
    anonymized = await tx<Array<{ id: string; uid: string; updated_at: Date }>>`
      UPDATE calendar_bookings SET
        attendee_name = ${ANONYMIZED_ATTENDEE_NAME},
        attendee_email = 'erased-' || id::text || '@deleted.invalid',
        attendee_phone = NULL,
        attendee_company = NULL,
        attendee_message = NULL,
        custom_responses = '{}'::jsonb,
        consent_ip = NULL,
        consent_user_agent = NULL,
        cancellation_reason = NULL,
        source_metadata = ${redactJsonExpr(tx, 'source_metadata', { email, pattern, fullKeys: [] })}
      WHERE id = ANY(${bookingIds}::uuid[])
      RETURNING id::text AS id, uid, updated_at
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

  // 2. Righe legacy: proiezioni delle prenotazioni e altre righe con l'email.
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
        RETURNING id::text AS id, recurrence_master_id::text AS recurrence_master_id, source, source_id
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
    const redacted = await tx<EventRowRef[]>`
      UPDATE ${tx(table)} SET
        summary = regexp_replace(summary, ${pattern}, ${ERASURE_REDACTED_TEXT}, 'gi'),
        description = CASE WHEN description IS NULL THEN NULL ELSE regexp_replace(description, ${pattern}, ${ERASURE_REDACTED_TEXT}, 'gi') END,
        location = CASE WHEN location IS NULL THEN NULL ELSE regexp_replace(location, ${pattern}, ${ERASURE_REDACTED_TEXT}, 'gi') END,
        url = CASE WHEN url IS NULL THEN NULL ELSE regexp_replace(url, ${pattern}, ${ERASURE_REDACTED_TEXT}, 'gi') END
      WHERE strpos(lower(coalesce(summary, '')), ${email}) > 0
         OR strpos(lower(coalesce(description, '')), ${email}) > 0
         OR strpos(lower(coalesce(location, '')), ${email}) > 0
         OR strpos(lower(coalesce(url, '')), ${email}) > 0
      RETURNING id::text AS id, recurrence_master_id::text AS recurrence_master_id, source, source_id
    `;
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

  // 3. Audit di calendar_events e calendar_bookings (anche quelli scritti dalle UPDATE qui sopra).
  const auditIds = new Set<string>();
  if (bookingIds.length > 0) {
    const rows = await tx<Array<{ id: string }>>`
      UPDATE audit_logs SET
        old_data = ${redactJsonExpr(tx, 'old_data', { email, pattern, fullKeys: BOOKING_PERSONAL_KEYS })},
        new_data = ${redactJsonExpr(tx, 'new_data', { email, pattern, fullKeys: BOOKING_PERSONAL_KEYS })}
      WHERE table_name = 'calendar_bookings'
        AND (record_id = ANY(${[...bookingIds, ...bookingUids]}::text[])
             OR old_data->>'uid' = ANY(${bookingUids}::text[]) OR new_data->>'uid' = ANY(${bookingUids}::text[]))
      RETURNING id::text AS id
    `;
    rows.forEach((r) => auditIds.add(r.id));
  }
  if (bookingUids.length > 0 || projectionRowIds.length > 0) {
    const rows = await tx<Array<{ id: string }>>`
      UPDATE audit_logs SET
        old_data = ${redactJsonExpr(tx, 'old_data', { email, pattern, fullKeys: PROJECTION_TEXT_KEYS })},
        new_data = ${redactJsonExpr(tx, 'new_data', { email, pattern, fullKeys: PROJECTION_TEXT_KEYS })}
      WHERE table_name IN ('calendar_events', 'calendar_events_legacy')
        AND (record_id = ANY(${uniq(projectionRowIds)}::text[])
             OR (old_data->>'source' = 'booking' AND old_data->>'source_id' = ANY(${bookingUids}::text[]))
             OR (new_data->>'source' = 'booking' AND new_data->>'source_id' = ANY(${bookingUids}::text[])))
      RETURNING id::text AS id
    `;
    rows.forEach((r) => auditIds.add(r.id));
  }
  {
    const rows = await tx<Array<{ id: string }>>`
      UPDATE audit_logs SET
        old_data = ${redactJsonExpr(tx, 'old_data', { email, pattern, fullKeys: [] })},
        new_data = ${redactJsonExpr(tx, 'new_data', { email, pattern, fullKeys: [] })}
      WHERE table_name = ANY(${[...AUDITED_TABLES, 'calendar_events_legacy']}::text[])
        AND (strpos(lower(coalesce(old_data::text, '')), ${email}) > 0 OR strpos(lower(coalesce(new_data::text, '')), ${email}) > 0)
      RETURNING id::text AS id
    `;
    rows.forEach((r) => auditIds.add(r.id));
  }
  report.audit_logs_redacted = auditIds.size;

  // 4. Ledger della migrazione e righe dei run.
  const ledger = await tx<Array<{ id: string; legacy_key: string; calendar_id: string; href: string }>>`
    UPDATE cal_migration_ledger SET legacy_snapshot = NULL, intent_snapshot = NULL, legacy_hash = NULL
    WHERE (legacy_key = ANY(${[...ledgerKeys]}::text[])
           OR (kind = 'detached' AND legacy_snapshot->>'master_id' = ANY(${[...masterIds]}::text[]))
           OR strpos(lower(coalesce(legacy_snapshot::text, '')), ${email}) > 0
           OR strpos(lower(coalesce(intent_snapshot::text, '')), ${email}) > 0)
      AND (legacy_snapshot IS NOT NULL OR intent_snapshot IS NOT NULL OR legacy_hash IS NOT NULL)
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

  const items = await tx`
    DELETE FROM cal_migration_items
    WHERE legacy_key = ANY(${[...ledgerKeys]}::text[]) OR strpos(lower(detail::text), ${email}) > 0
    RETURNING id
  `;
  report.migration_items_deleted = items.length;

  // 6. Versioni dell'indice degli oggetti toccati.
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
      OR EXISTS (SELECT 1 FROM cal_objects ob WHERE ob.id = r.id AND strpos(lower(coalesce(ob.raw_ics, '')), ${email}) > 0)
      OR EXISTS (SELECT 1 FROM cal_object_versions v WHERE v.object_id = r.id AND strpos(lower(coalesce(v.raw_ics, '')), ${email}) > 0)
    )
  `;
  report.versions_purged = await purgeVersionsForErasure(tx, { objectIds: objectRows.map((r) => r.id) });

  // Oggetti indicizzati con l'email che nessuna riscrittura toccherà in mode postgres (archivio della Fase 0, collezioni non migrate).
  let archiveObjects = 0;
  if (storeKind === 'postgres') {
    const [row] = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM cal_objects ob
      JOIN calendars c ON c.id = ob.calendar_id
      WHERE c.role <> 'subscription' AND strpos(lower(coalesce(ob.raw_ics, '')), ${email}) > 0
        AND NOT EXISTS (
          SELECT 1 FROM cal_migration_ledger l
          WHERE l.calendar_id = ob.calendar_id AND l.href = ob.href AND l.deleted_at IS NULL AND l.kind <> 'archive'
        )
    `;
    archiveObjects = row?.n ?? 0;
  }

  // 7. Job conclusi o morti delle chiavi toccate.
  const deletedJobs = await tx`
    DELETE FROM cal_jobs
    WHERE status IN ('done', 'dead', 'superseded')
      AND (
        (kind = ${SHADOW_MIRROR_JOB_KIND} AND key = ANY(${[...jobKeys, ...ledgerKeys]}::text[]))
        OR (kind IN (${CAL_JOB_KINDS.projectBooking}, ${CAL_JOB_KINDS.bookingConflictCheck}) AND key = ANY(${bookingUids}::text[]))
        OR strpos(lower(payload::text || coalesce(result::text, '') || coalesce(last_error, '')), ${email}) > 0
      )
    RETURNING id
  `;
  report.jobs_deleted = deletedJobs.length;

  // 5. Destinazione (outbox: i job esistono solo dopo la COMMIT).
  let facadeUpdates = false;
  if (state.mode === 'postgres') {
    if (state.volume_id) {
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

  return { report, facadeUpdates, googleEvents, archiveObjects, transition: writesSuspendedInMode(state.mode) ? state.mode : null };
}

/**
 * Store Radicale: componenti indicizzati (escluse iscrizioni, proiezioni e
 * archivio) che contengono l'email nel titolo, nella descrizione, nel luogo o
 * nel link, riscritti dalla facade con l'email sostituita (gate cal-write,
 * If-Match, versioni). Restituisce quanti ne ha aggiornati e gli id non
 * riusciti.
 */
async function redactIndexedEventsViaFacade(db: Db, email: string, pattern: string): Promise<{ updated: number; failed: string[] }> {
  const rows = await db<Array<{ id: string; summary: string | null; description: string | null; location: string | null; url: string | null }>>`
    SELECT cc.id::text AS id, cc.summary, cc.description, cc.location, cc.url
    FROM cal_components cc
    JOIN cal_objects ob ON ob.id = cc.object_id
    JOIN calendars c ON c.id = cc.calendar_id
    WHERE c.role <> 'subscription' AND c.origin <> 'migration'
      AND NOT (c.role = 'bookings' AND ob.href LIKE 'booking-%')
      AND (strpos(lower(coalesce(cc.summary, '')), ${email}) > 0
           OR strpos(lower(coalesce(cc.description, '')), ${email}) > 0
           OR strpos(lower(coalesce(cc.location, '')), ${email}) > 0
           OR strpos(lower(coalesce(cc.url, '')), ${email}) > 0)
    ORDER BY cc.calendar_id, cc.object_id, cc.recurrence_key
  `;
  if (rows.length === 0) return { updated: 0, failed: [] };
  const re = new RegExp(pattern, 'gi');
  const redact = (v: string | null): string | null => (v === null ? null : v.replace(re, ERASURE_REDACTED_TEXT));
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
