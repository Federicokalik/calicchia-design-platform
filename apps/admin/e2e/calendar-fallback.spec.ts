/**
 * Percorsi di ripiego dell'admin: con il backend in mode postgres l'editor è il
 * v1 e dell'API v2 si chiama solo /capabilities; se le capacità non rispondono
 * entro il timeout (5 s) l'editor v1 si apre senza aspettarle.
 */

import { expect, test } from './support/test';
import {
  calendarBySlug, createEvent, eventChip, gotoCalendar, romeToday, selectEvent, setBackendMode, uniq, wall, V2,
  type StackCalendar,
} from './support/calendar';

let lavoro: StackCalendar;
test.beforeAll(async () => {
  lavoro = await calendarBySlug('e2e-lavoro');
});

/** Apre l'editor dal pannello laterale e restituisce il titolo del dialogo, qualunque sia la versione dell'editor. */
async function openAnyEditor(page: Parameters<typeof gotoCalendar>[0], title: string) {
  await selectEvent(page, title);
  await page.getByRole('button', { name: 'Modifica', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Modifica evento' })).toBeVisible();
}

test.describe('mode postgres', () => {
  test.beforeAll(async () => {
    await setBackendMode('postgres');
  });
  test.afterAll(async () => {
    await setBackendMode('radicale');
  });

  test('editor v1 e nessuna chiamata v2 oltre a /capabilities', async ({ page, request }) => {
    const title = uniq('Evento v1');
    const today = romeToday();
    const start = wall(today, 10);
    const created = await request.post('/api/admin/calendar/events', {
      data: {
        calendar_id: lavoro.id,
        summary: title,
        start_time: new Date(Date.UTC(start.year, start.month - 1, start.day, 8, 0)).toISOString(),
        end_time: new Date(Date.UTC(start.year, start.month - 1, start.day, 9, 0)).toISOString(),
      },
    });
    expect(created.status(), await created.text()).toBe(200);

    const v2Calls = new Set<string>();
    page.on('request', (req) => {
      const { pathname } = new URL(req.url());
      if (pathname.startsWith(`${V2}/`)) v2Calls.add(pathname);
    });

    await gotoCalendar(page);
    await openAnyEditor(page, title);
    await expect(page.getByTestId('cal-editor-v2')).toHaveCount(0);
    await page.getByRole('button', { name: 'Annulla' }).click();

    // Le altre pagine del calendario non chiamano la v2 e il widget agenda usa la v1: ogni pagina si attende
    // fino al caricamento dei suoi dati, prima di contare le richieste.
    const eventsLoaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/calendar/events');
    await page.goto('/');
    await expect(page.getByTestId('cal-agenda-window-today')).toBeVisible();
    await eventsLoaded;

    const calendarsLoaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/calendar/calendars');
    await page.goto('/calendario/calendari');
    await calendarsLoaded;
    await expect(page.getByTestId('cal-calendar-row')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nuovo calendario' })).toBeVisible();

    await page.goto('/calendario/cestino');
    await expect(page.getByText('Il cestino non è disponibile: richiede il calendario su Radicale.')).toBeVisible();

    await page.goto('/calendario/salute');
    await expect(page.getByText('Salute del calendario non disponibile')).toBeVisible();

    const backupLoaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/backup/info');
    await page.goto('/impostazioni');
    await page.getByRole('button', { name: 'Backup', exact: true }).click();
    await backupLoaded;
    await expect(page.getByTestId('cal-backup-notice')).toHaveCount(0);

    expect([...v2Calls]).toEqual([`${V2}/capabilities`]);
    const caps = await (await request.get(`${V2}/capabilities`)).json();
    expect(caps.mode).toBe('postgres');
    expect(caps.occurrences).toBe(false);
  });
});

test.describe('capacità lente', () => {
  test('oltre 5 s l\'editor v1 si apre senza attendere la risposta', async ({ page, request }) => {
    const title = uniq('Capacità lente');
    await createEvent(request, { calendar: lavoro, title, day: romeToday() });

    // /capabilities risponde dopo 12 s: il client rinuncia a 5 s e ripiega sulla v1.
    let answered = false;
    await page.route(`**${V2}/capabilities`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      answered = true;
      await route.continue().catch(() => undefined);
    });

    const startedAt = Date.now();
    await page.goto('/calendario');
    await expect(page.locator('.fc-view')).toBeVisible();
    // La v1 parte subito, senza attendere le capacità: il chip c'è molto prima dei 5 s del timeout.
    await expect(eventChip(page, title)).toBeVisible({ timeout: 3_000 });
    await openAnyEditor(page, title);
    expect(Date.now() - startedAt, 'l\'editor v1 doveva aprirsi prima dei 5 s del timeout delle capacità').toBeLessThan(5_000);
    expect(answered, 'l\'editor v1 doveva aprirsi prima della risposta di /capabilities').toBe(false);
    await expect(page.getByTestId('cal-editor-v2')).toHaveCount(0);
  });
});
