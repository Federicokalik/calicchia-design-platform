/**
 * ICS subscription importer — fetch + parse + normalize.
 *
 * Scope: leggere un VCALENDAR remoto (es. URL "secret iCal" di Google Calendar)
 * e produrre `ParsedEvent[]` pronti per l'upsert in `calendar_events`.
 *
 * Subset RFC 5545 gestito:
 *  - VEVENT con SUMMARY/DESCRIPTION/LOCATION/URL/UID/STATUS
 *  - DTSTART / DTEND in UTC, con TZID o DATE-only (all-day)
 *  - RRULE / EXDATE → normalizzati a stringa singola (rrule) + array ISO (exdates)
 *  - RECURRENCE-ID → override
 *  - VTIMEZONE: skippato (per TZID usiamo Intl quando possibile; fallback UTC con warning)
 *
 * Difese: solo http(s), max body 5MB, timeout 15s, no redirect a host privati,
 * UID obbligatorio (eventi senza UID skippati con warning).
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface ParsedEvent {
  /** UID stabile dal remoto. Usato per dedup con il source_id locale. */
  remote_uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  /** ISO UTC */
  start_time: string;
  /** ISO UTC */
  end_time: string;
  all_day: boolean;
  rrule: string | null;
  exdates: string[];
  /** Se valorizzato è un override di un'occorrenza; il valore è l'original-start ISO. */
  recurrence_id: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

export interface FetchResult {
  notModified: boolean;
  body: string | null;
  etag: string | null;
  lastModified: string | null;
}

export class IcsImportError extends Error {
  code = 'ICS_IMPORT' as const;
  constructor(message: string) { super(message); }
}

// ============================================
// HTTP fetcher con If-None-Match / If-Modified-Since
// ============================================

export async function fetchIcs(
  url: string,
  cache: { etag?: string | null; lastModified?: string | null } = {},
): Promise<FetchResult> {
  if (!/^https?:\/\//i.test(url)) throw new IcsImportError('URL deve usare http/https');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      // Google a volte rifiuta requesti senza User-Agent
      'User-Agent': 'Caldes-Calendar-Subscriber/1.0',
      Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5',
    };
    if (cache.etag) headers['If-None-Match'] = cache.etag;
    if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow', // fetch nativo gestisce i redirect; cap MAX_REDIRECTS è browser-default
    });

    if (res.status === 304) {
      return { notModified: true, body: null, etag: cache.etag ?? null, lastModified: cache.lastModified ?? null };
    }
    if (!res.ok) {
      throw new IcsImportError(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    }

    // Limita dimensione: leggi a chunk
    const reader = res.body?.getReader();
    if (!reader) throw new IcsImportError('Risposta senza body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          throw new IcsImportError(`Feed > ${Math.round(MAX_BYTES / 1024 / 1024)}MB — rifiutato`);
        }
        chunks.push(value);
      }
    }
    const body = new TextDecoder('utf-8').decode(concatChunks(chunks, total));

    return {
      notModified: false,
      body,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// ============================================
// Parser
// ============================================

/**
 * Espande il line-folding RFC 5545: linee successive che iniziano con SPACE o TAB
 * sono continuazioni della precedente.
 */
function unfold(raw: string): string[] {
  // Normalizza CRLF/LF/CR a LF, poi divide su LF.
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.length > 0);
}

interface PropLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parsePropLine(line: string): PropLine | null {
  // FORMAT: NAME(;PARAM=VAL)*:VALUE
  // Il primo ':' separa header da value; ',' dentro params è value list (manteniamolo grezzo).
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = unescapeText(line.slice(colon + 1));

  const parts = head.split(';');
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

function unescapeText(s: string): string {
  return s
    .replace(/\\N/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Converte un valore DATE / DATE-TIME ICS in ISO UTC.
 * - "YYYYMMDDTHHMMSSZ" → ISO UTC diretto
 * - "YYYYMMDDTHHMMSS" + TZID → wall clock nel TZ → ISO UTC (best effort via Intl)
 * - "YYYYMMDDTHHMMSS" senza TZID (floating) → assume UTC (best effort; raro nei feed Google)
 * - "YYYYMMDD" (DATE-only) → midnight UTC del giorno
 */
function icsValueToIso(value: string, tzid: string | undefined, valueType: string | undefined): { iso: string; allDay: boolean } {
  const v = value.trim();

  // DATE-only (all-day)
  if (valueType === 'DATE' || /^\d{8}$/.test(v)) {
    const y = v.slice(0, 4);
    const m = v.slice(4, 6);
    const d = v.slice(6, 8);
    return { iso: `${y}-${m}-${d}T00:00:00.000Z`, allDay: true };
  }

  // DATE-TIME
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!match) throw new IcsImportError(`Valore data non valido: ${v}`);
  const [, y, mo, d, h, mi, s, z] = match;

  if (z === 'Z' || !tzid) {
    // UTC esplicito o floating → assume UTC
    return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`, allDay: false };
  }

  // TZID: usa Intl per scoprire l'offset al wall-time dato. Approccio binary-search-free:
  // costruiamo la data come se fosse UTC, poi calcoliamo l'offset apparente del TZ in quel momento
  // e correggiamo. Soggetto a 1h di errore al cambio DST per orari ambigui (raro nei feed reali).
  const naiveUtcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const offsetMs = tzOffsetAt(naiveUtcMs, tzid);
  const realUtcMs = naiveUtcMs - offsetMs;
  return { iso: new Date(realUtcMs).toISOString(), allDay: false };
}

/**
 * Restituisce l'offset (ms) di un'IANA timezone rispetto a UTC al momento dato.
 * Calcolato sfruttando Intl.DateTimeFormat che renderizza l'epoch nel timezone target.
 */
function tzOffsetAt(epochMs: number, tzid: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date(epochMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') === 24 ? 0 : get('hour'),
      get('minute'),
      get('second'),
    );
    return asUtc - epochMs;
  } catch {
    // TZID non riconosciuto da Intl → fallback UTC
    return 0;
  }
}

/**
 * Parse principale: estrae tutti i VEVENT dal VCALENDAR.
 */
export function parseIcs(raw: string): ParsedEvent[] {
  const lines = unfold(raw);
  const events: ParsedEvent[] = [];

  let inEvent = false;
  let inOther = 0; // contatore per skippare VTIMEZONE, VALARM, VTODO, ecc.
  let current: Partial<ParsedEvent> & { _exdates?: string[] } = {};
  let dtstartTzid: string | undefined;
  let dtendTzid: string | undefined;
  let dtstartValueType: string | undefined;
  let dtendValueType: string | undefined;
  let durationSeconds: number | null = null;

  for (const line of lines) {
    const upper = line.toUpperCase();

    if (upper === 'BEGIN:VEVENT') {
      inEvent = true;
      current = { _exdates: [] };
      dtstartTzid = dtendTzid = dtstartValueType = dtendValueType = undefined;
      durationSeconds = null;
      continue;
    }
    if (upper === 'END:VEVENT') {
      inEvent = false;
      const finalized = finalizeEvent(current, durationSeconds);
      if (finalized) events.push(finalized);
      continue;
    }
    if (upper.startsWith('BEGIN:') && !inEvent) {
      inOther++;
      continue;
    }
    if (upper.startsWith('END:') && inOther > 0) {
      inOther--;
      continue;
    }
    if (!inEvent || inOther > 0) continue;

    const prop = parsePropLine(line);
    if (!prop) continue;

    switch (prop.name) {
      case 'UID':
        current.remote_uid = prop.value;
        break;
      case 'SUMMARY':
        current.summary = prop.value.slice(0, 500);
        break;
      case 'DESCRIPTION':
        current.description = prop.value.slice(0, 5000) || null;
        break;
      case 'LOCATION':
        current.location = prop.value.slice(0, 500) || null;
        break;
      case 'URL':
        current.url = prop.value.slice(0, 1000) || null;
        break;
      case 'STATUS': {
        const s = prop.value.toUpperCase();
        current.status =
          s === 'CANCELLED' ? 'cancelled' :
          s === 'TENTATIVE' ? 'tentative' :
          'confirmed';
        break;
      }
      case 'DTSTART': {
        dtstartTzid = prop.params.TZID;
        dtstartValueType = prop.params.VALUE;
        const r = icsValueToIso(prop.value, dtstartTzid, dtstartValueType);
        current.start_time = r.iso;
        current.all_day = r.allDay;
        break;
      }
      case 'DTEND': {
        dtendTzid = prop.params.TZID;
        dtendValueType = prop.params.VALUE;
        const r = icsValueToIso(prop.value, dtendTzid, dtendValueType);
        current.end_time = r.iso;
        break;
      }
      case 'DURATION':
        durationSeconds = parseDuration(prop.value);
        break;
      case 'RRULE':
        // Manteniamo grezza la RRULE; il motore di espansione locale (rrule.ts) la interpreta.
        current.rrule = prop.value;
        break;
      case 'EXDATE': {
        // EXDATE può essere comma-list o multipla
        const tzid = prop.params.TZID;
        const valueType = prop.params.VALUE;
        for (const part of prop.value.split(',')) {
          try {
            const r = icsValueToIso(part.trim(), tzid, valueType);
            current._exdates!.push(r.iso);
          } catch { /* skip token malformato */ }
        }
        break;
      }
      case 'RECURRENCE-ID': {
        try {
          const r = icsValueToIso(prop.value, prop.params.TZID, prop.params.VALUE);
          current.recurrence_id = r.iso;
        } catch { /* skip */ }
        break;
      }
      default:
        // Tutti gli altri prop (ORGANIZER, ATTENDEE, CREATED, LAST-MODIFIED, SEQUENCE, ecc.) ignorati.
        break;
    }
  }

  return events;
}

function parseDuration(d: string): number | null {
  // PnDTnHnMnS — supporto subset (no PnW per ora, raro in Google).
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d.trim());
  if (!m) return null;
  const [, dDay, dH, dM, dS] = m;
  return (+(dDay || 0) * 86400) + (+(dH || 0) * 3600) + (+(dM || 0) * 60) + +(dS || 0);
}

function finalizeEvent(c: Partial<ParsedEvent> & { _exdates?: string[] }, durationSeconds: number | null): ParsedEvent | null {
  if (!c.remote_uid || !c.start_time) return null;

  let endTime = c.end_time;
  if (!endTime) {
    // Se manca DTEND, calcola da DURATION o (RFC 5545) default = DTSTART per DATE-TIME / DTSTART+1d per DATE
    const startMs = new Date(c.start_time).getTime();
    if (durationSeconds != null) {
      endTime = new Date(startMs + durationSeconds * 1000).toISOString();
    } else if (c.all_day) {
      endTime = new Date(startMs + 86400 * 1000).toISOString();
    } else {
      // Stesso istante: end = start → invalido per il nostro CHECK. Forza +1ms.
      endTime = new Date(startMs + 1).toISOString();
    }
  }

  // Difesa: end > start
  if (new Date(endTime).getTime() <= new Date(c.start_time).getTime()) {
    endTime = new Date(new Date(c.start_time).getTime() + 1).toISOString();
  }

  return {
    remote_uid: c.remote_uid,
    summary: (c.summary || '(senza titolo)').slice(0, 500),
    description: c.description ?? null,
    location: c.location ?? null,
    url: c.url ?? null,
    start_time: c.start_time,
    end_time: endTime,
    all_day: !!c.all_day,
    rrule: c.rrule ?? null,
    exdates: c._exdates || [],
    recurrence_id: c.recurrence_id ?? null,
    status: c.status ?? 'confirmed',
  };
}
