/**
 * Headful capture worker (Fase 3) — apps/worker.
 *
 * Polls the `capture_sessions` table for work and drives a headful Chromium
 * session per project, exposed to the admin via noVNC so the operator can
 * log in / navigate manually on sites behind auth. The persistent Chrome
 * profile (`userDataDir` per project) survives across sessions, so later
 * headless captures can reuse the login (see captureSiteAuthenticated in
 * apps/api/src/lib/capture.ts).
 *
 * Flow (one row drives the whole lifecycle through `status`):
 *
 *   pending         → worker launches Chromium (headful on :99) + x11vnc +
 *                     websockify(novnc), navigates to target_url, sets
 *                     status='open' + vnc_url.
 *   open            → admin opens vnc_url, logs in, navigates. Idle.
 *   snap_requested  → admin asked for a screenshot at the current scroll /
 *                     viewport. Worker shoots webp, writes to the shared
 *                     uploads volume, sets status='snap_done' + last_capture_url.
 *   snap_done       → admin previews the webp, pushes to gallery, then closes.
 *   close_requested → admin closed. Worker tears down Chromium + VNC, persists
 *                     the profile, sets status='closed'.
 *
 * The worker talks only to Postgres (no HTTP of its own) + the X display.
 * Concurrency is capped (default 1 — this is an admin manual tool, not a
 * farm). Stale `open` sessions past SESSION_TTL are force-closed as a safety
 * net. See apps/worker/README.md for the architecture.
 */
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import puppeteer, { type Browser } from 'puppeteer';
import { logger } from './lib/log';
import { saveCapture } from './lib/storage';

const log = logger.child({ scope: 'worker' });

// --- env -----------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}
const POLL_MS = Number(process.env.CAPTURE_WORKER_POLL_MS || 2000);
const MAX_CONCURRENCY = Number(process.env.CAPTURE_WORKER_CONCURRENCY || 1);
const SESSION_TTL_MS = Number(process.env.CAPTURE_SESSION_TTL_MS || 30 * 60 * 1000);
const VNC_PORT = String(process.env.CAPTURE_WORKER_VNC_PORT || '6080');
const VNC_BASE_URL = process.env.CAPTURE_VNC_BASE_URL || `http://localhost:${VNC_PORT}`;
const PROFILES_DIR = process.env.CAPTURE_PROFILES_DIR || '/data/profiles';
const DISPLAY = process.env.DISPLAY || ':99';
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
// noVNC web assets served by websockify. Debian's `novnc` package installs here.
const NOVNC_WEB = process.env.NOVNC_WEB_DIR || '/usr/share/novnc';

mkdirSync(PROFILES_DIR, { recursive: true });

const sql = postgres(DATABASE_URL, { max: 3, onnotice: () => {} });

interface SessionRow {
  id: string;
  project_id: string;
  status: string;
  target_url: string | null;
  profile_dir: string;
  viewport_width: number | null;
  viewport_height: number | null;
  scroll_y: number | null;
}

interface ActiveSession {
  row: SessionRow;
  browser: Browser;
  vnc: ChildProcess | null;
  web: ChildProcess | null;
  openedAt: number;
}

const active = new Map<string, ActiveSession>();
let shuttingDown = false;

// --- subprocess helpers --------------------------------------------------

function killProc(p: ChildProcess | null): void {
  if (!p || p.exitCode !== null) return;
  try {
    p.kill('SIGTERM');
    setTimeout(() => {
      if (p.exitCode === null) {
        try { p.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 1500);
  } catch { /* noop */ }
}

/** Start x11vnc attached to the worker's Xvfb display. */
function startVnc(): ChildProcess | null {
  try {
    const p = spawn(
      'x11vnc',
      ['-display', DISPLAY, '-rfbport', '5900', '-forever', '-shared', '-nopw', '-bg', '-o', '/dev/stdout'],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    p.on('error', (e) => log.warn({ err: e }, 'x11vnc failed to start'));
    return p;
  } catch (e) {
    log.warn({ err: e }, 'x11vnc spawn failed');
    return null;
  }
}

/** Start websockify serving the noVNC web client on VNC_PORT → localhost:5900. */
function startWebsockify(): ChildProcess | null {
  try {
    const p = spawn(
      'websockify',
      ['--web', NOVNC_WEB, VNC_PORT, 'localhost:5900'],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    p.on('error', (e) => log.warn({ err: e }, 'websockify failed to start'));
    p.on('exit', (code) => log.info({ code }, 'websockify exited'));
    return p;
  } catch (e) {
    log.warn({ err: e }, 'websockify spawn failed');
    return null;
  }
}

// --- session lifecycle ---------------------------------------------------

async function openSession(row: SessionRow): Promise<void> {
  const profileDir = join(PROFILES_DIR, row.project_id);
  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      executablePath: CHROMIUM_PATH,
      userDataDir: profileDir,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        `--display=${DISPLAY}`,
        '--start-maximized',
        '--window-size=1280,900',
      ],
    });
  } catch (e) {
    log.error({ err: e, id: row.id }, 'chromium launch failed');
    await markError(row.id, e);
    return;
  }

  try {
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    if (row.target_url) {
      try {
        await page.goto(row.target_url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      } catch (e) {
        // Non-fatal: the admin can navigate manually in the VNC window.
        log.warn({ err: e, id: row.id, url: row.target_url }, 'initial goto failed (admin can navigate manually)');
      }
    }

    // VNC stack — single shared display, so only start it if not already up.
    let vnc: ChildProcess | null = null;
    let web: ChildProcess | null = null;
    if (!hasVncRunning()) {
      vnc = startVnc();
      web = startWebsockify();
    } else {
      log.debug({ id: row.id }, 'vnc stack already running — reusing');
    }

    const vncUrl = `${VNC_BASE_URL}/vnc.html?autoconnect=1&resize=scale`;
    await sql`
      UPDATE capture_sessions
      SET status = 'open', vnc_url = ${vncUrl}, updated_at = NOW()
      WHERE id = ${row.id}
    `;

    active.set(row.id, { row, browser, vnc, web, openedAt: Date.now() });
    log.info({ id: row.id, project_id: row.project_id, vnc_url: vncUrl }, 'session open');
  } catch (e) {
    try { await browser.close(); } catch { /* noop */ }
    log.error({ err: e, id: row.id }, 'openSession failed');
    await markError(row.id, e);
  }
}

function hasVncRunning(): boolean {
  for (const s of active.values()) {
    if (s.web && s.web.exitCode === null) return true;
  }
  return false;
}

async function snapSession(row: SessionRow): Promise<void> {
  const s = active.get(row.id);
  if (!s) {
    // No live browser (e.g. worker restarted). Let the admin reopen.
    log.warn({ id: row.id }, 'snap requested but no active browser — resetting to open');
    await sql`UPDATE capture_sessions SET status = 'open', updated_at = NOW() WHERE id = ${row.id}`;
    return;
  }
  try {
    const pages = await s.browser.pages();
    const page = pages[0];
    if (!page) throw new Error('nessuna pagina aperta nel browser');

    const vw = row.viewport_width ?? undefined;
    const vh = row.viewport_height ?? undefined;
    if (vw && vh) {
      await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 2 });
    }
    if (row.scroll_y && row.scroll_y > 0) {
      await page.evaluate((y) => window.scrollTo(0, y), row.scroll_y);
    }
    await new Promise((r) => setTimeout(r, 600)); // settle lazy content

    const isClip = !!(vw && vh);
    const buffer = (await page.screenshot({
      type: 'webp',
      quality: 90,
      ...(isClip ? { clip: { x: 0, y: 0, width: vw!, height: vh! } } : { fullPage: true }),
    })) as Buffer;

    const [proj] = await sql`SELECT slug FROM projects WHERE id = ${row.project_id}`;
    const slug = (proj?.slug as string) || `project-${row.project_id}`;
    const label = 'headful';
    const { url, key } = await saveCapture(buffer, slug, label);

    await sql`
      UPDATE capture_sessions
      SET status = 'snap_done', last_capture_url = ${url}, updated_at = NOW()
      WHERE id = ${row.id}
    `;
    log.info({ id: row.id, url, key }, 'snap done');
  } catch (e) {
    log.error({ err: e, id: row.id }, 'snap failed');
    await sql`
      UPDATE capture_sessions
      SET status = 'open', last_error = ${e instanceof Error ? e.message : String(e)}, updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }
}

async function closeSession(row: SessionRow): Promise<void> {
  const s = active.get(row.id);
  if (s) await teardown(s);
  try {
    await sql`UPDATE capture_sessions SET status = 'closed', updated_at = NOW() WHERE id = ${row.id}`;
    log.info({ id: row.id }, 'session closed');
  } catch (e) {
    log.warn({ err: e, id: row.id }, 'failed to mark closed');
  }
}

async function teardown(s: ActiveSession): Promise<void> {
  active.delete(s.row.id);
  try { await s.browser.close(); } catch { /* noop */ }
  // Only stop the VNC stack if no other session is still using it.
  if (!hasVncRunning()) {
    killProc(s.vnc);
    killProc(s.web);
  }
}

async function markError(id: string, e: unknown): Promise<void> {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    await sql`UPDATE capture_sessions SET status = 'error', last_error = ${msg}, updated_at = NOW() WHERE id = ${id}`;
  } catch { /* noop */ }
}

// --- poll loop -----------------------------------------------------------

async function tick(): Promise<void> {
  // 1. Drift reconciliation: drop/close sessions whose DB row disappeared or
  //    was externally closed, and force-close overstayed sessions.
  await reconcileActive();

  // 2. Pick up control transitions (snap/close) for sessions we hold.
  const activeIds = [...active.keys()];
  if (activeIds.length) {
    const controls = await sql`
      SELECT * FROM capture_sessions
      WHERE id = ANY(${activeIds}::uuid[])
        AND status IN ('snap_requested', 'close_requested', 'closed', 'error')
    ` as SessionRow[];
    for (const r of controls) {
      if (r.status === 'snap_requested') await snapSession(r);
      else if (r.status === 'close_requested') await closeSession(r);
      else { // closed/error set externally (admin or stale janitor) → teardown
        const s = active.get(r.id);
        if (s) await teardown(s);
      }
    }
  }

  // 3. Open new pending sessions up to the concurrency cap.
  if (active.size < MAX_CONCURRENCY) {
    const pending = await sql`
      SELECT * FROM capture_sessions
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ${MAX_CONCURRENCY - active.size}
    ` as SessionRow[];
    for (const r of pending) await openSession(r);
  }
}

async function reconcileActive(): Promise<void> {
  for (const [id, s] of [...active]) {
    const [row] = await sql`SELECT status, updated_at FROM capture_sessions WHERE id = ${id}` as
      { status: string; updated_at: string }[];
    if (!row) {
      // Row deleted (project cascaded) → teardown silently.
      await teardown(s);
      continue;
    }
    if (row.status === 'closed' || row.status === 'error') {
      await teardown(s);
      continue;
    }
    // Stale `open` session with no admin interaction for TTL → force close so
    // the browser/vnc stack doesn't sit open forever if the admin dropped.
    const idleMs = Date.now() - new Date(row.updated_at).getTime();
    if (idleMs > SESSION_TTL_MS) {
      log.warn({ id, idle_ms: idleMs }, 'stale session — force closing');
      await closeSession(s.row);
    }
  }
}

async function loop(): Promise<void> {
  if (shuttingDown) return;
  try {
    await tick();
  } catch (e) {
    log.error({ err: e }, 'tick failed');
  }
  setTimeout(loop, POLL_MS);
}

// --- graceful shutdown ---------------------------------------------------

async function shutdown(): Promise<void> {
  shuttingDown = true;
  log.info('shutting down — closing active sessions');
  for (const r of active.values()) {
    try { await r.browser.close(); } catch { /* noop */ }
    killProc(r.vnc);
    killProc(r.web);
    try {
      await sql`UPDATE capture_sessions SET status = 'closed', updated_at = NOW() WHERE id = ${r.row.id}`;
    } catch { /* noop */ }
  }
  active.clear();
  try { await sql.end(); } catch { /* noop */ }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

log.info(
  { poll_ms: POLL_MS, concurrency: MAX_CONCURRENCY, profiles: PROFILES_DIR, vnc_base: VNC_BASE_URL, display: DISPLAY },
  'headful capture worker starting',
);
void loop();