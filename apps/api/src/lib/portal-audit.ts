import type { Context } from 'hono';
import { sql } from '../db';
import { logger } from './logger';

const log = logger.child({ scope: 'portal-audit' });

export type PortalAuthEvent =
  | 'link_requested'
  | 'link_consumed'
  | 'link_invalid'
  | 'link_expired'
  | 'code_login_success'
  | 'code_login_failed'
  | 'logout'
  | 'sessions_revoked';

interface AuditOptions {
  customer_id?: string | null;
  /** Audit B-011: who actually triggered the event — works for collaborators too,
   * unlike the legacy customer_id (FK on customers, NULL for collabs). */
  actor_id?: string | null;
  actor_role?: 'client' | 'collaborator' | null;
  email?: string | null;
  success?: boolean;
  error_code?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Defensive audit logger — never throws (failure to write a log row must
 * not fail an auth request). Captures IP and UA from the request headers.
 */
export async function auditPortalEvent(
  c: Context,
  event_type: PortalAuthEvent,
  opts: AuditOptions = {}
): Promise<void> {
  try {
    const ipHeader =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      null;
    const ua = c.req.header('user-agent') ?? null;
    // If caller passed customer_id but not actor_id, mirror to actor_role='client'
    // for the unified-audit query (back-compat — old call sites kept working).
    const actorId = opts.actor_id ?? opts.customer_id ?? null;
    const actorRole = opts.actor_role ?? (opts.customer_id ? 'client' : null);
    await sql`
      INSERT INTO portal_login_events
        (customer_id, actor_id, actor_role, email, event_type, success, ip, user_agent, error_code, metadata)
      VALUES (
        ${opts.customer_id ?? null},
        ${actorId},
        ${actorRole},
        ${opts.email?.toLowerCase().trim() ?? null},
        ${event_type},
        ${opts.success ?? false},
        ${ipHeader},
        ${ua},
        ${opts.error_code ?? null},
        ${JSON.stringify(opts.metadata ?? {})}
      )
    `;
  } catch (err) {
    // Best-effort — log to stderr and move on.
    log.error({ err }, 'insert failed');
  }
}
