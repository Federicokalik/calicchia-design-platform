/**
 * App-password CalDAV per dispositivo. Modello identico ai token MCP
 * (`lib/mcp/tokens.ts`): token random ad alta entropia, hashato sha256,
 * mostrato in chiaro una sola volta. Il device manda Basic auth
 * username:app-password a ogni richiesta; `verifyCredentials` lo valida.
 */

import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../../db';

export function generateAppPassword(): { password: string; hash: string; prefix: string } {
  // 32 hex char: alta entropia, sha256-lookup => verifica per-richiesta veloce.
  const password = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(password).digest('hex');
  const prefix = password.slice(0, 8);
  return { password, hash, prefix };
}

export function hashAppPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

export interface CalDavAppPassword {
  id: string;
  username: string;
  device_name: string;
  token_prefix: string;
  last_used_at: string | null;
  usage_count: number;
  is_active: boolean;
  created_at: string;
  revoked_at: string | null;
}

const PUBLIC_COLUMNS = sql`
  id, username, device_name, token_prefix, last_used_at, usage_count, is_active, created_at, revoked_at
`;

export async function createAppPassword(input: {
  username: string;
  deviceName: string;
  createdBy?: string | null;
}): Promise<{ password: string; row: CalDavAppPassword }> {
  const { password, hash, prefix } = generateAppPassword();
  const rows = await sql<CalDavAppPassword[]>`
    INSERT INTO caldav_app_passwords (token_hash, token_prefix, username, device_name, created_by)
    VALUES (${hash}, ${prefix}, ${input.username}, ${input.deviceName}, ${input.createdBy ?? null})
    RETURNING ${PUBLIC_COLUMNS}
  `;
  return { password, row: rows[0] };
}

export async function listAppPasswords(): Promise<CalDavAppPassword[]> {
  return await sql<CalDavAppPassword[]>`
    SELECT ${PUBLIC_COLUMNS} FROM caldav_app_passwords ORDER BY created_at DESC
  `;
}

export async function revokeAppPassword(id: string): Promise<boolean> {
  const rows = await sql`
    UPDATE caldav_app_passwords
    SET is_active = false, revoked_at = now(), revoked_reason = 'revoked from admin'
    WHERE id = ${id}::uuid AND revoked_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Valida le credenziali Basic di un device CalDAV. Aggiorna last_used in
 * best-effort. Ritorna il principal (= username) se valide.
 */
export async function verifyCredentials(
  username: string,
  password: string,
  ip?: string,
): Promise<{ ok: boolean; principal?: string }> {
  if (!username || !password) return { ok: false };
  const hash = hashAppPassword(password);
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM caldav_app_passwords
    WHERE token_hash = ${hash}
      AND username = ${username}
      AND is_active = true
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { ok: false };

  sql`
    UPDATE caldav_app_passwords
    SET last_used_at = now(), last_used_ip = ${ip ?? null}, usage_count = usage_count + 1
    WHERE id = ${row.id}
  `.catch(() => {});

  return { ok: true, principal: username };
}
