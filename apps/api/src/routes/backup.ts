import { Hono } from 'hono';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sql, sqlv } from '../db';

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

async function listTables(): Promise<TableRef[]> {
  const rows = await sql`
    SELECT table_schema AS schema, table_name AS table
    FROM information_schema.tables
    WHERE table_schema = ANY(${[...ALLOWED_SCHEMAS] as unknown as string[]})
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name
  ` as unknown as TableRef[];
  return rows;
}

async function getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
  const rows = await sql`
    SELECT column_name, data_type, udt_name, is_generated, is_identity
    FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table}
    ORDER BY ordinal_position
  ` as unknown as ColumnInfo[];
  return rows;
}

async function buildSnapshot() {
  const tables = await listTables();
  const data: Record<string, unknown[]> = {};
  let totalRows = 0;

  for (const t of tables) {
    const cols = await getColumns(t.schema, t.table);
    const writable = cols.filter((c) => c.is_generated !== 'ALWAYS');
    if (writable.length === 0) {
      data[`${t.schema}.${t.table}`] = [];
      continue;
    }
    const colList = writable.map((c) => `"${c.column_name.replace(/"/g, '""')}"`).join(', ');
    const rows = await sql.unsafe(
      `SELECT ${colList} FROM "${t.schema}"."${t.table}"`
    ) as unknown as Record<string, unknown>[];
    data[`${t.schema}.${t.table}`] = rows;
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
  const stats = await Promise.all(
    tables.map(async (t) => {
      const res = await sql.unsafe(
        `SELECT COUNT(*)::int AS count FROM "${t.schema}"."${t.table}"`
      ) as unknown as Array<{ count: number }>;
      return { schema: t.schema, table: t.table, rows: res[0]?.count ?? 0 };
    })
  );
  const totalRows = stats.reduce((acc, t) => acc + t.rows, 0);
  return c.json({ version: BACKUP_VERSION, tableCount: tables.length, totalRows, tables: stats });
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
  if (!parsed.tables || typeof parsed.tables !== 'object') {
    return c.json({ error: 'Struttura backup non valida' }, 400);
  }

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
  const liveKey = (t: TableRef) => `${t.schema}.${t.table}`;
  const liveSet = new Set(liveTables.map(liveKey));
  const incoming = Object.keys(parsed.tables);
  const unknownTables = incoming.filter((k) => !liveSet.has(k));
  if (unknownTables.length > 0) {
    return c.json({
      error: 'Il backup contiene tabelle non presenti nel database corrente. Esegui prima le migrazioni.',
      unknown: unknownTables,
      preRestoreBackup: preRestoreName,
    }, 400);
  }

  // 3) Restore inside a transaction with FK triggers disabled.
  const stats = { tablesRestored: 0, rowsInserted: 0, tablesSkipped: 0 };
  const tablesPayload = parsed.tables;
  const targetTables = liveTables.filter((t) => liveKey(t) in tablesPayload);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sql.begin(async (tx: any) => {
      await tx.unsafe(`SET LOCAL session_replication_role = 'replica'`);

      const truncateList = targetTables
        .map((t) => `"${t.schema}"."${t.table}"`)
        .join(', ');
      await tx.unsafe(`TRUNCATE ${truncateList} RESTART IDENTITY CASCADE`);

      for (const t of targetTables) {
        const cols = await getColumns(t.schema, t.table);
        const writable = cols.filter((c) => c.is_generated !== 'ALWAYS');
        const writableNames = new Set(writable.map((c) => c.column_name));
        const jsonCols = new Set(
          writable
            .filter((c) => c.data_type === 'jsonb' || c.data_type === 'json')
            .map((c) => c.column_name)
        );

        const rows = tablesPayload[liveKey(t)] as Record<string, unknown>[];
        if (!rows || rows.length === 0) {
          stats.tablesSkipped++;
          continue;
        }

        await tx.unsafe(`SET LOCAL search_path TO "${t.schema}"`);

        for (const raw of rows) {
          const obj: Record<string, unknown> = {};
          for (const col of writable) {
            if (!(col.column_name in raw)) continue;
            let value = raw[col.column_name];
            // JSONB/JSON: pass objects through (postgres.js will encode).
            // For arrays/scalars destined to jsonb columns, JSON.stringify
            // to avoid being interpreted as PG arrays.
            if (jsonCols.has(col.column_name) && value !== null && value !== undefined) {
              if (typeof value !== 'string') {
                value = JSON.stringify(value);
              }
            }
            obj[col.column_name] = value;
          }
          const cleaned = Object.keys(obj).filter((k) => writableNames.has(k));
          if (cleaned.length === 0) continue;
          await tx`INSERT INTO ${tx(t.table)} ${tx(obj, ...cleaned)}`;
          stats.rowsInserted++;
        }
        stats.tablesRestored++;
      }

      // 4) Resync sequences for identity/serial columns.
      await tx.unsafe(`
        DO $$
        DECLARE
          r RECORD;
          v_seq TEXT;
          v_max BIGINT;
        BEGIN
          FOR r IN
            SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public', 'auth')
              AND a.attnum > 0 AND NOT a.attisdropped
              AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
          LOOP
            v_seq := pg_get_serial_sequence(format('%I.%I', r.schema, r.table), r.column);
            EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %I.%I', r.column, r.schema, r.table)
              INTO v_max;
            PERFORM setval(v_seq, GREATEST(v_max, 1), v_max > 0);
          END LOOP;
        END $$;
      `);
    });
  } catch (err) {
    return c.json({
      error: 'Ripristino fallito. Il database NON è stato modificato (transazione annullata).',
      detail: (err as Error).message,
      preRestoreBackup: preRestoreName,
    }, 500);
  }

  // 5) Audit (outside tx so it survives even if tx rolled back — but here it committed).
  const user = c.get('user');
  await sql`
    INSERT INTO audit_logs (
      user_email, user_role, action, table_name, metadata
    ) VALUES (
      ${user?.email ?? null}, ${user?.role ?? null},
      'IMPORT', 'backup',
      ${sqlv({ source: 'api/backup', preRestoreBackup: preRestoreName, ...stats })}
    )
  `;

  return c.json({ success: true, stats, preRestoreBackup: preRestoreName });
});
