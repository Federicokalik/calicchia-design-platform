/**
 * Busy del calendario per slot, capacity e prenotazioni (fase F2 del
 * passaggio a Radicale; design §6.4, §6.5, §7, §9, §14 "local-busy
 * fail-open"; decisione 1; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §7.1).
 *
 * Sostituisce local-busy.ts, che in caso di errore restituiva [] (fail-open:
 * un DB lento o una query rotta rendevano liberi tutti gli slot). Qui il busy
 * è fail-closed e il fallimento è circoscritto:
 *
 *  - mai [] per errore: ogni errore si propaga al chiamante, anche sullo store
 *    legacy (design §9: "busy.ts solleva sempre l'errore");
 *  - un oggetto rotto degrada solo sé stesso: le occorrenze di un oggetto in
 *    quarantena restano quelle dell'ultima versione buona (stale) o un blocco
 *    conservativo sul suo intervallo noto, già scritti dall'indicizzatore;
 *    oltre materialized_until o fuori dall'orizzonte della collezione l'oggetto
 *    si espande al volo sulla sola finestra, e se l'espansione non riesce
 *    blocca in modo conservativo la sola finestra. Nessun singolo oggetto
 *    produce un 503;
 *  - una collezione bloccante non verificabile (unsyncable con modifiche
 *    pendenti, Radicale irraggiungibile con la directory cambiata, campanello
 *    fermo) produce 503 secondo la decisione 1, salvo l'interruttore
 *    "modalità degradata" (al massimo 2 ore, registrato e con alert): in quel
 *    caso si decide sull'ultimo indice noto. Identità del volume diversa,
 *    stato illeggibile e orizzonte insufficiente non si scavalcano mai.
 *
 * Sorgente per modo (backend-mode.ts):
 *
 * | store    | display (/slots, cal-slots, MCP)          | decision (createBooking, reschedule)        |
 * |----------|-------------------------------------------|---------------------------------------------|
 * | postgres | legacy/events-pg.getBusyRanges (come oggi) | idem, modo riletto senza cache nella tx     |
 * | radicale | assertDisplayReady + indexBusyRanges      | assertHorizonCovers + indexBusyRanges (tx); |
 * |          |                                           | la freshness la fa booking.ts nel lock      |
 *
 * In mode postgres il risultato è identico a quello di oggi (stesse
 * occorrenze confermate e timed dei calendari bloccanti, iscrizioni comprese
 * se il calendario di destinazione blocca, proiezioni delle prenotazioni
 * comprese): cambia solo che un errore non diventa più un busy vuoto.
 *
 * Query di busy sull'indice (design §7): occorrenze con `blocks` (regola del
 * §9 calcolata dall'indicizzatore con calendar-core: VEVENT, STATUS confermato
 * o assente, non TRANSPARENT, timed salvo decisione 6, mai le proiezioni
 * booking-*) dei calendari bloccanti; le iscrizioni bloccano solo se lo
 * prevedono sia il flag dell'iscrizione sia quello del calendario di
 * destinazione (decisione 5). Indice GiST parziale su span WHERE blocks.
 *
 * Grafo degli import (contratto §10): backend-mode, freshness, horizon,
 * indexer, health (avvisi) e legacy/events-pg per il ramo postgres. Mai la
 * facade né store.ts come valore: RadicaleStore.getBusyRanges usa
 * indexBusyRanges di questo modulo.
 */

import type { Logger } from 'pino';
import { sql } from '../../db';
import { logger as rootLogger } from '../logger';
import { readBackendStateFresh, readStoreKind, storeKindForMode, storeKindOverride, type CalendarStoreKind } from './backend-mode';
import { CalendarUnavailableError, type CalendarUnavailableReason } from './errors';
import type { OccurrenceKind } from './index-model';
import { getBusyRanges as legacyBusyRanges } from './legacy/events-pg';
import { assertDisplayReady } from './radicale/freshness';
import { raiseIndexAlert } from './radicale/health';
import { assertHorizonCovers } from './radicale/horizon';
import { type CollectionContext, CollectionNotFoundError, expandIndexedObject, loadCollectionContext } from './radicale/indexer';
import type { Db } from './radicale/policy';
import type { BusyRange } from './types';

export type { BusyRange } from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-busy' });

// ─── Tipi del contratto (f2-modules §7.1) ───────────────────

/**
 * Livello della lettura (design §7, §9): `display` per la sola
 * visualizzazione (slot pubblici, form contatti, tool MCP in lettura),
 * `decision` dentro la sezione critica di una prenotazione.
 */
export type BusyLevel = 'display' | 'decision';

export interface BusyOptions {
  /** Default 'display'. */
  level?: BusyLevel;
  /** Connessione o transazione del chiamante (default pool principale); nelle decisioni la tx della prenotazione. */
  db?: Db;
}

/** Occorrenza bloccante dell'indice, con l'oggetto e l'istanza che la producono. */
export interface BlockingOccurrence {
  /** cal_objects.id (= cal_object_ids.id della risorsa). */
  objectId: string;
  calendarId: string;
  recurrenceKey: string;
  start: Date;
  end: Date;
  kind: OccurrenceKind;
  /** Occorrenza dell'ultima versione buona di un oggetto in quarantena. */
  stale: boolean;
  /** Prodotta dall'espansione al volo (oltre materialized_until o fuori orizzonte). */
  onTheFly: boolean;
}

// ─── Busy ───────────────────────────────

/**
 * Drop-in di getLocalBusyRanges (slots.ts), ma fail-closed: mai [] per
 * errore. Intervalli [start, end) in ISO UTC delle occorrenze bloccanti che
 * si sovrappongono a [fromIso, toIso), ordinati per inizio.
 *
 * Lancia CalendarUnavailableError (503) se il calendario non è verificabile
 * al livello richiesto, l'errore del database o della query altrimenti.
 */
export async function getBusyRanges(fromIso: string, toIso: string, opts: BusyOptions = {}): Promise<BusyRange[]> {
  const db = opts.db ?? sql;
  const level: BusyLevel = opts.level ?? 'display';
  const kind = await busyStoreKind(db, level);

  if (kind === 'postgres') {
    // Stesso insieme di oggi (occorrenze confermate e timed dei calendari
    // bloccanti), ma l'errore si propaga: niente più busy vuoto per errore.
    // Il codice legacy legge dal pool principale (non accetta una tx): in
    // READ COMMITTED vede le stesse righe di calendar_events della tx.
    return legacyBusyRanges(fromIso, toIso);
  }

  if (level === 'display') {
    await assertReadyOrDegraded(db, () => assertDisplayReady(db), 'display');
  } else {
    // La freshness l'ha già verificata il chiamante nella stessa tx
    // (booking.ts, dentro l'advisory lock): qui resta la garanzia statica
    // dell'orizzonte, mai busy su un intervallo che l'indice non copre.
    const { to } = parseWindow(fromIso, toIso);
    if (to !== null) await assertHorizonCovers(db, new Date(to));
  }
  return indexBusyRanges(db, fromIso, toIso);
}

export interface IndexBusyOptions {
  /**
   * Comprende anche le proiezioni delle prenotazioni (kind booking_projection,
   * confermate e timed) dei calendari bloccanti. Il busy delle decisioni e
   * degli slot le esclude (design §9: le prenotazioni bloccano già tramite
   * calendar_bookings); la facade events.getBusyRanges, che legge solo il
   * calendario (find_free_slots), le comprende come lo store legacy, dove la
   * proiezione è un evento confermato del calendario Prenotazioni.
   */
  includeBookingProjections?: boolean;
}

/**
 * Query di busy del design §7 sull'indice, più l'espansione al volo degli
 * oggetti oltre materialized_until o fuori dall'orizzonte materializzato
 * della loro collezione. Non verifica la freshness: la usano getBusyRanges
 * (dopo i controlli del livello) e RadicaleStore.getBusyRanges.
 */
export async function indexBusyRanges(db: Db, fromIso: string, toIso: string, opts: IndexBusyOptions = {}): Promise<BusyRange[]> {
  const { from, to } = parseWindow(fromIso, toIso);
  if (from === null || to === null) return [];
  const fromTs = new Date(from);
  const toTs = new Date(to);
  // Percorso caldo (/slots, decisioni): solo gli intervalli distinti, senza
  // oggetto né istanza (indice GiST parziale su span WHERE blocks). I
  // calendari bloccanti si calcolano prima, come semi-join (pochi calendari):
  // la condizione sui flag non si valuta per ogni occorrenza, e il piano resta
  // buono anche con le statistiche di un indice appena ripopolato (stesso
  // insieme della query di busy del design §7).
  const [rows, extra, projections] = await Promise.all([
    db<Array<{ start_utc: Date; end_utc: Date }>>`
      SELECT DISTINCT o.start_utc, o.end_utc
      FROM cal_occurrences o
      WHERE o.blocks
        AND o.calendar_id IN (${blockingCalendarIds(db)})
        AND o.span && tstzrange(${fromTs}::timestamptz, ${toTs}::timestamptz, '[)')
      ORDER BY o.start_utc, o.end_utc
    `,
    onTheFlyOccurrences(db, from, to),
    opts.includeBookingProjections
      ? db<Array<{ start_utc: Date; end_utc: Date }>>`
        SELECT DISTINCT o.start_utc, o.end_utc
        FROM cal_occurrences o
        WHERE o.kind = 'booking_projection'
          AND o.status = 'confirmed'
          AND NOT o.all_day
          AND o.calendar_id IN (${blockingCalendarIds(db)})
          AND o.span && tstzrange(${fromTs}::timestamptz, ${toTs}::timestamptz, '[)')
      `
      : Promise.resolve([]),
  ]);
  const out: BusyRange[] = rows.map((r) => ({ start: r.start_utc.toISOString(), end: r.end_utc.toISOString() }));
  const additions = [
    ...extra.map((occ) => ({ start: occ.start, end: occ.end })),
    ...projections.map((r) => ({ start: r.start_utc, end: r.end_utc })),
  ];
  if (additions.length === 0) return out;
  const seen = new Set(out.map((r) => `${r.start}|${r.end}`));
  for (const occ of additions) {
    const range = { start: occ.start.toISOString(), end: occ.end.toISOString() };
    const key = `${range.start}|${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(range);
  }
  out.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  return out;
}

/**
 * Sottoquery dei calendari bloccanti (design §7, decisione 5): i calendari
 * con blocks_availability e le iscrizioni il cui flag e quello del calendario
 * di destinazione bloccano entrambi.
 */
function blockingCalendarIds(db: Db) {
  return db`
    SELECT c.id
    FROM calendars c
    LEFT JOIN calendars p ON p.id = c.parent_calendar_id
    LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
    WHERE CASE WHEN c.role = 'subscription'
               THEN COALESCE(s.blocks_availability, false) AND COALESCE(p.blocks_availability, false)
               ELSE c.blocks_availability END
  `;
}

interface OccurrenceSqlRow {
  object_id: string;
  calendar_id: string;
  recurrence_key: string;
  start_utc: Date;
  end_utc: Date;
  kind: OccurrenceKind;
  stale: boolean;
}

interface OnTheFlyRow {
  id: string;
  calendar_id: string;
  href: string;
  health: 'ok' | 'quarantined' | 'pending_404';
  raw_ics: string | null;
  range_start: Date;
  range_end: Date | null;
  materialized_until: Date | null;
  horizon_start: Date | null;
  horizon_end: Date | null;
}

/**
 * Occorrenze bloccanti (con `blocks` e i flag dei calendari) che si
 * sovrappongono a [fromIso, toIso), con oggetto e istanza: stesso insieme di
 * indexBusyRanges, per il controllo delle sovrapposizioni delle prenotazioni
 * (booking-projection.ts, cal_booking_conflicts). Ordinate per inizio.
 */
export async function indexBlockingOccurrences(db: Db, fromIso: string, toIso: string): Promise<BlockingOccurrence[]> {
  const { from, to } = parseWindow(fromIso, toIso);
  if (from === null || to === null) return [];
  const fromTs = new Date(from);
  const toTs = new Date(to);

  const rows = await db<OccurrenceSqlRow[]>`
    SELECT o.object_id, o.calendar_id, o.recurrence_key, o.start_utc, o.end_utc, o.kind, o.stale
    FROM cal_occurrences o
    WHERE o.blocks
      AND o.calendar_id IN (${blockingCalendarIds(db)})
      AND o.span && tstzrange(${fromTs}::timestamptz, ${toTs}::timestamptz, '[)')
    ORDER BY o.start_utc, o.end_utc, o.object_id, o.recurrence_key
  `;

  const out: BlockingOccurrence[] = rows.map((r) => ({
    objectId: r.object_id,
    calendarId: r.calendar_id,
    recurrenceKey: r.recurrence_key,
    start: r.start_utc,
    end: r.end_utc,
    kind: r.kind,
    stale: r.stale,
    onTheFly: false,
  }));

  const extra = await onTheFlyOccurrences(db, from, to);
  if (extra.length === 0) return out;
  const known = new Set(out.map((o) => `${o.objectId}|${o.recurrenceKey}`));
  for (const occ of extra) {
    if (occ.recurrenceKey !== 'conservative' && known.has(`${occ.objectId}|${occ.recurrenceKey}`)) continue;
    out.push(occ);
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  return out;
}

/**
 * Espansione al volo (design §6.4, §6.9) degli oggetti delle collezioni
 * bloccanti la cui parte di [from, to) non è materializzata in
 * cal_occurrences: oltre materialized_until (più di 5000 occorrenze
 * nell'orizzonte) o fuori dall'orizzonte della collezione. Ogni oggetto si
 * espande sulla sola finestra scoperta, dal testo corrente o, per un oggetto
 * in quarantena, dall'ultima versione buona; un'espansione non riuscita
 * produce il blocco conservativo della sola finestra (expandIndexedObject
 * non lancia). Gli oggetti senza alcun intervallo noto restano esclusi come
 * nell'indice (badge "illeggibile", rischio residuo del design §6.5).
 *
 * Nel caso normale (finestra dentro l'orizzonte, nessuna serie oltre il
 * tetto) la query non restituisce righe.
 */
async function onTheFlyOccurrences(db: Db, from: number, to: number): Promise<BlockingOccurrence[]> {
  const fromTs = new Date(from);
  const toTs = new Date(to);
  const rows = await db<OnTheFlyRow[]>`
    WITH blocking AS (
      SELECT c.id AS calendar_id, st.horizon_start, st.horizon_end
      FROM calendars c
      LEFT JOIN calendars p ON p.id = c.parent_calendar_id
      LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
      LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
      WHERE CASE WHEN c.role = 'subscription'
                 THEN COALESCE(s.blocks_availability, false) AND COALESCE(p.blocks_availability, false)
                 ELSE c.blocks_availability END
    ),
    uncovered AS (
      SELECT b.* FROM blocking b
      WHERE b.horizon_end IS NULL OR b.horizon_start > ${fromTs}::timestamptz OR b.horizon_end < ${toTs}::timestamptz
    ),
    candidates AS (
      -- Serie oltre il tetto di 5000 occorrenze: indice parziale cal_objects_recurring_idx.
      SELECT ob.id
      FROM cal_objects ob
      JOIN blocking b ON b.calendar_id = ob.calendar_id
      WHERE ob.materialized_until IS NOT NULL
        AND ob.materialized_until < ${toTs}::timestamptz
        AND ob.range_start IS NOT NULL
        AND ob.range_start < ${toTs}::timestamptz
        AND (ob.range_end IS NULL OR ob.range_end > GREATEST(${fromTs}::timestamptz, ob.materialized_until))
      UNION
      -- Collezioni il cui orizzonte materializzato non copre la finestra.
      SELECT ob.id
      FROM cal_objects ob
      JOIN uncovered u ON u.calendar_id = ob.calendar_id
      WHERE ob.range_start IS NOT NULL
        AND ob.range_start < ${toTs}::timestamptz
        AND (ob.range_end IS NULL OR ob.range_end > ${fromTs}::timestamptz)
        AND (
          u.horizon_end IS NULL
          OR (u.horizon_end < ${toTs}::timestamptz AND (ob.range_end IS NULL OR ob.range_end > GREATEST(${fromTs}::timestamptz, u.horizon_end)))
          OR (u.horizon_start > ${fromTs}::timestamptz AND ob.range_start < LEAST(${toTs}::timestamptz, u.horizon_start))
        )
    )
    SELECT ob.id, ob.calendar_id, ob.href, ob.health,
           CASE WHEN ob.health = 'quarantined' AND v.raw_ics IS NOT NULL THEN v.raw_ics ELSE ob.raw_ics END AS raw_ics,
           ob.range_start, ob.range_end, ob.materialized_until, st.horizon_start, st.horizon_end
    FROM candidates k
    JOIN cal_objects ob ON ob.id = k.id
    LEFT JOIN cal_collection_state st ON st.calendar_id = ob.calendar_id
    LEFT JOIN cal_object_versions v ON v.id = ob.last_good_version_id AND v.valid
    ORDER BY ob.calendar_id, ob.id
  `;
  if (rows.length === 0) return [];

  const contexts = new Map<string, CollectionContext | null>();
  const out: BlockingOccurrence[] = [];
  for (const row of rows) {
    let context = contexts.get(row.calendar_id);
    if (context === undefined) {
      try {
        context = await loadCollectionContext(db, row.calendar_id);
      } catch (err) {
        // Calendario cancellato nel frattempo: le sue righe spariscono in cascata.
        if (!(err instanceof CollectionNotFoundError)) throw err;
        context = null;
      }
      contexts.set(row.calendar_id, context);
    }
    if (!context) continue;

    for (const window of uncoveredWindows(row, from, to)) {
      const expanded = expandIndexedObject(
        { id: row.id, calendar_id: row.calendar_id, href: row.href, raw_ics: row.raw_ics, health: row.health },
        context,
        { from: new Date(window.from), to: new Date(window.to) },
      );
      if (expanded.conservative) {
        log.warn({ objectId: row.id, calendarId: row.calendar_id }, 'espansione al volo non riuscita: blocco conservativo della finestra');
      }
      for (const occ of expanded.occurrences) {
        if (!occ.blocks) continue;
        if (occ.end.getTime() <= from || occ.start.getTime() >= to) continue;
        out.push({
          objectId: row.id,
          calendarId: row.calendar_id,
          recurrenceKey: occ.recurrenceKey,
          start: occ.start,
          end: occ.end,
          kind: occ.kind,
          stale: row.health === 'quarantined',
          onTheFly: true,
        });
      }
    }
  }
  return out;
}

/**
 * Parti di [from, to) che le occorrenze materializzate dell'oggetto non
 * coprono: copertura = [horizon_start, min(horizon_end, materialized_until)).
 */
function uncoveredWindows(row: OnTheFlyRow, from: number, to: number): Array<{ from: number; to: number }> {
  const coverStart = row.horizon_start ? row.horizon_start.getTime() : Number.POSITIVE_INFINITY;
  const horizonEnd = row.horizon_end ? row.horizon_end.getTime() : Number.NEGATIVE_INFINITY;
  const materialized = row.materialized_until ? row.materialized_until.getTime() : Number.POSITIVE_INFINITY;
  const coverEnd = Math.min(horizonEnd, materialized);
  if (!(coverStart < coverEnd)) return [{ from, to }];
  const windows: Array<{ from: number; to: number }> = [];
  if (from < coverStart) windows.push({ from, to: Math.min(to, coverStart) });
  if (to > coverEnd) windows.push({ from: Math.max(from, coverEnd), to });
  return windows.filter((w) => w.from < w.to);
}

/** Estremi della finestra in ms; null se vuota. Un istante non valido è un errore (mai un busy vuoto). */
function parseWindow(fromIso: string, toIso: string): { from: number | null; to: number | null } {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new RangeError(`busy: finestra non valida (${String(fromIso).slice(0, 40)} – ${String(toIso).slice(0, 40)})`);
  }
  if (from >= to) return { from: null, to: null };
  return { from, to };
}

/**
 * Store che serve il busy: per la visualizzazione il modo in cache (2 s), per
 * le decisioni il modo riletto senza cache con la connessione del chiamante
 * (la tx della prenotazione). L'override di test dello store vale per
 * entrambi.
 */
async function busyStoreKind(db: Db, level: BusyLevel): Promise<CalendarStoreKind> {
  const forced = storeKindOverride();
  if (forced) return forced;
  if (level === 'decision') return storeKindForMode((await readBackendStateFresh(db)).mode);
  return readStoreKind(db);
}

// ─── Modalità degradata (decisione 1) ───────────────────────────────

/**
 * Motivi di indisponibilità che l'interruttore "modalità degradata" può
 * scavalcare: il calendario non è verificabile adesso, ma l'indice contiene
 * l'ultimo stato verificato. MAI: identità del volume diversa o non
 * verificata (l'indice potrebbe non descrivere il volume), stato del backend
 * illeggibile, orizzonte insufficiente (l'indice non copre l'intervallo),
 * transizioni e freeze (scelte esplicite), store non disponibile.
 */
export const DEGRADABLE_REASONS: ReadonlySet<CalendarUnavailableReason> = new Set<CalendarUnavailableReason>([
  'radicale_unreachable',
  'collection_unsyncable',
  'freshness_timeout',
  'remote_budget_exceeded',
  'watcher_down',
  'rebuild_in_progress',
]);

/** true se `err` è un'indisponibilità che la modalità degradata può scavalcare. */
export function isDegradableFailure(err: unknown): err is CalendarUnavailableError {
  return err instanceof CalendarUnavailableError && DEGRADABLE_REASONS.has(err.reason);
}

/** Durata massima dell'interruttore (decisione 1). */
export const DEGRADED_MODE_MAX_MS = 2 * 3_600_000;

/** Chiave in site_settings (fuori da SETTINGS_KEYS: non compare nelle impostazioni generiche). */
export const DEGRADED_MODE_SETTING_KEY = 'calendar.degraded_booking_mode';

export interface DegradedBookingMode {
  /** Interruttore acceso e non scaduto all'istante della lettura. */
  active: boolean;
  enabledAt: Date | null;
  /** Scadenza effettiva (mai oltre enabledAt + 2 h). */
  expiresAt: Date | null;
  enabledBy: string | null;
  reason: string | null;
}

interface DegradedModeValue {
  enabled_at?: unknown;
  expires_at?: unknown;
  enabled_by?: unknown;
  reason?: unknown;
}

const INACTIVE: DegradedBookingMode = Object.freeze({ active: false, enabledAt: null, expiresAt: null, enabledBy: null, reason: null });

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Stato dell'interruttore (senza cache: lo si legge solo quando una verifica
 * è già fallita). Un valore malformato o scaduto vale come spento; la
 * scadenza non supera mai le 2 ore dall'accensione, qualunque cosa ci sia
 * scritta.
 */
export async function getDegradedBookingMode(db: Db = sql, now: Date = new Date()): Promise<DegradedBookingMode> {
  const [row] = await db<Array<{ value: DegradedModeValue | null }>>`
    SELECT value FROM site_settings WHERE key = ${DEGRADED_MODE_SETTING_KEY}
  `;
  const value = row?.value;
  if (!value || typeof value !== 'object') return INACTIVE;
  const enabledAt = dateOf(value.enabled_at);
  const written = dateOf(value.expires_at);
  if (!enabledAt || !written) return INACTIVE;
  const expiresAt = new Date(Math.min(written.getTime(), enabledAt.getTime() + DEGRADED_MODE_MAX_MS));
  const active = enabledAt.getTime() <= now.getTime() + 60_000 && now.getTime() < expiresAt.getTime();
  return {
    active,
    enabledAt,
    expiresAt,
    enabledBy: typeof value.enabled_by === 'string' ? value.enabled_by : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
  };
}

/**
 * Accende l'interruttore per `durationMs` (default e massimo 2 ore). Lo
 * registra in audit_logs e manda un avviso: ogni prenotazione presa in
 * modalità degradata viene a sua volta registrata (booking.ts).
 */
export async function enableDegradedBookingMode(opts: { actor: string; reason: string; durationMs?: number; db?: Db; now?: Date }): Promise<DegradedBookingMode> {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  const actor = String(opts.actor ?? '').trim().slice(0, 200);
  const reason = String(opts.reason ?? '').trim().slice(0, 500);
  if (!actor) throw new TypeError('modalità degradata: attore obbligatorio');
  if (!reason) throw new TypeError('modalità degradata: motivo obbligatorio');
  const requested = opts.durationMs ?? DEGRADED_MODE_MAX_MS;
  if (!Number.isFinite(requested) || requested <= 0) throw new RangeError('modalità degradata: durata non valida');
  const duration = Math.min(requested, DEGRADED_MODE_MAX_MS);
  const value = {
    enabled_at: now.toISOString(),
    expires_at: new Date(now.getTime() + duration).toISOString(),
    enabled_by: actor,
    reason,
  };
  await db`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES (${DEGRADED_MODE_SETTING_KEY}, ${db.json(value)}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
  await db`
    INSERT INTO audit_logs (action, table_name, record_id, user_email, new_data, metadata)
    VALUES ('UPDATE', 'site_settings', ${DEGRADED_MODE_SETTING_KEY}, ${actor}, ${db.json(value)}, ${db.json({ calendar: 'degraded_mode_on' })})
  `;
  raiseIndexAlert('booking-degraded-mode', `Modalità degradata delle prenotazioni accesa fino a ${value.expires_at}: si prenota sull'ultimo indice noto`, {
    key: value.enabled_at,
    actor,
    expiresAt: value.expires_at,
  });
  log.warn({ actor, expiresAt: value.expires_at }, 'modalità degradata delle prenotazioni accesa');
  return getDegradedBookingMode(db, now);
}

/** Spegne l'interruttore (idempotente) e lo registra in audit_logs. */
export async function disableDegradedBookingMode(opts: { actor: string; db?: Db }): Promise<void> {
  const db = opts.db ?? sql;
  const actor = String(opts.actor ?? '').trim().slice(0, 200) || 'system';
  const removed = await db`DELETE FROM site_settings WHERE key = ${DEGRADED_MODE_SETTING_KEY} RETURNING key`;
  if (removed.length === 0) return;
  await db`
    INSERT INTO audit_logs (action, table_name, record_id, user_email, metadata)
    VALUES ('DELETE', 'site_settings', ${DEGRADED_MODE_SETTING_KEY}, ${actor}, ${db.json({ calendar: 'degraded_mode_off' })})
  `;
  log.info({ actor }, 'modalità degradata delle prenotazioni spenta');
}

/** Ultimo avviso di lettura degradata nel livello display (per non inondare i log a ogni /slots). */
let lastDegradedDisplayLogAt = 0;
const DEGRADED_DISPLAY_LOG_MS = 60_000;

/**
 * Esegue la verifica `check`; se fallisce con un motivo scavalcabile e la
 * modalità degradata è accesa, prosegue sull'ultimo indice noto (log e, la
 * prima volta, avviso). Restituisce il motivo scavalcato, null se la
 * verifica è riuscita. Altrimenti rilancia l'errore della verifica.
 */
export async function assertReadyOrDegraded(
  db: Db,
  check: () => Promise<unknown>,
  level: BusyLevel,
): Promise<CalendarUnavailableError | null> {
  try {
    await check();
    return null;
  } catch (err) {
    if (!isDegradableFailure(err)) throw err;
    const mode = await getDegradedBookingMode(db);
    if (!mode.active) throw err;
    const now = Date.now();
    if (level === 'decision' || now - lastDegradedDisplayLogAt >= DEGRADED_DISPLAY_LOG_MS) {
      lastDegradedDisplayLogAt = now;
      log.warn({ level, reason: err.reason, detail: err.detail, expiresAt: mode.expiresAt }, 'calendario non verificabile: modalità degradata, uso l\'ultimo indice noto');
      raiseIndexAlert('booking-degraded-read', `Calendario non verificabile (${err.reason}): letture in modalità degradata`, {
        key: `${level}|${err.reason}`,
        level,
        reason: err.reason,
      });
    }
    return err;
  }
}
