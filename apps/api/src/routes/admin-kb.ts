import { Hono } from 'hono';
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { bootstrapKBs, readKbMetadata, KB_DIR } from '../lib/agent/kb-bootstrap';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'admin-kb' });

export const adminKb = new Hono();

// Soft cap to avoid runaway uploads. KB files are usually <100 KB.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_EXTENSION = '.md';

interface KbFileInfo {
  name: string;
  size_bytes: number;
  modified: string;
  is_private: boolean;
}

function listKbFiles(): KbFileInfo[] {
  try {
    return readdirSync(KB_DIR)
      .filter((name) => name.endsWith('.md') && !name.endsWith('.example.md'))
      .map((name) => {
        const stat = statSync(resolve(KB_DIR, name));
        return {
          name,
          size_bytes: stat.size,
          modified: new Date(stat.mtimeMs).toISOString(),
          is_private: name.endsWith('_private.md'),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function isS4Configured(): boolean {
  return Boolean(
    process.env.S4_ENDPOINT &&
      process.env.S4_BUCKET &&
      process.env.S4_ACCESS_KEY_ID &&
      process.env.S4_SECRET_ACCESS_KEY,
  );
}

/** Sanitize filename to prevent path traversal — strict allowlist. */
function sanitizeFilename(raw: string): string | null {
  if (!raw) return null;
  // Allow letters, digits, dash, underscore, dot. No slashes, no relative bits.
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) return null;
  if (raw.startsWith('.')) return null;
  if (!raw.endsWith(ALLOWED_EXTENSION)) return null;
  if (raw.length > 100) return null;
  return raw;
}

// GET /api/admin/kb/status — combined status + files for the admin page.
adminKb.get('/status', (c) => {
  const meta = readKbMetadata();
  return c.json({
    s4_configured: isS4Configured(),
    metadata: meta,
    files: listKbFiles(),
    kb_dir: KB_DIR,
  });
});

// POST /api/admin/kb/import — re-runs bootstrapKBs() and reports the outcome.
adminKb.post('/import', async (c) => {
  if (!isS4Configured()) {
    return c.json(
      {
        error: 'S4 non configurato',
        detail:
          'Le variabili S4_ENDPOINT / S4_BUCKET / S4_ACCESS_KEY_ID / S4_SECRET_ACCESS_KEY ' +
          'devono essere settate nel container per usare l\'import da S4.',
      },
      400,
    );
  }

  try {
    await bootstrapKBs();
    const meta = readKbMetadata();
    log.info({ files: meta.file_count }, 'KB re-imported from S4 via admin');
    return c.json({
      success: true,
      metadata: meta,
      files: listKbFiles(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'KB import from S4 failed');
    return c.json({ error: 'Import fallito', detail: message }, 500);
  }
});

// POST /api/admin/kb/upload — multipart .md upload, writes into KB_DIR.
adminKb.post('/upload', async (c) => {
  try {
    mkdirSync(KB_DIR, { recursive: true });
  } catch {
    return c.json({ error: 'KB_DIR non scrivibile' }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ error: 'Upload non valido' }, 400);
  }

  const raw = body['file'];
  const file = Array.isArray(raw) ? raw[0] : raw;
  if (!(file instanceof File)) {
    return c.json({ error: 'Campo "file" mancante o non valido' }, 400);
  }

  const name = sanitizeFilename(file.name);
  if (!name) {
    return c.json(
      {
        error: 'Nome file non valido',
        detail: 'Ammessi solo A-Z, a-z, 0-9, ".", "_", "-" e estensione .md',
      },
      400,
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: `File troppo grande (max ${MAX_UPLOAD_BYTES} bytes)` },
      400,
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // Basic content sanity check: must look like UTF-8 text.
  let text: string;
  try {
    text = buf.toString('utf-8');
  } catch {
    return c.json({ error: 'Contenuto non UTF-8' }, 400);
  }

  try {
    writeFileSync(resolve(KB_DIR, name), text, 'utf-8');
    log.info({ name, size: file.size }, 'KB file uploaded via admin');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, name }, 'KB upload write failed');
    return c.json({ error: 'Scrittura fallita', detail: message }, 500);
  }

  return c.json({
    success: true,
    file: {
      name,
      size_bytes: file.size,
    },
    files: listKbFiles(),
  });
});

// DELETE /api/admin/kb/files/:name — remove a single .md from KB_DIR.
adminKb.delete('/files/:name', (c) => {
  const raw = c.req.param('name');
  const name = sanitizeFilename(raw);
  if (!name) {
    return c.json({ error: 'Nome file non valido' }, 400);
  }

  try {
    unlinkSync(resolve(KB_DIR, name));
    log.info({ name }, 'KB file deleted via admin');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ENOENT')) {
      return c.json({ error: 'File non trovato' }, 404);
    }
    log.error({ err: message, name }, 'KB delete failed');
    return c.json({ error: 'Cancellazione fallita', detail: message }, 500);
  }

  return c.json({ success: true, files: listKbFiles() });
});

// GET /api/admin/kb/files/:name — download/preview a single .md.
adminKb.get('/files/:name', (c) => {
  const raw = c.req.param('name');
  const name = sanitizeFilename(raw);
  if (!name) {
    return c.json({ error: 'Nome file non valido' }, 400);
  }

  try {
    const content = readFileSync(resolve(KB_DIR, name), 'utf-8');
    return c.text(content, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  } catch {
    return c.json({ error: 'File non trovato' }, 404);
  }
});
