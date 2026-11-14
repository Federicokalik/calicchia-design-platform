/**
 * Salute del calendario GET /api/health/calendar (routes/calendar/health.ts;
 * design §16.5, §6.5, §7, §13.1; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §1.6 e §9), senza Radicale:
 * RADICALE_URL non è impostata e il control-plane non è avviato, come in una
 * produzione in mode postgres senza Radicale configurato.
 *
 * Casi: senza JWT admin solo { status } (anche con un JWT di un altro ruolo);
 * mode postgres senza Radicale → 'ok' con i componenti 'not_configured'; job
 * morti e conflitti aperti → 'degraded' (HTTP 200); oggetti in quarantena in
 * shadow (mode postgres) → nessun effetto sullo stato; iscrizione bloccante
 * mai scaricata → nel dettaglio, 'degraded' solo con lo store Radicale; store
 * Radicale con Radicale non configurato → 'down' (HTTP 503) senza dettagli
 * per il pubblico.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { applyCollectionChanges, loadCollectionContext, stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { computeCalendarHealth, resetCalendarHealthCache } from '../../src/routes/calendar/health';
import { onBeforeDatabaseClose, sql, useTestDatabase } from '../helpers/db';
import { api, signTestToken } from '../helpers/http';
import { useFixtures } from '../helpers/fixtures';

useTestDatabase({ resetBaseline: true });
const fx = useFixtures('cons-health');

const PATH = '/api/health/calendar';

onBeforeDatabaseClose(async () => {
  await sql`UPDATE calendar_backend_state SET mode = 'postgres', volume_id = NULL, epoch = 0 WHERE id = true`;
  await sql`DELETE FROM cal_jobs WHERE key LIKE ${`${fx.prefix}%`}`;
  await sql`DELETE FROM cal_booking_conflicts WHERE booking_uid LIKE ${`${fx.prefix}%`}`;
  invalidateBackendModeCache();
  resetCalendarHealthCache();
  await stopIndexWorker();
});

async function health(auth?: 'admin' | { bearer: string }) {
  resetCalendarHealthCache();
  return api.get(PATH, auth ? { auth } : {});
}

function codes(json: { reasons: Array<{ code: string }> }): string[] {
  return json.reasons.map((r) => r.code);
}

describe('GET /api/health/calendar', () => {
  test('mode postgres senza Radicale: ok; senza JWT admin solo lo stato', async () => {
    const pub = await health();
    assert.equal(pub.status, 200, pub.text);
    assert.deepEqual(pub.json, { status: 'ok' });
    assert.equal(pub.headers.get('cache-control'), 'no-store');

    const client = await health({ bearer: await signTestToken({ role: 'client' }) });
    assert.deepEqual(client.json, { status: 'ok' }, 'un JWT non admin vale come anonimo');

    const admin = await health('admin');
    assert.equal(admin.status, 200);
    const r = admin.json;
    assert.equal(r.status, 'ok', JSON.stringify(r.reasons));
    assert.deepEqual(r.reasons, []);
    assert.equal(r.mode.mode, 'postgres');
    assert.equal(r.mode.store, 'postgres');
    assert.equal(r.radicale.status, 'not_configured');
    assert.match(r.radicale.reason, /RADICALE_URL/);
    assert.deepEqual(r.control_plane, { status: 'not_configured' });
    assert.equal(r.identity.status, 'not_configured');
    assert.equal(r.heartbeat.status, 'not_configured');
    assert.equal(r.watcher.running, false);
    assert.deepEqual(r.canary, { status: 'never_run' });
    assert.ok(Array.isArray(r.collections));
    assert.equal(typeof r.jobs.pending, 'number');
    assert.deepEqual(r.conflicts, { open: 0, oldest_open_at: null });
    assert.equal(r.rebuild.required, false);
    assert.equal(r.degraded_booking_mode.active, false);
    for (const key of ['status', 'reasons', 'generated_at', 'mode', 'radicale', 'control_plane', 'identity', 'heartbeat', 'watcher',
      'canary', 'collections', 'quarantined', 'hold', 'horizon', 'jobs', 'conflicts', 'rebuild', 'subscriptions', 'degraded_booking_mode']) {
      assert.ok(key in r, `sezione ${key}`);
    }
  });

  test('job morti e conflitti aperti: degraded (HTTP 200), con i motivi nel dettaglio', async () => {
    const [job] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_jobs (kind, key, payload, status, attempts, last_error, finished_at)
      VALUES ('project_booking', ${`${fx.prefix}-morto`}, '{}'::jsonb, 'dead', 8, 'errore di prova', now())
      RETURNING id::text
    `;
    try {
      const pub = await health();
      assert.equal(pub.status, 200);
      assert.deepEqual(pub.json, { status: 'degraded' });
      const admin = await health('admin');
      assert.equal(admin.json.status, 'degraded');
      assert.ok(codes(admin.json).includes('jobs_dead'), JSON.stringify(admin.json.reasons));
      assert.ok(admin.json.jobs.dead >= 1);
    } finally {
      await sql`DELETE FROM cal_jobs WHERE id = ${job.id}::bigint`;
    }

    const cal = await fx.calendar({ key: 'conflitti' });
    await sql`
      INSERT INTO cal_booking_conflicts (booking_id, booking_uid, calendar_id, object_id, booking_start, booking_end, event_start, event_end, detected_by)
      VALUES (${randomUUID()}, ${`${fx.prefix}-bk`}, ${cal.id}, ${randomUUID()}, '2027-01-04T09:00:00Z', '2027-01-04T09:30:00Z',
              '2027-01-04T09:00:00Z', '2027-01-04T10:00:00Z', 'post_commit')
    `;
    try {
      const admin = await health('admin');
      assert.equal(admin.json.status, 'degraded');
      assert.ok(codes(admin.json).includes('booking_conflicts'));
      assert.equal(admin.json.conflicts.open, 1);
    } finally {
      await sql`DELETE FROM cal_booking_conflicts WHERE booking_uid = ${`${fx.prefix}-bk`}`;
    }
  });

  test('oggetto in quarantena nell\'indice in shadow (mode postgres): riportato, nessun effetto sullo stato', async () => {
    const cal = await fx.calendar({ key: 'quarantena', blocks_availability: true });
    const context = await loadCollectionContext(sql, cal.id);
    await applyCollectionChanges({
      context,
      upserts: [{ href: 'rotto.ics', etag: '"e1"', raw: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:rotto-health\r\nDTSTART:20270104T090000Z\r\nDTEND:20270104T100000Z\r\nEND:VCALENDAR\r\n' }],
      deletes: [], radicaleSkipped: [], pending404: [], full: true,
      horizon: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2028-01-01T00:00:00Z') }, actor: 'test',
    }, { syncedAt: new Date() });
    const admin = await health('admin');
    assert.equal(admin.json.status, 'ok', JSON.stringify(admin.json.reasons));
    assert.ok(admin.json.quarantined.count >= 1);
    assert.ok(admin.json.quarantined.items.some((q: { href: string }) => q.href === 'rotto.ics'));
    const view = admin.json.collections.find((c: { calendarId: string }) => c.calendarId === cal.id);
    assert.ok(view, 'collezione nel dettaglio');
    assert.equal(view.quarantined, 1);
    assert.equal(typeof view.lag_seconds, 'number');
    assert.equal(view.blocks_display, false);
  });

  test('iscrizione bloccante mai scaricata: nel dettaglio sempre, motivo degraded solo con lo store Radicale', async () => {
    const cal = await fx.calendar({ key: 'iscr-dest', blocks_availability: true });
    const [sub] = await sql<Array<{ id: string }>>`
      INSERT INTO calendar_subscriptions (calendar_id, name, ics_url, sync_enabled, blocks_availability)
      VALUES (${cal.id}, ${`${fx.prefix} iscrizione`}, 'https://example.invalid/feed.ics', true, true)
      RETURNING id::text
    `;
    try {
      const shadow = await health('admin');
      assert.equal(shadow.json.status, 'ok', JSON.stringify(shadow.json.reasons));
      assert.ok(shadow.json.subscriptions.blocking_never_pulled >= 1);
      assert.ok(shadow.json.subscriptions.items.some((i: { subscription_id: string }) => i.subscription_id === sub.id));

      await sql`UPDATE calendar_backend_state SET mode = 'radicale', volume_id = ${randomUUID()}, epoch = 1 WHERE id = true`;
      invalidateBackendModeCache();
      const radicale = await health('admin');
      assert.ok(codes(radicale.json).includes('subscription_never_pulled'), JSON.stringify(radicale.json.reasons));
      assert.equal(radicale.json.reasons.find((r: { code: string }) => r.code === 'subscription_never_pulled').severity, 'degraded');
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = 'postgres', volume_id = NULL, epoch = 0 WHERE id = true`;
      invalidateBackendModeCache();
      await sql`DELETE FROM calendar_subscriptions WHERE id = ${sub.id}::uuid`;
    }
  });

  test('store Radicale con Radicale non configurato: down (HTTP 503), al pubblico solo lo stato', async () => {
    await sql`UPDATE calendar_backend_state SET mode = 'radicale', volume_id = ${randomUUID()}, epoch = 1 WHERE id = true`;
    invalidateBackendModeCache();
    try {
      const pub = await health();
      assert.equal(pub.status, 503);
      assert.deepEqual(pub.json, { status: 'down' });
      const admin = await health('admin');
      assert.equal(admin.status, 503);
      assert.equal(admin.json.status, 'down');
      assert.equal(admin.json.mode.store, 'radicale');
      assert.equal(admin.json.reasons[0].severity, 'down', 'motivi ordinati per gravità');
      assert.ok(codes(admin.json).includes('radicale_not_configured'), JSON.stringify(admin.json.reasons));
      // La funzione pura dà lo stesso esito.
      const report = await computeCalendarHealth();
      assert.equal(report.status, 'down');
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = 'postgres', volume_id = NULL, epoch = 0 WHERE id = true`;
      invalidateBackendModeCache();
    }
    const back = await health();
    assert.deepEqual(back.json, { status: 'ok' });
  });
});
