/**
 * Pre-calcolo delle foto e dei colori dei settori del tool "Palette di settore".
 *
 * Per ogni settore di PALETTE_SECTORS (sito-v3, src/data/risorse/palette/sectors)
 * cerca le 3 `queriesEn` su Unsplash e tiene fino a 4 foto nuove per ricerca
 * (deduplica per id, massimo 12). Di ogni foto scarica la miniatura 64×48 da
 * images.unsplash.com, la decodifica con jpeg-js ed estrae i colori col motore
 * condiviso, con seed fisso sull'id della foto (stesso input, stessi colori).
 * Il risultato è un SectorPhotoSet in apps/sito-v3/public/palette-data/{slug}.json
 * (JSON indentato, chiavi in ordine fisso) che il sito legge senza chiamate a
 * Unsplash.
 *
 * Quota: con l'app Unsplash in demo sono 50 richieste l'ora, condivise col
 * generatore di copertine del blog. Ogni settore costa 3 ricerche (le
 * miniature non contano). Prima di ogni settore, se le richieste rimaste
 * (X-Ratelimit-Remaining) sono meno di 3, lo script si ferma con exit 2:
 * si riprende rilanciando lo stesso comando, i settori già scritti si saltano.
 * L'endpoint di download di Unsplash qui non si chiama: si registra quando un
 * visitatore usa davvero la foto (POST /api/palette/download).
 *
 * Uso (da apps/api; serve UNSPLASH_ACCESS_KEY nell'ambiente o nel .env della root):
 *   pnpm palette:precompute                        settori senza JSON
 *   pnpm palette:precompute -- --only pizzerie     solo i settori indicati (ripetibile)
 *   pnpm palette:precompute -- --force             riscrive anche i JSON presenti
 *   pnpm palette:precompute -- --check             verifica che gli URL small salvati rispondano ancora
 *
 * Exit: 0 ok, 1 errori (settori falliti o foto rotte con --check), 2 fermato per quota.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as jpeg from 'jpeg-js';
import { createRng, extractFromPixels, hashString } from '@calicchia/shared/palette';
import type { PalettePhoto, SectorPhotoSet, StoredCluster } from '@calicchia/shared/palette';
import {
  UnsplashError,
  extractionThumbUrl,
  isUnsplashConfigured,
  searchPhotos,
  toPalettePhoto,
  type UnsplashPhoto,
} from '../src/lib/unsplash';

// sito-v3 non è "type": "module": tsx compila i suoi .ts come CommonJS e un
// import ESM non vede gli export nominati. Con require() arrivano tutti.
const require = createRequire(import.meta.url);
const { PALETTE_SECTORS } = require(
  '../../sito-v3/src/data/risorse/palette/sectors/index.ts',
) as typeof import('../../sito-v3/src/data/risorse/palette/sectors/index');

const OUT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../sito-v3/public/palette-data');

/** Foto nuove tenute per ogni ricerca. */
const PER_QUERY = 4;
/** Risultati chiesti per ricerca: margine per duplicati e miniature illeggibili. */
const PER_PAGE = 10;
/** Ricerche necessarie per un settore: sotto questa quota non se ne inizia un altro. */
const MIN_REMAINING = 3;
/** Sotto questa soglia di foto il settore viene scritto ma segnalato. */
const MIN_PHOTOS = 6;
/** La quota Unsplash si azzera ogni ora. */
const RESUME_MINUTES = 60;
const FETCH_TIMEOUT_MS = 15_000;

const { values: opts } = parseArgs({
  options: {
    only: { type: 'string', multiple: true },
    force: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
  },
});

class QuotaStop extends Error {}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Colori dominanti di una foto dalla sua miniatura; null se non si legge. */
async function extractPhoto(photo: UnsplashPhoto): Promise<StoredCluster[] | null> {
  const res = await fetch(extractionThumbUrl(photo), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const { data } = jpeg.decode(new Uint8Array(await res.arrayBuffer()), {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 1,
  });
  const clusters = extractFromPixels(data, createRng(hashString(photo.id)));
  return clusters.length ? clusters.map((c) => ({ hex: c.hex, w: round(c.w) })) : null;
}

interface QueryReport {
  query: string;
  kept: number;
  total: number;
}

let remaining: number | null = null;

async function buildSet(slug: string, queries: readonly string[]): Promise<{ set: SectorPhotoSet; report: QueryReport[] }> {
  const seen = new Set<string>();
  const photos: PalettePhoto[] = [];
  const report: QueryReport[] = [];

  for (const query of queries) {
    let result;
    try {
      result = await searchPhotos(query, { perPage: PER_PAGE, orientation: 'landscape', contentFilter: 'high' });
    } catch (e) {
      if (e instanceof UnsplashError && (e.status === 403 || e.status === 429)) {
        throw new QuotaStop(`Unsplash ha risposto ${e.status} su "${query}"`);
      }
      throw e;
    }
    if (result.rateLimitRemaining !== null) remaining = result.rateLimitRemaining;

    let kept = 0;
    for (const photo of result.photos) {
      if (kept >= PER_QUERY) break;
      if (seen.has(photo.id)) continue;
      seen.add(photo.id);
      try {
        const clusters = await extractPhoto(photo);
        if (!clusters) {
          console.warn(`  [skip] ${photo.id}: miniatura non leggibile`);
          continue;
        }
        photos.push(toPalettePhoto(photo, clusters));
        kept++;
      } catch (e) {
        console.warn(`  [skip] ${photo.id}: ${(e as Error).message}`);
      }
    }
    report.push({ query, kept, total: result.total });
    console.log(`  "${query}": ${kept} foto (${result.total} risultati, quota rimasta ${remaining ?? '?'})`);
  }

  return {
    set: { slug, queries: [...queries], generatedAt: new Date().toISOString(), photos },
    report,
  };
}

function selectedSectors() {
  const only = opts.only ?? [];
  const known = new Set(PALETTE_SECTORS.map((s) => s.slug));
  const unknown = only.filter((s) => !known.has(s));
  if (unknown.length) throw new Error(`settori sconosciuti: ${unknown.join(', ')}`);
  return only.length ? PALETTE_SECTORS.filter((s) => only.includes(s.slug)) : PALETTE_SECTORS;
}

async function precompute(): Promise<number> {
  if (!isUnsplashConfigured()) throw new Error('UNSPLASH_ACCESS_KEY non configurata');
  await mkdir(OUT_DIR, { recursive: true });

  const sectors = selectedSectors();
  const failed: string[] = [];
  const thin: string[] = [];
  let written = 0;

  for (const sector of sectors) {
    const file = resolve(OUT_DIR, `${sector.slug}.json`);
    if (existsSync(file) && !opts.force) {
      console.log(`[skip] ${sector.slug} — JSON già presente (--force per rifarlo)`);
      continue;
    }
    if (remaining !== null && remaining < MIN_REMAINING) {
      console.error(
        `\nQuota Unsplash quasi finita (${remaining} richieste rimaste). Riprendi tra ${RESUME_MINUTES} minuti ` +
          'con lo stesso comando: i settori già scritti vengono saltati.',
      );
      return 2;
    }

    console.log(`[run] ${sector.slug}`);
    try {
      const { set, report } = await buildSet(sector.slug, sector.queriesEn);
      if (!set.photos.length) {
        failed.push(`${sector.slug}: nessuna foto utilizzabile`);
        continue;
      }
      await writeFile(file, `${JSON.stringify(set, null, 2)}\n`, 'utf8');
      written++;
      console.log(`[ok]   ${sector.slug} — ${set.photos.length} foto`);
      if (set.photos.length < MIN_PHOTOS) {
        const weak = report.filter((r) => r.kept < PER_QUERY).map((r) => `"${r.query}" ${r.kept}`);
        thin.push(`${sector.slug}: ${set.photos.length} foto (${weak.join(', ')})`);
      }
    } catch (e) {
      if (e instanceof QuotaStop) {
        console.error(
          `\n${e.message}: quota esaurita. Riprendi tra ${RESUME_MINUTES} minuti con lo stesso comando ` +
            `(${sector.slug} non è stato scritto).`,
        );
        return 2;
      }
      if (e instanceof UnsplashError && e.status === 401) throw e;
      failed.push(`${sector.slug}: ${(e as Error).message}`);
      console.error(`[FAIL] ${sector.slug} — ${(e as Error).message}`);
    }
  }

  console.log(`\n=== Summary ===\nScritti: ${written}  |  Falliti: ${failed.length}  |  Quota rimasta: ${remaining ?? '?'}`);
  if (thin.length) console.log(`Settori con meno di ${MIN_PHOTOS} foto:\n  - ${thin.join('\n  - ')}`);
  if (failed.length) console.log(`Falliti:\n  - ${failed.join('\n  - ')}`);
  return failed.length ? 1 : 0;
}

/** Stato HTTP di un URL immagine (HEAD, con GET di riserva se HEAD non è ammesso). */
async function probe(url: string): Promise<string | null> {
  try {
    let res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 405) res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (e) {
    return (e as Error).message;
  }
}

async function check(): Promise<number> {
  const sectors = selectedSectors();
  const known = new Set(sectors.map((s) => s.slug));
  const files = existsSync(OUT_DIR) ? (await readdir(OUT_DIR)).filter((f) => f.endsWith('.json')) : [];
  const broken: string[] = [];
  const present = new Set<string>();

  for (const f of files) {
    const slug = f.slice(0, -'.json'.length);
    if (opts.only?.length && !known.has(slug)) continue;
    present.add(slug);
    if (!PALETTE_SECTORS.some((s) => s.slug === slug)) console.warn(`[warn] ${f}: settore non più in PALETTE_SECTORS`);
    const set = JSON.parse(await readFile(resolve(OUT_DIR, f), 'utf8')) as SectorPhotoSet;
    const results = await Promise.all(set.photos.map(async (p) => ({ p, err: await probe(p.small) })));
    const bad = results.filter((r) => r.err);
    for (const { p, err } of bad) broken.push(`${slug}/${p.id}: ${err} — ${p.small}`);
    console.log(`${bad.length ? '[FAIL]' : '[ok]  '} ${slug} — ${set.photos.length - bad.length}/${set.photos.length} foto raggiungibili`);
  }

  const missing = sectors.filter((s) => !present.has(s.slug)).map((s) => s.slug);
  if (missing.length) console.warn(`\nSettori senza JSON: ${missing.join(', ')}`);
  if (broken.length) console.log(`\nFoto rotte (${broken.length}):\n  - ${broken.join('\n  - ')}`);
  else console.log('\nNessuna foto rotta.');
  return broken.length ? 1 : 0;
}

(opts.check ? check() : precompute())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error('Fatal:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
