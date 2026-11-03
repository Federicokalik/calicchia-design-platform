/**
 * Editor ICS raw dell'API admin v2 (F6 tranche C, passo C1; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.2).
 *
 * `PUT /objects/:id/ics`: il testo si valida per intero (parse di
 * calendar-core, un solo UID uguale a quello dell'oggetto, solo VEVENT, al più
 * 1 MB, limiti strutturali, `validateObject` con `previous`) e si scrive così
 * com'è dopo la sola normalizzazione dei fine riga in CRLF: nessun
 * aggiornamento automatico di DTSTAMP, LAST-MODIFIED o SEQUENCE (lo fa
 * l'utente; un avviso `sequence_not_bumped` segnala tempi o ricorrenza
 * cambiati senza SEQUENCE+1). Nessuna fusione per campi: un ETag diverso è
 * sempre un 412 con `current` e `conflicts: []`. Un oggetto illeggibile si
 * può riparare da qui, se il testo nuovo è valido.
 *
 * La scrittura passa dalla pipeline dello store (gate cal-write, GET, PUT con
 * `If-Match`, write-through, audit `v2.raw` senza testo): `plan.text` fa
 * scrivere il testo verbatim al posto della serializzazione dell'oggetto.
 */

import {
  type CalendarObject,
  type IcsComponent,
  IcsParseError,
  getProperties,
  getTextValue,
  parseCalendarObject,
  validateObject,
} from '@calicchia/calendar-core';
import type { CalV2Issue, CalV2RawPutRequest, CalV2WriteResult } from '@calicchia/shared';
import { z } from 'zod';
import { sql } from '../../../db';
import { objectPath } from '../radicale/client';
import { allowedComponents, collectionNameOf, type CurrentObject, fetchCurrent, requireRadicale, safeTz, type SidecarRow, writeObject, writeThrough } from '../radicale/store';
import { assertV2ObjectsAvailable } from './capabilities';
import { CalendarV2PreconditionError, toV2Issue, validationFailed } from './errors';
import {
  ACTOR,
  type AdminActor,
  assertEditableObject,
  assertWritableCalendar,
  auditV2,
  currentForPrecondition,
  MAX_ATTEMPTS,
  normalizeEtag,
  notFound,
  PreconditionMarker,
  requireIfMatch,
  resolveObjectRef,
  type Resolved,
  result,
  type Snapshot,
  viewOf,
  zodIssues,
} from './objects';

/** Dimensione massima del testo (design §8: un oggetto è al più 1 MB). */
const MAX_RAW_BYTES = 1024 * 1024;
const TIMING_PROPERTIES = ['DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RDATE', 'EXDATE'] as const;

const rawPutSchema = z
  .object({
    ics: z.string().min(1, 'testo mancante'),
    dryRun: z.boolean().optional(),
  })
  .strict();

/** Corpo di `PUT /objects/:id/ics` validato (400 VALIDATION_FAILED con `details.issues`). */
export function parseRawPutRequest(raw: unknown): CalV2RawPutRequest {
  const parsed = rawPutSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta non valida', zodIssues(parsed.error));
  if (Buffer.byteLength(parsed.data.ics, 'utf8') > MAX_RAW_BYTES) {
    throw validationFailed('Il testo supera il limite di 1 MB', [{ code: 'TOO_LARGE', severity: 'error', message: 'Il testo supera il limite di 1 MB', property: 'ics' }]);
  }
  return parsed.data;
}

/** Fine riga in CRLF (anche l'ultima): l'unica modifica che l'editor raw fa al testo. */
export function normalizeIcsLineEndings(text: string): string {
  const crlf = text.replace(/\r\n|\r|\n/g, '\r\n');
  return crlf.endsWith('\r\n') ? crlf : `${crlf}\r\n`;
}

// ─── Avviso sulla SEQUENCE ───────────────────────────────

function sequenceOf(c: IcsComponent | null): number {
  const n = Number.parseInt(getTextValue(c ?? { name: '', properties: [], components: [] }, 'SEQUENCE') ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

function timingSignature(c: IcsComponent): string {
  return JSON.stringify(TIMING_PROPERTIES.map((name) => getProperties(c, name).map((p) => [p.name, p.params, p.value])));
}

function recurrenceIdOf(c: IcsComponent): string {
  return getProperties(c, 'RECURRENCE-ID')[0]?.value ?? '';
}

/** Componenti (master e override) per chiave grezza del RECURRENCE-ID. */
function componentsByKey(obj: CalendarObject): Map<string, IcsComponent> {
  const map = new Map<string, IcsComponent>();
  if (obj.master) map.set('', obj.master);
  for (const o of obj.overrides) map.set(recurrenceIdOf(o), o);
  return map;
}

/**
 * Avvisi `sequence_not_bumped`: un componente ha tempi o ricorrenza diversi da
 * prima ma la SEQUENCE non è salita. Solo informativi: il testo si scrive lo stesso.
 */
export function sequenceWarnings(previous: CalendarObject | null, next: CalendarObject): CalV2Issue[] {
  if (!previous) return [];
  const before = componentsByKey(previous);
  const issues: CalV2Issue[] = [];
  for (const [key, comp] of componentsByKey(next)) {
    const prev = before.get(key);
    if (!prev || timingSignature(prev) === timingSignature(comp)) continue;
    if (sequenceOf(comp) > sequenceOf(prev)) continue;
    issues.push({
      code: 'sequence_not_bumped',
      severity: 'warning',
      message: 'Hai cambiato orario o ricorrenza senza aumentare SEQUENCE: i calendari collegati potrebbero non riconoscere la modifica',
      property: 'SEQUENCE',
      ...(key ? { recurrence_key: key } : {}),
    });
  }
  return issues;
}

// ─── Analisi del testo ───────────────────────────────

type Analysis = { ok: true; object: CalendarObject } | { ok: false; issues: CalV2Issue[] };

/** Parse e controlli che non dipendono da Radicale: un solo UID, uguale a quello dell'oggetto, solo VEVENT. */
function analyzeText(text: string, expectedUid: string | null): Analysis {
  const parsed = parseCalendarObject(text);
  if (!parsed.ok) {
    const err: IcsParseError = parsed.error;
    const uid = err.code === 'MULTIPLE_UIDS' || err.code === 'MISSING_UID';
    return { ok: false, issues: [{ code: err.code ?? 'ICS_PARSE', severity: 'error', message: err.message, ...(uid ? { property: 'UID' } : {}) }] };
  }
  const object = parsed.value;
  // VTODO e VJOURNAL: sola lettura in questa fase, non un errore di validazione.
  assertEditableObject({ raw: text, etag: null, object, parseError: null });
  if (expectedUid !== null && object.uid !== expectedUid) {
    return { ok: false, issues: [{ code: 'UID_MISMATCH', severity: 'error', message: 'L\'UID del testo deve restare quello dell\'evento: per un evento diverso usa "Duplica"', property: 'UID' }] };
  }
  return { ok: true, object };
}

function firstError(issues: readonly CalV2Issue[]): string {
  return issues.find((i) => i.severity === 'error')?.message ?? 'Testo iCalendar non valido';
}

/** UID dell'oggetto all'ultima indicizzazione (per il controllo prima di contattare Radicale). */
async function indexedUid(resolved: Resolved): Promise<string | null> {
  const [row] = await sql<Array<{ uid: string | null }>>`SELECT uid FROM cal_object_ids WHERE id = ${resolved.objectId || resolved.id}::uuid`;
  return row?.uid ?? null;
}

interface RawDecision {
  noop: boolean;
  object: CalendarObject;
  previous: CalendarObject | null;
  issues: CalV2Issue[];
  valid: boolean;
}

/** Decisione sul testo corrente: ETag esatto, UID, validazione completa. */
function decide(current: CurrentObject, text: string, parsed: CalendarObject, ifm: string, cal: SidecarRow, lenient: boolean): RawDecision {
  if (normalizeEtag(current.etag) !== ifm) throw new PreconditionMarker([]);
  // Un oggetto illeggibile si ripara da qui; un VTODO/VJOURNAL corrente resta in sola lettura.
  if (current.object) assertEditableObject(current);
  if (current.object && current.object.uid !== parsed.uid) {
    throw validationFailed('L\'UID del testo deve restare quello dell\'evento', [{ code: 'UID_MISMATCH', severity: 'error', message: 'L\'UID del testo deve restare quello dell\'evento: per un evento diverso usa "Duplica"', property: 'UID' }]);
  }
  if (current.raw === text) return { noop: true, object: parsed, previous: current.object, issues: [], valid: true };
  const check = validateObject(parsed, {
    tz: safeTz(cal.timezone),
    allowedComponents: allowedComponents(cal),
    serializedBytes: Buffer.byteLength(text, 'utf8'),
    previous: current.object,
    now: new Date(),
  });
  const issues = [...check.issues.map((i) => toV2Issue(i)), ...sequenceWarnings(current.object, parsed)];
  if (!check.ok && !lenient) throw validationFailed(firstError(issues), issues);
  return { noop: false, object: parsed, previous: current.object, issues, valid: check.ok };
}

// ─── PUT ───────────────────────────────

/** `PUT /objects/:id/ics`: scrive il testo completo dell'oggetto (§9.1.2). */
export async function putRawIcsV2(ref: string, ifMatch: string, req: CalV2RawPutRequest, actor: AdminActor): Promise<CalV2WriteResult> {
  await assertV2ObjectsAvailable();
  const ifm = requireIfMatch(ifMatch);
  const resolved = await resolveObjectRef(ref);
  const cal = resolved.calendar;
  assertWritableCalendar(cal);
  const text = normalizeIcsLineEndings(req.ics);
  const analysis = analyzeText(text, await indexedUid(resolved));

  if (req.dryRun) return dryRun(resolved, text, analysis, ifm);
  if (!analysis.ok) throw validationFailed(firstError(analysis.issues), analysis.issues);
  const parsed = analysis.object;

  let missing = false;
  let decision: RawDecision | null = null;
  let outcome;
  try {
    outcome = await writeObject({
      calendar: cal,
      href: resolved.href,
      what: 'l\'evento',
      maxAttempts: MAX_ATTEMPTS,
      plan: (current) => {
        missing = false;
        decision = null;
        if (!current) {
          missing = true;
          return { action: 'none' };
        }
        const d = decide(current, text, parsed, ifm, cal, false);
        decision = d;
        if (d.noop) return { action: 'none' };
        return { action: 'put', object: d.object, previous: d.previous, changed: ['raw'], text };
      },
    });
  } catch (err) {
    if (err instanceof PreconditionMarker) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, ''), []);
    throw err;
  }
  if (missing) throw notFound();
  const d = decision as RawDecision | null;
  if (!d) throw new Error('PUT raw senza decisione');
  const put = outcome.action === 'put';
  if (put) {
    await writeThrough([cal.id], ACTOR);
    await auditV2({
      operation: 'v2.raw',
      action: 'UPDATE',
      recordId: resolved.objectId || resolved.id,
      calendar: cal,
      href: resolved.href,
      etagBefore: outcome.etagBefore,
      etagAfter: outcome.etagAfter,
      changed: ['raw'],
      actor,
    });
  }
  const etag = put ? outcome.etagAfter : outcome.etagBefore;
  const snap: Snapshot = { resolved, raw: outcome.raw ?? text, etag, object: outcome.object ?? parsed, parseError: null, source: 'radicale' };
  return result({ object: await viewOf(snap, ''), etag, changed: put ? ['raw'] : [], noop: !put, issues: d.issues, valid: true });
}

/** dryRun: stessi controlli, nessun gate, PUT né audit; la validazione fallita dà `valid: false` (non 400). */
async function dryRun(resolved: Resolved, text: string, analysis: Analysis, ifm: string): Promise<CalV2WriteResult> {
  const cal = resolved.calendar;
  const { client, principal } = requireRadicale();
  const current = await fetchCurrent(client, objectPath(principal, collectionNameOf(cal), resolved.href), 'l\'evento');
  if (!current) throw notFound();
  const asIs: Snapshot = { resolved, raw: current.raw, etag: current.etag, object: current.object, parseError: current.parseError, source: 'radicale' };
  try {
    if (!analysis.ok) {
      if (normalizeEtag(current.etag) !== ifm) throw new PreconditionMarker([]);
      return result({ object: await viewOf(asIs, ''), etag: current.etag, dry_run: true, valid: false, issues: analysis.issues });
    }
    const d = decide(current, text, analysis.object, ifm, cal, true);
    if (d.noop) return result({ object: await viewOf(asIs, ''), etag: current.etag, noop: true, dry_run: true });
    const proposed: Snapshot = { resolved, raw: text, etag: current.etag, object: d.object, parseError: null, source: 'radicale' };
    return result({ object: await viewOf(proposed, ''), etag: current.etag, changed: ['raw'], dry_run: true, valid: d.valid, issues: d.issues });
  } catch (err) {
    if (err instanceof PreconditionMarker) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, ''), []);
    throw err;
  }
}
