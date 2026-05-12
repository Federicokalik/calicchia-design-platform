import { createHash, randomBytes } from 'node:crypto';

export function generateMcpToken(): { token: string; hash: string; prefix: string } {
  const random = randomBytes(32).toString('hex'); // 64 char
  const token = `mcp_${random}`; // "mcp_<64hex>"
  const hash = createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, 12); // "mcp_abc123de" - visibile in UI
  return { token, hash, prefix };
}

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateOtp(): { code: string; hash: string } {
  const digits = randomBytes(3).readUIntBE(0, 3) % 1_000_000;
  const code = String(digits).padStart(6, '0'); // "048213"
  const hash = createHash('sha256').update(code).digest('hex');
  return { code, hash };
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
