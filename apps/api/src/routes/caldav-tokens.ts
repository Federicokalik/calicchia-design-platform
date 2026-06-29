/**
 * Route admin per gestire le app-password CalDAV (tabella caldav_app_passwords).
 *
 * I device CalDAV (DAVx5/iOS/macOS/Thunderbird) mandano Basic auth
 * username:app-password a ogni richiesta. Le app-password sono token random
 * ad alta entropia, hashati sha256, mostrati in chiaro una sola volta,
 * revocabili per-dispositivo. Mirror di mcp-tokens.ts.
 *
 * Protetto da authMiddleware (admin) via protectedPaths in app.ts.
 */

import { Hono } from 'hono';
import {
  createAppPassword,
  listAppPasswords,
  revokeAppPassword,
} from '../lib/calendar/caldav-passwords';

type Env = { Variables: { user: { id: string; email?: string } } };

export const caldavTokens = new Hono<Env>();

caldavTokens.get('/', async (c) => {
  const passwords = await listAppPasswords();
  return c.json({ passwords });
});

caldavTokens.post('/', async (c) => {
  let body: { username?: unknown; device_name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body JSON richiesto' }, 400);
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!username || username.length > 64) {
    return c.json({ error: 'username obbligatorio (max 64 caratteri)' }, 400);
  }
  // username CalDAV = principal. Mono-utente: di norma "federico".
  // Caratteri ammessi: lettere, cifre, _, -, . (no / niente spazi).
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) {
    return c.json({ error: 'username: solo lettere, cifre, _, -, .' }, 400);
  }

  const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
  if (!deviceName || deviceName.length > 100) {
    return c.json({ error: 'device_name obbligatorio (max 100 caratteri)' }, 400);
  }

  const user = c.get('user');
  const createdBy = user?.id ?? null;

  const { password, row } = await createAppPassword({ username, deviceName, createdBy });

  return c.json(
    {
      ...row,
      password,
      warning: 'Salva la password ora — non sarà più visibile. Usala nel device CalDAV come "password" (non quella admin).',
    },
    201,
  );
});

caldavTokens.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const ok = await revokeAppPassword(id);
  if (!ok) return c.json({ error: 'App-password non trovata o già revocata' }, 404);
  return c.json({ revoked: true });
});
