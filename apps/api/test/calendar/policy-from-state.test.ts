/**
 * Control-plane fra API e Radicale (fase F1): policyFromState(), formato e
 * lettura di policy.json e heartbeat.json, modalità effettiva dei device,
 * permessi attesi e identità del volume.
 *
 * Test puri (nessun database, nessun Radicale): verificano il modulo
 * src/lib/calendar/radicale/types.ts contro il contratto
 * docs/calendar-radicale/contracts/control-plane.md, i suoi schemi JSON e i
 * casi condivisi con i test Python dei plugin (fixtures/*.cases.json).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BACKEND_MODES,
  CALENDAR_ROLES,
  CANARY_COLLECTION,
  CONTROL_FILE_MAX_BYTES,
  ControlPlaneFormatError,
  DEAD_PROP,
  DEFAULT_BACKEND_STATE,
  EFFECTIVE_MODE_REASONS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_AFTER_MS,
  IDENTITY_STATUSES,
  POLICY_MODES,
  POLICY_REASONS,
  PROBE_USER,
  SERVICE_USER,
  decodeControlFile,
  effectiveDeviceMode,
  expectedRadicaleRights,
  heartbeatFromState,
  identityStatus,
  isReservedUsername,
  isValidCollectionName,
  isValidPathSegment,
  isValidPrincipal,
  normalizeBackendState,
  parseHeartbeat,
  parsePolicy,
  policyFromState,
  principalPropsPath,
  samePolicyContent,
  serializeControlFile,
  volumeMarkerFromProps,
  volumeMarkerProppatchBody,
  type BackendMode,
  type CaldesHeartbeat,
  type CaldesPolicy,
  type CalendarBackendState,
  type ControlFileRead,
  type EffectiveModeReason,
  type IdentityStatus,
  type PolicyInput,
  type PolicyMode,
  type SidecarCollection,
} from '../../src/lib/calendar/radicale/types';
import { validateJsonSchema } from '../helpers/json-schema-lite';

// ─── Contratto su disco ────────────────────────────────────

const CONTRACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/calendar-radicale/contracts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- documenti JSON del contratto
const loadJson = (name: string): any => JSON.parse(readFileSync(resolve(CONTRACTS_DIR, name), 'utf8'));

const POLICY_SCHEMA = loadJson('policy.schema.json');
const HEARTBEAT_SCHEMA = loadJson('heartbeat.schema.json');
const IDENTITY_SCHEMA = loadJson('volume-identity.schema.json');
const AUTHCACHE_SCHEMA = loadJson('authcache.schema.json');
const VERIFY_SCHEMA = loadJson('verify-credentials.schema.json');
const EFFECTIVE_CASES = loadJson('fixtures/effective-mode.cases.json');
const RIGHTS_CASES = loadJson('fixtures/rights-matrix.cases.json');

/** Validazione contro uno schema del contratto, con gli errori nel messaggio. */
function assertValid(schema: object, value: unknown, label: string): void {
  const errors = validateJsonSchema(schema, value);
  assert.deepEqual(errors, [], `${label}: ${errors.join('; ')}`);
}

/** Sotto-schema di un file del contratto ($defs condivisi). */
function defSchema(schema: { $defs: object }, def: string): object {
  return { $defs: schema.$defs, $ref: `#/$defs/${def}` };
}

// ─── Dati comuni ───────────────────────────────────────────

const NOW = new Date('2026-10-09T18:00:00.000Z');
const V1 = '3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60';

/** Stato con il volume inizializzato (epoch 1) più le modifiche indicate. */
function state(over: Partial<CalendarBackendState> = {}): CalendarBackendState {
  return { ...DEFAULT_BACKEND_STATE, volume_id: V1, epoch: 1, ...over };
}

function collection(name: string | null, role: SidecarCollection['role'] = 'user', over: Partial<SidecarCollection> = {}): SidecarCollection {
  return { collection_name: name, role, lifecycle: 'active', device_visible: true, ...over };
}

/** Sidecar dei calendari di produzione (inventario 2026-10-09, slug c e f). */
const PROD_SIDECAR: readonly SidecarCollection[] = Object.freeze([
  collection('bookings', 'bookings'),
  collection('c'),
  collection('f', 'holidays'),
  collection('lavoro'),
  collection('personale'),
  collection('scadenze', 'deadlines'),
]);

function derive(over: Partial<PolicyInput> = {}): CaldesPolicy {
  return policyFromState({ state: state(), identity: 'ok', collections: PROD_SIDECAR, principal: 'federico', now: NOW, ...over });
}

/** Stato valido per ogni modalità del backend (fuori da postgres serve un volume). */
function stateForMode(mode: BackendMode, over: Partial<CalendarBackendState> = {}): CalendarBackendState {
  return state({ mode, ...over });
}

// ─── policyFromState: modalità ─────────────────────────────

describe('policyFromState: modalità derivata dallo stato (design §13.1)', () => {
  test('mode postgres con i calendari di produzione: shadow, f in sola lettura', () => {
    assert.deepEqual(derive(), {
      schema: 1,
      version: 1,
      generated_at: '2026-10-09T18:00:00.000Z',
      backend_mode: 'postgres',
      mode: 'shadow',
      reasons: [],
      principal: 'federico',
      volume_id: V1,
      epoch: 1,
      credential_epoch: 0,
      readonly: ['bookings', 'f', 'scadenze'],
      hidden: ['_canary'],
    });
  });

  test('modalità base per ogni modalità del backend', () => {
    const expected: Record<BackendMode, PolicyMode> = {
      postgres: 'shadow',
      cutover: 'frozen',
      radicale: 'live',
      rollback: 'frozen',
      finalized: 'live',
    };
    assert.deepEqual([...BACKEND_MODES].sort(), Object.keys(expected).sort());
    for (const mode of BACKEND_MODES) {
      const p = derive({ state: stateForMode(mode) });
      assert.equal(p.mode, expected[mode], mode);
      assert.equal(p.backend_mode, mode);
      assert.deepEqual(p.reasons, [], mode);
    }
  });

  test('write_freeze blocca solo quando la base è live', () => {
    for (const mode of ['radicale', 'finalized'] as const) {
      const p = derive({ state: stateForMode(mode, { write_freeze: true }) });
      assert.equal(p.mode, 'frozen', mode);
      assert.deepEqual(p.reasons, ['write_freeze'], mode);
    }
    const pg = derive({ state: stateForMode('postgres', { write_freeze: true }) });
    assert.equal(pg.mode, 'shadow');
    assert.deepEqual(pg.reasons, []);
    const cutover = derive({ state: stateForMode('cutover', { write_freeze: true }) });
    assert.equal(cutover.mode, 'frozen');
    assert.deepEqual(cutover.reasons, [], 'la base è già frozen: nessun motivo in più');
  });

  test('restore_guard_until nel futuro blocca in ogni modalità, scaduto o uguale a now no', () => {
    for (const mode of BACKEND_MODES) {
      const future = derive({ state: stateForMode(mode, { restore_guard_until: new Date(NOW.getTime() + 1) }) });
      assert.equal(future.mode, 'frozen', mode);
      assert.deepEqual(future.reasons, ['restore_guard'], mode);
    }
    assert.equal(derive({ state: state({ restore_guard_until: NOW }) }).mode, 'shadow');
    const past = derive({ state: stateForMode('radicale', { restore_guard_until: new Date(NOW.getTime() - 1) }) });
    assert.equal(past.mode, 'live');
  });

  test('rebuild_required blocca in ogni modalità', () => {
    for (const mode of BACKEND_MODES) {
      const p = derive({ state: stateForMode(mode, { rebuild_required: true }) });
      assert.equal(p.mode, 'frozen', mode);
      assert.deepEqual(p.reasons, ['rebuild_required'], mode);
    }
  });

  test('identità diversa o non verificata blocca in ogni modalità', () => {
    for (const mode of BACKEND_MODES) {
      assert.deepEqual(derive({ state: stateForMode(mode), identity: 'mismatch' }).reasons, ['identity_mismatch'], mode);
      assert.deepEqual(derive({ state: stateForMode(mode), identity: 'unverified' }).reasons, ['identity_unverified'], mode);
      assert.equal(derive({ state: stateForMode(mode), identity: 'mismatch' }).mode, 'frozen', mode);
    }
  });

  test('volume non inizializzato in mode postgres: shadow senza identità (i rights negano comunque i device)', () => {
    for (const identity of IDENTITY_STATUSES) {
      const p = derive({ state: { ...DEFAULT_BACKEND_STATE }, identity });
      assert.equal(p.mode, 'shadow', identity);
      assert.deepEqual(p.reasons, [], identity);
      assert.equal(p.volume_id, null);
      assert.equal(p.epoch, 0);
    }
  });

  test('con un volume in PG, "uninitialized" dal lato API vale come non verificato (fail-closed)', () => {
    const p = derive({ identity: 'uninitialized' });
    assert.equal(p.mode, 'frozen');
    assert.deepEqual(p.reasons, ['identity_unverified']);
  });

  test('i motivi compaiono tutti, nell\'ordine fisso del contratto', () => {
    const p = derive({
      state: stateForMode('radicale', { write_freeze: true, restore_guard_until: new Date('2026-10-11T18:00:00Z'), rebuild_required: true }),
      identity: 'mismatch',
    });
    assert.equal(p.mode, 'frozen');
    assert.deepEqual(p.reasons, ['write_freeze', 'restore_guard', 'rebuild_required', 'identity_mismatch']);
    assert.deepEqual(POLICY_REASONS.filter((r) => p.reasons.includes(r)), p.reasons);
  });

  test('version, epoch, credential_epoch e volume_id vengono dallo stato (volume_id in minuscolo)', () => {
    const p = derive({ state: state({ volume_id: V1.toUpperCase(), epoch: 7, credential_epoch: 12, policy_version: 42 }) });
    assert.equal(p.version, 42);
    assert.equal(p.epoch, 7);
    assert.equal(p.credential_epoch, 12);
    assert.equal(p.volume_id, V1);
  });

  test('pura: stesso risultato a parità di ingressi, ordine delle collezioni ininfluente, ingressi intatti', () => {
    const frozenState = Object.freeze(state({ mode: 'radicale' }));
    const shuffled = Object.freeze([...PROD_SIDECAR].reverse().map((c) => Object.freeze({ ...c })));
    const a = policyFromState({ state: frozenState, identity: 'ok', collections: PROD_SIDECAR, principal: 'federico', now: NOW });
    const b = policyFromState({ state: frozenState, identity: 'ok', collections: shuffled, principal: 'federico', now: NOW });
    assert.deepEqual(a, b);
    assert.equal(serializeControlFile(a), serializeControlFile(b));
  });
});

// ─── policyFromState: collezioni ───────────────────────────

describe('policyFromState: readonly e hidden dal sidecar', () => {
  test('ruoli in sola lettura, collezioni nascoste, nomi non validi ignorati', () => {
    const p = derive({
      state: stateForMode('radicale'),
      collections: [
        collection('lavoro'),
        collection('compiti', 'tasks'),
        collection('bookings', 'bookings'),
        collection('f', 'holidays'),
        collection('scadenze', 'deadlines'),
        collection('sub-abc', 'subscription'),
        collection('sub-new', 'subscription', { device_visible: false }),
        collection('in-creazione', 'user', { lifecycle: 'creating' }),
        collection('in-cancellazione', 'holidays', { lifecycle: 'deleting' }),
        collection(null),
        collection('_sistema'),
        collection('.nascosto'),
        collection('a/b'),
        collection('f', 'holidays'),
      ],
    });
    assert.equal(p.mode, 'live');
    assert.deepEqual(p.readonly, ['bookings', 'f', 'scadenze', 'sub-abc']);
    assert.deepEqual(p.hidden, ['_canary', 'in-cancellazione', 'in-creazione', 'sub-new']);
  });

  test('_canary è sempre nascosta, anche senza calendari', () => {
    const p = derive({ collections: [] });
    assert.deepEqual(p.readonly, []);
    assert.deepEqual(p.hidden, [CANARY_COLLECTION]);
  });

  test('una collezione nascosta non compare anche fra quelle in sola lettura', () => {
    const p = derive({ collections: [collection('bookings', 'bookings', { device_visible: false })] });
    assert.deepEqual(p.readonly, []);
    assert.deepEqual(p.hidden, ['_canary', 'bookings']);
  });

  test('nomi dei device (UUID maiuscoli, spazi, accenti) restano verbatim e ordinati', () => {
    const p = derive({
      collections: [
        collection('4B8F0E2C-1F2A-4C3B-9D8E-ABCDEF012345', 'subscription'),
        collection('Calendario è', 'holidays'),
        collection('agenda'),
      ],
    });
    assert.deepEqual(p.readonly, ['4B8F0E2C-1F2A-4C3B-9D8E-ABCDEF012345', 'Calendario è']);
  });
});

// ─── policyFromState: errori ───────────────────────────────

describe('policyFromState: ingressi impossibili', () => {
  test('principal non valido o riservato', () => {
    for (const principal of ['', 'Federico', 'caldes-svc', 'CALDES-probe', 'a/b', 'x'.repeat(65)]) {
      assert.throws(() => derive({ principal }), ControlPlaneFormatError, principal);
    }
  });

  test('stato fuori dai vincoli della 162', () => {
    const bad: Array<Partial<CalendarBackendState>> = [
      { mode: 'radicale', volume_id: null, epoch: 0 },
      { volume_id: null, epoch: 1 },
      { volume_id: V1, epoch: 0 },
      { volume_id: 'non-un-uuid' },
      { epoch: -1 },
      { epoch: 1.5 },
      { credential_epoch: -1 },
      { policy_version: 0 },
      { mode: 'boh' as BackendMode },
    ];
    for (const over of bad) {
      assert.throws(() => derive({ state: state(over) }), ControlPlaneFormatError, JSON.stringify(over));
    }
  });

  test('stato d\'identità sconosciuto e now non valido', () => {
    assert.throws(() => derive({ identity: 'forse' as IdentityStatus }), ControlPlaneFormatError);
    assert.throws(() => derive({ now: new Date('x') }), ControlPlaneFormatError);
  });
});

// ─── policy.json: schema, serializzazione e lettura ────────

/** Tutte le combinazioni rilevanti di stato e identità (fuori da postgres il volume c'è sempre). */
function policyMatrix(): CaldesPolicy[] {
  const out: CaldesPolicy[] = [];
  for (const mode of BACKEND_MODES) {
    for (const identity of IDENTITY_STATUSES) {
      for (const flags of [{}, { write_freeze: true }, { rebuild_required: true }, { restore_guard_until: new Date('2026-10-11T00:00:00Z') }]) {
        out.push(derive({ state: stateForMode(mode, flags), identity }));
      }
    }
  }
  for (const identity of IDENTITY_STATUSES) out.push(derive({ state: { ...DEFAULT_BACKEND_STATE }, identity }));
  return out;
}

describe('policy.json: formato (policy.schema.json) e lettura (§5)', () => {
  test('ogni policy derivata rispetta lo schema e si rilegge identica', () => {
    const all = policyMatrix();
    assert.ok(all.length > 80);
    for (const p of all) {
      assertValid(POLICY_SCHEMA, p, `${p.backend_mode}/${p.reasons.join(',')}`);
      const text = serializeControlFile(p);
      assert.deepEqual(parsePolicy(decodeControlFile(text), 'federico'), p);
    }
  });

  test('serializzazione canonica: chiavi nell\'ordine dello schema, indentazione 2, a capo finale', () => {
    const p = derive();
    const text = serializeControlFile(p);
    assert.ok(text.endsWith('}\n'));
    assert.ok(text.startsWith('{\n  "schema": 1,\n  "version": 1,\n'));
    assert.deepEqual(Object.keys(JSON.parse(text)), POLICY_SCHEMA.required);
  });

  test('gli esempi dello schema sono validi e leggibili', () => {
    for (const example of POLICY_SCHEMA.examples) {
      assertValid(POLICY_SCHEMA, example, 'esempio');
      assert.deepEqual(parsePolicy(example, 'federico'), example);
    }
  });

  test('lo schema rifiuta gli errori del writer', () => {
    const p = derive();
    const broken: Array<[string, unknown]> = [
      ['campo in più', { ...p, extra: true }],
      ['campo mancante', (({ credential_epoch: _omit, ...rest }) => rest)(p)],
      ['senza _canary', { ...p, hidden: [] }],
      ['duplicati', { ...p, readonly: ['f', 'f'] }],
      ['readonly con prefisso _', { ...p, readonly: ['_x'] }],
      ['volume maiuscolo', { ...p, volume_id: V1.toUpperCase() }],
      ['epoch 0 con volume', { ...p, epoch: 0 }],
      ['live con motivi', { ...derive({ state: stateForMode('radicale') }), reasons: ['write_freeze'] }],
      ['live da postgres', { ...p, mode: 'live' }],
      ['shadow da radicale', { ...p, backend_mode: 'radicale' }],
      ['principal riservato', { ...p, principal: 'caldes-svc' }],
      ['generated_at senza millisecondi', { ...p, generated_at: '2026-10-09T18:00:00Z' }],
    ];
    for (const [label, value] of broken) {
      assert.notDeepEqual(validateJsonSchema(POLICY_SCHEMA, value), [], label);
    }
  });

  test('i lettori rifiutano le policy fuori contratto', () => {
    const p = derive();
    const invalid: Array<[string, unknown]> = [
      ['non oggetto', []],
      ['schema 2', { ...p, schema: 2 }],
      ['schema stringa', { ...p, schema: '1' }],
      ['version 0', { ...p, version: 0 }],
      ['generated_at assente', (({ generated_at: _omit, ...rest }) => rest)(p)],
      ['backend_mode sconosciuto', { ...p, backend_mode: 'mysql' }],
      ['mode sconosciuto', { ...p, mode: 'open' }],
      ['reasons non array', { ...p, reasons: 'x' }],
      ['principal diverso', { ...p, principal: 'mario' }],
      ['volume non UUID', { ...p, volume_id: 'abc' }],
      ['epoch stringa', { ...p, epoch: '1' }],
      ['epoch oltre int32', { ...p, epoch: 2 ** 31 }],
      ['volume con epoch 0', { ...p, epoch: 0 }],
      ['epoch senza volume', { ...p, volume_id: null }],
      ['live senza volume', { ...p, mode: 'live', volume_id: null, epoch: 0 }],
      ['credential_epoch negativo', { ...p, credential_epoch: -1 }],
      ['readonly con /', { ...p, readonly: ['a/b'] }],
      ['hidden con .', { ...p, hidden: ['.x'] }],
      ['hidden non array', { ...p, hidden: '_canary' }],
    ];
    for (const [label, value] of invalid) {
      assert.throws(() => parsePolicy(value, 'federico'), ControlPlaneFormatError, label);
    }
  });

  test('i lettori ignorano i campi e i motivi sconosciuti e normalizzano volume e liste', () => {
    const p = derive();
    const read = parsePolicy({ ...p, futuro: 1, reasons: ['nuovo'], volume_id: V1.toUpperCase(), readonly: ['scadenze', 'f', 'bookings', 'f'] }, 'federico');
    assert.equal(read.volume_id, V1);
    assert.deepEqual(read.reasons, []);
    assert.deepEqual(read.readonly, ['bookings', 'f', 'scadenze']);
    assert.ok(!('futuro' in read));
    // Senza principal atteso si accetta qualsiasi principal valido.
    assert.equal(parsePolicy({ ...p, principal: 'mario' }).principal, 'mario');
  });

  test('file oltre 64 KiB o non JSON: invalido', () => {
    assert.throws(() => decodeControlFile(' '.repeat(CONTROL_FILE_MAX_BYTES + 1)), ControlPlaneFormatError);
    assert.throws(() => decodeControlFile('{"schema": 1,'), ControlPlaneFormatError);
    const many = derive({ collections: Array.from({ length: 4000 }, (_, i) => collection(`collezione-${i}`, 'holidays')) });
    assert.throws(() => serializeControlFile(many), ControlPlaneFormatError);
  });

  test('samePolicyContent ignora solo generated_at', () => {
    const a = derive();
    const later = derive({ now: new Date(NOW.getTime() + HEARTBEAT_INTERVAL_MS) });
    assert.notEqual(a.generated_at, later.generated_at);
    assert.ok(samePolicyContent(a, later));
    assert.ok(!samePolicyContent(a, derive({ state: state({ credential_epoch: 1 }) })));
    assert.ok(!samePolicyContent(a, derive({ collections: [] })));
  });
});

// ─── heartbeat.json ────────────────────────────────────────

describe('heartbeat.json: formato (heartbeat.schema.json) e lettura (§7)', () => {
  test('heartbeatFromState rispetta lo schema e si rilegge identico', () => {
    for (const mode of BACKEND_MODES) {
      const hb = heartbeatFromState(stateForMode(mode, { epoch: 3 }), 'sha-1a2b3c4', NOW);
      assert.deepEqual(hb, { schema: 1, api_version: 'sha-1a2b3c4', mode, epoch: 3, ts: '2026-10-09T18:00:00.000Z' });
      assertValid(HEARTBEAT_SCHEMA, hb, mode);
      const text = serializeControlFile(hb);
      assert.deepEqual(Object.keys(JSON.parse(text)), HEARTBEAT_SCHEMA.required);
      assert.deepEqual(parseHeartbeat(decodeControlFile(text)), hb);
    }
    for (const example of HEARTBEAT_SCHEMA.examples) assertValid(HEARTBEAT_SCHEMA, example, 'esempio');
  });

  test('api_version fuori formato: errore del writer', () => {
    for (const v of ['', 'con spazio', 'x'.repeat(65), 'è']) {
      assert.throws(() => heartbeatFromState(state(), v, NOW), ControlPlaneFormatError, v);
    }
  });

  test('i lettori rifiutano i heartbeat fuori contratto', () => {
    const hb = heartbeatFromState(state(), 'sha-1', NOW);
    const invalid: Array<[string, unknown]> = [
      ['schema 2', { ...hb, schema: 2 }],
      ['api_version assente', (({ api_version: _omit, ...rest }) => rest)(hb)],
      ['mode sconosciuto', { ...hb, mode: 'live' }],
      ['epoch negativo', { ...hb, epoch: -1 }],
      ['ts senza fuso', { ...hb, ts: '2026-10-09T18:00:00' }],
      ['ts numerico', { ...hb, ts: 1760032800 }],
      ['ts impossibile', { ...hb, ts: '2026-13-45T18:00:00Z' }],
    ];
    for (const [label, value] of invalid) {
      assert.throws(() => parseHeartbeat(value), ControlPlaneFormatError, label);
    }
    assert.equal(parseHeartbeat({ ...hb, ts: '2026-10-09T20:00:00+02:00', pid: 1 }).ts, '2026-10-09T20:00:00+02:00');
  });
});

// ─── Modalità effettiva (casi condivisi) ───────────────────

/** Come un lettore vede un file del caso: assente, testo verbatim o oggetto serializzato. */
function readControl<T>(doc: unknown, text: string | undefined, parse: (v: unknown) => T): ControlFileRead<T> {
  if (text === undefined && doc === null) return { state: 'missing' };
  const raw = text ?? JSON.stringify(doc);
  try {
    return { state: 'ok', value: parse(decodeControlFile(raw)) };
  } catch (err) {
    if (err instanceof ControlPlaneFormatError) return { state: 'invalid', error: err.message };
    throw err;
  }
}

describe('modalità effettiva dei device (§7.3, fixtures/effective-mode.cases.json)', () => {
  const principal: string = EFFECTIVE_CASES.principal;

  for (const c of EFFECTIVE_CASES.cases) {
    test(c.name, () => {
      const policy = readControl(c.policy ?? null, c.policy_text, (v) => parsePolicy(v, principal));
      const heartbeat = readControl(c.heartbeat ?? null, c.heartbeat_text, parseHeartbeat);
      const lastKnownGood = c.last_known_good ? parsePolicy(c.last_known_good, principal) : null;
      const got = effectiveDeviceMode({ policy, heartbeat, lastKnownGood, now: new Date(c.now) });
      assert.deepEqual(
        { mode: got.mode, reasons: got.reasons, volume_id: got.volume_id, epoch: got.epoch },
        c.expected,
      );
      assert.ok(got.hidden.includes(CANARY_COLLECTION));
    });
  }

  test('i casi usano solo motivi del contratto, nell\'ordine di EFFECTIVE_MODE_REASONS', () => {
    for (const c of EFFECTIVE_CASES.cases) {
      const reasons: EffectiveModeReason[] = c.expected.reasons;
      assert.deepEqual(EFFECTIVE_MODE_REASONS.filter((r) => reasons.includes(r)), reasons, c.name);
    }
  });

  test('policy e heartbeat scritti dallo stesso giro dell\'API: modalità effettiva = modalità della policy', () => {
    for (const p of policyMatrix()) {
      const s = p.epoch === 0 ? { ...DEFAULT_BACKEND_STATE } : stateForMode(p.backend_mode);
      const hb = heartbeatFromState(s, 'sha-1', NOW);
      const got = effectiveDeviceMode({ policy: { state: 'ok', value: p }, heartbeat: { state: 'ok', value: hb }, now: NOW });
      assert.equal(got.mode, p.mode, `${p.backend_mode}/${p.reasons.join(',')}`);
      assert.deepEqual(got.reasons, []);
    }
  });

  test('un heartbeat non aggiornato per più di 10 minuti porta i device in frozen', () => {
    const p = derive({ state: stateForMode('radicale') });
    const hb = heartbeatFromState(stateForMode('radicale'), 'sha-1', NOW);
    const at = (ms: number): PolicyMode =>
      effectiveDeviceMode({ policy: { state: 'ok', value: p }, heartbeat: { state: 'ok', value: hb }, now: new Date(NOW.getTime() + ms) }).mode;
    assert.equal(at(HEARTBEAT_STALE_AFTER_MS), 'live');
    assert.equal(at(HEARTBEAT_STALE_AFTER_MS + 1), 'frozen');
  });
});

// ─── Permessi (casi condivisi) ─────────────────────────────

describe('permessi di caldes_rights (§8, fixtures/rights-matrix.cases.json)', () => {
  test('i casi coprono tutto il prodotto contesti × utenti × path', () => {
    const contexts = Object.keys(RIGHTS_CASES.contexts);
    assert.equal(RIGHTS_CASES.cases.length, contexts.length * RIGHTS_CASES.users.length * RIGHTS_CASES.paths.length);
    const seen = new Set(RIGHTS_CASES.cases.map((c: { context: string; user: string; path: string }) => `${c.context}|${c.user}|${c.path}`));
    assert.equal(seen.size, RIGHTS_CASES.cases.length);
  });

  test('ogni caso coincide con expectedRadicaleRights()', () => {
    for (const c of RIGHTS_CASES.cases) {
      const ctx = RIGHTS_CASES.contexts[c.context];
      const got = expectedRadicaleRights(c.user, c.path, {
        principal: ctx.principal,
        mode: ctx.mode,
        identityOk: ctx.identity_ok,
        readonly: ctx.readonly,
        hidden: ctx.hidden,
      });
      assert.equal(got, c.expected, `${c.context} ${c.user || '(anonimo)'} '${c.path}'`);
    }
  });

  test('matrice del design §3.4, scritta a mano', () => {
    const ctx = (mode: PolicyMode, identityOk = true) => ({
      principal: 'federico',
      mode,
      identityOk,
      readonly: ['bookings', 'f', 'scadenze', 'sub-abc'],
      hidden: ['_canary', 'sub-new'],
    });
    const r = (user: string, path: string, mode: PolicyMode, identityOk = true): string =>
      expectedRadicaleRights(user, path, ctx(mode, identityOk));

    for (const mode of POLICY_MODES) {
      // caldes-svc: R sulla root, RW sul principal, rwD sulle collezioni, niente altrove.
      assert.equal(r(SERVICE_USER, '', mode), 'R');
      assert.equal(r(SERVICE_USER, 'federico', mode), 'RW');
      assert.equal(r(SERVICE_USER, 'federico/f', mode), 'rwD');
      assert.equal(r(SERVICE_USER, 'federico/_canary', mode), 'rwD');
      assert.equal(r(SERVICE_USER, 'federico/qualsiasi', mode, false), 'rwD', 'serve all\'inizializzazione');
      assert.equal(r(SERVICE_USER, 'caldes-svc', mode), '');
      assert.equal(r(SERVICE_USER, 'iphone', mode), '');
      for (const user of ['federico', PROBE_USER]) {
        assert.equal(r(user, '', mode), 'R');
        assert.equal(r(user, '', mode, false), 'R', 'la root non dipende dall\'identità');
        assert.equal(r(user, 'iphone', mode), '');
        assert.equal(r(user, 'caldes-svc', mode), '');
        assert.equal(r(user, 'federico', mode, false), '');
        assert.equal(r(user, 'federico/c', mode, false), '');
        assert.equal(r(user, 'federico/f', mode), 'r');
        assert.equal(r(user, 'federico/bookings', mode), 'r');
        assert.equal(r(user, 'federico/sub-abc', mode), 'r');
        assert.equal(r(user, 'federico/sub-new', mode), '');
        assert.equal(r(user, 'federico/_qualsiasi', mode), '');
        assert.equal(r(user, 'federico/c/evento.ics', mode), '');
      }
      assert.equal(r('federico', 'federico/_canary', mode), '');
      assert.equal(r('iphone', '', mode), '', 'un utente diverso dal principal non arriva mai dall\'auth');
      assert.equal(r('', '', mode), '');
    }
    for (const mode of ['shadow', 'frozen'] as const) {
      assert.equal(r('federico', 'federico', mode), 'R');
      assert.equal(r('federico', 'federico/c', mode), 'r');
      assert.equal(r('federico', 'federico/nuova', mode), 'r', 'MKCALENDAR negata');
      assert.equal(r(PROBE_USER, 'federico/_canary', mode), '', 'la PUT del probe su _canary risponde 403');
    }
    // Sempre e solo R sul principal, anche in live: il marker lo scrive solo caldes-svc.
    assert.equal(r('federico', 'federico', 'live'), 'R');
    assert.equal(r(PROBE_USER, 'federico', 'live'), 'R');
    assert.equal(r('federico', 'federico/c', 'live'), 'rw');
    assert.equal(r('federico', 'federico/nuova', 'live'), 'rw', 'MKCALENDAR ammessa');
    assert.equal(r(PROBE_USER, 'federico/_canary', 'live'), 'rw');
    assert.ok(!r('federico', 'federico/c', 'live').includes('D'), 'DELETE della collezione vietata ai device');
  });
});

// ─── Identità del volume ───────────────────────────────────

describe('identità del volume (§4)', () => {
  /** .Radicale.props del principal come lo scrive Radicale 3.7.8 dopo la PROPPATCH. */
  const REAL_PROPS = { '{urn:calicchia:caldes}epoch': '1', '{urn:calicchia:caldes}volume-id': V1 };

  test('marker dalle props reali, anche con altre chiavi e UUID maiuscolo', () => {
    assert.deepEqual(volumeMarkerFromProps(REAL_PROPS), { volume_id: V1, epoch: 1 });
    assert.deepEqual(
      volumeMarkerFromProps({ ...REAL_PROPS, 'D:displayname': 'Federico', [DEAD_PROP.volumeId]: V1.toUpperCase(), [DEAD_PROP.epoch]: '12' }),
      { volume_id: V1, epoch: 12 },
    );
    assertValid(IDENTITY_SCHEMA, REAL_PROPS, 'props reali');
    for (const example of IDENTITY_SCHEMA.examples) assertValid(IDENTITY_SCHEMA, example, 'esempio');
  });

  test('marker assente o malformato', () => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      {},
      { [DEAD_PROP.volumeId]: V1 },
      { [DEAD_PROP.epoch]: '1' },
      { ...REAL_PROPS, [DEAD_PROP.epoch]: '0' },
      { ...REAL_PROPS, [DEAD_PROP.epoch]: '01' },
      { ...REAL_PROPS, [DEAD_PROP.epoch]: ' 1' },
      { ...REAL_PROPS, [DEAD_PROP.epoch]: 1 },
      { ...REAL_PROPS, [DEAD_PROP.epoch]: '99999999999' },
      { ...REAL_PROPS, [DEAD_PROP.volumeId]: 'abc' },
      { 'K:volume-id': V1, 'K:epoch': '1' },
    ];
    for (const props of bad) {
      assert.equal(volumeMarkerFromProps(props), null, JSON.stringify(props));
    }
    assert.notDeepEqual(validateJsonSchema(IDENTITY_SCHEMA, { ...REAL_PROPS, [DEAD_PROP.epoch]: '01' }), []);
  });

  test('esito del confronto con lo stato in PG', () => {
    const pg = { volume_id: V1, epoch: 2 };
    assert.equal(identityStatus({ volume_id: null, epoch: 0 }, { volume_id: V1, epoch: 1 }), 'uninitialized');
    assert.equal(identityStatus({ volume_id: null, epoch: 0 }, undefined), 'uninitialized');
    assert.equal(identityStatus(pg, undefined), 'unverified');
    assert.equal(identityStatus(pg, null), 'mismatch');
    assert.equal(identityStatus(pg, { volume_id: V1, epoch: 1 }), 'mismatch', 'snapshot precedente all\'ultimo cambio di epoch');
    assert.equal(identityStatus(pg, { volume_id: '00000000-0000-4000-8000-000000000000', epoch: 2 }), 'mismatch');
    assert.equal(identityStatus(pg, { volume_id: V1, epoch: 2 }), 'ok');
    assert.equal(identityStatus({ volume_id: V1.toUpperCase(), epoch: 2 }, { volume_id: V1, epoch: 2 }), 'ok');
  });

  test('percorso delle props e corpo della PROPPATCH del marker', () => {
    assert.equal(
      principalPropsPath('/radicale-data/collections', 'federico'),
      '/radicale-data/collections/collection-root/federico/.Radicale.props',
    );
    assert.throws(() => principalPropsPath('/x', 'caldes-svc'), ControlPlaneFormatError);
    const body = volumeMarkerProppatchBody({ volume_id: V1.toUpperCase(), epoch: 3 });
    assert.match(body, /xmlns:K="urn:calicchia:caldes"/);
    assert.match(body, new RegExp(`<K:volume-id>${V1}</K:volume-id><K:epoch>3</K:epoch>`));
    assert.throws(() => volumeMarkerProppatchBody({ volume_id: V1, epoch: 0 }), ControlPlaneFormatError);
    assert.throws(() => volumeMarkerProppatchBody({ volume_id: 'x', epoch: 1 }), ControlPlaneFormatError);
  });
});

// ─── Nomi, username e stato dal database ───────────────────

describe('nomi, username riservati e stato dal database', () => {
  test('username riservati: prefisso caldes- senza distinguere maiuscole e minuscole', () => {
    for (const u of ['caldes-svc', 'caldes-probe', 'CALDES-SVC', 'Caldes-x', 'caldes-']) assert.ok(isReservedUsername(u), u);
    for (const u of ['federico', 'iphone', 'caldes', 'caldessvc', 'x-caldes-svc', '']) assert.ok(!isReservedUsername(u), u);
  });

  test('nomi di collezione e segmenti di path, allineati allo schema della policy', () => {
    const collectionSchema = defSchema(POLICY_SCHEMA, 'collectionName');
    const segmentSchema = defSchema(POLICY_SCHEMA, 'pathSegment');
    const samples: Array<[string, boolean, boolean]> = [
      // [nome, collezione del sidecar, segmento della policy]
      ['f', true, true],
      ['creattivamente-srl', true, true],
      ['4B8F0E2C-1F2A-4C3B-9D8E-ABCDEF012345', true, true],
      ['Calendario è', true, true],
      ['_canary', false, true],
      ['_x', false, true],
      ['.x', false, false],
      ['a/b', false, false],
      ['a\\b', false, false],
      ['a\tb', false, false],
      ['a\u0085b', false, false],
      ['a\u007fb', false, false],
      ['', false, false],
      ['a'.repeat(255), true, true],
      ['è'.repeat(127), true, true],
    ];
    for (const [name, isCollection, isSegment] of samples) {
      assert.equal(isValidCollectionName(name), isCollection, `collezione ${JSON.stringify(name)}`);
      assert.equal(isValidPathSegment(name), isSegment, `segmento ${JSON.stringify(name)}`);
      // Lo schema conta caratteri e non byte: il limite in byte lo applica solo il codice.
      assert.equal(validateJsonSchema(collectionSchema, name).length === 0, isCollection, `schema collezione ${JSON.stringify(name)}`);
      assert.equal(validateJsonSchema(segmentSchema, name).length === 0, isSegment, `schema segmento ${JSON.stringify(name)}`);
    }
    // 256 byte UTF-8: rifiutati dal codice (e dalla 162) anche se sono 128 caratteri.
    assert.ok(!isValidCollectionName('è'.repeat(128)));
    assert.ok(!isValidCollectionName('a'.repeat(256)));
  });

  test('principal canonico', () => {
    assert.ok(isValidPrincipal('federico'));
    for (const p of ['Federico', 'caldes-svc', '', 'a b', 'a/b', '-x']) assert.ok(!isValidPrincipal(p), p);
    assert.deepEqual(validateJsonSchema(defSchema(POLICY_SCHEMA, 'principal'), 'federico'), []);
    assert.notDeepEqual(validateJsonSchema(defSchema(POLICY_SCHEMA, 'principal'), 'caldes-svc'), []);
  });

  test('normalizeBackendState accetta la riga di postgres-js e rifiuta valori fuori contratto', () => {
    const row = {
      id: true,
      mode: 'postgres',
      write_freeze: false,
      volume_id: V1.toUpperCase(),
      epoch: 1,
      credential_epoch: '3',
      policy_version: 5,
      restore_guard_until: '2026-10-11T18:00:00.000Z',
      rebuild_required: true,
      updated_at: new Date(),
    };
    assert.deepEqual(normalizeBackendState(row), {
      mode: 'postgres',
      write_freeze: false,
      volume_id: V1,
      epoch: 1,
      credential_epoch: 3,
      policy_version: 5,
      restore_guard_until: new Date('2026-10-11T18:00:00.000Z'),
      rebuild_required: true,
    });
    assert.deepEqual(normalizeBackendState({ ...DEFAULT_BACKEND_STATE }), DEFAULT_BACKEND_STATE);
    for (const bad of [
      { ...row, mode: 'boh' },
      { ...row, epoch: 0 },
      { ...row, write_freeze: 'false' },
      { ...row, restore_guard_until: 'domani' },
      { ...row, policy_version: null },
    ]) {
      assert.throws(() => normalizeBackendState(bad), ControlPlaneFormatError, JSON.stringify(bad));
    }
  });
});

// ─── Allineamento fra schemi JSON e tipi TS ────────────────

describe('allineamento fra schemi JSON e costanti TS', () => {
  test('policy.schema.json', () => {
    assert.deepEqual(POLICY_SCHEMA.properties.mode.enum, [...POLICY_MODES]);
    assert.deepEqual(POLICY_SCHEMA.$defs.backendMode.enum, [...BACKEND_MODES]);
    assert.deepEqual(POLICY_SCHEMA.properties.reasons.items.enum, [...POLICY_REASONS]);
    assert.deepEqual(POLICY_SCHEMA.required, Object.keys(derive()));
  });

  test('heartbeat.schema.json', () => {
    assert.deepEqual(HEARTBEAT_SCHEMA.properties.mode.enum, [...BACKEND_MODES]);
    assert.deepEqual(HEARTBEAT_SCHEMA.required, Object.keys(heartbeatFromState(state(), 'sha-1', NOW) as CaldesHeartbeat));
  });

  test('volume-identity.schema.json', () => {
    assert.deepEqual(IDENTITY_SCHEMA.required, [DEAD_PROP.volumeId, DEAD_PROP.epoch]);
    const coll = IDENTITY_SCHEMA.$defs.collectionDeadProps.properties;
    assert.deepEqual(Object.keys(coll), [DEAD_PROP.calendarId, DEAD_PROP.role]);
    assert.deepEqual(coll[DEAD_PROP.role].enum, [...CALENDAR_ROLES]);
  });

  test('authcache e verify-credentials: gli esempi rispettano gli schemi', () => {
    for (const example of AUTHCACHE_SCHEMA.examples) assertValid(AUTHCACHE_SCHEMA, example, 'authcache');
    const [request, ok, denied] = VERIFY_SCHEMA.examples;
    assertValid(defSchema(VERIFY_SCHEMA, 'request'), request, 'richiesta');
    assertValid(defSchema(VERIFY_SCHEMA, 'responseOk'), ok, 'risposta 200');
    assertValid(defSchema(VERIFY_SCHEMA, 'responseDenied'), denied, 'risposta 401');
    // Il 401 del middleware del Bearer non è una negazione: non ha ok:false.
    assert.notDeepEqual(validateJsonSchema(defSchema(VERIFY_SCHEMA, 'responseDenied'), { error: 'Unauthorized' }), []);
  });
});
