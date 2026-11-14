/**
 * Pagine di gestione del calendario v2 contro lo stack reale: import ed export,
 * collezioni in hold (applica e ricostruisci), badge delle occorrenze,
 * spostamento fra calendari trascinando sulla legenda e widget agenda.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './support/test';
import {
  addDays, calendarBySlug, confirmDialog, createCalendar, createEvent, dav, deviceCreate, deviceDelete, deviceIcs, discoverStack,
  eventChip, getObject, gotoCalendar, listOccurrences, nextSlot, quietDay, romeToday, syncStack, toastWith, uniq, V2, weekWindow,
  type StackCalendar,
} from './support/calendar';

const IMPORT_FIXTURE = fileURLToPath(new URL('./fixtures/import-sample.ics', import.meta.url));

let lavoro: StackCalendar;
let personale: StackCalendar;
test.beforeAll(async () => {
  lavoro = await calendarBySlug('e2e-lavoro');
  personale = await calendarBySlug('e2e-personale');
});

test.describe('import ed export', () => {
  test('anteprima, importazione con avanzamento ed esportazione', async ({ page, request }) => {
    const cal = await createCalendar(request, uniq('Import'));

    await page.goto('/calendario/calendari');
    const row = page.locator(`[data-testid="cal-calendar-row"][data-calendar-id="${cal.id}"]`);
    await expect(row).toBeVisible();
    await row.getByTestId('cal-import-open').click();

    // Gli UID del file sono unici per esecuzione: un UID già presente (anche in un altro calendario) non si importa.
    const run = randomBytes(3).toString('hex');
    const source = readFileSync(IMPORT_FIXTURE, 'utf8').replace(/@caldes\.test/g, `-${run}@caldes.test`);
    await page.getByTestId('cal-import-file').setInputFiles({ name: 'import-sample.ics', mimeType: 'text/calendar', buffer: Buffer.from(source) });
    await page.getByTestId('cal-import-preview').click();
    const summary = page.getByTestId('cal-import-summary');
    await expect(summary).toContainText('3');
    await expect(page.getByTestId('cal-import-plan')).toContainText('Import E2E settimanale');
    await expect(page.getByTestId('cal-import-plan')).toContainText('Import E2E due con promemoria');

    await page.getByTestId('cal-import-commit').click();
    await expect(page.getByTestId('cal-import-status')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });

    // Due eventi singoli e quattro occorrenze della serie settimanale.
    const occurrences = await listOccurrences(request, '2030-03-01T00:00:00.000Z', '2030-05-01T00:00:00.000Z', cal.id);
    expect(occurrences).toHaveLength(6);
    const alarmed = occurrences.find((o) => o.summary === 'Import E2E due con promemoria');
    expect(alarmed?.all_day).toBe(true);

    // Il promemoria e la proprietà X-* arrivano a Radicale così come erano nel file.
    const stored = await (await dav('GET', `${cal.collection_name}/e2e-import-due-${run}@caldes.test.ics`)).text();
    expect(stored).toContain('BEGIN:VALARM');
    expect(stored).toContain('X-E2E-CUSTOM:valore da conservare');

    // Esportazione del calendario: lo stesso contenuto, fuori dall'admin.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('cal-import-dialog')).toBeHidden();
    await page.reload();
    const href = await page.locator(`[data-testid="cal-calendar-row"][data-calendar-id="${cal.id}"]`).getByTestId('cal-export-link').getAttribute('href');
    expect(href).toBeTruthy();
    const exported = await request.get(href as string);
    expect(exported.status()).toBe(200);
    const text = await exported.text();
    expect(text).toContain('BEGIN:VCALENDAR');
    for (const uid of ['e2e-import-uno', 'e2e-import-due', 'e2e-import-tre']) expect(text).toContain(`UID:${uid}-${run}@caldes.test`);
    expect(text).toContain('BEGIN:VALARM');
  });
});

test.describe('collezione in hold', () => {
  /** Calendario con tre eventi (alle 20:00, 20:30 e 21:00 di un giorno tranquillo) che un dispositivo cancella tutti: la collezione svuotata va in hold. */
  async function emptiedByDevice(request: Parameters<typeof createEvent>[0], label: string) {
    const cal = await createCalendar(request, uniq(label));
    const titles: string[] = [];
    const created = [];
    for (let i = 1; i <= 3; i++) {
      const title = uniq(`${label} evento ${i}`);
      titles.push(title);
      created.push(await createEvent(request, { calendar: cal, title, day: quietDay(), hour: 20 + Math.floor((i - 1) / 2), minute: ((i - 1) % 2) * 30 }));
    }
    for (const c of created) await deviceDelete(cal, c.href);
    await syncStack(cal.id);
    return { cal, titles, created };
  }

  const collectionRow = (page: Parameters<typeof gotoCalendar>[0], calendarId: string) =>
    page.locator(`[data-testid="cal-health-collection"][data-calendar-id="${calendarId}"]`);

  test('applica le cancellazioni sospese', async ({ page, request }) => {
    const { cal, titles } = await emptiedByDevice(request, 'Hold applica');

    // Le occorrenze esistono ancora e portano il badge "hold".
    await gotoCalendar(page);
    await expect(eventChip(page, titles[0]).getByTestId('cal-occ-badge-hold')).toBeVisible();

    await page.goto('/calendario/salute');
    const row = collectionRow(page, cal.id);
    await expect(row).toHaveAttribute('data-health', 'hold');
    await row.getByTestId('cal-hold-apply').click();
    await expect(page.getByTestId('cal-hold-plan')).toContainText(titles[1]);
    const expected = await page.locator('label[for="cal-hold-confirm-input"] code').innerText();
    await page.getByTestId('cal-hold-confirm-input').fill(expected);
    await page.getByTestId('cal-hold-confirm').click();
    await expect(page.getByTestId('cal-hold-status')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await page.keyboard.press('Escape');

    await expect(collectionRow(page, cal.id)).not.toHaveAttribute('data-health', 'hold');
    const { from, to } = weekWindow();
    expect(await listOccurrences(request, from, to, cal.id)).toHaveLength(0);
  });

  test('ricostruisce le risorse dall\'indice', async ({ page, request }) => {
    const { cal, titles, created } = await emptiedByDevice(request, 'Hold ricostruisci');

    await page.goto('/calendario/salute');
    const row = collectionRow(page, cal.id);
    await expect(row).toHaveAttribute('data-health', 'hold');
    await row.getByTestId('cal-hold-rebuild').click();
    await expect(page.getByTestId('cal-hold-plan')).toContainText(titles[0]);
    const expected = await page.locator('label[for="cal-hold-confirm-input"] code').innerText();
    await page.getByTestId('cal-hold-confirm-input').fill(expected);
    await page.getByTestId('cal-hold-confirm').click();
    await expect(page.getByTestId('cal-hold-status')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await page.keyboard.press('Escape');

    await expect(collectionRow(page, cal.id)).not.toHaveAttribute('data-health', 'hold');
    // Le risorse sono di nuovo su Radicale e gli eventi hanno ancora gli stessi id.
    for (const c of created) {
      expect((await dav('GET', `${cal.collection_name}/${c.href}`)).status).toBe(200);
      expect((await getObject(request, c.id)).uid).toBe(c.uid);
    }
  });
});

test.describe('badge delle occorrenze', () => {
  test('calendario nuovo dal dispositivo', async ({ page, request }) => {
    const name = `e2e-device-${Date.now().toString(36)}`;
    const mk = await dav('MKCALENDAR', `${name}/`, {
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>'
        + `<D:displayname>${name}</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`
        + '</D:prop></D:set></C:mkcalendar>',
    });
    expect(mk.status, await mk.text()).toBeLessThan(300);
    await discoverStack();

    const list = await request.get(`${V2}/calendars`);
    const found = ((await list.json()) as { calendars: Array<{ id: string; slug: string; name: string; collection_name: string | null; needs_review: boolean }> }).calendars
      .find((c) => c.collection_name === name);
    expect(found?.needs_review).toBe(true);
    const cal: StackCalendar = { id: found!.id, slug: found!.slug, name: found!.name, collection_name: name };

    const title = uniq('Dal dispositivo');
    const slot = await nextSlot();
    await deviceCreate(cal, `${name}-evento`, deviceIcs(`${name}-evento`, title, romeToday(), slot.hour, slot.minute));

    await gotoCalendar(page);
    await expect(eventChip(page, title).getByTestId('cal-occ-badge-new_from_device')).toBeVisible();

    await page.goto('/calendario/calendari');
    const row = page.locator(`[data-testid="cal-calendar-row"][data-calendar-id="${cal.id}"]`);
    await expect(row.getByTestId('cal-calendar-new-badge')).toBeVisible();
    await row.getByTestId('cal-calendar-review-ack').click();
    await expect(row.getByTestId('cal-calendar-new-badge')).toBeHidden();

    await gotoCalendar(page);
    await expect(eventChip(page, title)).toBeVisible();
    await expect(eventChip(page, title).getByTestId('cal-occ-badge-new_from_device')).toHaveCount(0);
  });
});

test.describe('spostamento fra calendari', () => {
  test('trascinando l\'evento sulla legenda (MOVE)', async ({ page, request }) => {
    const title = uniq('Da spostare');
    const created = await createEvent(request, { calendar: lavoro, title, day: quietDay(), hour: 6, minute: 0 });

    await gotoCalendar(page);
    const chip = eventChip(page, title);
    const target = page.getByTestId(`cal-legend-drop-${personale.id}`);
    await expect(chip).toBeVisible();
    await chip.scrollIntoViewIfNeeded();
    const from = (await chip.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 - 12, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 25 });
    await page.mouse.up();

    await confirmDialog(page);
    await expect(toastWith(page, 'Spostato in')).toBeVisible();
    const moved = await getObject(request, created.id);
    expect(moved.calendar_id).toBe(personale.id);
    expect(moved.uid).toBe(created.uid);
    expect((await dav('GET', `${personale.collection_name}/${created.href}`)).status).toBe(200);
    expect((await dav('GET', `${lavoro.collection_name}/${created.href}`)).status).toBe(404);
  });

  test('dal pannello laterale: "Sposta in…"', async ({ page, request }) => {
    const title = uniq('Sposta dal pannello');
    const created = await createEvent(request, { calendar: lavoro, title, day: romeToday() });

    await gotoCalendar(page);
    await eventChip(page, title).click();
    await page.getByTestId('cal-panel-move').click();
    // Il nome compare anche nella legenda (che precede il pannello nel DOM): la voce del pannello è l'ultima.
    await page.getByRole('button', { name: personale.name }).last().click();
    await confirmDialog(page);
    await expect(toastWith(page, 'Spostato in')).toBeVisible();
    expect((await getObject(request, created.id)).calendar_id).toBe(personale.id);
  });

  test('duplica dal pannello laterale', async ({ page, request }) => {
    const title = uniq('Da duplicare');
    const created = await createEvent(request, { calendar: lavoro, title, day: romeToday() });

    await gotoCalendar(page);
    await eventChip(page, title).click();
    await page.getByTestId('cal-panel-duplicate').click();
    await expect(toastWith(page, 'Evento duplicato')).toBeVisible();
    // La copia si apre nell'editor: è un altro oggetto, con un altro UID.
    const editor = page.getByTestId('cal-editor-v2');
    await expect(editor).toBeVisible();
    await expect(editor.locator('#ev-summary')).not.toHaveValue('');
    const { from, to } = weekWindow();
    const copies = (await listOccurrences(request, from, to, lavoro.id)).filter((o) => (o.summary ?? '').includes(title));
    expect(copies.length).toBeGreaterThanOrEqual(2);
    expect(new Set(copies.map((o) => o.object_id)).size).toBe(copies.length);
    expect(copies.some((o) => o.object_id === created.id)).toBe(true);
  });
});

test.describe('widget agenda', () => {
  test('"Mostra altri" con il conteggio vero degli elementi', async ({ page, request }) => {
    const prefix = uniq('Agenda');
    const tomorrow = addDays(romeToday(), 1);
    for (let i = 1; i <= 12; i++) {
      await createEvent(request, { calendar: personale, title: `${prefix} ${String(i).padStart(2, '0')}`, day: tomorrow, hour: 8 + Math.floor((i - 1) / 2), minute: ((i - 1) % 2) * 30 });
    }

    await page.goto('/');
    await page.getByTestId('cal-agenda-window-tomorrow').click();
    const items = page.locator('p', { hasText: prefix });
    await expect(items).toHaveCount(8);
    const more = page.getByTestId('cal-agenda-more');
    await expect(more).toContainText('4');
    await more.click();
    await expect(items).toHaveCount(12);
    await expect(more).toHaveCount(0);
  });
});
