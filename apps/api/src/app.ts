import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdirSync } from 'fs';

import { createHmac, timingSafeEqual } from 'crypto';

import { initBugsink, captureException } from './lib/bugsink';
import { authMiddleware } from './middleware/auth';
import { sql } from './db';
import { decryptSecret, isEncryptedSecret } from './lib/crypto';
import { logger } from './lib/logger';
import { mapDbError } from './lib/db-errors';

const log = logger.child({ scope: 'http' });

// Initialize error tracking
initBugsink();
import { createRateLimit } from './middleware/rate-limit';
import { auth } from './routes/auth';
import { customers } from './routes/customers';
import { subscriptions } from './routes/subscriptions';
import { invoices } from './routes/invoices';
import { domains } from './routes/domains';
import { media } from './routes/media';
import { newsletter } from './routes/newsletter';
import { blog } from './routes/blog';
import { projects } from './routes/projects';
import { contacts } from './routes/contacts';
import { publicLeads } from './routes/public-leads';
import { analytics } from './routes/analytics';
import { keys } from './routes/keys';
import { health } from './routes/health';
import { files } from './routes/files';
import { search } from './routes/search';
import { exportRoutes } from './routes/export';
import { importRoutes } from './routes/import';
import { stripeWebhook } from './routes/stripe-webhook';
import { paypalWebhook } from './routes/paypal-webhook';
import { paypal } from './routes/paypal';
import { publicPay } from './routes/public-pay';
import { clientProjects } from './routes/client-projects';
import { projectTasks } from './routes/project-tasks';
import { milestones } from './routes/milestones';
import { timeEntries } from './routes/time-entries';
import { projectComments } from './routes/project-comments';
import { calcom } from './routes/calcom';
import { calendarPublic } from './routes/calendar/public';
import { calendarAdmin } from './routes/calendar/admin';
import { calendarFeed } from './routes/calendar/feed';
import { domainCron } from './routes/domain-cron';
import { notifications } from './routes/notifications';
import { dashboard } from './routes/dashboard';
import { quotes } from './routes/quotes';
import { auditLogs } from './routes/audit-logs';
import { collaborators } from './routes/collaborators';
import { publicRoutes } from './routes/public';
import { publicCapacity } from './routes/public-capacity';
import { settings } from './routes/settings';
import { payments } from './routes/payments';
import { services } from './routes/services';
import { deliverables } from './routes/deliverables';
import { websites } from './routes/websites';
import { marketing } from './routes/marketing';
import { leads } from './routes/leads';
import { customerNotes } from './routes/customer-notes';
import { paymentTracker } from './routes/payment-tracker';
import { quotesV2 } from './routes/quotes-v2';
import { quotePublic } from './routes/quote-public';
import { signables } from './routes/signables';
import { signablesPublic } from './routes/signables-public';
import { tax } from './routes/tax';
import { ai } from './routes/ai';
import { invoiceOcr } from './routes/invoice-ocr';
import { expenses } from './routes/expenses';
import { telegram } from './routes/telegram';
import { workflows } from './routes/workflows';
import { notes as notesRoutes } from './routes/notes';
import { boards as boardsRoutes } from './routes/boards';
import { aiKnowledge } from './routes/ai-knowledge';
import { adminKb } from './routes/admin-kb';
import { knowledge } from './routes/knowledge';
import { brain } from './routes/brain';
import { collaboratorsV2 } from './routes/collaborators-v2';
import { portal } from './routes/portal/index';
import { cookieConsent } from './routes/cookie-consent';
import { gdprRequests } from './routes/gdpr-requests';
import { portalAdmin } from './routes/portal-admin';
import { inbox } from './routes/inbox';
import { myWork } from './routes/my-work';
import { mail } from './routes/mail';
import { mcp } from './routes/mcp';
import { mcpTokens } from './routes/mcp-tokens';
import { backup } from './routes/backup';
import { analyticsTrack } from './routes/analytics-track';
import { mcpAuthMiddleware } from './middleware/mcp-auth';
import { whatsappPublic, whatsappAdmin } from './routes/whatsapp';
import { preferencesPublic } from './routes/preferences-public';

// Ensure uploads directory exists
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
mkdirSync(UPLOAD_DIR, { recursive: true });

const isDev = process.env.NODE_ENV !== 'production';

export const app = new Hono();

// Global middleware
if (isDev) {
  app.use('*', honoLogger());
  app.use('*', prettyJSON());
}

// Body size limits. The global 10MB cap is applied via a wrapper that SKIPS the
// routes declaring a larger limit below: a plain app.use('*', bodyLimit()) runs
// first and would 413 large uploads before their own limit ran (finding HN-01).
// WhatsApp admin media upload accepts up to 16MB (UPLOAD_MAX_BYTES in
// routes/whatsapp.ts). Without listing the prefix here, the global 10MB cap
// hit first and 413'd 10–16MB files before the route's own limit ran
// (audit J-K-16).
const LARGE_BODY_PREFIXES = [
  '/api/media/',
  '/api/ai/extract-invoice',
  '/api/backup/import',
  '/api/whatsapp-admin/conversations/',
];
app.use('*', async (c, next) => {
  if (LARGE_BODY_PREFIXES.some((p) => c.req.path.startsWith(p))) return next();
  return bodyLimit({ maxSize: 10 * 1024 * 1024 })(c, next);
});
app.use('/api/media/*', bodyLimit({ maxSize: 50 * 1024 * 1024 }));
app.use('/api/ai/extract-invoice', bodyLimit({ maxSize: 20 * 1024 * 1024 }));
app.use('/api/whatsapp-admin/conversations/*', bodyLimit({ maxSize: 16 * 1024 * 1024 }));
// Full database restore uploads can be large; allow up to 200MB.
app.use('/api/backup/import', bodyLimit({ maxSize: 200 * 1024 * 1024 }));
// Refuse to start outside development without an explicit allowlist —
// silently falling back to localhost would either break browser auth or
// accidentally expose dev origins. Using !== 'development' (instead of
// === 'production') also catches staging/preview/test deploys that conventionally
// use NODE_ENV=staging (audit E-012).
if (process.env.NODE_ENV !== 'development' && !process.env.CORS_ORIGINS) {
  throw new Error('CORS_ORIGINS environment variable is required when NODE_ENV is not "development"');
}

// Outer middleware: strip Access-Control-Allow-Credentials from /api/track responses.
// This guarantees the cookieless invariant — the browser never sends cookies on
// tracker requests. Registered BEFORE the global cors so its post-next runs LAST.
app.use('/api/track', async (c, next) => {
  await next();
  c.res.headers.delete('Access-Control-Allow-Credentials');
});

app.use('*', cors({
  origin: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(',').filter(Boolean),
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Accept-Language', 'X-Admin-Locale'],
}));

// Security headers (GDPR + OWASP)
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '0'); // Deprecated but harmless
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP (SEC-08): the API only returns JSON and static files — none of which
  // load sub-resources — so a deny-all policy is safe and blocks any HTML the
  // API might ever serve (e.g. error pages) from executing scripts.
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  // SEC-13: COOP isolates the browsing context; CORP must stay 'cross-origin'
  // because /media/* images are embedded by sito-v3 on another origin.
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'cross-origin');
  if (process.env.NODE_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});

// Serve uploaded files as static assets
app.use('/media/*', serveStatic({ root: UPLOAD_DIR, rewriteRequestPath: (path) => path.replace('/media', '') }));

// Health check (no auth required)
app.route('/api/health', health);

// Private files (SEC-10): quote PDFs / receipts / WhatsApp media. Public route —
// access is gated by the signed URL, not by a session. Must stay OUT of the
// protected-paths list below.
app.route('/api/files', files);

// Auth routes (no auth required)
app.route('/api/auth', auth);

// Public routes (no auth required)
// Public-form rate limit (3 / 10 min). Applied to POST submissions only — the
// same path prefixes also serve admin GET endpoints which must not be throttled
// (HN-04) — and mounted on /api/newsletter/* so it covers the real subscribe
// endpoint POST /api/newsletter/subscribe (HN-02).
const publicFormRateLimit = createRateLimit(3, 10 * 60 * 1000);
const postOnly = (mw: MiddlewareHandler): MiddlewareHandler =>
  (c, next) => (c.req.method === 'POST' ? mw(c, next) : next());
app.use('/api/contacts', postOnly(publicFormRateLimit));
// Invariant: /api/contacts/:id/* sub-paths are admin-only via inline
// authMiddleware in contacts.ts. No public sub-paths exist that bypass the
// rate-limit; if you add one, switch this mount to a wildcard.
app.use('/api/public-leads', postOnly(publicFormRateLimit));
app.use('/api/newsletter/*', postOnly(publicFormRateLimit));
// Both the exact mount and the wildcard are required: app.use(path) without
// a trailing /* matches ONLY the exact path under Hono, so cancel/reschedule
// at /api/calendar/bookings/:uid/* were entirely unthrottled despite the
// surface looking guarded (audit E-005, same pattern fix as /api/backup).
app.use('/api/calendar/bookings', postOnly(publicFormRateLimit));
app.use('/api/calendar/bookings/*', postOnly(publicFormRateLimit));
app.route('/api/newsletter', newsletter);
app.route('/api/contacts', contacts);
app.route('/api/public-leads', publicLeads);
app.route('/api/calendar', calendarPublic);
// ICS feed pubblico per subscription esterne (iPhone/macOS Calendar/Outlook)
app.route('/api/calendar/feed', calendarFeed);
// Webhook ingress rate limits: defense in depth before signature verify.
// Real Stripe/PayPal traffic burstiness fits comfortably in 100 req/min/IP —
// they retry with backoff and never overlap multiple deliveries per second.
const paymentWebhookRateLimit = createRateLimit(100, 60 * 1000);
app.use('/api/stripe/webhook', paymentWebhookRateLimit);
app.use('/api/paypal-webhook', paymentWebhookRateLimit);
app.route('/api/stripe/webhook', stripeWebhook);
app.route('/api/paypal-webhook', paypalWebhook);
app.route('/api/cron/domains', domainCron);
app.route('/api/public', publicRoutes);
const capacityRateLimit = createRateLimit(10, 60 * 1000);
app.use('/api/public/capacity', capacityRateLimit);
app.route('/api/public/capacity', publicCapacity);
// Quote public signing endpoints (no auth). Rate-limited identically to /api/sign/*
// to deny brute-force of the 6-digit OTP — see audit J-01. OTPs are stored as
// keyed hashes and burned after OTP_MAX_ATTEMPTS wrong submissions per code.
const signRateLimit = createRateLimit(10, 60 * 1000);
app.use('/api/quote-sign/*', signRateLimit);
app.route('/api/quote-sign', quotePublic);
app.use('/api/sign/*', signRateLimit);
app.route('/api/sign', signablesPublic);
// PayPal client-token generation is unauthenticated by design (the token is a
// browser-SDK capability, not a money-mover). Each call still costs us an
// OAuth roundtrip to PayPal, so cap per-IP to avoid abuse.
app.use('/api/paypal/client-token', createRateLimit(10, 60 * 1000));
app.route('/api/paypal', paypal);
// public-pay capability endpoints (UUID-as-capability) — rate-limited because
// each /checkout call performs a Stripe/PayPal OAuth roundtrip (audit E-008,
// same rationale as /api/paypal/client-token above). 20 req/min is generous
// for legitimate 3DS-redirect retry loops while making URL probing pointless.
app.use('/api/public-pay/*', createRateLimit(20, 60 * 1000));
app.route('/api/public-pay', publicPay);
// Telegram webhook (no auth — verified by bot secret token).
// BK-14: rate-limited so a leaked/guessed webhook path can't be flooded.
app.use('/api/telegram/*', createRateLimit(30, 60 * 1000));
app.route('/api/telegram', telegram);
// Workflow webhook (no auth — identified by webhookId + HMAC signature)
const webhookRateLimit = createRateLimit(10, 60 * 1000);
app.use('/api/wh/*', webhookRateLimit);
app.post('/api/wh/:webhookId', async (c) => {
  const { webhookId } = c.req.param();
  // Generic 404 for invalid format → no enumeration (valid vs malformed)
  if (!/^[a-f0-9-]{36}$/.test(webhookId)) return c.json({ error: 'Not Found' }, 404);

  // Lookup + decrypt MUST stay inside try/catch (audit E-013): the previous
  // version let decryptSecret throw on a tampered/legacy payload, which surfaced
  // as 500 via app.onError — distinguishable from the 404 returned on
  // invalid/unknown webhookId, leaking webhook existence to a probe.
  let workflowId: string;
  let secret: string;
  try {
    const rows = await sql`
      SELECT id, status, trigger_config FROM workflows
      WHERE trigger_type = 'webhook'
        AND trigger_config->>'webhook_id' = ${webhookId}
        AND status = 'active'
      LIMIT 1
    ` as Array<{ id: string; status: string; trigger_config: any }>;
    if (!rows.length) return c.json({ error: 'Not Found' }, 404);

    const config = typeof rows[0].trigger_config === 'string'
      ? JSON.parse(rows[0].trigger_config)
      : rows[0].trigger_config;
    const storedSecret: string | undefined = config?.webhook_secret;
    const resolved = storedSecret && isEncryptedSecret(storedSecret)
      ? decryptSecret(storedSecret)
      : storedSecret;
    if (!resolved) {
      // Workflow legacy without secret — reject and force regen via admin
      return c.json({ error: 'Not Found' }, 404);
    }
    workflowId = rows[0].id;
    secret = resolved;
  } catch (err) {
    // Log for operators (decrypt failures may indicate key rotation or
    // tampering) but never differentiate the HTTP shape from the miss path.
    log.warn({ err, webhookId }, 'webhook lookup/decrypt failed');
    return c.json({ error: 'Not Found' }, 404);
  }

  const rawBody = await c.req.text();
  const sigHeader = c.req.header('X-Webhook-Signature') || '';
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: 'Not Found' }, 404);
  }

  let body: any = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
  const { executeWorkflow } = await import('./lib/workflow/engine');
  const result = await executeWorkflow(workflowId, { webhook: true, ...body });
  return c.json(result);
});
app.route('/api/portal', portal);
// GDPR cookie consent log — public endpoint, rate-limited 10 req / 60s per IP
// (audit J-03). Schema-validated in the route handler with strict zod object.
app.use('/api/cookie-consent', createRateLimit(10, 60 * 1000));
app.route('/api/cookie-consent', cookieConsent);
// postOnly so the 3 req / 10 min cap throttles only the public submission,
// not the admin GET listing (audit E-006: admin loading the queue 3x burned
// the limit and got 429).
app.use('/api/gdpr-requests', postOnly(publicFormRateLimit));
app.route('/api/gdpr-requests', gdprRequests);

// WhatsApp (GOWA) — webhook ingress + endpoint pubblico preferences-by-token.
// Il webhook è verificato via HMAC (GOWA_WEBHOOK_SECRET); le preferences-by-token
// usano un token cifrato a 24 byte distribuito nei link "modifica preferenze".
const whatsappWebhookRateLimit = createRateLimit(60, 60 * 1000);
app.use('/api/whatsapp/webhook', whatsappWebhookRateLimit);
app.route('/api/whatsapp', whatsappPublic);
const preferencesPublicRateLimit = createRateLimit(20, 60 * 1000);
app.use('/api/preferences/*', preferencesPublicRateLimit);
app.route('/api/preferences', preferencesPublic);

// Public cookieless analytics tracker — rate-limited to 60 req/min per IP.
const trackRateLimit = createRateLimit(60, 60 * 1000);
app.use('/api/track', trackRateLimit);
app.route('/api/track', analyticsTrack);

// Protected routes (auth required — admin gestionale)
const protectedPaths = [
  '/api/customers',
  '/api/subscriptions',
  '/api/invoices',
  '/api/expenses',
  '/api/tax',
  '/api/domains',
  '/api/media',
  '/api/blog',
  '/api/projects',
  '/api/analytics',
  '/api/keys',
  '/api/export',
  '/api/import',
  '/api/client-projects',
  '/api/project-tasks',
  '/api/milestones',
  '/api/time-entries',
  '/api/project-comments',
  '/api/calcom',
  '/api/admin/calendar',
  '/api/notifications',
  '/api/dashboard',
  '/api/quotes',
  '/api/audit-logs',
  '/api/collaborators',
  '/api/settings',
  '/api/payments',
  '/api/services',
  '/api/deliverables',
  '/api/websites',
  '/api/marketing',
  '/api/leads',
  '/api/customer-notes',
  '/api/payment-tracker',
  '/api/quotes-v2',
  '/api/signables',
  '/api/ai',
  '/api/workflows',
  '/api/collaborators-v2',
  '/api/search',
  '/api/notes',
  '/api/boards',
  // '/api/ai/knowledge' is shadowed by /api/ai/* (audit E-011) — removed.
  '/api/knowledge',
  '/api/brain',
  '/api/portal-admin',
  '/api/inbox',
  '/api/my-work',
  '/api/mail',
  '/api/mcp-tokens',
  '/api/backup',
  '/api/whatsapp-admin',
  '/api/admin/kb',
];

// /api/track is intentionally NOT in protectedPaths — it's the cookieless
// ingestion endpoint; auth would defeat the purpose. See analytics-track.ts.

for (const path of protectedPaths) {
  app.use(`${path}`, authMiddleware);
  app.use(`${path}/*`, authMiddleware);
}

// Mount routes
app.route('/api/customers', customers);
app.route('/api/subscriptions', subscriptions);
app.route('/api/invoices', invoices);
app.route('/api/expenses', expenses);
app.route('/api/tax', tax);
app.route('/api/domains', domains);
app.route('/api/media', media);
app.route('/api/blog', blog);
app.route('/api/projects', projects);
app.route('/api/analytics', analytics);
app.route('/api/keys', keys);
app.route('/api/export', exportRoutes);
app.route('/api/import', importRoutes);
app.route('/api/client-projects', clientProjects);
app.route('/api/project-tasks', projectTasks);
app.route('/api/milestones', milestones);
app.route('/api/time-entries', timeEntries);
app.route('/api/project-comments', projectComments);
app.route('/api/calcom', calcom);
app.route('/api/admin/calendar', calendarAdmin);
app.route('/api/notifications', notifications);
app.route('/api/dashboard', dashboard);
app.route('/api/quotes', quotes);
app.route('/api/audit-logs', auditLogs);
app.route('/api/collaborators', collaborators);
app.route('/api/settings', settings);
app.route('/api/payments', payments);
app.route('/api/services', services);
app.route('/api/deliverables', deliverables);
app.route('/api/websites', websites);
app.route('/api/marketing', marketing);
app.route('/api/leads', leads);
app.route('/api/customer-notes', customerNotes);
app.route('/api/payment-tracker', paymentTracker);
app.route('/api/quotes-v2', quotesV2);
app.route('/api/signables', signables);
app.route('/api/ai', ai);
app.route('/api/ai', invoiceOcr);
app.route('/api/workflows', workflows);
app.route('/api/collaborators-v2', collaboratorsV2);
app.route('/api/search', search);
app.route('/api/notes', notesRoutes);
app.route('/api/boards', boardsRoutes);
app.route('/api/ai/knowledge', aiKnowledge);
app.route('/api/knowledge', knowledge);
app.route('/api/brain', brain);
app.route('/api/portal-admin', portalAdmin);
app.route('/api/inbox', inbox);
app.route('/api/my-work', myWork);
app.route('/api/mail', mail);
app.route('/api/mcp-tokens', mcpTokens);
app.route('/api/whatsapp-admin', whatsappAdmin);
app.route('/api/admin/kb', adminKb);

// Full DB backup/restore — admin-only, rate-limited (3 req / 10 min).
const backupRateLimit = createRateLimit(3, 10 * 60 * 1000);
app.use('/api/backup', backupRateLimit);
app.use('/api/backup/*', backupRateLimit);
app.route('/api/backup', backup);

// MCP endpoints (service-token auth, separato dal JWT admin)
app.use('/api/mcp', mcpAuthMiddleware);
app.use('/api/mcp/*', mcpAuthMiddleware);
app.route('/api/mcp', mcp);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Error handler
app.onError((err, c) => {
  // HTTPException from fail() helper — expected errors (4xx)
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  // DBX-04: database error boundary. Routes that run `sql` without a try/catch
  // would otherwise leak raw driver errors as opaque 500s. Map the known ones
  // (constraint violations → 4xx, connection/timeout failures → 503) to clean
  // responses. Routes that catch the error themselves re-throw via fail() and
  // are handled by the HTTPException branch above, so they keep full control.
  const dbError = mapDbError(err);
  if (dbError) {
    if (dbError.client) {
      log.warn({ err, url: c.req.url, method: c.req.method }, 'database constraint error');
    } else {
      log.error({ err, url: c.req.url, method: c.req.method }, 'database unavailable');
      captureException(err, { url: c.req.url, method: c.req.method, kind: 'db' });
    }
    return c.json({ error: dbError.message }, dbError.status);
  }
  // Unexpected errors (5xx) — log and report to Bugsink
  log.error({ err, url: c.req.url, method: c.req.method }, 'unhandled error');
  captureException(err, { url: c.req.url, method: c.req.method });
  return c.json({ error: 'Internal Server Error' }, 500);
});

export type AppType = typeof app;
