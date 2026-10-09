/**
 * Migrazione 162 (fase F1 del passaggio a Radicale): sidecar dei calendari,
 * calendar_sidecar_reconcile(), default all'inserimento, colonne delle
 * iscrizioni, stato del backend e NOTIFY della policy. Contratto:
 * docs/calendar-radicale/contracts/control-plane.md §2-§3.
 *
 * Gli scenari girano dentro transazioni sempre annullate (inRollback): niente
 * residui, nemmeno in audit_logs. Fanno eccezione il test del NOTIFY, che ha
 * bisogno di commit veri (dati con il prefisso del gruppo, ripuliti dalle
 * fixture, e un credential_epoch che per contratto può solo crescere), e il
 * calendario festività creato dal codice legacy.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import {
  BACKEND_MODES,
  CALENDAR_LIFECYCLES,
  CALENDAR_ORIGINS,
  CALENDAR_ROLES,
  DEFAULT_BACKEND_STATE,
  DEFAULT_PRINCIPAL,
  normalizeBackendState,
  policyFromState,
  type SidecarCollection,
} from '../../src/lib/calendar/radicale/types';
import { updateCalendar } from '../../src/lib/calendar/calendars';
import { validateJsonSchema } from '../helpers/json-schema-lite';

const POLICY_SCHEMA = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/calendar-radicale/contracts/policy.schema.json'), 'utf8'),
);

function assertValid(policy: unknown): void {
  const errors = validateJsonSchema(POLICY_SCHEMA, policy);
  assert.deepEqual(errors, [], errors.join('; '));
}

const fx = useFixtures('sidecar-162', { resetBaseline: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tipo tx di postgres-js (stesso pattern di src/)
type Tx = any;

class Rollback extends Error {}

/** Esegue `fn` in una transazione e la annulla sempre. */
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx: Tx) => {
      await fn(tx);
      throw new Rollback('rollback voluto');
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

/** Valori fra apici di un CHECK ... IN (...) letto dal catalogo. */
async function checkValues(table: string, constraint: string): Promise<string[]> {
  const [row] = await sql<Array<{ def: string }>>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = ${table}::regclass AND conname = ${constraint}
  `;
  assert.ok(row, `vincolo ${constraint} assente`);
  return [...row.def.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

interface SidecarRow {
  slug: string;
  collection_name: string | null;
  role: string;
  origin: string;
  lifecycle: string;
  device_visible: boolean;
  components: string[];
  dav_props: Record<string, unknown>;
  needs_review: boolean;
  review_reason: string | null;
}

async function sidecar(tx: Tx, slug: string): Promise<SidecarRow> {
  const [row] = await tx`
    SELECT slug, collection_name, role, origin, lifecycle, device_visible, components, dav_props, needs_review, review_reason
    FROM calendars WHERE slug = ${slug}
  `;
  assert.ok(row, `calendario ${slug} assente`);
  return row as SidecarRow;
}

/** Modifiche della riconciliazione come array semplice (postgres-js restituisce un Result). */
async function reconcile(tx: Tx): Promise<Array<{ slug: string; field: string; old_value: string | null; new_value: string | null }>> {
  const rows = await tx`
    SELECT c.slug, r.field, r.old_value, r.new_value
    FROM calendar_sidecar_reconcile() r JOIN calendars c ON c.id = r.calendar_id
    ORDER BY c.slug, r.field
  `;
  return Array.from(rows, (r: { slug: string; field: string; old_value: string | null; new_value: string | null }) => ({ ...r }));
}

/** Inserisce un calendario con le sole colonne legacy (come createCalendar), lasciando fare al trigger. */
async function insertLegacy(tx: Tx, slug: string, name: string, extra: Record<string, unknown> = {}): Promise<void> {
  await tx`
    INSERT INTO calendars ${tx({ slug, name, ics_feed_token: `${slug}-${'x'.repeat(32)}`.slice(0, 32), ...extra })}
  `;
}

// ─── Schema ────────────────────────────────────────────────

describe('162: vincoli allineati al contratto', () => {
  test('i CHECK della 162 hanno gli stessi valori delle costanti TS', async () => {
    assert.deepEqual(await checkValues('calendars', 'calendars_role_check'), [...CALENDAR_ROLES]);
    assert.deepEqual(await checkValues('calendars', 'calendars_origin_check'), [...CALENDAR_ORIGINS]);
    assert.deepEqual(await checkValues('calendars', 'calendars_lifecycle_check'), [...CALENDAR_LIFECYCLES]);
    assert.deepEqual(await checkValues('calendar_backend_state', 'calendar_backend_state_mode_check'), [...BACKEND_MODES]);
  });

  test('una sola riga di stato, con i default di un database appena migrato', async () => {
    const rows = await sql`SELECT * FROM calendar_backend_state`;
    assert.equal(rows.length, 1);
    const state = normalizeBackendState(rows[0]);
    // credential_epoch e policy_version sono monotoni: la baseline non li azzera.
    assert.deepEqual(
      { ...state, credential_epoch: 0, policy_version: 1 },
      { ...DEFAULT_BACKEND_STATE },
    );
    assert.ok(state.policy_version >= 1);
    assert.ok(state.credential_epoch >= 0);
  });

  test('calendari seminati già riconciliati: collection_name = slug e ruoli storici', async () => {
    await inRollback(async (tx) => {
      const rows: SidecarRow[] = await tx`
        SELECT slug, collection_name, role, origin, lifecycle, device_visible, components, dav_props, needs_review, review_reason
        FROM calendars ORDER BY slug
      `;
      assert.deepEqual(
        Array.from(rows, (r) => [r.slug, r.collection_name, r.role, r.origin, r.lifecycle, r.device_visible, [...r.components], r.needs_review]),
        [
          ['bookings', 'bookings', 'bookings', 'system', 'active', true, ['VEVENT'], false],
          ['lavoro', 'lavoro', 'user', 'admin', 'active', true, ['VEVENT'], false],
          ['personale', 'personale', 'user', 'admin', 'active', true, ['VEVENT'], false],
          ['scadenze', 'scadenze', 'deadlines', 'system', 'active', true, ['VEVENT'], false],
        ],
      );
      assert.deepEqual(await reconcile(tx), [], 'idempotente: nulla da fare');
    });
  });
});

// ─── Default all'inserimento ───────────────────────────────

describe('162: il trigger completa il sidecar dei calendari creati dal codice legacy', () => {
  test('createCalendar: collection_name = slug, ruolo user, origine admin', async () => {
    const cal = await fx.calendar({ key: 'lavoro-extra' });
    const row = await sidecar(sql, cal.slug);
    assert.equal(row.collection_name, cal.slug);
    assert.equal(row.role, 'user');
    assert.equal(row.origin, 'admin');
    assert.deepEqual(row.dav_props, {});
  });

  test('calendario festività con lo slug di produzione f (come getOrCreateFestivitaCalendar)', async () => {
    const cal = await fx.holidayCalendar();
    const row = await sidecar(sql, cal.slug);
    assert.equal(row.collection_name, 'f');
    assert.equal(row.role, 'holidays');
    assert.equal(row.origin, 'system');
  });

  test('regole storiche, dead prop e origine', async () => {
    await inRollback(async (tx) => {
      await insertLegacy(tx, fx.slug('fest-nome'), 'Festività');
      await insertLegacy(tx, fx.slug('fest-sys'), fx.name('festivita'), { is_system: true });
      await insertLegacy(tx, fx.slug('foto'), 'Foto festive');
      await insertLegacy(tx, fx.slug('dev'), 'Festività e chiusure', { origin: 'device' });
      await insertLegacy(tx, fx.slug('esplicito'), 'Festività e chiusure', { dav_props: tx.json({ '{urn:calicchia:caldes}role': 'user' }) });
      await insertLegacy(tx, fx.slug('dead'), fx.name('Altro'), { dav_props: tx.json({ '{urn:calicchia:caldes}role': 'tasks' }) });
      await insertLegacy(tx, fx.slug('scelto'), fx.name('Scelto'), { role: 'subscription', origin: 'migration' });

      assert.equal((await sidecar(tx, fx.slug('fest-nome'))).role, 'holidays', 'nome storico esatto, anche senza is_system');
      assert.equal((await sidecar(tx, fx.slug('fest-sys'))).role, 'user', 'slug diverso da f/festivita e nome con prefisso');
      assert.equal((await sidecar(tx, fx.slug('foto'))).role, 'user');
      assert.equal((await sidecar(tx, fx.slug('dev'))).role, 'user', 'mai le regole storiche per i device');
      assert.equal((await sidecar(tx, fx.slug('esplicito'))).role, 'user', 'la dead prop batte le regole');
      assert.equal((await sidecar(tx, fx.slug('dead'))).role, 'tasks');
      assert.equal((await sidecar(tx, fx.slug('scelto'))).role, 'subscription', 'un ruolo esplicito non si tocca');
      assert.equal((await sidecar(tx, fx.slug('fest-sys'))).origin, 'system');
    });
  });

  test('nome di collezione occupato: NULL senza errore, poi segnalato dalla riconciliazione', async () => {
    await inRollback(async (tx) => {
      await insertLegacy(tx, fx.slug('primo'), fx.name('Primo'), { collection_name: fx.slug('secondo') });
      await insertLegacy(tx, fx.slug('secondo'), fx.name('Secondo'));
      assert.equal((await sidecar(tx, fx.slug('secondo'))).collection_name, null);
      assert.deepEqual(await reconcile(tx), [
        { slug: fx.slug('secondo'), field: 'needs_review', old_value: null, new_value: 'collection_name_conflict' },
      ]);
      assert.deepEqual(await reconcile(tx), []);
    });
  });
});

// ─── Riconciliazione ───────────────────────────────────────

describe('162: calendar_sidecar_reconcile()', () => {
  test('righe legacy di produzione (c, f con is_system=false) come prima della 162', async () => {
    await inRollback(async (tx) => {
      const c = fx.slug('c');
      const f = fx.slug('f');
      await insertLegacy(tx, c, 'Creattivamente SRL');
      await insertLegacy(tx, f, 'Festività e chiusure');
      // Stato di una riga che esisteva prima della 162: default delle colonne nuove.
      await tx`UPDATE calendars SET collection_name = NULL, role = 'user', origin = 'admin' WHERE slug IN (${c}, ${f})`;

      assert.deepEqual(await reconcile(tx), [
        { slug: c, field: 'collection_name', old_value: null, new_value: c },
        { slug: f, field: 'collection_name', old_value: null, new_value: f },
        { slug: f, field: 'role', old_value: 'user', new_value: 'holidays' },
      ]);
      assert.deepEqual(await reconcile(tx), [], 'seconda chiamata: nessuna modifica');
    });
  });

  test('dead prop role dopo un ripristino, conflitti e iscrizioni orfane', async () => {
    await inRollback(async (tx) => {
      const restored = fx.slug('ripristinato');
      const conflict = fx.slug('conflitto');
      const orphan = fx.slug('sub-orfana');
      const linked = fx.slug('sub-collegata');
      await insertLegacy(tx, restored, fx.name('Ripristinato'));
      await insertLegacy(tx, conflict, fx.name('Conflitto'), { role: 'bookings' });
      await insertLegacy(tx, orphan, fx.name('Orfana'), { role: 'subscription', device_visible: false });
      await insertLegacy(tx, linked, fx.name('Collegata'), { role: 'subscription' });
      const [target] = await tx`SELECT id FROM calendars WHERE slug = 'lavoro'`;
      const [sub] = await tx`SELECT id FROM calendars WHERE slug = ${linked}`;
      await tx`
        INSERT INTO calendar_subscriptions (calendar_id, name, ics_url, collection_calendar_id)
        VALUES (${target.id}, ${fx.name('iscrizione')}, 'https://example.test/feed.ics', ${sub.id})
      `;
      // La discovery ha letto le dead prop dopo un ripristino del backup.
      await tx`UPDATE calendars SET dav_props = ${tx.json({ '{urn:calicchia:caldes}role': 'holidays' })} WHERE slug = ${restored}`;
      await tx`UPDATE calendars SET dav_props = ${tx.json({ '{urn:calicchia:caldes}role': 'holidays' })} WHERE slug = ${conflict}`;

      assert.deepEqual(await reconcile(tx), [
        { slug: conflict, field: 'needs_review', old_value: null, new_value: 'role_conflict' },
        { slug: restored, field: 'role', old_value: 'user', new_value: 'holidays' },
        { slug: orphan, field: 'needs_review', old_value: null, new_value: 'orphan_subscription' },
      ]);
      assert.equal((await sidecar(tx, conflict)).role, 'bookings', 'un ruolo diverso dal default non si sovrascrive');
      assert.equal((await sidecar(tx, conflict)).review_reason, 'role_conflict');
      assert.deepEqual(await reconcile(tx), []);
    });
  });
});

// ─── Iscrizioni ────────────────────────────────────────────

describe('162: colonne di calendar_subscriptions', () => {
  test('default false, sidecar unico e SET NULL quando il sidecar sparisce', async () => {
    await inRollback(async (tx) => {
      const [target] = await tx`SELECT id FROM calendars WHERE slug = 'lavoro'`;
      const [sub] = await tx`
        INSERT INTO calendar_subscriptions (calendar_id, name, ics_url)
        VALUES (${target.id}, ${fx.name('feed')}, 'https://example.test/a.ics')
        RETURNING blocks_availability, device_visible, collection_calendar_id, id
      `;
      assert.equal(sub.blocks_availability, false);
      assert.equal(sub.device_visible, false);
      assert.equal(sub.collection_calendar_id, null);

      await insertLegacy(tx, fx.slug('sub-x'), fx.name('Sub'), { role: 'subscription', parent_calendar_id: target.id, device_visible: false });
      const [side] = await tx`SELECT id FROM calendars WHERE slug = ${fx.slug('sub-x')}`;
      await tx`UPDATE calendar_subscriptions SET collection_calendar_id = ${side.id} WHERE id = ${sub.id}`;
      await assert.rejects(
        tx.savepoint((sp: Tx) => sp`
          INSERT INTO calendar_subscriptions (calendar_id, name, ics_url, collection_calendar_id)
          VALUES (${target.id}, ${fx.name('feed2')}, 'https://example.test/b.ics', ${side.id})
        `),
        /calendar_subscriptions_collection_calendar_key/,
      );
      await assert.rejects(
        tx.savepoint((sp: Tx) => sp`UPDATE calendar_subscriptions SET collection_calendar_id = calendar_id WHERE id = ${sub.id}`),
        /calendar_subscriptions_collection_not_target_check/,
      );
      await tx`DELETE FROM calendars WHERE id = ${side.id}`;
      const [after] = await tx`SELECT collection_calendar_id FROM calendar_subscriptions WHERE id = ${sub.id}`;
      assert.equal(after.collection_calendar_id, null);
    });
  });
});

// ─── Stato del backend ─────────────────────────────────────

describe('162: calendar_backend_state', () => {
  test('policy_version cresce solo con le colonne della policy e non si scrive a mano', async () => {
    await inRollback(async (tx) => {
      const [before] = await tx`SELECT policy_version FROM calendar_backend_state`;
      const v0: number = before.policy_version;
      const [same] = await tx`UPDATE calendar_backend_state SET updated_at = updated_at, policy_version = 999 RETURNING policy_version`;
      assert.equal(same.policy_version, v0);
      const [init] = await tx`
        UPDATE calendar_backend_state SET volume_id = '3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60', epoch = 1
        WHERE mode = 'postgres' AND epoch = 0 RETURNING policy_version
      `;
      assert.equal(init.policy_version, v0 + 1);
      const [revoked] = await tx`UPDATE calendar_backend_state SET credential_epoch = credential_epoch + 1 RETURNING policy_version`;
      assert.equal(revoked.policy_version, v0 + 2);
      const [guard] = await tx`UPDATE calendar_backend_state SET restore_guard_until = now() + interval '48 hours', rebuild_required = true RETURNING policy_version`;
      assert.equal(guard.policy_version, v0 + 3);
    });
  });

  test('vincoli d\'identità e singleton', async () => {
    await inRollback(async (tx) => {
      const rejects = (query: (sp: Tx) => Promise<unknown>, pattern: RegExp) => assert.rejects(tx.savepoint(query), pattern);
      await rejects((sp) => sp`UPDATE calendar_backend_state SET mode = 'radicale'`, /calendar_backend_state_mode_identity_check/);
      await rejects((sp) => sp`UPDATE calendar_backend_state SET epoch = 1`, /calendar_backend_state_identity_check/);
      await rejects((sp) => sp`UPDATE calendar_backend_state SET volume_id = gen_random_uuid()`, /calendar_backend_state_identity_check/);
      await rejects((sp) => sp`UPDATE calendar_backend_state SET mode = 'mysql'`, /calendar_backend_state_mode_check/);
      await rejects((sp) => sp`INSERT INTO calendar_backend_state (id) VALUES (false)`, /calendar_backend_state_singleton_check/);
      await rejects((sp) => sp`DELETE FROM calendar_backend_state`, /singleton/);
      await rejects((sp) => sp`TRUNCATE calendar_backend_state`, /singleton/);
    });
  });

  test('vincoli del sidecar', async () => {
    await inRollback(async (tx) => {
      const rejects = (query: (sp: Tx) => Promise<unknown>, pattern: RegExp) => assert.rejects(tx.savepoint(query), pattern);
      for (const name of ['_canary', '.x', 'a/b', 'a\\b', 'a\tb', '']) {
        await rejects((sp) => sp`UPDATE calendars SET collection_name = ${name} WHERE slug = 'lavoro'`, /calendars_collection_name_check/);
      }
      await rejects((sp) => sp`UPDATE calendars SET collection_name = 'bookings' WHERE slug = 'lavoro'`, /calendars_collection_name_key/);
      await rejects((sp) => sp`UPDATE calendars SET role = 'admin' WHERE slug = 'lavoro'`, /calendars_role_check/);
      await rejects((sp) => sp`UPDATE calendars SET origin = 'utente' WHERE slug = 'lavoro'`, /calendars_origin_check/);
      await rejects((sp) => sp`UPDATE calendars SET lifecycle = 'deleted' WHERE slug = 'lavoro'`, /calendars_lifecycle_check/);
      await rejects((sp) => sp`UPDATE calendars SET components = '{VCARD}' WHERE slug = 'lavoro'`, /calendars_components_check/);
      await rejects((sp) => sp`UPDATE calendars SET components = '{}' WHERE slug = 'lavoro'`, /calendars_components_check/);
      await rejects((sp) => sp`UPDATE calendars SET dav_props = '[]'::jsonb WHERE slug = 'lavoro'`, /calendars_dav_props_check/);
      await rejects((sp) => sp`UPDATE calendars SET review_reason = 'Da Rivedere' WHERE slug = 'lavoro'`, /calendars_review_reason_check/);
      await rejects((sp) => sp`UPDATE calendars SET parent_calendar_id = id WHERE slug = 'lavoro'`, /calendars_parent_not_self_check/);
      const [ok] = await tx`
        UPDATE calendars SET collection_name = '4B8F0E2C-1F2A-4C3B-9D8E-ABCDEF012345' WHERE slug = 'lavoro' RETURNING collection_name
      `;
      assert.equal(ok.collection_name, '4B8F0E2C-1F2A-4C3B-9D8E-ABCDEF012345');
    });
  });

  test('policyFromState sulle righe reali produce la policy di F1', async () => {
    await inRollback(async (tx) => {
      await insertLegacy(tx, fx.slug('chiusure'), fx.name('Chiusure'), { role: 'holidays' });
      await insertLegacy(tx, fx.slug('nascosto'), fx.name('Nascosto'), { device_visible: false });
      const [row] = await tx`SELECT * FROM calendar_backend_state`;
      const collections: SidecarCollection[] = Array.from(
        await tx`SELECT collection_name, role, lifecycle, device_visible FROM calendars`,
        (r: SidecarCollection) => ({ ...r }),
      );
      const policy = policyFromState({
        state: normalizeBackendState(row),
        identity: 'uninitialized',
        collections,
        principal: DEFAULT_PRINCIPAL,
        now: new Date(),
      });
      assertValid(policy);
      assert.equal(policy.mode, 'shadow');
      assert.equal(policy.volume_id, null);
      assert.equal(policy.epoch, 0);
      // Le righe degli altri test del file (es. la festività 'f') possono esserci: si
      // confronta con l'insieme atteso calcolato dalle righe stesse.
      const expectedReadonly = collections
        .filter((c) => c.device_visible && ['bookings', 'holidays', 'deadlines', 'subscription'].includes(c.role))
        .map((c) => c.collection_name as string)
        .sort();
      assert.deepEqual(policy.readonly, expectedReadonly);
      for (const name of ['bookings', 'scadenze', fx.slug('chiusure')]) assert.ok(policy.readonly.includes(name), name);
      assert.ok(!policy.readonly.includes('lavoro'));
      assert.deepEqual(policy.hidden, ['_canary', fx.slug('nascosto')]);
    });
  });
});

// ─── NOTIFY ────────────────────────────────────────────────

describe('162: NOTIFY calendar_policy_changed', () => {
  test('stato e sidecar notificano, gli UPDATE legacy no', async () => {
    const received: string[] = [];
    const listener = await sql.listen('calendar_policy_changed', (payload: string) => received.push(payload));
    try {
      const cal = await fx.calendar({ key: 'notifica' });
      await waitFor(() => received.length >= 1);
      assert.deepEqual(received.map((p) => JSON.parse(p)), [{ source: 'sidecar' }]);

      // UPDATE legacy (nome, colore, ordine): nessuna notifica.
      await updateCalendar(cal.id, { color: '#000000', sort_order: 7 });
      await sql`UPDATE calendar_backend_state SET updated_at = updated_at`;
      // credential_epoch per contratto può solo crescere: il commit non va annullato.
      await sql`UPDATE calendar_backend_state SET credential_epoch = credential_epoch + 1`;
      await waitFor(() => received.length >= 2);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(received.map((p) => JSON.parse(p)), [{ source: 'sidecar' }, { source: 'state' }]);
    } finally {
      await listener.unlisten();
    }
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout in attesa della notifica');
    await new Promise((r) => setTimeout(r, 20));
  }
}
