/**
 * Trasformazione per il feed ICS pubblico (design §10) e contenuto delle
 * proiezioni delle prenotazioni per i device (decisione 3, design §9).
 *
 * Il feed `GET /api/calendar/feed/:token.ics` si genera dall'indice della
 * collezione (funziona anche con Radicale giù) con le stesse finestre e gli
 * stessi filtri di oggi, correggendo i bug del §14 (override con UID diversi,
 * override cancellati che ricompaiono):
 * - finestra: serie sempre; singoli che si sovrappongono a
 *   [now − pastDays, now + futureDays] (default 90 e 365 giorni), con la
 *   stessa condizione del legacy (inizio < fine finestra e fine > inizio
 *   finestra);
 * - esclusi: oggetti delle iscrizioni (il chiamante non li passa mai), oggetti
 *   che non sono VEVENT e master o singoli con STATUS:CANCELLED, compresi
 *   quelli scritti dai device;
 * - override nella risorsa del master, con lo stesso UID; gli override
 *   STATUS:CANCELLED diventano EXDATE del master (tipizzati come il DTSTART);
 * - UID: per gli oggetti migrati `${legacyUid}@${uidDomain}` (cal_object_ids,
 *   l'UID che gli abbonati vedono oggi: il feed legacy aggiunge sempre il
 *   dominio); gli altri UID senza '@' ricevono il suffisso `@${uidDomain}`;
 *   gli UID con '@' passano invariati;
 * - DTSTAMP stabile: LAST-MODIFIED se presente, altrimenti firstSeenAt;
 * - privacy per costruzione (whitelist): passano solo le proprietà di
 *   FEED_PROPERTY_WHITELIST; niente VALARM, ATTENDEE, ORGANIZER né X-*;
 *   CLASS:PRIVATE o CONFIDENTIAL → SUMMARY FEED_PRIVATE_SUMMARY senza
 *   DESCRIPTION, LOCATION e URL (un override senza CLASS di un master privato
 *   resta privato);
 * - proiezioni delle prenotazioni (`bookingProjection`): contenuto della
 *   decisione 3 ricomposto dai dati della prenotazione (titolo con il nome,
 *   telefono, link all'admin; niente email, azienda, messaggio né ATTENDEE),
 *   ridotto a "Prenotazione" dopo BOOKING_PROJECTION_RETENTION_MONTHS dalla
 *   fine o se la prenotazione non c'è più;
 * - TRANSP assente → TRANSP:OPAQUE esplicito (è il default di RFC 5545 e il
 *   feed legacy lo scrive sempre);
 * - VTIMEZONE deduplicati per TZID (canonici del registro per i TZID IANA);
 * - intestazione come il feed legacy (ics-feed.ts): METHOD:PUBLISH,
 *   CALSCALE:GREGORIAN, X-WR-CALNAME, X-WR-CALDESC (default "Calendario
 *   <nome>"), X-WR-TIMEZONE, X-APPLE-CALENDAR-COLOR, PRODID stabile;
 * - ETag = SHA-256 del corpo generato (fingerprint.contentSha256) fra
 *   virgolette: cambia quando la finestra scorre e un evento entra o esce.
 *
 * Il corpo è deterministico: oggetti ordinati per inizio e UID pubblicato,
 * override per recurrence key, nessun valore che dipende dall'orologio se non
 * la finestra.
 */

import { allDayRangeFromIcs, localMidnightUtcMs } from './allday';
import { type CalendarCoreError, IcsParseError, IcsValueError, TimezoneError, toCoreError } from './errors';
import { contentSha256 } from './fingerprint';
import { collectTzidRefs, encodeText, vtimezoneTzid } from './ics-text';
import {
  addDurationToTime,
  BOOKING_UID_DOMAIN,
  bookingProjectionUid,
  type CalendarObject,
  cloneProperty,
  componentRecurrenceKey,
  createCalendarObject,
  createTimeListProperties,
  createTimeProperty,
  formatTimeValue,
  getProperties,
  getProperty,
  getTextValue,
  type IcsComponent,
  type IcsProperty,
  type IcsTime,
  parseDurationValue,
  readTimeListProperty,
  readTimeProperty,
  recurrenceKeyToTime,
  setProperty,
  setTextValue,
  timeParams,
  timeToUtcMs,
  utcMsToTime,
  type ZoneContext,
} from './model';
import { serializeCalendar } from './serialize';
import { DEFAULT_TZ, ianaZone, msToWall } from './tz-registry';

/** Versione della trasformazione: entra nella chiave della cache dell'ETag lato API. */
export const FEED_TRANSFORM_VERSION = 1;

/** Proprietà dei VEVENT che passano nel feed. */
export const FEED_PROPERTY_WHITELIST = [
  'UID',
  'DTSTAMP',
  'DTSTART',
  'DTEND',
  'DURATION',
  'RRULE',
  'RDATE',
  'EXDATE',
  'RECURRENCE-ID',
  'SUMMARY',
  'DESCRIPTION',
  'LOCATION',
  'URL',
  'STATUS',
  'TRANSP',
  'SEQUENCE',
  'CREATED',
  'LAST-MODIFIED',
] as const;

/** SUMMARY degli eventi CLASS:PRIVATE/CONFIDENTIAL. */
export const FEED_PRIVATE_SUMMARY = 'Occupato';

export const FEED_PAST_DAYS = 90;
export const FEED_FUTURE_DAYS = 365;

/** PRODID del feed: lo stesso del feed legacy (ics-feed.ts), senza versione. */
export const FEED_PRODID = '-//Caldes//Calendar//IT';

/** Mesi dopo la fine oltre i quali una proiezione mostra solo "Prenotazione" (decisione 3). */
export const BOOKING_PROJECTION_RETENTION_MONTHS = 24;

/** SUMMARY delle proiezioni ridotte (concluse da più di 24 mesi o senza prenotazione). */
export const BOOKING_PROJECTION_MINIMIZED_SUMMARY = 'Prenotazione';

export interface FeedCalendarInfo {
  name: string;
  description: string | null;
  /** calendars.timezone (X-WR-TIMEZONE). */
  timezone: string;
  /** calendars.color (X-APPLE-CALENDAR-COLOR). */
  color: string;
}

/**
 * Dati della prenotazione che servono alla proiezione sui device e nel feed
 * (decisione 3): mai email, azienda, messaggio. Li ricompone l'API da
 * calendar_bookings ed event_types.
 */
export interface BookingProjectionData {
  /** calendar_bookings.uid. */
  bookingUid: string;
  /** event_types.title. */
  title: string;
  attendeeName: string;
  attendeePhone: string | null;
  /** Link alla prenotazione nell'admin (lo costruisce l'API da ADMIN_URL); null se non disponibile. */
  adminUrl: string | null;
  /** Inizio (ISO o Date). */
  start: string | Date;
  /** Fine (ISO o Date): conta per la riduzione dopo 24 mesi. */
  end: string | Date;
  /** calendar_bookings.location_value. */
  location: string | null;
  /** Link della riunione (proprietà URL, come la proiezione legacy). */
  meetingUrl: string | null;
}

/** Contenuto testuale di una proiezione secondo la decisione 3. */
export interface BookingProjectionContent {
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  /** True se ridotta a "Prenotazione" (conclusa da più di 24 mesi o senza dati). */
  minimized: boolean;
}

export interface FeedObjectInput {
  object: CalendarObject;
  /** cal_objects.first_seen_at: DTSTAMP stabile quando manca LAST-MODIFIED. */
  firstSeenAt: Date;
  /**
   * cal_object_ids.legacy_uid degli oggetti migrati (proiezioni comprese), o
   * null: l'UID pubblicato diventa `${legacyUid}@${uidDomain}`, identico a
   * quello del feed legacy anche per gli UID legacy che contengono '@'.
   */
  legacyUid?: string | null;
  /** cal_objects.range_start (ms UTC), se noto: evita di ricalcolare l'estensione. */
  rangeStart?: number | null;
  /** cal_objects.range_end (ms UTC, null = illimitata), se noto. */
  rangeEnd?: number | null;
  /**
   * Proiezione di una prenotazione (occorrenze kind=booking_projection): il
   * contenuto si ricompone da `data` secondo la decisione 3; `data: null`
   * (prenotazione non più presente, per esempio dopo un'erasure) riduce a
   * "Prenotazione". Assente o null: l'oggetto non è una proiezione.
   */
  bookingProjection?: { data: BookingProjectionData | null } | null;
}

export interface FeedTransformOptions {
  now: Date;
  /** CAL_FEED_UID_DOMAIN (valore congelato). */
  uidDomain: string;
  /** Fuso del calendario (floating e DATE). */
  tz: string;
  /** Default FEED_PAST_DAYS. */
  pastDays?: number;
  /** Default FEED_FUTURE_DAYS. */
  futureDays?: number;
  /**
   * Solo buildFeed: un oggetto che la trasformazione non riesce a trattare
   * (difetto inatteso, non un valore illeggibile) resta fuori dal feed e
   * viene segnalato qui, così il chiamante lo registra; gli altri oggetti
   * escono comunque. Senza callback viene solo escluso.
   */
  onObjectError?: (input: FeedObjectInput, error: CalendarCoreError) => void;
}

export interface FeedObjectOutput {
  /** VEVENT pronti per il feed: master (con le EXDATE degli override cancellati) e override. */
  components: IcsComponent[];
  /** TZID referenziati, per la deduplica dei VTIMEZONE. */
  tzids: string[];
}

const DAY_MS = 86_400_000;
const WHITELIST: ReadonlySet<string> = new Set(FEED_PROPERTY_WHITELIST);
const PRIVATE_DROPPED: ReadonlySet<string> = new Set(['SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL']);

/** UID pubblicato nel feed per un oggetto (regole in testa al modulo). */
export function feedUid(uid: string, opts: { uidDomain: string; legacyUid?: string | null }): string {
  const legacy = opts.legacyUid?.trim();
  if (legacy) return `${legacy}@${opts.uidDomain}`;
  const u = uid.trim();
  return u.includes('@') ? u : `${u}@${opts.uidDomain}`;
}

/** Un oggetto → componenti del feed, o null se escluso (cancellato o fuori finestra). */
export function transformObjectForFeed(input: FeedObjectInput, opts: FeedTransformOptions): FeedObjectOutput | null {
  try {
    return transform(input, opts);
  } catch (err) {
    // Oggetto illeggibile (l'indice lo ha in quarantena): fuori dal feed, gli altri restano.
    if (err instanceof IcsValueError || err instanceof TimezoneError || err instanceof IcsParseError) return null;
    throw toCoreError(err, 'transformObjectForFeed');
  }
}

/** Feed completo di un calendario: corpo canonico (CRLF, folding) ed ETag. */
export function buildFeed(
  calendar: FeedCalendarInfo,
  objects: readonly FeedObjectInput[],
  opts: FeedTransformOptions,
): { body: string; etag: string } {
  try {
    const tz = opts.tz || DEFAULT_TZ;
    const entries: Array<{ sortStart: number; uid: string; components: IcsComponent[]; timezones: readonly IcsComponent[] }> = [];
    for (const input of objects) {
      let out: FeedObjectOutput | null;
      try {
        out = transformObjectForFeed(input, opts);
      } catch (err) {
        // Un solo oggetto non porta mai il feed in errore (design §1, fallimento circoscritto).
        opts.onObjectError?.(input, toCoreError(err, 'buildFeed'));
        continue;
      }
      if (!out) continue;
      const uid = getTextValue(out.components[0], 'UID') ?? '';
      entries.push({ sortStart: sortStartOf(input, out.components, { tz, timezones: input.object.timezones }), uid, components: out.components, timezones: input.object.timezones });
    }
    entries.sort((a, b) => a.sortStart - b.sortStart || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));

    // VTIMEZONE non IANA dagli oggetti, deduplicati per TZID (vince il primo nell'ordine del feed):
    // per i TZID IANA serializeCalendar usa i canonici del registro.
    const customTz = new Map<string, IcsComponent>();
    for (const e of entries) {
      for (const tzid of collectTzidRefs(e.components)) {
        if (customTz.has(tzid)) continue;
        const own = e.timezones.find((t) => vtimezoneTzid(t) === tzid.trim());
        if (own) customTz.set(tzid, own);
      }
    }

    const header: IcsProperty[] = [
      { name: 'CALSCALE', params: [], value: 'GREGORIAN' },
      { name: 'METHOD', params: [], value: 'PUBLISH' },
      { name: 'X-WR-CALNAME', params: [], value: encodeText(calendar.name) },
      { name: 'X-WR-CALDESC', params: [], value: encodeText(calendar.description || `Calendario ${calendar.name}`) },
      { name: 'X-WR-TIMEZONE', params: [], value: oneLine(calendar.timezone) },
      { name: 'X-APPLE-CALENDAR-COLOR', params: [], value: oneLine(calendar.color) },
    ];
    const cal: IcsComponent = {
      name: 'VCALENDAR',
      properties: header,
      components: [...customTz.values(), ...entries.flatMap((e) => e.components)],
    };
    const body = serializeCalendar(cal, { prodid: FEED_PRODID, timezones: 'canonical' });
    return { body, etag: `"${contentSha256(body)}"` };
  } catch (err) {
    throw toCoreError(err, 'buildFeed');
  }
}

// ============================================
// Proiezioni delle prenotazioni (decisione 3)
// ============================================

function toMs(v: string | Date | number): number {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms)) throw new IcsValueError('INVALID_ISO', `Istante non valido: "${String(v).slice(0, 40)}"`, { value: String(v) });
  return ms;
}

/** True se la prenotazione è conclusa da più di BOOKING_PROJECTION_RETENTION_MONTHS mesi (mesi di calendario, UTC). */
export function isBookingProjectionExpired(end: string | Date | number, now: Date): boolean {
  const limit = new Date(toMs(end));
  limit.setUTCMonth(limit.getUTCMonth() + BOOKING_PROJECTION_RETENTION_MONTHS);
  return now.getTime() >= limit.getTime();
}

function oneLine(s: string | null | undefined): string {
  return (s ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Contenuto di una proiezione per i device e per il feed (decisione 3):
 * SUMMARY «titolo – nome» (come la proiezione legacy), DESCRIPTION con il
 * telefono e il link alla prenotazione nell'admin, LOCATION e URL della
 * riunione. Niente email, azienda, messaggio. Dopo 24 mesi dalla fine (o
 * senza dati) solo "Prenotazione", senza descrizione, luogo e link.
 */
export function bookingProjectionContent(data: BookingProjectionData | null, opts: { now: Date }): BookingProjectionContent {
  if (!data || isBookingProjectionExpired(data.end, opts.now)) {
    return { summary: BOOKING_PROJECTION_MINIMIZED_SUMMARY, description: null, location: null, url: null, minimized: true };
  }
  const title = oneLine(data.title);
  const name = oneLine(data.attendeeName);
  const summary = title && name ? `${title} – ${name}` : title || name || BOOKING_PROJECTION_MINIMIZED_SUMMARY;
  const lines: string[] = [];
  const phone = oneLine(data.attendeePhone);
  if (phone) lines.push(`Tel: ${phone}`);
  const adminUrl = oneLine(data.adminUrl);
  if (adminUrl) lines.push(`Prenotazione in admin: ${adminUrl}`);
  return {
    summary,
    description: lines.length > 0 ? lines.join('\n') : null,
    location: oneLine(data.location) || null,
    url: oneLine(data.meetingUrl) || null,
    minimized: false,
  };
}

/** Istante → DATE-TIME nel fuso del calendario (TZID, o UTC se il fuso è UTC). */
function zonedValue(ms: number, tz: string): IcsTime {
  const zone = ianaZone(tz);
  if (zone.kind === 'utc') return { type: 'date-time', ...msToWall(ms), zone: { kind: 'utc' } };
  return utcMsToTime(ms, { type: 'date-time', year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0, zone: { kind: 'tzid', tzid: tz } }, { tz });
}

function utcStamp(d: Date | number): string {
  return formatTimeValue({ type: 'date-time', ...msToWall(typeof d === 'number' ? d : d.getTime()), zone: { kind: 'utc' } });
}

/**
 * Risorsa della proiezione di una prenotazione nella collezione bookings
 * (job project_booking, design §9): UID `<uid>@caldes.it` come l'invito,
 * orari nel fuso del calendario, STATUS:CONFIRMED, contenuto della decisione
 * 3, nessun ORGANIZER, ATTENDEE, VALARM né TRANSP (vale OPAQUE). L'href è
 * model.bookingHref(uid). La provenienza la decidono collezione e href, non
 * le X-prop: nessuna X-CALDES-SOURCE.
 */
export function buildBookingProjection(
  data: BookingProjectionData,
  opts: { now: Date; tz: string; sequence?: number | null; created?: Date | null; uidDomain?: string },
): CalendarObject {
  try {
    const tz = opts.tz || DEFAULT_TZ;
    const uid = bookingProjectionUid(data.bookingUid, opts.uidDomain ?? BOOKING_UID_DOMAIN);
    const startMs = toMs(data.start);
    const endMs = toMs(data.end);
    if (endMs <= startMs) throw new IcsValueError('INVALID_VALUE', 'Prenotazione con fine non successiva all\'inizio', { property: 'DTEND' });
    const content = bookingProjectionContent(data, { now: opts.now });
    const props: IcsProperty[] = [
      { name: 'UID', params: [], value: encodeText(uid) },
      { name: 'DTSTAMP', params: [], value: utcStamp(opts.now) },
    ];
    if (opts.created) props.push({ name: 'CREATED', params: [], value: utcStamp(opts.created) });
    props.push({ name: 'LAST-MODIFIED', params: [], value: utcStamp(opts.now) });
    if (opts.sequence != null) props.push({ name: 'SEQUENCE', params: [], value: String(Math.max(0, Math.trunc(opts.sequence))) });
    props.push(createTimeProperty('DTSTART', zonedValue(startMs, tz)));
    props.push(createTimeProperty('DTEND', zonedValue(endMs, tz)));
    props.push({ name: 'SUMMARY', params: [], value: encodeText(content.summary) });
    if (content.description) props.push({ name: 'DESCRIPTION', params: [], value: encodeText(content.description) });
    if (content.location) props.push({ name: 'LOCATION', params: [], value: encodeText(content.location) });
    if (content.url) props.push({ name: 'URL', params: [], value: content.url });
    props.push({ name: 'STATUS', params: [], value: 'CONFIRMED' });
    return createCalendarObject({ uid, componentType: 'VEVENT', master: { name: 'VEVENT', properties: props, components: [] } });
  } catch (err) {
    throw toCoreError(err, 'buildBookingProjection');
  }
}

// ============================================
// Trasformazione di un oggetto
// ============================================

function isCancelled(c: IcsComponent): boolean {
  return (getTextValue(c, 'STATUS') ?? '').trim().toUpperCase() === 'CANCELLED';
}

function classOf(c: IcsComponent): string | null {
  const v = getTextValue(c, 'CLASS');
  return v == null ? null : v.trim().toUpperCase();
}

function isPrivateClass(cls: string | null): boolean {
  return cls === 'PRIVATE' || cls === 'CONFIDENTIAL';
}

/** Estensione [inizio, fine) in ms UTC di un componente (all-day: mezzanotti locali nel fuso del calendario). */
function componentSpan(c: IcsComponent, ctx: ZoneContext): { start: number; end: number } {
  const startProp = getProperty(c, 'DTSTART');
  if (!startProp) throw new IcsValueError('MISSING_PROPERTY', 'VEVENT senza DTSTART', { property: 'DTSTART' });
  const start = readTimeProperty(startProp);
  const endProp = getProperty(c, 'DTEND');
  const end = endProp ? readTimeProperty(endProp) : null;
  const durProp = getProperty(c, 'DURATION');
  const duration = durProp ? parseDurationValue(durProp.value, 'DURATION') : null;
  if (start.type === 'date') {
    const range = allDayRangeFromIcs(start, end, end ? null : duration, ctx);
    return { start: localMidnightUtcMs(range.start, ctx.tz), end: localMidnightUtcMs(range.end, ctx.tz) };
  }
  const startMs = timeToUtcMs(start, ctx);
  let endMs = startMs;
  if (end) endMs = timeToUtcMs(end, ctx);
  else if (duration) endMs = timeToUtcMs(addDurationToTime(start, duration, ctx), ctx);
  return { start: startMs, end: Math.max(endMs, startMs) };
}

/** Condizione del feed legacy: inizio < fine finestra e fine > inizio finestra. */
function overlaps(span: { start: number; end: number }, from: number, to: number): boolean {
  return span.start < to && span.end > from;
}

function stableStamp(c: IcsComponent, fallback: string): string {
  const p = getProperty(c, 'LAST-MODIFIED');
  if (p) {
    try {
      const t = readTimeProperty(p);
      if (t.type === 'date-time' && t.zone.kind === 'utc') return formatTimeValue(t);
    } catch {
      // LAST-MODIFIED illeggibile: vale first_seen_at.
    }
  }
  return fallback;
}

/** Componente filtrato per il feed: whitelist, UID pubblicato, DTSTAMP stabile, privacy e contenuto della proiezione. */
function feedComponent(
  c: IcsComponent,
  uid: string,
  fallbackStamp: string,
  privateEvent: boolean,
  projection: BookingProjectionContent | null,
): IcsComponent {
  const stampValue = stableStamp(c, fallbackStamp);
  const props: IcsProperty[] = [
    { name: 'UID', params: [], value: encodeText(uid) },
    { name: 'DTSTAMP', params: [], value: stampValue },
  ];
  for (const p of c.properties) {
    const name = p.name.toUpperCase();
    if (!WHITELIST.has(name) || name === 'UID' || name === 'DTSTAMP') continue;
    props.push(cloneProperty(p));
  }
  const out: IcsComponent = { name: 'VEVENT', properties: props, components: [] };
  if (projection) {
    setTextValue(out, 'SUMMARY', projection.summary);
    setTextValue(out, 'DESCRIPTION', projection.description);
    setTextValue(out, 'LOCATION', projection.location);
    if (projection.url) setUrl(out, projection.url);
    else out.properties = out.properties.filter((p) => p.name.toUpperCase() !== 'URL');
  }
  if (privateEvent) {
    out.properties = out.properties.filter((p) => !PRIVATE_DROPPED.has(p.name.toUpperCase()));
    out.properties.push({ name: 'SUMMARY', params: [], value: encodeText(FEED_PRIVATE_SUMMARY) });
  }
  // TRANSP assente vale OPAQUE (RFC 5545): il feed legacy lo scrive sempre, lo si rende esplicito.
  if (!out.properties.some((p) => p.name.toUpperCase() === 'TRANSP')) out.properties.push({ name: 'TRANSP', params: [], value: 'OPAQUE' });
  return out;
}

/** URL della proiezione, nella posizione di quello esistente (valore URI: niente escape TEXT). */
function setUrl(c: IcsComponent, url: string): void {
  setProperty(c, { name: 'URL', params: [], value: url });
}

function sortedByRecurrenceKey(overrides: IcsComponent[], ctx: ZoneContext): IcsComponent[] {
  const keyed = overrides.map((c, i) => {
    let key: string;
    try {
      key = componentRecurrenceKey(c, ctx);
    } catch {
      key = `~${getProperty(c, 'RECURRENCE-ID')?.value ?? ''}`;
    }
    return { c, i, key };
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i));
  return keyed.map((k) => k.c);
}

function timeKey(t: IcsTime): string {
  return `${formatTimeValue(t)}|${timeParams(t)
    .map((p) => `${p.name}=${p.values.join(',')}`)
    .join(';')}`;
}

function transform(input: FeedObjectInput, opts: FeedTransformOptions): FeedObjectOutput | null {
  const obj = input.object;
  if (obj.componentType !== 'VEVENT') return null;
  const tz = opts.tz || DEFAULT_TZ;
  const ctx: ZoneContext = { tz, timezones: obj.timezones };
  const nowMs = opts.now.getTime();
  const from = nowMs - (opts.pastDays ?? FEED_PAST_DAYS) * DAY_MS;
  const to = nowMs + (opts.futureDays ?? FEED_FUTURE_DAYS) * DAY_MS;
  const uid = feedUid(obj.uid, { uidDomain: opts.uidDomain, legacyUid: input.legacyUid });
  const fallbackStamp = utcStamp(input.firstSeenAt);
  const projection = input.bookingProjection ? bookingProjectionContent(input.bookingProjection.data, { now: opts.now }) : null;
  const components: IcsComponent[] = [];

  const master = obj.master;
  if (master) {
    if (isCancelled(master)) return null;
    const recurring = getProperties(master, 'RRULE').length > 0 || getProperties(master, 'RDATE').length > 0;
    if (!recurring) {
      const span =
        input.rangeStart != null
          ? { start: input.rangeStart, end: input.rangeEnd ?? Number.POSITIVE_INFINITY }
          : componentSpan(master, ctx);
      if (!overlaps(span, from, to)) return null;
    }
    const startProp = getProperty(master, 'DTSTART');
    if (!startProp) throw new IcsValueError('MISSING_PROPERTY', 'VEVENT senza DTSTART', { property: 'DTSTART' });
    const masterStart = readTimeProperty(startProp);
    const masterClass = classOf(master);
    const cancelled: IcsTime[] = [];
    const kept: IcsComponent[] = [];
    for (const ov of sortedByRecurrenceKey(obj.overrides, ctx)) {
      if (isCancelled(ov)) {
        if (!recurring) continue;
        try {
          cancelled.push(recurrenceKeyToTime(componentRecurrenceKey(ov, ctx), masterStart, ctx));
        } catch {
          // RECURRENCE-ID illeggibile: l'override cancellato non si può tradurre, resta fuori.
        }
        continue;
      }
      // Override di un evento singolo (orfano): occorrenza autonoma, nella finestra come i singoli.
      if (!recurring) {
        try {
          if (!overlaps(componentSpan(ov, ctx), from, to)) continue;
        } catch {
          continue;
        }
      }
      kept.push(ov);
    }

    const m = feedComponent(master, uid, fallbackStamp, isPrivateClass(masterClass), projection);
    if (cancelled.length > 0) {
      const existing = new Set<string>();
      for (const p of getProperties(m, 'EXDATE')) {
        try {
          for (const v of readTimeListProperty(p)) if (v.type !== 'period') existing.add(timeKey(v));
        } catch {
          // EXDATE illeggibile: si aggiungono comunque le nuove.
        }
      }
      const fresh = cancelled.filter((v) => {
        const k = timeKey(v);
        if (existing.has(k)) return false;
        existing.add(k);
        return true;
      });
      if (fresh.length > 0) m.properties.push(...createTimeListProperties('EXDATE', fresh));
    }
    components.push(m);
    for (const ov of kept) {
      const cls = classOf(ov);
      const priv = isPrivateClass(cls) || (cls == null && isPrivateClass(masterClass));
      components.push(feedComponent(ov, uid, fallbackStamp, priv, projection));
    }
  } else {
    // Solo override (inviti a singole occorrenze): ognuno con la propria finestra.
    for (const ov of sortedByRecurrenceKey(obj.overrides, ctx)) {
      if (isCancelled(ov)) continue;
      try {
        if (!overlaps(componentSpan(ov, ctx), from, to)) continue;
      } catch {
        continue;
      }
      components.push(feedComponent(ov, uid, fallbackStamp, isPrivateClass(classOf(ov)), projection));
    }
    if (components.length === 0) return null;
  }
  return { components, tzids: collectTzidRefs(components) };
}

/** Chiave d'ordinamento del feed: inizio dell'oggetto (range_start se noto), poi UID pubblicato. */
function sortStartOf(input: FeedObjectInput, components: IcsComponent[], ctx: ZoneContext): number {
  if (input.rangeStart != null) return input.rangeStart;
  try {
    return componentSpan(components[0], ctx).start;
  } catch {
    return 0;
  }
}
