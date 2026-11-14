/**
 * XML WebDAV/CalDAV per il client di servizio verso Radicale (fase F1, piano
 * T6): un parser con namespace ridotto a ciò che Radicale produce, il modello
 * del multistatus (RFC 4918 §13) e i costruttori dei corpi delle richieste.
 *
 * Nessuna dipendenza esterna. Il parser è volutamente rigido: rifiuta DOCTYPE
 * (quindi nessuna entità definita dal documento, niente espansioni), entità
 * sconosciute, prefissi non dichiarati, tag non bilanciati e annidamenti oltre
 * MAX_XML_DEPTH. Le risposte arrivano da Radicale sulla rete interna, ma una
 * risposta malformata deve diventare un errore esplicito, mai un dato
 * interpretato a metà. Il limite di dimensione lo applica il trasporto.
 */

/** Namespace usati da CalDAV, dalle estensioni Apple/CalendarServer e dalle dead prop del progetto. */
export const NS = Object.freeze({
  DAV: 'DAV:',
  CALDAV: 'urn:ietf:params:xml:ns:caldav',
  CALSERVER: 'http://calendarserver.org/ns/',
  APPLE_ICAL: 'http://apple.com/ns/ical/',
  /** Dead prop dell'applicazione (identità del volume, calendar-id, role): contratto control-plane §4. */
  CALDES: 'urn:calicchia:caldes',
});

/** Massimo annidamento accettato nelle risposte (Radicale arriva a 6-7 livelli). */
export const MAX_XML_DEPTH = 64;

/** Elemento XML con namespace risolto. */
export interface XmlElement {
  /** URI del namespace ('' se assente). */
  ns: string;
  /** Nome locale, senza prefisso. */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Testo diretto (CDATA compreso), entità decodificate, non trimmato. */
  text: string;
}

/** Errore di parsing XML (il client lo trasforma in RadicaleProtocolError). */
export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXmlEntities(text: string): string {
  return text.replace(/&([^;\s&]{0,32});/g, (_match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        throw new XmlParseError(`riferimento a carattere non valido: &${entity};`);
      }
      return String.fromCodePoint(code);
    }
    const value = XML_ENTITIES[entity];
    if (value === undefined) throw new XmlParseError(`entità XML sconosciuta: &${entity};`);
    return value;
  });
}

// Caratteri ammessi in XML 1.0 (§2.2): tab, LF, CR e da U+0020 in su, esclusi
// i surrogati isolati e U+FFFE/U+FFFF.
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Escape per testo e attributi XML. Lancia TypeError per i caratteri che XML
 * 1.0 non ammette (es. U+0001): Radicale rifiuterebbe il corpo con un 400.
 */
export function escapeXml(text: string): string {
  if (XML_FORBIDDEN_CHARS_RE.test(text)) throw new TypeError('testo con caratteri non ammessi in XML 1.0');
  return text.replace(/[<>&"']/g, (ch) => `&${({ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' } as const)[ch as '<']};`);
}

/**
 * Parser XML per le risposte di Radicale: elementi, attributi, namespace
 * (default e con prefisso, con scope), testo, CDATA, entità predefinite e
 * riferimenti numerici. Ignora dichiarazione, commenti e PI; rifiuta DOCTYPE.
 * Lancia XmlParseError.
 */
export function parseXml(input: string): XmlElement {
  const text = input.replace(/^﻿/, '');
  // Sticky: ogni token deve iniziare dove finisce il precedente, così un '<'
  // malformato fa fallire il parse invece di essere saltato.
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(DOCTYPE)|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
  const attrPattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  interface Frame { el: XmlElement; qname: string; scope: Map<string, string> }
  const stack: Frame[] = [];
  let root: XmlElement | null = null;

  const resolveName = (qname: string, scope: Map<string, string>, isAttr: boolean): { ns: string; name: string } => {
    const colon = qname.indexOf(':');
    if (colon < 0) return { ns: isAttr ? '' : scope.get('') ?? '', name: qname };
    const prefix = qname.slice(0, colon);
    const local = qname.slice(colon + 1);
    if (!local) throw new XmlParseError(`nome XML non valido: "${qname}"`);
    if (prefix === 'xml') return { ns: 'http://www.w3.org/XML/1998/namespace', name: local };
    const ns = scope.get(prefix);
    if (ns === undefined) throw new XmlParseError(`prefisso XML non dichiarato: "${prefix}"`);
    return { ns, name: local };
  };

  while (token.lastIndex < text.length) {
    const position = token.lastIndex;
    const match = token.exec(text);
    if (!match) throw new XmlParseError(`XML non valido alla posizione ${position}`);
    const [, cdata, doctype, closing, qname, rawAttrs, selfClosing, chars] = match;
    if (doctype) throw new XmlParseError('DOCTYPE non ammesso nelle risposte');
    if (chars !== undefined || cdata !== undefined) {
      const top = stack[stack.length - 1];
      const value = cdata !== undefined ? cdata : decodeXmlEntities(chars);
      if (top) top.el.text += value;
      else if (value.trim()) throw new XmlParseError("testo fuori dall'elemento radice");
      continue;
    }
    if (!qname) continue; // commento o PI
    if (closing) {
      const top = stack.pop();
      if (!top || top.qname !== qname) throw new XmlParseError(`tag di chiusura inatteso </${qname}>`);
      continue;
    }

    const parentScope = stack[stack.length - 1]?.scope ?? new Map<string, string>();
    const scope = new Map(parentScope);
    const rawPairs: Array<[string, string]> = [];
    attrPattern.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = attrPattern.exec(rawAttrs ?? '')) !== null) {
      const value = decodeXmlEntities(attr[2] ?? attr[3] ?? '');
      if (attr[1] === 'xmlns') scope.set('', value);
      else if (attr[1].startsWith('xmlns:')) scope.set(attr[1].slice(6), value);
      else rawPairs.push([attr[1], value]);
    }
    const { ns, name } = resolveName(qname, scope, false);
    const attrs: Record<string, string> = {};
    for (const [key, value] of rawPairs) attrs[resolveName(key, scope, true).name] = value;

    const el: XmlElement = { ns, name, attrs, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) parent.el.children.push(el);
    else if (root) throw new XmlParseError('più di un elemento radice');
    else root = el;
    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) throw new XmlParseError(`annidamento oltre ${MAX_XML_DEPTH} livelli`);
      stack.push({ el, qname, scope });
    }
  }
  if (stack.length) throw new XmlParseError(`elemento <${stack[stack.length - 1].qname}> non chiuso`);
  if (!root) throw new XmlParseError('documento XML vuoto');
  return root;
}

/** Primo figlio con namespace e nome dati. */
export function xmlChild(el: XmlElement, ns: string, name: string): XmlElement | undefined {
  return el.children.find((c) => c.ns === ns && c.name === name);
}

/** Tutti i figli con namespace e nome dati. */
export function xmlChildren(el: XmlElement, ns: string, name: string): XmlElement[] {
  return el.children.filter((c) => c.ns === ns && c.name === name);
}

/** Testo di un elemento e dei discendenti, concatenato. */
export function xmlText(el: XmlElement): string {
  return el.text + el.children.map(xmlText).join('');
}

// ─── Proprietà ───────────────────────────────

/** Nome di una proprietà WebDAV. */
export interface DavPropName {
  ns: string;
  name: string;
}

/**
 * Proprietà da impostare: `value` è testo (con escape), `xml` è contenuto XML
 * grezzo già costruito dal chiamante (es. i `<comp>` di
 * supported-calendar-component-set).
 */
export interface DavPropValue extends DavPropName {
  value?: string;
  xml?: string;
}

/** Proprietà usate dal client. */
export const DAV_PROPS = Object.freeze({
  displayname: { ns: NS.DAV, name: 'displayname' },
  resourcetype: { ns: NS.DAV, name: 'resourcetype' },
  getetag: { ns: NS.DAV, name: 'getetag' },
  getcontenttype: { ns: NS.DAV, name: 'getcontenttype' },
  syncToken: { ns: NS.DAV, name: 'sync-token' },
  currentUserPrincipal: { ns: NS.DAV, name: 'current-user-principal' },
  calendarDescription: { ns: NS.CALDAV, name: 'calendar-description' },
  calendarTimezone: { ns: NS.CALDAV, name: 'calendar-timezone' },
  supportedComponents: { ns: NS.CALDAV, name: 'supported-calendar-component-set' },
  calendarData: { ns: NS.CALDAV, name: 'calendar-data' },
  calendarColor: { ns: NS.APPLE_ICAL, name: 'calendar-color' },
  calendarOrder: { ns: NS.APPLE_ICAL, name: 'calendar-order' },
  getctag: { ns: NS.CALSERVER, name: 'getctag' },
  /** Dead prop sul principal: UUID del volume (contratto §4.1). */
  volumeId: { ns: NS.CALDES, name: 'volume-id' },
  /** Dead prop sul principal: epoch del volume (contratto §4.1). */
  volumeEpoch: { ns: NS.CALDES, name: 'epoch' },
  /** Dead prop di collezione: calendars.id (contratto §4.5). */
  calendarId: { ns: NS.CALDES, name: 'calendar-id' },
  /** Dead prop di collezione: calendars.role (contratto §4.5). */
  role: { ns: NS.CALDES, name: 'role' },
} satisfies Record<string, DavPropName>);

/** Chiave `{ns}name` di una proprietà (notazione di Clark, come in `.Radicale.props`). */
export function clark(prop: DavPropName): string {
  return `{${prop.ns}}${prop.name}`;
}

/** `{ns}name` → nome della proprietà (null se non è in notazione di Clark). */
export function parseClark(key: string): DavPropName | null {
  const match = /^\{([^}]*)\}(.+)$/.exec(key);
  return match ? { ns: match[1], name: match[2] } : null;
}

const XML_NAME_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** Elemento di una proprietà con il proprio namespace di default (vuoto o con valore). */
export function propElement(prop: DavPropName | DavPropValue, withValue = false): string {
  if (!XML_NAME_RE.test(prop.name)) throw new TypeError(`nome di proprietà non valido: ${JSON.stringify(prop.name)}`);
  const open = `<${prop.name} xmlns="${escapeXml(prop.ns)}"`;
  if (!withValue) return `${open}/>`;
  const { value, xml } = prop as DavPropValue;
  const inner = xml ?? (value !== undefined ? escapeXml(value) : '');
  return inner ? `${open}>${inner}</${prop.name}>` : `${open}/>`;
}

export const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';

// ─── Multistatus ───────────────────────────────

/** Status di una riga `HTTP/1.1 404 Not Found` (null se illeggibile). */
export function statusLineCode(line: string | undefined): number | null {
  const match = line ? /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line) : null;
  return match ? Number(match[1]) : null;
}

/** Una `<propstat>`: status e proprietà riportate. */
export interface DavPropstat {
  status: number | null;
  props: XmlElement[];
}

function safeDecode(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** Un `<response>` di un multistatus. */
export class DavResponseEntry {
  constructor(
    /** href come restituito dal server (percent-encoded, percorso assoluto). */
    readonly href: string,
    /** `<status>` diretto della response (es. 404 per gli eliminati in sync-collection), altrimenti null. */
    readonly status: number | null,
    readonly propstats: readonly DavPropstat[],
  ) {}

  /** href decodificato. */
  get path(): string {
    return safeDecode(this.href);
  }

  /** Ultimo segmento dell'href, decodificato (nome dell'oggetto o della collezione). */
  get name(): string {
    const segments = this.path.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
  }

  /** Elemento della proprietà con status 200 (undefined se assente o con altro status). */
  element(prop: DavPropName): XmlElement | undefined {
    for (const ps of this.propstats) {
      if (ps.status !== 200) continue;
      const el = ps.props.find((p) => p.ns === prop.ns && p.name === prop.name);
      if (el) return el;
    }
    return undefined;
  }

  /** Testo della proprietà con status 200 (null se assente o con altro status). Non trimmato. */
  text(prop: DavPropName): string | null {
    const el = this.element(prop);
    return el ? xmlText(el) : null;
  }

  /** Status della propstat che contiene la proprietà (null se non riportata). */
  statusOf(prop: DavPropName): number | null {
    for (const ps of this.propstats) {
      if (ps.props.some((p) => p.ns === prop.ns && p.name === prop.name)) return ps.status;
    }
    return null;
  }

  /** Proprietà con status 200 come record `{ns}nome` → testo (le dead prop sono stringhe). */
  textProps(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const ps of this.propstats) {
      if (ps.status !== 200) continue;
      for (const p of ps.props) out[clark(p)] = xmlText(p);
    }
    return out;
  }
}

/** Risposta 207 Multi-Status. */
export class Multistatus {
  constructor(
    readonly responses: readonly DavResponseEntry[],
    /** `<sync-token>` di primo livello (sync-collection), altrimenti null. */
    readonly syncToken: string | null,
  ) {}

  /** Lancia XmlParseError se il corpo non è un `<D:multistatus>` ben formato. */
  static parse(text: string): Multistatus {
    const root = parseXml(text);
    if (root.ns !== NS.DAV || root.name !== 'multistatus') {
      throw new XmlParseError(`atteso <D:multistatus>, ricevuto <${root.name}> (${root.ns})`);
    }
    const responses = xmlChildren(root, NS.DAV, 'response').map((r) => {
      const href = xmlChild(r, NS.DAV, 'href');
      if (!href) throw new XmlParseError('<D:response> senza <D:href>');
      const status = xmlChild(r, NS.DAV, 'status');
      const propstats = xmlChildren(r, NS.DAV, 'propstat').map((ps) => ({
        status: statusLineCode(xmlChild(ps, NS.DAV, 'status')?.text),
        props: xmlChild(ps, NS.DAV, 'prop')?.children ?? [],
      }));
      return new DavResponseEntry(xmlText(href).trim(), status ? statusLineCode(xmlText(status)) : null, propstats);
    });
    const token = xmlChild(root, NS.DAV, 'sync-token');
    return new Multistatus(responses, token ? xmlText(token).trim() : null);
  }

  /** Response per href o percorso (confronto sulla forma decodificata). */
  find(pathOrHref: string): DavResponseEntry | undefined {
    const target = safeDecode(pathOrHref);
    return this.responses.find((r) => r.path === target);
  }
}

/**
 * Condizione di un corpo `<D:error>` (RFC 4918 §16): il primo figlio, es.
 * `{urn:ietf:params:xml:ns:caldav}no-uid-conflict` o `{DAV:}valid-sync-token`.
 * null se il corpo è vuoto, non è XML o non è un `<D:error>`.
 */
export function parseDavErrorCondition(text: string): DavPropName | null {
  if (!text.trim()) return null;
  try {
    const root = parseXml(text);
    if (root.ns !== NS.DAV || root.name !== 'error') return null;
    const first = root.children[0];
    return first ? { ns: first.ns, name: first.name } : null;
  } catch {
    return null;
  }
}
