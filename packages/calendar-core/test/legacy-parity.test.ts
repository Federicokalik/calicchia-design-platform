/**
 * Parità dell'espansione con il codice legacy (rrule.js in
 * apps/api/src/lib/calendar/legacy/rrule-legacy.ts, già corretto per il DST):
 * stessi istanti, stesse fini e stessa sostituzione degli override dove il
 * legacy è corretto; le differenze volute hanno valori attesi espliciti per
 * entrambi i lati (test/legacy-parity-cases.ts).
 *
 * Il lato legacy viene dalla fixture test/fixtures/legacy-parity.json
 * (catturata con test/tools/capture-legacy-parity.ts) e, quando il sorgente
 * dell'API è raggiungibile dal pacchetto, anche dal vivo: la fixture deve
 * coincidere con l'output attuale.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fixture } from './helpers';
import { loadLegacyExpandRRule } from './legacy-loader';
import { describeOccurrences, legacyOccurrences, oursOccurrences, PARITY_CASES } from './legacy-parity-cases';

const captured = JSON.parse(fixture('legacy-parity.json')) as { cases: Record<string, string[]> };
const expandRRule = await loadLegacyExpandRRule();
const SKIP_LIVE = expandRRule ? false : 'sorgente legacy dell\'API (o le sue dipendenze) non raggiungibile da questo checkout';

describe('parità con l\'espansione legacy (rrule.js)', () => {
  test('la fixture copre tutti i casi, senza avanzi', () => {
    assert.deepEqual(Object.keys(captured.cases).sort(), PARITY_CASES.map((c) => c.name).sort());
  });

  for (const c of PARITY_CASES) {
    const legacy = captured.cases[c.name] ?? [];
    if (!c.diff) {
      test(`identica: ${c.name} [${c.origin}]`, () => {
        assert.ok(legacy.length > 0, 'caso senza occorrenze: non dimostra nulla');
        assert.deepEqual(oursOccurrences(c), legacy);
      });
    } else {
      const diff = c.diff;
      test(`differenza voluta: ${c.name} — ${diff.reason}`, () => {
        assert.deepEqual(describeOccurrences(legacy, diff.ends), diff.legacy, 'lato legacy');
        assert.deepEqual(describeOccurrences(oursOccurrences(c), diff.ends), diff.ours, 'lato calendar-core');
      });
    }
  }

  test('la fixture coincide con l\'output attuale del codice legacy', { skip: SKIP_LIVE }, () => {
    for (const c of PARITY_CASES) {
      assert.deepEqual(legacyOccurrences(expandRRule!, c), captured.cases[c.name], c.name);
    }
  });
});
