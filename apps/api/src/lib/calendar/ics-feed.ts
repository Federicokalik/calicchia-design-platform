/**
 * Genera ICS feed completo per un calendario (RFC 5545).
 *
 * Differenza da `ics.ts` (singolo evento booking):
 * - VCALENDAR contiene N VEVENT (tutti gli eventi del calendario)
 * - Master ricorrenti emessi con RRULE/EXDATE — il client espande lui (Apple/Google/Outlook)
 * - Override emessi come VEVENT separati con RECURRENCE-ID
 * - Niente VALARM (i client gestiscono notifiche autonomamente per i loro calendari)
 * - METHOD:PUBLISH (non REQUEST/CANCEL — è una sottoscrizione, non un invito)
 */

import type { Calendar, CalendarEvent } from './types';

const CRLF = '\r\n';

function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

/** Folding RFC 5545: 75 ottetti per linea, byte-safe per UTF-8 */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).byteLength <= 75) return line;

  const out: string[] = [];
  let buf = '';
  let bufBytes = 0;
  let isFirstLine = true;

  for (const ch of line) {
    const chBytes = enc.encode(ch).byteLength;
    const limit = isFirstLine ? 75 : 74;
    if (bufBytes + chBytes > limit) {
      out.push(isFirstLine ? buf : ' ' + buf);
      buf = ch;
      bufBytes = chBytes;
      isFirstLine = false;
    } else {
      buf += ch;
      bufBytes += chBytes;
    }
  }
  if (buf.length > 0) out.push(isFirstLine ? buf : ' ' + buf);
  return out.join(CRLF);
}

function formatUtcDateTime(iso: string | Date): string {
  // NB: il driver postgres restituisce Date per timestamptz — accetta entrambi.
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function zonedParts(iso: string | Date, tz: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

// Gli all-day sono salvati come mezzanotte locale (22:00/23:00Z del giorno
// prima): con toISOString() il feed li spostava al giorno precedente.
function formatDateOnly(iso: string | Date, tz: string): string {
  const p = zonedParts(iso, tz);
  return `${p.year}${p.month}${p.day}`;
}

/** Wall-clock nel fuso, formato RFC 5545 da usare con ;TZID= */
function formatLocalDateTime(iso: string | Date, tz: string): string {
  const p = zonedParts(iso, tz);
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

// Serie ricorrenti con DTSTART in UTC vengono ripetute dai client (iPhone,
// Google) alla stessa ora UTC: dopo il cambio d'ora slittano di un'ora. Per
// master ricorrenti e loro eccezioni si emette l'ora locale con TZID, che
// RFC 5545 vuole accompagnata dal VTIMEZONE (regole UE vigenti per Europe/Rome).
const RECURRING_TZ = 'Europe/Rome';
const VTIMEZONE_EUROPE_ROME = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Rome',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

const usesRecurringTz = (ev: CalendarEvent, tz: string) =>
  tz === RECURRING_TZ && !ev.all_day && Boolean(ev.rrule || ev.recurrence_id);

function nowUtcCompact(): string {
  return formatUtcDateTime(new Date().toISOString());
}

// I tempi sono emessi in UTC (Z) o come DATE all-day; solo i ricorrenti usano
// TZID=Europe/Rome con il relativo VTIMEZONE (vedi usesRecurringTz).

interface BuildOpts {
  calendar: Calendar;
  events: CalendarEvent[];
  uidDomain?: string;
}

export function buildIcsFeed(opts: BuildOpts): string {
  const uidDomain = opts.uidDomain || 'caldes.it';
  const calName = escapeText(opts.calendar.name);
  const calDesc = escapeText(opts.calendar.description || `Calendario ${opts.calendar.name}`);

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Caldes//Calendar//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${calName}`,
    `X-WR-CALDESC:${calDesc}`,
    `X-WR-TIMEZONE:${opts.calendar.timezone}`,
    `X-APPLE-CALENDAR-COLOR:${opts.calendar.color}`,
  ];

  const tz = opts.calendar.timezone || RECURRING_TZ;
  const visible = opts.events.filter((ev) => ev.status !== 'cancelled');
  if (visible.some((ev) => usesRecurringTz(ev, tz))) lines.push(...VTIMEZONE_EUROPE_ROME);
  for (const ev of visible) {
    lines.push(...buildVEvent(ev, uidDomain, tz));
  }

  lines.push('END:VCALENDAR');

  return lines
    .filter(Boolean)
    .map((l) => fold(l))
    .join(CRLF) + CRLF;
}

/**
 * Una singola risorsa CalDAV (RFC 4791): un VCALENDAR con il VEVENT master e i
 * suoi override (RECURRENCE-ID), TUTTI con lo stesso UID del master. È ciò che
 * il backend CalDAV serve su GET .../items/:uid e accetta su PUT.
 */
export function buildIcsResource(opts: {
  calendar: Calendar;
  master: CalendarEvent;
  overrides?: CalendarEvent[];
  uidDomain?: string;
}): string {
  const uidDomain = opts.uidDomain || 'caldes.it';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Caldes//Calendar//IT',
    'CALSCALE:GREGORIAN',
  ];
  const tz = opts.calendar.timezone || RECURRING_TZ;
  if ([opts.master, ...(opts.overrides || [])].some((ev) => usesRecurringTz(ev, tz))) {
    lines.push(...VTIMEZONE_EUROPE_ROME);
  }
  lines.push(...buildVEvent(opts.master, uidDomain, tz));
  for (const ov of opts.overrides || []) {
    // L'override condivide l'UID del master (lo distingue il RECURRENCE-ID).
    lines.push(...buildVEvent({ ...ov, uid: opts.master.uid }, uidDomain, tz));
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map((l) => fold(l)).join(CRLF) + CRLF;
}

function buildVEvent(ev: CalendarEvent, uidDomain: string, tz: string): string[] {
  const local = usesRecurringTz(ev, tz);
  const dateTime = (d: string | Date) => (local ? `;TZID=${tz}:${formatLocalDateTime(d, tz)}` : `:${formatUtcDateTime(d)}`);
  const uid = `${ev.uid}@${uidDomain}`;
  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${nowUtcCompact()}`,
  ];

  if (ev.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(ev.start_time, tz)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDateOnly(ev.end_time, tz)}`);
  } else {
    lines.push(`DTSTART${dateTime(ev.start_time)}`);
    lines.push(`DTEND${dateTime(ev.end_time)}`);
  }

  lines.push(`SUMMARY:${escapeText(ev.summary)}`);

  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  if (ev.url) lines.push(`URL:${ev.url}`);

  if (ev.rrule) {
    lines.push(`RRULE:${ev.rrule}`);
    if (ev.exdates && ev.exdates.length > 0) {
      const exdateValues = ev.exdates.map((d) => (local ? formatLocalDateTime(d, tz) : formatUtcDateTime(d))).join(',');
      lines.push(local ? `EXDATE;TZID=${tz}:${exdateValues}` : `EXDATE:${exdateValues}`);
    }
  }

  if (ev.recurrence_id) {
    lines.push(`RECURRENCE-ID${dateTime(ev.recurrence_id)}`);
  }

  lines.push(`STATUS:${ev.status.toUpperCase()}`);
  lines.push('TRANSP:OPAQUE');
  lines.push('END:VEVENT');

  return lines;
}
