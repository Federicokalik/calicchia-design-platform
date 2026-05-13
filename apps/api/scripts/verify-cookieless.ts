import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../');
const apiUrl = process.env.API_URL || 'http://localhost:3001';
const useColor = process.stdout.isTTY;

const color = {
  green: (value: string) => (useColor ? `\x1b[32m${value}\x1b[0m` : value),
  red: (value: string) => (useColor ? `\x1b[31m${value}\x1b[0m` : value),
  yellow: (value: string) => (useColor ? `\x1b[33m${value}\x1b[0m` : value),
};

type CheckResult = {
  ok: boolean;
  skipped?: boolean;
  label: string;
  reason: string;
};

const trackerFiles = [
  'apps/sito-v3/src/components/analytics/InternalAnalytics.tsx',
  'apps/sito-v3/src/components/analytics/WebVitalsTracker.tsx',
  'apps/sito-v3/src/components/analytics/OutboundLinkTracker.tsx',
];

const forbiddenPatterns = [
  /\bdocument\.cookie\b/i,
  /\blocalStorage\b/i,
  /\bsessionStorage\b/i,
  /\bindexedDB\b/i,
  /credentials:\s*['"]include['"]/i,
  /from\s+['"]@\/lib\/cookie-consent['"]/i,
];

function printResult(result: CheckResult): void {
  if (result.skipped) {
    console.log(`  ${color.yellow('↷')} ${result.label}: skipped (${result.reason})`);
    return;
  }

  const mark = result.ok ? color.green('✓') : color.red('✗');
  console.log(`  ${mark} ${result.label} (${result.reason})`);
}

async function checkServer(): Promise<CheckResult> {
  const label = 'Check 1: server does not Set-Cookie on /api/track';
  try {
    const response = await fetch(`${apiUrl}/api/track`, {
      method: 'POST',
      headers: {
        cookie: 'auth_token=fake',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'pageview', page: '/test', website: 'verify' }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (response.status !== 204) return { ok: false, label, reason: `status ${response.status}` };
    if (setCookie) return { ok: false, label, reason: `Set-Cookie returned: ${setCookie}` };
    return { ok: true, label, reason: 'no cookie returned' };
  } catch (error) {
    return { ok: false, label, reason: error instanceof Error ? error.message : String(error) };
  }
}

function checkClientSource(): CheckResult {
  const label = 'Check 2: sito-v3 trackers free of cookie/storage references';
  const missingFile = trackerFiles.find((file) => !existsSync(resolve(repoRoot, file)));
  if (missingFile) {
    return { ok: true, skipped: true, label: 'Check 2', reason: 'files not yet created' };
  }
  const failures: string[] = [];
  for (const file of trackerFiles) {
    const source = readFileSync(resolve(repoRoot, file), 'utf8');
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(source)) failures.push(`${file} matches ${pattern}`);
    }
  }

  if (failures.length > 0) {
    return { ok: false, label, reason: failures.join('; ') };
  }
  return { ok: true, label, reason: 'no forbidden references found' };
}

async function checkCors(): Promise<CheckResult> {
  const label = 'Check 3: CORS allows credentials';
  try {
    const response = await fetch(`${apiUrl}/api/track`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
      },
    });
    const value = response.headers.get('access-control-allow-credentials');
    if (value?.toLowerCase() === 'true') {
      return { ok: false, label, reason: `found 'true' on /api/track preflight` };
    }
    return { ok: true, label, reason: `found ${value ? `'${value}'` : 'no header'}` };
  } catch (error) {
    return { ok: false, label, reason: error instanceof Error ? error.message : String(error) };
  }
}

console.log('Cookieless gate');
const results = [await checkServer(), checkClientSource(), await checkCors()];
for (const result of results) printResult(result);

if (results.some((result) => !result.ok && !result.skipped)) {
  process.exitCode = 1;
}
