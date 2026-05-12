/**
 * Generatore .ics RFC 5545.
 *
 * Caratteristiche:
 * - METHOD: REQUEST (creazione/conferma) o CANCEL
 * - VTIMEZONE Europe/Rome esplicito (DST CEST/CET)
 * - Line folding a 75 ottetti
 * - Escaping di virgole, semicolons, backslashes, newlines
 * - VALARM 24h e 30m prima
 * - UID stabile per supportare update da parte dei client mail
 */

import type { Booking, EventType } from './types';

const CRLF = '\r\n';

function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

/**
 * Folding a 75 ottetti come da RFC 5545 §3.1 (continuazione = SP iniziale).
 *
 * Misura in BYTE UTF-8 (non in caratteri) per gestire correttamente accentate
 * italiane (à, è, ì, ò, ù = 2 byte ciascuna) ed emoji (4 byte).
 * Itera per code point Unicode per non spezzare mai char multibyte.
 *
 * Limite: 75 byte la prima riga, 74 byte le continuazioni (1 byte riservato
 * allo SPACE iniziale che marca la continuazione).
 */
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
  if (buf.length > 0) {
    out.push(isFirstLine ? buf : ' ' + buf);
  }
  return out.join(CRLF);
}

function formatUtcDateTime(iso: string): string {
  // 2026-04-26T09:00:00.000Z → 20260426T090000Z
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function nowUtcCompact(): string {
  return formatUtcDateTime(new Date().toISOString());
}

/** VTIMEZONE Europe/Rome con regole DST 2007-onwards (sufficiente per booking entro qualche anno). */
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

export interface IcsBuildOptions {
  booking: Pick<Booking,
    'uid' | 'start_time' | 'end_time' | 'attendee_name' | 'attendee_email' |
    'location_type' | 'location_value' | 'attendee_message'>;
  eventType: Pick<EventType, 'title' | 'description'>;
  organizerName: string;
  organizerEmail: string;
  manageUrl?: string;
  meetingUrl?: string | null;
  /** Sequence number per supportare update successivi (incrementa ad ogni reschedule). */
  sequence?: number;
  /** REQUEST = nuovo/conferma; CANCEL = cancellazione */
  method?: 'REQUEST' | 'CANCEL';
  /** Domain per UID (es. 'caldes.it'). Default: hostname o 'caldes' */
  uidDomain?: string;
}

export function buildIcs(opts: IcsBuildOptions): string {
  const method = opts.method ?? 'REQUEST';
  const sequence = opts.sequence ?? 0;
  const uidDomain = opts.uidDomain || 'caldes.it';
  const uid = `${opts.booking.uid}@${uidDomain}`;

  const status = method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED';

  const description = [
    opts.eventType.description ? opts.eventType.description : '',
    opts.booking.attendee_message ? `\n\nMessaggio: ${opts.booking.attendee_message}` : '',
    opts.meetingUrl ? `\n\nLink meeting: ${opts.meetingUrl}` : '',
    opts.manageUrl ? `\n\nGestisci la prenotazione: ${opts.manageUrl}` : '',
  ].filter(Boolean).join('').trim();

  const locationLine = opts.booking.location_value || (opts.meetingUrl || '');

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Caldes//Booking//IT`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    VTIMEZONE_EUROPE_ROME,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${nowUtcCompact()}`,
    `DTSTART:${formatUtcDateTime(opts.booking.start_time)}`,
    `DTEND:${formatUtcDateTime(opts.booking.end_time)}`,
    `SUMMARY:${escapeText(opts.eventType.title)}`,
    `DESCRIPTION:${escapeText(description)}`,
    locationLine ? `LOCATION:${escapeText(locationLine)}` : '',
    `STATUS:${status}`,
    `ORGANIZER;CN=${escapeText(opts.organizerName)}:mailto:${opts.organizerEmail}`,
    `ATTENDEE;CN=${escapeText(opts.booking.attendee_name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${opts.booking.attendee_email}`,
    method === 'REQUEST' ? 'TRANSP:OPAQUE' : 'TRANSP:TRANSPARENT',
  ];

  if (method === 'REQUEST') {
    lines.push(
      'BEGIN:VALARM',
      'TRIGGER:-PT24H',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText('Promemoria 24h: ' + opts.eventType.title)}`,
      'END:VALARM',
      'BEGIN:VALARM',
      'TRIGGER:-PT30M',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText('Promemoria 30 minuti: ' + opts.eventType.title)}`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines
    .filter(Boolean)
    .map((l) => fold(l))
    .join(CRLF) + CRLF;
}
