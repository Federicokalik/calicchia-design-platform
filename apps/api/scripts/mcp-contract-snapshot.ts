/**
 * Contratto MCP dei tool di calendario (F0 del passaggio a Radicale, design §12).
 *
 * `apps/mcp` è un proxy puro verso /api/mcp/tools e /api/mcp/execute: il
 * contratto che vedono i client MCP coincide quindi con l'array `tools` di
 * src/lib/agent/tools.ts (nome, description, inputSchema, rischio, conferma) e
 * con l'output JSON degli executor. Questo script estrae dall'array la lista
 * vincolante dei tool di calendario e la salva in
 * test/contracts/__snapshots__/mcp-calendar-tools.schema.json; il test
 * test/contracts/mcp-calendar-tools.contract.test.ts la confronta con il codice
 * e congela anche gli output su fixture deterministiche.
 *
 * Quali tool sono "di calendario":
 *  - rilevati dal sorgente dell'executor: import dinamici di ../calendar/*,
 *    tabelle calendar_* o calendars (oggi 19 tool, non i "22" stimati in
 *    decisioni.md: design §12 lo segnala già);
 *  - più quelli già presenti nello snapshot, anche se il loro executor non
 *    contiene più i marcatori (es. dopo un refactor verso lo store in F2): la
 *    lista è vincolante, un tool entra con una rigenerazione e non esce mai da
 *    solo. Togliere un tool dall'array è rifiutato senza --allow-removal.
 *
 * Esposizione MCP (campo `mcp`): calcolata con le stesse regole di
 * routes/mcp.ts (prefissi dei tool di lettura, rischio di default 'low',
 * scope read/write/admin). Il test la verifica con GET /api/mcp/tools reale.
 *
 * Uso (da apps/api; nessun database richiesto):
 *   tsx scripts/mcp-contract-snapshot.ts                  rigenera lo snapshot
 *   tsx scripts/mcp-contract-snapshot.ts --check          verifica senza scrivere (exit 1 se diverso)
 *   tsx scripts/mcp-contract-snapshot.ts --list           stampa la lista dei tool e termina
 *   tsx scripts/mcp-contract-snapshot.ts --allow-removal  consente di togliere tool vincolanti
 * Script npm equivalenti: `pnpm contract:mcp-snapshot` e `pnpm contract:mcp-check`
 * (quest'ultimo anche in CI, job api-tests, prima dei test).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition } from '../src/lib/agent/tools';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Identificativo del contratto (anche in allowed-diffs.json). */
export const CONTRACT_ID = 'mcp-calendar-tools';

/** Snapshot vincolante dello schema dei tool. */
export const SCHEMA_SNAPSHOT_PATH = resolve(API_ROOT, 'test/contracts/__snapshots__/mcp-calendar-tools.schema.json');

/** Comando documentato nello snapshot per rigenerarlo. */
const REGENERATE_COMMAND = 'pnpm --filter @calicchia/api contract:mcp-snapshot';

// ─── Classificazione ───────────────────────────────

/**
 * Marcatori nel sorgente dell'executor che identificano un tool di calendario:
 * moduli di src/lib/calendar (import dinamici) e tabelle del dominio.
 */
const CALENDAR_SOURCE_MARKERS: readonly RegExp[] = [
  /\.\.\/calendar\//,
  /\bcalendar_(?:events|bookings|event_types|availability_\w+)\b/,
  /\bcalendars\b/,
];

/**
 * Famiglia del tool (design §12 e mappa dei consumatori):
 *  - booking: prenotazioni e tipi (calendar_bookings, calendar_event_types),
 *    che restano in Postgres; la proiezione nel calendario 'bookings' è un effetto;
 *  - events: eventi e calendari, che in F2 passano dallo store;
 *  - mixed: leggono sia prenotazioni sia eventi o busy.
 * Un tool nuovo resta 'unclassified' finché non viene aggiunto qui.
 */
export type CalendarToolFamily = 'booking' | 'events' | 'mixed' | 'unclassified';

const FAMILY: Readonly<Record<string, Exclude<CalendarToolFamily, 'unclassified'>>> = {
  get_calendar_today: 'mixed',
  get_calendar_availability: 'mixed',
  list_event_types: 'booking',
  list_bookings: 'booking',
  create_booking: 'booking',
  reschedule_booking: 'booking',
  cancel_booking: 'booking',
  list_cal_bookings: 'booking',
  create_cal_booking: 'booking',
  update_cal_booking: 'booking',
  cancel_cal_booking: 'booking',
  list_calendars: 'events',
  list_events: 'events',
  get_events_for_today: 'events',
  find_free_slots: 'events',
  create_event: 'events',
  create_calendar: 'events',
  update_event: 'events',
  delete_event: 'events',
};

// ─── Regole di esposizione di routes/mcp.ts ───────────────────────────────

export type McpScope = 'read' | 'write' | 'admin';
export type RiskLevel = 'low' | 'medium' | 'high';

/** Stessi valori di routes/mcp.ts (READ_PREFIXES, READ_EXACT). */
const MCP_READ_PREFIXES = ['get_', 'list_', 'search_', 'read_', 'find_', 'summarize_'];
const MCP_READ_EXACT = new Set(['emails_for_entity']);

function isMcpReadTool(name: string): boolean {
  return MCP_READ_EXACT.has(name) || MCP_READ_PREFIXES.some((p) => name.startsWith(p));
}

/** Scope che vedono ed eseguono il tool (checkScope di routes/mcp.ts). */
function mcpScopesFor(name: string, risk: RiskLevel): McpScope[] {
  const scopes: McpScope[] = [];
  if (isMcpReadTool(name)) scopes.push('read');
  if (risk !== 'high') scopes.push('write');
  scopes.push('admin');
  return scopes;
}

// ─── Forma dello snapshot ───────────────────────────────

export interface CalendarToolContract {
  name: string;
  family: CalendarToolFamily;
  description: string;
  /** `parameters` del tool, esposto da GET /api/mcp/tools come inputSchema. */
  inputSchema: Record<string, unknown>;
  /** Rischio effettivo (routes/mcp.ts usa 'low' se il tool non lo dichiara). */
  riskLevel: RiskLevel;
  /** Conferma richiesta in chat admin/Telegram (assente = false, come in agent/index.ts). */
  requiresConfirmation: boolean;
  mcp: {
    /** Tool di lettura per i prefissi di routes/mcp.ts. */
    readTool: boolean;
    /** Scope dei token MCP che lo vedono in /tools e lo eseguono in /execute. */
    scopes: McpScope[];
  };
  /** Tool che condividono lo stesso executor (alias legacy *_cal_booking), null se unico. */
  sharedExecutor: string[] | null;
}

export interface CalendarToolsSchemaSnapshot {
  contract: typeof CONTRACT_ID;
  version: 1;
  description: string;
  source: string;
  regenerate: string;
  count: number;
  tools: CalendarToolContract[];
}

export interface SchemaBuildResult {
  snapshot: CalendarToolsSchemaSnapshot;
  /** Tool rilevati come calendario e assenti dallo snapshot precedente. */
  added: string[];
  /** Tool dello snapshot precedente che non esistono più nell'array. */
  removed: string[];
  /** Tool dello snapshot precedente mantenuti anche se non più rilevati dai marcatori. */
  sticky: string[];
  /** Tool nuovi senza famiglia in FAMILY. */
  unclassified: string[];
}

/** Sottoinsieme di ToolDefinition usato qui (permette array di prova nei test). */
export type ToolLike = Pick<ToolDefinition, 'name' | 'description' | 'parameters' | 'riskLevel' | 'requiresConfirmation' | 'execute'>;

/** Nomi dei tool il cui executor tocca il dominio calendario. */
export function detectCalendarTools(tools: readonly ToolLike[]): Set<string> {
  const found = new Set<string>();
  for (const tool of tools) {
    const source = Function.prototype.toString.call(tool.execute);
    if (CALENDAR_SOURCE_MARKERS.some((marker) => marker.test(source))) found.add(tool.name);
  }
  return found;
}

/** Copia profonda di un valore JSON (lo schema non deve condividere riferimenti col codice). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Costruisce lo snapshot dall'array dei tool, nell'ordine dell'array (lo
 * stesso di GET /api/mcp/tools). `previous` è lo snapshot vincolante corrente:
 * i suoi tool restano nella lista anche se non più rilevati, e quelli spariti
 * dall'array vengono riportati in `removed` (il chiamante decide se rifiutare).
 */
export function buildSchemaSnapshot(
  tools: readonly ToolLike[],
  previous: CalendarToolsSchemaSnapshot | null = null,
): SchemaBuildResult {
  const detected = detectCalendarTools(tools);
  const previousNames = new Set(previous?.tools.map((t) => t.name) ?? []);
  const existingNames = new Set(tools.map((t) => t.name));

  const selected = tools.filter((t) => detected.has(t.name) || previousNames.has(t.name));

  // Alias: tool diversi con lo stesso executor (stessa funzione).
  const byExecutor = new Map<ToolLike['execute'], string[]>();
  for (const tool of selected) {
    const group = byExecutor.get(tool.execute) ?? [];
    group.push(tool.name);
    byExecutor.set(tool.execute, group);
  }

  const contracts = selected.map((tool): CalendarToolContract => {
    const risk: RiskLevel = tool.riskLevel ?? 'low';
    const group = byExecutor.get(tool.execute) ?? [];
    return {
      name: tool.name,
      family: FAMILY[tool.name] ?? 'unclassified',
      description: tool.description,
      inputSchema: cloneJson(tool.parameters),
      riskLevel: risk,
      requiresConfirmation: tool.requiresConfirmation === true,
      mcp: { readTool: isMcpReadTool(tool.name), scopes: mcpScopesFor(tool.name, risk) },
      sharedExecutor: group.length > 1 ? [...group].sort() : null,
    };
  });

  return {
    snapshot: {
      contract: CONTRACT_ID,
      version: 1,
      description:
        'Lista vincolante dei tool di calendario esposti a MCP, chat admin/Telegram e workflow (array tools di ' +
        'src/lib/agent/tools.ts): nomi, description, inputSchema, rischio, conferma ed esposizione per scope MCP. ' +
        'Gli output su fixture sono in mcp-calendar-tools.outputs.json. Design §12, piano F0.',
      source: 'apps/api/src/lib/agent/tools.ts',
      regenerate: REGENERATE_COMMAND,
      count: contracts.length,
      tools: contracts,
    },
    added: contracts.filter((c) => !previousNames.has(c.name)).map((c) => c.name),
    removed: [...previousNames].filter((name) => !existingNames.has(name)),
    sticky: contracts.filter((c) => previousNames.has(c.name) && !detected.has(c.name)).map((c) => c.name),
    unclassified: contracts.filter((c) => c.family === 'unclassified').map((c) => c.name),
  };
}

/** Serializzazione canonica (2 spazi, newline finale): il file va committato. */
export function serializeSchemaSnapshot(snapshot: CalendarToolsSchemaSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** Legge lo snapshot vincolante; null se il file non esiste ancora. */
export function readSchemaSnapshot(path = SCHEMA_SNAPSHOT_PATH): CalendarToolsSchemaSnapshot | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CalendarToolsSchemaSnapshot;
  if (parsed?.contract !== CONTRACT_ID || !Array.isArray(parsed.tools)) {
    throw new Error(`${path} non è uno snapshot del contratto ${CONTRACT_ID}`);
  }
  return parsed;
}

/** Scrive lo snapshot creando la cartella se serve. */
export function writeSchemaSnapshot(snapshot: CalendarToolsSchemaSnapshot, path = SCHEMA_SNAPSHOT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeSchemaSnapshot(snapshot), 'utf8');
}

/** Elenco leggibile delle differenze per tool fra due snapshot (per --check e per il test). */
export function describeSchemaChanges(
  expected: CalendarToolsSchemaSnapshot | null,
  actual: CalendarToolsSchemaSnapshot,
): string[] {
  const lines: string[] = [];
  const before = new Map((expected?.tools ?? []).map((t) => [t.name, t]));
  const after = new Map(actual.tools.map((t) => [t.name, t]));
  for (const name of after.keys()) {
    if (!before.has(name)) lines.push(`+ ${name}: nuovo tool di calendario`);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) lines.push(`- ${name}: tool non più presente`);
  }
  for (const [name, tool] of after) {
    const old = before.get(name);
    if (!old) continue;
    const fields = (Object.keys(tool) as Array<keyof CalendarToolContract>)
      .filter((key) => JSON.stringify(tool[key]) !== JSON.stringify(old[key]));
    if (fields.length) lines.push(`~ ${name}: cambiati ${fields.join(', ')}`);
  }
  const orderBefore = (expected?.tools ?? []).map((t) => t.name).filter((n) => after.has(n));
  const orderAfter = actual.tools.map((t) => t.name).filter((n) => before.has(n));
  if (JSON.stringify(orderBefore) !== JSON.stringify(orderAfter)) lines.push('~ ordine dei tool nell\'array cambiato');
  return lines;
}

/**
 * Carica l'array dei tool. src/db/index.ts lancia senza DATABASE_URL e crea
 * il pool all'import, ma postgres-js apre connessioni solo alla prima query:
 * fuori dai test basta un URL segnaposto (mai contattato).
 */
export async function loadTools(): Promise<ToolDefinition[]> {
  process.env.DATABASE_URL ||= 'postgres://contract-snapshot@127.0.0.1:1/never-connected';
  process.env.LOG_LEVEL ||= 'silent';
  const mod = await import('../src/lib/agent/tools');
  return mod.tools;
}

// ─── CLI ───────────────────────────────

interface CliOptions {
  check: boolean;
  list: boolean;
  allowRemoval: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = { check: false, list: false, allowRemoval: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--check') opts.check = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--allow-removal') opts.allowRemoval = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Uso: tsx scripts/mcp-contract-snapshot.ts [--check] [--list] [--allow-removal]');
      process.exit(0);
    } else {
      console.error(`Opzione sconosciuta: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main(): Promise<number> {
  const opts = parseCli(process.argv.slice(2));
  const tools = await loadTools();
  const previous = readSchemaSnapshot();
  const result = buildSchemaSnapshot(tools, previous);
  const { snapshot } = result;
  const target = relative(process.cwd(), SCHEMA_SNAPSHOT_PATH) || SCHEMA_SNAPSHOT_PATH;

  if (opts.list) {
    for (const t of snapshot.tools) {
      console.log(`${t.name.padEnd(28)} ${t.family.padEnd(13)} ${t.riskLevel.padEnd(7)} ${t.requiresConfirmation ? 'conferma' : '-'}  [${t.mcp.scopes.join(',')}]`);
    }
    console.log(`\n${snapshot.count} tool di calendario su ${tools.length} tool totali.`);
    return 0;
  }

  const serialized = serializeSchemaSnapshot(snapshot);
  const current = existsSync(SCHEMA_SNAPSHOT_PATH) ? readFileSync(SCHEMA_SNAPSHOT_PATH, 'utf8') : null;
  const changes = describeSchemaChanges(previous, snapshot);

  if (opts.check) {
    if (current === serialized) {
      console.log(`OK: ${target} è allineato (${snapshot.count} tool di calendario).`);
      return 0;
    }
    console.error(`${target} non è allineato a tools.ts:`);
    for (const line of changes.length ? changes : ['~ formato del file diverso']) console.error(`  ${line}`);
    console.error(`Rigenera con: ${REGENERATE_COMMAND}`);
    return 1;
  }

  if (result.removed.length && !opts.allowRemoval) {
    console.error(
      `Tool vincolanti non più presenti in tools.ts: ${result.removed.join(', ')}.\n` +
        'Rimuoverli rompe il contratto MCP (decisioni.md: contratti invariati per i tool calendario). ' +
        'Se la rimozione è voluta, rilancia con --allow-removal.',
    );
    return 1;
  }
  if (result.unclassified.length) {
    console.warn(`Attenzione: tool senza famiglia (aggiungili a FAMILY): ${result.unclassified.join(', ')}`);
  }
  if (result.sticky.length) {
    console.warn(`Mantenuti perché già vincolanti (executor senza marcatori di calendario): ${result.sticky.join(', ')}`);
  }

  if (current === serialized) {
    console.log(`Nessuna modifica: ${target} (${snapshot.count} tool di calendario).`);
    return 0;
  }
  writeSchemaSnapshot(snapshot);
  console.log(`Scritto ${target} (${snapshot.count} tool di calendario).`);
  for (const line of changes) console.log(`  ${line}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('Errore:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
