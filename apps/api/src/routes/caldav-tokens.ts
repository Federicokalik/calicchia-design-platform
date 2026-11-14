/**
 * Route admin per gestire le app-password CalDAV (tabella caldav_app_passwords).
 *
 * I device CalDAV (DAVx5/iOS/macOS/Thunderbird) mandano Basic auth
 * username:app-password a ogni richiesta. Le app-password sono token random
 * ad alta entropia, hashati sha256, mostrati in chiaro una sola volta,
 * revocabili per-dispositivo. Mirror di mcp-tokens.ts.
 *
 * Dalla fase F1 del passaggio a Radicale (contratto control-plane §9):
 *  - lo username è di norma il principal canonico (RADICALE_PRINCIPAL,
 *    'federico'): se il corpo non lo indica si usa quello. Uno username
 *    diverso resta ammesso per compatibilità e autentica comunque come il
 *    principal canonico;
 *  - gli username con prefisso `caldes-` sono riservati agli utenti di
 *    servizio di Radicale → 400;
 *  - la revoca incrementa credential_epoch nella stessa transazione, così la
 *    cache di caldes_auth non prolunga la vita della password revocata.
 *
 * Protetto da authMiddleware (admin) via protectedPaths in app.ts.
 */

import { Hono } from 'hono';
import {
  APP_PASSWORD_DEVICE_NAME_MAX_LENGTH,
  AppPasswordValidationError,
  caldavPrincipal,
  createAppPassword,
  listAppPasswords,
  normalizeAppPasswordUsername,
  revokeAppPassword,
} from '../lib/calendar/caldav-passwords';
import { BACKEND_MODES, type BackendMode } from '../lib/calendar/radicale/types';
import { sql } from '../db';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'caldav-tokens' });

type Env = { Variables: { user: { id: string; email?: string } } };

export const caldavTokens = new Hono<Env>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Riepilogo dello stato del backend calendario per l'interfaccia (solo visualizzazione). */
interface CalendarBackendSummary {
  /** Modalità del backend (calendar_backend_state.mode). */
  mode: BackendMode;
  /** Volume di Radicale inizializzato (epoch ≥ 1): prima i device non vedono i calendari. */
  initialized: boolean;
}

/**
 * Legge modalità e inizializzazione da calendar_backend_state per i messaggi
 * della UI (sola lettura sui device durante la migrazione, volume non ancora
 * inizializzato). Non è la modalità effettiva di caldes_rights, che dipende
 * anche da heartbeat e identità: è solo un'indicazione. Un errore di lettura
 * non deve impedire la gestione delle app-password → null.
 */
async function readCalendarBackendSummary(): Promise<CalendarBackendSummary | null> {
  try {
    const [row] = await sql<Array<{ mode: string; epoch: number }>>`
      SELECT mode, epoch FROM calendar_backend_state WHERE id
    `;
    if (!row || !BACKEND_MODES.includes(row.mode as BackendMode)) return null;
    return { mode: row.mode as BackendMode, initialized: Number(row.epoch) > 0 };
  } catch (err) {
    log.warn({ err: { code: (err as { code?: string }).code, message: (err as Error).message } }, 'stato del backend calendario non leggibile');
    return null;
  }
}

/** Principal canonico, o null se RADICALE_PRINCIPAL è configurato male (la lista resta consultabile). */
function principalOrNull(): string | null {
  try {
    return caldavPrincipal();
  } catch (err) {
    log.error({ err: { message: (err as Error).message } }, 'RADICALE_PRINCIPAL non valido');
    return null;
  }
}

caldavTokens.get('/', async (c) => {
  const [passwords, calendarBackend] = await Promise.all([listAppPasswords(), readCalendarBackendSummary()]);
  return c.json({ passwords, principal: principalOrNull(), calendar_backend: calendarBackend });
});

caldavTokens.post('/', async (c) => {
  let body: { username?: unknown; device_name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body JSON richiesto' }, 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Body JSON richiesto' }, 400);
  }

  // Username assente o vuoto → principal canonico; prefisso caldes- rifiutato.
  let username: string;
  try {
    username = normalizeAppPasswordUsername(body.username);
  } catch (err) {
    if (err instanceof AppPasswordValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }

  const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
  if (!deviceName || deviceName.length > APP_PASSWORD_DEVICE_NAME_MAX_LENGTH) {
    return c.json({ error: `device_name obbligatorio (max ${APP_PASSWORD_DEVICE_NAME_MAX_LENGTH} caratteri)` }, 400);
  }

  const user = c.get('user');
  const createdBy = user?.id ?? null;

  const { password, row } = await createAppPassword({ username, deviceName, createdBy });

  return c.json(
    {
      ...row,
      password,
      warning:
        `Salva la password ora — non sarà più visibile. Sul device usa lo username "${row.username}" ` +
        'e questa password come "password" dell\'account CalDAV (non quella admin).',
    },
    201,
  );
});

caldavTokens.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'id non valido' }, 400);
  const ok = await revokeAppPassword(id);
  if (!ok) return c.json({ error: 'App-password non trovata o già revocata' }, 404);
  return c.json({ revoked: true });
});
