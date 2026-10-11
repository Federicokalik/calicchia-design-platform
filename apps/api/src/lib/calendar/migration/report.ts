/**
 * Verdetti, accettazioni e report dei run dello strumento di migrazione
 * (fase F3 del piano; design §13.7, §13.13; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §5.4, §6.3 e §8.2-§8.4).
 *
 *  - Verdetti per calendario di un run di verifica: colore per livello e
 *    complessivo (verde, giallo con sole differenze attese, rosso con almeno
 *    una inattesa) e accettazione (verde, o giallo con tutte le differenze
 *    attese accettate esplicitamente). Le differenze informative del busy con
 *    le iscrizioni (variant 'with_subscriptions') non entrano né nel colore né
 *    nell'accettazione.
 *  - Accettazione esplicita delle sole differenze attese (le rosse non si
 *    accettano: si correggono) e riporto per firma sui run successivi, così il
 *    giro notturno dello shadow resta verde-accettato senza riaccettare ogni
 *    notte le stesse differenze. È l'unica scrittura di questo modulo su
 *    cal_migration_items (accepted_at/accepted_by) e sul riassunto del run di
 *    verifica (verdetti aggiornati dopo l'accettazione).
 *  - Report scaricabile di un run, generato al volo senza file su disco: JSON
 *    (run, sezione leggibile per il wizard, verdetti, righe) o CSV delle righe.
 *    I dettagli delle righe non contengono dati personali per costruzione
 *    (contratto §1.4 regola 5); il CSV neutralizza le celle che un foglio di
 *    calcolo interpreterebbe come formule.
 */

import { planCounts } from './plan';
import type { Db } from '../radicale/policy';
import {
  type AcceptDiffsResponse,
  type ApplyOutcome,
  type CalendarVerdict,
  CONFLICT_CODES,
  type ConflictCode,
  type ItemSeverity,
  type MigrationItemType,
  type MigrationItemView,
  MigrationError,
  type MigrationProgress,
  type MigrationRunKind,
  type MigrationRunStatus,
  type MigrationRunTrigger,
  type MigrationRunView,
  type PlanAction,
  type PlanItem,
  type PlanSummary,
  type VerifyColor,
  type VerifyLevel,
  VERIFY_LEVELS,
  type VerifyLevelVerdict,
  type VerifySummary,
  verifyColorOf,
  verdictAcceptable,
  worstColor,
} from './types';

// ─── Verdetti (puri) ───────────────────────────────

/** Differenza ridotta ai campi che decidono colore e accettazione. */
export interface DiffRowLite {
  calendar_id: string | null;
  level: VerifyLevel;
  expected: boolean;
  accepted: boolean;
  /** 'with_subscriptions' = informativa (fuori dal colore e dall'accettazione). */
  variant?: string | null;
}

/**
 * Verdetti per calendario dalle differenze (puro). `calendars` sono i
 * calendari verificati (anche senza differenze: verdi); quelli che compaiono
 * solo nelle righe si aggiungono con nome di collezione e slug vuoti.
 */
export function buildVerdicts(
  calendars: ReadonlyArray<{ calendar_id: string; collection_name: string; slug: string }>,
  levels: readonly VerifyLevel[],
  rows: readonly DiffRowLite[],
): CalendarVerdict[] {
  const info = new Map(calendars.map((c) => [c.calendar_id, c]));
  for (const r of rows) {
    if (r.calendar_id && !info.has(r.calendar_id)) info.set(r.calendar_id, { calendar_id: r.calendar_id, collection_name: '', slug: '' });
  }
  const colored = rows.filter((r) => r.variant !== 'with_subscriptions');
  const out: CalendarVerdict[] = [];
  for (const c of info.values()) {
    const mine = colored.filter((r) => r.calendar_id === c.calendar_id);
    const perLevel: Partial<Record<VerifyLevel, VerifyLevelVerdict>> = {};
    for (const level of levels) {
      const diffs = mine.filter((r) => r.level === level);
      perLevel[level] = {
        color: verifyColorOf(diffs),
        diffs: diffs.length,
        expected: diffs.filter((d) => d.expected).length,
        unexpected: diffs.filter((d) => !d.expected).length,
      };
    }
    // Righe di livelli non richiesti (non dovrebbero esserci) contano comunque nel colore.
    const color = worstColor([verifyColorOf(mine), ...Object.values(perLevel).map((v) => (v as VerifyLevelVerdict).color)]);
    const accepted = color === 'green' || (color === 'yellow' && mine.every((r) => r.expected && r.accepted));
    out.push({ calendar_id: c.calendar_id, collection_name: c.collection_name, slug: c.slug, color, accepted, levels: perLevel });
  }
  return out.sort((a, b) => (a.collection_name || a.slug).localeCompare(b.collection_name || b.slug) || a.calendar_id.localeCompare(b.calendar_id));
}

// ─── Lettura dei run ───────────────────────────────

interface RunRow {
  id: string;
  kind: MigrationRunKind;
  status: MigrationRunStatus;
  trigger: MigrationRunTrigger;
  requested_by: string;
  params: Record<string, unknown> | null;
  plan_run_id: string | null;
  plan_hash: string | null;
  progress: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  error: string | null;
  error_code: string | null;
  attempts: number;
  heartbeat_at: Date | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

async function readRun(db: Db, runId: string): Promise<RunRow> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    throw new MigrationError('RUN_NOT_FOUND', 'Run di migrazione inesistente');
  }
  const rows = await db<RunRow[]>`
    SELECT id::text AS id, kind, status, trigger, requested_by, params, plan_run_id::text AS plan_run_id, plan_hash,
           progress, summary, error, error_code, attempts, heartbeat_at, cancel_requested_at, created_at, started_at, finished_at
    FROM cal_migration_runs WHERE id = ${runId}::uuid
  `;
  if (!rows[0]) throw new MigrationError('RUN_NOT_FOUND', 'Run di migrazione inesistente');
  return rows[0];
}

function iso(d: Date | string | null): string | null {
  if (d === null || d === undefined) return null;
  const v = d instanceof Date ? d : new Date(d);
  return Number.isFinite(v.getTime()) ? v.toISOString() : null;
}

/** Vista REST di un run (stessa forma di MigrationRunView di runs.ts). */
function runView(r: RunRow): MigrationRunView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    trigger: r.trigger,
    requested_by: r.requested_by,
    created_at: iso(r.created_at) as string,
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    heartbeat_at: iso(r.heartbeat_at),
    progress: (r.progress ?? {}) as MigrationProgress | Record<string, never>,
    summary: (r.summary ?? null) as MigrationRunView['summary'],
    error: r.error || r.error_code ? { code: r.error_code ?? 'INTERNAL', message: r.error ?? '' } : null,
    plan_run_id: r.plan_run_id,
    plan_hash: r.plan_hash,
    attempts: r.attempts,
    cancel_requested: r.cancel_requested_at !== null,
  };
}

function assertVerifyRun(run: RunRow): void {
  if (run.kind !== 'verify') {
    throw new MigrationError('PRECONDITION_FAILED', 'Le differenze si accettano solo su un run di verifica', { reasons: ['RUN_KIND_NOT_VERIFY'], kind: run.kind });
  }
}

interface DiffDbRow {
  id: string;
  calendar_id: string | null;
  collection_name: string | null;
  level: VerifyLevel;
  expected: boolean;
  accepted: boolean;
  variant: string | null;
}

async function readDiffRows(db: Db, runId: string): Promise<DiffDbRow[]> {
  return db<DiffDbRow[]>`
    SELECT id::text AS id, calendar_id::text AS calendar_id, collection_name, level, expected,
           (accepted_at IS NOT NULL) AS accepted, detail->>'variant' AS variant
    FROM cal_migration_items
    WHERE run_id = ${runId}::uuid AND item_type = 'diff'
    ORDER BY seq
  `;
}

function levelsOf(run: RunRow): VerifyLevel[] {
  const fromSummary = (run.summary as Partial<VerifySummary> | null)?.levels;
  const fromParams = (run.params as { levels?: unknown } | null)?.levels;
  const raw = Array.isArray(fromSummary) && fromSummary.length ? fromSummary : Array.isArray(fromParams) && fromParams.length ? fromParams : [...VERIFY_LEVELS];
  return VERIFY_LEVELS.filter((l) => (raw as unknown[]).includes(l));
}

async function verdictsOfRun(db: Db, run: RunRow): Promise<CalendarVerdict[]> {
  const rows = await readDiffRows(db, run.id);
  const summaryCals = ((run.summary as Partial<VerifySummary> | null)?.calendars ?? [])
    .map((c) => ({ calendar_id: c.calendar_id, collection_name: c.collection_name ?? '', slug: c.slug ?? '' }));
  const known = new Set(summaryCals.map((c) => c.calendar_id));
  const missing = [...new Set(rows.map((r) => r.calendar_id).filter((id): id is string => Boolean(id) && !known.has(id as string)))];
  if (missing.length) {
    const cals = await db<Array<{ id: string; slug: string; collection_name: string | null }>>`
      SELECT id::text AS id, slug, collection_name FROM calendars WHERE id = ANY(${missing}::uuid[])
    `;
    const byId = new Map(cals.map((c) => [c.id, c]));
    for (const id of missing) {
      const c = byId.get(id);
      const fromRow = rows.find((r) => r.calendar_id === id)?.collection_name ?? '';
      summaryCals.push({ calendar_id: id, collection_name: c?.collection_name ?? fromRow, slug: c?.slug ?? '' });
    }
  }
  return buildVerdicts(summaryCals, levelsOf(run), rows);
}

/** Verdetti per calendario di un run di verifica, con le accettazioni. */
export async function calendarVerdicts(db: Db, verifyRunId: string): Promise<CalendarVerdict[]> {
  const run = await readRun(db, verifyRunId);
  assertVerifyRun(run);
  return verdictsOfRun(db, run);
}

// ─── Accettazioni ───────────────────────────────

/**
 * Copia sulle differenze attese del run le accettazioni di differenze con la
 * stessa firma (detail.signature) nei run di verifica precedenti: stesso
 * accepted_by, accepted_at = now(). Restituisce quante righe ha accettato.
 */
export async function carryOverAcceptances(db: Db, verifyRunId: string): Promise<number> {
  const rows = await db<Array<{ id: string }>>`
    UPDATE cal_migration_items cur
    SET accepted_at = now(), accepted_by = prev.accepted_by
    FROM (
      SELECT DISTINCT ON (i.detail->>'signature') i.detail->>'signature' AS signature, i.accepted_by
      FROM cal_migration_items i
      JOIN cal_migration_runs r ON r.id = i.run_id
      WHERE r.kind = 'verify' AND i.run_id <> ${verifyRunId}::uuid
        AND i.item_type = 'diff' AND i.expected AND i.accepted_at IS NOT NULL
        AND i.detail ? 'signature'
      ORDER BY i.detail->>'signature', i.accepted_at DESC
    ) prev
    WHERE cur.run_id = ${verifyRunId}::uuid AND cur.item_type = 'diff' AND cur.expected
      AND cur.accepted_at IS NULL
      AND cur.detail->>'signature' = prev.signature
    RETURNING cur.id::text AS id
  `;
  return rows.length;
}

/** Aggiorna verdetti, accettabilità e conteggio delle accettate nel riassunto di un run di verifica concluso. */
async function refreshVerifySummary(db: Db, run: RunRow, verdicts: CalendarVerdict[]): Promise<void> {
  if (!run.summary) return;
  const rows = await readDiffRows(db, run.id);
  const colored = rows.filter((r) => r.variant !== 'with_subscriptions');
  const summary = {
    ...run.summary,
    calendars: verdicts,
    acceptable: verdicts.every((v) => verdictAcceptable(v)),
    totals: {
      ...((run.summary.totals as Record<string, unknown> | undefined) ?? {}),
      diffs: colored.length,
      expected: colored.filter((r) => r.expected).length,
      unexpected: colored.filter((r) => !r.expected).length,
      accepted: colored.filter((r) => r.accepted).length,
    },
  };
  await db`UPDATE cal_migration_runs SET summary = ${db.json(summary as never)} WHERE id = ${run.id}::uuid`;
}

/**
 * Accettazione esplicita delle sole differenze attese di un run di verifica
 * riuscito: per id delle righe, per calendario o tutte le attese. Una riga
 * rossa fra gli id indicati → MigrationError NOT_ACCEPTABLE (nessuna riga
 * accettata); con calendario o "tutte" le rosse restano semplicemente fuori.
 */
export async function acceptDiffs(
  db: Db,
  input: { runId: string; itemIds?: readonly string[]; calendarId?: string; allExpected?: boolean; actor: string },
): Promise<AcceptDiffsResponse> {
  const run = await readRun(db, input.runId);
  assertVerifyRun(run);
  if (run.status !== 'succeeded') {
    throw new MigrationError('PRECONDITION_FAILED', 'La verifica non è conclusa con successo: niente da accettare', { reasons: ['VERIFY_REQUIRED'], status: run.status });
  }
  const actor = typeof input.actor === 'string' ? input.actor.trim().slice(0, 200) : '';
  if (!actor) throw new MigrationError('VALIDATION_FAILED', 'Attore dell\'accettazione mancante');
  const ids = [...new Set(input.itemIds ?? [])];
  if (ids.some((id) => typeof id !== 'string' || !/^[0-9]{1,19}$/.test(id))) throw new MigrationError('VALIDATION_FAILED', 'item_ids: attesi id di righe');
  const calendarId = input.calendarId ?? null;
  if (calendarId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(calendarId)) {
    throw new MigrationError('VALIDATION_FAILED', 'calendar_id: atteso un UUID');
  }
  if (ids.length === 0 && calendarId === null && input.allExpected !== true) {
    throw new MigrationError('VALIDATION_FAILED', 'Indica le righe, un calendario o tutte le differenze attese');
  }

  const inTx = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    const begin = (db as unknown as { begin?: unknown }).begin;
    if (typeof begin !== 'function') return fn(db);
    return (await db.begin(async (trx) => fn(trx as unknown as Db))) as T;
  };
  const accepted = await inTx(async (tx) => {
    let n = 0;
    if (ids.length) {
      const rows = await tx<Array<{ id: string; expected: boolean; variant: string | null }>>`
        SELECT id::text AS id, expected, detail->>'variant' AS variant FROM cal_migration_items
        WHERE run_id = ${run.id}::uuid AND item_type = 'diff' AND id = ANY(${ids}::bigint[])
        FOR UPDATE
      `;
      const found = new Set(rows.map((r) => r.id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) throw new MigrationError('VALIDATION_FAILED', 'item_ids: righe non trovate in questa verifica', { missing: missing.slice(0, 20) });
      const red = rows.filter((r) => !r.expected).map((r) => r.id);
      if (red.length) {
        throw new MigrationError('NOT_ACCEPTABLE', 'Le differenze inattese (rosse) non si accettano: vanno corrette (nuovo apply, forza o correzione in PG)', { item_ids: red.slice(0, 20) });
      }
      const upd = await tx<Array<{ id: string }>>`
        UPDATE cal_migration_items SET accepted_at = now(), accepted_by = ${actor}
        WHERE run_id = ${run.id}::uuid AND item_type = 'diff' AND expected AND accepted_at IS NULL AND id = ANY(${ids}::bigint[])
        RETURNING id::text AS id
      `;
      n += upd.length;
    }
    if (calendarId !== null || input.allExpected === true) {
      const upd = await tx<Array<{ id: string }>>`
        UPDATE cal_migration_items SET accepted_at = now(), accepted_by = ${actor}
        WHERE run_id = ${run.id}::uuid AND item_type = 'diff' AND expected AND accepted_at IS NULL
          AND (${calendarId}::uuid IS NULL OR calendar_id = ${calendarId}::uuid)
          AND COALESCE(detail->>'variant', '') <> 'with_subscriptions'
        RETURNING id::text AS id
      `;
      n += upd.length;
    }
    return n;
  });

  const verdicts = await verdictsOfRun(db, run);
  await refreshVerifySummary(db, run, verdicts);
  return { accepted, calendars: verdicts, acceptable: verdicts.every((v) => verdictAcceptable(v)) };
}

/**
 * Ultima verifica completa riuscita (tutti i livelli V1-V5 su tutti i
 * calendari: quelle parziali, come il giro orario V4 dello shadow o una
 * verifica di un solo calendario, non attestano la migrazione) e i suoi
 * verdetti, per il wizard, lo shadow e i criteri del cutover.
 */
export async function latestVerifyVerdicts(db: Db): Promise<{ runId: string | null; verdicts: CalendarVerdict[]; acceptable: boolean; finished_at: Date | null }> {
  const rows = await db<Array<{ id: string }>>`
    SELECT id::text AS id FROM cal_migration_runs
    WHERE kind = 'verify' AND status = 'succeeded'
      AND (params->'levels' IS NULL OR jsonb_typeof(params->'levels') <> 'array' OR jsonb_array_length(params->'levels') = 0
           OR (params->'levels') ?& ${[...VERIFY_LEVELS]}::text[])
      AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(params->'scope'->'calendar_ids') = 'array' THEN params->'scope'->'calendar_ids' END), 0) = 0
    ORDER BY finished_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  if (!rows[0]) return { runId: null, verdicts: [], acceptable: false, finished_at: null };
  const run = await readRun(db, rows[0].id);
  const verdicts = await verdictsOfRun(db, run);
  return { runId: run.id, verdicts, acceptable: verdicts.every((v) => verdictAcceptable(v)), finished_at: run.finished_at };
}

// ─── Report scaricabile ───────────────────────────────

interface ItemDbRow {
  id: string;
  seq: number;
  item_type: MigrationItemType;
  calendar_id: string | null;
  collection_name: string | null;
  href: string | null;
  legacy_key: string | null;
  action: PlanAction | null;
  outcome: ApplyOutcome | null;
  code: string | null;
  level: VerifyLevel | null;
  severity: ItemSeverity;
  expected: boolean | null;
  detail: Record<string, unknown> | null;
  forced: boolean;
  accepted_at: Date | null;
  accepted_by: string | null;
}

function itemView(r: ItemDbRow): MigrationItemView {
  return {
    id: r.id,
    seq: r.seq,
    item_type: r.item_type,
    calendar_id: r.calendar_id,
    collection_name: r.collection_name,
    href: r.href,
    legacy_key: r.legacy_key,
    action: r.action,
    outcome: r.outcome,
    code: r.code,
    level: r.level,
    severity: r.severity,
    expected: r.expected,
    detail: r.detail ?? {},
    forced: r.forced,
    accepted_at: iso(r.accepted_at),
    accepted_by: r.accepted_by,
  };
}

const CONFLICT_SET: ReadonlySet<string> = new Set<string>(CONFLICT_CODES);
const READABLE_LIST_MAX = 50;

/** Sezione leggibile del report per il wizard: conteggi per calendario ed esempi di ciò che richiede attenzione. */
function readableSection(run: RunRow, items: readonly MigrationItemView[], verdicts: CalendarVerdict[] | null): Record<string, unknown> {
  const byCalendar = new Map<string, MigrationItemView[]>();
  for (const i of items) {
    const k = i.calendar_id ?? '';
    const list = byCalendar.get(k) ?? [];
    list.push(i);
    byCalendar.set(k, list);
  }
  const sample = (list: readonly MigrationItemView[]) => list.slice(0, READABLE_LIST_MAX).map((i) => ({
    id: i.id,
    href: i.href,
    legacy_key: i.legacy_key,
    code: i.code,
    level: i.level,
    action: i.action,
    outcome: i.outcome,
    summary: typeof i.detail.summary === 'string' ? i.detail.summary : null,
    message: typeof i.detail.message === 'string' ? i.detail.message : typeof i.detail.error === 'string' ? i.detail.error : null,
    reason: typeof i.detail.reason === 'string' ? i.detail.reason : null,
    accepted: i.accepted_at !== null,
  }));
  const calendars = [...byCalendar.entries()].map(([calendarId, list]) => {
    const countBy = (f: (i: MigrationItemView) => string | null) => {
      const out: Record<string, number> = {};
      for (const i of list) {
        const k = f(i);
        if (k) out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    };
    const entry: Record<string, unknown> = {
      calendar_id: calendarId || null,
      collection_name: list.find((i) => i.collection_name)?.collection_name ?? null,
      rows: list.length,
      by_type: countBy((i) => i.item_type),
    };
    if (run.kind === 'apply') {
      entry.by_outcome = countBy((i) => i.outcome);
      entry.conflicts = sample(list.filter((i) => i.outcome === 'conflict'));
      entry.failed = sample(list.filter((i) => i.outcome === 'failed'));
      entry.forced = sample(list.filter((i) => i.outcome === 'forced'));
    } else if (run.kind === 'plan') {
      entry.by_action = countBy((i) => i.action);
      entry.conflicts = sample(list.filter((i) => i.action === 'conflict'));
      entry.anomalies = countBy((i) => (i.item_type === 'anomaly' ? i.code : null));
    } else if (run.kind === 'verify') {
      const verdict = verdicts?.find((v) => v.calendar_id === calendarId) ?? null;
      entry.color = verdict?.color ?? null;
      entry.accepted = verdict?.accepted ?? null;
      entry.by_level = countBy((i) => i.level);
      entry.unexpected = sample(list.filter((i) => i.item_type === 'diff' && i.expected === false));
      entry.to_accept = sample(list.filter((i) => i.item_type === 'diff' && i.expected === true && i.accepted_at === null && i.detail.variant !== 'with_subscriptions'));
    } else {
      entry.by_code = countBy((i) => i.code);
      entry.attention = sample(list.filter((i) => i.severity !== 'info'));
    }
    return entry;
  }).sort((a, b) => String(a.collection_name ?? '').localeCompare(String(b.collection_name ?? '')));

  const out: Record<string, unknown> = {
    kind: run.kind,
    status: run.status,
    rows: items.length,
    calendars,
  };
  if (run.kind === 'apply' && run.summary) {
    const s = run.summary as Record<string, unknown>;
    out.totals = s.totals ?? null;
    out.writes = s.writes ?? null;
    out.zero_writes = s.zero_writes ?? null;
    out.conflicts = Object.fromEntries(Object.entries((s.conflicts as Record<string, number> | undefined) ?? {}).filter(([k]) => CONFLICT_SET.has(k as ConflictCode)));
  }
  if (run.kind === 'verify') {
    const colors = (verdicts ?? []).map((v) => v.color);
    out.overall = colors.length ? worstColor(colors) : ((run.summary as Partial<VerifySummary> | null)?.overall ?? null);
    out.acceptable = verdicts ? verdicts.every((v) => verdictAcceptable(v)) : null;
  }
  return out;
}

/** Cella CSV: virgolette quando serve, apice davanti alle celle che sembrano formule. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
  'id', 'seq', 'item_type', 'calendar_id', 'collection_name', 'href', 'legacy_key', 'action', 'outcome', 'code',
  'level', 'severity', 'expected', 'forced', 'accepted_at', 'accepted_by', 'detail',
] as const;

/** Download di un run, generato al volo (niente file su disco): JSON con run e righe, oppure CSV delle righe. */
export async function buildRunReport(db: Db, runId: string, format: 'json' | 'csv'): Promise<{ filename: string; contentType: string; body: string }> {
  if (format !== 'json' && format !== 'csv') throw new MigrationError('VALIDATION_FAILED', 'Formato del report: json o csv');
  const run = await readRun(db, runId);
  const rows = await db<ItemDbRow[]>`
    SELECT id::text AS id, seq, item_type, calendar_id::text AS calendar_id, collection_name, href, legacy_key,
           action, outcome, code, level, severity, expected, detail, forced, accepted_at, accepted_by
    FROM cal_migration_items
    WHERE run_id = ${run.id}::uuid
    ORDER BY seq
  `;
  const items = rows.map(itemView);
  const day = (run.finished_at ?? run.created_at).toISOString().slice(0, 10).replace(/-/g, '');
  const base = `migrazione-calendario-${run.kind}-${day}-${run.id.slice(0, 8)}`;

  if (format === 'csv') {
    const lines = [CSV_COLUMNS.join(',')];
    for (const i of items) {
      const record: Record<(typeof CSV_COLUMNS)[number], unknown> = {
        id: i.id, seq: i.seq, item_type: i.item_type, calendar_id: i.calendar_id, collection_name: i.collection_name,
        href: i.href, legacy_key: i.legacy_key, action: i.action, outcome: i.outcome, code: i.code, level: i.level,
        severity: i.severity, expected: i.expected, forced: i.forced, accepted_at: i.accepted_at, accepted_by: i.accepted_by,
        detail: i.detail,
      };
      lines.push(CSV_COLUMNS.map((c) => csvCell(record[c])).join(','));
    }
    // BOM: Excel apre l'UTF-8 senza storpiare gli accenti.
    return { filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8', body: `﻿${lines.join('\r\n')}\r\n` };
  }

  const verdicts = run.kind === 'verify' ? await verdictsOfRun(db, run) : null;
  const body = {
    report_version: 1,
    generated_at: new Date().toISOString(),
    run: runView(run),
    readable: readableSection(run, items, verdicts),
    ...(verdicts ? { verdicts, acceptable: verdicts.every((v) => verdictAcceptable(v)) } : {}),
    items,
  };
  return { filename: `${base}.json`, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` };
}

// ─── Piano ───────────────────────────────

/** Conteggi di un piano (pura): stessa implementazione dell'anteprima (plan.planCounts). */
export function summarizePlanItems(items: readonly PlanItem[]): Pick<PlanSummary, 'totals' | 'writes' | 'conflicts' | 'skips' | 'calendars'> {
  return planCounts(items);
}

/** Colore complessivo di un insieme di verdetti (verde senza calendari). */
export function overallColor(verdicts: readonly CalendarVerdict[]): VerifyColor {
  return worstColor(verdicts.map((v) => v.color));
}
