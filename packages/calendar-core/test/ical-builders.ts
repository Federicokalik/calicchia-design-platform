/**
 * Costruttori dei casi inline per i test di espansione, abbinamento degli
 * override e operazioni sulle ricorrenze (expand, override-match,
 * recurrence-ops, parità con il legacy).
 */

import { type CalendarObject, getProperty, parseCalendarObjectOrThrow } from '../src/index';
import { ianaZone, utcToZoned, zonedToUtc } from '../src/tz-registry';

export const ROME = 'Europe/Rome';
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Testo iCalendar (CRLF) di un VCALENDAR con i componenti dati (ognuno come righe, BEGIN/END compresi). */
export function vcalendar(...components: string[][]): string {
  return `${['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Caldes//test//IT', ...components.flat(), 'END:VCALENDAR'].join('\r\n')}\r\n`;
}

/** VEVENT con UID e DTSTAMP di default e le proprietà date. */
export function vevent(props: string[], uid = 'serie@caldes.test'): string[] {
  const has = (name: string): boolean => props.some((p) => p.toUpperCase().startsWith(`${name}:`) || p.toUpperCase().startsWith(`${name};`));
  return [
    'BEGIN:VEVENT',
    ...(has('UID') ? [] : [`UID:${uid}`]),
    ...(has('DTSTAMP') ? [] : ['DTSTAMP:20261001T080000Z']),
    ...props,
    'END:VEVENT',
  ];
}

/** Oggetto calendario da uno o più VEVENT (master e override con lo stesso UID). */
export function objectOf(...events: string[][]): CalendarObject {
  return parseCalendarObjectOrThrow(vcalendar(...events));
}

/** Oggetto da un testo iCalendar completo. */
export function objectFromText(text: string): CalendarObject {
  return parseCalendarObjectOrThrow(text);
}

/** Istante (ms UTC) di un'ora da muro 'YYYY-MM-DD' 'HH:MM[:SS]' nel fuso dato (RFC 5545 per buchi e ambiguità). */
export function wallMs(date: string, time = '00:00', tz = ROME): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  return zonedToUtc({ year, month, day, hour, minute, second }, ianaZone(tz));
}

/** ISO UTC di un istante. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Ora da muro 'YYYY-MM-DD HH:MM' di un istante nel fuso dato. */
export function localOf(ms: number, tz = ROME): string {
  const w = utcToZoned(ms, ianaZone(tz));
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`;
}

/** Valore grezzo di una proprietà del master (o undefined). */
export function masterValue(obj: CalendarObject, name: string): string | undefined {
  return obj.master ? getProperty(obj.master, name)?.value : undefined;
}

/** Riga (nome;parametri:valore) di una proprietà di un componente, per confronti leggibili. */
export function propLine(c: { properties: Array<{ name: string; params: Array<{ name: string; values: string[] }>; value: string }> }, name: string): string | undefined {
  const p = c.properties.find((x) => x.name === name);
  if (!p) return undefined;
  const params = p.params.map((x) => `;${x.name}=${x.values.join(',')}`).join('');
  return `${p.name}${params}:${p.value}`;
}
