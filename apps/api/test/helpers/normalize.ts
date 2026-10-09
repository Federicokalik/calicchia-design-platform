/**
 * Normalizzazione delle risposte per gli snapshot di contratto.
 *
 * Sostituisce con segnaposto stabili solo ciò che cambia a ogni run, lasciando
 * intatti ordine degli elementi, ordine delle chiavi e campi semantici
 * (start_time, end_time, recurrence_id, exdates, all_day, status, source...):
 *  - UUID ovunque compaiano (anche dentro testi e URL)  → `<id:N>`;
 *  - uid generati (chiavi uid/*_uid, source_id con forma di uid di
 *    prenotazione)                                      → `<uid:N>`;
 *  - token e segreti (ics_feed_token, token, password...) → `<token:N>`;
 *  - timestamp di sistema (created_at, updated_at, cancelled_at...) → `<timestamp>`;
 *  - DTSTAMP, CREATED e LAST-MODIFIED negli ICS.
 *
 * La numerazione segue l'ordine di prima apparizione ed è condivisa da tutte le
 * chiamate dello stesso normalizzatore: due risposte che citano lo stesso
 * calendario mostrano lo stesso `<id:N>`, quindi le relazioni restano visibili
 * nello snapshot. `alias()` dà nomi leggibili a valori noti (es. `<cal:f>`).
 *
 * Uso tipico con gli snapshot nativi di node:test (serializzazione JSON):
 *   const n = createNormalizer();
 *   t.assert.snapshot(n.normalize(res.json));
 * Aggiornamento: `pnpm --filter @calicchia/api test -- --test-update-snapshots`.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_FULL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Forma degli uid di prenotazione (booking.ts: 12 caratteri [0-9a-z]). */
const BOOKING_UID_RE = /^[0-9a-z]{12}$/;

/** Chiavi i cui valori sono timestamp di sistema (NOW() o Date.now()). */
export const DEFAULT_TIMESTAMP_KEYS: readonly string[] = [
  'created_at',
  'updated_at',
  'last_used_at',
  'last_synced_at',
  'cancelled_at',
  'approved_at',
  'revoked_at',
  'sent_at',
  'timestamp',
];

/** Chiavi i cui valori sono uid generati. */
export const DEFAULT_UID_KEYS: readonly string[] = ['uid', 'booking_uid', 'previous_uid', 'rescheduled_from_uid'];

/** Chiavi i cui valori sono token o segreti generati. */
export const DEFAULT_TOKEN_KEYS: readonly string[] = [
  'ics_feed_token',
  'token',
  'token_hash',
  'token_prefix',
  'password',
  'device_token',
  'manage_token',
];

export interface NormalizerOptions {
  /** Chiavi da trattare come timestamp di sistema (sostituiscono le predefinite se indicate). */
  timestampKeys?: readonly string[];
  /** Chiavi da trattare come uid generati. */
  uidKeys?: readonly string[];
  /** Chiavi da trattare come token. */
  tokenKeys?: readonly string[];
  /** Chiavi da rimuovere del tutto dall'output. */
  dropKeys?: readonly string[];
  /** Prefissi dei dati di test da sostituire con `<prefix>` (utile con prefissi casuali). */
  prefixes?: readonly string[];
}

type Kind = 'id' | 'uid' | 'token';

export class SnapshotNormalizer {
  private readonly placeholders = new Map<string, string>();
  private readonly counters: Record<Kind, number> = { id: 0, uid: 0, token: 0 };
  private readonly timestampKeys: Set<string>;
  private readonly uidKeys: Set<string>;
  private readonly tokenKeys: Set<string>;
  private readonly dropKeys: Set<string>;
  private readonly prefixes: string[];

  constructor(opts: NormalizerOptions = {}) {
    this.timestampKeys = new Set(opts.timestampKeys ?? DEFAULT_TIMESTAMP_KEYS);
    this.uidKeys = new Set(opts.uidKeys ?? DEFAULT_UID_KEYS);
    this.tokenKeys = new Set(opts.tokenKeys ?? DEFAULT_TOKEN_KEYS);
    this.dropKeys = new Set(opts.dropKeys ?? []);
    // I più lunghi per primi, così un prefisso non ne spezza un altro.
    this.prefixes = [...(opts.prefixes ?? [])].sort((a, b) => b.length - a.length);
  }

  /** Nome leggibile per un valore noto (id, uid, token): `alias(cal.id, 'cal:f')` → `<cal:f>`. */
  alias(value: string, label: string): this {
    this.placeholders.set(value, `<${label.replace(/^<|>$/g, '')}>`);
    return this;
  }

  /** Segnaposto per un valore, assegnato alla prima apparizione. */
  placeholder(kind: Kind, value: string): string {
    const known = this.placeholders.get(value);
    if (known) return known;
    this.counters[kind] += 1;
    const ph = `<${kind}:${this.counters[kind]}>`;
    this.placeholders.set(value, ph);
    return ph;
  }

  /**
   * Normalizza un valore JSON-compatibile (risposta di API, righe del DB).
   * Le Date diventano ISO; i timestamp di sistema `<timestamp>`.
   */
  normalize<T>(value: T): unknown {
    // Prima passata: registra i valori volatili nell'ordine di apparizione,
    // così anche un uid citato prima dentro un testo (es. la descrizione di una
    // proiezione) e solo dopo come campo riceve lo stesso segnaposto.
    this.collect(value, null);
    return this.replace(value, null);
  }

  /**
   * Normalizza un corpo iCalendar: unfold delle righe (RFC 5545 §3.1), CRLF
   * → LF, DTSTAMP/CREATED/LAST-MODIFIED fissi, UID e valori volatili noti
   * sostituiti come nel JSON (stessi segnaposto). L'ordine delle righe resta.
   */
  normalizeIcs(body: string): string {
    const lines = body.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
    const out: string[] = [];
    for (const line of lines) {
      const sep = line.indexOf(':');
      if (sep < 0) {
        out.push(this.replaceInText(line));
        continue;
      }
      const name = line.slice(0, sep);
      const prop = name.split(';')[0].toUpperCase();
      const value = line.slice(sep + 1);
      if (prop === 'DTSTAMP') {
        out.push(`${name}:<dtstamp>`);
      } else if (prop === 'CREATED' || prop === 'LAST-MODIFIED') {
        out.push(`${name}:<timestamp>`);
      } else if (prop === 'UID') {
        // `<uid>@dominio`: normalizza la parte locale, conserva il dominio.
        const at = value.lastIndexOf('@');
        const local = at > 0 ? value.slice(0, at) : value;
        const domain = at > 0 ? value.slice(at) : '';
        const ph = UUID_FULL_RE.test(local) ? this.placeholder('id', local) : this.placeholder('uid', local);
        out.push(`${name}:${ph}${domain}`);
      } else {
        out.push(`${name}:${this.replaceInText(value)}`);
      }
    }
    // Una sola riga vuota finale al posto del CRLF conclusivo.
    while (out.length && out[out.length - 1] === '') out.pop();
    return `${out.join('\n')}\n`;
  }

  // ─── Interni ───

  private collect(value: unknown, key: string | null): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) this.collect(item, key);
      return;
    }
    if (value instanceof Date) return;
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!this.dropKeys.has(k)) this.collect(v, k);
      }
      return;
    }
    if (typeof value !== 'string' || !value) return;
    if (key && this.timestampKeys.has(key)) return;
    if (key && this.tokenKeys.has(key)) {
      this.placeholder('token', value);
      return;
    }
    if (UUID_FULL_RE.test(value)) {
      this.placeholder('id', value.toLowerCase());
      return;
    }
    if (key && (this.uidKeys.has(key) || (key === 'source_id' && BOOKING_UID_RE.test(value)))) {
      this.placeholder('uid', value);
      return;
    }
    for (const match of value.match(UUID_RE) ?? []) this.placeholder('id', match.toLowerCase());
  }

  private replace(value: unknown, key: string | null): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((item) => this.replace(item, key));
    if (value instanceof Date) {
      return key && this.timestampKeys.has(key) ? '<timestamp>' : value.toISOString();
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!this.dropKeys.has(k)) out[k] = this.replace(v, k);
      }
      return out;
    }
    if (typeof value !== 'string') return value;
    if (key && this.timestampKeys.has(key)) return value ? '<timestamp>' : value;
    const exact = this.placeholders.get(value) ?? this.placeholders.get(value.toLowerCase());
    if (exact) return exact;
    return this.replaceInText(value);
  }

  /** Sostituisce dentro un testo UUID, valori volatili già noti e prefissi di test. */
  private replaceInText(text: string): string {
    let out = text.replace(UUID_RE, (m) => this.placeholder('id', m.toLowerCase()));
    // Valori noti (uid, token) citati in descrizioni, URL e righe ICS; i più
    // lunghi per primi. Gli uid troppo corti non si cercano dentro i testi.
    const known = [...this.placeholders.entries()]
      .filter(([raw]) => raw.length >= 8 && !UUID_FULL_RE.test(raw))
      .sort((a, b) => b[0].length - a[0].length);
    for (const [raw, ph] of known) {
      if (out.includes(raw)) out = out.split(raw).join(ph);
    }
    for (const prefix of this.prefixes) {
      if (out.includes(prefix)) out = out.split(prefix).join('<prefix>');
    }
    return out;
  }
}

/** Nuovo normalizzatore (segnaposto numerati da 1). */
export function createNormalizer(opts?: NormalizerOptions): SnapshotNormalizer {
  return new SnapshotNormalizer(opts);
}

/** Normalizzazione "una tantum" con un normalizzatore nuovo. */
export function normalize<T>(value: T, opts?: NormalizerOptions): unknown {
  return new SnapshotNormalizer(opts).normalize(value);
}
