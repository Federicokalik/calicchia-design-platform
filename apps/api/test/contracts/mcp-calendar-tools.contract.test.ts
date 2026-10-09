/**
 * Contratto MCP dei tool di calendario (F0, design §12 e §15).
 *
 * `apps/mcp` è un proxy puro: il contratto per i client MCP (e per chat
 * admin/Telegram e workflow) è l'array `tools` di src/lib/agent/tools.ts. Qui
 * si congela il comportamento attuale, prima di toccare lo storage:
 *  (a) schema: la lista vincolante dei tool di calendario (nomi, description,
 *      inputSchema, rischio, conferma, scope MCP) coincide con
 *      __snapshots__/mcp-calendar-tools.schema.json, generato da
 *      scripts/mcp-contract-snapshot.ts;
 *  (b) output: ogni tool viene eseguito con executeTool() (lo stesso wrapper
 *      di routes/mcp.ts e della chat) sullo scenario di _mcp-scenario.ts, e
 *      l'output JSON normalizzato, con gli effetti sul database per i tool di
 *      scrittura, coincide con __snapshots__/mcp-calendar-tools.outputs.json.
 *      Sono compresi i percorsi d'errore ({error} e {error, code}), gli eventi
 *      del calendario 'bookings' (proiezioni e manuali) e le festività in 'f';
 *  (c) forma HTTP di routes/mcp.ts: /tools per scope, involucro di /execute,
 *      tool_error, scope_denied, OTP per il rischio alto, tool inesistente.
 *
 * In F2 gli stessi casi girano su entrambi gli store; le sole differenze
 * ammesse sono quelle motivate in allowed-diffs.json.
 *
 * Aggiornamento degli snapshot (dopo aver verificato che il cambiamento è voluto):
 *   UPDATE_SNAPSHOTS=1 pnpm --filter @calicchia/api test test/contracts/mcp-calendar-tools.contract.test.ts
 *   pnpm --filter @calicchia/api contract:mcp-snapshot     (solo lo schema)
 *
 * Comportamenti attuali congelati qui e da correggere solo dopo F0 (design §14
 * e §12 "Parità prima"), ciascuno commentato nel caso relativo:
 *  - find_free_slots lavora nel fuso del server (UTC), non in Europe/Rome;
 *  - list_events perde le occorrenze di una serie già iniziate prima di `from`;
 *  - getEvent scambia un UID con forma di UUID per un id: update_event non lo trova;
 *  - get_events_for_today ignora in silenzio un calendario inesistente;
 *  - routes/mcp.ts scarta il `code` (CONFLICT, VALIDATION) dell'errore del tool;
 *  - la riprogrammazione proietta il nuovo evento con url null;
 *  - EXDATE e override "DST_SHIFTED" non combaciano più con la serie.
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { onBeforeDatabaseClose, onDatabaseReady, sql } from '../helpers/db';
import { api } from '../helpers/http';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { freezeTime, restoreTime } from '../helpers/clock';
import { executeTool } from '../../src/lib/agent/tools';
import {
  buildSchemaSnapshot,
  CONTRACT_ID,
  describeSchemaChanges,
  loadTools,
  readSchemaSnapshot,
  serializeSchemaSnapshot,
  writeSchemaSnapshot,
  type CalendarToolsSchemaSnapshot,
  type ToolLike,
} from '../../scripts/mcp-contract-snapshot';
import {
  diffJson,
  isAllowedDiff,
  isFilteredRun,
  JsonContractStore,
  loadAllowedDiffs,
  type AllowedDiff,
} from './_json-contract';
import {
  AliasRegistry,
  bookingState,
  calendarRow,
  createBaseScenario,
  createScenarioNormalizer,
  DST_SHIFTED_EXDATE,
  DST_SHIFTED_OVERRIDE_START,
  eventRows,
  HOLIDAY_NOW,
  NOW,
  overrideRows,
  UUID_SHAPED_UID,
  WEEK_FROM,
  WEEK_TO,
  type BaseScenario,
} from './_mcp-scenario';

const fx = useFixtures('mcp-calendario', { resetBaseline: true });

const OUTPUTS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '__snapshots__/mcp-calendar-tools.outputs.json');
const UPDATE_COMMAND = 'UPDATE_SNAPSHOTS=1 pnpm --filter @calicchia/api test test/contracts/mcp-calendar-tools.contract.test.ts';

const store = new JsonContractStore<Record<string, unknown>>({
  contract: CONTRACT_ID,
  file: OUTPUTS_PATH,
  description:
    'Output dei tool di calendario di src/lib/agent/tools.ts (via executeTool) sullo scenario di ' +
    'test/contracts/_mcp-scenario.ts, normalizzato (id, uid, token, timestamp di sistema), con gli effetti sul ' +
    "database dei tool di scrittura e la forma HTTP di routes/mcp.ts ('mcp-http/*'). Baseline F0 su PgLegacyStore.",
  regenerate: UPDATE_COMMAND,
});

const aliases = new AliasRegistry();
/** Tool del contratto eseguiti in questo run (copertura). */
const covered = new Set<string>();
let base: BaseScenario;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- output JSON arbitrario dei tool
type ToolOutput = any;

// ─── Ciclo di vita ───────────────────────────────

/**
 * Righe di audit_logs che la pulizia per prefisso non vede: le chiamate MCP
 * (table_name 'mcp_call', scritte da writeMcpAudit con la label del token) e i
 * trigger sugli eventi cancellati dai tool stessi (delete_event) o in cascata.
 */
async function cleanupAudit(): Promise<void> {
  const like = `%${fx.prefix}%`;
  const calendarIds = (await sql<Array<{ id: string }>>`
    SELECT id FROM calendars WHERE slug LIKE ${`${fx.prefix}%`} OR slug = 'f'
  `).map((r) => r.id);
  await sql`
    DELETE FROM audit_logs
    WHERE (table_name = 'mcp_call' AND user_email = ${`mcp:${fx.name('mcp')}`})
       OR (table_name IN ('calendars', 'calendar_events', 'calendar_subscriptions')
           AND (old_data::text LIKE ${like} OR new_data::text LIKE ${like}
                OR old_data->>'calendar_id' = ANY(${calendarIds}::text[])
                OR new_data->>'calendar_id' = ANY(${calendarIds}::text[])
                OR record_id = ANY(${calendarIds}::text[])))
  `;
}

// Lo scenario si crea dentro il `before` di useTestDatabase (dopo migrazioni,
// baseline e pre-pulizia del gruppo) e non con un `before` proprio: con node
// --test un `before` di primo livello registrato quando il test radice è già
// partito viene eseguito subito, in parallelo agli altri, e la creazione dei
// calendari andrebbe in deadlock con resetCalendarBaseline().
onDatabaseReady(cleanupAudit);
onDatabaseReady(async () => {
  freezeTime(NOW);
  base = await createBaseScenario(fx, aliases);
});
onBeforeDatabaseClose(async () => {
  // Prima la pulizia del gruppo (i DELETE scrivono a loro volta audit), poi l'audit residuo.
  await fx.cleanup();
  await cleanupAudit();
});

after(() => {
  restoreTime();
  store.flush();
});

// ─── Esecuzione dei casi ───────────────────────────────

function parseOutput(raw: string): ToolOutput {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Esegue il tool come routes/mcp.ts (executeTool: errori lanciati → {error}),
 * normalizza argomenti, output ed effetti con lo stesso normalizzatore (stessi
 * segnaposto) e li confronta con lo snapshot del caso `<tool>/<caso>`.
 */
async function runTool(
  caseName: string,
  tool: string,
  args: Record<string, unknown>,
  effects?: (output: ToolOutput) => Promise<unknown>,
): Promise<ToolOutput> {
  const output = parseOutput(await executeTool(tool, args));
  const effect = effects ? await effects(output) : undefined;
  const n = await createScenarioNormalizer(fx, aliases);
  const entry: Record<string, unknown> = { tool, args: n.normalize(args), output: n.normalize(output) };
  if (effect !== undefined) entry.effects = n.normalize(effect);
  store.check(`${tool}/${caseName}`, entry);
  covered.add(tool);
  return output;
}

// ─── (a) Schema ───────────────────────────────

test('schema: la lista vincolante dei tool di calendario coincide con tools.ts', async () => {
  const previous = readSchemaSnapshot();
  const result = buildSchemaSnapshot(await loadTools(), previous);
  assert.deepEqual(result.removed, [], `Tool vincolanti spariti da tools.ts: ${result.removed.join(', ')}`);
  assert.deepEqual(result.unclassified, [], `Tool di calendario senza famiglia: ${result.unclassified.join(', ')}`);

  if (store.updating) {
    if (!previous || serializeSchemaSnapshot(previous) !== serializeSchemaSnapshot(result.snapshot)) {
      writeSchemaSnapshot(result.snapshot);
    }
    return;
  }
  assert.ok(previous, 'Snapshot dello schema assente: pnpm --filter @calicchia/api contract:mcp-snapshot');
  const changes = describeSchemaChanges(previous, result.snapshot);
  assert.deepEqual(
    result.snapshot,
    previous,
    `Lo schema dei tool di calendario è cambiato:\n${changes.join('\n')}\n` +
      'Se è voluto: pnpm --filter @calicchia/api contract:mcp-snapshot (e verifica i client MCP).',
  );
  assert.equal(previous.count, previous.tools.length);
});

test('schema: regole della lista vincolante (rilevamento, alias, scope, tool mantenuti e rimossi)', () => {
  // Executor sintetici: i marcatori di calendario stanno nel sorgente della funzione.
  const calendarExec = async (): Promise<string> => JSON.stringify({ from: 'calendar_events' });
  const deleteExec = async (): Promise<string> => JSON.stringify({ from: 'calendar_events', op: 'delete' });
  const otherExec = async (): Promise<string> => JSON.stringify({ from: 'leads' });
  const tool = (name: string, execute: () => Promise<string>, extra: Partial<ToolLike> = {}): ToolLike => ({
    name, description: `Tool ${name}`, parameters: { type: 'object', properties: {} }, execute, ...extra,
  });

  const first = buildSchemaSnapshot([
    tool('list_events', calendarExec),
    tool('get_leads', otherExec),
    tool('list_events_alias', calendarExec),
    tool('delete_event', deleteExec, { riskLevel: 'high', requiresConfirmation: true }),
  ]);
  assert.deepEqual(first.snapshot.tools.map((t) => t.name), ['list_events', 'list_events_alias', 'delete_event']);
  assert.deepEqual(first.added, ['list_events', 'list_events_alias', 'delete_event']);
  assert.deepEqual(first.unclassified, ['list_events_alias']);
  // Stesso executor → alias; rischio di default 'low'; scope come routes/mcp.ts.
  assert.deepEqual(first.snapshot.tools[0].sharedExecutor, ['list_events', 'list_events_alias']);
  assert.equal(first.snapshot.tools[0].riskLevel, 'low');
  assert.deepEqual(first.snapshot.tools[0].mcp, { readTool: true, scopes: ['read', 'write', 'admin'] });
  assert.deepEqual(first.snapshot.tools[2].mcp, { readTool: false, scopes: ['admin'] });
  assert.equal(first.snapshot.tools[2].requiresConfirmation, true);

  // Dopo un refactor l'executor di list_events non ha più marcatori: resta
  // vincolante. L'alias sparito dall'array è segnalato come rimosso.
  const second = buildSchemaSnapshot([tool('list_events', otherExec), tool('delete_event', deleteExec, { riskLevel: 'high' })], first.snapshot);
  assert.deepEqual(second.snapshot.tools.map((t) => t.name), ['list_events', 'delete_event']);
  assert.deepEqual(second.sticky, ['list_events']);
  assert.deepEqual(second.removed, ['list_events_alias']);
  assert.deepEqual(second.added, []);
});

test('allowed-diffs.json: formato valido e regole di confronto', () => {
  // Il file reale: valido (vuoto in F0, le differenze previste sono solo documentate).
  const entries = loadAllowedDiffs();
  assert.ok(Array.isArray(entries));

  // Le regole di confronto, su dati sintetici (il file reale non ne contiene).
  const diffs = diffJson(
    { events: [{ uid: 'a', start: '1' }, { uid: 'b', start: '2' }], count: 2 },
    { count: 3, events: [{ start: '1', uid: 'x' }, { uid: 'b', start: '2' }, { uid: 'c', start: '3' }] },
  );
  assert.deepEqual(diffs, [
    { path: '/events/0/uid', kind: 'changed', expected: 'a', actual: 'x' },
    { path: '/events/2', kind: 'added', actual: { uid: 'c', start: '3' } },
    { path: '/count', kind: 'changed', expected: 2, actual: 3 },
  ]);
  const entry: AllowedDiff = {
    id: 'esempio', contract: CONTRACT_ID, case: 'list_events/*', path: '/output/events/*/uid',
    kind: 'changed', stores: ['radicale'], reason: 'esempio', design_ref: 'design.md §12',
  };
  const ctx = { contract: CONTRACT_ID, caseId: 'list_events/settimana', store: 'radicale' };
  const uidDiff = { path: '/output/events/4/uid', kind: 'changed' as const };
  assert.equal(isAllowedDiff(entry, ctx, uidDiff), true);
  assert.equal(isAllowedDiff(entry, { ...ctx, store: 'postgres' }, uidDiff), false);
  assert.equal(isAllowedDiff(entry, { ...ctx, caseId: 'list_events/a/b' }, uidDiff), false);
  assert.equal(isAllowedDiff(entry, ctx, { path: '/output/events/4/summary', kind: 'changed' }), false);
  assert.equal(isAllowedDiff({ ...entry, path: '/output/**' }, ctx, { path: '/output/events/4/summary', kind: 'changed' }), true);
});

// ─── (b) Output: tool di lettura ───────────────────────────────

test('get_calendar_today: prenotazioni ed eventi di oggi, giorno festivo', async () => {
  // Oggi (30 marzo): la prenotazione confermata arriva da calendar_bookings
  // (kind 'booking'), la sua proiezione è esclusa; restano l'override della
  // serie, l'evento manuale nel calendario 'bookings', l'iscrizione e il
  // calendario non bloccante. L'override cancellato del 31 non compare.
  const today = await runTool('oggi', 'get_calendar_today', {});
  assert.equal(today.date, '2027-03-30');
  assert.deepEqual(today.events.map((e: { kind: string }) => e.kind), ['event', 'event', 'event', 'booking', 'event', 'event']);

  // Pasquetta: la festività del calendario 'f' (00:00→24:00 di Roma) è un evento come gli altri.
  freezeTime(HOLIDAY_NOW);
  try {
    const holiday = await runTool('giorno-festivo', 'get_calendar_today', {});
    assert.equal(holiday.date, '2027-03-29');
    assert.ok(holiday.events.some((e: { title: string }) => e.title === base.events.pasquetta.summary));
  } finally {
    freezeTime(NOW);
  }
});

test('get_events_for_today: tutti, calendario bookings, calendario inesistente', async () => {
  await runTool('tutti', 'get_events_for_today', {});
  // Qui le proiezioni delle prenotazioni NON sono escluse (a differenza di get_calendar_today).
  const bookings = await runTool('calendario-bookings', 'get_events_for_today', { calendar: 'bookings' });
  assert.equal(bookings.count, 2);
  // Comportamento attuale: un calendario inesistente viene ignorato in silenzio
  // e la risposta contiene gli eventi di tutti i calendari (nessun {error}).
  const unknown = await runTool('calendario-inesistente', 'get_events_for_today', { calendar: 'inesistente' });
  const all = parseOutput(await executeTool('get_events_for_today', {}));
  assert.deepEqual(unknown, all);
});

test('list_calendars: calendari seminati e di test, conteggi e feed', async () => {
  const out = await runTool('tutti', 'list_calendars', {});
  // event_count conta le righe non cancellate (master, override, singoli), non le occorrenze.
  const lavoro = out.calendars.find((c: { slug: string }) => c.slug === base.calendars.lavoro.slug);
  assert.equal(lavoro.event_count, 7);
  const f = out.calendars.find((c: { slug: string }) => c.slug === 'f');
  assert.equal(f.event_count, 3);
});

test('list_events: settimana, f, bookings, serie attraverso il cambio d\'ora, iscrizione, errori', async () => {
  await runTool('settimana-tutti', 'list_events', { from: WEEK_FROM, to: WEEK_TO });
  // Festività in 'f': Pasqua dura 23 ore (cambio d'ora), Pasquetta 24, il Ponte è una chiusura timed.
  await runTool('festivita-f', 'list_events', { calendar: 'f', from: '2027-03-27T00:00:00.000Z', to: WEEK_TO });
  // Calendario 'bookings': proiezione (source 'booking') ed evento manuale.
  await runTool('calendario-bookings', 'list_events', { calendar: 'bookings', from: WEEK_FROM, to: WEEK_TO });

  // Serie per id del calendario: prima del 28 marzo alle 08:00Z, dopo alle 07:00Z.
  const dst = await runTool('serie-dst-per-id', 'list_events', {
    calendar: base.calendars.lavoro.id, from: romeIso('2027-03-22'), to: WEEK_TO,
  });
  const standup = dst.events.filter((e: { summary: string }) => e.summary.endsWith('Standup'));
  const starts = standup.map((e: { start_time: string }) => e.start_time);
  // EXDATE del 24 (ora solare, corretto) applicato; EXDATE "DST_SHIFTED" del 1° aprile
  // ignorato: l'occorrenza delle 07:00Z ricompare (comportamento attuale).
  assert.ok(base.series.standup.master.exdates.includes(DST_SHIFTED_EXDATE));
  assert.ok(!starts.includes('2027-03-24T08:00:00.000Z'));
  assert.ok(starts.includes('2027-04-01T07:00:00.000Z'));
  // Override "DST_SHIFTED" del 29: orfano, emesso accanto all'occorrenza regolare.
  assert.ok(starts.includes('2027-03-29T07:00:00.000Z'));
  const orphan = dst.events.find((e: { original_start: string | null; is_override: boolean }) =>
    e.is_override && e.original_start === DST_SHIFTED_OVERRIDE_START);
  assert.ok(orphan, 'override orfano assente');

  await runTool('iscrizione', 'list_events', { calendar: base.calendars.esterno.slug, from: WEEK_FROM, to: WEEK_TO });

  // BUG ATTUALE (design §14, "expandRRule.between perde gli eventi in corso"):
  // la Palestra (16:00-17:00Z) è in corso alle 16:30Z ma l'espansione parte da
  // `from` e la scarta; un evento singolo nella stessa situazione comparirebbe.
  const inProgress = await runTool('occorrenza-in-corso', 'list_events', {
    from: '2027-03-30T16:30:00.000Z', to: '2027-03-30T17:30:00.000Z',
  });
  assert.equal(inProgress.count, 0);

  const missing = await runTool('calendario-inesistente', 'list_events', { calendar: 'inesistente', from: WEEK_FROM, to: WEEK_TO });
  assert.deepEqual(missing, { error: 'Calendario non trovato' });
});

test('find_free_slots: finestre libere nella settimana, orario personalizzato, data non valida', async () => {
  // COMPORTAMENTO ATTUALE (design §12, release R+1): giornate e orario
  // lavorativo sono calcolati nel fuso del server (UTC in produzione), non in
  // Europe/Rome: le 09:00-18:00 di default sono le 11:00-20:00 di Roma in
  // ora legale. Bloccano solo eventi confermati e non all-day dei calendari
  // bloccanti (Pasquetta e Ponte compresi); tentative, all-day e calendari non
  // bloccanti no.
  const week = await runTool('settimana', 'find_free_slots', {
    from: '2027-03-29T00:00:00.000Z', to: '2027-04-03T00:00:00.000Z', duration_minutes: 60,
  });
  assert.ok(week.free_slots.every((s: { start: string }) => !s.start.startsWith('2027-03-29')), 'Pasquetta non bloccata');
  await runTool('orario-personalizzato', 'find_free_slots', {
    from: WEEK_FROM, to: WEEK_TO, duration_minutes: 30, working_hours_start: '07:00', working_hours_end: '16:00',
  });
  // Errore lanciato dalla query (cast di una data non valida): executeTool lo
  // trasforma nel messaggio generico.
  const invalid = await runTool('data-non-valida', 'find_free_slots', { from: 'non-una-data', to: WEEK_TO, duration_minutes: 30 });
  assert.deepEqual(invalid, { error: 'Errore esecuzione tool "find_free_slots"' });
});

test('list_event_types: pubblici, privati, inattivi e seminati', async () => {
  const out = await runTool('tutti', 'list_event_types', {});
  assert.equal(out.count, 6);
});

test('get_calendar_availability: slot della settimana, buffer, tipo privato, tipo inesistente', async () => {
  const { consulenza, sopralluogo, privato } = base.eventTypes;
  // Pasquetta e Ponte (calendario 'f') svuotano lunedì e venerdì; martedì
  // mancano gli slot occupati da override, riunione, prenotazione e telefonata.
  const week = await runTool('settimana', 'get_calendar_availability', {
    event_type_slug: consulenza.slug, from_date: '2027-03-29', to_date: '2027-04-02',
  });
  assert.deepEqual(week.slots_by_date['2027-03-29'], []);
  assert.deepEqual(week.slots_by_date['2027-04-02'], []);
  await runTool('buffer', 'get_calendar_availability', {
    event_type_slug: sopralluogo.slug, from_date: '2027-03-30', to_date: '2027-03-30',
  });
  // onlyPublic=false: anche i tipi non pubblici sono interrogabili (schedule di default).
  await runTool('tipo-privato', 'get_calendar_availability', {
    event_type_slug: privato.slug, from_date: '2027-04-01', to_date: '2027-04-01',
  });
  const missing = await runTool('tipo-inesistente', 'get_calendar_availability', {
    event_type_slug: fx.slug('inesistente'), from_date: '2027-03-29', to_date: '2027-03-30',
  });
  assert.deepEqual(missing, { error: 'Event type non trovato' });
});

test('list_bookings e list_cal_bookings: filtri per stato, date e limite; alias identico', async () => {
  const confirmed = await runTool('default-confermate', 'list_bookings', {});
  assert.equal(confirmed.count, 1);
  const all = await runTool('tutte', 'list_bookings', { status: 'all' });
  assert.equal(all.count, 3);
  await runTool('in-attesa', 'list_bookings', { status: 'pending' });
  await runTool('intervallo-date', 'list_bookings', { status: 'all', from_date: '2027-03-31', to_date: '2027-03-31' });
  await runTool('limite', 'list_bookings', { status: 'all', limit: 1 });

  // L'alias legacy condivide l'executor: stesso output a parità di argomenti.
  const alias = await runTool('tutte', 'list_cal_bookings', { status: 'all' });
  assert.deepEqual(alias, all);
});

// ─── (c) Forma HTTP di routes/mcp.ts ───────────────────────────────

test('routes/mcp.ts: GET /tools espone per scope gli stessi tool e schemi dello snapshot', async () => {
  const schema = readSchemaSnapshot() as CalendarToolsSchemaSnapshot;
  const names = new Set(schema.tools.map((t) => t.name));
  for (const scope of ['read', 'write', 'admin'] as const) {
    const { token } = await fx.mcpToken({ scope });
    const res = await api.get('/api/mcp/tools', { auth: { bearer: token } });
    assert.equal(res.status, 200);
    assert.equal(res.json.scope, scope);
    const listed = res.json.tools.filter((t: { name: string }) => names.has(t.name));
    const expected = schema.tools
      .filter((t) => t.mcp.scopes.includes(scope))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    assert.deepEqual(listed, expected, `tool di calendario esposti allo scope ${scope}`);
  }
});

test('routes/mcp.ts: involucro di /execute, tool_error, scope, OTP e tool inesistente', async () => {
  const tokens = {
    read: (await fx.mcpToken({ scope: 'read' })).token,
    write: (await fx.mcpToken({ scope: 'write' })).token,
    admin: (await fx.mcpToken({ scope: 'admin' })).token,
  };
  // Il rate limit di /execute è in memoria (20 chiamate per finestra di un
  // minuto) e l'orologio è fermo: questo test resta sotto le 20 chiamate.
  const execute = async (caseName: string, scope: keyof typeof tokens, name: string, args: Record<string, unknown>) => {
    const res = await api.post('/api/mcp/execute', { auth: { bearer: tokens[scope] }, body: { name, args } });
    const n = await createScenarioNormalizer(fx, aliases);
    store.check(`mcp-http/${caseName}`, {
      request: n.normalize({ scope, name, args }),
      status: res.status,
      body: n.normalize(res.json),
    });
    return res;
  };

  // Successo: il testo è l'output di executeTool, ri-serializzato; isError assente.
  const okArgs = { calendar: 'f' };
  const ok = await execute('successo', 'read', 'get_events_for_today', okArgs);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.content[0].text, await executeTool('get_events_for_today', okArgs));
  assert.equal('isError' in ok.json, false);

  const denied = await execute('scope-insufficiente', 'read', 'create_event', {
    calendar: 'lavoro', summary: fx.name('Mai creato'), start: romeIso('2027-04-12', '10:00'), end: romeIso('2027-04-12', '11:00'),
  });
  assert.equal(denied.status, 403);

  const toolError = await execute('errore-del-tool', 'write', 'list_events', { calendar: 'inesistente', from: WEEK_FROM, to: WEEK_TO });
  assert.equal(toolError.status, 200);
  assert.equal(toolError.json.isError, true);

  // COMPORTAMENTO ATTUALE: il tool risponde {error, code: 'VALIDATION'} ma
  // routes/mcp.ts tiene solo il messaggio e mette code 'tool_error'.
  const codeLost = await execute('errore-con-code', 'write', 'create_booking', {
    event_type_slug: base.eventTypes.consulenza.slug, start: 'non-una-data',
    attendee_name: 'Cliente MCP', attendee_email: fx.email('mcp-http'),
  });
  assert.deepEqual(JSON.parse(codeLost.json.content[0].text), { code: 'tool_error', error: 'Data inizio non valida', tool: 'create_booking' });

  const highWithWrite = await execute('rischio-alto-scope-write', 'write', 'delete_event', { id_or_uid: base.events.riunione.id });
  assert.equal(highWithWrite.status, 403);

  // Rischio alto con scope admin: OTP richiesto prima di eseguire (Telegram non
  // configurato nei test → telegram_delivered false). Nessun effetto sulla prenotazione.
  const otp = await execute('rischio-alto-otp', 'admin', 'cancel_booking', { uid: base.bookings.confermata.booking.uid });
  assert.equal(otp.status, 401);
  assert.equal(otp.json.needs_otp, true);
  const state = await bookingState(base.bookings.confermata.booking.uid);
  assert.equal(state.booking?.status, 'confirmed');

  // 'create_event_exception' è citato nelle description di update_event e delete_event ma non esiste.
  const missing = await execute('tool-inesistente', 'admin', 'create_event_exception', { id_or_uid: base.series.standup.master.id });
  assert.equal(missing.status, 404);
});

// ─── (b) Output: tool di scrittura ───────────────────────────────

test('create_booking e create_cal_booking: successo, conflitti, buffer e validazioni', async () => {
  const { consulenza, sopralluogo } = base.eventTypes;
  const booking = (start: string, name: string, extra: Record<string, unknown> = {}) => ({
    event_type_slug: consulenza.slug, start, attendee_name: name, attendee_email: fx.email(`mcp-${name.split(' ')[0].toLowerCase()}`), ...extra,
  });
  // Effetti: prenotazione e proiezioni; la nuova prenotazione riceve un alias
  // prima della normalizzazione, così compare con lo stesso nome ovunque.
  const effects = (key: string) => async (out: ToolOutput) => {
    if (!out.uid) return null;
    aliases.add(out.uid, `bk:${key}`);
    const state = await bookingState(out.uid);
    for (const p of state.projections) aliases.add(String(p.id), `ev:proiezione-${key}`);
    return state;
  };

  // Prenotazione MCP: source 'mcp', proiezione nel calendario 'bookings' con il template di booking.ts.
  const created = await runTool('successo', 'create_booking', booking(romeIso('2027-04-05', '09:00'), 'Giulia Bianchi', {
    attendee_phone: '+39 320 1111111', attendee_company: 'Bianchi SNC', attendee_message: 'Prima consulenza',
  }), effects('mcp-giulia'));
  assert.equal(created.success, true);

  const conflict = await runTool('conflitto', 'create_booking', booking(romeIso('2027-04-05', '09:00'), 'Carlo Blu'), effects('mcp-carlo'));
  assert.deepEqual(conflict, { error: 'Lo slot selezionato non è più disponibile', code: 'CONFLICT' });

  await runTool('successo', 'create_cal_booking', booking(romeIso('2027-04-05', '11:00'), 'Elena Viola'), effects('mcp-elena'));

  // Buffer di 30 minuti del sopralluogo: 16:15 è troppo vicino alla fine (16:00) di quello delle 15:00.
  await runTool('sopralluogo', 'create_booking', {
    ...booking(romeIso('2027-04-05', '15:00'), 'Franco Rosa'), event_type_slug: sopralluogo.slug,
  }, effects('mcp-franco'));
  const buffer = await runTool('buffer-violato', 'create_booking', {
    ...booking(romeIso('2027-04-05', '16:15'), 'Gino Grigi'), event_type_slug: sopralluogo.slug,
  }, effects('mcp-gino-rifiutata'));
  assert.equal(buffer.code, 'CONFLICT');
  await runTool('buffer-forzato', 'create_booking', {
    ...booking(romeIso('2027-04-05', '16:15'), 'Gino Grigi'), event_type_slug: sopralluogo.slug, allow_buffer_override: true,
  }, effects('mcp-gino'));

  await runTool('data-non-valida', 'create_booking', booking('domani alle nove', 'Ivo Neri'));
  // min_notice_hours = 0: il messaggio cita "0 ore" (testo attuale).
  await runTool('nel-passato', 'create_booking', booking(romeIso('2027-03-01', '09:00'), 'Ivo Neri'));
  await runTool('oltre-anticipo-massimo', 'create_booking', booking(romeIso('2028-06-01', '09:00'), 'Ivo Neri'));
  await runTool('tipo-inesistente', 'create_booking', { ...booking(romeIso('2027-04-05', '14:00'), 'Ivo Neri'), event_type_slug: fx.slug('inesistente') });
  await runTool('dati-mancanti', 'create_booking', { event_type_slug: consulenza.slug, start: romeIso('2027-04-05', '14:00'), attendee_name: 'Ivo Neri' });
  // Errore non di dominio (nome non stringa → TypeError in createBooking): {error} senza code.
  const generic = await runTool('errore-generico', 'create_booking', { ...booking(romeIso('2027-04-05', '14:00'), 'Ivo Neri'), attendee_name: 12345 });
  assert.equal('code' in generic, false);
  assert.equal(typeof generic.error, 'string');
});

test('reschedule_booking e update_cal_booking: successo, sovrapposizione, conflitto ed errori', async () => {
  const { consulenza } = base.eventTypes;
  const at = (date: string, time: string) => romeIso(date, time);
  const make = async (key: string, start: string, status?: 'cancelled') => {
    const created = await fx.booking({ eventType: consulenza, start, status, attendee: { name: `Cliente ${key}`, email: fx.email(`spostare-${key}`) } });
    aliases.booking(`spostare-${key}`, created);
    return created.booking.uid;
  };
  const moved = await make('base', at('2027-04-06', '09:00'));
  const overlap = await make('sovrapposta', at('2027-04-07', '09:00'));
  const obstacle = await make('ostacolo', at('2027-04-06', '14:00'));
  const blocked = await make('bloccata', at('2027-04-06', '16:00'));
  const viaAlias = await make('alias', at('2027-04-07', '15:00'));
  const cancelled = await make('annullata', at('2027-04-07', '11:00'), 'cancelled');

  // Effetti: stato delle prenotazioni coinvolte più quella nuova creata dalla
  // riprogrammazione, con alias `bk:<key>-nuova` assegnato prima della normalizzazione.
  const effects = (key: string, ...uids: string[]) => async (out: ToolOutput) => {
    const created = typeof out.uid === 'string' && !uids.includes(out.uid) ? out.uid : null;
    if (created) aliases.add(created, `bk:${key}-nuova`);
    const states = [];
    for (const uid of created ? [...uids, created] : uids) states.push(await bookingState(uid));
    return states;
  };

  // Successo: la vecchia diventa cancelled ("Rescheduled: ..."), la nuova ha
  // rescheduled_from_uid e una proiezione nuova. COMPORTAMENTO ATTUALE (design
  // §14, "meetingUrl null in riprogrammazione"): la nuova proiezione ha url null.
  const ok = await runTool('successo', 'reschedule_booking', { uid: moved, start: at('2027-04-06', '11:00'), reason: 'Richiesta del cliente' }, effects('spostare-base', moved));
  assert.equal(ok.previous_uid, moved);
  // Nuovo orario sovrapposto all'originale (09:00 → 09:30): accettato per MCP
  // (il controllo di disponibilità non è richiesto, la EXCLUDE vede la vecchia già cancellata nella tx).
  const shifted = await runTool('sovrapposta-all-originale', 'reschedule_booking', { uid: overlap, start: at('2027-04-07', '09:30') }, effects('spostare-sovrapposta', overlap));
  assert.equal(shifted.success, true);
  // Conflitto con un'altra prenotazione: rollback, l'originale resta confermata.
  const conflict = await runTool('conflitto', 'reschedule_booking', { uid: blocked, start: at('2027-04-06', '14:00') }, effects('spostare-bloccata', blocked, obstacle));
  assert.equal(conflict.code, 'CONFLICT');
  await runTool('nel-passato', 'reschedule_booking', { uid: blocked, start: at('2027-03-01', '09:00') }, effects('spostare-bloccata', blocked));
  await runTool('gia-annullata', 'reschedule_booking', { uid: cancelled, start: at('2027-04-07', '12:00') });
  await runTool('inesistente', 'reschedule_booking', { uid: 'nonesiste000', start: at('2027-04-07', '12:00') });
  await runTool('start-mancante', 'reschedule_booking', { uid: blocked });

  // Alias legacy con booking_id come sinonimo di uid.
  await runTool('successo-booking-id', 'update_cal_booking', { booking_id: viaAlias, start: at('2027-04-07', '16:00') }, effects('spostare-alias', viaAlias));
});

test('cancel_booking e cancel_cal_booking: successo, idempotenza ed errori', async () => {
  const { consulenza } = base.eventTypes;
  const make = async (key: string, time: string) => {
    const created = await fx.booking({ eventType: consulenza, start: romeIso('2027-04-09', time), attendee: { name: `Cliente ${key}`, email: fx.email(`annullare-${key}`) } });
    aliases.booking(`annullare-${key}`, created);
    return created.booking.uid;
  };
  const target = await make('base', '09:00');
  const viaAlias = await make('alias', '11:00');
  const effects = (uid: string) => () => bookingState(uid);

  // La prenotazione diventa cancelled (cancelled_by admin) e la proiezione status cancelled.
  await runTool('successo', 'cancel_booking', { uid: target, reason: 'Annullata dal cliente' }, effects(target));
  // Una seconda cancellazione risponde ancora success, senza modifiche.
  const again = await runTool('gia-annullata', 'cancel_booking', { uid: target, reason: 'Di nuovo' }, effects(target));
  assert.deepEqual(again, { success: true, uid: target });
  await runTool('inesistente', 'cancel_booking', { uid: 'nonesiste000' });
  await runTool('uid-mancante', 'cancel_booking', {});
  await runTool('successo-booking-id', 'cancel_cal_booking', { booking_id: viaAlias }, effects(viaAlias));
});

test('create_event: singolo, ricorrente, per nome, all-day ed errori', async () => {
  const { lavoro } = base.calendars;
  // Effetti: la riga creata, con alias `ev:mcp-<key>` assegnato prima della normalizzazione.
  const effects = (key: string) => async (out: ToolOutput) => {
    if (!out.event?.id) return null;
    fx.track('eventIds', out.event.id);
    aliases.event(`mcp-${key}`, out.event);
    return eventRows([out.event.id]);
  };
  const at = (date: string, time: string) => romeIso(date, time);

  // L'evento creato da MCP ha source 'mcp'.
  await runTool('singolo', 'create_event', {
    calendar: lavoro.slug, summary: fx.name('Call MCP'), description: 'Dettagli della call', location: 'Online',
    url: 'https://meet.caldes.test/mcp', start: at('2027-04-12', '10:00'), end: at('2027-04-12', '11:00'),
  }, effects('singolo'));
  // RRULE normalizzata da validateRRule; calendario indicato per id.
  await runTool('ricorrente', 'create_event', {
    calendar: lavoro.id, summary: fx.name('Revisione settimanale'), start: at('2027-04-12', '15:00'), end: at('2027-04-12', '15:30'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
  }, effects('ricorrente'));
  // Fallback per nome: esatto (case-insensitive) e poi contenuto.
  await runTool('per-nome', 'create_event', {
    calendar: fx.name('personale'), summary: fx.name('Dentista'), start: at('2027-04-13', '17:00'), end: at('2027-04-13', '18:00'),
  }, effects('per-nome'));
  await runTool('per-nome-parziale', 'create_event', {
    calendar: 'Esterno', summary: fx.name('Promemoria'), start: at('2027-04-13', '08:00'), end: at('2027-04-13', '08:15'),
  }, effects('per-nome-parziale'));
  await runTool('tutto-il-giorno', 'create_event', {
    calendar: lavoro.slug, summary: fx.name('Ferie'), start: romeIso('2027-04-14'), end: romeIso('2027-04-15'), all_day: true,
  }, effects('tutto-il-giorno'));

  // L'errore elenca tutti i calendari (nome e slug) per aiutare l'assistente.
  const missing = await runTool('calendario-inesistente', 'create_event', {
    calendar: 'inesistente', summary: fx.name('Mai creato'), start: at('2027-04-12', '10:00'), end: at('2027-04-12', '11:00'),
  });
  assert.match(missing.error, /^ERRORE: calendario "inesistente" non trovato — evento NON creato\. Calendari disponibili: /);
  await runTool('fine-prima-di-inizio', 'create_event', {
    calendar: lavoro.slug, summary: fx.name('Mai creato'), start: at('2027-04-12', '11:00'), end: at('2027-04-12', '10:00'),
  });
  await runTool('rrule-non-valida', 'create_event', {
    calendar: lavoro.slug, summary: fx.name('Mai creato'), start: at('2027-04-12', '10:00'), end: at('2027-04-12', '11:00'), rrule: 'FREQ=MAI;COUNT=x',
  });
  await runTool('titolo-mancante', 'create_event', {
    calendar: lavoro.slug, summary: '', start: at('2027-04-12', '10:00'), end: at('2027-04-12', '11:00'),
  });
  await runTool('date-non-valide', 'create_event', {
    calendar: lavoro.slug, summary: fx.name('Mai creato'), start: 'lunedì', end: at('2027-04-12', '11:00'),
  });
});

test('create_calendar: slug derivato o esplicito, default, duplicati ed errori', async () => {
  const effects = async (out: ToolOutput) => {
    if (!out.calendar?.id) return null;
    fx.track('calendarIds', out.calendar.id);
    return calendarRow(out.calendar.id);
  };
  // Slug derivato dal nome (prefisso compreso), blocks_availability esplicito.
  await runTool('successo', 'create_calendar', { name: fx.name('Clienti'), color: '#22c55e', blocks_availability: false }, effects);
  await runTool('slug-esplicito', 'create_calendar', { name: fx.name('Progetti'), slug: fx.slug('progetti-2027') }, effects);
  // Colore non valido → viola di default; fuso diverso accettato; blocca di default.
  await runTool('default-e-fuso', 'create_calendar', { name: fx.name('Estero'), color: 'rosso', timezone: 'America/New_York' }, effects);
  // I caratteri non [a-z0-9] diventano '-' (le lettere accentate si perdono).
  await runTool('slug-da-caratteri-speciali', 'create_calendar', { name: fx.name('Città & Co.') }, effects);

  await runTool('slug-duplicato', 'create_calendar', { name: fx.name('Clienti bis'), slug: fx.slug('clienti') }, effects);
  await runTool('nome-duplicato', 'create_calendar', { name: fx.name('clienti'), slug: fx.slug('altro-slug') }, effects);
  await runTool('nome-mancante', 'create_calendar', { name: '   ' }, effects);
  await runTool('timezone-non-valida', 'create_calendar', { name: fx.name('Fuso sbagliato'), timezone: 'Europe/Rom' }, effects);
});

test('update_event: per id e uid, serie, override, proiezioni, sola lettura ed errori', async () => {
  const { lavoro, bookings } = base.calendars;
  const at = (date: string, time: string) => romeIso(date, time);
  const single = await fx.event({ calendar: lavoro, summary: 'Riunione da spostare', start_time: at('2027-04-19', '10:00'), end_time: at('2027-04-19', '11:00'), url: 'https://meet.caldes.test/vecchio' });
  aliases.event('da-spostare', single);
  const series = await fx.series({
    calendar: lavoro, summary: 'Revisione', rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
    start_time: at('2027-04-19', '08:00'), end_time: at('2027-04-19', '08:30'),
    overrides: [{ originalStart: at('2027-04-26', '08:00'), start: at('2027-04-26', '09:00') }],
  });
  aliases.series('revisione', series, ['revisione-override']);
  const manual = await fx.event({ calendar: bookings, summary: 'Nota manuale', source: 'manual', start_time: at('2027-04-20', '12:00'), end_time: at('2027-04-20', '12:30') });
  aliases.event('nota-manuale', manual);
  const projected = await fx.booking({ eventType: base.eventTypes.consulenza, start: at('2027-04-08', '15:00'), attendee: { name: 'Sara Blu', email: fx.email('sara') } });
  aliases.booking('modificabile', projected);

  // Spostamento per id: l'output è la riga completa (rrule, exdates, recurrence_*).
  await runTool('sposta-per-id', 'update_event', {
    id_or_uid: single.id, summary: fx.name('Riunione spostata'), start: at('2027-04-19', '14:00'), end: at('2027-04-19', '15:00'),
  });
  // Per uid; stringa vuota → null (url rimosso).
  await runTool('per-uid', 'update_event', { id_or_uid: single.uid, location: 'Sala riunioni 2', url: '' });
  await runTool('nessuna-modifica', 'update_event', { id_or_uid: single.id });
  await runTool('stato-annullato', 'update_event', { id_or_uid: single.id, status: 'cancelled' });

  // Sul master la modifica vale per tutta la serie; l'override resta.
  await runTool('serie-cambia-rrule', 'update_event', { id_or_uid: series.master.id, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU;COUNT=6' },
    () => overrideRows(series.master.id));
  await runTool('override', 'update_event', { id_or_uid: series.overrides[0].id, summary: fx.name('Revisione straordinaria') });
  await runTool('serie-rimuove-rrule', 'update_event', { id_or_uid: series.master.id, rrule: '' });

  // Calendario 'bookings': proiezione ed evento manuale sono modificabili (decisione 8, parità).
  await runTool('proiezione-prenotazione', 'update_event', {
    id_or_uid: projected.projection!.id, summary: fx.name('Titolo cambiato da MCP'),
  }, () => bookingState(projected.booking.uid));
  await runTool('evento-manuale-bookings', 'update_event', { id_or_uid: manual.id, description: 'Richiamare entro sera' });

  // BUG ATTUALE (design §14, "getEvent scambia un UID con forma di UUID per un
  // id"): cercato per uid, l'evento non viene trovato; per id sì.
  assert.equal(base.events.uidUuid.uid, UUID_SHAPED_UID);
  const byUuidUid = await runTool('uid-con-forma-di-uuid', 'update_event', { id_or_uid: UUID_SHAPED_UID, summary: fx.name('Mai applicato') });
  assert.deepEqual(byUuidUid, { error: 'Evento non trovato' });

  await runTool('iscrizione-sola-lettura', 'update_event', { id_or_uid: base.events.webinar.id, summary: fx.name('Mai applicato') });
  await runTool('inesistente', 'update_event', { id_or_uid: '00000000-0000-4000-8000-000000000000', summary: 'x' });
  await runTool('start-non-valido', 'update_event', { id_or_uid: single.id, start: 'ieri' });
  await runTool('fine-prima-di-inizio', 'update_event', { id_or_uid: single.id, end: at('2027-04-19', '13:00') });
  await runTool('rrule-non-valida', 'update_event', { id_or_uid: series.master.id, rrule: 'FREQ=MAI' });
});

test('delete_event: singolo, per uid, override, serie, proiezioni, sola lettura ed errori', async () => {
  const { lavoro } = base.calendars;
  const at = (date: string, time: string) => romeIso(date, time);
  const single = await fx.event({ calendar: lavoro, summary: 'Da eliminare', start_time: at('2027-04-26', '10:00'), end_time: at('2027-04-26', '11:00') });
  aliases.event('da-eliminare', single);
  const byUid = await fx.event({ calendar: lavoro, summary: 'Da eliminare per uid', start_time: at('2027-04-26', '14:00'), end_time: at('2027-04-26', '15:00') });
  aliases.event('da-eliminare-per-uid', byUid);
  const withOverride = await fx.series({
    calendar: lavoro, summary: 'Serie con eccezione', rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=3',
    start_time: at('2027-04-29', '09:00'), end_time: at('2027-04-29', '10:00'),
    overrides: [{ originalStart: at('2027-05-06', '09:00'), start: at('2027-05-06', '11:00') }],
  });
  aliases.series('serie-eccezione', withOverride, ['serie-eccezione-override']);
  const doomed = await fx.series({
    calendar: lavoro, summary: 'Serie da eliminare', rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=3',
    start_time: at('2027-04-27', '09:00'), end_time: at('2027-04-27', '10:00'),
    overrides: [{ originalStart: at('2027-05-04', '09:00'), start: at('2027-05-04', '10:00') }],
  });
  aliases.series('serie-da-eliminare', doomed, ['serie-da-eliminare-override']);
  const cancelledWithProjection = await fx.booking({
    eventType: base.eventTypes.consulenza, start: at('2027-04-08', '10:00'), status: 'cancelled', project: true,
    attendee: { name: 'Teo Verdi', email: fx.email('teo') },
  });
  aliases.booking('annullata-con-proiezione', cancelledWithProjection);

  await runTool('singolo', 'delete_event', { id_or_uid: single.id }, () => eventRows([single.id]));
  await runTool('per-uid', 'delete_event', { id_or_uid: byUid.uid }, () => eventRows([byUid.id]));
  // Un override non si cancella: diventa status cancelled e continua a sopprimere l'occorrenza.
  await runTool('override', 'delete_event', { id_or_uid: withOverride.overrides[0].id }, () => eventRows([withOverride.overrides[0].id]));
  // Il master si cancella con i suoi override (ON DELETE CASCADE).
  await runTool('serie', 'delete_event', { id_or_uid: doomed.master.id }, () => eventRows([doomed.master.id, doomed.overrides[0].id]));

  // Proiezione di una prenotazione attiva: rifiutata. Di una annullata: cancellabile.
  const active = base.bookings.confermata;
  const refused = await runTool('proiezione-prenotazione-attiva', 'delete_event', { id_or_uid: active.projection!.id },
    () => eventRows([active.projection!.id]));
  assert.deepEqual(refused, { error: 'Evento di una prenotazione attiva: annullala da Calendario → Prenotazioni.' });
  await runTool('proiezione-prenotazione-annullata', 'delete_event', { id_or_uid: cancelledWithProjection.projection!.id },
    () => eventRows([cancelledWithProjection.projection!.id]));

  await runTool('iscrizione-sola-lettura', 'delete_event', { id_or_uid: base.events.webinar.id }, () => eventRows([base.events.webinar.id]));
  await runTool('inesistente', 'delete_event', { id_or_uid: '00000000-0000-4000-8000-000000000000' });
  // Errore lanciato (parametro undefined nella query): messaggio generico di executeTool.
  const generic = await runTool('id-mancante', 'delete_event', {});
  assert.deepEqual(generic, { error: 'Errore esecuzione tool "delete_event"' });
});

// ─── Copertura ───────────────────────────────

test('copertura: ogni tool vincolante ha casi di output, nessun caso obsoleto nello snapshot', (t) => {
  if (isFilteredRun()) {
    t.skip('run filtrato: la copertura si verifica solo sul file completo');
    return;
  }
  const schema = readSchemaSnapshot() as CalendarToolsSchemaSnapshot;
  const uncovered = schema.tools.map((tool) => tool.name).filter((name) => !covered.has(name));
  assert.deepEqual(uncovered, [], `tool vincolanti senza casi di output: ${uncovered.join(', ')}`);
  if (!store.updating) {
    assert.deepEqual(store.staleCases(), [], `casi nello snapshot non più eseguiti (rigenera con ${UPDATE_COMMAND})`);
  }
});
