/**
 * Utilità condivise dai test di @calicchia/calendar-core.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(TEST_DIR, 'fixtures');
export const REPO_ROOT = resolve(TEST_DIR, '../../..');

/** Testo di una fixture (test/fixtures/<nome>), con le fini riga del file. */
export function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf8');
}

/** Byte di una fixture. */
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES_DIR, name)));
}

/** Righe iCalendar con CRLF a partire da un array (comodo per i casi inline). */
export function ics(lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`;
}

/** DTSTAMP generati con l'orologio di sistema → valore fisso, per confrontare i testi. */
export function normalizeDtstamp(text: string, stamp = '20261009T080000Z'): string {
  return text.replace(/^DTSTAMP:\d{8}T\d{6}Z$/gm, `DTSTAMP:${stamp}`);
}

/**
 * Verifica la forma fisica di un testo serializzato: CRLF ovunque (anche in
 * fondo), righe di al massimo 75 ottetti, nessun code point spezzato (ogni
 * riga è UTF-8 valido da sola).
 */
export function assertPhysicalForm(text: string): void {
  assert.ok(text.endsWith('\r\n'), 'il testo deve finire con CRLF');
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(text), 'solo fini riga CRLF');
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8', { fatal: true });
  const lines = text.slice(0, -2).split('\r\n');
  for (const line of lines) {
    const bytes = enc.encode(line);
    assert.ok(bytes.byteLength <= 75, `riga di ${bytes.byteLength} ottetti: ${line.slice(0, 40)}…`);
    assert.doesNotThrow(() => dec.decode(bytes));
  }
}
