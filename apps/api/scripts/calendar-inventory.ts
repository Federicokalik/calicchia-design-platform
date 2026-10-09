/**
 * Inventario del calendario in SOLA LETTURA, prima del passaggio a Radicale.
 * Fase F0, attività 1 del piano (docs/calendar-radicale/piano.md); anomalie
 * del design §13.4. Esegue le query di scripts/sql/calendar-inventory.sql
 * contro DATABASE_URL e scrive un report JSON e Markdown in una cartella.
 *
 * Garanzie di sola lettura, una dentro l'altra:
 *  1. connessione dedicata (un solo socket, mai il pool di src/db) aperta con
 *     default_transaction_read_only=on come parametro di avvio;
 *  2. `SET default_transaction_read_only = on` esplicito sulla sessione;
 *  3. un'unica transazione REPEATABLE READ READ ONLY (tutte le query vedono lo
 *     stesso snapshot), verificata con current_setting('transaction_read_only')
 *     prima di eseguire qualsiasi query, e chiusa sempre con ROLLBACK;
 *  4. ogni query del file deve essere una sola istruzione SELECT (o WITH ...
 *     SELECT) senza INTO, FOR UPDATE/SHARE né istruzioni che modificano dati:
 *     altrimenti lo script rifiuta il file senza connettersi;
 *  5. statement_timeout, lock_timeout e idle_in_transaction_session_timeout
 *     locali, così una query lenta non resta appesa sul database di produzione.
 * Ogni query gira in un savepoint: se una fallisce (es. una colonna rinominata
 * da una migrazione futura) l'errore finisce nel report e le altre proseguono.
 *
 * Uso (da apps/api; DATABASE_URL nell'ambiente, nessun .env letto):
 *   pnpm calendar:inventory -- --out ./inventario-calendario
 *   pnpm calendar:inventory -- --out <dir> --sql <file.sql> --max-md-rows 100
 *   pnpm calendar:inventory -- --out <dir> --statement-timeout 120
 *
 * In produzione l'immagine dell'API non contiene scripts/: copiare questo file
 * e scripts/sql/calendar-inventory.sql nel container (stessi percorsi sotto
 * /app/apps/api) ed eseguire `npx tsx scripts/calendar-inventory.ts --out
 * /tmp/inventario-calendario`, oppure lanciarlo da un checkout con
 * DATABASE_URL verso il database. In alternativa, senza Node:
 *   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/sql/calendar-inventory.sql
 *
 * Output (permessi 0600: il report contiene titoli di eventi, username e nomi
 * dei device): <out>/calendar-inventory.json (tutte le righe) e
 * <out>/calendar-inventory.md (riepilogo, anomalie e tabelle troncate a
 * --max-md-rows righe per query).
 *
 * Exit code: 0 ok, 1 errore, 2 uso errato, 3 report scritto ma con query fallite.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(SCRIPT_DIR, '..');

/** File SQL di default. */
export const DEFAULT_SQL_PATH = join(SCRIPT_DIR, 'sql', 'calendar-inventory.sql');

/** Versione del formato del report JSON. */
export const REPORT_SCHEMA = 'caldes.calendar-inventory/v1';

/** Nomi dei file scritti nella cartella di output. */
export const REPORT_FILES = Object.freeze({ json: 'calendar-inventory.json', markdown: 'calendar-inventory.md' });

/** Chiave della query di sessione: deve esistere e confermare la sola lettura. */
const SESSION_QUERY_KEY = '00_sessione';

// ─── Parsing del file SQL ───────────────────────────────

/** Come contare un'anomalia dai risultati di una query. */
export type AnomalyRule =
  | { code: string; kind: 'rows' }
  | { code: string; kind: 'when'; column: string }
  | { code: string; kind: 'sum'; column: string };

export interface InventoryQuery {
  key: string;
  title: string;
  /** Righe di commento della query (descrizione nel report). */
  notes: string[];
  anomalies: AnomalyRule[];
  /** Istruzione SQL senza il ';' finale. */
  sql: string;
}

export class InventorySqlError extends Error {}

/**
 * Testo SQL senza commenti e senza il contenuto di stringhe e identificatori
 * quotati (sostituiti da spazi): serve solo per i controlli lessicali.
 */
function stripSqlLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      out += ' ';
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new InventorySqlError('Commento /* non chiuso');
      i = end + 2;
      out += ' ';
    } else if (ch === "'" || ch === '"') {
      // Stringhe ('...', con '' come escape) e identificatori quotati ("...").
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      if (j >= sql.length) throw new InventorySqlError(`Stringa ${ch} non chiusa`);
      out += ch === "'" ? "''" : '""';
      i = j + 1;
    } else if (ch === '$') {
      // Dollar quoting ($$...$$ o $tag$...$tag$): non usato dall'inventario, rifiutato.
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) throw new InventorySqlError('Dollar quoting non ammesso nelle query di inventario');
      out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Parole che non possono comparire in una query di inventario (fuori da stringhe e commenti). */
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'GRANT', 'REVOKE',
  'COPY', 'CALL', 'DO', 'VACUUM', 'ANALYZE', 'CLUSTER', 'REINDEX', 'REFRESH', 'LOCK', 'COMMENT',
  'SECURITY', 'LISTEN', 'NOTIFY', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'DISCARD', 'RESET', 'SET',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'INTO',
];

/**
 * Verifica che una query sia una sola istruzione SELECT o WITH ... SELECT
 * senza parole che scrivono, bloccano o cambiano la sessione. È una seconda
 * barriera: la prima è la transazione READ ONLY.
 */
export function assertReadOnlySelect(key: string, sql: string): void {
  const bare = stripSqlLiterals(sql).trim();
  if (!bare) throw new InventorySqlError(`Query ${key}: vuota`);
  if (bare.includes(';')) throw new InventorySqlError(`Query ${key}: una sola istruzione per query (';' interno)`);
  if (!/^(SELECT|WITH)\b/i.test(bare)) throw new InventorySqlError(`Query ${key}: deve iniziare con SELECT o WITH`);
  const upper = bare.toUpperCase();
  for (const word of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${word}\\b`).test(upper)) {
      throw new InventorySqlError(`Query ${key}: parola non ammessa "${word}"`);
    }
  }
  if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/.test(upper)) {
    throw new InventorySqlError(`Query ${key}: clausole di lock non ammesse`);
  }
}

const QUERY_MARKER = /^--\s*@query\s+([A-Za-z0-9_]+)\s*\|\s*(.+?)\s*$/;
const ANOMALY_MARKER = /^--\s*@anomaly\s+([A-Z][A-Z0-9_]*)(?:\s+(when|sum)=([a-z0-9_]+))?\s*$/;
const END_MARKER = /^--\s*@end\s*$/;

/**
 * Estrae le query dal file: blocchi che iniziano con `-- @query chiave |
 * titolo` e finiscono alla query successiva o a `-- @end`. Lancia se il
 * formato non è valido o una query non è di sola lettura.
 */
export function parseInventorySql(text: string): InventoryQuery[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const queries: InventoryQuery[] = [];
  let current: { key: string; title: string; notes: string[]; anomalies: AnomalyRule[]; body: string[] } | null = null;
  let ended = false;

  const flush = (): void => {
    if (!current) return;
    const sql = current.body.join('\n').trim().replace(/;\s*$/, '').trim();
    assertReadOnlySelect(current.key, sql);
    queries.push({ key: current.key, title: current.title, notes: current.notes, anomalies: current.anomalies, sql });
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (END_MARKER.test(trimmed)) {
      flush();
      ended = true;
      break;
    }
    const query = QUERY_MARKER.exec(trimmed);
    if (query) {
      flush();
      if (queries.some((q) => q.key === query[1])) throw new InventorySqlError(`Chiave di query duplicata: ${query[1]}`);
      current = { key: query[1], title: query[2], notes: [], anomalies: [], body: [] };
      continue;
    }
    if (!current) continue; // intestazione, SET e BEGIN per l'uso con psql
    if (trimmed.startsWith('--') && current.body.length === 0) {
      if (/^--\s*@anomaly\b/.test(trimmed)) {
        const anomaly = ANOMALY_MARKER.exec(trimmed);
        if (!anomaly) throw new InventorySqlError(`Annotazione @anomaly non valida in ${current.key}: ${trimmed}`);
        const [, code, kind, column] = anomaly;
        current.anomalies.push(kind ? { code, kind: kind as 'when' | 'sum', column } : { code, kind: 'rows' });
      } else if (/^--\s*@/.test(trimmed)) {
        throw new InventorySqlError(`Annotazione sconosciuta in ${current.key}: ${trimmed}`);
      } else {
        const note = trimmed.replace(/^--\s?/, '');
        if (note) current.notes.push(note);
      }
      continue;
    }
    current.body.push(line);
  }
  if (!ended) throw new InventorySqlError('Manca il marcatore finale "-- @end"');
  if (!queries.length) throw new InventorySqlError('Nessuna query "-- @query" nel file');
  if (!queries.some((q) => q.key === SESSION_QUERY_KEY)) {
    throw new InventorySqlError(`Manca la query ${SESSION_QUERY_KEY} (verifica della sola lettura)`);
  }
  return queries;
}

// ─── Esecuzione ───────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Row = Record<string, JsonValue>;

export interface QueryResult {
  key: string;
  title: string;
  notes: string[];
  ok: boolean;
  error: string | null;
  row_count: number;
  columns: string[];
  rows: Row[];
  duration_ms: number;
}

export interface AnomalyCount {
  code: string;
  /** null se una delle query sorgente è fallita. */
  count: number | null;
  sources: string[];
}

export interface InventorySummary {
  calendari: number | null;
  eventi: number | null;
  eventi_singoli: number | null;
  serie: number | null;
  override: number | null;
  prenotazioni_future: number | null;
  iscrizioni: number | null;
  app_password_attive: number | null;
}

export interface InventoryReport {
  schema: typeof REPORT_SCHEMA;
  generated_at: string;
  sql_file: string;
  sql_sha256: string;
  session: Row;
  duration_ms: number;
  failed_queries: string[];
  summary: InventorySummary;
  anomalies: AnomalyCount[];
  queries: QueryResult[];
}

/** OID dei tipi numerici restituiti come stringa da postgres-js (int8, numeric). */
const INT8_OID = 20;
const NUMERIC_OID = 1700;

/** Valore di una cella in forma JSON stabile (date ISO, numeri come numeri quando sicuri). */
function toJsonValue(value: unknown, typeOid: number | undefined): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === 'string' && (typeOid === INT8_OID || typeOid === NUMERIC_OID) && /^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (typeOid === INT8_OID ? Number.isSafeInteger(n) : Number.isFinite(n) && Math.abs(n) < 1e15) return n;
    return value;
  }
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (Array.isArray(value)) return value.map((v) => toJsonValue(v, undefined));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonValue(v, undefined)]));
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  return String(value);
}

function describeError(err: unknown): string {
  const e = err as { message?: string; code?: string; detail?: string };
  const base = e?.message || e?.code || String(err);
  return e?.detail ? `${base} (${e.detail})` : base;
}

export interface RunInventoryOptions {
  databaseUrl: string;
  /** Default: scripts/sql/calendar-inventory.sql. */
  sqlPath?: string;
  /** Timeout di ogni query in secondi (default 120). */
  statementTimeoutSeconds?: number;
}

/**
 * Esegue l'inventario e restituisce il report (senza scrivere file). Lancia
 * se il file SQL non è valido, la connessione fallisce o la transazione non
 * risulta di sola lettura; gli errori delle singole query finiscono nel report.
 */
export async function runCalendarInventory(options: RunInventoryOptions): Promise<InventoryReport> {
  const sqlPath = resolve(options.sqlPath ?? DEFAULT_SQL_PATH);
  const text = readFileSync(sqlPath, 'utf8');
  const queries = parseInventorySql(text);
  const timeoutSeconds = Math.max(1, Math.floor(options.statementTimeoutSeconds ?? 120));
  const started = performance.now();

  const sql = postgres(options.databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    max_lifetime: null,
    prepare: false,
    onnotice: () => {},
    connection: {
      application_name: 'caldes-calendar-inventory',
      // Ogni sessione nasce in sola lettura, anche se il socket venisse riaperto.
      default_transaction_read_only: true,
    },
  });

  const results: QueryResult[] = [];
  let session: Row = {};
  try {
    const reserved = await sql.reserve();
    try {
      await reserved.unsafe('SET default_transaction_read_only = on');
      await reserved.unsafe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await reserved.unsafe("SET LOCAL TIME ZONE 'UTC'");
        await reserved.unsafe(`SET LOCAL statement_timeout = '${timeoutSeconds}s'`);
        await reserved.unsafe("SET LOCAL lock_timeout = '5s'");
        await reserved.unsafe(`SET LOCAL idle_in_transaction_session_timeout = '${timeoutSeconds * 2}s'`);
        const [guard] = await reserved.unsafe<Array<{ ro: string; dro: string }>>(
          "SELECT current_setting('transaction_read_only') AS ro, current_setting('default_transaction_read_only') AS dro",
        );
        if (guard?.ro !== 'on' || guard?.dro !== 'on') {
          throw new Error(`La transazione non è in sola lettura (transaction_read_only=${guard?.ro}, default=${guard?.dro}): inventario interrotto`);
        }

        for (const query of queries) {
          const t0 = performance.now();
          await reserved.unsafe('SAVEPOINT inventario_query');
          try {
            const rows = await reserved.unsafe(query.sql);
            await reserved.unsafe('RELEASE SAVEPOINT inventario_query');
            const types = new Map(rows.columns.map((c) => [c.name, c.type]));
            const columns = rows.columns.map((c) => c.name);
            const jsonRows = [...rows].map((row) =>
              Object.fromEntries(columns.map((col) => [col, toJsonValue((row as Record<string, unknown>)[col], types.get(col))])),
            );
            results.push({
              key: query.key,
              title: query.title,
              notes: query.notes,
              ok: true,
              error: null,
              row_count: jsonRows.length,
              columns,
              rows: jsonRows,
              duration_ms: Math.round(performance.now() - t0),
            });
          } catch (err) {
            await reserved.unsafe('ROLLBACK TO SAVEPOINT inventario_query');
            results.push({
              key: query.key,
              title: query.title,
              notes: query.notes,
              ok: false,
              error: describeError(err),
              row_count: 0,
              columns: [],
              rows: [],
              duration_ms: Math.round(performance.now() - t0),
            });
          }
        }
      } finally {
        // Mai COMMIT: anche una transazione di sola lettura si chiude annullandola.
        await reserved.unsafe('ROLLBACK').catch(() => {});
      }
    } finally {
      reserved.release();
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const sessionResult = results.find((r) => r.key === SESSION_QUERY_KEY);
  if (!sessionResult?.ok || sessionResult.rows[0]?.transaction_read_only !== 'on') {
    throw new Error(`La query ${SESSION_QUERY_KEY} non conferma la sola lettura: ${sessionResult?.error ?? 'transaction_read_only diverso da on'}`);
  }
  session = sessionResult.rows[0];

  return {
    schema: REPORT_SCHEMA,
    generated_at: new Date().toISOString(),
    sql_file: relative(API_ROOT, sqlPath).split('\\').join('/'),
    sql_sha256: createHash('sha256').update(text).digest('hex'),
    session,
    duration_ms: Math.round(performance.now() - started),
    failed_queries: results.filter((r) => !r.ok).map((r) => r.key),
    summary: buildSummary(results),
    anomalies: countAnomalies(queries, results),
    queries: results,
  };
}

// ─── Riepilogo e anomalie ───────────────────────────────

const asNumber = (value: JsonValue | undefined): number => (typeof value === 'number' ? value : Number(value ?? 0) || 0);

function sumColumn(result: QueryResult | undefined, column: string): number | null {
  if (!result?.ok) return null;
  return result.rows.reduce((acc, row) => acc + asNumber(row[column]), 0);
}

function buildSummary(results: QueryResult[]): InventorySummary {
  const byKey = new Map(results.map((r) => [r.key, r]));
  const ok = (key: string): QueryResult | undefined => (byKey.get(key)?.ok ? byKey.get(key) : undefined);
  const events = ok('02_eventi_per_calendario');
  const singles = sumColumn(events, 'singoli');
  const series = sumColumn(events, 'serie');
  const overrides = events ? asNumber(sumColumn(events, 'override_modificati')) + asNumber(sumColumn(events, 'override_cancellati')) : null;
  const appPasswords = ok('15_app_password');
  return {
    calendari: ok('01_calendari')?.row_count ?? null,
    eventi: singles === null || series === null || overrides === null ? null : singles + series + overrides,
    eventi_singoli: singles,
    serie: series,
    override: overrides,
    prenotazioni_future: sumColumn(ok('13_prenotazioni_future'), 'prenotazioni'),
    iscrizioni: ok('14_iscrizioni')?.row_count ?? null,
    app_password_attive: appPasswords
      ? appPasswords.rows.filter((r) => r.is_active === true && r.revocata === false).length
      : null,
  };
}

function countAnomalies(queries: InventoryQuery[], results: QueryResult[]): AnomalyCount[] {
  const byKey = new Map(results.map((r) => [r.key, r]));
  const counts = new Map<string, AnomalyCount>();
  for (const query of queries) {
    for (const rule of query.anomalies) {
      const entry = counts.get(rule.code) ?? { code: rule.code, count: 0, sources: [] };
      entry.sources.push(query.key);
      const result = byKey.get(query.key);
      if (!result?.ok || entry.count === null) {
        entry.count = null;
      } else if (rule.kind !== 'rows' && result.columns.length > 0 && !result.columns.includes(rule.column)) {
        throw new Error(`Query ${query.key}: la colonna "${rule.column}" dell'annotazione ${rule.code} non esiste`);
      } else if (rule.kind === 'rows') {
        entry.count += result.row_count;
      } else if (rule.kind === 'when') {
        entry.count += result.rows.filter((r) => r[rule.column] === true).length;
      } else {
        entry.count += asNumber(sumColumn(result, rule.column));
      }
      counts.set(rule.code, entry);
    }
  }
  return [...counts.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// ─── Markdown ───────────────────────────────

function mdCell(value: JsonValue): string {
  if (value === null) return '—';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const flat = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

function mdTable(columns: string[], rows: Row[]): string {
  const header = `| ${columns.map((c) => mdCell(c)).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((c) => mdCell(row[c] ?? null)).join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

/** Report Markdown: intestazione, riepilogo, anomalie e una tabella per query. */
export function renderInventoryMarkdown(report: InventoryReport, opts: { maxRows?: number } = {}): string {
  const maxRows = Math.max(1, opts.maxRows ?? 200);
  const s = report.session;
  const out: string[] = [
    '# Inventario del calendario',
    '',
    `- Generato: ${report.generated_at} (snapshot del database: ${mdCell(s.snapshot_at ?? null)})`,
    `- Database: ${mdCell(s.database ?? null)}, PostgreSQL ${mdCell(s.server_version ?? null)}, ultima migrazione ${mdCell(s.ultima_migrazione ?? null)} (${mdCell(s.migrazioni_applicate ?? null)} applicate)`,
    `- Sessione: transaction_read_only=${mdCell(s.transaction_read_only ?? null)}, default_transaction_read_only=${mdCell(s.default_transaction_read_only ?? null)}, isolamento ${mdCell(s.isolamento ?? null)}, fuso ${mdCell(s.fuso ?? null)}`,
    `- SQL: \`${report.sql_file}\` (sha256 \`${report.sql_sha256.slice(0, 16)}…\`), durata ${report.duration_ms} ms`,
    '',
    '> Contiene dati personali (titoli degli eventi, username e nomi dei device delle app-password, nomi delle iscrizioni). Non condividerlo fuori dal progetto; gli IP sono mascherati e i token non vengono mai letti.',
    '',
  ];
  if (report.failed_queries.length) {
    out.push(`**Query fallite: ${report.failed_queries.join(', ')}.** I conteggi che ne dipendono sono indicati come "—".`, '');
  }

  const summaryLabels: Record<keyof InventorySummary, string> = {
    calendari: 'Calendari',
    eventi: 'Eventi (righe di calendar_events)',
    eventi_singoli: 'di cui singoli',
    serie: 'di cui serie',
    override: 'di cui override (modificati e cancellati)',
    prenotazioni_future: 'Prenotazioni future',
    iscrizioni: 'Iscrizioni ICS',
    app_password_attive: 'App-password attive',
  };
  out.push('## Riepilogo', '', '| Voce | Valore |', '| --- | --- |');
  for (const [key, label] of Object.entries(summaryLabels) as Array<[keyof InventorySummary, string]>) {
    out.push(`| ${label} | ${mdCell(report.summary[key])} |`);
  }
  out.push('');

  out.push('## Anomalie (design §13.4)', '', '| Codice | Conteggio | Query |', '| --- | --- | --- |');
  for (const a of report.anomalies) out.push(`| ${a.code} | ${mdCell(a.count)} | ${a.sources.join(', ')} |`);
  out.push('');

  out.push('## Query', '');
  for (const q of report.queries) {
    out.push(`### ${q.key}: ${q.title}`, '');
    if (q.notes.length) out.push(q.notes.join(' '), '');
    if (!q.ok) {
      out.push(`**Errore:** ${mdCell(q.error)}`, '');
      continue;
    }
    out.push(`${q.row_count} ${q.row_count === 1 ? 'riga' : 'righe'}, ${q.duration_ms} ms.`, '');
    if (q.row_count === 0) continue;
    out.push(mdTable(q.columns, q.rows.slice(0, maxRows)), '');
    if (q.row_count > maxRows) out.push(`_Prime ${maxRows} righe di ${q.row_count}: l'elenco completo è nel JSON._`, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** Scrive JSON e Markdown nella cartella (creata se manca) con permessi 0600. */
export function writeInventoryReport(report: InventoryReport, outDir: string, opts: { maxRows?: number } = {}): { json: string; markdown: string } {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const json = join(dir, REPORT_FILES.json);
  const markdown = join(dir, REPORT_FILES.markdown);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdown, renderInventoryMarkdown(report, opts), { mode: 0o600 });
  return { json, markdown };
}

// ─── CLI ───────────────────────────────

const USAGE = `Uso: pnpm calendar:inventory -- --out <cartella> [--sql <file.sql>] [--max-md-rows <n>] [--statement-timeout <secondi>]

Esegue in sola lettura l'inventario del calendario contro DATABASE_URL e scrive
<cartella>/${REPORT_FILES.json} e <cartella>/${REPORT_FILES.markdown}.`;

export async function main(argv: string[]): Promise<number> {
  let values: { out?: string; sql?: string; 'max-md-rows'?: string; 'statement-timeout'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      // pnpm (dalla 7) inoltra allo script anche il separatore '--' di
      // `pnpm calendar:inventory -- --out <dir>`: senza il filtro parseArgs
      // tratterebbe tutto ciò che segue come argomenti posizionali.
      args: argv.filter((a) => a !== '--'),
      options: {
        out: { type: 'string' },
        sql: { type: 'string' },
        'max-md-rows': { type: 'string' },
        'statement-timeout': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`${describeError(err)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.out) {
    console.error(`--out è obbligatorio.\n\n${USAGE}`);
    return 2;
  }
  const maxRows = values['max-md-rows'] !== undefined ? Number(values['max-md-rows']) : 200;
  const timeout = values['statement-timeout'] !== undefined ? Number(values['statement-timeout']) : 120;
  if (!Number.isInteger(maxRows) || maxRows < 1 || !Number.isInteger(timeout) || timeout < 1) {
    console.error(`--max-md-rows e --statement-timeout devono essere interi positivi.\n\n${USAGE}`);
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL non impostata.');
    return 2;
  }

  try {
    const report = await runCalendarInventory({ databaseUrl, sqlPath: values.sql, statementTimeoutSeconds: timeout });
    const files = writeInventoryReport(report, values.out, { maxRows });
    const anomalies = report.anomalies.filter((a) => a.count !== 0).map((a) => `${a.code}=${a.count ?? '?'}`);
    console.log(`Inventario di ${report.session.database} (${report.queries.length} query, ${report.duration_ms} ms, sola lettura).`);
    console.log(`Anomalie: ${anomalies.length ? anomalies.join(', ') : 'nessuna'}.`);
    console.log(`Report: ${files.markdown}\n        ${files.json}`);
    if (report.failed_queries.length) {
      console.error(`Query fallite: ${report.failed_queries.join(', ')} (dettagli nel report).`);
      return 3;
    }
    return 0;
  } catch (err) {
    if (err instanceof InventorySqlError) {
      console.error(`File SQL non valido: ${err.message}`);
      return 2;
    }
    console.error(`Errore: ${describeError(err)}`);
    return 1;
  }
}

const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
