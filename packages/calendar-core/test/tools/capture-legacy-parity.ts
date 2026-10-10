/**
 * Rigenera test/fixtures/legacy-parity.json: le occorrenze del modello legacy
 * (expandRRule di apps/api/src/lib/calendar/legacy/rrule-legacy.ts, rrule.js)
 * per i casi di test/legacy-parity-cases.ts. Da rilanciare solo se cambiano i
 * casi; finché il codice legacy esiste, legacy-parity.test.ts verifica anche
 * che la fixture coincida con l'output dal vivo.
 *
 *   tsx test/tools/capture-legacy-parity.ts
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIXTURES_DIR } from '../helpers';
import { loadLegacyExpandRRule } from '../legacy-loader';
import { legacyOccurrences, PARITY_CASES } from '../legacy-parity-cases';

const expandRRule = await loadLegacyExpandRRule();
if (!expandRRule) {
  console.error('sorgente legacy dell\'API non raggiungibile da questo checkout');
  process.exit(1);
}
const cases = Object.fromEntries(PARITY_CASES.map((c) => [c.name, legacyOccurrences(expandRRule, c)]));
writeFileSync(resolve(FIXTURES_DIR, 'legacy-parity.json'), `${JSON.stringify({ source: 'apps/api/src/lib/calendar/legacy/rrule-legacy.ts (rrule.js)', cases }, null, 1)}\n`);
console.log(`scritti ${Object.keys(cases).length} casi`);
