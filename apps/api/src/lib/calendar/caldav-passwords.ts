/**
 * App-password CalDAV per dispositivo. Modello identico ai token MCP
 * (`lib/mcp/tokens.ts`): token random ad alta entropia, hashato sha256,
 * mostrato in chiaro una sola volta. Il device manda Basic auth
 * username:app-password a ogni richiesta; Radicale (plugin caldes_auth) la
 * verifica con POST /api/caldav-backend/verify-credentials, che usa
 * `verifyCredentials`.
 *
 * Dalla fase F1 del passaggio a Radicale (contratto control-plane §9, design
 * §3.3):
 *  - ogni app-password valida autentica come il principal canonico
 *    (RADICALE_PRINCIPAL, default 'federico'), qualunque sia lo username con
 *    cui è stata creata: un'app-password storica creata come 'iphone' continua
 *    a funzionare e vede /federico/. Lo username resta per audit e rate limit;
 *  - gli username con prefisso `caldes-` sono riservati agli utenti di
 *    servizio di Radicale (caldes-svc, caldes-probe): rifiutati alla creazione
 *    e mai verificati, nemmeno se una riga storica li contiene;
 *  - ogni revoca incrementa calendar_backend_state.credential_epoch nella
 *    stessa transazione (§9.6): caldes_auth svuota le sue cache, compresa
 *    quella persistita su disco, e una password revocata non sopravvive
 *    nemmeno con il backend irraggiungibile. La creazione non lo cambia.
 */

import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../../db';
import { logger } from '../logger';
import {
  DEFAULT_PRINCIPAL,
  RESERVED_USERNAME_PREFIX,
  isReservedUsername,
  isValidPrincipal,
} from './radicale/types';

const log = logger.child({ scope: 'caldav-passwords' });

// ─── Limiti ─────────────────────────────────────────────────

/** Lunghezza massima dello username di un'app-password nuova. */
export const APP_PASSWORD_USERNAME_MAX_LENGTH = 64;
/** Caratteri ammessi nello username di un'app-password nuova (niente '/', spazi o ':'). */
const APP_PASSWORD_USERNAME_RE = /^[A-Za-z0-9_.-]+$/;
/** Lunghezza massima del nome del dispositivo. */
export const APP_PASSWORD_DEVICE_NAME_MAX_LENGTH = 100;

/**
 * Login verificabile (contratto §9.2 e verify-credentials.schema.json): da 1 a
 * 255 byte UTF-8, senza caratteri di controllo. caldes_auth scarta già gli
 * altri senza chiamare il backend; qui vale come difesa in profondità.
 */
export const VERIFY_USERNAME_MAX_BYTES = 255;
/** Lunghezza massima della password accettata da verify-credentials. */
export const VERIFY_PASSWORD_MAX_LENGTH = 1024;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;

// ─── Errori ─────────────────────────────────────────────────

/** Dati di un'app-password nuova non validi (la route risponde 400 con il messaggio). */
export class AppPasswordValidationError extends Error {
  readonly code = 'APP_PASSWORD_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AppPasswordValidationError';
  }
}

/** RADICALE_PRINCIPAL configurato male: errore di configurazione, mai delle credenziali. */
export class CaldavPrincipalConfigError extends Error {
  readonly code = 'CALDAV_PRINCIPAL_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CaldavPrincipalConfigError';
  }
}

// ─── Principal e username ───────────────────────────────────

/**
 * Principal canonico di Radicale (RADICALE_PRINCIPAL, default 'federico'):
 * l'utente che caldes_auth restituisce per ogni app-password valida. Deve
 * coincidere con il RADICALE_PRINCIPAL del container di Radicale (contratto
 * §1.3). Letto a ogni chiamata: costa poco e segue l'ambiente corrente.
 * Stessa interpretazione del writer della policy (radicale/policy.ts): spazi
 * ignorati, assente o vuoto → default.
 */
export function caldavPrincipal(): string {
  const principal = process.env.RADICALE_PRINCIPAL?.trim() || DEFAULT_PRINCIPAL;
  if (!isValidPrincipal(principal)) {
    throw new CaldavPrincipalConfigError(
      `RADICALE_PRINCIPAL non valido (${JSON.stringify(principal)}): minuscole, cifre, '-' e '_', ` +
        `al massimo 64 caratteri, mai con il prefisso "${RESERVED_USERNAME_PREFIX}"`,
    );
  }
  return principal;
}

/**
 * Username di un'app-password nuova. Assente o vuoto → principal canonico (il
 * caso normale: l'admin non lo chiede più). Uno username diverso resta
 * ammesso per compatibilità (script e app-password storiche), ma autentica
 * comunque come il principal canonico. Il prefisso `caldes-` è rifiutato
 * senza distinguere maiuscole e minuscole.
 */
export function normalizeAppPasswordUsername(raw: unknown): string {
  if (raw === undefined || raw === null) return caldavPrincipal();
  if (typeof raw !== 'string') throw new AppPasswordValidationError('username deve essere una stringa');
  const username = raw.trim();
  if (!username) return caldavPrincipal();
  if (username.length > APP_PASSWORD_USERNAME_MAX_LENGTH) {
    throw new AppPasswordValidationError(`username: al massimo ${APP_PASSWORD_USERNAME_MAX_LENGTH} caratteri`);
  }
  if (!APP_PASSWORD_USERNAME_RE.test(username)) {
    throw new AppPasswordValidationError('username: solo lettere, cifre, _, -, .');
  }
  if (isReservedUsername(username)) {
    throw new AppPasswordValidationError(
      `username: il prefisso "${RESERVED_USERNAME_PREFIX}" è riservato agli utenti di servizio di Radicale`,
    );
  }
  return username;
}

/** Login con la forma ammessa da verify-credentials (prima di qualsiasi lookup). */
function isVerifiableLogin(username: string, password: string): boolean {
  if (!username || !password) return false;
  if (password.length > VERIFY_PASSWORD_MAX_LENGTH) return false;
  if (CONTROL_CHARS_RE.test(username)) return false;
  return Buffer.byteLength(username, 'utf8') <= VERIFY_USERNAME_MAX_BYTES;
}

// ─── App-password ───────────────────────────────────────────

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
  last_used_ip: string | null;
  usage_count: number;
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

const PUBLIC_COLUMNS = sql`
  id, username, device_name, token_prefix, last_used_at, last_used_ip, usage_count, is_active,
  expires_at, created_at, revoked_at
`;

export async function createAppPassword(input: {
  /** Assente → principal canonico; il prefisso `caldes-` è rifiutato. */
  username?: string | null;
  deviceName: string;
  createdBy?: string | null;
}): Promise<{ password: string; row: CalDavAppPassword }> {
  // Validato anche qui (non solo nella route): nessun percorso deve poter
  // creare un'app-password con uno username riservato.
  const username = normalizeAppPasswordUsername(input.username);
  const { password, hash, prefix } = generateAppPassword();
  const rows = await sql<CalDavAppPassword[]>`
    INSERT INTO caldav_app_passwords (token_hash, token_prefix, username, device_name, created_by)
    VALUES (${hash}, ${prefix}, ${username}, ${input.deviceName}, ${input.createdBy ?? null})
    RETURNING ${PUBLIC_COLUMNS}
  `;
  return { password, row: rows[0] };
}

export async function listAppPasswords(): Promise<CalDavAppPassword[]> {
  return await sql<CalDavAppPassword[]>`
    SELECT ${PUBLIC_COLUMNS} FROM caldav_app_passwords ORDER BY created_at DESC
  `;
}

/**
 * Incrementa calendar_backend_state.credential_epoch dentro la transazione
 * `tx` di una revoca, rigenerazione o cancellazione (contratto §9.6). Il
 * trigger della 162 alza policy_version ed emette NOTIFY
 * calendar_policy_changed: il writer della policy la riscrive subito e
 * caldes_auth, al cambio di epoch, svuota entrambe le cache.
 *
 * Restituisce il nuovo epoch, oppure null se la riga singleton manca (non
 * dovrebbe mai succedere: un trigger ne vieta DELETE e TRUNCATE). In quel
 * caso la revoca resta valida: senza stato non c'è nemmeno una policy con un
 * credential_epoch noto, e caldes_auth non usa alcuna voce di cache.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TransactionSql di postgres-js perde la firma di chiamata
export async function bumpCredentialEpoch(tx: any): Promise<number | null> {
  const rows = (await tx`
    UPDATE calendar_backend_state
    SET credential_epoch = credential_epoch + 1
    WHERE id
    RETURNING credential_epoch
  `) as Array<{ credential_epoch: number }>;
  if (!rows.length) {
    log.error('calendar_backend_state assente: credential_epoch non incrementato');
    return null;
  }
  return Number(rows[0].credential_epoch);
}

/**
 * Revoca un'app-password e, nella stessa transazione, incrementa
 * credential_epoch. Una revoca ripetuta (o di un id inesistente) non tocca
 * l'epoch e restituisce false.
 */
export async function revokeAppPassword(id: string, reason = 'revoked from admin'): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vedi bumpCredentialEpoch
  return await sql.begin(async (tx: any) => {
    const rows = await tx`
      UPDATE caldav_app_passwords
      SET is_active = false, revoked_at = now(), revoked_reason = ${reason}
      WHERE id = ${id}::uuid AND revoked_at IS NULL
      RETURNING id
    `;
    if (!rows.length) return false;
    await bumpCredentialEpoch(tx);
    return true;
  });
}

// ─── Verifica (verify-credentials) ──────────────────────────

export interface VerifyCredentialsResult {
  ok: boolean;
  /** Principal canonico (solo con ok). */
  principal?: string;
  /** Scadenza dell'app-password in ISO 8601 UTC, null se non scade (solo con ok). */
  expires_at?: string | null;
  /** Motivo del rifiuto, solo per i log (mai nella risposta HTTP). */
  reason?: 'malformed' | 'reserved' | 'not_found';
}

/**
 * Valida le credenziali Basic di un device CalDAV (contratto §9.4).
 *
 * - Login malformati e username riservati (`caldes-*`) → rifiutati senza
 *   toccare il database.
 * - L'app-password è legata al proprio username: la coppia deve coincidere
 *   con una riga attiva, non revocata e non scaduta (come prima della F1).
 * - Con credenziali valide il principal è SEMPRE quello canonico, qualunque
 *   sia lo username.
 * - last_used_at, last_used_ip e usage_count si aggiornano in best effort:
 *   un errore di quella scrittura non nega mai credenziali valide.
 *
 * Lancia CaldavPrincipalConfigError (configurazione) o gli errori del
 * database: la route li trasforma in un errore del backend (503), che per
 * caldes_auth NON è una negazione.
 */
export async function verifyCredentials(
  username: string,
  password: string,
  ip?: string | null,
): Promise<VerifyCredentialsResult> {
  if (typeof username !== 'string' || typeof password !== 'string' || !isVerifiableLogin(username, password)) {
    return { ok: false, reason: 'malformed' };
  }
  if (isReservedUsername(username)) return { ok: false, reason: 'reserved' };

  const principal = caldavPrincipal();
  const hash = hashAppPassword(password);
  const rows = await sql<{ id: string; expires_at: Date | string | null }[]>`
    SELECT id, expires_at FROM caldav_app_passwords
    WHERE token_hash = ${hash}
      AND username = ${username}
      AND is_active = true
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };

  try {
    await sql`
      UPDATE caldav_app_passwords
      SET last_used_at = now(), last_used_ip = ${ip ?? null}, usage_count = COALESCE(usage_count, 0) + 1
      WHERE id = ${row.id}
    `;
  } catch (err) {
    log.warn({ err: { code: (err as { code?: string }).code, message: (err as Error).message } }, 'aggiornamento di last_used non riuscito');
  }

  return {
    ok: true,
    principal,
    expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
  };
}
