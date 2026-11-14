/**
 * Export v2 del calendario (fase F4; design §16.2; contratto
 * docs/calendar-radicale/contracts/f4-modules.md §5.5): fuori da mode
 * postgres gli eventi stanno nel volume Radicale e il backup JSON v1 ne
 * contiene solo la fotografia legacy. L'export v2 è uno zip con
 *
 *   manifest.json                     CalendarExportManifest (identità del
 *                                     volume, epoch, collezioni con conteggi
 *                                     e sha256 dei file);
 *   collections/<collection_name>.ics un VCALENDAR per collezione Radicale
 *                                     del sidecar, con i componenti di ogni
 *                                     risorsa indicizzata (testo dell'ultima
 *                                     versione buona) e i VTIMEZONE una volta
 *                                     sola per TZID.
 *
 * Le iscrizioni non visibili ai device (dati di terzi mai esposti) e le
 * collezioni non attive restano fuori e sono elencate in `skipped`. Lo zip si
 * scrive senza dipendenze (entry deflate di node:zlib, CRC32 calcolato qui):
 * leggibile da qualunque strumento standard. Nessun dato personale nei log.
 */

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import type { Db } from './radicale/policy';
import type { BackendMode, CalendarRole } from './radicale/types';
import type { CalendarExportManifest } from './migration/types';

// ─── Zip (PKWARE APPNOTE, senza ZIP64: export di pochi MB) ─────────────────

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) di un buffer. */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Data e ora DOS (risoluzione di 2 secondi) in UTC. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: ((d.getUTCHours() & 0x1f) << 11) | ((d.getUTCMinutes() & 0x3f) << 5) | (Math.floor(d.getUTCSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getUTCMonth() + 1) & 0x0f) << 5) | (d.getUTCDate() & 0x1f),
  };
}

export interface ZipEntry {
  /** Percorso nello zip (separatore '/', UTF-8). */
  name: string;
  data: Buffer;
}

/** Limite dello zip senza ZIP64: 0xFFFF entry, 4 GiB per entry e in totale. */
const ZIP32_MAX = 0xffffffff;

/**
 * Zip in memoria: entry deflate (stored se la compressione non conviene),
 * nomi UTF-8 (bit 11), directory centrale. Lancia RangeError oltre i limiti
 * dello zip a 32 bit.
 */
export function buildZip(entries: readonly ZipEntry[], opts: { now?: Date } = {}): Buffer {
  if (entries.length > 0xffff) throw new RangeError('troppi file per uno zip senza ZIP64');
  const { time, date } = dosDateTime(opts.now ?? new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    if (entry.data.length > ZIP32_MAX || payload.length > ZIP32_MAX || offset > ZIP32_MAX) throw new RangeError('export troppo grande per uno zip senza ZIP64');
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versione necessaria
    local.writeUInt16LE(0x0800, 6); // nomi UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // creato da: Unix, versione 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // commento
    central.writeUInt16LE(0, 34); // disco
    central.writeUInt16LE(0, 36); // attributi interni
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // attributi esterni: file normale 0644
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ─── iCalendar ───────────────────────────────

const CRLF = '\r\n';

/** Righe logiche (RFC 5545 §3.1) con le righe fisiche originali: una continuazione inizia con spazio o tab. */
function physicalLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.length > 0);
}

interface ComponentBlock {
  name: string;
  /** Righe fisiche del blocco (piegature comprese), da BEGIN a END. */
  lines: string[];
  /** Valore di TZID (solo VTIMEZONE). */
  tzid: string | null;
}

/** Componenti di primo livello di un VCALENDAR (VEVENT, VTODO, VJOURNAL, VTIMEZONE…), senza interpretarli. */
export function topLevelComponents(ics: string): ComponentBlock[] {
  const lines = physicalLines(ics);
  const out: ComponentBlock[] = [];
  let depth = 0;
  let current: ComponentBlock | null = null;
  for (const line of lines) {
    const continuation = line.startsWith(' ') || line.startsWith('\t');
    const upper = continuation ? '' : line.toUpperCase();
    if (upper.startsWith('BEGIN:')) {
      depth += 1;
      if (depth === 2) current = { name: upper.slice(6).trim(), lines: [], tzid: null };
    }
    if (current && depth >= 2) current.lines.push(line);
    if (current && depth === 2 && current.name === 'VTIMEZONE' && upper.startsWith('TZID')) {
      const colon = line.indexOf(':');
      current.tzid = colon >= 0 ? line.slice(colon + 1).trim() : null;
    }
    if (upper.startsWith('END:')) {
      if (depth === 2 && current) {
        out.push(current);
        current = null;
      }
      depth = Math.max(0, depth - 1);
    }
  }
  return out;
}

function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

/** Piega una riga a 75 ottetti (RFC 5545 §3.1) senza spezzare i caratteri UTF-8. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (size + n > limit) {
      parts.push(current);
      current = '';
      size = 0;
      limit = 74; // la continuazione inizia con uno spazio
    }
    current += ch;
    size += n;
  }
  if (current) parts.push(current);
  return parts.join(`${CRLF} `);
}

/**
 * VCALENDAR di una collezione: VTIMEZONE deduplicati per TZID (il primo
 * incontrato), poi i componenti di ogni risorsa nell'ordine dato.
 */
export function collectionIcs(calendarName: string, objects: readonly string[]): string {
  const timezones = new Map<string, ComponentBlock>();
  const components: ComponentBlock[] = [];
  for (const raw of objects) {
    for (const c of topLevelComponents(raw)) {
      if (c.name === 'VTIMEZONE') {
        const key = c.tzid ?? `#${timezones.size}`;
        if (!timezones.has(key)) timezones.set(key, c);
      } else {
        components.push(c);
      }
    }
  }
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Calicchia Design//Export calendario v2//IT',
    'CALSCALE:GREGORIAN',
    fold(`X-WR-CALNAME:${escapeText(calendarName)}`),
    ...[...timezones.values()].flatMap((c) => c.lines),
    ...components.flatMap((c) => c.lines),
    'END:VCALENDAR',
  ];
  return lines.join(CRLF) + CRLF;
}

// ─── Export ───────────────────────────────

interface ExportCalendarRow {
  id: string;
  name: string;
  collection_name: string | null;
  role: CalendarRole;
  origin: string;
  lifecycle: string;
  device_visible: boolean;
}

/** Testo dell'ultima versione buona di ogni risorsa indicizzata di una collezione, ordinato per href. */
async function collectionObjects(db: Db, calendarId: string): Promise<string[]> {
  const rows = await db<Array<{ href: string; raw: string | null }>>`
    SELECT o.href,
           CASE WHEN o.health = 'ok' AND o.raw_ics IS NOT NULL THEN o.raw_ics
                ELSE COALESCE(
                  (SELECT v.raw_ics FROM cal_object_versions v
                   WHERE v.object_id = o.id AND v.valid AND v.raw_ics IS NOT NULL
                   ORDER BY v.created_at DESC LIMIT 1),
                  o.raw_ics)
           END AS raw
    FROM cal_objects o
    WHERE o.calendar_id = ${calendarId}::uuid
    ORDER BY o.href
  `;
  return rows.map((r) => r.raw).filter((r): r is string => typeof r === 'string' && r.length > 0);
}

export interface CalendarExportV2 {
  zip: Buffer;
  manifest: CalendarExportManifest;
  filename: string;
}

/**
 * Costruisce lo zip dell'export v2 (nessuna scrittura). Il chiamante decide
 * se è ammesso (fuori da mode postgres) e registra l'audit.
 */
export async function buildCalendarExportV2(
  db: Db,
  opts: { now?: Date; principal: string; state: { mode: BackendMode; volume_id: string | null; epoch: number } },
): Promise<CalendarExportV2> {
  const now = opts.now ?? new Date();
  const calendars = await db<ExportCalendarRow[]>`
    SELECT id::text AS id, name, collection_name, role, origin, lifecycle, device_visible
    FROM calendars
    ORDER BY collection_name NULLS LAST, id
  `;
  const manifest: CalendarExportManifest = {
    format: 'caldes-calendar-export',
    version: 2,
    generated_at: now.toISOString(),
    backend_mode: opts.state.mode,
    volume_id: opts.state.volume_id,
    epoch: opts.state.epoch,
    principal: opts.principal,
    collections: [],
    skipped: [],
  };
  const entries: ZipEntry[] = [];
  for (const cal of calendars) {
    if (!cal.collection_name) {
      manifest.skipped.push({ calendar_id: cal.id, collection_name: null, reason: 'calendario senza collezione Radicale' });
      continue;
    }
    if (cal.lifecycle !== 'active') {
      manifest.skipped.push({ calendar_id: cal.id, collection_name: cal.collection_name, reason: `collezione non attiva (${cal.lifecycle})` });
      continue;
    }
    if (cal.role === 'subscription' && !cal.device_visible) {
      manifest.skipped.push({ calendar_id: cal.id, collection_name: cal.collection_name, reason: 'iscrizione non visibile ai device' });
      continue;
    }
    const objects = await collectionObjects(db, cal.id);
    const text = collectionIcs(cal.name, objects);
    const data = Buffer.from(text, 'utf8');
    const file = `collections/${cal.collection_name}.ics`;
    entries.push({ name: file, data });
    manifest.collections.push({
      calendar_id: cal.id,
      collection_name: cal.collection_name,
      name: cal.name,
      role: cal.role,
      file,
      objects: objects.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  entries.unshift({ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') });
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return { zip: buildZip(entries, { now }), manifest, filename: `caldes-calendario-v2-${stamp}.zip` };
}
