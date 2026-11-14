/**
 * Parti pure del modello dell'indice (apps/api/src/lib/calendar/index-model.ts;
 * design §6.4, §6.9; contratto docs/calendar-radicale/contracts/f2-modules.md
 * §2): formato delle recurrence key (lo stesso di recurrenceKeyOf di
 * @calicchia/calendar-core), orizzonte e chiavi dei lock. Provenienza, kind e
 * regola blocks sono di calendar-core e si provano lì. Nessun database.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CAL_LOCKS,
  HORIZON,
  parseRecurrenceKey,
  RECURRENCE_KEY_RE,
  recurrenceKeyForDate,
  recurrenceKeyForFloating,
  recurrenceKeyForInstant,
  requiredHorizonEnd,
  targetHorizon,
} from '../../src/lib/calendar/index-model';

describe('chiavi di ricorrenza', () => {
  test('istante UTC al secondo, data locale per gli all-day, ora da muro per i floating, round-trip', () => {
    assert.equal(recurrenceKeyForInstant(new Date('2026-10-26T08:00:00.987Z')), '20261026T080000Z');
    assert.equal(recurrenceKeyForDate('2026-12-25'), '20261225');
    assert.equal(recurrenceKeyForDate('20261225'), '20261225');
    assert.equal(recurrenceKeyForFloating('2026-10-26T09:00:00'), '20261026T090000');
    assert.deepEqual(parseRecurrenceKey('20261026T080000Z'), { kind: 'instant', utc: new Date('2026-10-26T08:00:00Z') });
    assert.deepEqual(parseRecurrenceKey('20261225'), { kind: 'date', date: '2026-12-25' });
    assert.deepEqual(parseRecurrenceKey('20261026T090000'), { kind: 'floating', wall: '2026-10-26T09:00:00' });
    assert.deepEqual(parseRecurrenceKey(''), { kind: 'master' });
    assert.deepEqual(parseRecurrenceKey('conservative'), { kind: 'conservative' });
    for (const k of ['', '20261225', '20261026T080000Z', '20261026T090000']) assert.match(k, RECURRENCE_KEY_RE);
    assert.doesNotMatch('conservative', RECURRENCE_KEY_RE, 'conservative solo in cal_occurrences');
  });

  test('date e istanti inesistenti o malformati rifiutati', () => {
    assert.throws(() => recurrenceKeyForDate('2026-02-30'), RangeError);
    assert.throws(() => recurrenceKeyForDate('2026-1-5'), RangeError);
    assert.throws(() => recurrenceKeyForInstant(new Date('x')), RangeError);
    assert.throws(() => recurrenceKeyForFloating('2026-10-26T24:00:00'), RangeError);
    for (const bad of ['20261301', '20261026T250000Z', '20261026T250000', '2026-10-26T08:00:00Z', '20261026t080000z', 'conservativo']) {
      assert.throws(() => parseRecurrenceKey(bad), RangeError, bad);
    }
  });
});

describe('orizzonte (design §6.9)', () => {
  test('[oggi − 400 g, oggi + 800 g] al giorno UTC; garanzia statica con max_advance_days + 14 g', () => {
    const now = new Date('2026-10-09T15:30:00Z');
    const h = targetHorizon(now);
    assert.equal(h.start.toISOString(), '2025-09-04T00:00:00.000Z');
    assert.equal(h.end.toISOString(), '2028-12-17T00:00:00.000Z');
    assert.equal((h.end.getTime() - h.start.getTime()) / 86_400_000, HORIZON.pastDays + HORIZON.futureDays);
    assert.equal(requiredHorizonEnd(now, 60).toISOString(), '2026-12-22T15:30:00.000Z');
    assert.ok(requiredHorizonEnd(now, 365) < h.end, 'il massimo anticipo di oggi sta dentro l\'orizzonte');
  });

  test('chiavi degli advisory lock', () => {
    assert.equal(CAL_LOCKS.write, 'cal-write');
    assert.equal(CAL_LOCKS.collection('ABC'), 'cal-sync:abc');
  });
});
