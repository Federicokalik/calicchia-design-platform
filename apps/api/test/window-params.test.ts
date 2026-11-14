/**
 * Parametri a finestra per le sovrapposizioni della vista calendario e del
 * widget agenda (F6 tranche C, passo C3; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.6):
 *
 *  - `GET /api/project-tasks?due_from=&due_to=` (estremi inclusi);
 *  - `GET /api/client-projects?overlap_from=&overlap_to=` (progetti con
 *    `start_date ≤ overlap_to` e `coalesce(target_end_date, start_date) ≥ overlap_from`).
 *
 * Senza i parametri nuovi la risposta è quella di sempre; un valore non valido
 * non filtra.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { onBeforeDatabaseClose, onDatabaseReady, sql, useTestDatabase } from './helpers/db';
import { useFixtures } from './helpers/fixtures';
import { api } from './helpers/http';

useTestDatabase();
const fx = useFixtures('window-params');

async function cleanup(): Promise<void> {
  const like = `${fx.prefix}%`;
  const projects = (await sql<Array<{ id: string }>>`SELECT id FROM client_projects WHERE name LIKE ${like}`).map((r) => r.id);
  const customers = (await sql<Array<{ id: string }>>`SELECT id FROM customers WHERE contact_name LIKE ${like}`).map((r) => r.id);
  if (!projects.length && !customers.length) return;
  await sql`DELETE FROM project_tasks WHERE project_id = ANY(${projects}::uuid[])`;
  await sql`DELETE FROM client_projects WHERE id = ANY(${projects}::uuid[])`;
  await sql`DELETE FROM customers WHERE id = ANY(${customers}::uuid[])`;
  await sql`DELETE FROM audit_logs WHERE record_id = ANY(${[...customers, ...projects]}::text[])`;
  await sql`DELETE FROM webhook_events WHERE entity_id = ANY(${customers}::uuid[])`;
}
onDatabaseReady(cleanup);
onBeforeDatabaseClose(cleanup);

/** Progetti e task del file, con date lontane da quelle di altri dati del database. */
async function seed(): Promise<{ projectId: string }> {
  await cleanup();
  const [customer] = await sql<Array<{ id: string }>>`INSERT INTO customers (contact_name) VALUES (${fx.name('Cliente')}) RETURNING id`;
  const insert = async (name: string, start: string | null, end: string | null): Promise<string> => {
    const [p] = await sql<Array<{ id: string }>>`
      INSERT INTO client_projects (customer_id, name, start_date, target_end_date)
      VALUES (${customer.id}::uuid, ${fx.name(name)}, ${start}::date, ${end}::date) RETURNING id
    `;
    return p.id;
  };
  const main = await insert('Progetto con fine', '2031-03-10', '2031-03-20');
  await insert('Progetto senza fine', '2031-03-15', null);
  await insert('Progetto lontano', '2031-06-01', '2031-06-30');
  await insert('Progetto senza date', null, null);
  for (const [title, due] of [['Prima', '2031-03-09'], ['Dentro 1', '2031-03-10'], ['Dentro 2', '2031-03-12'], ['Dentro 3', '2031-03-14'], ['Dopo', '2031-03-15']] as const) {
    await sql`INSERT INTO project_tasks (project_id, title, status, due_date) VALUES (${main}::uuid, ${fx.name(title)}, 'todo'::task_status, ${due}::date)`;
  }
  await sql`INSERT INTO project_tasks (project_id, title, status) VALUES (${main}::uuid, ${fx.name('Senza scadenza')}, 'todo'::task_status)`;
  return { projectId: main };
}

const titles = (rows: Array<{ title?: string; name?: string }>): string[] =>
  rows.map((r) => (r.title ?? r.name ?? '').replace(`${fx.prefix} `, '').replace(fx.prefix, '')).sort();

describe('GET /api/project-tasks: due_from e due_to', () => {
  test('estremi inclusi; senza parametri la risposta è invariata', async () => {
    const { projectId } = await seed();
    const base = { auth: 'admin' as const, query: { project_id: projectId, limit: 200 } };

    const all = await api.get('/api/project-tasks', base);
    assert.equal(all.status, 200);
    assert.equal(all.json.count, 6, 'senza finestra: tutti i task del progetto, anche senza scadenza');

    const win = await api.get('/api/project-tasks', { ...base, query: { ...base.query, due_from: '2031-03-10', due_to: '2031-03-14' } });
    assert.equal(win.status, 200);
    assert.deepEqual(titles(win.json.tasks), ['Dentro 1', 'Dentro 2', 'Dentro 3']);
    assert.equal(win.json.count, 3);

    const fromOnly = await api.get('/api/project-tasks', { ...base, query: { ...base.query, due_from: '2031-03-14' } });
    assert.deepEqual(titles(fromOnly.json.tasks), ['Dentro 3', 'Dopo']);

    const toOnly = await api.get('/api/project-tasks', { ...base, query: { ...base.query, due_to: '2031-03-09' } });
    assert.deepEqual(titles(toOnly.json.tasks), ['Prima']);
  });

  test('un valore non valido non filtra; due_date esatta resta com\'era', async () => {
    const { projectId } = await seed();
    const bad = await api.get('/api/project-tasks', { auth: 'admin', query: { project_id: projectId, limit: 200, due_from: '2031-02-30', due_to: 'domani' } });
    assert.equal(bad.json.count, 6);
    const exact = await api.get('/api/project-tasks', { auth: 'admin', query: { project_id: projectId, due_date: '2031-03-12' } });
    assert.deepEqual(titles(exact.json.tasks), ['Dentro 2']);
  });
});

describe('GET /api/client-projects: overlap_from e overlap_to', () => {
  const mine = (rows: Array<{ name: string }>): string[] => titles(rows.filter((r) => r.name.startsWith(fx.prefix)));

  test('sovrapposizione con la finestra (estremi inclusi); la fine mancante vale la data di inizio', async () => {
    await seed();
    const q = (extra: Record<string, string>) => api.get('/api/client-projects', { auth: 'admin', query: { limit: 100, search: fx.prefix, ...extra } });

    const all = await q({});
    assert.equal(all.status, 200);
    assert.deepEqual(mine(all.json.projects), ['Progetto con fine', 'Progetto lontano', 'Progetto senza date', 'Progetto senza fine']);

    const inside = await q({ overlap_from: '2031-03-20', overlap_to: '2031-03-25' });
    assert.deepEqual(mine(inside.json.projects), ['Progetto con fine'], 'finisce il 20: lo include; quello senza fine dura il solo 15');

    const day = await q({ overlap_from: '2031-03-15', overlap_to: '2031-03-15' });
    assert.deepEqual(mine(day.json.projects), ['Progetto con fine', 'Progetto senza fine']);

    const before = await q({ overlap_to: '2031-03-09' });
    assert.deepEqual(mine(before.json.projects), [], 'nessun progetto inizia prima del 10 marzo (quello senza date non si può collocare)');

    const after = await q({ overlap_from: '2031-06-30', overlap_to: '2031-07-31' });
    assert.deepEqual(mine(after.json.projects), ['Progetto lontano']);
  });

  test('un valore non valido non filtra', async () => {
    await seed();
    const res = await api.get('/api/client-projects', { auth: 'admin', query: { limit: 100, search: fx.prefix, overlap_from: 'ieri', overlap_to: '2031-13-01' } });
    assert.equal(mine(res.json.projects).length, 4);
  });
});
