/**
 * Utilità degli scenari del calendario: informazioni dello stack, date nel
 * fuso di Roma, creazione di eventi con l'API admin v2 (stesso percorso e
 * stessa sessione del browser, via il proxy di vite preview), scritture
 * "da dispositivo" direttamente su Radicale e gesti ricorrenti sulla pagina.
 *
 * Gli eventi si creano via API e si modificano dall'interfaccia: gli scenari
 * provano l'admin, non la preparazione dei dati. Ogni titolo ha un suffisso
 * casuale, così gli scenari non si pestano i piedi sullo stesso stack.
 */

import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { CONTROL_URL } from './env';

export const V2 = '/api/admin/calendar/v2';
export const TZ = 'Europe/Rome';

// ─── Stack ───────────────────────────────

export interface StackCalendar { id: string; slug: string; name: string; collection_name: string | null }
export interface StackInfo {
  radicale: { url: string; user: string; password: string; principal: string };
  calendars: StackCalendar[];
}

let stackCache: StackInfo | null = null;

/** Informazioni dello stack (Radicale, calendari seminati dagli e2e). */
export async function stack(): Promise<StackInfo> {
  if (!stackCache) {
    const res = await fetch(`${CONTROL_URL}/stack`);
    if (!res.ok) throw new Error(`Informazioni dello stack non disponibili: HTTP ${res.status}`);
    stackCache = (await res.json()) as StackInfo;
  }
  return stackCache;
}

/** Calendario degli e2e per slug (`e2e-lavoro`, `e2e-personale`, `e2e-archivio`). */
export async function calendarBySlug(slug: string): Promise<StackCalendar> {
  const found = (await stack()).calendars.find((c) => c.slug === slug);
  if (!found) throw new Error(`Calendario ${slug} assente nello stack`);
  return found;
}

/** Chiamata al server di controllo dello stack. */
export async function control(path: string, body: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`${CONTROL_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Stack ${path}: HTTP ${res.status} ${await res.text()}`);
}

/** Forza la sincronizzazione di un calendario (o di tutti) come farebbe il campanello. */
export const syncStack = (calendarId?: string): Promise<void> => control('/sync', calendarId ? { calendar_id: calendarId } : {});

/** Fa scoprire le collezioni create fuori dall'admin (da un dispositivo). */
export const discoverStack = (): Promise<void> => control('/discover');

/** Cambia il modo del backend (la baseline degli e2e è `radicale`). */
export const setBackendMode = (mode: 'radicale' | 'postgres'): Promise<void> => control('/mode', { mode });

// ─── Date ───────────────────────────────

export interface Day { year: number; month: number; day: number }

const ROME_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });

/** Giorno corrente a Roma e giorno della settimana (1 = lunedì ... 7 = domenica). */
export function romeToday(): Day & { weekday: number } {
  const parts = Object.fromEntries(ROME_FORMAT.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday };
}

export function addDays(d: Day, n: number): Day {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Lunedì della settimana corrente (la vista si apre sulla settimana di oggi). */
export function weekMonday(): Day {
  const t = romeToday();
  return addDays(t, 1 - t.weekday);
}

/** Un giorno della settimana corrente diverso da oggi e domani (per gli scenari che non vogliono sovrapposizioni). */
export function quietDay(): Day {
  const today = romeToday();
  const monday = weekMonday();
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    const offset = (Date.UTC(d.year, d.month - 1, d.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000;
    if (offset !== 0 && offset !== 1) return d;
  }
  return monday;
}

export const isoDate = (d: Day): string => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

/** Ora di una giornata nel formato CalV2DateTime con TZID. */
export function wall(d: Day, hour: number, minute = 0, tzid: string = TZ) {
  return { type: 'date-time' as const, year: d.year, month: d.month, day: d.day, hour, minute, second: 0, zone: { kind: 'tzid' as const, tzid } };
}

export const wallDate = (d: Day) => ({ type: 'date' as const, year: d.year, month: d.month, day: d.day });

/** Prossima fascia da mezz'ora libera della griglia (08:00-22:30), assegnata dallo stack in sequenza. */
export async function nextSlot(): Promise<{ hour: number; minute: number }> {
  const res = await fetch(`${CONTROL_URL}/slot`, { method: 'POST' });
  if (!res.ok) throw new Error(`Fascia oraria non assegnata: HTTP ${res.status}`);
  return (await res.json()) as { hour: number; minute: number };
}

export const uniq = (label: string): string => `${label} ${randomBytes(3).toString('hex')}`;

// ─── API admin v2 ───────────────────────────────

export interface Created { id: string; uid: string; etag: string; href: string; calendar_id: string }

export interface NewEvent {
  calendar: StackCalendar;
  title: string;
  day: Day;
  /** Default: la prossima fascia libera (`nextSlot`). */
  hour?: number;
  minute?: number;
  durationMinutes?: number;
  tzid?: string;
  allDay?: boolean;
  rrule?: string;
  location?: string;
  fields?: Record<string, unknown>;
}

/** Crea un evento con l'API admin v2. */
export async function createEvent(request: APIRequestContext, ev: NewEvent): Promise<Created> {
  const tzid = ev.tzid ?? TZ;
  const slot = ev.hour === undefined ? await nextSlot() : null;
  const hour = ev.hour ?? slot!.hour;
  const minute = ev.minute ?? slot?.minute ?? 0;
  const fields: Record<string, unknown> = ev.allDay
    ? { summary: ev.title, start: wallDate(ev.day), end: wallDate(addDays(ev.day, 1)) }
    : (() => {
        const total = hour * 60 + minute + (ev.durationMinutes ?? 30);
        return {
          summary: ev.title,
          start: wall(ev.day, hour, minute, tzid),
          end: wall(ev.day, Math.floor(total / 60), total % 60, tzid),
        };
      })();
  if (ev.rrule) fields.rrule = ev.rrule;
  if (ev.location) fields.location = ev.location;
  Object.assign(fields, ev.fields ?? {});
  const res = await request.post(`${V2}/objects`, { data: { calendar_id: ev.calendar.id, fields } });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  return { id: body.object.id, uid: body.object.uid, etag: body.etag, href: body.object.href, calendar_id: body.object.calendar_id };
}

/** Testo iCalendar senza le righe ripiegate (RFC 5545 §3.1). */
export const unfold = (text: string): string => text.replace(/\r?\n[ \t]/g, '');

/** Elimina un oggetto con l'API admin v2 (preparazione dei dati), come fa il browser: DELETE senza corpo. */
export async function deleteObject(request: APIRequestContext, created: Created): Promise<void> {
  const res = await request.delete(`${V2}/objects/${encodeURIComponent(created.id)}`, {
    params: { scope: 'all', recurrence_key: '' },
    headers: { 'if-match': created.etag },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** Vista di un oggetto (con ETag e testo ICS). */
export async function getObject(request: APIRequestContext, id: string, recurrenceKey?: string) {
  const res = await request.get(`${V2}/objects/${encodeURIComponent(id)}`, { params: recurrenceKey === undefined ? {} : { recurrence_key: recurrenceKey } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as {
    id: string; uid: string; etag: string; href: string; calendar_id: string; ics: string; recurring: boolean;
    master: { fields: Record<string, any>; all_day: boolean } | null;
  };
}

export interface ApiOccurrence {
  object_id: string; recurrence_key: string; calendar_id: string; start_utc: string; end_utc: string; all_day: boolean;
  summary: string | null; badges: string[]; kind: string;
}

/** Occorrenze v2 di una finestra (UTC ISO). */
export async function listOccurrences(request: APIRequestContext, from: string, to: string, calendarId?: string): Promise<ApiOccurrence[]> {
  const res = await request.get(`${V2}/occurrences`, { params: { from, to, ...(calendarId ? { calendar_id: calendarId } : {}) } });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { occurrences: ApiOccurrence[] }).occurrences;
}

/** Finestra [lunedì di questa settimana, lunedì successivo) in UTC, abbondante rispetto al fuso. */
export function weekWindow(): { from: string; to: string } {
  const monday = weekMonday();
  const from = addDays(monday, -1);
  const to = addDays(monday, 8);
  return { from: `${isoDate(from)}T00:00:00.000Z`, to: `${isoDate(to)}T00:00:00.000Z` };
}

/** Calendari creati dagli scenari (oltre a quelli `e2e-*` dello stack): li svuota `purgeWeek`. */
const ownCalendars = new Set<string>();

/** Crea un calendario nuovo con l'API v2 (collezione compresa). */
export async function createCalendar(request: APIRequestContext, name: string): Promise<StackCalendar> {
  const res = await request.post(`${V2}/calendars`, { data: { name } });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  ownCalendars.add(body.id);
  return { id: body.id, slug: body.slug, name: body.name, collection_name: body.collection_name ?? body.slug };
}

/**
 * Toglie gli eventi della settimana corrente dai calendari degli scenari
 * (`e2e-*` e quelli creati con `createCalendar`), così la griglia resta sgombra e
 * il clic sul chip di un evento non è intercettato da quelli dei test precedenti.
 * Best effort: serve a tenere pulito lo stack, non è parte di uno scenario.
 */
export async function purgeWeek(request: APIRequestContext): Promise<void> {
  try {
    const list = await request.get(`${V2}/calendars`);
    if (!list.ok()) return;
    const calendars = ((await list.json()) as { calendars: Array<{ id: string; slug: string }> }).calendars
      .filter((c) => c.slug.startsWith('e2e-') || ownCalendars.has(c.id));
    const { from, to } = weekWindow();
    const objects = new Set<string>();
    for (const c of calendars) {
      for (const o of await listOccurrences(request, from, to, c.id)) objects.add(o.object_id);
    }
    for (const id of objects) {
      const view = await request.get(`${V2}/objects/${encodeURIComponent(id)}`);
      if (!view.ok()) continue;
      const { etag } = (await view.json()) as { etag: string | null };
      if (!etag) continue;
      await request.delete(`${V2}/objects/${encodeURIComponent(id)}`, {
        params: { scope: 'all', recurrence_key: '' },
        headers: { 'if-match': etag },
      });
    }
  } catch {
    // Stack non raggiungibile o in un modo che non ammette la v2 (mode postgres): niente da pulire.
  }
}

// ─── Dispositivi: scritture dirette su Radicale ───────────────────────────────

/** Richiesta CalDAV autenticata come caldes-svc (equivale a un dispositivo con le stesse mani sulla collezione). */
export async function dav(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const { radicale } = await stack();
  const auth = Buffer.from(`${radicale.user}:${radicale.password}`).toString('base64');
  return fetch(`${radicale.url}/${radicale.principal}/${path}`, {
    method,
    headers: { authorization: `Basic ${auth}`, ...init.headers },
    body: init.body,
    redirect: 'manual',
  });
}

/** Testo ICS minimo di un evento "da dispositivo" di mezz'ora. */
export function deviceIcs(uid: string, title: string, day: Day, hour: number, minute = 0, extra: string[] = []): string {
  const stamp = (total: number) => `${isoDate(day).replace(/-/g, '')}T${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}00`;
  const start = hour * 60 + minute;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//E2E Device//IT',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z',
    `DTSTART;TZID=${TZ}:${stamp(start)}`, `DTEND;TZID=${TZ}:${stamp(start + 30)}`,
    `SUMMARY:${title}`, ...extra,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/** Scrive una risorsa come farebbe un dispositivo e la fa indicizzare. */
export async function deviceCreate(calendar: StackCalendar, uid: string, ics: string): Promise<void> {
  const res = await dav('PUT', `${calendar.collection_name}/${uid}.ics`, { body: ics, headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' } });
  expect(res.status, await res.text()).toBeLessThan(300);
  await syncStack(calendar.id);
}

/** Modifica da dispositivo con If-Match (il testo è quello letto), poi indicizza. */
export async function deviceEdit(calendar: StackCalendar, href: string, edit: (text: string) => string): Promise<void> {
  const cur = await dav('GET', `${calendar.collection_name}/${href}`);
  expect(cur.status).toBe(200);
  const etag = cur.headers.get('etag') as string;
  const res = await dav('PUT', `${calendar.collection_name}/${href}`, { body: edit(await cur.text()), headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-match': etag } });
  expect(res.status, await res.text()).toBeLessThan(300);
}

/** Cancella la risorsa come un dispositivo. */
export async function deviceDelete(calendar: StackCalendar, href: string): Promise<void> {
  const res = await dav('DELETE', `${calendar.collection_name}/${href}`, { headers: { 'if-match': '*' } });
  expect(res.status, await res.text()).toBeLessThan(300);
}

// ─── Pagina ───────────────────────────────

/** Apre il calendario e attende la griglia. */
export async function gotoCalendar(page: Page): Promise<void> {
  await page.goto('/calendario');
  await expect(page.locator('.fc-view')).toBeVisible();
}

/** Chip di un evento nella griglia, per titolo. */
export const eventChip = (page: Page, title: string): Locator => page.locator('.fc-event', { hasText: title });

/** Seleziona un evento nella griglia (apre il pannello laterale). */
export async function selectEvent(page: Page, title: string, nth = 0): Promise<void> {
  const chip = eventChip(page, title).nth(nth);
  await expect(chip).toBeVisible();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

/** Apre l'editor v2 di un evento dal pannello laterale e attende che sia caricato. */
export async function openEditor(page: Page, title: string, nth = 0): Promise<Locator> {
  await selectEvent(page, title, nth);
  await page.getByRole('button', { name: 'Modifica', exact: true }).click();
  const editor = page.getByTestId('cal-editor-v2');
  await expect(editor).toBeVisible();
  await expect(editor.locator('#ev-summary')).toBeVisible();
  return editor;
}

/** Apre il calendario e l'editor di un evento. */
export async function openEvent(page: Page, title: string, nth = 0): Promise<Locator> {
  await gotoCalendar(page);
  return openEditor(page, title, nth);
}

/** Conferma la finestra di conferma dell'admin (AlertDialog). */
export async function confirmDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button').last().click();
  await expect(dialog).toBeHidden();
}

/** Messaggio a comparsa (sonner) con un testo. */
export const toastWith = (page: Page, text: string | RegExp): Locator => page.locator('[data-sonner-toast]', { hasText: text });
