// Precarico di node --test (test/run.ts, script test:migrate): valuta
// helpers/env.ts prima di qualsiasi modulo di src/, solo nel thread principale.
//
// I worker thread ereditano execArgv, quindi anche questo --import: su Node
// 22.12 (.nvmrc e CI) non hanno però il loader di tsx, e importare lì un file
// .ts fa crashare il worker del transport pino-pretty dopo la fine dei test.
// Per questo il precarico è JavaScript e salta i worker, che non usano env.
import { isMainThread } from 'node:worker_threads';

if (isMainThread) {
  await import('./env.ts');
}
