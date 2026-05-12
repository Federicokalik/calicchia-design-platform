import { sql } from '../../db';

export interface McpAuditEntry {
  tokenId: string;
  tokenLabel: string;
  ip: string;
  userAgent: string;
  tool: string;
  argsSummary: string;
  risk: 'low' | 'medium' | 'high';
  otpRequired: boolean;
  durationMs?: number;
  success: boolean;
  error?: string;
}

export async function writeMcpAudit(e: McpAuditEntry): Promise<void> {
  await sql`
    INSERT INTO audit_logs (
      action, table_name, user_email,
      new_data, ip_address, user_agent, metadata, created_at
    ) VALUES (
      ${e.success ? 'INSERT' : 'UPDATE'},
      'mcp_call',
      ${'mcp:' + e.tokenLabel},
      ${JSON.stringify({ tool: e.tool, args_summary: e.argsSummary, risk: e.risk, otp_required: e.otpRequired, success: e.success, error: e.error })}::jsonb,
      ${e.ip},
      ${e.userAgent},
      ${JSON.stringify({ mcp_token_id: e.tokenId, duration_ms: e.durationMs })}::jsonb,
      now()
    )
  `.catch((err: unknown) => console.error('[mcp-audit]', err));
}

export function summarizeArgs(args: Record<string, unknown>): string {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (/password|secret|token/i.test(k)) {
      safe[k] = '***';
      continue;
    }
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const normalized = s ?? 'null';
    safe[k] = normalized.length > 80 ? normalized.slice(0, 80) + '…' : normalized;
  }
  return JSON.stringify(safe).slice(0, 500);
}
