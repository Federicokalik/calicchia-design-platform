#!/usr/bin/env node
/**
 * One-off refactor: rimuove dai data file le entries dei servizi deprecated
 * (branding, comunicazione, comunicazione-offline, automazioni-ai) e rinomina
 * la chiave 'web-app' → 'sviluppo-web'.
 *
 * Files:
 *  - src/data/comune-service-content.ts (TEMPLATES record + FALLBACK + SERVICE_LABELS)
 *  - src/data/seo-service-content.ts (CONTENT record finale)
 *
 * Logica:
 *  - Multi-line block: identifica `'KEY': {` con indent 2 (start) e cancella fino
 *    al `},` con stesso indent (end). Conserva commenti che precedono.
 *  - One-liner record entry: regex `^\s*'KEY':\s+.*,$`.
 *  - Rinomina: replace su `'web-app'` → `'sviluppo-web'` (chiave) — ma SOLO
 *    nei file target, non nei valori string user-facing.
 *
 * Eseguibile una volta sola; lo script va eliminato dopo Fase 1 chiusa.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const FILES = {
  comune: resolve(ROOT, 'src/data/comune-service-content.ts'),
  seoContent: resolve(ROOT, 'src/data/seo-service-content.ts'),
};

const DEAD_KEYS = ['branding', 'comunicazione', 'comunicazione-offline', 'automazioni-ai'];
const RENAME_KEY = { from: 'web-app', to: 'sviluppo-web' };

/**
 * Rimuove blocchi multi-riga `  'KEY': {` ... `  },` con indent 2.
 * Cancella anche eventuali righe-commento (// ─── ...) immediatamente sopra.
 */
function stripMultiLineBlocks(source, keys) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let i = 0;
  let removed = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Match `  'KEY': {` con indent 2 (block opener in record)
    const m = line.match(/^(\s{2})'([^']+)':\s*\{\s*$/);
    if (m && keys.includes(m[2])) {
      const indent = m[1];
      // Backtrack: rimuovi commenti/blank line immediatamente sopra
      while (out.length > 0) {
        const prev = out[out.length - 1];
        if (/^\s{0,2}\/\/.*$/.test(prev) || /^\s*$/.test(prev)) {
          out.pop();
          continue;
        }
        break;
      }
      // Avanza fino al `  },` di chiusura matching
      i++;
      while (i < lines.length) {
        if (lines[i] === `${indent}},`) {
          i++; // consume closing line
          break;
        }
        i++;
      }
      removed++;
      continue;
    }
    out.push(line);
    i++;
  }
  return { source: out.join('\n'), removed };
}

/**
 * Rimuove entries one-liner di un Record:
 *   `  'KEY': '...',` oppure `  'KEY':   '...',` (allineamento variabile)
 */
function stripOneLinerEntries(source, keys) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let removed = 0;
  for (const line of lines) {
    const m = line.match(/^\s{2}'([^']+)':\s+.*,\s*$/);
    if (m && keys.includes(m[1])) {
      removed++;
      continue;
    }
    out.push(line);
  }
  return { source: out.join('\n'), removed };
}

/**
 * Rinomina chiave Record (sia multi-line opener che one-liner).
 * Es. `  'web-app': {` → `  'sviluppo-web': {`
 *     `  'web-app':  '...',` → `  'sviluppo-web':  '...',`
 */
function renameKey(source, fromKey, toKey) {
  const re = new RegExp(`^(\\s{2})'${fromKey}'(\\s*:)`, 'gm');
  let count = 0;
  const next = source.replace(re, (_, sp, colon) => {
    count++;
    return `${sp}'${toKey}'${colon}`;
  });
  return { source: next, renamed: count };
}

// ─── COMUNE-SERVICE-CONTENT.ts ────────────────────────────────────
{
  let src = await readFile(FILES.comune, 'utf8');
  let totalRemoved = 0;
  let totalRenamed = 0;

  // 1. TEMPLATES: blocchi multi-line per 4 dead keys
  const r1 = stripMultiLineBlocks(src, DEAD_KEYS);
  src = r1.source;
  totalRemoved += r1.removed;

  // 2. FALLBACK: blocchi multi-line per 4 dead keys (stesso indent 2)
  // (già coperto dal pass 1 perché stesso indent)

  // 3. SERVICE_LABELS: one-liner per 4 dead keys
  const r2 = stripOneLinerEntries(src, DEAD_KEYS);
  src = r2.source;
  totalRemoved += r2.removed;

  // 4. Rinomina 'web-app' → 'sviluppo-web' (chiavi in TEMPLATES + FALLBACK + SERVICE_LABELS)
  const r3 = renameKey(src, RENAME_KEY.from, RENAME_KEY.to);
  src = r3.source;
  totalRenamed += r3.renamed;

  await writeFile(FILES.comune, src, 'utf8');
  console.log(`[ok] comune-service-content.ts — removed ${totalRemoved} entries, renamed ${totalRenamed} keys`);
}

// ─── SEO-SERVICE-CONTENT.ts ───────────────────────────────────────
{
  let src = await readFile(FILES.seoContent, 'utf8');
  let totalRemoved = 0;

  // CONTENT record finale: entry `  branding: { ... }` con indent 2
  // Anche varianti senza quote: `  branding: BRANDING_CONTENT,`
  const r1 = stripMultiLineBlocks(src, DEAD_KEYS);
  src = r1.source;
  totalRemoved += r1.removed;

  // One-liner senza quote (es. `  branding: BRANDING_CONTENT,`)
  const lines = src.split(/\r?\n/);
  const out = [];
  let removed = 0;
  for (const line of lines) {
    const m = line.match(/^\s{2}([a-z-]+):\s+[A-Z_]+,\s*$/);
    if (m && DEAD_KEYS.includes(m[1])) {
      removed++;
      continue;
    }
    out.push(line);
  }
  src = out.join('\n');
  totalRemoved += removed;

  await writeFile(FILES.seoContent, src, 'utf8');
  console.log(`[ok] seo-service-content.ts — removed ${totalRemoved} entries`);
}

console.log('\nDone.');
