/**
 * Modello → testo iCalendar canonico.
 *
 * Forma canonica (deterministica a parità di modello):
 * - righe terminate da CRLF, anche l'ultima; folding a 75 ottetti UTF-8 senza
 *   spezzare i code point (ics-text.foldLine);
 * - nomi di proprietà, parametri e componenti in maiuscolo; valori dei
 *   parametri fra virgolette solo se contengono ':', ';' o ','; VALUE in
 *   maiuscolo; valori delle proprietà scritti così come sono nel modello;
 * - VCALENDAR: VERSION:2.0, poi PRODID (stabile, CALDES_PRODID, senza numero
 *   di versione: aggiornare il pacchetto non cambia gli ETag), poi le altre
 *   proprietà del calendario nell'ordine del modello;
 * - VTIMEZONE in testa, ordinati per TZID. Con `timezones: 'canonical'`
 *   (default) uno per ogni TZID referenziato: il VTIMEZONE canonico del
 *   registro per i TZID IANA, quello dell'oggetto per gli altri (nomi
 *   Windows, VTIMEZONE personalizzati), nessuno per i TZID sconosciuti;
 *   quelli non referenziati spariscono. Con 'preserve' restano quelli del
 *   modello, tali e quali;
 * - oggetto calendario: master, poi override in ordine di recurrence key,
 *   poi gli altri componenti.
 *
 * Errori: SerializeError tipizzati (nomi non validi, a capo in un valore,
 * virgolette in un parametro). Nessun altro tipo di eccezione.
 */

import { SerializeError, toCoreError } from './errors';
import { appendAll, collectTzidRefs, componentLines, contentLine, CRLF, foldLine, vtimezoneTzid } from './ics-text';
import { type CalendarObject, componentRecurrenceKey, type IcsComponent, type IcsProperty, objectComponents } from './model';
import { canonicalVtimezone, DEFAULT_TZ, findVtimezone, isIanaTzid, resolveTzid } from './tz-registry';

export { foldLine } from './ics-text';

/** PRODID stabile dei testi scritti dal pacchetto. */
export const CALDES_PRODID = '-//Caldes//calendar-core//IT';

export interface SerializeOptions {
  /** PRODID del VCALENDAR: default CALDES_PRODID; 'preserve' tiene quello del modello (o il default se manca). */
  prodid?: string | 'preserve';
  /** VTIMEZONE: 'canonical' (default) o 'preserve' (quelli del modello, tali e quali). */
  timezones?: 'canonical' | 'preserve';
}

function lines(parts: string[]): string {
  return parts.map(foldLine).join(CRLF) + CRLF;
}

/** Una riga di contenuto piegata, senza CRLF finale. */
export function serializeProperty(prop: IcsProperty): string {
  try {
    return foldLine(contentLine(prop));
  } catch (err) {
    throw toCoreError(err, 'serializeProperty');
  }
}

/** Un componente (BEGIN...END) con righe piegate e CRLF finale, senza VCALENDAR intorno. */
export function serializeComponent(comp: IcsComponent): string {
  try {
    return lines(componentLines(comp, []));
  } catch (err) {
    throw toCoreError(err, 'serializeComponent');
  }
}

/**
 * VTIMEZONE da scrivere per i componenti dati, secondo la regola canonica:
 * per ogni TZID referenziato (in ordine) il canonico del registro se il TZID è
 * IANA, altrimenti quello di `existing` con lo stesso TZID, altrimenti, per i
 * nomi Windows e le etichette di offset mappati su IANA, il canonico della
 * zona mappata con quel TZID. I TZID sconosciuti non producono VTIMEZONE.
 */
export function canonicalTimezonesFor(components: readonly IcsComponent[], existing: readonly IcsComponent[] = []): IcsComponent[] {
  const out: IcsComponent[] = [];
  for (const tzid of collectTzidRefs(components)) {
    const res = resolveTzid(tzid, existing);
    const own = findVtimezone(existing, tzid);
    if (res.kind === 'iana' && isIanaTzid(res)) {
      const canonical = canonicalVtimezone(res.iana, tzid);
      if (canonical) out.push(canonical);
      else if (own) out.push(own);
    } else if (own) {
      out.push(own);
    } else if (res.kind === 'iana') {
      const mapped = canonicalVtimezone(res.iana, tzid);
      if (mapped) out.push(mapped);
    }
  }
  return out;
}

function calendarHeader(properties: readonly IcsProperty[], opts: SerializeOptions): IcsProperty[] {
  const existingProdid = properties.find((p) => p.name.toUpperCase() === 'PRODID');
  const prodid =
    opts.prodid === 'preserve'
      ? existingProdid ?? { name: 'PRODID', params: [], value: CALDES_PRODID }
      : { name: 'PRODID', params: [], value: opts.prodid ?? CALDES_PRODID };
  const rest = properties.filter((p) => {
    const n = p.name.toUpperCase();
    return n !== 'VERSION' && n !== 'PRODID';
  });
  return [{ name: 'VERSION', params: [], value: '2.0' }, prodid, ...rest];
}

function sortTimezones(tzs: IcsComponent[]): IcsComponent[] {
  return [...tzs].sort((a, b) => {
    const ta = vtimezoneTzid(a) ?? '';
    const tb = vtimezoneTzid(b) ?? '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
}

function writeCalendar(header: IcsProperty[], timezones: IcsComponent[], body: IcsComponent[]): string {
  const out: string[] = ['BEGIN:VCALENDAR'];
  const wrapper: IcsComponent = { name: 'VCALENDAR', properties: header, components: [] };
  const headerLines = componentLines(wrapper, []);
  appendAll(out, headerLines.slice(1, -1));
  for (const tz of timezones) componentLines(tz, out);
  for (const c of body) componentLines(c, out);
  out.push('END:VCALENDAR');
  return lines(out);
}

/**
 * VCALENDAR grezzo (feed, import, più UID) → testo canonico. I componenti non
 * VTIMEZONE restano nell'ordine del modello.
 */
export function serializeCalendar(cal: IcsComponent, opts: SerializeOptions = {}): string {
  try {
    if (cal.name.toUpperCase() !== 'VCALENDAR') {
      throw new SerializeError('INVALID_OBJECT', `Radice ${cal.name} al posto di VCALENDAR`);
    }
    const existingTz = cal.components.filter((c) => c.name.toUpperCase() === 'VTIMEZONE');
    const body = cal.components.filter((c) => c.name.toUpperCase() !== 'VTIMEZONE');
    const tzs = opts.timezones === 'preserve' ? existingTz : sortTimezones(canonicalTimezonesFor(body, existingTz));
    return writeCalendar(calendarHeader(cal.properties, opts), tzs, body);
  } catch (err) {
    throw toCoreError(err, 'serializeCalendar');
  }
}

/** Override ordinati per recurrence key (stabile; chiave illeggibile → valore grezzo, in coda a parità). */
function sortedOverrides(obj: CalendarObject): IcsComponent[] {
  const ctx = { tz: DEFAULT_TZ, timezones: obj.timezones };
  const keyed = obj.overrides.map((c, i) => {
    let key: string;
    try {
      key = componentRecurrenceKey(c, ctx);
    } catch {
      key = `~${c.properties.find((p) => p.name.toUpperCase() === 'RECURRENCE-ID')?.value ?? ''}`;
    }
    return { c, i, key };
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i));
  return keyed.map((k) => k.c);
}

/** Oggetto calendario → testo canonico della risorsa CalDAV. */
export function serializeObject(obj: CalendarObject, opts: SerializeOptions = {}): string {
  try {
    if (!obj.master && obj.overrides.length === 0) {
      throw new SerializeError('INVALID_OBJECT', `Oggetto ${obj.uid.slice(0, 60)} senza componenti`, { uid: obj.uid.slice(0, 60) });
    }
    const body = [...(obj.master ? [obj.master] : []), ...sortedOverrides(obj), ...obj.otherComponents];
    const tzs =
      opts.timezones === 'preserve'
        ? obj.timezones
        : sortTimezones(canonicalTimezonesFor([...objectComponents(obj), ...obj.otherComponents], obj.timezones));
    return writeCalendar(calendarHeader(obj.calendarProperties, opts), tzs, body);
  } catch (err) {
    throw toCoreError(err, 'serializeObject');
  }
}
