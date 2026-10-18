/**
 * Smoke automatici del cutover (fase F4 del passaggio a Radicale; design
 * §13.10 passo 7; contratto docs/calendar-radicale/contracts/f4-modules.md
 * §3.3). Girano nell'ultimo passo del cutover, con il mode già `radicale` e la
 * policy live, e controllano i percorsi che il sito, l'admin e l'assistente
 * usano davvero, SENZA effetti collaterali:
 *
 *  - SLOTS: computeAvailableSlots di un event type pubblico sui prossimi 14
 *    giorni, livello display (nessun 503);
 *  - BOOKING_ROLLBACK: createBooking su un event type non pubblico (o, se non
 *    ce n'è, su uno qualsiasi con un orario fuori dalle finestre pubbliche,
 *    nella notte UTC) dentro una transazione SEMPRE annullata, passando
 *    `db: tx`: con la transazione del chiamante createBooking non esegue
 *    alcun effetto post-commit (proiezione, controllo delle sovrapposizioni,
 *    workflow) e non invia email (le invia sempre il chiamante, mai
 *    createBooking). L'esito atteso è la decisione presa (prenotazione
 *    inserita nella transazione, o conflitto deciso sul busy verificato) e la
 *    riga sparita dopo l'annullamento;
 *  - FEED: feed ICS di ogni calendario con il feed attivo, risolto per token
 *    come fa la route pubblica (mai il token nei log o nel dettaglio);
 *  - MCP_READ: tool dell'assistente in lettura (list_calendars, list_events,
 *    get_calendar_availability) senza `{error}`;
 *  - NO_SIDE_EFFECTS: nessuna prenotazione, job, esecuzione di workflow o
 *    riga d'audit residua che riguardi le prenotazioni di prova dello smoke.
 *    Il controllo è mirato (uid e indirizzo sintetico della prova), non un
 *    conteggio delle tabelle: durante lo smoke il sito resta aperto e una
 *    prenotazione vera non deve farlo fallire.
 *
 * Un fallimento NON annulla il cutover: il riassunto lo riporta e il wizard
 * propone il rollback. runCutoverSmoke non lancia mai: ogni controllo cattura i
 * propri errori e li riporta con un testo in italiano senza dati personali.
 */

import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { BookingConflictError, BookingValidationError, createBooking } from '../booking';
import { getCalendarByFeedToken } from '../calendars';
import { isCalendarUnavailable } from '../errors';
import { buildCalendarFeed } from '../events';
import { feedUidDomain } from '../feed-builder';
import type { Db } from '../radicale/policy';
import { computeAvailableSlots } from '../slots';
import { SMOKE_CHECK_CODES, type SmokeCheck, type SmokeCheckCode, type SmokeReport } from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-cutover-smoke' });

const DAY_MS = 86_400_000;
/** Indirizzo sintetico della prenotazione di prova: dominio riservato (RFC 2606), mai recapitabile. */
export const SMOKE_ATTENDEE_EMAIL = 'prova-passaggio@caldes.invalid';
const SMOKE_ATTENDEE_NAME = 'Prova automatica del passaggio';
/** Giorni di slot controllati (design §13.10). */
const SLOTS_DAYS = 14;
/** Tentativi di orario per la prenotazione di prova (una settimana dopo l'altra). */
const BOOKING_ATTEMPTS = 3;
/** Ora UTC della prenotazione di prova: notte a Roma, fuori da qualsiasi finestra pubblica. */
const BOOKING_UTC_HOUR = 2;

/** Annullamento voluto della transazione della prenotazione di prova. */
class SmokeRollback extends Error {
  constructor(readonly outcome: { uid: string; status: string; store: string; projection: string; inserted: boolean }) {
    super('annullamento voluto dello smoke');
    this.name = 'SmokeRollback';
  }
}

/** Data locale YYYY-MM-DD a Roma di un istante. */
function romeDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function shortReason(err: unknown): string {
  if (isCalendarUnavailable(err)) return `calendario non disponibile (${err.reason})`;
  if (err instanceof BookingConflictError) return 'slot non disponibile';
  if (err instanceof BookingValidationError) return 'richiesta non valida per l\'event type';
  if (err instanceof Error) return err.name === 'Error' ? 'errore interno (dettagli nei log)' : `${err.name} (dettagli nei log)`;
  return 'errore interno (dettagli nei log)';
}

interface SmokeContext {
  db: Db;
  now: Date;
  signal?: AbortSignal;
  /** uid delle prenotazioni di prova create (e annullate) nelle transazioni. */
  bookingUids: string[];
}

async function timed(code: SmokeCheckCode, ctx: SmokeContext, fn: () => Promise<{ ok: boolean; detail: string | null }>): Promise<SmokeCheck> {
  const t0 = Date.now();
  if (ctx.signal?.aborted) return { code, ok: false, ms: 0, detail: 'Smoke interrotto prima del controllo' };
  try {
    const r = await fn();
    return { code, ok: r.ok, ms: Date.now() - t0, detail: r.detail };
  } catch (err) {
    log.warn({ code, err: err instanceof Error ? err.message : String(err) }, 'controllo dello smoke non riuscito');
    return { code, ok: false, ms: Date.now() - t0, detail: `Controllo non riuscito: ${shortReason(err)}` };
  }
}

/** Event type pubblico e attivo per gli slot (il primo nell'ordine del sito). */
async function publicEventTypeSlug(db: Db): Promise<string | null> {
  const [row] = await db<Array<{ slug: string }>>`
    SELECT slug FROM calendar_event_types
    WHERE is_active AND is_public
    ORDER BY sort_order, created_at, id
    LIMIT 1
  `;
  return row?.slug ?? null;
}

async function checkSlots(ctx: SmokeContext): Promise<{ ok: boolean; detail: string | null }> {
  const slug = await publicEventTypeSlug(ctx.db);
  if (!slug) return { ok: true, detail: 'Nessun event type pubblico attivo: controllo degli slot non applicabile' };
  const from = romeDate(ctx.now.getTime());
  const to = romeDate(ctx.now.getTime() + (SLOTS_DAYS - 1) * DAY_MS);
  const result = await computeAvailableSlots({ eventTypeIdOrSlug: slug, fromDateLocal: from, toDateLocal: to, onlyPublic: true }, { level: 'display', db: ctx.db });
  if (!result) return { ok: false, detail: `Event type pubblico ${slug} non trovato dal calcolo degli slot` };
  return { ok: true, detail: `${result.slots.length} slot calcolati per ${slug} dal ${from} al ${to}` };
}

interface SmokeEventType {
  id: string;
  slug: string;
  is_public: boolean;
  min_notice_hours: number;
  max_advance_days: number;
}

/** Event type della prenotazione di prova: prima i non pubblici, poi gli altri attivi. */
async function bookingEventType(db: Db): Promise<SmokeEventType | null> {
  const [row] = await db<SmokeEventType[]>`
    SELECT id::text AS id, slug, is_public, min_notice_hours, max_advance_days
    FROM calendar_event_types
    WHERE is_active
    ORDER BY is_public ASC, sort_order, created_at, id
    LIMIT 1
  `;
  return row ?? null;
}

/** Istanti candidati: alle 02:00 UTC del primo giorno utile dopo il preavviso, poi a una settimana di distanza. */
function bookingCandidates(et: SmokeEventType, now: Date): Date[] {
  const earliest = now.getTime() + et.min_notice_hours * 3_600_000 + DAY_MS;
  const latest = now.getTime() + et.max_advance_days * DAY_MS;
  const first = new Date(earliest);
  first.setUTCHours(BOOKING_UTC_HOUR, 0, 0, 0);
  if (first.getTime() < earliest) first.setTime(first.getTime() + DAY_MS);
  const out: Date[] = [];
  for (let i = 0; i < BOOKING_ATTEMPTS; i++) {
    const at = new Date(first.getTime() + i * 7 * DAY_MS);
    if (at.getTime() <= latest) out.push(at);
  }
  return out;
}

async function checkBookingRollback(ctx: SmokeContext): Promise<{ ok: boolean; detail: string | null }> {
  const et = await bookingEventType(ctx.db);
  if (!et) return { ok: true, detail: 'Nessun event type attivo: prova di prenotazione non applicabile' };
  const candidates = bookingCandidates(et, ctx.now);
  if (candidates.length === 0) return { ok: false, detail: `Nessun orario ammesso dall'event type ${et.slug} per la prova (preavviso e anticipo massimo)` };
  const kind = et.is_public ? 'pubblico, orario notturno fuori dalle finestre' : 'non pubblico';
  let lastReason = '';
  for (const at of candidates) {
    if (ctx.signal?.aborted) return { ok: false, detail: 'Smoke interrotto' };
    let outcome: SmokeRollback['outcome'] | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
      await ctx.db.begin(async (tx: any) => {
        const result = await createBooking(
          {
            event_type_id: et.id,
            start: at.toISOString(),
            attendee: { name: SMOKE_ATTENDEE_NAME, email: SMOKE_ATTENDEE_EMAIL, timezone: 'Europe/Rome' },
            source: 'admin_manual',
            source_metadata: { cutover_smoke: true },
            skip_emails: true,
            allow_buffer_override: true,
          },
          { db: tx, suppressWorkflowEvents: true },
        );
        ctx.bookingUids.push(result.booking.uid);
        const [seen] = await tx`SELECT count(*)::int AS n FROM calendar_bookings WHERE uid = ${result.booking.uid}`;
        // Sempre annullata: nessun effetto sopravvive alla prova.
        throw new SmokeRollback({
          uid: result.booking.uid,
          status: result.booking.status,
          store: result.decision.store,
          projection: result.decision.projection,
          inserted: Number(seen?.n ?? 0) === 1,
        });
      });
      return { ok: false, detail: 'La transazione della prova non è stata annullata' };
    } catch (err) {
      if (err instanceof SmokeRollback) {
        outcome = err.outcome;
      } else if (err instanceof BookingConflictError) {
        // Decisione presa sul busy verificato: lo slot di prova è occupato (capacità, buffer o un evento).
        lastReason = 'slot di prova occupato';
        continue;
      } else if (err instanceof BookingValidationError) {
        lastReason = 'orario di prova rifiutato dai vincoli dell\'event type';
        continue;
      } else {
        throw err;
      }
    }
    const [after] = await ctx.db<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_bookings WHERE uid = ${outcome.uid}`;
    if (!outcome.inserted) return { ok: false, detail: 'Prenotazione di prova non visibile nella propria transazione' };
    if (Number(after?.n ?? 0) !== 0) return { ok: false, detail: 'Prenotazione di prova ancora presente dopo l\'annullamento' };
    return {
      ok: true,
      detail: `Decisione presa su un event type ${kind} (store ${outcome.store}, proiezione ${outcome.projection}, stato ${outcome.status}); transazione annullata, nessuna riga residua`,
    };
  }
  // Ogni orario rifiutato: la decisione è stata comunque presa sul calendario verificato (nessun 503).
  return { ok: true, detail: `Decisione presa senza inserimento su un event type ${kind}: ${lastReason}` };
}

async function checkFeeds(ctx: SmokeContext): Promise<{ ok: boolean; detail: string | null }> {
  const rows = await ctx.db<Array<{ slug: string; token: string }>>`
    SELECT slug, ics_feed_token AS token FROM calendars
    WHERE ics_feed_enabled AND ics_feed_token IS NOT NULL
      -- Righe dello strumento (sidecar delle iscrizioni, archivio della Fase 0): mai servite dal feed legacy.
      AND role <> 'subscription' AND origin <> 'migration'
    ORDER BY slug
  `;
  if (rows.length === 0) return { ok: true, detail: 'Nessun calendario con il feed ICS attivo' };
  const failed: string[] = [];
  const uidDomain = feedUidDomain();
  for (const row of rows) {
    if (ctx.signal?.aborted) return { ok: false, detail: 'Smoke interrotto' };
    try {
      const calendar = await getCalendarByFeedToken(row.token);
      if (!calendar) {
        failed.push(`${row.slug} (token non risolto)`);
        continue;
      }
      const feed = await buildCalendarFeed(calendar, { now: ctx.now, uidDomain });
      if (!feed.body.startsWith('BEGIN:VCALENDAR') || !feed.body.includes('END:VCALENDAR')) failed.push(`${row.slug} (corpo non VCALENDAR)`);
    } catch (err) {
      failed.push(`${row.slug} (${shortReason(err)})`);
    }
  }
  return failed.length
    ? { ok: false, detail: `Feed non generati: ${failed.join(', ')}` }
    : { ok: true, detail: `${rows.length} feed ICS generati per token` };
}

async function checkMcpRead(ctx: SmokeContext): Promise<{ ok: boolean; detail: string | null }> {
  const { executeTool } = await import('../../agent/tools');
  const from = ctx.now.toISOString();
  const to = new Date(ctx.now.getTime() + 7 * DAY_MS).toISOString();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'list_calendars', args: {} },
    { name: 'list_events', args: { from, to } },
  ];
  const slug = (await publicEventTypeSlug(ctx.db)) ?? (await bookingEventType(ctx.db))?.slug ?? null;
  if (slug) {
    calls.push({ name: 'get_calendar_availability', args: { event_type_slug: slug, from_date: romeDate(ctx.now.getTime()), to_date: romeDate(ctx.now.getTime() + 6 * DAY_MS) } });
  }
  const failed: string[] = [];
  for (const call of calls) {
    if (ctx.signal?.aborted) return { ok: false, detail: 'Smoke interrotto' };
    const raw = await executeTool(call.name, call.args);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      failed.push(`${call.name} (risposta non JSON)`);
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed) failed.push(call.name);
  }
  return failed.length
    ? { ok: false, detail: `Tool con {error}: ${failed.join(', ')}` }
    : { ok: true, detail: `${calls.length} tool in lettura senza errori (${calls.map((c) => c.name).join(', ')})` };
}

async function checkNoSideEffects(ctx: SmokeContext, startedAt: Date): Promise<{ ok: boolean; detail: string | null }> {
  const uids = ctx.bookingUids;
  const [bookings] = await ctx.db<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM calendar_bookings
    WHERE uid = ANY(${uids}::text[]) OR (attendee_email = ${SMOKE_ATTENDEE_EMAIL} AND created_at >= ${startedAt})
  `;
  const [jobs] = await ctx.db<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM cal_jobs WHERE key = ANY(${uids}::text[])
  `;
  const [workflows] = await ctx.db<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM workflow_executions
    WHERE started_at >= ${startedAt}
      AND (trigger_data->>'booking_uid' = ANY(${uids}::text[]) OR trigger_data->>'attendee_email' = ${SMOKE_ATTENDEE_EMAIL})
  `;
  const [audits] = await ctx.db<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM audit_logs
    WHERE created_at >= ${startedAt} AND table_name IN ('calendar_bookings', 'calendar_degraded_bookings')
      AND (new_data->>'booking_uid' = ANY(${uids}::text[]) OR new_data->>'uid' = ANY(${uids}::text[]) OR new_data->>'attendee_email' = ${SMOKE_ATTENDEE_EMAIL})
  `;
  const residue = {
    prenotazioni: Number(bookings?.n ?? 0),
    job: Number(jobs?.n ?? 0),
    workflow: Number(workflows?.n ?? 0),
    audit: Number(audits?.n ?? 0),
  };
  const left = Object.entries(residue).filter(([, n]) => n > 0);
  if (left.length) return { ok: false, detail: `Effetti residui della prova: ${left.map(([k, n]) => `${k} ${n}`).join(', ')}` };
  return {
    ok: true,
    detail: `Nessuna prenotazione, job, workflow o audit residuo (${uids.length} prenotazioni di prova annullate; createBooking non accoda email: le invia il chiamante)`,
  };
}

/**
 * Smoke del cutover (contratto f4-modules §3.3): i cinque controlli in
 * ordine, ognuno con durata e dettaglio. Non lancia mai.
 */
export async function runCutoverSmoke(opts: { db?: Db; now?: Date; signal?: AbortSignal } = {}): Promise<SmokeReport> {
  const startedAt = new Date();
  const ctx: SmokeContext = { db: opts.db ?? sql, now: opts.now ?? startedAt, signal: opts.signal, bookingUids: [] };
  const checks: SmokeCheck[] = [];
  checks.push(await timed('SLOTS', ctx, () => checkSlots(ctx)));
  checks.push(await timed('BOOKING_ROLLBACK', ctx, () => checkBookingRollback(ctx)));
  checks.push(await timed('FEED', ctx, () => checkFeeds(ctx)));
  checks.push(await timed('MCP_READ', ctx, () => checkMcpRead(ctx)));
  checks.push(await timed('NO_SIDE_EFFECTS', ctx, () => checkNoSideEffects(ctx, startedAt)));
  // Ordine fisso del contratto (types.ts).
  checks.sort((a, b) => SMOKE_CHECK_CODES.indexOf(a.code) - SMOKE_CHECK_CODES.indexOf(b.code));
  const report: SmokeReport = {
    ok: checks.every((c) => c.ok),
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    checks,
  };
  if (report.ok) log.info({ checks: checks.map((c) => ({ code: c.code, ms: c.ms })) }, 'smoke del cutover superati');
  else log.warn({ failed: checks.filter((c) => !c.ok).map((c) => ({ code: c.code, detail: c.detail })) }, 'smoke del cutover non superati: valuta il rollback');
  return report;
}
