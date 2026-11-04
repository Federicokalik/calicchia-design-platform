/**
 * Policy del gateway API generico dell'MCP (tool `api_request`).
 *
 * Modulo puro (nessun accesso a DB o app): decide se una richiesta verso le
 * route admin è ammessa e con che livello di rischio. Lo scope del token MCP
 * mappa il rischio come per i tool curati (routes/mcp.ts):
 *   read  → solo GET (rischio low)
 *   write → low + medium
 *   admin → tutto; high richiede lo step-up OTP via Telegram
 */

export type McpScope = 'read' | 'write' | 'admin';
export type Risk = 'low' | 'medium' | 'high';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Prefissi admin con authMiddleware inline (non in protectedPaths di app.ts):
 * espongono sia POST pubblici sia handler admin sullo stesso prefisso.
 */
export const INLINE_ADMIN_PREFIXES: readonly string[] = [
  '/api/contacts',
  '/api/newsletter',
  '/api/gdpr-requests',
  '/api/cookie-consent',
];

/**
 * Mai raggiungibili via MCP, a prescindere dallo scope: gestione dei token e
 * delle credenziali (evita che un token si auto-promuova o ne crei altri),
 * autenticazione, backup/restore del DB, chiavi API.
 */
const DENY_PATTERN = /^\/api\/(?:mcp|auth|backup|caldav-tokens|caldav-backend|device|keys)(?:[-/]|$)/;

/**
 * Azioni verso l'esterno o difficili da annullare: rischio high su qualsiasi
 * metodo di scrittura. DELETE è sempre high a prescindere da questa lista.
 */
const HIGH_RISK_WRITE_PATTERNS: readonly RegExp[] = [
  // Invii: email, preventivi, firme, accesso portale, promemoria, campagne.
  /\/send(?:[-/]|$)/,
  /\/resend-/,
  /\/schedule-send(?:\/|$)/,
  /^\/api\/email-marketing\/campaigns\/[^/]+\/test$/,
  /^\/api\/email-marketing\/automations\/[^/]+\/enroll$/,
  // WhatsApp: messaggi, programmati, reazioni, approvazione bozze AI, device.
  /^\/api\/whatsapp-admin\/conversations\/[^/]+\/(?:messages|schedule)(?:\/|$)/,
  /^\/api\/whatsapp-admin\/messages\/[^/]+\/(?:approve|react)$/,
  /^\/api\/whatsapp-admin\/(?:link|logout|reconnect)$/,
  // Messaggi e richieste visibili al cliente nel portale.
  /^\/api\/portal-admin\/projects\/[^/]+\/messages$/,
  /^\/api\/portal-admin\/request-material(?:\/|$)/,
  // Pubblicazione di contenuti sul sito.
  /\/publish(?:\/|$)/,
  // Pagamenti, link di pagamento, sincronizzazioni con Stripe/PayPal.
  /^\/api\/payments(?:\/|$)/,
  /^\/api\/subscriptions(?:\/|$)/,
  /\/payment-link$/,
  /\/(?:sync-stripe|stripe-sync|sync-paypal)$/,
  // Import massivi (l'anteprima resta medium).
  /\/import(?!\/preview)(?:[-/]|$)/,
  // Impostazioni globali e workflow (che possono inviare a loro volta).
  /^\/api\/settings(?:\/|$)/,
  /^\/api\/workflows\/[^/]+\/execute$/,
  // Cancellazioni massive / GDPR e migrazione del calendario.
  /\/purge$/,
  /^\/api\/gdpr-requests\/erase\//,
  /^\/api\/admin\/calendar\/migration(?:\/|$)/,
  // Annullamento di una prenotazione (avvisa il partecipante), come cancel_booking.
  /^\/api\/admin\/calendar\/bookings\/[^/]+\/cancel$/,
];

export type PathCheck =
  | { ok: true; pathname: string }
  | { ok: false; code: 'invalid_path' | 'path_denied' | 'not_admin_route'; error: string };

/**
 * Normalizza e valida il path richiesto. Rifiuta path relativi, traversal
 * (anche percent-encoded), query string nel path (va passata a parte) e
 * qualsiasi route fuori dai prefissi admin.
 */
export function checkPath(rawPath: string, adminPrefixes: readonly string[]): PathCheck {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/api/')) {
    return { ok: false, code: 'invalid_path', error: 'Il path deve iniziare con /api/' };
  }
  if (rawPath.includes('?') || rawPath.includes('#')) {
    return { ok: false, code: 'invalid_path', error: 'Passa i parametri in "query", non nel path' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, code: 'invalid_path', error: 'Path con encoding non valido' };
  }
  if (/(^|\/)\.\.?(\/|$)/.test(decoded) || decoded.includes('\\') || /\/\//.test(decoded)) {
    return { ok: false, code: 'invalid_path', error: 'Path non valido' };
  }
  const pathname = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
  if (DENY_PATTERN.test(decoded)) {
    return { ok: false, code: 'path_denied', error: 'Endpoint non accessibile via MCP' };
  }
  const isAdmin = adminPrefixes.some((p) => decoded === p || decoded.startsWith(`${p}/`));
  if (!isAdmin) {
    return { ok: false, code: 'not_admin_route', error: 'Endpoint fuori dalle route admin del gestionale' };
  }
  return { ok: true, pathname };
}

/** Rischio di una richiesta già validata da checkPath. */
export function classifyRisk(method: HttpMethod, pathname: string): Risk {
  if (method === 'GET') return 'low';
  if (method === 'DELETE') return 'high';
  const decoded = safeDecode(pathname);
  return HIGH_RISK_WRITE_PATTERNS.some((re) => re.test(decoded)) ? 'high' : 'medium';
}

/** Stessa regola dei tool curati: read solo low, write fino a medium, admin tutto. */
export function scopeAllows(scope: McpScope, risk: Risk): boolean {
  if (scope === 'admin') return true;
  if (scope === 'write') return risk !== 'high';
  return risk === 'low';
}

export function isDeniedPath(path: string): boolean {
  return DENY_PATTERN.test(safeDecode(path));
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
