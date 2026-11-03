/**
 * PgLegacyStore, iscrizioni: CRUD su calendar_subscriptions + sync legacy
 * verso calendar_events.
 *
 * Codice spostato da lib/calendar/subscriptions.ts nella fase F2 del passaggio
 * a Radicale SENZA modifiche di comportamento (cambiano solo i percorsi degli
 * import: errori in ../errors, tipi in ../types). Il sottoinsieme bacato di
 * parseIcs e la trappola del 304 restano: parità prima del cutover (design
 * §6.6). Lo usa solo PgLegacyStore in ../store.ts. Si elimina in F7.
 *
 * Contenuto originale:
 *
 * Una subscription è un URL ICS pubblico (es. "secret iCal" di Google Calendar)
 * che importiamo periodicamente in un calendar Caldes. Gli eventi importati hanno
 * `source='ics_pull'` e `subscription_id=<sub.id>` — il loro ciclo di vita è legato
 * alla subscription (cascade delete) e NON vengono ripubblicati dal feed ICS in uscita
 * (filtro in `ics-feed.ts`).
 *
 * Sync strategy (full reconcile):
 *   1. fetch ICS (con If-None-Match / If-Modified-Since per evitare re-download)
 *   2. parse VEVENT
 *   3. dentro una transazione: cancella tutti gli eventi della subscription e reinserisce
 *      il set fresco. È semplice, atomico e si lascia dietro un calendar_events pulito.
 *      Trade-off: gli ID UUID degli eventi cambiano ad ogni sync (non li usiamo come riferimento esterno).
 *
 * Anti-wipe: un feed che parse-a a 0 eventi con eventi locali presenti fa rollback
 * (vedi replaceSubscriptionEvents) — solo il sync manuale con `force` può svuotare.
 */

import { customAlphabet } from 'nanoid';
import { sql, sqlInsert } from '../../../db';
import { SubscriptionValidationError } from '../errors';
import { fetchIcs, parseIcs, IcsImportError, type ParsedEvent } from '../ics-import';
import { logger } from '../../logger';
import type {
  CalendarSubscription,
  CreateSubscriptionInput,
  SyncResult,
  UpdateSubscriptionInput,
} from '../types';

const log = logger.child({ scope: 'ics-pull' });

const generateEventUid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

const COLUMNS = sql`
  id, calendar_id, name, ics_url, sync_enabled,
  last_synced_at, last_error, etag, last_modified, event_count,
  created_at, updated_at
`;

// ============================================
// CRUD
// ============================================

export async function listSubscriptions(): Promise<CalendarSubscription[]> {
  const rows = await sql<CalendarSubscription[]>`
    SELECT ${COLUMNS} FROM calendar_subscriptions ORDER BY created_at DESC
  `;
  return rows;
}

export async function getSubscription(id: string): Promise<CalendarSubscription | null> {
  const rows = await sql<CalendarSubscription[]>`
    SELECT ${COLUMNS} FROM calendar_subscriptions WHERE id = ${id}::uuid LIMIT 1
  `;
  return rows[0] || null;
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<CalendarSubscription> {
  if (!input.calendar_id) throw new SubscriptionValidationError('calendar_id richiesto');
  if (!input.name?.trim()) throw new SubscriptionValidationError('Nome richiesto');
  if (!/^https?:\/\//i.test(input.ics_url)) {
    throw new SubscriptionValidationError('URL ICS deve iniziare con http:// o https://');
  }

  const rows = await sql<CalendarSubscription[]>`
    INSERT INTO calendar_subscriptions ${sqlInsert({
      calendar_id: input.calendar_id,
      name: input.name.trim().slice(0, 200),
      ics_url: input.ics_url.trim(),
      sync_enabled: true,
    })}
    RETURNING ${COLUMNS}
  `;
  return rows[0];
}

export async function updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<CalendarSubscription | null> {
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = String(input.name).trim().slice(0, 200);
  if (input.ics_url !== undefined) {
    if (!/^https?:\/\//i.test(input.ics_url)) {
      throw new SubscriptionValidationError('URL ICS deve iniziare con http:// o https://');
    }
    updates.ics_url = String(input.ics_url).trim();
    // Reset cache ETag perché l'URL è cambiato
    updates.etag = null;
    updates.last_modified = null;
  }
  if (input.sync_enabled !== undefined) updates.sync_enabled = !!input.sync_enabled;
  if (input.calendar_id !== undefined) updates.calendar_id = input.calendar_id;

  if (Object.keys(updates).length === 0) return getSubscription(id);

  const rows = await sql<CalendarSubscription[]>`
    UPDATE calendar_subscriptions SET ${sql(updates)}
    WHERE id = ${id}::uuid
    RETURNING ${COLUMNS}
  `;
  return rows[0] || null;
}

export async function deleteSubscription(id: string): Promise<boolean> {
  // CASCADE su calendar_events.subscription_id elimina automaticamente gli eventi importati
  const rows = await sql`DELETE FROM calendar_subscriptions WHERE id = ${id}::uuid RETURNING id`;
  return rows.length > 0;
}

// ============================================
// Sync engine
// ============================================

/**
 * Esegue il sync di una singola subscription. Idempotente: re-eseguito senza modifiche
 * sull'origine, riconosce 304 Not Modified via ETag e termina senza scrivere.
 *
 * `force`: ignora la cache ETag/Last-Modified (ri-scarica sempre) e accetta anche
 * un feed legittimamente vuoto (bypassa la protezione anti-wipe). Mai usato dal cron;
 * riservato al sync manuale esplicito dell'admin.
 */
export async function syncSubscription(id: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const sub = await getSubscription(id);
  if (!sub) throw new SubscriptionValidationError('Subscription non trovata');

  try {
    const fetched = await fetchIcs(sub.ics_url, opts.force ? {} : {
      etag: sub.etag,
      lastModified: sub.last_modified,
    });

    if (fetched.notModified) {
      // Tocca solo last_synced_at, nessuna scrittura su calendar_events
      await sql`
        UPDATE calendar_subscriptions
        SET last_synced_at = NOW(), last_error = NULL
        WHERE id = ${sub.id}::uuid
      `;
      return { notModified: true, inserted: 0, removed: 0, error: null };
    }

    // Body vuoto/null passa comunque da parseIcs: senza BEGIN:VCALENDAR lancia
    // IcsImportError → last_error, invece di essere trattato come feed a 0 eventi.
    const parsed = parseIcs(fetched.body ?? '');
    const { inserted, removed } = await replaceSubscriptionEvents(sub.id, sub.calendar_id, parsed, {
      allowEmpty: opts.force,
    });

    await sql`
      UPDATE calendar_subscriptions SET
        last_synced_at = NOW(),
        last_error = NULL,
        etag = ${fetched.etag},
        last_modified = ${fetched.lastModified},
        event_count = ${inserted}
      WHERE id = ${sub.id}::uuid
    `;

    return { notModified: false, inserted, removed, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE calendar_subscriptions
      SET last_synced_at = NOW(), last_error = ${msg.slice(0, 1000)}
      WHERE id = ${sub.id}::uuid
    `;
    // Non rilanciamo: il cron deve continuare con le altre subscription
    if (err instanceof IcsImportError) {
      return { notModified: false, inserted: 0, removed: 0, error: msg };
    }
    log.error({ err, subscriptionId: id }, 'sync failed for subscription');
    return { notModified: false, inserted: 0, removed: 0, error: msg };
  }
}

/**
 * Replace atomico degli eventi di una subscription. Due fasi nello stesso statement:
 *  1. DELETE FROM calendar_events WHERE subscription_id = $1
 *  2. INSERT degli eventi parsati
 *
 * Strategia "master + override": nella seconda passata, gli eventi con RECURRENCE-ID
 * vengono linkati al master via UID remoto → cerchiamo l'ID locale appena inserito.
 *
 * Anti-wipe: un feed parsato a 0 eventi mentre localmente ce ne sono N è quasi
 * sempre un feed remoto rotto, non uno svuotamento intenzionale — il throw fa
 * rollback della transazione e gli eventi locali restano intatti. `allowEmpty`
 * (sync manuale con force) è l'unico modo di svuotare davvero.
 * Esportata (non usata fuori dal modulo a runtime) per il test in verify-calendar.ts.
 */
export async function replaceSubscriptionEvents(
  subscriptionId: string,
  calendarId: string,
  parsed: ParsedEvent[],
  opts: { allowEmpty?: boolean } = {},
): Promise<{ inserted: number; removed: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres driver tx type narrows away the tagged-template call signature
  return await sql.begin(async (tx: any) => {
    // Step 1: rimuovi tutti gli eventi correnti della subscription
    const removedRows = await tx`
      DELETE FROM calendar_events WHERE subscription_id = ${subscriptionId}::uuid RETURNING id
    `;
    const removed = removedRows.length;

    if (parsed.length === 0) {
      if (removed > 0 && !opts.allowEmpty) {
        throw new IcsImportError(
          `Feed vuoto ma ${removed} eventi presenti localmente: sync annullato (protezione anti-wipe). ` +
          'Se il calendario remoto è stato davvero svuotato, usa il sync manuale con force.',
        );
      }
      return { inserted: 0, removed };
    }

    // Step 2: separa master/single da override (RECURRENCE-ID)
    // Google emette spesso master+override con stesso UID; manteniamo la stessa
    // semantica di calendar_events: master = riga base, override = riga con
    // recurrence_master_id + recurrence_id valorizzati.
    const masters = parsed.filter((p) => !p.recurrence_id);
    const overrides = parsed.filter((p) => p.recurrence_id);

    // Inserisci master/single per primi: ci servono gli ID per linkare gli override
    const remoteUidToLocalId = new Map<string, string>();
    let inserted = 0;
    for (const ev of masters) {
      const localUid = generateEventUid();
      const insertedRows = await tx<{ id: string }[]>`
        INSERT INTO calendar_events ${sqlInsert({
          calendar_id: calendarId,
          subscription_id: subscriptionId,
          uid: localUid,
          summary: ev.summary,
          description: ev.description,
          location: ev.location,
          url: ev.url,
          start_time: ev.start_time,
          end_time: ev.end_time,
          all_day: ev.all_day,
          rrule: ev.rrule,
          exdates: ev.exdates,
          recurrence_id: null,
          recurrence_master_id: null,
          source: 'ics_pull',
          source_id: ev.remote_uid.slice(0, 500),
          status: ev.status,
        })}
        RETURNING id
      `;
      remoteUidToLocalId.set(ev.remote_uid, insertedRows[0].id);
      inserted++;
    }

    // Inserisci override; se il master non è presente nel feed corrente li trattiamo
    // come eventi singoli (recurrence_master_id NULL) per evitare orfani che violano
    // il CHECK constraint di calendar_events.
    for (const ov of overrides) {
      const masterId = remoteUidToLocalId.get(ov.remote_uid) || null;
      await tx`
        INSERT INTO calendar_events ${sqlInsert({
          calendar_id: calendarId,
          subscription_id: subscriptionId,
          uid: generateEventUid(),
          summary: ov.summary,
          description: ov.description,
          location: ov.location,
          url: ov.url,
          start_time: ov.start_time,
          end_time: ov.end_time,
          all_day: ov.all_day,
          rrule: null,
          exdates: [],
          recurrence_id: masterId ? ov.recurrence_id : null,
          recurrence_master_id: masterId,
          source: 'ics_pull',
          source_id: `${ov.remote_uid.slice(0, 480)}@${ov.recurrence_id?.slice(0, 19) ?? ''}`,
          status: ov.status,
        })}
      `;
      inserted++;
    }

    return { inserted, removed };
  });
}

/**
 * Sync di tutte le subscription abilitate. Chiamato dal cron job.
 */
export async function syncAllSubscriptions(): Promise<{ total: number; ok: number; failed: number; notModified: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM calendar_subscriptions WHERE sync_enabled = true
  `;
  let ok = 0;
  let failed = 0;
  let notModified = 0;
  for (const { id } of rows) {
    const res = await syncSubscription(id);
    if (res.error) failed++;
    else if (res.notModified) { ok++; notModified++; }
    else ok++;
  }
  return { total: rows.length, ok, failed, notModified };
}
