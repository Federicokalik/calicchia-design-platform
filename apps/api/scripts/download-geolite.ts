import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..');
const dataDir = resolve(apiRoot, 'data');
const outputPath = resolve(dataDir, 'GeoLite2-City.mmdb');

function findMmdb(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findMmdb(path);
      if (found) return found;
    }
    if (entry.isFile() && basename(path) === 'GeoLite2-City.mmdb') {
      return path;
    }
  }
  return null;
}

function moveFile(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'EXDEV') throw error;
    copyFileSync(source, destination);
    unlinkSync(source);
  }
}

async function extractTarball(response: Response, tempDir: string): Promise<void> {
  if (!response.body) {
    throw new Error('MaxMind response did not include a body');
  }

  const tar = spawn('tar', ['-xzf', '-', '-C', tempDir, '--wildcards', '*/GeoLite2-City.mmdb']);
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.pipe(tar.stdin);

  await new Promise<void>((resolvePromise, reject) => {
    source.on('error', reject);
    tar.on('error', reject);
    tar.stderr.on('data', (chunk) => process.stderr.write(chunk));
    tar.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`tar exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const key = process.env.MAXMIND_LICENSE_KEY?.trim();
  if (!key) {
    console.log('MAXMIND_LICENSE_KEY not set, skipping geo download');
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'geolite-'));
  const url = `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${encodeURIComponent(key)}&suffix=tar.gz`;

  try {
    mkdirSync(dataDir, { recursive: true });

    console.log('Downloading from MaxMind...');
    const response = await fetch(url);
    if (response.status !== 200) {
      console.error(`MaxMind download failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    console.log('Extracting...');
    await extractTarball(response, tempDir);

    const extractedPath = findMmdb(tempDir);
    if (!extractedPath || !existsSync(extractedPath)) {
      throw new Error('GeoLite2-City.mmdb was not found in the downloaded archive');
    }

    moveFile(extractedPath, outputPath);
    const sizeMb = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`Saved to ${outputPath} (${sizeMb} MB)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`GeoLite download failed: ${message}`);
    process.exitCode = 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
