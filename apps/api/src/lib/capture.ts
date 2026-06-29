/**
 * Headless screenshot capture for portfolio case studies.
 *
 * Replaces the one-off `apps/api/scripts/capture-pooltech.mjs` with a
 * reusable library invoked by `POST /api/projects/:id/capture`. Supports
 * two sources:
 *
 *   - `live`    — navigates to the project `live_url` and shoots hero
 *                 desktop (1920×1080), hero mobile (390×844), fullpage
 *                 desktop (1440×900 with lazy-load scroll trigger).
 *   - `archive` — resolves the closest Wayback Machine snapshot for the
 *                 target URL via `archive.org/wayback/available`, then
 *                 navigates to the `id_` form of the snapshot (which
 *                 returns the raw archived HTML without the Wayback
 *                 toolbar/wrapper) and shoots the same viewports.
 *
 * Output is uploaded via `lib/s3.uploadFile` so it lands in the same
 * `/media/...` namespace used by the rest of the admin media library.
 *
 * Headful capture for login-protected sites is intentionally NOT here —
 * that lives in a separate worker (planned: `apps/worker` with xvfb).
 * See `<repo>/apps/worker/README.md` (to be created in Fase 3).
 */
import puppeteer, { type Browser } from 'puppeteer';
import { uploadFile, generateFileKey } from './s3';
import { logger } from './logger';

const log = logger.child({ scope: 'capture' });

export type CaptureSource = 'live' | 'archive';
export type CaptureViewport = 'desktop' | 'mobile' | 'fullpage';

export interface CaptureResult {
  /** Which viewport shot this is. */
  kind: CaptureViewport;
  /** Public URL of the uploaded webp. */
  url: string;
  /** Storage key (relative to UPLOAD_DIR). */
  key: string;
  width: number;
  height: number;
  /** Where the screenshot was taken from. */
  source: CaptureSource;
  /** For `archive` source: the Wayback snapshot timestamp (YYYYMMDDhhmmss). */
  archiveTimestamp?: string;
  /** For `archive` source: the resolved Wayback URL used for navigation. */
  archiveUrl?: string;
}

export interface CaptureOptions {
  /** Target URL to capture. For `archive` mode this is the original site URL. */
  url: string;
  /** Storage folder under UPLOAD_DIR (e.g. `projects/<slug>`). */
  folder: string;
  /** Base filename slug (used for the webp naming). */
  slug: string;
  source?: CaptureSource;
  /** Optional Wayback timestamp to pin the snapshot (YYYYMMDD or YYYYMMDDhhmmss). */
  archiveDate?: string;
  /** Viewports to shoot. Defaults to all three. */
  viewports?: CaptureViewport[];
  /** Fase 3: reuse a previously logged-in Chrome profile (created by the
   *  headful worker). Pass the same per-project `userDataDir` the worker used. */
  profileDir?: string;
  /** Fase 3: launch headful (worker only). The API always runs headless. */
  headless?: boolean;
}

interface WaybackSnapshot {
  archiveUrl: string;
  timestamp: string;
  originalUrl: string;
}

const VIEWPORTS: Record<CaptureViewport, { width: number; height: number; deviceScaleFactor: number }> = {
  desktop: { width: 1920, height: 1080, deviceScaleFactor: 2 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3 },
  fullpage: { width: 1440, height: 900, deviceScaleFactor: 2 },
};

/**
 * Resolve the closest Wayback Machine snapshot for a URL.
 *
 * Uses the public `archive.org/wayback/available` JSON API. The returned
 * `archiveUrl` uses the `id_` modifier (`https://web.archive.org/web/<ts>id_/<url>`)
 * which serves the raw archived HTML with no Wayback toolbar — clean for
 * screenshots.
 *
 * @throws if no snapshot is available for the URL.
 */
export async function resolveWaybackSnapshot(
  targetUrl: string,
  archiveDate?: string,
): Promise<WaybackSnapshot> {
  const params = new URLSearchParams({ url: targetUrl });
  if (archiveDate) params.set('timestamp', archiveDate);
  const api = `https://archive.org/wayback/available?${params.toString()}`;

  const res = await fetch(api, {
    headers: { 'User-Agent': 'calicchia-portfolio-capture/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Wayback API HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    archived_snapshots?: {
      closest?: { available: boolean; url: string; timestamp: string; status?: string };
    };
  };
  const closest = data.archived_snapshots?.closest;
  if (!closest?.available || !closest.url) {
    throw new Error(`Nessuno snapshot Wayback disponibile per ${targetUrl}`);
  }

  // Rewrite the snapshot URL to the `id_` form so we get the raw archived
  // page without the Wayback toolbar/wrapper. The canonical URL shape is:
  //   https://web.archive.org/web/<timestamp>/<original>
  // The `id_` modifier goes between timestamp and original:
  //   https://web.archive.org/web/<timestamp>id_/<original>
  const ts = closest.timestamp;
  const original = targetUrl.replace(/^https?:\/\//, '');
  const archiveUrl = `https://web.archive.org/web/${ts}id_/${original}`;

  return {
    archiveUrl,
    timestamp: ts,
    originalUrl: targetUrl,
  };
}

/**
 * Best-effort dismissal of common EU cookie banners. Mirrors the helper in
 * `apps/api/scripts/capture-pooltech.mjs` — kept here so the library is
 * self-contained for sites that gate content behind a consent overlay.
 */
async function dismissCookies(page: import('puppeteer').Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, a')];
      const target = buttons.find((b) =>
        /^(rifiuta|reject|ok|accetta|accept|chiudi|close|rifiuta tutti|deny all|reject all)$/i.test(
          (b.textContent ?? '').trim(),
        ),
      );
      if (target) (target as HTMLElement).click();
    });
    await new Promise((r) => setTimeout(r, 600));
  } catch {
    /* noop */
  }
}

/**
 * Scroll through the page to trigger lazy-loaded images before a fullPage
 * shot. Mirrors capture-pooltech.mjs step logic.
 */
async function triggerLazyLoad(page: import('puppeteer').Page): Promise<void> {
  const totalH = (await page.evaluate(() => document.body.scrollHeight)) ?? 0;
  for (let y = 0; y < totalH; y += 800) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await new Promise((r) => setTimeout(r, 250));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 600));
}

async function shootViewport(
  browser: Browser,
  targetUrl: string,
  viewport: CaptureViewport,
  folder: string,
  slug: string,
): Promise<{ url: string; key: string; width: number; height: number }> {
  const vp = VIEWPORTS[viewport];
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
    });
    // domcontentloaded, NON networkidle2: i siti con analytics/chat/polling non
    // raggiungono mai l'idle → goto andava in timeout (45s) e ogni viewport
    // falliva ("Nessuno screenshot catturato"). Poi aspettiamo l'idle in modo
    // tollerante (non blocca se la rete non si quieta) + un settle per il render.
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8_000 }).catch(() => {});
    await dismissCookies(page);
    await new Promise((r) => setTimeout(r, 1200));

    let buffer: Buffer;
    if (viewport === 'fullpage') {
      await triggerLazyLoad(page);
      buffer = (await page.screenshot({
        type: 'webp',
        quality: 80,
        fullPage: true,
      })) as Buffer;
    } else {
      buffer = (await page.screenshot({
        type: 'webp',
        quality: 90,
        clip: { x: 0, y: 0, width: vp.width, height: vp.height },
      })) as Buffer;
    }

    const filename = `${slug}-${viewport}.webp`;
    const key = generateFileKey(filename, folder);
    const result = await uploadFile(buffer, key, 'image/webp', {
      'capture-viewport': viewport,
      'capture-source': targetUrl,
    });
    return { url: result.url, key: result.key, width: vp.width, height: vp.height };
  } finally {
    await page.close();
  }
}

/**
 * High-level orchestrator: resolves the navigation URL (Wayback for
 * `archive` source, the raw URL for `live`), launches a single headless
 * Chromium, and shoots the requested viewports.
 *
 * Returns one `CaptureResult` per requested viewport, in the same order.
 */
export async function captureSite(opts: CaptureOptions): Promise<CaptureResult[]> {
  const source = opts.source ?? 'live';
  const viewports = opts.viewports ?? ['desktop', 'mobile', 'fullpage'];
  if (!opts.url) throw new Error('URL obbligatorio per capture');
  if (!opts.folder) throw new Error('folder obbligatorio (storage destination)');
  if (!opts.slug) throw new Error('slug obbligatorio (base filename)');

  let targetUrl = opts.url;
  let archiveTimestamp: string | undefined;
  let archiveUrl: string | undefined;

  if (source === 'archive') {
    const snap = await resolveWaybackSnapshot(opts.url, opts.archiveDate);
    targetUrl = snap.archiveUrl;
    archiveTimestamp = snap.timestamp;
    archiveUrl = snap.archiveUrl;
    log.info({ url: opts.url, snap: snap.timestamp }, 'wayback resolved');
  }

  const browser = await puppeteer.launch({
    headless: opts.headless ?? true,
    userDataDir: opts.profileDir,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const results: CaptureResult[] = [];
  try {
    for (const vp of viewports) {
      try {
        const shot = await shootViewport(browser, targetUrl, vp, opts.folder, opts.slug);
        results.push({
          kind: vp,
          url: shot.url,
          key: shot.key,
          width: shot.width,
          height: shot.height,
          source,
          archiveTimestamp,
          archiveUrl,
        });
      } catch (err) {
        log.warn({ err, viewport: vp, url: targetUrl }, 'capture viewport failed');
      }
    }
  } finally {
    await browser.close();
  }

  if (results.length === 0) {
    throw new Error(`Nessuno screenshot catturato per ${opts.url}`);
  }
  return results;
}

/**
 * Fase 3 extension: headless capture reusing a Chrome profile that was logged
 * in manually via the headful worker (`apps/worker`). Once an admin has done
 * the login in the noVNC session, `userDataDir` holds the session cookies,
 * so this runs the exact same `captureSite` pipeline headless — no UI, no
 * login step — against pages that would otherwise be gated.
 *
 * The comment at the top of this file said this was "intentionally NOT here";
 * it now lives here, backed by `capture_sessions` (migration 141) + the worker.
 */
export async function captureSiteAuthenticated(
  opts: CaptureOptions & { profileDir: string },
): Promise<CaptureResult[]> {
  if (!opts.profileDir) {
    throw new Error('profileDir obbligatorio per capture autenticato');
  }
  return captureSite({ ...opts, headless: true, profileDir: opts.profileDir });
}
