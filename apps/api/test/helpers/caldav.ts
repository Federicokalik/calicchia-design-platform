/**
 * Client CalDAV minimale per i test, con parser XML del multistatus e utilità
 * iCalendar (fase F0 del passaggio del calendario a Radicale: harness del
 * piano, docs/calendar-radicale/piano.md F0 attività 6).
 *
 * Nessuna dipendenza esterna né dall'ambiente dei test: fetch (o node:http
 * quando serve scegliere l'indirizzo sorgente), un parser XML ridotto a ciò
 * che Radicale produce, e un parser delle righe iCalendar. Si usa tramite
 * helpers/radicale.ts, che lo riesporta insieme al server di prova.
 */

import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';

/** Namespace XML usati da CalDAV, dalle estensioni Apple/CalendarServer e dalle dead prop del progetto. */
export const NS = Object.freeze({
  DAV: 'DAV:',
  CALDAV: 'urn:ietf:params:xml:ns:caldav',
  CALSERVER: 'http://calendarserver.org/ns/',
  APPLE_ICAL: 'http://apple.com/ns/ical/',
  RADICALE: 'http://radicale.org/ns/',
  /** Dead prop del progetto (identità del volume, ruolo della collezione): design §3.3 e §3.4. */
  CALDES: 'urn:calicchia:caldes',
});

// ─── XML minimale (risposte WebDAV) ───────────────────────────────

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

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

/** Escape per testo e attributi XML. */
export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => `&${({ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' } as const)[ch as '<']};`);
}

/**
 * Parser XML minimale per le risposte di Radicale: elementi, attributi,
 * namespace (default e con prefisso, con scope), testo, CDATA, entità.
 * Ignora dichiarazione, commenti, PI e DOCTYPE. Lancia su tag non bilanciati.
 */
export function parseXml(input: string): XmlElement {
  const text = input.replace(/^\uFEFF/, '');
  // Sticky: ogni token deve iniziare dove finisce il precedente, così un '<'
  // malformato fa fallire il parse invece di essere saltato in silenzio.
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
  const attrPattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  interface Frame { el: XmlElement; qname: string; scope: Map<string, string> }
  const stack: Frame[] = [];
  let root: XmlElement | null = null;
  let match: RegExpExecArray | null;

  const resolveName = (qname: string, scope: Map<string, string>, isAttr: boolean): { ns: string; name: string } => {
    const colon = qname.indexOf(':');
    if (colon < 0) return { ns: isAttr ? '' : scope.get('') ?? '', name: qname };
    const prefix = qname.slice(0, colon);
    if (prefix === 'xml') return { ns: 'http://www.w3.org/XML/1998/namespace', name: qname.slice(colon + 1) };
    const ns = scope.get(prefix);
    if (ns === undefined) throw new Error(`Prefisso XML non dichiarato: "${prefix}"`);
    return { ns, name: qname.slice(colon + 1) };
  };

  while (token.lastIndex < text.length) {
    const position = token.lastIndex;
    match = token.exec(text);
    if (!match) throw new Error(`XML non valido alla posizione ${position}: ${text.slice(position, position + 40)}`);
    const [, cdata, closing, qname, rawAttrs, selfClosing, chars] = match;
    if (chars !== undefined || cdata !== undefined) {
      const top = stack[stack.length - 1];
      const value = cdata !== undefined ? cdata : decodeXmlEntities(chars);
      if (top) top.el.text += value;
      else if (value.trim()) throw new Error('Testo fuori dall\'elemento radice');
      continue;
    }
    if (!qname) continue; // commento, PI, DOCTYPE
    if (closing) {
      const top = stack.pop();
      if (!top || top.qname !== qname) throw new Error(`Tag di chiusura inatteso </${qname}>`);
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
    else if (root) throw new Error('Più di un elemento radice');
    else root = el;
    if (!selfClosing) stack.push({ el, qname, scope });
  }
  if (stack.length) throw new Error(`Elemento <${stack[stack.length - 1].qname}> non chiuso`);
  if (!root) throw new Error('Documento XML vuoto');
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

// ─── Client CalDAV ───────────────────────────────

/** Nome di una proprietà WebDAV. */
export interface DavPropName {
  ns: string;
  name: string;
}

/**
 * Proprietà da impostare: `value` è testo (con escape), `xml` è contenuto XML
 * grezzo (es. `<comp xmlns="urn:ietf:params:xml:ns:caldav" name="VEVENT"/>`).
 */
export interface DavProp extends DavPropName {
  value?: string;
  xml?: string;
}

/** Proprietà più usate nei test. */
export const DAV_PROPS = Object.freeze({
  displayname: { ns: NS.DAV, name: 'displayname' },
  resourcetype: { ns: NS.DAV, name: 'resourcetype' },
  getetag: { ns: NS.DAV, name: 'getetag' },
  getcontenttype: { ns: NS.DAV, name: 'getcontenttype' },
  syncToken: { ns: NS.DAV, name: 'sync-token' },
  currentUserPrincipal: { ns: NS.DAV, name: 'current-user-principal' },
  calendarHomeSet: { ns: NS.CALDAV, name: 'calendar-home-set' },
  calendarDescription: { ns: NS.CALDAV, name: 'calendar-description' },
  calendarTimezone: { ns: NS.CALDAV, name: 'calendar-timezone' },
  supportedComponents: { ns: NS.CALDAV, name: 'supported-calendar-component-set' },
  calendarData: { ns: NS.CALDAV, name: 'calendar-data' },
  calendarColor: { ns: NS.APPLE_ICAL, name: 'calendar-color' },
  calendarOrder: { ns: NS.APPLE_ICAL, name: 'calendar-order' },
  getctag: { ns: NS.CALSERVER, name: 'getctag' },
} satisfies Record<string, DavPropName>);

/** Chiave `{ns}name` di una proprietà (notazione di Clark). */
export function clark(prop: DavPropName): string {
  return `{${prop.ns}}${prop.name}`;
}

function propElement(prop: DavProp | DavPropName, withValue: boolean): string {
  const open = `<${prop.name} xmlns="${escapeXml(prop.ns)}"`;
  if (!withValue) return `${open}/>`;
  const { value, xml } = prop as DavProp;
  const inner = xml ?? (value !== undefined ? escapeXml(value) : '');
  return inner ? `${open}>${inner}</${prop.name}>` : `${open}/>`;
}

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';

/** Data in formato CalDAV UTC (20270104T080000Z) per time-range ed expand. */
export function toCalDavUtc(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new Error(`Data non valida: ${String(value)}`);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Percorso di una collezione o di un oggetto con i segmenti codificati: davPath('federico', 'lavoro') → /federico/lavoro/. */
export function davPath(...segments: string[]): string {
  if (!segments.length) return '/';
  const encoded = segments.map((s) => encodeURIComponent(s));
  const last = segments[segments.length - 1];
  return `/${encoded.join('/')}${/\.(ics|vcf)$/i.test(last) ? '' : '/'}`;
}

/** Header Authorization Basic. */
export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function statusCode(line: string | undefined): number | null {
  const match = line ? /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line) : null;
  return match ? Number(match[1]) : null;
}

/** Un `<response>` di un multistatus. */
export class DavResponseEntry {
  constructor(
    /** href come restituito dal server (percent-encoded). */
    readonly href: string,
    /** `<status>` diretto della response (es. 404 per gli eliminati in sync-collection), altrimenti null. */
    readonly status: number | null,
    readonly propstats: ReadonlyArray<{ status: number | null; props: XmlElement[] }>,
  ) {}

  /** href decodificato, per confronti con i percorsi creati dai test. */
  get path(): string {
    return safeDecode(this.href);
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

  /** Testo della proprietà con status 200 (null se assente o con altro status). */
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
}

function safeDecode(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** Risposta 207 Multi-Status. */
export class Multistatus {
  constructor(
    readonly responses: DavResponseEntry[],
    /** `<sync-token>` di primo livello (sync-collection), altrimenti null. */
    readonly syncToken: string | null,
  ) {}

  static parse(text: string): Multistatus {
    const root = parseXml(text);
    if (root.ns !== NS.DAV || root.name !== 'multistatus') {
      throw new Error(`Atteso <D:multistatus>, ricevuto <${root.name}> (${root.ns})`);
    }
    const responses = xmlChildren(root, NS.DAV, 'response').map((r) => {
      const href = xmlChild(r, NS.DAV, 'href');
      const status = xmlChild(r, NS.DAV, 'status');
      const propstats = xmlChildren(r, NS.DAV, 'propstat').map((ps) => ({
        status: statusCode(xmlChild(ps, NS.DAV, 'status')?.text),
        props: xmlChild(ps, NS.DAV, 'prop')?.children ?? [],
      }));
      return new DavResponseEntry(href ? xmlText(href).trim() : '', status ? statusCode(status.text) : null, propstats);
    });
    const token = xmlChild(root, NS.DAV, 'sync-token');
    return new Multistatus(responses, token ? xmlText(token).trim() : null);
  }

  /** Response per href o percorso (confronto sulla forma decodificata). */
  find(pathOrHref: string): DavResponseEntry | undefined {
    const target = safeDecode(pathOrHref);
    return this.responses.find((r) => r.path === target);
  }

  /** Percorsi decodificati, ordinati (utile per confronti deterministici). */
  paths(): string[] {
    return this.responses.map((r) => r.path).sort();
  }
}

/** Risposta HTTP del client CalDAV. */
export class DavResponse {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly headers: Headers,
    readonly text: string,
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /** ETag della risposta (con le virgolette, come va rimandato in If-Match). */
  get etag(): string | null {
    return this.headers.get('etag');
  }

  /** Multistatus della risposta; lancia se lo status non è 207. */
  multistatus(): Multistatus {
    if (this.status !== 207) {
      throw new Error(`${this.method} ${this.url}: atteso 207, ricevuto ${this.status}\n${this.text.slice(0, 500)}`);
    }
    return Multistatus.parse(this.text);
  }

  /** Corpo come XML (es. l'errore di precondizione di un 403/409). */
  xml(): XmlElement {
    return parseXml(this.text);
  }

  /** Descrizione breve per i messaggi delle asserzioni. */
  describe(): string {
    return `${this.method} ${this.url} → ${this.status}\n${this.text.slice(0, 800)}`;
  }
}

export interface DavRequestOptions {
  body?: string;
  contentType?: string;
  depth?: 0 | 1 | 'infinity';
  headers?: Record<string, string>;
  /** Timeout della richiesta (default 15 s). */
  timeoutMs?: number;
}

export interface CalendarQueryOptions {
  /** Inizio e fine del time-range (UTC); senza, nessun filtro temporale. */
  start?: Date | string;
  end?: Date | string;
  /** Espansione delle ricorrenze lato server (CALDAV:expand) nell'intervallo dato o in quello del filtro. */
  expand?: boolean | { start: Date | string; end: Date | string };
  /** Componente filtrato (default VEVENT). */
  component?: string;
  /** Proprietà oltre a getetag e calendar-data. */
  props?: DavPropName[];
}

/** Oggetto di calendario letto con calendar-query o calendar-multiget. */
export interface CalendarObject {
  href: string;
  path: string;
  etag: string | null;
  data: string | null;
}

export interface CalDavClientOptions {
  /** Header aggiunti a ogni richiesta. */
  headers?: Record<string, string>;
  /**
   * Indirizzo sorgente della connessione TCP (es. 127.0.0.2): Radicale lo vede
   * come REMOTE_ADDR, cioè il peer da cui caldes_auth riconosce gli utenti di
   * servizio (design §3.3). Su Linux tutto 127.0.0.0/8 è loopback, quindi
   * bastano indirizzi diversi per simulare "rete interna" e "gateway" senza
   * Docker (vedi canBindLocalAddress). Con questa opzione le richieste passano
   * da node:http invece che da fetch, che non permette di sceglierlo.
   */
  localAddress?: string;
}

/**
 * Verifica che il sistema permetta connessioni dall'indirizzo locale dato
 * (es. 127.0.0.2 su Linux sì, su macOS solo dopo un alias di lo0).
 */
export async function canBindLocalAddress(address: string): Promise<boolean> {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once('error', () => resolveBind(false));
    server.listen(0, address, () => server.close(() => resolveBind(true)));
  });
}

/**
 * Client CalDAV minimale per i test, su fetch. Non segue redirect, non
 * riprova e non interpreta gli errori: restituisce sempre la risposta, così i
 * test possono asserire anche 403, 404, 409 e 412.
 */
export class CalDavClient {
  private readonly defaultHeaders: Record<string, string>;
  private readonly localAddress: string | undefined;

  constructor(
    readonly baseUrl: string,
    readonly credentials: { username: string; password: string } | null,
    opts: CalDavClientOptions = {},
  ) {
    this.defaultHeaders = { ...(opts.headers ?? {}) };
    this.localAddress = opts.localAddress;
  }

  private copy(credentials: CalDavClient['credentials'], opts: CalDavClientOptions): CalDavClient {
    return new CalDavClient(this.baseUrl, credentials, { headers: this.defaultHeaders, localAddress: this.localAddress, ...opts });
  }

  /** Copia del client con altre credenziali. */
  as(username: string, password: string): CalDavClient {
    return this.copy({ username, password }, {});
  }

  /** Copia del client con header aggiunti a ogni richiesta (es. X-Remote-Addr, User-Agent). */
  withHeaders(headers: Record<string, string>): CalDavClient {
    return this.copy(this.credentials, { headers: { ...this.defaultHeaders, ...headers } });
  }

  /** Copia del client che si connette dall'indirizzo locale dato (peer TCP visto da Radicale). */
  fromAddress(localAddress: string): CalDavClient {
    return this.copy(this.credentials, { localAddress });
  }

  url(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async request(method: string, path: string, opts: DavRequestOptions = {}): Promise<DavResponse> {
    const headers: Record<string, string> = { ...this.defaultHeaders, ...(opts.headers ?? {}) };
    if (this.credentials) headers.Authorization = basicAuth(this.credentials.username, this.credentials.password);
    if (opts.depth !== undefined) headers.Depth = String(opts.depth);
    if (opts.body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/xml; charset=utf-8';
    const url = this.url(path);
    const timeoutMs = opts.timeoutMs ?? 15_000;
    if (this.localAddress) return this.requestFrom(this.localAddress, method, url, headers, opts.body, timeoutMs);
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return new DavResponse(method, url, res.status, res.headers, await res.text());
  }

  /** Stessa richiesta via node:http con indirizzo sorgente scelto. */
  private requestFrom(
    localAddress: string,
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<DavResponse> {
    const target = new URL(url);
    if (target.protocol !== 'http:') throw new Error('localAddress è supportato solo per URL http://');
    const payload = body !== undefined ? Buffer.from(body, 'utf8') : undefined;
    return new Promise((resolveResponse, reject) => {
      const req = httpRequest(
        {
          host: target.hostname,
          port: target.port || 80,
          path: `${target.pathname}${target.search}`,
          method,
          localAddress,
          headers: { ...headers, ...(payload ? { 'Content-Length': String(payload.length) } : {}) },
        },
        (res) => {
          res.setEncoding('utf8');
          let text = '';
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
            }
            resolveResponse(new DavResponse(method, url, res.statusCode ?? 0, responseHeaders, text));
          });
          res.on('error', reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout di ${timeoutMs} ms`)));
      req.on('error', reject);
      req.end(payload);
    });
  }

  options(path = '/'): Promise<DavResponse> {
    return this.request('OPTIONS', path);
  }

  get(path: string, headers: Record<string, string> = {}): Promise<DavResponse> {
    return this.request('GET', path, { headers });
  }

  /**
   * PUT di una risorsa iCalendar. `ifNoneMatch: '*'` crea solo se assente;
   * `ifMatch` aggiorna solo se l'ETag corrisponde.
   */
  put(path: string, ics: string, opts: { ifMatch?: string; ifNoneMatch?: string; headers?: Record<string, string> } = {}): Promise<DavResponse> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
    return this.request('PUT', path, { body: ics, contentType: 'text/calendar; charset=utf-8', headers });
  }

  delete(path: string, opts: { ifMatch?: string } = {}): Promise<DavResponse> {
    return this.request('DELETE', path, { headers: opts.ifMatch ? { 'If-Match': opts.ifMatch } : {} });
  }

  /** PROPFIND: senza `props` chiede allprop. */
  propfind(path: string, opts: { props?: DavPropName[]; depth?: 0 | 1 } = {}): Promise<DavResponse> {
    const inner = opts.props ? `<prop>${opts.props.map((p) => propElement(p, false)).join('')}</prop>` : '<allprop/>';
    return this.request('PROPFIND', path, {
      depth: opts.depth ?? 0,
      body: `${XML_DECL}<propfind xmlns="DAV:">${inner}</propfind>`,
    });
  }

  proppatch(path: string, opts: { set?: DavProp[]; remove?: DavPropName[] }): Promise<DavResponse> {
    const set = opts.set?.length ? `<set><prop>${opts.set.map((p) => propElement(p, true)).join('')}</prop></set>` : '';
    const remove = opts.remove?.length ? `<remove><prop>${opts.remove.map((p) => propElement(p, false)).join('')}</prop></remove>` : '';
    return this.request('PROPPATCH', path, { body: `${XML_DECL}<propertyupdate xmlns="DAV:">${set}${remove}</propertyupdate>` });
  }

  /** MKCOL esteso (RFC 5689): con `props` imposta anche le proprietà della collezione. */
  mkcol(path: string, opts: { props?: DavProp[] } = {}): Promise<DavResponse> {
    if (!opts.props?.length) return this.request('MKCOL', path);
    const props = opts.props.map((p) => propElement(p, true)).join('');
    return this.request('MKCOL', path, {
      body: `${XML_DECL}<D:mkcol xmlns:D="DAV:"><D:set><D:prop><D:resourcetype><D:collection/></D:resourcetype>${props}</D:prop></D:set></D:mkcol>`,
    });
  }

  /** MKCALENDAR con le proprietà più comuni (nome, colore, descrizione, fuso, componenti). */
  mkcalendar(
    path: string,
    opts: { displayName?: string; color?: string; description?: string; timezone?: string; components?: string[]; props?: DavProp[] } = {},
  ): Promise<DavResponse> {
    const props: DavProp[] = [];
    if (opts.displayName !== undefined) props.push({ ...DAV_PROPS.displayname, value: opts.displayName });
    if (opts.color !== undefined) props.push({ ...DAV_PROPS.calendarColor, value: opts.color });
    if (opts.description !== undefined) props.push({ ...DAV_PROPS.calendarDescription, value: opts.description });
    if (opts.timezone !== undefined) props.push({ ...DAV_PROPS.calendarTimezone, value: opts.timezone });
    if (opts.components?.length) {
      props.push({
        ...DAV_PROPS.supportedComponents,
        xml: opts.components.map((c) => `<comp xmlns="${NS.CALDAV}" name="${escapeXml(c)}"/>`).join(''),
      });
    }
    props.push(...(opts.props ?? []));
    const body = props.length
      ? `${XML_DECL}<C:mkcalendar xmlns:C="${NS.CALDAV}" xmlns:D="DAV:"><D:set><D:prop>${props.map((p) => propElement(p, true)).join('')}</D:prop></D:set></C:mkcalendar>`
      : undefined;
    return this.request('MKCALENDAR', path, { body });
  }

  /** REPORT calendar-query (Depth 1) con time-range ed expand opzionali. */
  calendarQuery(path: string, opts: CalendarQueryOptions = {}): Promise<DavResponse> {
    const range = opts.start || opts.end
      ? `<C:time-range${opts.start ? ` start="${toCalDavUtc(opts.start)}"` : ''}${opts.end ? ` end="${toCalDavUtc(opts.end)}"` : ''}/>`
      : '';
    let expand = '';
    if (opts.expand) {
      const window = opts.expand === true ? { start: opts.start, end: opts.end } : opts.expand;
      if (!window.start || !window.end) throw new Error('expand richiede start ed end (nel filtro o espliciti)');
      expand = `<C:expand start="${toCalDavUtc(window.start)}" end="${toCalDavUtc(window.end)}"/>`;
    }
    const extra = (opts.props ?? []).map((p) => propElement(p, false)).join('');
    const component = escapeXml(opts.component ?? 'VEVENT');
    const body = `${XML_DECL}<C:calendar-query xmlns:D="DAV:" xmlns:C="${NS.CALDAV}">`
      + `<D:prop><D:getetag/><C:calendar-data>${expand}</C:calendar-data>${extra}</D:prop>`
      + `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${component}">${range}</C:comp-filter></C:comp-filter></C:filter>`
      + '</C:calendar-query>';
    return this.request('REPORT', path, { depth: 1, body });
  }

  /** REPORT calendar-multiget per href. */
  calendarMultiget(path: string, hrefs: string[], opts: { expand?: { start: Date | string; end: Date | string } } = {}): Promise<DavResponse> {
    const expand = opts.expand ? `<C:expand start="${toCalDavUtc(opts.expand.start)}" end="${toCalDavUtc(opts.expand.end)}"/>` : '';
    const body = `${XML_DECL}<C:calendar-multiget xmlns:D="DAV:" xmlns:C="${NS.CALDAV}">`
      + `<D:prop><D:getetag/><C:calendar-data>${expand}</C:calendar-data></D:prop>`
      + hrefs.map((h) => `<D:href>${escapeXml(h)}</D:href>`).join('')
      + '</C:calendar-multiget>';
    return this.request('REPORT', path, { depth: 1, body });
  }

  /**
   * REPORT sync-collection (RFC 6578). `syncToken` null o vuoto: sync iniziale.
   * Gli oggetti eliminati tornano come response con status 404 e senza propstat.
   */
  syncCollection(path: string, opts: { syncToken?: string | null; props?: DavPropName[]; limit?: number } = {}): Promise<DavResponse> {
    const props = (opts.props ?? [DAV_PROPS.getetag]).map((p) => propElement(p, false)).join('');
    const limit = opts.limit !== undefined ? `<D:limit><D:nresults>${opts.limit}</D:nresults></D:limit>` : '';
    const body = `${XML_DECL}<D:sync-collection xmlns:D="DAV:">`
      + `<D:sync-token>${escapeXml(opts.syncToken ?? '')}</D:sync-token><D:sync-level>1</D:sync-level>${limit}`
      + `<D:prop>${props}</D:prop></D:sync-collection>`;
    return this.request('REPORT', path, { body });
  }

  /** Oggetti di un REPORT calendar-query/multiget (lancia se non 207). */
  static objects(res: DavResponse): CalendarObject[] {
    return res.multistatus().responses.map((r) => ({
      href: r.href,
      path: r.path,
      etag: r.text(DAV_PROPS.getetag),
      data: r.text(DAV_PROPS.calendarData),
    }));
  }
}

// ─── iCalendar per i test ───────────────────────────────

/** Proprietà iCalendar: nome maiuscolo, parametri (chiave maiuscola, valore senza virgolette) e valore grezzo. */
export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
  /** Riga logica originale (dopo l'unfold). */
  raw: string;
}

export interface IcsComponent {
  name: string;
  properties: IcsProperty[];
  components: IcsComponent[];
}

/** Righe logiche di un testo iCalendar (unfold RFC 5545 §3.1, righe vuote scartate). */
export function unfoldIcs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Piega una riga logica a 75 ottetti senza spezzare i caratteri UTF-8 (RFC 5545 §3.1). */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Non tagliare dentro una sequenza UTF-8 (byte di continuazione 10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // lo spazio iniziale della continuazione conta come ottetto
  }
  return parts.join('\r\n ');
}

/** Testo iCalendar da righe logiche: piegatura a 75 ottetti e CRLF, con CRLF finale. */
export function icsText(lines: string[]): string {
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === separator && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Una riga logica come proprietà (nome;PARAM=valore:valore). */
export function parseIcsLine(line: string): IcsProperty {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) throw new Error(`Riga iCalendar senza ':': ${line}`);
  const [name, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const eq = raw.indexOf('=');
    const key = (eq < 0 ? raw : raw.slice(0, eq)).toUpperCase();
    params[key] = eq < 0 ? '' : raw.slice(eq + 1).replace(/^"(.*)"$/, '$1');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1), raw: line };
}

/** Albero dei componenti di un testo iCalendar (radice: di norma VCALENDAR). */
export function parseIcsTree(text: string): IcsComponent {
  const stack: IcsComponent[] = [];
  let root: IcsComponent | null = null;
  for (const line of unfoldIcs(text)) {
    const prop = parseIcsLine(line);
    if (prop.name === 'BEGIN') {
      const comp: IcsComponent = { name: prop.value.toUpperCase(), properties: [], components: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.components.push(comp);
      else if (root) throw new Error('Più di un componente radice');
      else root = comp;
      stack.push(comp);
    } else if (prop.name === 'END') {
      const top = stack.pop();
      if (!top || top.name !== prop.value.toUpperCase()) throw new Error(`END:${prop.value} inatteso`);
    } else {
      const top = stack[stack.length - 1];
      if (!top) throw new Error(`Proprietà fuori da un componente: ${line}`);
      top.properties.push(prop);
    }
  }
  if (stack.length) throw new Error(`Componente ${stack[stack.length - 1].name} non chiuso`);
  if (!root) throw new Error('Nessun componente iCalendar');
  return root;
}

/** Prima proprietà con il nome dato. */
export function icsProp(comp: IcsComponent, name: string): IcsProperty | undefined {
  return comp.properties.find((p) => p.name === name.toUpperCase());
}

/** Tutte le proprietà con il nome dato. */
export function icsProps(comp: IcsComponent, name: string): IcsProperty[] {
  return comp.properties.filter((p) => p.name === name.toUpperCase());
}

/** Sottocomponenti con il nome dato (es. VEVENT, VALARM). */
export function icsComponents(comp: IcsComponent, name: string): IcsComponent[] {
  return comp.components.filter((c) => c.name === name.toUpperCase());
}
