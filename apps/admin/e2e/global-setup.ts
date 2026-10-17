/**
 * Setup globale: ottiene dallo stack la sessione admin e la salva come
 * storageState (cookie auth_token, come dopo un login), così gli scenari
 * partono già autenticati. Lo stack è già pronto: Playwright avvia i webServer
 * prima del setup globale.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BASE_URL, CONTROL_URL, STORAGE_STATE } from './support/env';

export default async function globalSetup(): Promise<void> {
  const res = await fetch(`${CONTROL_URL}/session`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sessione admin non ottenuta dallo stack: HTTP ${res.status}`);
  const { token } = (await res.json()) as { token: string };

  const week = 7 * 24 * 3600;
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  writeFileSync(
    STORAGE_STATE,
    JSON.stringify({
      cookies: [
        {
          name: 'auth_token',
          value: token,
          domain: new URL(BASE_URL).hostname,
          path: '/',
          expires: Math.floor(Date.now() / 1000) + week,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
  );
}
