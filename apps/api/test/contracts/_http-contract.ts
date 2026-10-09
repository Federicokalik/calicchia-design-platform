/**
 * Contratti HTTP (sito, feed, agenda device, capacity): una voce di snapshot
 * per ogni risposta dell'app reale, normalizzata con helpers/normalize.ts e
 * salvata con JsonContractStore (_json-contract.ts) in
 * __snapshots__/<contratto>.contract.json.
 *
 * Forma di una voce (`"<gruppo>/<caso>": {...}`):
 *  - request: metodo, percorso (con token e uid già sostituiti), query, body e
 *    tipo di autenticazione, così il diff in review dice cosa è stato chiesto;
 *  - status e un sottoinsieme fisso di header (quelli che i client usano:
 *    content-type, content-disposition, cache-control, CORS, ETag);
 *  - body: JSON normalizzato, oppure `ics` (righe iCalendar dopo l'unfold, con
 *    DTSTAMP e UID sostituiti) oppure `text` per i corpi testuali;
 *  - effects (facoltativo): righe del database lette dopo la richiesta.
 *
 * Ogni caso usa un normalizzatore proprio (segnaposto numerati da 1), con
 * alias leggibili per i valori noti dello scenario: lo snapshot di un caso non
 * dipende da quali altri casi sono stati eseguiti (run filtrati con
 * --test-name-pattern).
 *
 * Aggiornamento: UPDATE_SNAPSHOTS=1 (oppure --test-update-snapshots), vedi
 * _json-contract.ts. Le differenze ammesse fra gli store stanno in
 * allowed-diffs.json con contract = id del contratto.
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TestResponse } from '../helpers/http';
import type { SnapshotNormalizer } from '../helpers/normalize';
import { JsonContractStore } from './_json-contract';

const CONTRACTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Header registrati negli snapshot (in minuscolo); gli altri sono infrastruttura. */
export const CONTRACT_HEADERS: readonly string[] = [
  'content-type',
  'content-disposition',
  'cache-control',
  'access-control-allow-origin',
  'etag',
];

/** Richiesta come compare nello snapshot. */
export interface HttpContractRequest {
  method: string;
  /** Percorso con token e uid sostituiti da segnaposto (normalizzato). */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Tipo di autenticazione usata (es. 'admin', 'device', 'nessuna'). */
  auth?: string;
}

/** Voce di snapshot di un contratto HTTP. */
export interface HttpContractEntry {
  request: HttpContractRequest;
  status: number;
  headers: Record<string, string | null>;
  body?: unknown;
  ics?: string[];
  text?: string;
  effects?: unknown;
}

/** Store degli snapshot del contratto `contract` (file __snapshots__/<contract>.contract.json). */
export function httpContractStore(contract: string, testFile: string, description: string): JsonContractStore<HttpContractEntry> {
  return new JsonContractStore<HttpContractEntry>({
    contract,
    file: resolve(CONTRACTS_DIR, `__snapshots__/${contract}.contract.json`),
    description,
    regenerate: `UPDATE_SNAPSHOTS=1 pnpm --filter @calicchia/api test test/contracts/${testFile}`,
  });
}

/**
 * Registra il test finale di copertura del contratto: fallisce se nello
 * snapshot restano casi non più eseguiti (un caso rinominato o tolto dal
 * file). Va chiamata dopo tutti i test che registrano casi. Nei run filtrati
 * si salta; in aggiornamento il flush di un run completo rimuove già i casi
 * obsoleti.
 */
export function contractCoverageTest(store: JsonContractStore<HttpContractEntry>, testFile: string): void {
  test('copertura: nessun caso obsoleto nello snapshot del contratto', (t) => {
    if (store.filtered) {
      t.skip('run filtrato: la copertura si verifica solo sul file completo');
      return;
    }
    if (store.updating) return;
    assert.deepEqual(
      store.staleCases(),
      [],
      `casi nello snapshot non più eseguiti (rigenera con UPDATE_SNAPSHOTS=1 e ${testFile})`,
    );
  });
}

export interface ResponseEntryOptions {
  request: HttpContractRequest;
  /** Come registrare il corpo: 'auto' sceglie in base al content-type (default). */
  bodyKind?: 'auto' | 'json' | 'ics' | 'text' | 'none';
  /**
   * Parte del corpo JSON da registrare (default tutto il corpo), per escludere
   * dati che non appartengono allo scenario (es. le righe seminate).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- corpo JSON arbitrario della risposta
  select?: (json: any) => unknown;
  /** Effetti sul database da registrare (già letti dal test, normalizzati qui). */
  effects?: unknown;
}

/**
 * Voce di snapshot per una risposta: richiesta, status, header del contratto
 * e corpo, tutto normalizzato con lo stesso normalizzatore (stessi segnaposto
 * per lo stesso valore in percorso, header, corpo ed effetti).
 */
export function responseEntry(res: TestResponse, n: SnapshotNormalizer, opts: ResponseEntryOptions): HttpContractEntry {
  // Prima il corpo e gli effetti, poi la richiesta: i segnaposto seguono
  // l'ordine di prima apparizione, e nel corpo i valori hanno una chiave
  // (uid, token...) che li classifica, mentre nel percorso sono solo testo.
  const kind = opts.bodyKind && opts.bodyKind !== 'auto' ? opts.bodyKind : detectBodyKind(res);
  const entry: Partial<HttpContractEntry> = {};
  if (kind === 'json') entry.body = n.normalize(opts.select ? opts.select(res.json) : res.json);
  else if (kind === 'ics') entry.ics = icsLines(n, res.text);
  else if (kind === 'text') entry.text = n.normalize(res.text) as string;
  if (opts.effects !== undefined) entry.effects = n.normalize(opts.effects);

  const headers: Record<string, string | null> = {};
  for (const name of CONTRACT_HEADERS) {
    const value = res.headers.get(name);
    headers[name] = value === null ? null : (n.normalize(value) as string);
  }

  const request = n.normalize(opts.request) as HttpContractRequest;
  return {
    request,
    status: res.status,
    headers,
    ...(entry.body !== undefined ? { body: entry.body } : {}),
    ...(entry.ics !== undefined ? { ics: entry.ics } : {}),
    ...(entry.text !== undefined ? { text: entry.text } : {}),
    ...(entry.effects !== undefined ? { effects: entry.effects } : {}),
  };
}

function detectBodyKind(res: TestResponse): 'json' | 'ics' | 'text' | 'none' {
  if (!res.text) return 'none';
  if (res.contentType?.includes('json')) return 'json';
  if (res.contentType?.includes('text/calendar')) return 'ics';
  return 'text';
}

/** Corpo iCalendar normalizzato come elenco di righe (diff leggibile nello snapshot). */
export function icsLines(n: SnapshotNormalizer, body: string): string[] {
  return n.normalizeIcs(body).replace(/\n$/, '').split('\n');
}

// ─── Utilità per le asserzioni leggibili ───────────────────────────────

const romeTime = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Ora locale di Roma ('HH:MM') di un istante ISO. */
export function romeHour(iso: string): string {
  return romeTime.format(new Date(iso));
}

/** slots_by_date → { data: ['HH:MM' di Roma, ...] }, per asserzioni a misura d'uomo. */
export function romeHoursByDate(slotsByDate: Record<string, Array<{ start: string }>>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(slotsByDate).map(([date, slots]) => [date, slots.map((s) => romeHour(s.start))]),
  );
}

/**
 * Righe iCalendar "logiche" (dopo l'unfold, RFC 5545 §3.1) di un corpo grezzo,
 * senza normalizzazione: per asserzioni puntuali su UID, EXDATE e simili.
 */
export function unfoldIcs(body: string): string[] {
  return body.replace(/\r\n[ \t]/g, '').split(/\r\n/).filter((line) => line.length > 0);
}

/** Blocchi VEVENT (righe logiche) di un corpo iCalendar grezzo. */
export function icsEvents(body: string): string[][] {
  const events: string[][] = [];
  let current: string[] | null = null;
  for (const line of unfoldIcs(body)) {
    if (line === 'BEGIN:VEVENT') current = [];
    else if (line === 'END:VEVENT' && current) {
      events.push(current);
      current = null;
    } else if (current) current.push(line);
  }
  return events;
}

/** Valore della prima proprietà `name` (senza parametri) in un VEVENT. */
export function icsProp(event: string[], name: string): string | undefined {
  const line = event.find((l) => l.split(':')[0].split(';')[0] === name);
  return line === undefined ? undefined : line.slice(line.indexOf(':') + 1);
}
