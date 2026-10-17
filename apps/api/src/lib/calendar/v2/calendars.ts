/**
 * Calendari dell'API admin v2 (F6 tranche C, passo C2; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.4).
 *
 *  - `GET /calendars`: tutti i calendari attivi con salute di sync, conteggio
 *    degli oggetti, URL dei device e del feed (`CalV2CalendarList`);
 *  - `POST /calendars`: MKCALENDAR esplicita dello store (nessuna MKCOL
 *    implicita), ruolo solo fra `CAL_V2_ASSIGNABLE_ROLES`;
 *  - `PATCH /calendars/:id`: PROPPATCH più sidecar; iscrizioni e archivio
 *    cambiano solo nome e colore (403 per il resto);
 *  - `PUT /calendars/order`: `sort_order` = posizione, più PROPPATCH di
 *    `calendar-order` (best effort);
 *  - `DELETE /calendars/:id?with_objects=1`: un calendario con oggetti si
 *    elimina solo con la conferma esplicita (409 CALENDAR_NOT_EMPTY);
 *  - `POST /calendars/:id/rotate-token`: nuovo token del feed.
 *
 * Tutte le scritture passano dalle funzioni dello store (gate cal-write,
 * identità del volume verificata) e lasciano una riga in `audit_logs`
 * (`table_name 'calendars'`) con soli campi e conteggi.
 */

import type {
  CalV2CalendarCreateRequest,
  CalV2CalendarList,
  CalV2CalendarOrderRequest,
  CalV2CalendarPatchRequest,
  CalV2CalendarRole,
  CalV2CalendarView,
  CalV2CollectionHealth,
} from '@calicchia/shared';
import { CAL_V2_ASSIGNABLE_ROLES, CAL_V2_CALENDAR_ROLES } from '@calicchia/shared';
import { z } from 'zod';
import { sql } from '../../../db';
import { buildFeedUrl } from '../calendars';
import { CalendarConflictError, CalendarSystemError, CalendarValidationError } from '../errors';
import { collectionPath } from '../radicale/client';
import {
  applyCalendarOrder,
  auditCalendarTokenRotation,
  type CalendarPatchV2,
  createCalendarV2,
  deleteCalendarV2,
  getRadicaleStore,
  updateCalendarV2,
} from '../radicale/store';
import { radicaleRuntime } from '../radicale/sync';
import { isValidCollectionName } from '../radicale/types';
import { isValidTimeZone } from '../validation';
import { assertV2ObjectsAvailable } from './capabilities';
import { calendarNotEmpty, CalendarV2Error, invalidValue, readOnly, v2ErrorFrom, validationFailed } from './errors';
import { type AdminActor, notFound, UUID_RE, zodIssues } from './objects';

/** Base pubblica CalDAV per l'URL dei device (la stessa che il preflight della migrazione verifica). */
const DEFAULT_DEVICE_BASE_URL = 'https://dav.calicchia.design';

// ═══════════════════════════════════════════════════════════════════
// Richieste
// ═══════════════════════════════════════════════════════════════════

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const nameSchema = z.string().trim().min(1, 'Il nome è obbligatorio').max(200, 'Il nome è troppo lungo (massimo 200 caratteri)');
const descriptionSchema = z.string().max(1000, 'La descrizione è troppo lunga (massimo 1000 caratteri)').nullable();
const colorSchema = z.string().regex(COLOR_RE, 'Il colore deve essere nel formato #RRGGBB');
const timezoneSchema = z.string().refine((tz) => isValidTimeZone(tz), 'Fuso orario non valido (es. Europe/Rome)');
const roleSchema = z.enum(CAL_V2_CALENDAR_ROLES);

const createSchema = z
  .object({
    name: nameSchema,
    slug: z.string().regex(SLUG_RE, 'Lo slug usa solo a-z, 0-9 e - (massimo 63 caratteri)').optional(),
    description: descriptionSchema.optional(),
    color: colorSchema.optional(),
    timezone: timezoneSchema.optional(),
    role: roleSchema.optional(),
    blocks_availability: z.boolean().optional(),
    device_visible: z.boolean().optional(),
    ics_feed_enabled: z.boolean().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    color: colorSchema.optional(),
    timezone: timezoneSchema.optional(),
    role: roleSchema.optional(),
    blocks_availability: z.boolean().optional(),
    device_visible: z.boolean().optional(),
    ics_feed_enabled: z.boolean().optional(),
    needs_review: z.literal(false).optional(),
  })
  .strict();

const orderSchema = z.object({ ids: z.array(z.string().regex(UUID_RE, 'Identificativo di calendario non valido')).min(1).max(500) }).strict();

/** Il ruolo arriva come stringa dell'enum completo: i ruoli di sistema sono un 403 (non un 400) nel passo successivo. */
type CreateParsed = Omit<CalV2CalendarCreateRequest, 'role'> & { role?: CalV2CalendarRole };
type PatchParsed = Omit<CalV2CalendarPatchRequest, 'role'> & { role?: CalV2CalendarRole };

/** Corpo di `POST /calendars` validato. */
export function parseCalendarCreateRequest(raw: unknown): CreateParsed {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta di creazione del calendario non valida', zodIssues(parsed.error));
  return parsed.data;
}

/** Corpo di `PATCH /calendars/:id` validato (almeno un campo). */
export function parseCalendarPatchRequest(raw: unknown): PatchParsed {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta di modifica del calendario non valida', zodIssues(parsed.error));
  if (Object.keys(parsed.data).length === 0) throw invalidValue('Indica almeno un campo da modificare');
  return parsed.data;
}

/** Corpo di `PUT /calendars/order` validato. */
export function parseCalendarOrderRequest(raw: unknown): CalV2CalendarOrderRequest {
  const parsed = orderSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Elenco dei calendari non valido', zodIssues(parsed.error));
  return { ids: parsed.data.ids.map((id) => id.toLowerCase()) };
}

// ═══════════════════════════════════════════════════════════════════
// Vista
// ═══════════════════════════════════════════════════════════════════

interface CalendarRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  timezone: string;
  sort_order: number;
  is_default: boolean;
  is_system: boolean;
  role: CalV2CalendarRole;
  origin: CalV2CalendarView['origin'];
  lifecycle: CalV2CalendarView['lifecycle'];
  components: string[];
  blocks_availability: boolean;
  collection_name: string | null;
  device_visible: boolean;
  ics_feed_enabled: boolean;
  ics_feed_token: string;
  needs_review: boolean;
  review_reason: string | null;
  object_count: number;
  sync_health: CalV2CollectionHealth | null;
  last_synced_at: Date | null;
  dirty_since: Date | null;
  pending_deletions: number | null;
  quarantined_count: number | null;
}

const ROW_COLUMNS = sql`
  c.id, c.slug, c.name, c.description, c.color, c.icon, c.timezone, c.sort_order,
  c.is_default, c.is_system, c.role, c.origin, c.lifecycle, c.components, c.blocks_availability,
  c.collection_name, c.device_visible, c.ics_feed_enabled, c.ics_feed_token, c.needs_review, c.review_reason,
  COALESCE(oc.n, 0)::int AS object_count,
  s.health AS sync_health, s.last_synced_at, s.dirty_since,
  cardinality(s.pending_deletions)::int AS pending_deletions, s.quarantined_count
`;

const ROW_JOINS = sql`
  FROM calendars c
  LEFT JOIN (SELECT calendar_id, count(*) AS n FROM cal_objects GROUP BY calendar_id) oc ON oc.calendar_id = c.id
  LEFT JOIN cal_collection_state s ON s.calendar_id = c.id
`;

function readonlyReasonOf(row: Pick<CalendarRow, 'role' | 'origin'>): CalV2CalendarView['readonly_reason'] {
  if (row.role === 'subscription') return 'subscription';
  if (row.origin === 'migration') return 'archive';
  return null;
}

/** Eliminabile dall'admin: non di sistema, non predefinito, non `bookings`/`holidays`, né iscrizione o archivio. */
function isDeletable(row: CalendarRow): boolean {
  return !row.is_system && !row.is_default && row.role !== 'bookings' && row.role !== 'holidays' && readonlyReasonOf(row) === null && row.lifecycle === 'active';
}

function deviceUrlOf(row: CalendarRow): string | null {
  if (!row.device_visible || row.lifecycle !== 'active' || !isValidCollectionName(row.collection_name)) return null;
  const base = (process.env.RADICALE_PUBLIC_URL?.trim() || DEFAULT_DEVICE_BASE_URL).replace(/\/+$/, '');
  return `${base}${collectionPath(radicaleRuntime().principal, row.collection_name)}`;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function toView(row: CalendarRow): CalV2CalendarView {
  const readonly = readonlyReasonOf(row);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: row.icon,
    timezone: row.timezone,
    sort_order: row.sort_order,
    is_default: row.is_default,
    is_system: row.is_system,
    role: row.role,
    origin: row.origin,
    lifecycle: row.lifecycle,
    components: row.components as CalV2CalendarView['components'],
    blocks_availability: row.blocks_availability,
    collection_name: row.collection_name,
    device_url: deviceUrlOf(row),
    device_visible: row.device_visible,
    ics_feed_enabled: row.ics_feed_enabled,
    // Il feed di un'iscrizione non esiste: i suoi eventi sono quelli del calendario remoto.
    feed_url: row.ics_feed_enabled && row.role !== 'subscription' ? buildFeedUrl({ ics_feed_token: row.ics_feed_token } as Parameters<typeof buildFeedUrl>[0]) : null,
    readonly_reason: readonly,
    needs_review: row.needs_review,
    review_reason: row.review_reason,
    object_count: row.object_count,
    sync: row.sync_health
      ? {
          health: row.sync_health,
          last_synced_at: iso(row.last_synced_at),
          dirty_since: iso(row.dirty_since),
          pending_deletions: row.pending_deletions ?? 0,
          quarantined_count: row.quarantined_count ?? 0,
        }
      : null,
    deletable: isDeletable(row),
  };
}

async function loadRows(where?: { id: string }): Promise<CalendarRow[]> {
  return sql<CalendarRow[]>`
    SELECT ${ROW_COLUMNS} ${ROW_JOINS}
    WHERE c.lifecycle = 'active' ${where ? sql`AND c.id = ${where.id}::uuid` : sql``}
    ORDER BY c.sort_order ASC, c.name ASC, c.id ASC
  `;
}

/** Riga di un calendario attivo; id non valido o inesistente → 404 NOT_FOUND. */
export async function requireCalendarRow(id: string): Promise<CalendarRow> {
  if (!UUID_RE.test(id)) throw notFound('Calendario non trovato');
  const [row] = await loadRows({ id: id.toLowerCase() });
  if (!row) throw notFound('Calendario non trovato');
  return row;
}

/** `GET /calendars`. */
export async function listCalendarsV2(): Promise<CalV2CalendarList> {
  await assertV2ObjectsAvailable();
  return { calendars: (await loadRows()).map(toView) };
}

async function viewOf(id: string): Promise<CalV2CalendarView> {
  return toView(await requireCalendarRow(id));
}

// ═══════════════════════════════════════════════════════════════════
// Errori del dominio
// ═══════════════════════════════════════════════════════════════════

/** Errori dello store sui calendari → errori v2 (400 per nome o slug già usati, 403 per i calendari di sistema). */
function calendarError(err: unknown): unknown {
  if (err instanceof CalendarValidationError) return invalidValue(err.message);
  if (err instanceof CalendarSystemError) return readOnly(err.message, 'system');
  if (err instanceof CalendarConflictError) return invalidValue(err.message, /nome/i.test(err.message) ? 'name' : 'slug');
  return v2ErrorFrom(err) ?? err;
}

function actorLabel(actor: AdminActor): string {
  return actor.userId ? `admin:${actor.userId}` : 'admin';
}

const READONLY_PATCH_MESSAGES: Record<NonNullable<CalV2CalendarView['readonly_reason']>, string> = {
  subscription: 'Le iscrizioni si gestiscono dalla sezione Iscrizioni: da qui puoi cambiare solo nome, colore e ordine',
  archive: 'Archivio della Fase 0: da qui puoi cambiare solo nome, colore e ordine',
};

/** Ruolo assegnabile dall'admin (`CAL_V2_ASSIGNABLE_ROLES`). */
function isAssignable(role: string): boolean {
  return (CAL_V2_ASSIGNABLE_ROLES as readonly string[]).includes(role);
}

function assertAssignableRole(role: CalV2CalendarRole | undefined): void {
  if (role !== undefined && !isAssignable(role)) {
    throw readOnly('Questo ruolo lo gestisce il sistema: si può scegliere solo fra "personale" e "scadenze"', 'role_not_assignable', { role });
  }
}

// ═══════════════════════════════════════════════════════════════════
// Creazione, modifica, ordine, eliminazione, token
// ═══════════════════════════════════════════════════════════════════

/** Slug derivato dal nome: minuscolo, senza accenti, solo a-z, 0-9 e `-`. */
export function slugFromName(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/g, '');
  return base || 'calendario';
}

/** Primo slug libero fra `base`, `base-2`, `base-3`... (slug e nome di collezione condividono lo spazio dei nomi). */
async function freeSlug(base: string): Promise<string> {
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [taken] = await sql<Array<{ id: string }>>`SELECT id FROM calendars WHERE slug = ${candidate} OR collection_name = ${candidate} LIMIT 1`;
    if (!taken) return candidate;
  }
  throw invalidValue('Non riesco a ricavare uno slug libero dal nome: indicane uno', 'slug');
}

/** `POST /calendars`: 201 con la vista del calendario creato. */
export async function createCalendarRouteV2(req: CreateParsed, actor: AdminActor): Promise<CalV2CalendarView> {
  await assertV2ObjectsAvailable();
  assertAssignableRole(req.role);
  const slug = req.slug ?? (await freeSlug(slugFromName(req.name)));
  // In coda agli altri: il nuovo calendario non scavalca l'ordine scelto dall'admin.
  const [{ next }] = await sql<Array<{ next: number }>>`SELECT (COALESCE(MAX(sort_order), -1) + 1)::int AS next FROM calendars WHERE lifecycle = 'active'`;
  try {
    const created = await createCalendarV2(
      {
        slug,
        name: req.name,
        description: req.description ?? null,
        color: req.color,
        timezone: req.timezone,
        sort_order: next,
        blocks_availability: req.blocks_availability,
        role: req.role as 'user' | 'deadlines' | undefined,
        device_visible: req.device_visible,
        ics_feed_enabled: req.ics_feed_enabled,
      },
      actorLabel(actor),
    );
    return await viewOf(created.id);
  } catch (err) {
    throw calendarError(err);
  }
}

/** `PATCH /calendars/:id`: 200 con la vista aggiornata. */
export async function patchCalendarRouteV2(id: string, req: PatchParsed, actor: AdminActor): Promise<CalV2CalendarView> {
  await assertV2ObjectsAvailable();
  const cal = await requireCalendarRow(id);
  const readonly = readonlyReasonOf(cal);
  if (readonly) {
    const forbidden = Object.keys(req).filter((f) => f !== 'name' && f !== 'color');
    if (forbidden.length > 0) throw readOnly(READONLY_PATCH_MESSAGES[readonly], readonly, { fields: forbidden });
  }
  if (req.role !== undefined) {
    assertAssignableRole(req.role);
    if (!isAssignable(cal.role)) {
      throw readOnly('Il ruolo di questo calendario lo gestisce il sistema e non si cambia', 'role_locked', { role: cal.role });
    }
  }
  try {
    await updateCalendarV2(cal.id, req as CalendarPatchV2, actorLabel(actor));
  } catch (err) {
    throw calendarError(err);
  }
  return viewOf(cal.id);
}

/** `PUT /calendars/order`: `ids` contiene ogni calendario attivo esattamente una volta. */
export async function orderCalendarsRouteV2(req: CalV2CalendarOrderRequest, actor: AdminActor): Promise<CalV2CalendarList> {
  await assertV2ObjectsAvailable();
  const all = (await sql<Array<{ id: string }>>`SELECT id FROM calendars WHERE lifecycle = 'active'`).map((r) => r.id);
  const wanted = new Set(req.ids);
  if (wanted.size !== req.ids.length) throw invalidValue('L\'elenco contiene lo stesso calendario più volte', 'ids');
  const known = new Set(all);
  const unknown = req.ids.filter((id) => !known.has(id));
  const missing = all.filter((id) => !wanted.has(id));
  if (unknown.length > 0 || missing.length > 0) {
    throw new CalendarV2Error('VALIDATION_FAILED', 400, 'L\'elenco deve contenere ogni calendario esattamente una volta', {
      issues: [{ code: 'INVALID_VALUE', severity: 'error', message: 'L\'elenco deve contenere ogni calendario esattamente una volta', property: 'ids' }],
      missing: missing.length,
      unknown: unknown.length,
    });
  }
  await applyCalendarOrder(req.ids, actorLabel(actor));
  return { calendars: (await loadRows()).map(toView) };
}

/** `DELETE /calendars/:id?with_objects=1`: `{ deleted: true }`. */
export async function deleteCalendarRouteV2(id: string, withObjects: boolean, actor: AdminActor): Promise<{ deleted: true }> {
  await assertV2ObjectsAvailable();
  const cal = await requireCalendarRow(id);
  const readonly = readonlyReasonOf(cal);
  if (readonly) {
    throw readOnly(
      readonly === 'subscription' ? 'Le iscrizioni si eliminano dalla sezione Iscrizioni' : 'L\'archivio della Fase 0 non si elimina da qui',
      readonly,
    );
  }
  if (!isDeletable(cal)) {
    throw readOnly('Questo calendario è di sistema (predefinito, prenotazioni o festività) e non si può eliminare', 'system');
  }
  if (cal.object_count > 0 && !withObjects) throw calendarNotEmpty(cal.object_count);
  try {
    await deleteCalendarV2(cal.id, actorLabel(actor), { object_count: cal.object_count, with_objects: withObjects });
  } catch (err) {
    throw calendarError(err);
  }
  return { deleted: true };
}

/** `POST /calendars/:id/rotate-token`: 200 con la vista (nuovo `feed_url`). */
export async function rotateCalendarTokenV2(id: string, actor: AdminActor): Promise<CalV2CalendarView> {
  await assertV2ObjectsAvailable();
  const cal = await requireCalendarRow(id);
  const readonly = readonlyReasonOf(cal);
  if (readonly) throw readOnly(READONLY_PATCH_MESSAGES[readonly], readonly, { fields: ['ics_feed_token'] });
  const rotated = await getRadicaleStore().rotateFeedToken(cal.id);
  if (!rotated) throw notFound('Calendario non trovato');
  await auditCalendarTokenRotation(cal.id, actorLabel(actor));
  return viewOf(cal.id);
}
