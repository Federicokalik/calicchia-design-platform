/** Chiusura: toglie la cartella di lavoro degli e2e (sessione e informazioni dello stack). */

import { rmSync } from 'node:fs';
import { STATE_DIR } from './support/env';

export default function globalTeardown(): void {
  rmSync(STATE_DIR, { recursive: true, force: true });
}
