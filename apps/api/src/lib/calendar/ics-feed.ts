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

function formatUtcDateTime(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function formatDateOnly(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10).replace(/-/g, '');
}

function nowUtcCompact(): string {
  return formatUtcDateTime(new Date().toISOString());
}

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
].join(CRLF);

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
    VTIMEZONE_EUROPE_ROME,
  ];

  for (const ev of opts.events) {
    if (ev.status === 'cancelled') continue;
    lines.push(...buildVEvent(ev, uidDomain));
  }

  lines.push('END:VCALENDAR');

  return lines
    .filter(Boolean)
    .map((l) => fold(l))
    .join(CRLF) + CRLF;
}

function buildVEvent(ev: CalendarEvent, uidDomain: string): string[] {
  const uid = `${ev.uid}@${uidDomain}`;
  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${nowUtcCompact()}`,
  ];

  if (ev.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(ev.start_time)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDateOnly(ev.end_time)}`);
  } else {
    lines.push(`DTSTART:${formatUtcDateTime(ev.start_time)}`);
    lines.push(`DTEND:${formatUtcDateTime(ev.end_time)}`);
  }

  lines.push(`SUMMARY:${escapeText(ev.summary)}`);

  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  if (ev.url) lines.push(`URL:${ev.url}`);

  if (ev.rrule) {
    lines.push(`RRULE:${ev.rrule}`);
    if (ev.exdates && ev.exdates.length > 0) {
      const exdateValues = ev.exdates.map((d) => formatUtcDateTime(d)).join(',');
      lines.push(`EXDATE:${exdateValues}`);
    }
  }

  if (ev.recurrence_id) {
    lines.push(`RECURRENCE-ID:${formatUtcDateTime(ev.recurrence_id)}`);
  }

  lines.push(`STATUS:${ev.status.toUpperCase()}`);
  lines.push('TRANSP:OPAQUE');
  lines.push('END:VEVENT');

  return lines;
}
