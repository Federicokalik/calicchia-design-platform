#!/usr/bin/env node
/**
 * One-off refactor: rimuove tutti i blocchi `pricing: { ... }` e `pricing: [ ... ]`
 * dai data file di apps/sito-v3.
 *
 * Targets:
 *  - src/data/services-detail.ts → `pricing: { plans: [...], deliveryTime?, note? },`
 *  - src/data/seo-service-content.ts → `pricing: [ {label,...}, ... ],`
 *
 * Eseguibile una volta sola; lo script verrà eliminato dopo Fase 2 chiusa.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const FILES = [
  resolve(ROOT, 'src/data/services-detail.ts'),
  resolve(ROOT, 'src/data/seo-service-content.ts'),
];

/**
 * Rimuove un blocco multi-riga indentato che inizia con la riga `prefix`
 * (es. "    pricing: {" o "    pricing: [") e finisce con la riga `suffix`
 * (es. "    },") corrispondente alla stessa indentazione.
 *
 * Lavora su array di righe per evitare regex su body annidati con `{}` o `[]`.
 */
function stripBlocks(source, openMatch, closeMatch) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let inBlock = false;

  for (const line of lines) {
    if (!inBlock) {
      if (openMatch.test(line)) {
        inBlock = true;
        continue;
      }
      out.push(line);
    } else {
      if (closeMatch.test(line)) {
        inBlock = false;
      }
      // Skip everything while inBlock (incluso il delimitatore di chiusura)
    }
  }

  return out.join('\n');
}

async function processFile(path) {
  const original = await readFile(path, 'utf8');

  // services-detail.ts: pricing è oggetto `pricing: { plans: [ ... ], ... },`
  // seo-service-content.ts: pricing è array `pricing: [ ... ],`
  // Le indentazioni sono coerenti: `    pricing: {` / `    pricing: [`
  // e chiudono con `    },` / `    ],` allo stesso livello di indentazione.
  const openObj = /^\s{4}pricing:\s*\{\s*$/;
  const closeObj = /^\s{4}\},\s*$/;
  const openArr = /^\s{4}pricing:\s*\[\s*$/;
  const closeArr = /^\s{4}\],\s*$/;

  let next = original;
  let removedCount = 0;

  // Pass 1: oggetti
  const beforeObj = next;
  next = stripBlocks(next, openObj, closeObj);
  if (beforeObj !== next) {
    removedCount += (beforeObj.match(openObj) ?? beforeObj.split('\n').filter(l => openObj.test(l))).length || 0;
  }

  // Pass 2: array
  const beforeArr = next;
  next = stripBlocks(next, openArr, closeArr);
  if (beforeArr !== next) {
    removedCount += (beforeArr.split('\n').filter(l => openArr.test(l))).length;
  }

  if (next === original) {
    console.log(`[skip] ${path} — nothing to strip`);
    return { path, removed: 0 };
  }

  await writeFile(path, next, 'utf8');
  console.log(`[ok] ${path} — stripped pricing blocks`);
  return { path, removed: removedCount };
}

const results = await Promise.all(FILES.map(processFile));
const total = results.reduce((acc, r) => acc + r.removed, 0);
console.log(`\nDone. Removed ~${total} pricing block(s).`);
