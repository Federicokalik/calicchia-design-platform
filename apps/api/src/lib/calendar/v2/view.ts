/**
 * Viste dell'API admin del calendario v2 (F6, contratto
 * docs/calendar-radicale/contracts/f6-modules.md §3.3, §3.4, §4, §5.3).
 *
 * Modulo PURO: nessun I/O, nessun database, nessun import dello store. Dal
 * testo di una risorsa (già interpretato da calendar-core) costruisce i DTO
 * condivisi con l'admin (`@calicchia/shared`): valori tipizzati per campo
 * (`fields`, identici a PatchFieldValues), token di base per il confronto
 * delle modifiche concorrenti (`tokens`), VALARM decodificati per la sola
 * visualizzazione, proprietà non tipizzate (`extra_properties`), campi in
 * sola lettura e anteprima della ricorrenza.
 *
 * I token sono opachi: sha256 (16 caratteri esadecimali) di una forma
 * canonica del valore. Due valori equivalenti (categorie in ordine diverso,
 * VALARM con parametri riordinati...) hanno lo stesso token; una proprietà
 * non tipizzata assente vale CAL_V2_ABSENT_TOKEN.
 */

import { createHash } from 'node:crypto';
import {
  type CalendarObject,
  canonicalComponentText,
  canonicalPropertyText,
  canonicalRruleText,
  cloneProperty,
  componentRecurrenceKey,
  describeRrule,
  expandObject,
  getParamValue,
  getProperties,
  getProperty,
  getTextValue,
  type IcsAddress,
  type IcsComponent,
  type IcsProperty,
  type IcsTime,
  IcsValueError,
  isCalendarCoreError,
  MASTER_RECURRENCE_KEY,
  materializeOverride,
  parseDurationValue,
  readEvent,
  readFieldValues,
  readTimeProperty,
  recurrenceKeyToTime,
  timeToUtcMs,
  vtimezoneTzid,
  type ZoneContext,
  addDurationToTime,
  addDays,
  stringToIcsDate,
  icsDateToString,
} from '@calicchia/calendar-core';
import {
  CAL_V2_ABSENT_TOKEN,
  CAL_V2_FIELDS,
  CAL_V2_RESERVED_PROPERTIES,
  type CalV2AlarmView,
  type CalV2Address,
  type CalV2ComponentView,
  type CalV2DateTime,
  type CalV2DeleteBlockedReason,
  type CalV2FieldName,
  type CalV2FieldValues,
  type CalV2Notice,
  type CalV2ObjectView,
  type CalV2Preview,
  type CalV2Property,
  type CalV2ReadonlyReason,
} from '@calicchia/shared';

const RESERVED: ReadonlySet<string> = new Set(CAL_V2_RESERVED_PROPERTIES);
const FIELD_SET: ReadonlySet<string> = new Set(CAL_V2_FIELDS);
const DAY_MS = 86_400_000;
/** Occorrenze elencate nell'anteprima. */
const PREVIEW_LIMIT = 10;
/** Orizzonte dell'anteprima: come validateObject (oggi − 400 giorni, oggi + 800 giorni). */
const HORIZON_PAST_DAYS = 400;
const HORIZON_FUTURE_DAYS = 800;
/** Ricerca delle prossime occorrenze oltre l'orizzonte (serie rade, per esempio annuali). */
const NEXT_SEARCH_DAYS = 3660;
/** Tetto delle occorrenze contate nell'orizzonte (come MAX_INSTANCES_IN_HORIZON). */
const HORIZON_CAP = 5000;

export interface ObjectViewContext {
  objectId: string;
  calendarId: string;
  calendarTz: string;
  href: string;
  etag: string | null;
  source: 'radicale' | 'index';
  health: CalV2ObjectView['health'];
  healthReason: string | null;
  collectionHealth: CalV2ObjectView['collection_health'];
  provenance: { source: string; source_id: string | null };
  readonlyReason: CalV2ReadonlyReason | null;
  deleteBlockedReason: CalV2DeleteBlockedReason | null;
  notices: CalV2Notice[];
  /** recurrence key → component_id noti (cal_object_ids). */
  componentIds: ReadonlyMap<string, string>;
  now: Date;
  /** UID noto altrove (oggetto illeggibile: non si ricava dal testo interpretato). */
  uid?: string | null;
  /** Tipo di componente noto altrove (oggetto illeggibile). */
  componentType?: CalV2ObjectView['component_type'];
}

// ─── Token ───────────────────────────────

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** JSON con chiavi ordinate: forma canonica dei valori wire. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function sortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.replace(/\r\n|\r/g, '\n');
  return v === '' ? null : v;
}

/** Forma canonica (confrontabile) del valore wire di un campo. */
function canonicalFieldValue(field: CalV2FieldName, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  switch (field) {
    case 'summary':
    case 'description':
    case 'location':
      return normalizeText(value as string);
    case 'url':
    case 'color':
      return (value as string).trim() || null;
    case 'status':
    case 'transp':
    case 'class':
      return (value as string).trim().toUpperCase() || null;
    case 'categories':
      return sortedStrings((value as string[]).filter((s) => s !== ''));
    case 'rrule':
      try {
        return canonicalRruleText(value as string);
      } catch {
        return value;
      }
    case 'rdates':
    case 'exdates':
      return sortedStrings((value as unknown[]).map((v) => canonicalJson(v)));
    case 'alarms':
      return (value as IcsComponent[]).map((c) => canonicalComponentText(c)).sort();
    case 'organizer':
      return canonicalPropertyText(value as IcsProperty);
    case 'attendees':
      return (value as IcsProperty[]).map((p) => canonicalPropertyText(p)).sort();
    default:
      return value;
  }
}

/**
 * Token di un campo o di 'prop:<NOME>' sul componente (CAL_V2_ABSENT_TOKEN per
 * una proprietà assente). Un campo illeggibile ha un token proprio, mai uguale
 * a quello di un valore valido.
 */
export function tokenFor(component: IcsComponent, key: string): string {
  if (key.startsWith('prop:')) {
    const props = getProperties(component, key.slice(5).toUpperCase());
    if (props.length === 0) return CAL_V2_ABSENT_TOKEN;
    return digest(canonicalJson(props.map((p) => canonicalPropertyText(p)).sort()));
  }
  if (!FIELD_SET.has(key)) return CAL_V2_ABSENT_TOKEN;
  const field = key as CalV2FieldName;
  try {
    const value = readFieldValues(component, [field])[field];
    return digest(canonicalJson(canonicalFieldValue(field, value)));
  } catch (err) {
    if (err instanceof IcsValueError) return digest(`unreadable:${field}`);
    throw err;
  }
}

// ─── Componenti ───────────────────────────────

function wireProperty(p: IcsProperty): CalV2Property {
  return cloneProperty(p);
}

function wireAddress(a: IcsAddress): CalV2Address {
  return { value: a.value, cn: a.cn, params: a.params.map((p) => ({ name: p.name, values: [...p.values] })) };
}

function utcDateTime(t: IcsTime | null): CalV2DateTime | null {
  return t && t.type === 'date-time' ? (t as CalV2DateTime) : null;
}

/** Proprietà non tipizzate per nome, nell'ordine del testo. */
function extraProperties(c: IcsComponent): Record<string, CalV2Property[]> {
  const out: Record<string, CalV2Property[]> = {};
  for (const p of c.properties) {
    const name = p.name.toUpperCase();
    if (RESERVED.has(name)) continue;
    (out[name] ??= []).push(wireProperty(p));
  }
  return out;
}

function alarmView(alarm: IcsComponent, index: number): CalV2AlarmView {
  const trigger = getProperty(alarm, 'TRIGGER');
  let decoded: CalV2AlarmView['trigger'] = null;
  if (trigger) {
    try {
      if ((getParamValue(trigger, 'VALUE') ?? '').toUpperCase() === 'DATE-TIME') {
        const at = readTimeProperty(trigger);
        if (at.type === 'date-time') decoded = { kind: 'absolute', at };
      } else {
        const related = (getParamValue(trigger, 'RELATED') ?? 'START').toUpperCase() === 'END' ? 'END' : 'START';
        decoded = { kind: 'relative', related, offset: parseDurationValue(trigger.value, 'TRIGGER') };
      }
    } catch {
      decoded = null;
    }
  }
  const repeat = getProperty(alarm, 'REPEAT')?.value.trim();
  let duration: CalV2AlarmView['duration'] = null;
  const durationProp = getProperty(alarm, 'DURATION');
  if (durationProp) {
    try {
      duration = parseDurationValue(durationProp.value, 'DURATION');
    } catch {
      duration = null;
    }
  }
  const uid = getTextValue(alarm, 'UID') ?? getTextValue(alarm, 'X-WR-ALARMUID');
  return {
    index,
    action: getProperty(alarm, 'ACTION')?.value.trim().toUpperCase() || null,
    trigger: decoded,
    description: getTextValue(alarm, 'DESCRIPTION'),
    summary: getTextValue(alarm, 'SUMMARY'),
    attendees: getProperties(alarm, 'ATTENDEE').map((p) => p.value),
    repeat: repeat != null && /^\d+$/.test(repeat) ? Number(repeat) : null,
    duration,
    apple_default: (getTextValue(alarm, 'X-APPLE-DEFAULT-ALARM') ?? '').trim().toUpperCase() === 'TRUE',
    uid: uid && uid.trim() !== '' ? uid.trim() : null,
  };
}

/** Fine dell'istanza: DTEND, oppure inizio + DURATION; un giorno per gli all-day, durata nulla per i timed. */
function endOf(fields: CalV2FieldValues, ctx: ZoneContext): IcsTime {
  const start = fields.start as IcsTime;
  if (fields.end) return fields.end as IcsTime;
  if (fields.duration) return addDurationToTime(start, fields.duration, ctx);
  if (start.type === 'date') return stringToIcsDate(addDays(icsDateToString(start), 1));
  return start;
}

interface ComponentCtx {
  tz: string;
  now: Date;
  componentId: string | null;
}

/** Vista di un componente già individuato. null se il componente non si interpreta (tempi illeggibili). */
function componentView(
  obj: CalendarObject,
  component: IcsComponent,
  recurrenceKey: string,
  isOverride: boolean,
  ctx: ComponentCtx,
): CalV2ComponentView | null {
  try {
    const event = readEvent(component);
    const values = readFieldValues(component);
    if (!values.start) return null;
    const fields = values as unknown as CalV2FieldValues;
    const zctx: ZoneContext = { tz: ctx.tz, timezones: obj.timezones };
    const startMs = timeToUtcMs(fields.start as IcsTime, zctx);
    const endMs = Math.max(startMs, timeToUtcMs(endOf(fields, zctx), zctx));
    const extra = extraProperties(component);
    const tokens: Record<string, string> = {};
    for (const f of CAL_V2_FIELDS) tokens[f] = tokenFor(component, f);
    for (const name of Object.keys(extra)) tokens[`prop:${name}`] = tokenFor(component, `prop:${name}`);
    return {
      recurrence_key: recurrenceKey,
      component_id: ctx.componentId,
      is_override: isOverride,
      fields,
      tokens,
      all_day: fields.start.type === 'date',
      start_utc: new Date(startMs).toISOString(),
      end_utc: new Date(endMs).toISOString(),
      readonly: {
        uid: event.uid,
        sequence: event.sequence,
        dtstamp: utcDateTime(event.dtstamp),
        created: utcDateTime(event.created),
        last_modified: utcDateTime(event.lastModified),
        recurrence_id: event.recurrenceId,
      },
      alarms: event.alarms.map(alarmView),
      organizer: event.organizer ? wireAddress(event.organizer) : null,
      attendees: event.attendees.map(wireAddress),
      extra_properties: extra,
      warnings: event.warnings.map((w) => ({ code: w.code, message: w.message })),
    };
  } catch (err) {
    if (isCalendarCoreError(err)) return null;
    throw err;
  }
}

function keyOfOverride(c: IcsComponent, zctx: ZoneContext): string | null {
  try {
    return componentRecurrenceKey(c, zctx);
  } catch {
    return null;
  }
}

/** SEQUENCE di un componente (0 se assente o illeggibile): serve a scegliere il vincitore fra override duplicati. */
function sequenceOf(c: IcsComponent): number {
  const v = getProperty(c, 'SEQUENCE')?.value.trim();
  return v != null && /^\d+$/.test(v) ? Number(v) : 0;
}

/**
 * Componente di un target: il master ('' ), l'override esistente o, per
 * un'istanza senza override, la pre-immagine (copia del master all'istanza,
 * come preImage() dello store). null se il target non esiste più.
 */
function resolveComponent(
  obj: CalendarObject,
  recurrenceKey: string,
  ctx: { tz: string; now: Date },
): { component: IcsComponent; isOverride: boolean } | null {
  if (recurrenceKey === MASTER_RECURRENCE_KEY) return obj.master ? { component: obj.master, isOverride: false } : null;
  try {
    const mat = materializeOverride(obj, recurrenceKey, ctx);
    return { component: mat.object.overrides[mat.index], isOverride: !mat.created };
  } catch {
    // Oggetto senza master (soli override), o chiave non risolvibile con le regole della serie: override per chiave.
    const zctx: ZoneContext = { tz: ctx.tz, timezones: obj.timezones };
    const found = obj.overrides.find((c) => keyOfOverride(c, zctx) === recurrenceKey);
    return found ? { component: found, isOverride: true } : null;
  }
}

/** Componente (master, override o pre-immagine) di un target, per la lettura dei token e dei valori correnti. */
export function resolveTargetComponent(obj: CalendarObject, recurrenceKey: string, ctx: { tz: string; now: Date }): { component: IcsComponent; isOverride: boolean } | null {
  return resolveComponent(obj, recurrenceKey, ctx);
}

export function buildComponentView(
  obj: CalendarObject,
  recurrenceKey: string,
  ctx: { tz: string; now: Date; componentId: string | null },
): CalV2ComponentView | null {
  const found = resolveComponent(obj, recurrenceKey, ctx);
  return found ? componentView(obj, found.component, recurrenceKey, found.isOverride, ctx) : null;
}

// ─── Anteprima della ricorrenza ───────────────────────────────

function isRecurringMaster(obj: CalendarObject): boolean {
  return Boolean(obj.master && (getProperty(obj.master, 'RRULE') || getProperty(obj.master, 'RDATE')));
}

export function buildPreview(
  obj: CalendarObject,
  opts: { tz: string; now: Date; fromKey?: string; limit?: number },
): CalV2Preview | null {
  const master = obj.master;
  if (!master || !isRecurringMaster(obj)) return null;
  const limit = Math.max(1, Math.min(opts.limit ?? PREVIEW_LIMIT, 50));
  const zctx: ZoneContext = { tz: opts.tz, timezones: obj.timezones };
  const nowMs = opts.now.getTime();

  let dtstart: IcsTime | null = null;
  try {
    const p = getProperty(master, 'DTSTART');
    dtstart = p ? readTimeProperty(p) : null;
  } catch {
    dtstart = null;
  }
  const rruleProp = getProperty(master, 'RRULE');
  const summary = rruleProp && dtstart
    ? describeRrule(rruleProp.value, dtstart, { tz: opts.tz })
    : rruleProp ? `Ricorrenza personalizzata (${rruleProp.value.trim().replace(/^RRULE:/i, '')})` : 'Date scelte singolarmente';

  // Punto di partenza: l'istanza del target, altrimenti adesso.
  let fromMs = nowMs;
  if (opts.fromKey && opts.fromKey !== MASTER_RECURRENCE_KEY && dtstart) {
    try {
      fromMs = timeToUtcMs(recurrenceKeyToTime(opts.fromKey, dtstart, zctx), zctx);
    } catch {
      fromMs = nowMs;
    }
  }

  const visible = (o: { kind: string; status: string | null }): boolean =>
    (o.kind === 'event' || o.kind === 'override') && o.status !== 'CANCELLED';
  const toNext = (o: ReturnType<typeof expandObject>['occurrences'][number]): CalV2Preview['next'][number] => ({
    recurrence_key: o.recurrenceKey,
    start_utc: new Date(o.startUtc).toISOString(),
    end_utc: new Date(o.endUtc).toISOString(),
    all_day: o.allDay,
    is_override: o.kind === 'override',
  });

  // Conteggio nell'orizzonte (come la validazione) ed elenco delle prossime occorrenze.
  const horizon = expandObject(obj, {
    from: nowMs - HORIZON_PAST_DAYS * DAY_MS,
    to: nowMs + HORIZON_FUTURE_DAYS * DAY_MS,
    tz: opts.tz,
    maxOccurrences: HORIZON_CAP,
    computeRangeEnd: false,
  });
  const quarantined = horizon.health !== 'ok';
  const truncated = horizon.materializedUntil !== null;
  const count = quarantined ? null : horizon.occurrences.filter(visible).length;

  let next = quarantined ? [] : horizon.occurrences.filter((o) => visible(o) && o.startUtc >= fromMs).slice(0, limit).map(toNext);
  if (!quarantined && next.length < limit && !truncated) {
    // Serie rade o già oltre l'orizzonte: si cerca più avanti.
    const wide = expandObject(obj, {
      from: fromMs,
      to: fromMs + NEXT_SEARCH_DAYS * DAY_MS,
      tz: opts.tz,
      maxOccurrences: limit + 20,
      computeRangeEnd: false,
    });
    if (wide.health === 'ok') next = wide.occurrences.filter((o) => visible(o) && o.startUtc >= fromMs).slice(0, limit).map(toNext);
  }
  return { rrule_summary: summary, next, instances_in_horizon: count, truncated };
}

// ─── Oggetto ───────────────────────────────

function uidFromRaw(raw: string): string {
  const m = /^UID(?:;[^:\r\n]*)?:([^\r\n]*)/im.exec(raw);
  return m ? m[1].trim() : '';
}

/** Vista dei soli override, uno per recurrence key (a parità vince la SEQUENCE più alta, poi l'ultimo). */
function overrideViews(obj: CalendarObject, ctx: { tz: string; now: Date; componentIds: ReadonlyMap<string, string> }): CalV2ComponentView[] {
  const zctx: ZoneContext = { tz: ctx.tz, timezones: obj.timezones };
  const winners = new Map<string, IcsComponent>();
  for (const c of obj.overrides) {
    const key = keyOfOverride(c, zctx);
    if (key === null) continue;
    const prev = winners.get(key);
    if (!prev || sequenceOf(c) >= sequenceOf(prev)) winners.set(key, c);
  }
  const out: CalV2ComponentView[] = [];
  for (const [key, c] of winners) {
    const view = componentView(obj, c, key, true, { tz: ctx.tz, now: ctx.now, componentId: ctx.componentIds.get(key) ?? null });
    if (view) out.push(view);
  }
  return out.sort((a, b) => (a.recurrence_key < b.recurrence_key ? -1 : a.recurrence_key > b.recurrence_key ? 1 : 0));
}

/**
 * Vista completa di una risorsa (§4 `CalV2ObjectView`). `obj` è null per un
 * testo non interpretabile (`parseError` non nullo): vista di sola lettura
 * con il testo così com'è. `targetKey` null = il master (o, senza master, il
 * primo override).
 */
export function buildObjectView(
  raw: string,
  obj: CalendarObject | null,
  parseError: string | null,
  targetKey: string | null,
  ctx: ObjectViewContext,
): CalV2ObjectView {
  const base = {
    id: ctx.objectId,
    calendar_id: ctx.calendarId,
    href: ctx.href,
    etag: ctx.etag,
    source: ctx.source,
    calendar_tz: ctx.calendarTz,
    health: ctx.health,
    health_reason: ctx.healthReason,
    collection_health: ctx.collectionHealth,
    provenance: { source: ctx.provenance.source, source_id: ctx.provenance.source_id },
    delete_blocked_reason: ctx.deleteBlockedReason,
    ics: raw,
    parse_error: parseError,
  };
  const notices = new Set<CalV2Notice>(ctx.notices);
  if (ctx.source === 'index') notices.add('index_fallback');
  if (ctx.collectionHealth === 'hold') notices.add('collection_hold');
  if (ctx.provenance.source === 'booking') notices.add('booking_projection');

  if (!obj) {
    return {
      ...base,
      uid: ctx.uid ?? uidFromRaw(raw),
      component_type: ctx.componentType ?? 'VEVENT',
      readonly_reason: ctx.readonlyReason ?? 'unreadable',
      notices: [...notices],
      recurring: false,
      master: null,
      overrides: [],
      target: null,
      calendar_properties: [],
      timezones: [],
      other_components: [],
      preview: null,
      parse_error: parseError ?? 'Testo non interpretabile',
    };
  }

  const tz = ctx.calendarTz;
  const compCtx = (key: string): { tz: string; now: Date; componentId: string | null } => ({
    tz,
    now: ctx.now,
    componentId: ctx.componentIds.get(key) ?? (key === MASTER_RECURRENCE_KEY && ctx.objectId ? ctx.objectId : null),
  });
  const master = obj.master ? componentView(obj, obj.master, MASTER_RECURRENCE_KEY, false, compCtx(MASTER_RECURRENCE_KEY)) : null;
  const overrides = overrideViews(obj, { tz, now: ctx.now, componentIds: ctx.componentIds });

  let target: CalV2ComponentView | null;
  if (targetKey === null) target = master ?? overrides[0] ?? null;
  else if (targetKey === MASTER_RECURRENCE_KEY) target = master;
  else target = overrides.find((o) => o.recurrence_key === targetKey) ?? buildComponentView(obj, targetKey, compCtx(targetKey));

  const hasAttendees = [obj.master, ...obj.overrides].some((c) => c != null && getProperties(c, 'ATTENDEE').length > 0);
  if (hasAttendees) notices.add('no_scheduling');

  const recurring = isRecurringMaster(obj);
  const readonlyReason: CalV2ReadonlyReason | null = ctx.readonlyReason
    ?? (obj.master && !master ? 'unreadable' : obj.componentType !== 'VEVENT' ? 'component_unsupported' : null);
  const fromKey = targetKey ?? undefined;
  return {
    ...base,
    uid: obj.uid,
    component_type: obj.componentType,
    readonly_reason: readonlyReason,
    notices: [...notices],
    recurring,
    master,
    overrides,
    target,
    calendar_properties: obj.calendarProperties.map(wireProperty),
    timezones: obj.timezones.map((t) => vtimezoneTzid(t)).filter((t): t is string => typeof t === 'string' && t !== ''),
    other_components: obj.otherComponents.map((c) => c.name),
    preview: recurring && master ? buildPreview(obj, { tz, now: ctx.now, fromKey }) : null,
  };
}
