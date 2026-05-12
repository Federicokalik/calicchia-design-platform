import type { Context } from 'hono';
import { sql } from '../db';

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
    await sql`
      INSERT INTO portal_login_events
        (customer_id, email, event_type, success, ip, user_agent, error_code, metadata)
      VALUES (
        ${opts.customer_id ?? null},
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
    console.error('[portal-audit] insert failed:', (err as Error).message);
  }
}
