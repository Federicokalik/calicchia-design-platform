/**
 * analytics-geo-refresh — Best-effort monthly refresh of the GeoLite2-City.mmdb
 * file by re-running the download-geolite.ts script. If MAXMIND_LICENSE_KEY
 * is missing the script no-ops, so this is safe to run unconditionally.
 *
 * Spawns the tsx process so we don't have to import the script's side effects.
 */
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = resolve(__dirname, '../../scripts/download-geolite.ts');

export async function runAnalyticsGeoRefresh(): Promise<void> {
  return new Promise((res) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', SCRIPT],
      { env: process.env, stdio: 'inherit' },
    );
    child.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[analytics-geo-refresh] download script exited ${code}`);
      }
      res();
    });
    child.on('error', () => res());
  });
}
