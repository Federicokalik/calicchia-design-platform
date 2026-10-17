/**
 * Editor v2 dell'evento contro lo stack reale (API vera + Radicale 3.7.8):
 * ambiti di modifica di una serie, eliminazione e cestino, cronologia, tutto il
 * giorno, fuso, promemoria, invitati, editor ICS grezzo e conflitto 412.
 * Selettori `data-testid` di contratto §9.2.5; i gesti sono quelli di un utente.
 */

import { expect, test } from './support/test';
import {
  calendarBySlug, confirmDialog, createEvent, deleteObject, deviceEdit, eventChip, getObject, gotoCalendar, isoDate, listOccurrences,
  openEditor, openEvent, romeToday, toastWith, unfold, uniq, weekMonday, weekWindow,
  type StackCalendar,
} from './support/calendar';

let lavoro: StackCalendar;
test.beforeAll(async () => {
  lavoro = await calendarBySlug('e2e-lavoro');
});

test.describe('serie ricorrente: ambito della modifica', () => {
  /** Serie da lunedì a venerdì della settimana corrente (5 occorrenze, tutte nella vista). */
  const weekdaySeries = (title: string, request: Parameters<typeof createEvent>[0]) =>
    createEvent(request, { calendar: lavoro, title, day: weekMonday(), rrule: 'FREQ=DAILY;COUNT=5' });

  test('solo questa occorrenza', async ({ page, request }) => {
    const title = uniq('Serie solo questa');
    await weekdaySeries(title, request);
    const changed = `${title} (mod)`;

    await openEvent(page, title, 2);
    const editor = page.getByTestId('cal-editor-v2');
    await editor.locator('#ev-summary').fill(changed);
    await page.getByTestId('cal-editor-save').click();
    await page.getByTestId('cal-scope-this').click();
    await expect(toastWith(page, 'Evento aggiornato')).toBeVisible();

    await expect(eventChip(page, changed)).toHaveCount(1);
    await expect(eventChip(page, title).filter({ hasNotText: '(mod)' })).toHaveCount(4);
  });

  test('questa e le successive', async ({ page, request }) => {
    const title = uniq('Serie da qui');
    await weekdaySeries(title, request);
    const changed = `${title} (mod)`;

    await openEvent(page, title, 2);
    await page.getByTestId('cal-editor-v2').locator('#ev-summary').fill(changed);
    await page.getByTestId('cal-editor-save').click();
    await page.getByTestId('cal-scope-this_and_future').click();
    await expect(toastWith(page, 'Serie divisa')).toBeVisible();

    // Mercoledì, giovedì e venerdì cambiano; lunedì e martedì restano quelli di prima.
    await expect(eventChip(page, changed)).toHaveCount(3);
    await expect(eventChip(page, title).filter({ hasNotText: '(mod)' })).toHaveCount(2);
  });

  test('tutta la serie', async ({ page, request }) => {
    const title = uniq('Serie tutta');
    await weekdaySeries(title, request);
    const changed = `${title} (mod)`;

    await openEvent(page, title, 2);
    await page.getByTestId('cal-editor-v2').locator('#ev-summary').fill(changed);
    await page.getByTestId('cal-editor-save').click();
    await page.getByTestId('cal-scope-all').click();
    await expect(toastWith(page, 'Evento aggiornato')).toBeVisible();

    await expect(eventChip(page, changed)).toHaveCount(5);
    await expect(eventChip(page, title).filter({ hasNotText: '(mod)' })).toHaveCount(0);
  });
});

test.describe('eliminazione, cestino e cronologia', () => {
  // Con il server vero la DELETE dell'admin (senza corpo) arriva a sameOriginWrites con un corpo
  // "presente" ma senza Content-Type JSON e riceve 415: difetto dell'app, non dello scenario.
  test('elimina un evento dall\'editor e lo ripristina dal cestino con lo stesso id', async ({ page, request }) => {
    const title = uniq('Da cestinare');
    const created = await createEvent(request, { calendar: lavoro, title, day: romeToday() });

    await openEvent(page, title);
    await page.getByTestId('cal-editor-delete').click();
    await confirmDialog(page);
    await expect(toastWith(page, 'Evento eliminato')).toBeVisible();
    await expect(eventChip(page, title)).toHaveCount(0);

    await page.goto('/calendario/cestino');
    const item = page.getByTestId('cal-trash-item').filter({ hasText: title });
    await expect(item).toBeVisible();
    await item.getByTestId('cal-trash-restore').click();
    await page.getByTestId('cal-trash-restore-confirm').click();
    await expect(toastWith(page, 'Evento ripristinato')).toBeVisible();
    await expect(page.getByTestId('cal-trash-item').filter({ hasText: title })).toHaveCount(0);

    // Stesso identificativo e stesso UID: i dispositivi lo rivedono come lo stesso evento.
    const restored = await getObject(request, created.id);
    expect(restored.uid).toBe(created.uid);
    await gotoCalendar(page);
    await expect(eventChip(page, title)).toHaveCount(1);
  });

  test('ripristina dal cestino un evento eliminato, con lo stesso id', async ({ page, request }) => {
    const title = uniq('Nel cestino');
    const created = await createEvent(request, { calendar: lavoro, title, day: romeToday() });
    await deleteObject(request, created);

    await page.goto('/calendario/cestino');
    const item = page.getByTestId('cal-trash-item').filter({ hasText: title });
    await expect(item).toBeVisible();
    await item.getByTestId('cal-trash-restore').click();
    await page.getByTestId('cal-trash-restore-confirm').click();
    await expect(toastWith(page, 'Evento ripristinato')).toBeVisible();

    expect((await getObject(request, created.id)).uid).toBe(created.uid);
    await gotoCalendar(page);
    await expect(eventChip(page, title)).toHaveCount(1);
  });

  test('ripristina una versione dalla cronologia', async ({ page, request }) => {
    const original = uniq('Versione originale');
    const created = await createEvent(request, { calendar: lavoro, title: original, day: romeToday() });
    const edited = `${original} modificato`;

    const editor = await openEvent(page, original);
    await editor.locator('#ev-summary').fill(edited);
    await page.getByTestId('cal-editor-save').click();
    await expect(toastWith(page, 'Evento aggiornato')).toBeVisible();
    expect((await getObject(request, created.id)).master?.fields.summary).toBe(edited);

    await gotoCalendar(page);
    await openEditor(page, edited);
    await page.getByTestId('cal-history-open').click();
    const items = page.getByTestId('cal-history-item');
    await expect(items.nth(1)).toBeVisible();
    // La versione più vecchia è quella creata dall'admin con il titolo originale.
    await items.last().click();
    await expect(page.getByTestId('cal-history-restore')).toBeEnabled();
    await page.getByTestId('cal-history-restore').click();
    await confirmDialog(page);
    await expect(toastWith(page, 'Versione ripristinata')).toBeVisible();

    await expect(page.getByTestId('cal-editor-v2').locator('#ev-summary')).toHaveValue(original);
    expect((await getObject(request, created.id)).master?.fields.summary).toBe(original);
  });
});

test.describe('campi dell\'evento', () => {
  test('evento di giornata intera creato dall\'editor', async ({ page, request }) => {
    const title = uniq('Tutto il giorno');
    const today = romeToday();

    await gotoCalendar(page);
    await page.getByRole('button', { name: 'Nuovo evento' }).click();
    const editor = page.getByTestId('cal-editor-v2');
    await editor.locator('#ev-summary').fill(title);
    await editor.locator('#ev-calendar').selectOption({ label: 'E2E Lavoro' });
    await page.getByTestId('cal-tab-tempo').click();
    await editor.getByRole('switch', { name: 'Tutto il giorno' }).click();
    await editor.getByLabel('Data di inizio').fill(isoDate(today));
    await page.getByTestId('cal-editor-save').click();
    await expect(toastWith(page, 'Evento creato')).toBeVisible();

    await expect(eventChip(page, title)).toBeVisible();
    const { from, to } = weekWindow();
    const occ = (await listOccurrences(request, from, to, lavoro.id)).find((o) => o.summary === title);
    expect(occ?.all_day).toBe(true);
  });

  test('evento in un fuso diverso da quello del calendario', async ({ page, request }) => {
    const title = uniq('Fuso Tokyo');
    const today = romeToday();

    await gotoCalendar(page);
    await page.getByRole('button', { name: 'Nuovo evento' }).click();
    const editor = page.getByTestId('cal-editor-v2');
    await editor.locator('#ev-summary').fill(title);
    await editor.locator('#ev-calendar').selectOption({ label: 'E2E Lavoro' });
    await page.getByTestId('cal-tab-tempo').click();
    await editor.getByLabel('Data di inizio').fill(isoDate(today));
    await editor.getByLabel('Ora di inizio').fill('10:00');
    await editor.locator('#ev-tz').selectOption('Asia/Tokyo');
    await page.getByTestId('cal-editor-save').click();
    await expect(toastWith(page, 'Evento creato')).toBeVisible();

    // 10:00 a Tokyo (UTC+9, senza ora legale) sono le 01:00 UTC dello stesso giorno.
    const { from, to } = weekWindow();
    const occ = (await listOccurrences(request, from, to, lavoro.id)).find((o) => o.summary === title);
    expect(occ).toBeTruthy();
    expect(Date.parse(occ!.start_utc)).toBe(Date.UTC(today.year, today.month - 1, today.day, 1, 0));
    const view = await getObject(request, occ!.object_id);
    expect(view.master?.fields.start.zone).toEqual({ kind: 'tzid', tzid: 'Asia/Tokyo' });
  });

  test('promemoria', async ({ page, request }) => {
    const title = uniq('Con promemoria');
    const created = await createEvent(request, { calendar: lavoro, title, day: romeToday() });

    const editor = await openEvent(page, title);
    await page.getByTestId('cal-tab-promemoria').click();
    await editor.getByRole('button', { name: 'Aggiungi promemoria' }).click();
    await expect(editor.getByLabel('Tipo di promemoria')).toHaveCount(1);
    await page.getByTestId('cal-editor-save').click();
    await expect(toastWith(page, 'Evento aggiornato')).toBeVisible();

    const ics = (await getObject(request, created.id)).ics;
    expect(ics).toContain('BEGIN:VALARM');
    expect(ics).toMatch(/TRIGGER:-PT15M/);

    await gotoCalendar(page);
    const reopened = await openEditor(page, title);
    await page.getByTestId('cal-tab-promemoria').click();
    await expect(reopened.getByLabel('Tipo di promemoria')).toHaveCount(1);
  });

  test('invitati', async ({ page, request }) => {
    const title = uniq('Con invitati');
    const created = await createEvent(request, { calendar: lavoro, title, day: romeToday() });

    const editor = await openEvent(page, title);
    await page.getByTestId('cal-tab-partecipanti').click();
    await editor.getByRole('button', { name: 'Aggiungi invitato' }).click();
    await editor.getByLabel('Email dell\'invitato').fill('ospite@example.test');
    await page.getByTestId('cal-editor-save').click();
    await expect(toastWith(page, 'Evento aggiornato')).toBeVisible();

    expect(unfold((await getObject(request, created.id)).ics)).toMatch(/ATTENDEE[^\r\n]*mailto:ospite@example\.test/i);

    await gotoCalendar(page);
    const reopened = await openEditor(page, title);
    await page.getByTestId('cal-tab-partecipanti').click();
    await expect(reopened.getByLabel('Email dell\'invitato')).toHaveValue('ospite@example.test');
  });
});

test.describe('editor ICS grezzo', () => {
  test('verifica e salva il testo', async ({ page, request }) => {
    const title = uniq('Testo grezzo');
    const created = await createEvent(request, { calendar: lavoro, title, day: romeToday() });
    const rewritten = `${title} riscritto`;

    const editor = await openEvent(page, title);
    await page.getByTestId('cal-tab-avanzate').click();
    await expect(page.getByTestId('cal-raw-editor')).toBeVisible();
    const text = editor.getByLabel('Testo ICS');
    const source = await text.inputValue();
    expect(source).toContain(`SUMMARY:${title}`);
    await text.fill(source.replace(`SUMMARY:${title}`, `SUMMARY:${rewritten}`));

    await page.getByTestId('cal-raw-check').click();
    await expect(editor.getByText('Il testo è valido.')).toBeVisible();
    await page.getByTestId('cal-raw-save').click();
    await expect(toastWith(page, 'Testo ICS salvato')).toBeVisible();

    expect((await getObject(request, created.id)).ics).toContain(`SUMMARY:${rewritten}`);
  });

  test('un testo con UID diverso non si salva', async ({ page, request }) => {
    const title = uniq('Testo non valido');
    await createEvent(request, { calendar: lavoro, title, day: romeToday() });

    const editor = await openEvent(page, title);
    await page.getByTestId('cal-tab-avanzate').click();
    const text = editor.getByLabel('Testo ICS');
    await text.fill((await text.inputValue()).replace(/UID:.*/, 'UID:un-altro-uid'));
    await page.getByTestId('cal-raw-check').click();
    await expect(editor.getByRole('status').locator('li').first()).toBeVisible();
    await expect(editor.getByText('Il testo è valido.')).toHaveCount(0);
  });
});

test.describe('conflitti di versione', () => {
  test('412: una modifica concorrente di un dispositivo apre il dialogo dei conflitti', async ({ page, request }) => {
    const title = uniq('Conflitto');
    const created = await createEvent(request, { calendar: lavoro, title, day: romeToday() });
    const mine = `${title} mio`;

    const editor = await openEvent(page, title);
    // Mentre l'editor è aperto, un dispositivo cambia lo stesso campo direttamente su Radicale.
    await deviceEdit(lavoro, created.href, (text) => text.replace(`SUMMARY:${title}`, `SUMMARY:${title} dal dispositivo`));
    await editor.locator('#ev-summary').fill(mine);
    await page.getByTestId('cal-editor-save').click();

    await expect(page.getByTestId('cal-conflict-dialog')).toBeVisible();
    await page.getByTestId('cal-conflict-keep-summary').check();
    await page.getByTestId('cal-conflict-resolve').click();
    await expect(toastWith(page, 'Evento aggiornato')).toBeVisible();

    expect((await getObject(request, created.id)).master?.fields.summary).toBe(mine);
  });

  test('412 sul testo grezzo: ricarica o sovrascrivi', async ({ page, request }) => {
    const title = uniq('Conflitto grezzo');
    const created = await createEvent(request, { calendar: lavoro, title, day: romeToday() });

    const editor = await openEvent(page, title);
    await page.getByTestId('cal-tab-avanzate').click();
    const text = editor.getByLabel('Testo ICS');
    const source = await text.inputValue();
    await deviceEdit(lavoro, created.href, (t) => t.replace(`SUMMARY:${title}`, `SUMMARY:${title} dal dispositivo`));
    await text.fill(source.replace(`SUMMARY:${title}`, `SUMMARY:${title} dal testo`));
    await page.getByTestId('cal-raw-save').click();

    await expect(page.getByTestId('cal-raw-reload')).toBeVisible();
    await page.getByTestId('cal-raw-overwrite').click();
    await confirmDialog(page);
    await expect(toastWith(page, 'Testo ICS salvato')).toBeVisible();
    expect((await getObject(request, created.id)).ics).toContain(`SUMMARY:${title} dal testo`);
  });
});
