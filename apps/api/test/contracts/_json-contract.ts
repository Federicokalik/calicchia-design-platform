/**
 * Snapshot di contratto in JSON leggibile, con differenze ammesse.
 *
 * Diversamente da `t.assert.snapshot` (un blob per test), qui ogni contratto
 * ha un file JSON committato in __snapshots__/ con un elemento per caso
 * (`"<tool>/<caso>": { args, output, effects }`): il diff in review è
 * leggibile e lo stesso file servirà in F2 per confrontare i due store
 * (PgLegacyStore e RadicaleStore), applicando le eccezioni motivate di
 * allowed-diffs.json (design §12).
 *
 * Confronto: uguaglianza semantica JSON (l'ordine delle chiavi degli oggetti
 * non conta, quello degli array sì). Le differenze che restano dopo le
 * eccezioni ammesse fanno fallire il test con l'elenco dei percorsi.
 *
 * Aggiornamento: `UPDATE_SNAPSHOTS=1` (oppure `--test-update-snapshots`, come
 * gli snapshot nativi) riscrive i casi eseguiti. In un run filtrato
 * (--test-name-pattern, --test-skip-pattern, --test-only) gli altri casi del
 * file restano invariati; in un run completo i casi non più eseguiti vengono
 * rimossi.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACTS_DIR = dirname(fileURLToPath(import.meta.url));

/** File delle differenze ammesse fra la baseline F0 e gli store successivi. */
export const ALLOWED_DIFFS_PATH = resolve(CONTRACTS_DIR, 'allowed-diffs.json');

// ─── Modalità del run ───────────────────────────────

/** True se il run deve riscrivere gli snapshot invece di confrontarli. */
export function isUpdatingSnapshots(): boolean {
  const env = process.env.UPDATE_SNAPSHOTS;
  return env === '1' || env === 'true' || process.execArgv.includes('--test-update-snapshots');
}

/** True se node --test esegue solo una parte dei test del file. */
export function isFilteredRun(): boolean {
  return process.execArgv.some((arg) =>
    arg.startsWith('--test-name-pattern') || arg.startsWith('--test-skip-pattern') || arg === '--test-only');
}

/** Store del calendario sotto test (matrice CI calendar-integration, design §15). */
export function currentCalendarBackend(): string {
  return process.env.CALENDAR_BACKEND || 'postgres';
}

// ─── Differenze JSON ───────────────────────────────

export type JsonDiffKind = 'changed' | 'added' | 'removed' | 'type';

export interface JsonDiff {
  /** JSON Pointer (RFC 6901) del valore, es. `/events/3/start_time`. */
  path: string;
  kind: JsonDiffKind;
  expected?: unknown;
  actual?: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const typeOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

const escapePointer = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Differenze fra due valori JSON. Gli array si confrontano per indice
 * (elementi in più o in meno come added/removed in coda), gli oggetti per
 * chiave senza badare all'ordine.
 */
export function diffJson(expected: unknown, actual: unknown, path = ''): JsonDiff[] {
  const te = typeOf(expected);
  const ta = typeOf(actual);
  if (te !== ta) return [{ path: path || '/', kind: 'type', expected, actual }];

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: JsonDiff[] = [];
    const max = Math.max(expected.length, actual.length);
    for (let i = 0; i < max; i++) {
      const p = `${path}/${i}`;
      if (i >= actual.length) out.push({ path: p, kind: 'removed', expected: expected[i] });
      else if (i >= expected.length) out.push({ path: p, kind: 'added', actual: actual[i] });
      else out.push(...diffJson(expected[i], actual[i], p));
    }
    return out;
  }

  if (isPlainObject(expected) && isPlainObject(actual)) {
    const out: JsonDiff[] = [];
    for (const key of Object.keys(expected)) {
      const p = `${path}/${escapePointer(key)}`;
      if (!(key in actual)) out.push({ path: p, kind: 'removed', expected: expected[key] });
      else out.push(...diffJson(expected[key], actual[key], p));
    }
    for (const key of Object.keys(actual)) {
      if (!(key in expected)) out.push({ path: `${path}/${escapePointer(key)}`, kind: 'added', actual: actual[key] });
    }
    return out;
  }

  return Object.is(expected, actual) ? [] : [{ path: path || '/', kind: 'changed', expected, actual }];
}

// ─── Differenze ammesse ───────────────────────────────

/** Voce di allowed-diffs.json (vedi la documentazione nel file). */
export interface AllowedDiff {
  id: string;
  contract: string;
  /** Glob sull'id del caso: `*` non attraversa '/', `**` sì. */
  case: string;
  /** JSON Pointer con `*` per un segmento e `**` per zero o più segmenti. */
  path: string;
  /** Tipo di differenza ammessa; assente = qualsiasi. */
  kind?: JsonDiffKind;
  /** Store a cui si applica (CALENDAR_BACKEND); assente = tutti. */
  stores?: string[];
  reason: string;
  design_ref: string;
  /** Fase in cui la differenza è stata introdotta (es. 'F2'). */
  added_in?: string;
}

interface AllowedDiffsFile {
  version: number;
  diffs: AllowedDiff[];
}

const REQUIRED_FIELDS = ['id', 'contract', 'case', 'path', 'reason', 'design_ref'] as const;
const OPTIONAL_FIELDS = ['kind', 'stores', 'added_in'] as const;
const DIFF_KINDS: readonly JsonDiffKind[] = ['changed', 'added', 'removed', 'type'];

/**
 * Legge e valida allowed-diffs.json: campi obbligatori non vuoti, nessun campo
 * sconosciuto, id univoci, `kind` e `stores` ben formati. Un file malformato
 * fa fallire il test invece di ammettere differenze per errore.
 */
export function loadAllowedDiffs(path = ALLOWED_DIFFS_PATH): AllowedDiff[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AllowedDiffsFile>;
  if (parsed.version !== 1) throw new Error(`${path}: version ${String(parsed.version)} non supportata (attesa 1)`);
  if (!Array.isArray(parsed.diffs)) throw new Error(`${path}: "diffs" deve essere un array`);

  const ids = new Set<string>();
  const known = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  parsed.diffs.forEach((raw: unknown, index) => {
    const where = `${path}: diffs[${index}]`;
    if (!isPlainObject(raw)) throw new Error(`${where} non è un oggetto`);
    for (const field of REQUIRED_FIELDS) {
      if (typeof raw[field] !== 'string' || !(raw[field] as string).trim()) {
        throw new Error(`${where}: campo obbligatorio "${field}" mancante o vuoto`);
      }
    }
    for (const field of Object.keys(raw)) {
      if (!known.has(field)) throw new Error(`${where}: campo sconosciuto "${field}"`);
    }
    if (raw.kind !== undefined && !DIFF_KINDS.includes(raw.kind as JsonDiffKind)) {
      throw new Error(`${where}: kind "${String(raw.kind)}" non valido (${DIFF_KINDS.join(', ')})`);
    }
    if (raw.stores !== undefined && (!Array.isArray(raw.stores) || raw.stores.some((s) => typeof s !== 'string' || !s))) {
      throw new Error(`${where}: "stores" deve essere un array di nomi di store`);
    }
    if (!(raw.path as string).startsWith('/')) throw new Error(`${where}: "path" deve essere un JSON Pointer (inizia con '/')`);
    if (ids.has(raw.id as string)) throw new Error(`${where}: id "${String(raw.id)}" duplicato`);
    ids.add(raw.id as string);
  });
  return parsed.diffs;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Confronto segmento per segmento di un JSON Pointer con `*` e `**`. */
function pointerMatches(pattern: string, path: string): boolean {
  const pat = pattern.split('/').slice(1);
  const segs = path === '/' ? [] : path.split('/').slice(1);
  const match = (pi: number, si: number): boolean => {
    if (pi === pat.length) return si === segs.length;
    if (pat[pi] === '**') {
      for (let k = si; k <= segs.length; k++) if (match(pi + 1, k)) return true;
      return false;
    }
    if (si === segs.length) return false;
    return (pat[pi] === '*' || pat[pi] === segs[si]) && match(pi + 1, si + 1);
  };
  return match(0, 0);
}

/** True se la differenza è coperta dalla voce per questo contratto, caso e store. */
export function isAllowedDiff(
  entry: AllowedDiff,
  ctx: { contract: string; caseId: string; store: string },
  diff: JsonDiff,
): boolean {
  if (entry.contract !== ctx.contract) return false;
  if (entry.stores && !entry.stores.includes(ctx.store)) return false;
  if (entry.kind && entry.kind !== diff.kind) return false;
  return globToRegExp(entry.case).test(ctx.caseId) && pointerMatches(entry.path, diff.path);
}

// ─── Store degli snapshot ───────────────────────────────

/** Contenuto di un file di snapshot di contratto. */
export interface ContractSnapshotFile<T> {
  contract: string;
  version: 1;
  description: string;
  regenerate: string;
  cases: Record<string, T>;
}

export interface ContractStoreOptions {
  contract: string;
  file: string;
  description: string;
  /** Comando documentato nel file per rigenerarlo. */
  regenerate: string;
}

/** Valore JSON "puro" (Date → ISO, undefined rimossi), come lo vede un client. */
export function toJsonValue<T>(value: T): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function formatValue(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export class JsonContractStore<T = unknown> {
  readonly contract: string;
  readonly file: string;
  readonly updating = isUpdatingSnapshots();
  readonly filtered = isFilteredRun();
  private readonly options: ContractStoreOptions;
  private readonly expected: Record<string, T>;
  private readonly recorded = new Map<string, T>();
  private allowed: AllowedDiff[] | null = null;

  constructor(options: ContractStoreOptions) {
    this.options = options;
    this.contract = options.contract;
    this.file = options.file;
    this.expected = existsSync(options.file) ? this.readFile().cases : {};
  }

  private readFile(): ContractSnapshotFile<T> {
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ContractSnapshotFile<T>;
    if (parsed?.contract !== this.contract || typeof parsed.cases !== 'object' || parsed.cases === null) {
      throw new Error(`${this.file} non è uno snapshot del contratto ${this.contract}`);
    }
    return parsed;
  }

  /** Casi registrati in questo run (nell'ordine di esecuzione). */
  get recordedCases(): string[] {
    return [...this.recorded.keys()];
  }

  /** Casi presenti nel file ma non eseguiti in questo run. */
  staleCases(): string[] {
    return Object.keys(this.expected).filter((id) => !this.recorded.has(id));
  }

  /**
   * Registra il caso e, fuori dalla modalità di aggiornamento, lo confronta
   * con il file: fallisce con l'elenco delle differenze non ammesse.
   */
  check(caseId: string, entry: T): void {
    if (this.recorded.has(caseId)) throw new Error(`Caso di contratto "${caseId}" registrato due volte`);
    const actual = toJsonValue(entry) as T;
    this.recorded.set(caseId, actual);
    if (this.updating) return;

    if (!(caseId in this.expected)) {
      assert.fail(
        `Snapshot assente per "${caseId}" in ${this.file}. ` +
          `Rigenera con: ${this.options.regenerate}`,
      );
    }
    const diffs = diffJson(this.expected[caseId], actual);
    if (!diffs.length) return;

    this.allowed ??= loadAllowedDiffs();
    const ctx = { contract: this.contract, caseId, store: currentCalendarBackend() };
    const residual = diffs.filter((d) => !this.allowed!.some((entry) => isAllowedDiff(entry, ctx, d)));
    if (!residual.length) return;

    const lines = residual.slice(0, 25).map((d) => {
      if (d.kind === 'added') return `  + ${d.path}: ${formatValue(d.actual)}`;
      if (d.kind === 'removed') return `  - ${d.path}: ${formatValue(d.expected)}`;
      return `  ~ ${d.path}: atteso ${formatValue(d.expected)}, ottenuto ${formatValue(d.actual)}`;
    });
    if (residual.length > lines.length) lines.push(`  … altre ${residual.length - lines.length} differenze`);
    assert.fail(
      `Contratto ${this.contract}, caso "${caseId}": ${residual.length} differenze non ammesse ` +
        `(store ${ctx.store}).\n${lines.join('\n')}\n` +
        `Se il cambiamento è voluto: ${this.options.regenerate}, oppure una voce motivata in allowed-diffs.json.`,
    );
  }

  /**
   * Scrive il file in modalità di aggiornamento. Run completo: solo i casi
   * eseguiti, nell'ordine di esecuzione. Run filtrato: il file esistente con i
   * casi eseguiti sostituiti al loro posto e i nuovi in coda.
   */
  flush(): void {
    if (!this.updating || !this.recorded.size) return;
    let cases: Record<string, T>;
    if (this.filtered) {
      cases = { ...this.expected };
      for (const [id, entry] of this.recorded) cases[id] = entry;
    } else {
      cases = Object.fromEntries(this.recorded);
    }
    const file: ContractSnapshotFile<T> = {
      contract: this.contract,
      version: 1,
      description: this.options.description,
      regenerate: this.options.regenerate,
      cases,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }
}
