import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
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

// Ensure uploads directory exists
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
mkdirSync(UPLOAD_DIR, { recursive: true });

const isDev = process.env.NODE_ENV !== 'production';

export const app = new Hono();

// Global middleware
if (isDev) {
  app.use('*', logger());
  app.use('*', prettyJSON());
}

// Body size limit (10MB default, 50MB for media uploads)
app.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 }));
app.use('/api/media/*', bodyLimit({ maxSize: 50 * 1024 * 1024 }));
app.use('/api/ai/extract-invoice', bodyLimit({ maxSize: 20 * 1024 * 1024 }));
// Full database restore uploads can be large; allow up to 200MB.
app.use('/api/backup/import', bodyLimit({ maxSize: 200 * 1024 * 1024 }));
// In production, refuse to start without an explicit allowlist —
// silently falling back to localhost would either break browser
// auth or accidentally expose dev origins.
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS) {
  throw new Error('CORS_ORIGINS environment variable is required in production');
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
  if (process.env.NODE_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});

// Serve uploaded files as static assets
app.use('/media/*', serveStatic({ root: UPLOAD_DIR, rewriteRequestPath: (path) => path.replace('/media', '') }));

// Health check (no auth required)
app.route('/api/health', health);

// Auth routes (no auth required)
app.route('/api/auth', auth);

// Public routes (no auth required)
const publicFormRateLimit = createRateLimit(3, 10 * 60 * 1000);
app.use('/api/contacts', publicFormRateLimit);
app.use('/api/public-leads', publicFormRateLimit);
app.use('/api/newsletter', publicFormRateLimit);
app.use('/api/calendar/bookings', publicFormRateLimit);
app.route('/api/newsletter', newsletter);
app.route('/api/contacts', contacts);
app.route('/api/public-leads', publicLeads);
app.route('/api/calendar', calendarPublic);
// ICS feed pubblico per subscription esterne (iPhone/macOS Calendar/Outlook)
app.route('/api/calendar/feed', calendarFeed);
app.route('/api/stripe/webhook', stripeWebhook);
app.route('/api/paypal-webhook', paypalWebhook);
app.route('/api/cron/domains', domainCron);
app.route('/api/public', publicRoutes);
const capacityRateLimit = createRateLimit(10, 60 * 1000);
app.use('/api/public/capacity', capacityRateLimit);
app.route('/api/public/capacity', publicCapacity);
// Quote public signing endpoints (no auth)
app.route('/api/quote-sign', quotePublic);
const signRateLimit = createRateLimit(10, 60 * 1000);
app.use('/api/sign/*', signRateLimit);
app.route('/api/sign', signablesPublic);
app.route('/api/paypal', paypal);
app.route('/api/public-pay', publicPay);
// Telegram webhook (no auth — verified by bot token)
app.route('/api/telegram', telegram);
// Workflow webhook (no auth — identified by webhookId + HMAC signature)
const webhookRateLimit = createRateLimit(10, 60 * 1000);
app.use('/api/wh/*', webhookRateLimit);
app.post('/api/wh/:webhookId', async (c) => {
  const { webhookId } = c.req.param();
  // Generic 404 for invalid format → no enumeration (valid vs malformed)
  if (!/^[a-f0-9-]{36}$/.test(webhookId)) return c.json({ error: 'Not Found' }, 404);

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
  const secret = storedSecret && isEncryptedSecret(storedSecret)
    ? decryptSecret(storedSecret)
    : storedSecret;
  if (!secret) {
    // Workflow legacy without secret — reject and force regen via admin
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
  const result = await executeWorkflow(rows[0].id, { webhook: true, ...body });
  return c.json(result);
});
app.route('/api/portal', portal);
app.route('/api/cookie-consent', cookieConsent);
app.use('/api/gdpr-requests', publicFormRateLimit);
app.route('/api/gdpr-requests', gdprRequests);

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
  '/api/ai/knowledge',
  '/api/knowledge',
  '/api/brain',
  '/api/portal-admin',
  '/api/inbox',
  '/api/my-work',
  '/api/mail',
  '/api/mcp-tokens',
  '/api/backup',
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
  // Unexpected errors (5xx) — log and report to Bugsink
  console.error('Error:', err);
  captureException(err, { url: c.req.url, method: c.req.method });
  return c.json({ error: 'Internal Server Error' }, 500);
});

export type AppType = typeof app;
