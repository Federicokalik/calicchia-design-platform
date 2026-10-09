/**
 * Runner dei test dell'API: `tsx --test` con concorrenza 1 e helpers/env.ts
 * precaricato (--import ./test/helpers/preload.mjs) prima di ogni modulo di
 * src/, più la scelta della suite e l'inoltro delle opzioni.
 *
 * Serve perché node --test tratta come argomenti dello script tutto ciò che
 * segue il primo pattern: con il glob scritto in package.json, un
 * `pnpm test -- --test-update-snapshots` verrebbe ignorato in silenzio. Qui le
 * opzioni vanno sempre prima dei pattern.
 *
 * Uso (da apps/api, o con pnpm --filter @calicchia/api):
 *   tsx test/run.ts                        tutte le suite
 *   tsx test/run.ts contracts calendar     solo le suite indicate
 *   tsx test/run.ts test/smoke/infra.test.ts   file o glob specifici
 *   tsx test/run.ts -- --test-update-snapshots --test-name-pattern=feed
 *
 * Le opzioni che iniziano con '-' passano a node --test; quelle che vogliono
 * un valore separato (es. --test-name-pattern feed) consumano l'argomento dopo.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Suite disponibili → glob relativi ad apps/api. */
const SUITES: Record<string, string> = {
  all: 'test/**/*.test.ts',
  smoke: 'test/smoke/**/*.test.ts',
  contracts: 'test/contracts/**/*.test.ts',
  calendar: 'test/calendar/**/*.test.ts',
};

/** Opzioni di node --test che accettano il valore come argomento separato. */
const FLAGS_WITH_VALUE = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-timeout',
  '--test-shard',
  '--test-concurrency',
  '--import',
  '--require',
]);

function parseArgs(argv: string[]): { flags: string[]; patterns: string[] } {
  const flags: string[] = [];
  const patterns: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg.startsWith('-')) {
      flags.push(arg);
      if (!arg.includes('=') && FLAGS_WITH_VALUE.has(arg) && i + 1 < argv.length) flags.push(argv[++i]);
      continue;
    }
    const suite = SUITES[arg];
    // Un nome senza '/', '.' né '*' non è un percorso: è una suite scritta male,
    // che altrimenti girerebbe come pattern vuoto con 0 test ed esito verde.
    if (!suite && !/[/.*]/.test(arg)) {
      console.error(`Suite sconosciuta "${arg}". Disponibili: ${Object.keys(SUITES).join(', ')} (oppure un percorso o glob).`);
      process.exit(2);
    }
    patterns.push(suite ?? arg);
  }
  return { flags, patterns: patterns.length ? patterns : [SUITES.all] };
}

/**
 * Opzioni di node aggiunte solo se questa versione le accetta (prova rapida
 * con `node <flag> -e ''`):
 * - --experimental-test-snapshots: su Node 22.12 (.nvmrc e CI) t.assert.snapshot
 *   esiste solo con questo flag; dalle 22.13 è stabile e il flag è un no-op;
 * - --disable-warning=ExperimentalWarning: MockTimers (helpers/clock.ts) e
 *   snapshot stampano un avviso per ogni file di test.
 */
function acceptedNodeFlags(candidates: string[]): string[] {
  return candidates.filter((flag) => spawnSync(process.execPath, [flag, '-e', ''], { stdio: 'ignore' }).status === 0);
}

const { flags, patterns } = parseArgs(process.argv.slice(2));
const nodeFlags = acceptedNodeFlags(['--experimental-test-snapshots', '--disable-warning=ExperimentalWarning']);
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const child = spawn(
  process.execPath,
  [tsxCli, '--test', '--test-concurrency=1', ...nodeFlags, '--import', './test/helpers/preload.mjs', ...flags, ...patterns],
  { cwd: API_ROOT, stdio: 'inherit' },
);

// Ctrl-C arriva già al figlio (stesso gruppo di processi del terminale): il
// runner lo ignora e aspetta che i test si chiudano. SIGTERM (es. timeout
// della CI) può invece colpire solo il runner, quindi va inoltrato.
process.on('SIGINT', () => {
  /* gestito dal figlio */
});
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on('error', (err) => {
  console.error(`Impossibile avviare tsx --test: ${err.message}`);
  process.exit(1);
});
