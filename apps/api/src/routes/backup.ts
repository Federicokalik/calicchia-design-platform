import { Hono } from 'hono';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { customAlphabet } from 'nanoid';
import { sql, sqlv } from '../db';
import {
  type BackendMode,
  type CalendarBackendState,
  normalizeBackendState,
} from '../lib/calendar/radicale/types';

type Env = { Variables: { user: { id: string; email?: string; role?: string } } };

export const backup = new Hono<Env>();

const BACKUP_VERSION = 1;
const ALLOWED_SCHEMAS = ['public', 'auth'] as const;
const CONFIRM_TOKEN = 'RIPRISTINA-DATABASE';
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const PRE_RESTORE_DIR = join(UPLOAD_DIR, 'backups');

type TableRef = { schema: string; table: string };
type ColumnInfo = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_generated: 'NEVER' | 'ALWAYS';
  is_identity: 'YES' | 'NO';
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tipo tx di postgres-js (stesso pattern di src/)
type Tx = any;

const tableKey = (t: TableRef): string => `${t.schema}.${t.table}`;
const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const qualified = (key: string): string => {
  const dot = key.indexOf('.');
  return `${ident(key.slice(0, dot))}.${ident(key.slice(dot + 1))}`;
};

// ─── Partizione delle tabelle (design §16.2) ─────────────────────────────────
//
// Il formato v1 resta quello di sempre (è un contratto): l'export contiene
// tutte le tabelle. Cambia solo cosa il ripristino ne fa, per gruppo:
//
//  S  stato e derivati: mai ripristinati dal JSON, in nessuna modalità
//     (saltati e riportati nella risposta). Riportare indietro lo stato del
//     backend (mode, volume_id, epoch, credential_epoch…) o l'indice derivato
//     rimetterebbe in gioco un volume o una policy che non sono più veri.
//  D  dominio iCalendar: ripristinato solo con calendar_backend_state.mode =
//     'postgres'. Fuori da 'postgres' la fonte è il volume Radicale e si usa
//     il ripristino coordinato (dump più snapshot) o quello da versioni.
//  B  tutto il resto (prenotazioni, tipi, disponibilità, app-password,
//     promemoria, CRM…): TRUNCATE e reinserimento come prima.
//
// session_replication_role = 'replica' spegne i trigger (anche i vincoli dei
// trigger 162 e la guardia 166 della F4): l'esclusione di S e D DEVE stare qui
// nel codice, non nel database (design §4, contratto control-plane §2).

/** Gruppo di una tabella nel backup. */
export type BackupGroup = 'state' | 'calendar' | 'business';

/**
 * Gruppo S con nomi espliciti: cal_bookings, cal_sync_log e cal_webhook_logs
 * (integrazione Cal.com, migrazione 023) sono dati di business nonostante il
 * prefisso, quindi niente regola su "cal_*". Le tabelle dell'indice e dei job
 * (163-164) e lo stato (162/165) vanno elencate qui quando nascono.
 *
 * schema_migrations è stato dello schema, non un dato: il ripristino non cambia
 * lo schema (le tabelle del backup devono già esistere), quindi il ledger deve
 * restare quello vero. Ripristinarlo da un backup vecchio fa riapplicare al
 * boot migrazioni già applicate (una non idempotente blocca l'avvio
 * dell'API); da uno più nuovo, fa saltare migrazioni mai applicate.
 */
const STATE_TABLES: ReadonlySet<string> = new Set([
  'public.schema_migrations',
  'public.calendar_backend_state',
  'public.cal_jobs',
  'public.cal_collection_state',
  'public.cal_objects',
  'public.cal_components',
  'public.cal_occurrences',
  'public.cal_booking_conflicts',
  'public.cal_object_ids',
  'public.cal_object_versions',
]);

/** cal_migration_runs, cal_migration_ledger, cal_migration_items (165) e successive. */
const STATE_TABLE_PREFIXES: readonly string[] = ['public.cal_migration_'];

const CALENDARS_KEY = 'public.calendars';

/**
 * Gruppo D. calendar_events_legacy esiste solo dopo il finalize (167): è
 * elencata già ora perché, se presente, non deve mai finire nel gruppo B.
 */
const CALENDAR_TABLES: ReadonlySet<string> = new Set([
  CALENDARS_KEY,
  'public.calendar_events',
  'public.calendar_events_legacy',
  'public.calendar_subscriptions',
]);

export function backupGroup(key: string): BackupGroup {
  if (STATE_TABLES.has(key) || STATE_TABLE_PREFIXES.some((p) => key.startsWith(p))) return 'state';
  if (CALENDAR_TABLES.has(key)) return 'calendar';
  return 'business';
}

/** Durata della guardia post-ripristino: nessuna cancellazione automatica e policy frozen (design §16.2). */
export const RESTORE_GUARD_HOURS = 48;

/** Codice di needs_review per le righe di calendars assenti dal backup (contratto control-plane §3.1). */
export const MISSING_IN_BACKUP = 'missing_in_backup';

// ─── Catalogo ────────────────────────────────────────────────────────────────

// information_schema riporta come BASE TABLE sia una tabella partizionata
// (analytics) sia ognuna delle sue partizioni: esportandole tutte, ogni evento
// finiva due volte nel backup e il ripristino falliva sempre per chiave
// duplicata. Si tiene solo il padre: SELECT, TRUNCATE e INSERT sul padre
// coprono già le partizioni (le righe vengono instradate da Postgres).
async function listTables(db: Tx = sql): Promise<TableRef[]> {
  const rows = await db`
    SELECT t.table_schema AS schema, t.table_name AS table
    FROM information_schema.tables t
    JOIN pg_namespace n ON n.nspname = t.table_schema
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
    WHERE t.table_schema = ANY(${[...ALLOWED_SCHEMAS] as unknown as string[]})
      AND t.table_type = 'BASE TABLE'
      AND NOT c.relispartition
    ORDER BY t.table_schema, t.table_name
  ` as unknown as TableRef[];
  return rows;
}

/** "schema.tabella" delle partizioni: nei backup vecchi duplicano il padre. */
async function listPartitionKeys(): Promise<Set<string>> {
  const rows = await sql`
    SELECT n.nspname || '.' || c.relname AS key
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relispartition AND c.relkind IN ('r', 'p')
      AND n.nspname = ANY(${[...ALLOWED_SCHEMAS] as unknown as string[]})
  ` as unknown as Array<{ key: string }>;
  return new Set(rows.map((r) => r.key));
}

const INSERT_BATCH = 500;

// Fetch column metadata for every allowed table in one query (DBX-02: avoids a
// per-table round-trip), grouped by "schema.table".
async function getAllColumns(db: Tx = sql): Promise<Map<string, ColumnInfo[]>> {
  const rows = await db`
    SELECT table_schema, table_name, column_name, data_type, udt_name, is_generated, is_identity
    FROM information_schema.columns
    WHERE table_schema = ANY(${[...ALLOWED_SCHEMAS] as unknown as string[]})
    ORDER BY table_schema, table_name, ordinal_position
  ` as unknown as Array<ColumnInfo & { table_schema: string; table_name: string }>;

  const byTable = new Map<string, ColumnInfo[]>();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`;
    (byTable.get(key) ?? byTable.set(key, []).get(key)!).push(r);
  }
  return byTable;
}

/** Foreign key fra tabelle (radici delle partizioni), con le colonne nell'ordine del vincolo. */
export interface ForeignKeyRef {
  name: string;
  /** "schema.tabella" che contiene la FK. */
  child: string;
  /** "schema.tabella" referenziata. */
  parent: string;
  childCols: string[];
  parentCols: string[];
}

/**
 * Tutte le FK del database, anche verso schemi diversi da public/auth (una
 * tabella fuori dal backup che referenzia una tabella da svuotare deve
 * bloccare il ripristino, non essere svuotata in silenzio). Solo i vincoli
 * di primo livello (conparentid = 0): quelli ereditati dalle partizioni
 * duplicherebbero il padre.
 */
export async function listForeignKeys(db: Tx = sql): Promise<ForeignKeyRef[]> {
  const rows = await db`
    SELECT con.conname AS name,
           cn.nspname || '.' || cl.relname AS child,
           fn.nspname || '.' || fl.relname AS parent,
           array_agg(ca.attname::text ORDER BY k.ord) AS child_cols,
           array_agg(pa.attname::text ORDER BY k.ord) AS parent_cols
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = COALESCE(pg_partition_root(con.conrelid), con.conrelid)
    JOIN pg_namespace cn ON cn.oid = cl.relnamespace
    JOIN pg_class fl ON fl.oid = COALESCE(pg_partition_root(con.confrelid), con.confrelid)
    JOIN pg_namespace fn ON fn.oid = fl.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(child_att, parent_att, ord)
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.child_att
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.parent_att
    WHERE con.contype = 'f' AND con.conparentid = 0
    GROUP BY con.oid, con.conname, cn.nspname, cl.relname, fn.nspname, fl.relname
    ORDER BY child, name
  ` as unknown as Array<{ name: string; child: string; parent: string; child_cols: string[]; parent_cols: string[] }>;
  return rows.map((r) => ({
    name: r.name,
    child: r.child,
    parent: r.parent,
    childCols: [...r.child_cols],
    parentCols: [...r.parent_cols],
  }));
}

// ─── Stato del backend calendario ────────────────────────────────────────────

/**
 * Stato del backend calendario visto dal backup:
 * - absent: schema precedente alla 162, Postgres è l'unico store;
 * - ok: riga singleton valida;
 * - unreadable: riga assente o fuori contratto. Fail-closed: il dominio
 *   calendario non si ripristina (non si sa chi sia la fonte).
 */
type CalendarBackendRead =
  | { kind: 'absent' }
  | { kind: 'ok'; state: CalendarBackendState }
  | { kind: 'unreadable'; reason: string };

async function readCalendarBackend(db: Tx, opts: { forUpdate?: boolean } = {}): Promise<CalendarBackendRead> {
  const [{ present }] = await db`
    SELECT to_regclass('public.calendar_backend_state') IS NOT NULL AS present
  ` as Array<{ present: boolean }>;
  if (!present) return { kind: 'absent' };
  // FOR UPDATE nel ripristino: una transizione di stato (cutover, rollback,
  // inizializzazione, revoca di app-password) aspetta la fine dell'import
  // invece di cambiare la modalità a metà.
  const rows = opts.forUpdate
    ? await db`
        SELECT mode, write_freeze, volume_id, epoch, credential_epoch, policy_version,
               restore_guard_until, rebuild_required
        FROM public.calendar_backend_state WHERE id = true FOR UPDATE
      `
    : await db`
        SELECT mode, write_freeze, volume_id, epoch, credential_epoch, policy_version,
               restore_guard_until, rebuild_required
        FROM public.calendar_backend_state WHERE id = true
      `;
  if (rows.length !== 1) return { kind: 'unreadable', reason: 'riga singleton assente' };
  try {
    return { kind: 'ok', state: normalizeBackendState(rows[0] as Record<string, unknown>) };
  } catch (err) {
    return { kind: 'unreadable', reason: (err as Error).message };
  }
}

/** Il dominio calendario (gruppo D) si ripristina solo con Postgres autorevole. */
function calendarRestorable(read: CalendarBackendRead): boolean {
  return read.kind === 'absent' || (read.kind === 'ok' && read.state.mode === 'postgres');
}

/** Riassunto per la UI (GET /info e risposta dell'import). */
interface CalendarBackendSummary {
  /** 'absent' = schema precedente alla 162; 'unreadable' = stato illeggibile. */
  status: CalendarBackendRead['kind'];
  mode: BackendMode | null;
  /** true se il ripristino da JSON tocca calendari, eventi e iscrizioni. */
  restorable: boolean;
  rebuild_required: boolean;
  restore_guard_until: string | null;
}

function summarizeBackend(read: CalendarBackendRead): CalendarBackendSummary {
  return {
    status: read.kind,
    mode: read.kind === 'ok' ? read.state.mode : read.kind === 'absent' ? 'postgres' : null,
    restorable: calendarRestorable(read),
    rebuild_required: read.kind === 'ok' ? read.state.rebuild_required : false,
    restore_guard_until:
      read.kind === 'ok' && read.state.restore_guard_until ? read.state.restore_guard_until.toISOString() : null,
  };
}

// ─── Piano del ripristino ────────────────────────────────────────────────────

export interface RestorePlan {
  /** Tabelle svuotate con un unico TRUNCATE senza CASCADE (insieme chiuso rispetto alle FK). */
  truncate: string[];
  /** Tabelle in cui si reinseriscono le righe del backup (sottoinsieme di truncate). */
  insert: string[];
  /** Svuotate solo per chiudere l'insieme rispetto alle FK (prima lo faceva il CASCADE), senza righe da reinserire. */
  emptied: string[];
  /** calendars in UPSERT per id (mai TRUNCATE: il CASCADE svuoterebbe indice e id). */
  upsertCalendars: boolean;
  /** Tabelle del gruppo S presenti nel backup: mai ripristinate. */
  skippedState: string[];
  /** Tabelle del gruppo D presenti nel backup ma non ripristinate (mode ≠ postgres). */
  skippedCalendar: string[];
  /** Tabelle del backup (escluso S) che non esistono nel database. */
  unknown: string[];
  /** Tabelle protette che referenziano una tabella da svuotare: il ripristino non è eseguibile. */
  blocked: Array<{ table: string; referencedBy: string; constraint: string }>;
}

/**
 * Funzione pura: dalle tabelle del backup, da quelle del database, dalle FK e
 * dalla modalità decide cosa svuotare, reinserire, aggiornare o saltare.
 *
 * Protette (mai svuotate, nemmeno per chiusura FK): il gruppo S, calendars,
 * il resto del gruppo D quando non si ripristina, e ogni tabella fuori da
 * public/auth. Se una di queste referenzia una tabella da svuotare, il TRUNCATE
 * senza CASCADE fallirebbe e con CASCADE la svuoterebbe: il piano lo segnala
 * in `blocked` e il ripristino viene rifiutato prima di toccare qualsiasi dato.
 */
export function planRestore(input: {
  liveTables: readonly string[];
  backupTables: readonly string[];
  restoreCalendar: boolean;
  foreignKeys: readonly Pick<ForeignKeyRef, 'name' | 'child' | 'parent'>[];
}): RestorePlan {
  const live = new Set(input.liveTables);
  const plan: RestorePlan = {
    truncate: [],
    insert: [],
    emptied: [],
    upsertCalendars: false,
    skippedState: [],
    skippedCalendar: [],
    unknown: [],
    blocked: [],
  };

  for (const key of [...new Set(input.backupTables)].sort()) {
    const group = backupGroup(key);
    if (group === 'state') {
      plan.skippedState.push(key);
      continue;
    }
    if (!live.has(key)) {
      plan.unknown.push(key);
      continue;
    }
    if (group === 'calendar' && !input.restoreCalendar) {
      plan.skippedCalendar.push(key);
      continue;
    }
    if (key === CALENDARS_KEY) {
      plan.upsertCalendars = true;
      continue;
    }
    plan.insert.push(key);
  }

  const isProtected = (key: string): boolean =>
    !live.has(key) ||
    backupGroup(key) === 'state' ||
    key === CALENDARS_KEY ||
    (backupGroup(key) === 'calendar' && !input.restoreCalendar);

  // Chiusura rispetto alle FK: chi referenzia una tabella svuotata va svuotato
  // anche lui (stesso effetto del vecchio CASCADE), salvo le tabelle protette.
  const truncate = new Set(plan.insert);
  const queue = [...plan.insert];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const fk of input.foreignKeys) {
      if (fk.parent !== parent || truncate.has(fk.child)) continue;
      if (isProtected(fk.child)) {
        plan.blocked.push({ table: parent, referencedBy: fk.child, constraint: fk.name });
        continue;
      }
      truncate.add(fk.child);
      plan.emptied.push(fk.child);
      queue.push(fk.child);
    }
  }
  plan.truncate = [...truncate].sort();
  plan.emptied.sort();
  return plan;
}

class RestorePlanError extends Error {
  constructor(message: string, readonly details: unknown) {
    super(message);
  }
}

class RestoreIntegrityError extends Error {}

// ─── Snapshot ────────────────────────────────────────────────────────────────

async function buildSnapshot() {
  const tables = await listTables();
  const columnsByTable = await getAllColumns();
  const data: Record<string, unknown[]> = {};
  let totalRows = 0;

  for (const t of tables) {
    const cols = columnsByTable.get(tableKey(t)) ?? [];
    const writable = cols.filter((c) => c.is_generated !== 'ALWAYS');
    if (writable.length === 0) {
      data[tableKey(t)] = [];
      continue;
    }
    const colList = writable.map((c) => ident(c.column_name)).join(', ');
    const rows = await sql.unsafe(
      `SELECT ${colList} FROM ${ident(t.schema)}.${ident(t.table)}`
    ) as unknown as Record<string, unknown>[];
    data[tableKey(t)] = rows;
    totalRows += rows.length;
  }

  return {
    snapshot: {
      version: BACKUP_VERSION,
      generated_at: new Date().toISOString(),
      generator: 'caldes-admin',
      tables: data,
    },
    stats: { tableCount: tables.length, totalRows },
  };
}

backup.get('/info', async (c) => {
  const tables = await listTables();

  // DBX-02: one round-trip for all row counts instead of a COUNT(*) per table.
  // Schema/table names come from information_schema (real identifiers); they are
  // double-quoted as identifiers and single-quote-escaped as string literals.
  let stats: Array<{ schema: string; table: string; rows: number; group: BackupGroup }> = [];
  if (tables.length > 0) {
    const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const unionSql = tables
      .map((t) => `SELECT ${lit(tableKey(t))} AS key, COUNT(*)::int AS count FROM ${ident(t.schema)}.${ident(t.table)}`)
      .join(' UNION ALL ');
    const counts = await sql.unsafe(unionSql) as unknown as Array<{ key: string; count: number }>;
    const byKey = new Map(counts.map((r) => [r.key, r.count]));
    stats = tables.map((t) => ({
      schema: t.schema,
      table: t.table,
      rows: byKey.get(tableKey(t)) ?? 0,
      group: backupGroup(tableKey(t)),
    }));
  }

  const totalRows = stats.reduce((acc, t) => acc + t.rows, 0);
  const calendar = summarizeBackend(await readCalendarBackend(sql));
  return c.json({ version: BACKUP_VERSION, tableCount: tables.length, totalRows, tables: stats, calendar });
});

backup.get('/export', async (c) => {
  const { snapshot, stats } = await buildSnapshot();
  const user = c.get('user');

  await sql`
    INSERT INTO audit_logs (
      user_email, user_role, action, table_name, metadata
    ) VALUES (
      ${user?.email ?? null}, ${user?.role ?? null},
      'EXPORT', 'backup',
      ${sqlv({ source: 'api/backup', ...stats })}
    )
  `;

  const filename = `caldes-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  return new Response(JSON.stringify(snapshot), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

// ─── Inserimento a blocchi ───────────────────────────────────────────────────

interface InsertTarget {
  schema: string;
  table: string;
  writable: ColumnInfo[];
}

/** Riga del backup ridotta alle colonne scrivibili, jsonb con tx.json(). */
function toInsertRow(tx: Tx, raw: Record<string, unknown>, target: InsertTarget): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const col of target.writable) {
    if (!(col.column_name in raw)) continue;
    const value = raw[col.column_name];
    // JSONB/JSON: tx.json() invia il valore con tipo jsonb e lo serializza una
    // sola volta. Pre-serializzarlo con JSON.stringify lo faceva ricodificare
    // dal serializer jsonb di postgres-js: ogni oggetto tornava come stringa
    // JSON (impostazioni, codici MFA, contenuti… tutti corrotti dopo il
    // ripristino).
    obj[col.column_name] =
      (col.data_type === 'jsonb' || col.data_type === 'json') && value !== null && value !== undefined
        ? tx.json(value)
        : value;
  }
  return obj;
}

/**
 * Inserisce le righe a blocchi di righe con le stesse colonne (una INSERT per
 * riga rendeva il ripristino di analytics lentissimo). Con `upsertOnId` le
 * righe con un id già presente vengono aggiornate sulle sole colonne del
 * backup (calendars: le colonne del sidecar che il backup non ha restano).
 */
async function insertRows(
  tx: Tx,
  target: InsertTarget,
  rows: Record<string, unknown>[],
  opts: { upsertOnId?: boolean } = {},
): Promise<number> {
  await tx.unsafe(`SET LOCAL search_path TO ${ident(target.schema)}`);
  let inserted = 0;
  let batch: Record<string, unknown>[] = [];
  let batchCols: string[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    if (opts.upsertOnId && batchCols.includes('id')) {
      const updates = batchCols.filter((col) => col !== 'id');
      if (updates.length === 0) {
        await tx`INSERT INTO ${tx(target.table)} ${tx(batch, ...batchCols)} ON CONFLICT (id) DO NOTHING`;
      } else {
        // Frammenti annidati (postgres-js): "col" = EXCLUDED."col", ...
        const set = updates
          .map((col) => tx`${tx(col)} = EXCLUDED.${tx(col)}`)
          .reduce((acc: unknown, fragment: unknown) => tx`${acc}, ${fragment}`);
        await tx`INSERT INTO ${tx(target.table)} ${tx(batch, ...batchCols)} ON CONFLICT (id) DO UPDATE SET ${set}`;
      }
    } else {
      await tx`INSERT INTO ${tx(target.table)} ${tx(batch, ...batchCols)}`;
    }
    inserted += batch.length;
    batch = [];
  };

  for (const raw of rows) {
    const obj = toInsertRow(tx, raw, target);
    const cleaned = Object.keys(obj);
    if (cleaned.length === 0) continue;
    // Limite di 65535 parametri per statement in Postgres.
    const maxRows = Math.max(1, Math.min(INSERT_BATCH, Math.floor(60000 / cleaned.length)));
    if (batch.length >= maxRows || cleaned.join(',') !== batchCols.join(',')) {
      await flush();
      batchCols = cleaned;
    }
    batch.push(obj);
  }
  await flush();
  return inserted;
}

// ─── calendars in UPSERT ─────────────────────────────────────────────────────

const generateFeedToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 32);

/** Stesso limite di SLUG_REGEX in lib/calendar/calendars.ts (1 + 80 caratteri). */
const SLUG_MAX = 81;

/** Calendario mantenuto perché assente dal backup (needs_review = missing_in_backup). */
export interface KeptCalendar {
  id: string;
  slug: string;
  /** Slug prima del ripristino, se cambiato perché il backup lo assegna a un altro calendario. */
  previous_slug?: string;
  /** Token del feed rigenerato perché il backup lo assegna a un altro calendario. */
  feed_token_regenerated?: true;
  /** Nome di collezione liberato (poi riassegnato dalla riconciliazione, se possibile). */
  released_collection_name?: string;
}

export interface CalendarRestoreReport {
  inserted: number;
  updated: number;
  kept: KeptCalendar[];
}

/** Slug libero per un calendario mantenuto: `<slug>-<8 cifre dell'id>`, con un contatore se serve. */
function freeSlug(base: string, id: string, used: ReadonlySet<string>): string {
  const suffix = id.replace(/-/g, '').slice(0, 8);
  const stem = base.slice(0, SLUG_MAX - suffix.length - 5).replace(/-+$/, '') || 'calendario';
  let candidate = `${stem}-${suffix}`;
  for (let n = 2; used.has(candidate); n++) candidate = `${stem}-${suffix}-${n}`;
  return candidate;
}

const rowId = (row: Record<string, unknown>): string | null =>
  typeof row.id === 'string' ? row.id.toLowerCase() : null;

/**
 * calendars in UPSERT per id sulle sole colonne presenti nel backup (design
 * §16.2). Niente TRUNCATE: le colonne del sidecar che il backup non ha (un
 * backup precedente alla 162 non ne ha nessuna) restano, e le righe assenti
 * dal backup non vengono cancellate ma segnalate con needs_review.
 *
 * Gira con session_replication_role = 'replica' (nessun trigger, nessun
 * controllo di FK) e risolve prima i vincoli UNIQUE (slug, ics_feed_token,
 * collection_name, un solo is_default) che l'UPSERT riga per riga violerebbe:
 * 1. le righe che il backup riscrive liberano subito i valori che il backup
 *    rimpiazza (segnaposto univoci, poi sovrascritti dall'UPSERT): così uno
 *    scambio di slug fra due calendari non collide a metà;
 * 2. le righe assenti dal backup cedono ai calendari del backup slug, token
 *    del feed, nome di collezione e is_default che collidono (il caso tipico è
 *    il ripristino su un database nuovo, dove i calendari seminati hanno gli
 *    stessi slug ma id diversi) e vanno in needs_review 'missing_in_backup'
 *    senza sovrascrivere un motivo già presente;
 * 3. UPSERT a blocchi.
 * In mode postgres eventi e iscrizioni vengono sostituiti da quelli del backup
 * (un export completo li contiene sempre), quindi le righe mantenute restano
 * vuote: nessun evento del backup va perso, e id e sidecar (in futuro anche
 * indice e id degli oggetti, che le referenziano) restano validi.
 */
async function upsertCalendars(
  tx: Tx,
  target: InsertTarget,
  rawRows: Record<string, unknown>[],
): Promise<CalendarRestoreReport> {
  const writableNames = new Set(target.writable.map((c) => c.column_name));
  const rows = rawRows.map((raw) => {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (writableNames.has(k)) obj[k] = v;
    return obj;
  });

  const live = await tx`
    SELECT id::text AS id, slug, ics_feed_token, collection_name, is_default, needs_review, review_reason
    FROM public.calendars
    ORDER BY created_at, id
    FOR UPDATE
  ` as Array<{
    id: string;
    slug: string;
    ics_feed_token: string;
    collection_name: string | null;
    is_default: boolean;
    needs_review: boolean;
    review_reason: string | null;
  }>;
  const liveIds = new Set(live.map((r) => r.id));
  const backupIds = new Set(rows.map(rowId).filter((id): id is string => id !== null));

  // 1. Valori liberati dalle righe che il backup riscrive.
  const rewritten = rows.filter((r) => {
    const id = rowId(r);
    return id !== null && liveIds.has(id);
  });
  const idsWith = (col: string): string[] => rewritten.filter((r) => col in r).map((r) => rowId(r)!);
  const freeSlugIds = idsWith('slug');
  if (freeSlugIds.length) {
    await tx`UPDATE public.calendars SET slug = 'restore-' || id::text WHERE id = ANY(${freeSlugIds}::uuid[])`;
  }
  const freeTokenIds = idsWith('ics_feed_token');
  if (freeTokenIds.length) {
    await tx`UPDATE public.calendars SET ics_feed_token = 'restore-' || id::text WHERE id = ANY(${freeTokenIds}::uuid[])`;
  }
  const freeNameIds = idsWith('collection_name');
  if (freeNameIds.length) {
    await tx`UPDATE public.calendars SET collection_name = NULL WHERE id = ANY(${freeNameIds}::uuid[])`;
  }
  const freeDefaultIds = idsWith('is_default');
  if (freeDefaultIds.length) {
    await tx`UPDATE public.calendars SET is_default = false WHERE id = ANY(${freeDefaultIds}::uuid[]) AND is_default`;
  }

  // 2. Righe assenti dal backup.
  const claimedSlugs = new Set(rows.map((r) => r.slug).filter((v): v is string => typeof v === 'string'));
  const claimedTokens = new Set(rows.map((r) => r.ics_feed_token).filter((v): v is string => typeof v === 'string'));
  const claimedNames = new Set<string>();
  for (const r of rows) {
    if ('collection_name' in r) {
      if (typeof r.collection_name === 'string') claimedNames.add(r.collection_name);
    } else {
      // Backup precedente alla 162: le righe nuove nascono senza nome e la
      // riconciliazione proverà a dar loro lo slug.
      const id = rowId(r);
      if ((id === null || !liveIds.has(id)) && typeof r.slug === 'string') claimedNames.add(r.slug);
    }
  }
  const backupHasDefault = rows.some((r) => r.is_default === true);

  const keptRows = live.filter((r) => !backupIds.has(r.id));
  const usedSlugs = new Set<string>([...claimedSlugs, ...keptRows.map((r) => r.slug)]);
  const kept: KeptCalendar[] = [];
  for (const k of keptRows) {
    const entry: KeptCalendar = { id: k.id, slug: k.slug };
    let slug = k.slug;
    if (claimedSlugs.has(k.slug)) {
      slug = freeSlug(k.slug, k.id, usedSlugs);
      usedSlugs.add(slug);
      entry.slug = slug;
      entry.previous_slug = k.slug;
    }
    let token = k.ics_feed_token;
    if (claimedTokens.has(token)) {
      token = generateFeedToken();
      entry.feed_token_regenerated = true;
    }
    let collectionName = k.collection_name;
    if (collectionName !== null && claimedNames.has(collectionName)) {
      entry.released_collection_name = collectionName;
      collectionName = null;
    }
    const isDefault = k.is_default && !backupHasDefault;
    const reason = k.needs_review && k.review_reason ? k.review_reason : MISSING_IN_BACKUP;
    await tx`
      UPDATE public.calendars
      SET slug = ${slug}, ics_feed_token = ${token}, collection_name = ${collectionName},
          is_default = ${isDefault}, needs_review = true, review_reason = ${reason},
          updated_at = now()
      WHERE id = ${k.id}::uuid
    `;
    kept.push(entry);
  }

  // 3. UPSERT.
  await insertRows(tx, target, rawRows, { upsertOnId: true });
  const updated = rewritten.length;
  return { inserted: rows.length - updated, updated, kept };
}

/**
 * Integrità referenziale delle FK che toccano il dominio calendario dopo il
 * caricamento con i trigger spenti (righe mantenute più righe del backup).
 * Una riga orfana vuol dire un backup incoerente: si annulla tutto.
 */
async function assertForeignKeys(tx: Tx, fks: readonly ForeignKeyRef[]): Promise<void> {
  for (const fk of fks) {
    const notNull = fk.childCols.map((c) => `c.${ident(c)} IS NOT NULL`).join(' AND ');
    const match = fk.childCols.map((c, i) => `p.${ident(fk.parentCols[i])} = c.${ident(c)}`).join(' AND ');
    const [{ n }] = await tx.unsafe(
      `SELECT count(*)::int AS n FROM ${qualified(fk.child)} c
       WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${qualified(fk.parent)} p WHERE ${match})`,
    ) as Array<{ n: number }>;
    if (n > 0) {
      throw new RestoreIntegrityError(
        `Backup incoerente: ${n} righe di ${fk.child} senza la riga referenziata in ${fk.parent} (${fk.name})`,
      );
    }
  }
}

/**
 * Riallinea le sequenze delle colonne serial/identity delle tabelle indicate
 * al massimo valore presente (1 e is_called=false se la tabella è vuota).
 */
async function resyncSequences(tx: Tx, tables: readonly string[]): Promise<void> {
  if (tables.length === 0) return;
  const sequences = await tx`
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
           pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname || '.' || c.relname = ANY(${[...tables]}::text[])
      AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  ` as Array<{ schema: string; table: string; column: string; seq: string }>;
  for (const s of sequences) {
    await tx.unsafe(
      `SELECT setval($1, GREATEST(m, 1), m > 0)
       FROM (SELECT COALESCE(MAX(${ident(s.column)}), 0)::bigint AS m FROM ${ident(s.schema)}.${ident(s.table)}) x`,
      [s.seq],
    );
  }
}

// ─── Import ──────────────────────────────────────────────────────────────────

const CALENDAR_SKIPPED_WARNING =
  'Calendari, eventi e iscrizioni NON sono stati ripristinati: il calendario è servito da Radicale ' +
  '(modalità «%MODE%»). Usa il ripristino coordinato (dump del database più snapshot del volume) ' +
  'o il ripristino da versioni.';

backup.post('/import', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  const confirm = (formData.get('confirm') as string | null) ?? '';

  if (confirm !== CONFIRM_TOKEN) {
    return c.json({ error: `Conferma mancante o errata. Digita "${CONFIRM_TOKEN}".` }, 400);
  }
  if (!file) return c.json({ error: 'Nessun file fornito' }, 400);

  const text = await file.text();
  let parsed: { version?: number; tables?: Record<string, unknown[]> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return c.json({ error: 'File non valido: JSON malformato' }, 400);
  }

  if (parsed.version !== BACKUP_VERSION) {
    return c.json({ error: `Versione backup non supportata: ${parsed.version}` }, 400);
  }
  if (!parsed.tables || typeof parsed.tables !== 'object' || Array.isArray(parsed.tables)) {
    return c.json({ error: 'Struttura backup non valida' }, 400);
  }
  const tablesPayload = parsed.tables;

  // 1) Auto-save a pre-restore snapshot of the current DB.
  mkdirSync(PRE_RESTORE_DIR, { recursive: true });
  const preRestoreName = `pre-restore-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  const preRestorePath = join(PRE_RESTORE_DIR, preRestoreName);
  try {
    const { snapshot: pre } = await buildSnapshot();
    writeFileSync(preRestorePath, JSON.stringify(pre));
  } catch (err) {
    return c.json({
      error: 'Impossibile creare il backup di sicurezza prima del ripristino',
      detail: (err as Error).message,
    }, 500);
  }

  // 2) Validate target tables exist before mutating anything.
  const liveTables = await listTables();
  const liveKeys = liveTables.map(tableKey);
  // Backup creati prima del fix contengono anche le partizioni di analytics:
  // le loro righe sono già nel padre, quindi si ignorano.
  const partitionKeys = await listPartitionKeys();
  const incoming = Object.keys(tablesPayload).filter((k) => !partitionKeys.has(k));
  // Il gruppo S non conta: non viene mai ripristinato, quindi non serve che esista.
  const unknownTables = incoming.filter((k) => backupGroup(k) !== 'state' && !liveKeys.includes(k));
  if (unknownTables.length > 0) {
    return c.json({
      error: 'Il backup contiene tabelle non presenti nel database corrente. Esegui prima le migrazioni.',
      unknown: unknownTables,
      preRestoreBackup: preRestoreName,
    }, 400);
  }

  // 3) Restore inside a transaction with FK triggers disabled.
  const stats = { tablesRestored: 0, rowsInserted: 0, tablesSkipped: 0 };
  const rowsOf = (key: string): Record<string, unknown>[] => {
    const rows = tablesPayload[key];
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  };

  let result: {
    plan: RestorePlan;
    backend: CalendarBackendSummary;
    calendars: CalendarRestoreReport | null;
    reconciled: Array<{ calendar_id: string; field: string; old_value: string | null; new_value: string | null }>;
  };

  try {
    result = await sql.begin(async (tx: Tx) => {
      // Lo stato si legge (e si blocca) prima di toccare qualsiasi dato: decide
      // se il dominio calendario si ripristina.
      const backendRead = await readCalendarBackend(tx, { forUpdate: true });
      const restoreCalendar = calendarRestorable(backendRead);
      const foreignKeys = await listForeignKeys(tx);
      const plan = planRestore({ liveTables: liveKeys, backupTables: incoming, restoreCalendar, foreignKeys });
      if (plan.blocked.length > 0) {
        throw new RestorePlanError(
          'Ripristino non eseguibile: tabelle che il ripristino non può toccare referenziano tabelle da svuotare.',
          plan.blocked,
        );
      }

      await tx.unsafe(`SET LOCAL session_replication_role = 'replica'`);

      // Senza CASCADE: l'insieme è già chiuso rispetto alle FK (planRestore), e
      // un CASCADE raggiungerebbe calendars, indice, id e stato.
      if (plan.truncate.length > 0) {
        await tx.unsafe(`TRUNCATE ${plan.truncate.map(qualified).join(', ')} RESTART IDENTITY`);
      }

      // DBX-02: fetch all column metadata once, not per table inside the loop.
      const columnsByTable = await getAllColumns(tx);
      const targetOf = (key: string): InsertTarget => {
        const dot = key.indexOf('.');
        const cols = columnsByTable.get(key) ?? [];
        return { schema: key.slice(0, dot), table: key.slice(dot + 1), writable: cols.filter((col) => col.is_generated !== 'ALWAYS') };
      };

      let calendars: CalendarRestoreReport | null = null;
      if (plan.upsertCalendars) {
        calendars = await upsertCalendars(tx, targetOf(CALENDARS_KEY), rowsOf(CALENDARS_KEY));
        stats.rowsInserted += calendars.inserted + calendars.updated;
        if (calendars.inserted + calendars.updated > 0) stats.tablesRestored++;
        else stats.tablesSkipped++;
      }

      for (const key of plan.insert) {
        const rows = rowsOf(key);
        if (rows.length === 0) {
          stats.tablesSkipped++;
          continue;
        }
        stats.rowsInserted += await insertRows(tx, targetOf(key), rows);
        stats.tablesRestored++;
      }

      // insertRows lascia il search_path sullo schema dell'ultima tabella (anche
      // 'auth'): la riconciliazione della 162 risolve calendars tramite il
      // search_path, quindi si torna al default prima dei passi successivi.
      await tx.unsafe(`SET LOCAL search_path TO DEFAULT`);

      if (restoreCalendar) {
        const restoredCalendarTables = new Set(
          [...plan.insert, ...plan.emptied, ...(plan.upsertCalendars ? [CALENDARS_KEY] : [])]
            .filter((k) => backupGroup(k) === 'calendar'),
        );
        await assertForeignKeys(
          tx,
          foreignKeys.filter((fk) => restoredCalendarTables.has(fk.child) || restoredCalendarTables.has(fk.parent)),
        );
      }

      // 4) Resync sequences for identity/serial columns, solo delle tabelle
      //    riscritte: quelle saltate (gruppo S compreso) restano come sono.
      await resyncSequences(tx, [...plan.truncate, ...(plan.upsertCalendars ? [CALENDARS_KEY] : [])]);

      // 5) Dopo l'import (design §16.2), con i trigger di nuovo attivi: la
      //    riconciliazione passa dall'audit, il trigger della 162 incrementa
      //    policy_version e il NOTIFY fa riscrivere subito la policy.
      await tx.unsafe(`SET LOCAL session_replication_role = 'origin'`);

      let reconciled: Array<{ calendar_id: string; field: string; old_value: string | null; new_value: string | null }> = [];
      let backend = summarizeBackend(backendRead);
      if (backendRead.kind !== 'absent') {
        if (restoreCalendar) {
          // Righe nuove senza sidecar (backup precedente alla 162, trigger
          // BEFORE INSERT spento): nome della collezione, ruolo dalla dead
          // prop o dalle regole storiche, origine dei calendari di sistema.
          const changes = await tx`
            SELECT calendar_id::text AS calendar_id, field, old_value, new_value
            FROM public.calendar_sidecar_reconcile()
          `;
          reconciled = Array.from(changes as Iterable<typeof reconciled[number]>, (r) => ({ ...r }));
          // L'UPSERT con i trigger spenti non ha emesso il NOTIFY del sidecar.
          await tx`SELECT pg_notify('calendar_policy_changed', ${JSON.stringify({ source: 'sidecar' })})`;
        }
        // Guardia post-ripristino in ogni modalità: indice e verifica da
        // rifare, nessuna cancellazione automatica e policy frozen per 48 h.
        // Con lo shadow attivo (F3) qui va anche il plan dry-run del ledger, e
        // un ripristino di calendar_bookings avvia la riconciliazione delle
        // proiezioni in sola lettura (F3).
        const updated = await tx`
          UPDATE public.calendar_backend_state
          SET rebuild_required = true,
              restore_guard_until = GREATEST(
                COALESCE(restore_guard_until, now()),
                now() + make_interval(hours => ${RESTORE_GUARD_HOURS})
              )
          WHERE id = true
          RETURNING mode, write_freeze, volume_id, epoch, credential_epoch, policy_version,
                    restore_guard_until, rebuild_required
        `;
        if (updated.length === 1) {
          try {
            backend = summarizeBackend({ kind: 'ok', state: normalizeBackendState(updated[0] as Record<string, unknown>) });
          } catch {
            /* stato fuori contratto: resta il riassunto letto prima */
          }
        }
      }

      return { plan, backend, calendars, reconciled };
    });
  } catch (err) {
    if (err instanceof RestorePlanError) {
      return c.json({
        error: `${err.message} Il database NON è stato modificato.`,
        blocked: err.details,
        preRestoreBackup: preRestoreName,
      }, 409);
    }
    return c.json({
      error: 'Ripristino fallito. Il database NON è stato modificato (transazione annullata).',
      detail: (err as Error).message,
      preRestoreBackup: preRestoreName,
    }, 500);
  }

  const { plan, backend, calendars, reconciled } = result;
  const warnings: string[] = [];
  if (plan.skippedCalendar.length > 0) {
    warnings.push(
      backend.status === 'unreadable'
        ? 'Calendari, eventi e iscrizioni NON sono stati ripristinati: lo stato del backend calendario è illeggibile.'
        : CALENDAR_SKIPPED_WARNING.replace('%MODE%', backend.mode ?? 'sconosciuta'),
    );
  }
  if (calendars && calendars.kept.length > 0) {
    const n = calendars.kept.length;
    warnings.push(
      `${n === 1 ? 'Un calendario assente dal backup è stato mantenuto e segnalato' : `${n} calendari assenti dal backup sono stati mantenuti e segnalati`} ` +
        'da rivedere' +
        (plan.insert.includes('public.calendar_events')
          ? `: ${n === 1 ? 'resta vuoto perché gli eventi sono' : 'restano vuoti perché gli eventi sono'} quelli del backup.`
          : '.'),
    );
  }

  const calendarReport = {
    ...backend,
    restored: plan.upsertCalendars || plan.insert.some((k) => backupGroup(k) === 'calendar'),
    inserted: calendars?.inserted ?? 0,
    updated: calendars?.updated ?? 0,
    kept: calendars?.kept ?? [],
    reconciled,
  };
  const skipped = { state: plan.skippedState, calendar: plan.skippedCalendar };

  // 5) Audit (outside tx so it survives even if tx rolled back — but here it committed).
  const user = c.get('user');
  await sql`
    INSERT INTO audit_logs (
      user_email, user_role, action, table_name, metadata
    ) VALUES (
      ${user?.email ?? null}, ${user?.role ?? null},
      'IMPORT', 'backup',
      ${sqlv({
        source: 'api/backup',
        preRestoreBackup: preRestoreName,
        ...stats,
        skipped,
        emptied: plan.emptied,
        calendar: {
          mode: calendarReport.mode,
          restored: calendarReport.restored,
          inserted: calendarReport.inserted,
          updated: calendarReport.updated,
          kept: calendarReport.kept,
          reconciled: calendarReport.reconciled.length,
          restore_guard_until: calendarReport.restore_guard_until,
        },
      })}
    )
  `;

  return c.json({
    success: true,
    stats,
    preRestoreBackup: preRestoreName,
    skipped,
    emptied: plan.emptied,
    calendar: calendarReport,
    warnings,
  });
});
