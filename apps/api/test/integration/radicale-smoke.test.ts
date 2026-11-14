/**
 * Smoke di integrazione con un Radicale 3.7.8 reale (fase F0, harness del
 * piano: docs/calendar-radicale/piano.md F0 attività 6; design §3 e §15).
 *
 * Verifica che il harness (helpers/radicale.ts, helpers/mock_verify.py)
 * funzioni end-to-end e fissa il comportamento di Radicale su cui F1-F3
 * costruiscono: MKCALENDAR e PROPPATCH (anche le dead prop
 * {urn:calicchia:caldes}), PUT/GET di una serie con TZID Europe/Rome,
 * override, VALARM, ATTENDEE e X-CALDES-*, REPORT time-range ed expand
 * attraverso il cambio dell'ora legale, calendar-multiget, sync-collection
 * iniziale e delta, DELETE con If-Match; poi il contratto del mock di
 * verify-credentials, un plugin di prova che lo usa (principal canonico,
 * X-Forwarded-For, peer TCP da 127.0.0.2, guasti del backend → 500) e uno
 * smoke del plugin caldes_auth di F1 (la suite completa è pytest:
 * apps/radicale/tests/test_auth.py).
 *
 * Altri comportamenti asseriti che il design dà per scontati: ETag forte
 * (sha256), If-None-Match: * e If-Match → 412, DELETE della collezione e
 * MKCALENDAR su una collezione esistente negati con la config di produzione
 * (403 e 409), sync-token invalido → 403 DAV:valid-sync-token, expand con
 * istanze in UTC senza VTIMEZONE, dead prop salvate in .Radicale.props.
 *
 * Gira solo se Radicale è disponibile (RADICALE_BIN, oppure `radicale` nel
 * PATH): altrimenti le suite vengono saltate con il motivo. Con RADICALE_BIN
 * o RADICALE_REQUIRED=1 l'assenza è invece un errore. Ogni suite ha un proprio
 * server con storage in una directory temporanea, cancellata a fine suite;
 * ogni test usa una collezione propria. Nessun dato tocca il database e le
 * date sono fisse nel 2027: l'esito non dipende dal giorno di esecuzione.
 *
 * Limitazioni osservate su Radicale 3.7.8 con vobject 0.9.9 SENZA la patch di
 * fedeltà (caldes_vobject_fix, F1), asserite nella suite "limitazioni":
 *  1. le virgole non escapate nei valori TEXT troncano il valore (SUMMARY
 *     "Pranzo, cena" → "Pranzo"; LOCATION idem); quelle escapate (\,) restano;
 *  2. le X-prop sono trattate come TEXT e, come le proprietà VALUE=URI,
 *     troncate alla prima virgola: X-CALDES-LEGACY-RRULE
 *     "FREQ=WEEKLY;BYDAY=MO,WE,FR" torna come "FREQ=WEEKLY\;BYDAY=MO";
 *     anche senza virgole il ';' di una X-prop diventa '\;' (rilevante per
 *     X-CALDES-LEGACY-RRULE del serializer, design §13.5); CONFERENCE e il
 *     geo: di X-APPLE-STRUCTURED-LOCATION perdono la parte dopo la virgola.
 *     URL e CATEGORIES restano;
 *  3. la risorsa viene riserializzata: ordine di proprietà e parametri
 *     cambiato, virgolette dei CN tolte, righe ripiegate; l'ETag è l'hash del
 *     testo riserializzato, deterministico (stesso contenuto → stesso ETag);
 *  4. una PUT senza DTSTAMP riceve un DTSTAMP con l'ora del server;
 *  5. la sync-collection iniziale (token vuoto) riporta anche gli href
 *     eliminati in passato, con status 404 (tombstone della history), e
 *     ignora DAV:limit/nresults (restituisce tutto, nessun 507);
 *  6. il time-range tratta gli all-day VALUE=DATE come giorni UTC (TZ=UTC
 *     del processo, come il container), non come giorni di Roma (asserito
 *     nel test del time-range della prima suite);
 *  7. validazione in PUT: UID già presente su un altro href → 409
 *     CALDAV:no-uid-conflict; UID diversi nella stessa risorsa → 400;
 *     UNTIL < DTSTART → 400; stima delle occorrenze oltre
 *     max_vevent_rrule_occurrence → 400 (DAILY fino al 2056 rifiutata con il
 *     default 10000, accettata con 50000 della config di produzione);
 *     MINUTELY infinita e override orfano (solo RECURRENCE-ID) accettati.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CalDavClient,
  canBindLocalAddress,
  DAV_PROPS,
  type IcsComponent,
  type IcsProperty,
  icsComponents,
  icsProp,
  icsProps,
  icsText,
  type MockVerifyMode,
  NS,
  parseIcsTree,
  pythonAvailability,
  RADICALE_PINNED_VERSION,
  RADICALE_PLUGINS_DIR,
  radicaleAvailability,
  startRadicale,
  TEST_PRINCIPAL,
  unfoldIcs,
  useMockVerify,
  useRadicale,
  xmlChild,
} from '../helpers/radicale';

const radicale = radicaleAvailability();
const python = pythonAvailability();
const INTEGRATION_DIR = dirname(fileURLToPath(import.meta.url));

/** Prefisso di collezioni e UID di questo file (gli altri dati vivono solo nella directory temporanea). */
const P = 'tst-radicale';

// ─── Fixture iCalendar ───────────────────────────────

/** VTIMEZONE Europe/Rome come lo inviano Apple e Google (regole UE dal 1996). */
const VTIMEZONE_ROME = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Rome',
  'X-LIC-LOCATION:Europe/Rome',
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

const SERIES_UID = `${P}-serie@caldes.test`;

/**
 * Serie del lunedì alle 09:00 di Roma, 13 occorrenze dal 4 gennaio al 29
 * marzo 2027 (attraversa il passaggio all'ora legale del 28 marzo), con:
 * EXDATE il 18 gennaio; override del 11 gennaio spostato a martedì 12 alle
 * 10:00; due VALARM; ORGANIZER e due ATTENDEE; X-CALDES-* senza virgole (con
 * virgole vengono troncate: vedi le limitazioni).
 */
function seriesIcs(): string {
  return icsText([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Calicchia Design//Test harness//IT',
    'CALSCALE:GREGORIAN',
    ...VTIMEZONE_ROME,
    'BEGIN:VEVENT',
    `UID:${SERIES_UID}`,
    'DTSTAMP:20261001T080000Z',
    'CREATED:20261001T080000Z',
    'LAST-MODIFIED:20261001T080000Z',
    'SEQUENCE:0',
    'DTSTART;TZID=Europe/Rome:20270104T090000',
    'DTEND;TZID=Europe/Rome:20270104T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=13',
    'EXDATE;TZID=Europe/Rome:20270118T090000',
    'SUMMARY:Riunione settimanale\\, team',
    'LOCATION:Via Roma 1\\, 03100 Frosinone',
    'DESCRIPTION:Ordine del giorno:\\n1) avanzamento\\; 2) varie',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'CLASS:PUBLIC',
    'CATEGORIES:Lavoro,Cliente',
    'ORGANIZER;CN="Federico Calicchia":mailto:federico@caldes.test',
    'ATTENDEE;CN="Mario Rossi";CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mario.rossi@caldes.test',
    'ATTENDEE;CN="Federico Calicchia";ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:federico@caldes.test',
    'X-CALDES-SOURCE:admin',
    'X-CALDES-LEGACY-ID:7f3a1c2e-0b1d-4e5f-9a8b-1234567890ab',
    'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Promemoria\\, tra 15 minuti',
    'TRIGGER:-PT15M',
    `X-WR-ALARMUID:${P}-alarm-1`,
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:AUDIO',
    'TRIGGER;RELATED=END:PT0S',
    `X-WR-ALARMUID:${P}-alarm-2`,
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',
    `UID:${SERIES_UID}`,
    'DTSTAMP:20261001T090000Z',
    'RECURRENCE-ID;TZID=Europe/Rome:20270111T090000',
    'DTSTART;TZID=Europe/Rome:20270112T100000',
    'DTEND;TZID=Europe/Rome:20270112T110000',
    'SEQUENCE:1',
    'SUMMARY:Riunione spostata a martedì',
    'X-CALDES-SOURCE:admin',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
}

/** Evento singolo (UTC o con TZID) in un VCALENDAR minimo. */
function eventIcs(uid: string, lines: string[]): string {
  return icsText([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Calicchia Design//Test harness//IT',
    ...(lines.some((l) => l.includes('TZID=Europe/Rome')) ? VTIMEZONE_ROME : []),
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T080000Z',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
}

/** Firma confrontabile di una proprietà: nome, parametri ordinati (senza virgolette) e valore. */
function propertySignature(p: IcsProperty): string {
  const params = Object.entries(p.params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  return `${p.name}${params ? `;${params}` : ''}:${p.value}`;
}

/**
 * Firme di un componente: proprietà e sottocomponenti (ciascuno come firma
 * annidata su una riga), ordinate, perché l'ordine non è semantico e
 * Radicale lo cambia (es. STANDARD prima di DAYLIGHT nel VTIMEZONE).
 */
function componentSignatures(c: IcsComponent): string[] {
  return [
    ...c.properties.map(propertySignature),
    ...c.components.map((child) => `BEGIN:${child.name} { ${componentSignatures(child).join(' | ')} }`),
  ].sort();
}

/** VEVENT con o senza RECURRENCE-ID di un VCALENDAR. */
function vevents(ics: string): { master: IcsComponent; overrides: IcsComponent[] } {
  const events = icsComponents(parseIcsTree(ics), 'VEVENT');
  const master = events.find((e) => !icsProp(e, 'RECURRENCE-ID'));
  assert.ok(master, 'VEVENT master assente');
  return { master, overrides: events.filter((e) => icsProp(e, 'RECURRENCE-ID')) };
}

/** Coppie [RECURRENCE-ID, DTSTART] delle istanze espanse di un calendar-data. */
function expandedInstances(ics: string): Array<[string, string]> {
  return icsComponents(parseIcsTree(ics), 'VEVENT').map((e) => [
    icsProp(e, 'RECURRENCE-ID')?.value ?? '',
    icsProp(e, 'DTSTART')?.value ?? '',
  ]);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ─── Radicale reale: CalDAV ───────────────────────────────

describe('Radicale reale: smoke CalDAV', { skip: radicale.skip }, () => {
  const rad = useRadicale({ label: 'smoke' });
  const collection = (name: string): string => `/${TEST_PRINCIPAL}/${P}-${name}/`;

  test('avvio: versione fissata, readiness, autenticazione e discovery del principal', async () => {
    const { server } = rad;
    assert.equal(server.version, RADICALE_PINNED_VERSION, `Radicale ${server.version} invece del pin ${RADICALE_PINNED_VERSION} (design §3.1)`);
    assert.ok(server.isRunning());

    const options = await server.anonymous().options('/');
    assert.equal(options.status, 200);
    assert.match(options.headers.get('dav') ?? '', /calendar-access/);
    assert.match(options.headers.get('allow') ?? '', /MKCALENDAR/);

    const anonymous = await server.anonymous().propfind(`/${TEST_PRINCIPAL}/`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Basic /);
    assert.equal((await server.client(TEST_PRINCIPAL, 'password-sbagliata').propfind(`/${TEST_PRINCIPAL}/`)).status, 401);

    const client = rad.client();
    const root = (await client.propfind('/', { props: [DAV_PROPS.currentUserPrincipal] })).multistatus();
    const principalHref = root.responses[0].element(DAV_PROPS.currentUserPrincipal);
    assert.ok(principalHref);
    assert.equal(xmlChild(principalHref, NS.DAV, 'href')?.text, `/${TEST_PRINCIPAL}/`);

    // Con owner_only e un utente htpasswd il principal nasce al primo accesso autenticato.
    const principal = (await client.propfind(`/${TEST_PRINCIPAL}/`, { props: [DAV_PROPS.resourcetype, DAV_PROPS.calendarHomeSet] })).multistatus();
    const types = principal.responses[0].element(DAV_PROPS.resourcetype)?.children.map((c) => c.name).sort();
    assert.deepEqual(types, ['collection', 'principal']);
    const home = principal.responses[0].element(DAV_PROPS.calendarHomeSet);
    assert.equal(home && xmlChild(home, NS.DAV, 'href')?.text, `/${TEST_PRINCIPAL}/`);
    assert.ok(existsSync(server.fsPath(TEST_PRINCIPAL)), 'directory del principal assente sul disco');

    // owner_only: nessun accesso al principal di un altro utente.
    assert.equal((await client.propfind('/altro-utente/')).status, 403);
    assert.equal((await client.mkcalendar('/altro-utente/lavoro/')).status, 403);
  });

  test('MKCALENDAR con displayname, colore, descrizione e componenti; layout su disco', async () => {
    const client = rad.client();
    const path = collection('mkcalendar');
    const created = await client.mkcalendar(path, {
      displayName: 'Lavoro (test)',
      color: '#2563EBFF',
      description: 'Calendario di prova del harness',
      components: ['VEVENT'],
    });
    assert.equal(created.status, 201, created.describe());

    const props = [DAV_PROPS.displayname, DAV_PROPS.calendarColor, DAV_PROPS.calendarDescription, DAV_PROPS.supportedComponents, DAV_PROPS.resourcetype, DAV_PROPS.getctag, DAV_PROPS.syncToken];
    const entry = (await client.propfind(path, { props })).multistatus().responses[0];
    assert.equal(entry.text(DAV_PROPS.displayname), 'Lavoro (test)');
    assert.equal(entry.text(DAV_PROPS.calendarColor), '#2563EBFF');
    assert.equal(entry.text(DAV_PROPS.calendarDescription), 'Calendario di prova del harness');
    assert.deepEqual(entry.element(DAV_PROPS.supportedComponents)?.children.map((c) => c.attrs.name), ['VEVENT']);
    assert.deepEqual(entry.element(DAV_PROPS.resourcetype)?.children.map((c) => `${c.ns}|${c.name}`).sort(), [`${NS.DAV}|collection`, `${NS.CALDAV}|calendar`]);
    assert.match(entry.text(DAV_PROPS.getctag) ?? '', /^"[0-9a-f]{64}"$/);
    assert.match(entry.text(DAV_PROPS.syncToken) ?? '', /^http:\/\/radicale\.org\/ns\/sync\/[0-9a-f]{64}$/);

    // Layout multifilesystem: collection-root/<principal>/<slug>/.Radicale.props (JSON).
    const stored = JSON.parse(readFileSync(rad.server.fsPath(TEST_PRINCIPAL, `${P}-mkcalendar`, '.Radicale.props'), 'utf8'));
    assert.deepEqual(stored, {
      'C:calendar-description': 'Calendario di prova del harness',
      'C:supported-calendar-component-set': 'VEVENT',
      'D:displayname': 'Lavoro (test)',
      'ICAL:calendar-color': '#2563EBFF',
      tag: 'VCALENDAR',
    });

    // permit_overwrite_collection = False come in produzione (design §3.2).
    assert.equal((await client.mkcalendar(path, { displayName: 'Doppione' })).status, 409);
  });

  test('PROPPATCH: proprietà live e dead prop {urn:calicchia:caldes} (impostazione e rimozione)', async () => {
    const client = rad.client();
    const path = collection('proppatch');
    assert.equal((await client.mkcalendar(path, { displayName: 'Prima' })).status, 201);

    const role = { ns: NS.CALDES, name: 'role' };
    const volumeId = { ns: NS.CALDES, name: 'volume-id' };
    const patched = await client.proppatch(path, {
      set: [
        { ...DAV_PROPS.displayname, value: 'Festività' },
        { ...DAV_PROPS.calendarColor, value: '#DC2626FF' },
        { ...role, value: 'holidays' },
        { ...volumeId, value: '0b9d3c1e-6c55-4c8e-9f7e-2f1a3b4c5d6e' },
      ],
    });
    const result = patched.multistatus().responses[0];
    for (const prop of [DAV_PROPS.displayname, DAV_PROPS.calendarColor, role, volumeId]) {
      assert.equal(result.statusOf(prop), 200, `PROPPATCH di ${prop.name}`);
    }

    const read = (await client.propfind(path, { props: [DAV_PROPS.displayname, DAV_PROPS.calendarColor, role, volumeId] })).multistatus().responses[0];
    assert.equal(read.text(DAV_PROPS.displayname), 'Festività');
    assert.equal(read.text(DAV_PROPS.calendarColor), '#DC2626FF');
    assert.equal(read.text(role), 'holidays');
    assert.equal(read.text(volumeId), '0b9d3c1e-6c55-4c8e-9f7e-2f1a3b4c5d6e');

    // Le dead prop finiscono in .Radicale.props in notazione di Clark: è lì che
    // caldes_rights leggerà identità del volume e ruolo (design §3.3).
    const stored = JSON.parse(readFileSync(rad.server.fsPath(TEST_PRINCIPAL, `${P}-proppatch`, '.Radicale.props'), 'utf8'));
    assert.equal(stored['{urn:calicchia:caldes}role'], 'holidays');
    assert.equal(stored['{urn:calicchia:caldes}volume-id'], '0b9d3c1e-6c55-4c8e-9f7e-2f1a3b4c5d6e');
    assert.equal(stored['D:displayname'], 'Festività');

    const removed = await client.proppatch(path, { remove: [role] });
    assert.equal(removed.multistatus().responses[0].statusOf(role), 200);
    const after = (await client.propfind(path, { props: [role, volumeId] })).multistatus().responses[0];
    assert.equal(after.statusOf(role), 404);
    assert.equal(after.text(volumeId), '0b9d3c1e-6c55-4c8e-9f7e-2f1a3b4c5d6e');
  });

  test('PUT e GET di una serie con TZID Europe/Rome, override, VALARM, ATTENDEE e X-CALDES-*: proprietà preservate', async () => {
    const client = rad.client();
    const path = collection('fedelta');
    assert.equal((await client.mkcalendar(path, { components: ['VEVENT'] })).status, 201);
    const href = `${path}serie.ics`;
    const original = seriesIcs();

    const put = await client.put(href, original, { ifNoneMatch: '*' });
    assert.equal(put.status, 201, put.describe());
    assert.match(put.etag ?? '', /^"[0-9a-f]{64}"$/);
    assert.equal((await client.put(href, original, { ifNoneMatch: '*' })).status, 412, 'If-None-Match: * su una risorsa esistente');

    const got = await client.get(href);
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-type') ?? '', /^text\/calendar/);
    assert.equal(got.etag, put.etag, "l'ETag della GET è quello restituito dalla PUT");

    // Confronto semantico (nome, parametri e valore; ordine libero) di
    // VTIMEZONE, master con i VALARM e override.
    const before = parseIcsTree(original);
    const after = parseIcsTree(got.text);
    assert.deepEqual(componentSignatures(icsComponents(after, 'VTIMEZONE')[0]), componentSignatures(icsComponents(before, 'VTIMEZONE')[0]));
    const a = vevents(got.text);
    const b = vevents(original);
    assert.deepEqual(componentSignatures(a.master), componentSignatures(b.master));
    assert.equal(a.overrides.length, 1);
    assert.deepEqual(componentSignatures(a.overrides[0]), componentSignatures(b.overrides[0]));

    // Le proprietà su cui l'API farà affidamento, esplicite.
    assert.equal(icsProp(a.master, 'DTSTART')?.params.TZID, 'Europe/Rome');
    assert.equal(icsProp(a.master, 'DTSTART')?.value, '20270104T090000');
    assert.equal(icsProp(a.master, 'EXDATE')?.value, '20270118T090000');
    assert.equal(icsProp(a.master, 'SUMMARY')?.value, 'Riunione settimanale\\, team');
    assert.equal(icsProp(a.master, 'X-CALDES-SOURCE')?.value, 'admin');
    assert.equal(icsProp(a.master, 'X-CALDES-LEGACY-ID')?.value, '7f3a1c2e-0b1d-4e5f-9a8b-1234567890ab');
    assert.deepEqual(icsProps(a.master, 'ATTENDEE').map((p) => [p.params.CN, p.params.PARTSTAT, p.value]), [
      ['Mario Rossi', 'NEEDS-ACTION', 'mailto:mario.rossi@caldes.test'],
      ['Federico Calicchia', 'ACCEPTED', 'mailto:federico@caldes.test'],
    ]);
    assert.deepEqual(icsComponents(a.master, 'VALARM').map((v) => icsProp(v, 'TRIGGER')?.value), ['-PT15M', 'PT0S']);
    assert.equal(icsProp(a.overrides[0], 'RECURRENCE-ID')?.params.TZID, 'Europe/Rome');
    assert.equal(icsProp(a.overrides[0], 'RECURRENCE-ID')?.value, '20270111T090000');

    // Sul disco: un file per risorsa, col nome dell'href.
    assert.match(readFileSync(rad.server.fsPath(TEST_PRINCIPAL, `${P}-fedelta`, 'serie.ics'), 'utf8'), new RegExp(`UID:${SERIES_UID}`));

    // Riserializzazione stabile: rimettere il testo letto lascia invariato l'ETag.
    const again = await client.put(href, got.text, { ifMatch: got.etag ?? '' });
    assert.equal(again.status, 204);
    assert.equal(again.etag, got.etag);
  });

  test('REPORT calendar-query con time-range: occorrenze, EXDATE, override spostato, ora legale, fine serie, all-day', async () => {
    const client = rad.client();
    const path = collection('timerange');
    assert.equal((await client.mkcalendar(path, { components: ['VEVENT'] })).status, 201);
    const series = `${path}serie.ics`;
    const single = `${path}singolo.ics`;
    const allDay = `${path}ferie.ics`;
    assert.equal((await client.put(series, seriesIcs())).status, 201);
    assert.equal((await client.put(single, eventIcs(`${P}-singolo@caldes.test`, [
      'DTSTART;TZID=Europe/Rome:20270201T150000',
      'DTEND;TZID=Europe/Rome:20270201T160000',
      'SUMMARY:Sopralluogo',
    ]))).status, 201);
    assert.equal((await client.put(allDay, eventIcs(`${P}-ferie@caldes.test`, [
      'DTSTART;VALUE=DATE:20270302',
      'DTEND;VALUE=DATE:20270303',
      'TRANSP:TRANSPARENT',
      'SUMMARY:Ferie',
    ]))).status, 201);

    const found = async (start: string, end: string): Promise<string[]> => {
      const res = await client.calendarQuery(path, { start, end });
      return res.multistatus().paths();
    };

    const cases: Array<[string, string, string, string[]]> = [
      ['prima occorrenza (lun 4/1)', '2027-01-04T00:00:00Z', '2027-01-05T00:00:00Z', [series]],
      ['occorrenza spostata dall\'override (lun 11/1)', '2027-01-11T00:00:00Z', '2027-01-12T00:00:00Z', []],
      ['override (mar 12/1)', '2027-01-12T00:00:00Z', '2027-01-13T00:00:00Z', [series]],
      ['EXDATE (lun 18/1)', '2027-01-18T00:00:00Z', '2027-01-19T00:00:00Z', []],
      ['serie e singolo (lun 1/2)', '2027-02-01T00:00:00Z', '2027-02-02T00:00:00Z', [series, single]],
      ['ora solare: 09:00 Roma = 08:00Z (lun 22/3)', '2027-03-22T08:00:00Z', '2027-03-22T08:30:00Z', [series]],
      ['ora solare: nulla alle 07:00Z (lun 22/3)', '2027-03-22T07:00:00Z', '2027-03-22T07:30:00Z', []],
      ['ora legale: 09:00 Roma = 07:00Z (lun 29/3)', '2027-03-29T07:00:00Z', '2027-03-29T07:30:00Z', [series]],
      ['ora legale: nulla alle 08:00Z (lun 29/3)', '2027-03-29T08:00:00Z', '2027-03-29T08:30:00Z', []],
      ['dopo COUNT=13 (lun 5/4)', '2027-04-05T00:00:00Z', '2027-04-06T00:00:00Z', []],
      ['evento in corso (finestra interna)', '2027-01-04T08:30:00Z', '2027-01-04T08:45:00Z', [series]],
      ['fine esclusiva (finestra che inizia alla fine)', '2027-01-04T09:00:00Z', '2027-01-04T10:00:00Z', []],
      ['all-day (mar 2/3, giorno UTC)', '2027-03-02T00:00:00Z', '2027-03-03T00:00:00Z', [allDay]],
      // Limitazione 6: 00:15-00:45 del 2/3 a Roma (23:15-23:45Z dell'1/3) non
      // tocca l'all-day, che Radicale colloca sul giorno UTC.
      ['all-day: mezzanotte di Roma non inclusa', '2027-03-01T23:15:00Z', '2027-03-01T23:45:00Z', []],
    ];
    for (const [label, start, end, expected] of cases) {
      assert.deepEqual(await found(start, end), [...expected].sort(), label);
    }

    // Senza time-range: tutti gli oggetti VEVENT della collezione, con dati ed ETag.
    const all = CalDavClient.objects(await client.calendarQuery(path));
    assert.deepEqual(all.map((o) => o.path).sort(), [allDay, series, single].sort());
    assert.ok(all.every((o) => o.etag && o.data?.startsWith('BEGIN:VCALENDAR')));
  });

  test('REPORT con expand: istanze in UTC attraverso il cambio dell\'ora legale, override ed EXDATE applicati', async () => {
    const client = rad.client();
    const path = collection('expand');
    assert.equal((await client.mkcalendar(path, { components: ['VEVENT'] })).status, 201);
    const href = `${path}serie.ics`;
    assert.equal((await client.put(href, seriesIcs())).status, 201);

    const res = await client.calendarQuery(path, { start: '2027-01-01T00:00:00Z', end: '2027-05-01T00:00:00Z', expand: true });
    const [object] = CalDavClient.objects(res);
    assert.equal(object.path, href);
    assert.ok(object.data);

    // 13 lunedì meno l'EXDATE del 18/1; l'11/1 diventa l'override di martedì
    // 12 alle 10:00 di Roma (09:00Z); dal 29/3 l'ora legale porta le 09:00 di
    // Roma alle 07:00Z.
    const winter = ['0104', '0125', '0201', '0208', '0215', '0222', '0301', '0308', '0315', '0322'];
    const expected: Array<[string, string]> = winter.map((d) => [`2027${d}T080000Z`, `2027${d}T080000Z`]);
    expected.splice(1, 0, ['20270111T080000Z', '20270112T090000Z']);
    expected.push(['20270329T070000Z', '20270329T070000Z']);
    assert.deepEqual(expandedInstances(object.data), expected);

    // Le istanze espanse non hanno più regola, EXDATE né VTIMEZONE; VALARM e X-prop restano.
    const tree = parseIcsTree(object.data);
    assert.equal(icsComponents(tree, 'VTIMEZONE').length, 0);
    const instances = icsComponents(tree, 'VEVENT');
    assert.ok(instances.every((e) => !icsProp(e, 'RRULE') && !icsProp(e, 'EXDATE')));
    assert.ok(instances.every((e) => icsProp(e, 'UID')?.value === SERIES_UID));
    assert.equal(icsComponents(instances[0], 'VALARM').length, 2);
    assert.equal(icsProp(instances[0], 'X-CALDES-SOURCE')?.value, 'admin');
    assert.equal(icsProp(instances[1], 'SUMMARY')?.value, 'Riunione spostata a martedì');
  });

  test('calendar-multiget: dati ed ETag per href, 404 per gli href assenti', async () => {
    const client = rad.client();
    const path = collection('multiget');
    assert.equal((await client.mkcalendar(path)).status, 201);
    const a = await client.put(`${path}a.ics`, eventIcs(`${P}-mg-a@caldes.test`, ['DTSTART:20270201T080000Z', 'DTEND:20270201T090000Z', 'SUMMARY:A']));
    assert.equal(a.status, 201);

    const res = (await client.calendarMultiget(path, [`${path}a.ics`, `${path}assente.ics`])).multistatus();
    const found = res.find(`${path}a.ics`);
    assert.equal(found?.text(DAV_PROPS.getetag), a.etag);
    assert.match(found?.text(DAV_PROPS.calendarData) ?? '', /SUMMARY:A\r?\n/);
    assert.equal(res.find(`${path}assente.ics`)?.status, 404);
  });

  test('sync-collection: sync iniziale, delta dopo creazione, modifica e cancellazione, token non valido', async () => {
    const client = rad.client();
    const path = collection('sync');
    assert.equal((await client.mkcalendar(path)).status, 201);
    const ev = (name: string, summary: string): string => eventIcs(`${P}-sync-${name}@caldes.test`, [
      'DTSTART:20270301T080000Z',
      'DTEND:20270301T090000Z',
      `SUMMARY:${summary}`,
    ]);
    const etags: Record<string, string> = {};
    for (const name of ['a', 'b', 'c']) {
      const res = await client.put(`${path}${name}.ics`, ev(name, name.toUpperCase()), { ifNoneMatch: '*' });
      assert.equal(res.status, 201);
      etags[name] = res.etag ?? '';
    }
    const ctagBefore = (await client.propfind(path, { props: [DAV_PROPS.getctag] })).multistatus().responses[0].text(DAV_PROPS.getctag);

    const initial = (await client.syncCollection(path)).multistatus();
    assert.match(initial.syncToken ?? '', /^http:\/\/radicale\.org\/ns\/sync\/[0-9a-f]{64}$/);
    assert.deepEqual(initial.paths(), ['a', 'b', 'c'].map((n) => `${path}${n}.ics`));
    for (const name of ['a', 'b', 'c']) assert.equal(initial.find(`${path}${name}.ics`)?.text(DAV_PROPS.getetag), etags[name]);
    const t1 = initial.syncToken as string;

    // Nessuna modifica: delta vuoto e stesso token.
    const unchanged = (await client.syncCollection(path, { syncToken: t1 })).multistatus();
    assert.equal(unchanged.responses.length, 0);
    assert.equal(unchanged.syncToken, t1);

    // Modifica di a (If-Match), cancellazione di b (If-Match), creazione di d.
    const updated = await client.put(`${path}a.ics`, ev('a', 'A modificato'), { ifMatch: etags.a });
    assert.equal(updated.status, 204);
    assert.notEqual(updated.etag, etags.a);
    assert.equal((await client.delete(`${path}b.ics`, { ifMatch: etags.b })).status, 200);
    const created = await client.put(`${path}d.ics`, ev('d', 'D'), { ifNoneMatch: '*' });
    assert.equal(created.status, 201);

    const delta = (await client.syncCollection(path, { syncToken: t1 })).multistatus();
    assert.notEqual(delta.syncToken, t1);
    assert.deepEqual(delta.paths(), ['a', 'b', 'd'].map((n) => `${path}${n}.ics`));
    assert.equal(delta.find(`${path}a.ics`)?.text(DAV_PROPS.getetag), updated.etag);
    assert.equal(delta.find(`${path}d.ics`)?.text(DAV_PROPS.getetag), created.etag);
    const deleted = delta.find(`${path}b.ics`);
    assert.equal(deleted?.status, 404, 'gli eliminati tornano come response con status 404');
    assert.equal(deleted?.propstats.length, 0);

    const t2 = delta.syncToken as string;
    const empty = (await client.syncCollection(path, { syncToken: t2 })).multistatus();
    assert.equal(empty.responses.length, 0);
    assert.equal(empty.syncToken, t2);

    const ctagAfter = (await client.propfind(path, { props: [DAV_PROPS.getctag] })).multistatus().responses[0].text(DAV_PROPS.getctag);
    assert.notEqual(ctagAfter, ctagBefore);

    // Token sconosciuto o malformato: 403 con la precondizione DAV:valid-sync-token (RFC 6578).
    const invalid = await client.syncCollection(path, { syncToken: 'http://radicale.org/ns/sync/non-valido' });
    assert.equal(invalid.status, 403);
    const error = invalid.xml();
    assert.equal(error.name, 'error');
    assert.ok(xmlChild(error, NS.DAV, 'valid-sync-token'));
  });

  test('DELETE con If-Match: 412 con l\'ETag vecchio, poi 404; DELETE della collezione negato', async () => {
    const client = rad.client();
    const path = collection('delete');
    assert.equal((await client.mkcalendar(path)).status, 201);
    const href = `${path}evento.ics`;
    const first = await client.put(href, eventIcs(`${P}-del@caldes.test`, ['DTSTART:20270301T080000Z', 'DTEND:20270301T090000Z', 'SUMMARY:Prima']));
    const second = await client.put(href, eventIcs(`${P}-del@caldes.test`, ['DTSTART:20270301T080000Z', 'DTEND:20270301T090000Z', 'SUMMARY:Seconda']), { ifMatch: first.etag ?? '' });
    assert.equal(second.status, 204);

    assert.equal((await client.put(href, eventIcs(`${P}-del@caldes.test`, ['DTSTART:20270301T080000Z', 'SUMMARY:Terza']), { ifMatch: first.etag ?? '' })).status, 412, 'PUT con ETag vecchio');
    assert.equal((await client.delete(href, { ifMatch: first.etag ?? '' })).status, 412, 'DELETE con ETag vecchio');
    assert.equal((await client.get(href)).status, 200);

    assert.equal((await client.delete(href, { ifMatch: second.etag ?? '' })).status, 200);
    assert.equal((await client.get(href)).status, 404);
    assert.equal((await client.delete(href)).status, 404);
    assert.ok(!existsSync(rad.server.fsPath(TEST_PRINCIPAL, `${P}-delete`, 'evento.ics')));

    // permit_delete_collection = False come in produzione (design §3.2).
    assert.equal((await client.delete(path)).status, 403);
    assert.equal((await client.propfind(path)).status, 207);
  });
});

// ─── Limitazioni osservate ───────────────────────────────

describe('Radicale reale: limitazioni osservate (vobject 0.9.9 senza patch di fedeltà)', { skip: radicale.skip }, () => {
  const rad = useRadicale({ label: 'limiti' });
  const path = `/${TEST_PRINCIPAL}/${P}-limiti/`;
  // Dopo il before di useRadicale (gli hook girano in ordine di registrazione).
  before(async () => {
    assert.equal((await rad.client().mkcalendar(path)).status, 201);
  });

  /** PUT nella collezione delle limitazioni e GET del risultato. */
  const roundTrip = async (name: string, lines: string[]): Promise<IcsComponent> => {
    const client = rad.client();
    const res = await client.put(`${path}${name}.ics`, eventIcs(`${P}-${name}@caldes.test`, lines));
    assert.equal(res.status, 201, res.describe());
    return vevents((await client.get(`${path}${name}.ics`)).text).master;
  };

  test('virgole non escapate nei valori TEXT: il valore viene troncato', async () => {
    const event = await roundTrip('virgole-text', [
      'DTSTART:20270201T080000Z',
      'SUMMARY:Pranzo, cena',
      'LOCATION:Via Roma 1, Frosinone',
      'DESCRIPTION:Con virgola escapata\\, resta intera',
    ]);
    assert.equal(icsProp(event, 'SUMMARY')?.value, 'Pranzo');
    assert.equal(icsProp(event, 'LOCATION')?.value, 'Via Roma 1');
    assert.equal(icsProp(event, 'DESCRIPTION')?.value, 'Con virgola escapata\\, resta intera');
  });

  test('X-prop e VALUE=URI con virgole troncate alla prima virgola (URL e CATEGORIES restano)', async () => {
    const event = await roundTrip('virgole-xprop', [
      'DTSTART:20270201T080000Z',
      'SUMMARY:X-prop',
      'X-CALDES-LEGACY-RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'X-CALDES-SOURCE-ID:gruppo;voce',
      'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Studio:geo:41.639,13.342',
      'CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://meet.caldes.test/stanza?a=1,2',
      'URL:https://caldes.test/percorso?a=1,2',
      'CATEGORIES:Lavoro,Cliente',
    ]);
    // Le X-prop sono trattate come TEXT: troncate alla prima virgola e con il
    // ';' riscritto come '\;' (valore originale: FREQ=WEEKLY;BYDAY=MO,WE,FR).
    assert.equal(icsProp(event, 'X-CALDES-LEGACY-RRULE')?.value, 'FREQ=WEEKLY\\;BYDAY=MO');
    // Anche senza virgole il ';' di una X-prop viene riscritto come '\;'.
    assert.equal(icsProp(event, 'X-CALDES-SOURCE-ID')?.value, 'gruppo\\;voce');
    assert.equal(icsProp(event, 'X-APPLE-STRUCTURED-LOCATION')?.value, 'geo:41.639');
    assert.equal(icsProp(event, 'CONFERENCE')?.value, 'https://meet.caldes.test/stanza?a=1');
    assert.equal(icsProp(event, 'URL')?.value, 'https://caldes.test/percorso?a=1,2');
    assert.equal(icsProp(event, 'CATEGORIES')?.value, 'Lavoro,Cliente');
  });

  test('riserializzazione: ordine e virgolette cambiano, ETag deterministico sul contenuto', async () => {
    const client = rad.client();
    const lines = [
      'SUMMARY:Ordine',
      'DTSTART:20270201T080000Z',
      'ATTENDEE;RSVP=TRUE;CN="Mario Rossi";PARTSTAT=NEEDS-ACTION:mailto:mario.rossi@caldes.test',
    ];
    const event = await roundTrip('serializzazione', lines);
    const text = (await client.get(`${path}serializzazione.ics`)).text;
    const logical = unfoldIcs(text);
    // UID e DTSTART prima delle altre proprietà, parametri in ordine alfabetico, CN senza virgolette.
    assert.deepEqual(logical.slice(logical.indexOf('BEGIN:VEVENT') + 1, logical.indexOf('BEGIN:VEVENT') + 3), [
      `UID:${P}-serializzazione@caldes.test`,
      'DTSTART:20270201T080000Z',
    ]);
    assert.ok(logical.includes('ATTENDEE;CN=Mario Rossi;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mario.rossi@caldes.test'));
    assert.equal(icsProp(event, 'ATTENDEE')?.params.CN, 'Mario Rossi');

    // Stesso contenuto → stesso ETag (hash del testo salvato); contenuto diverso → ETag diverso.
    const first = await client.put(`${path}serializzazione.ics`, eventIcs(`${P}-serializzazione@caldes.test`, lines));
    const second = await client.put(`${path}serializzazione.ics`, eventIcs(`${P}-serializzazione@caldes.test`, lines));
    assert.equal(first.etag, second.etag);
    const stored = readFileSync(rad.server.fsPath(TEST_PRINCIPAL, `${P}-limiti`, 'serializzazione.ics'), 'utf8');
    assert.equal(first.etag, `"${sha256(stored)}"`);
    const changed = await client.put(`${path}serializzazione.ics`, eventIcs(`${P}-serializzazione@caldes.test`, [...lines, 'LOCATION:Altrove']));
    assert.notEqual(changed.etag, first.etag);
  });

  test('PUT senza DTSTAMP: Radicale aggiunge DTSTAMP con l\'ora del server', async () => {
    const client = rad.client();
    const ics = icsText([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calicchia Design//Test harness//IT',
      'BEGIN:VEVENT', `UID:${P}-senza-dtstamp@caldes.test`, 'DTSTART:20270201T080000Z', 'SUMMARY:Senza DTSTAMP', 'END:VEVENT',
      'END:VCALENDAR',
    ]);
    assert.equal((await client.put(`${path}senza-dtstamp.ics`, ics)).status, 201);
    const event = vevents((await client.get(`${path}senza-dtstamp.ics`)).text).master;
    // Il valore dipende dall'orologio del server: si verifica solo la forma.
    assert.match(icsProp(event, 'DTSTAMP')?.value ?? '', /^\d{8}T\d{6}Z$/);
  });

  test('sync-collection iniziale: tombstone 404 degli eliminati e DAV:limit ignorato', async () => {
    const client = rad.client();
    const syncPath = `/${TEST_PRINCIPAL}/${P}-limiti-sync/`;
    assert.equal((await client.mkcalendar(syncPath)).status, 201);
    for (const name of ['a', 'b', 'c']) {
      assert.equal((await client.put(`${syncPath}${name}.ics`, eventIcs(`${P}-ls-${name}@caldes.test`, ['DTSTART:20270201T080000Z', `SUMMARY:${name}`]))).status, 201);
    }
    assert.equal((await client.delete(`${syncPath}b.ics`)).status, 200);

    const initial = (await client.syncCollection(syncPath)).multistatus();
    assert.deepEqual(initial.paths(), ['a', 'b', 'c'].map((n) => `${syncPath}${n}.ics`));
    assert.equal(initial.find(`${syncPath}b.ics`)?.status, 404, "l'eliminato compare anche nella sync iniziale");
    assert.equal(initial.find(`${syncPath}a.ics`)?.status, null);

    const limited = await client.syncCollection(syncPath, { limit: 1 });
    assert.equal(limited.status, 207, 'nessun 507 con DAV:limit');
    assert.equal(limited.multistatus().responses.length, 3, 'DAV:limit/nresults ignorato');
  });

  test('validazione in PUT: no-uid-conflict, UID multipli, UNTIL < DTSTART, limite delle occorrenze, orfani', async () => {
    const client = rad.client();
    const vPath = `/${TEST_PRINCIPAL}/${P}-limiti-validazione/`;
    assert.equal((await client.mkcalendar(vPath)).status, 201);
    const base = ['DTSTART:20270201T080000Z', 'DTEND:20270201T090000Z', 'SUMMARY:Validazione'];

    assert.equal((await client.put(`${vPath}uno.ics`, eventIcs(`${P}-uid-doppio@caldes.test`, base))).status, 201);
    const conflict = await client.put(`${vPath}due.ics`, eventIcs(`${P}-uid-doppio@caldes.test`, base));
    assert.equal(conflict.status, 409, 'stesso UID su un altro href');
    assert.ok(xmlChild(conflict.xml(), NS.CALDAV, 'no-uid-conflict'));

    const twoUids = icsText([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calicchia Design//Test harness//IT',
      'BEGIN:VEVENT', `UID:${P}-uid-a@caldes.test`, 'DTSTAMP:20261001T080000Z', ...base, 'END:VEVENT',
      'BEGIN:VEVENT', `UID:${P}-uid-b@caldes.test`, 'DTSTAMP:20261001T080000Z', ...base, 'END:VEVENT',
      'END:VCALENDAR',
    ]);
    assert.equal((await client.put(`${vPath}due-uid.ics`, twoUids)).status, 400);
    assert.equal((await client.put(`${vPath}until.ics`, eventIcs(`${P}-until@caldes.test`, [...base, 'RRULE:FREQ=WEEKLY;UNTIL=20260101T000000Z']))).status, 400, 'UNTIL < DTSTART');

    // Con max_vevent_rrule_occurrence = 50000 (config di produzione) la DAILY
    // fino al 2056 passa; la stima ignora INTERVAL e BY*, quindi passa anche
    // una MINUTELY infinita (design §3.2).
    const daily2056 = eventIcs(`${P}-daily-2056@caldes.test`, [...base, 'RRULE:FREQ=DAILY;UNTIL=20560101T000000Z']);
    assert.equal((await client.put(`${vPath}daily-2056.ics`, daily2056)).status, 201);
    assert.equal((await client.put(`${vPath}minutely.ics`, eventIcs(`${P}-minutely@caldes.test`, [...base, 'RRULE:FREQ=MINUTELY']))).status, 201);

    // Override senza master (solo RECURRENCE-ID): accettato come risorsa autonoma.
    const orphan = icsText([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calicchia Design//Test harness//IT',
      'BEGIN:VEVENT', `UID:${P}-orfano@caldes.test`, 'DTSTAMP:20261001T080000Z', 'RECURRENCE-ID:20270201T080000Z',
      'DTSTART:20270201T100000Z', 'DTEND:20270201T110000Z', 'SUMMARY:Solo override', 'END:VEVENT',
      'END:VCALENDAR',
    ]);
    assert.equal((await client.put(`${vPath}orfano.ics`, orphan)).status, 201);

    // Con il default di Radicale (10000) la stessa DAILY viene rifiutata: il
    // valore va replicato identico nel validatore dell'API (design §3.2).
    const strict = await startRadicale({ label: 'limiti-10000', maxVeventRruleOccurrence: 10_000 });
    try {
      const strictClient = strict.client();
      assert.equal((await strictClient.mkcalendar(vPath)).status, 201);
      const mark = strict.logMark();
      assert.equal((await strictClient.put(`${vPath}daily-2056.ics`, daily2056)).status, 400);
      assert.match(strict.logsSince(mark), /Too many recurrence rule entries.*\(limit: 10000\)/);
    } finally {
      await strict.stop();
    }
  });
});

// ─── Mock di verify-credentials ───────────────────────────────

describe('mock di verify-credentials (helpers/mock_verify.py)', { skip: python.skip }, () => {
  const IPHONE = { username: 'iphone', password: 'test-only-app-password-iphone' };
  const verify = useMockVerify({ users: [IPHONE, { username: 'caldes-svc', password: 'test-only-svc' }, { username: 'mac', password: 'test-only-mac', principal: 'altro' }] });

  const call = async (body: unknown, opts: { bearer?: string | null; headers?: Record<string, string>; raw?: string } = {}): Promise<{ status: number; text: string }> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
    const bearer = opts.bearer === undefined ? verify.mock.token : opts.bearer;
    if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetch(`${verify.mock.backendUrl}/verify-credentials`, {
      method: 'POST',
      headers,
      body: opts.raw ?? JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, text: await res.text() };
  };

  test('contratto della route reale: Bearer, credenziali, principal canonico, username riservati', async () => {
    const { mock } = verify;
    await mock.setState({ mode: 'ok', principal_mode: 'canonical' });
    await mock.clearCalls();

    // Credenziali valide → principal canonico (contratto di F1), qualunque sia lo username.
    let res = await call(IPHONE, { headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Remote-Addr': '203.0.113.7' } });
    assert.deepEqual([res.status, JSON.parse(res.text)], [200, { ok: true, principal: TEST_PRINCIPAL }]);
    // Principal proprio dell'utente.
    res = await call({ username: 'mac', password: 'test-only-mac' });
    assert.deepEqual(JSON.parse(res.text), { ok: true, principal: 'altro' });
    // Bearer assente o errato: 401 del middleware caldav-service-auth.
    for (const bearer of [null, 'token-sbagliato']) {
      res = await call(IPHONE, { bearer });
      assert.deepEqual([res.status, JSON.parse(res.text)], [401, { error: 'Unauthorized' }]);
    }
    // Password errata, campi mancanti, corpo non JSON: 401 {ok:false} come la route.
    for (const [body, raw] of [[{ ...IPHONE, password: 'sbagliata' }, undefined], [{ username: 'iphone' }, undefined], [null, 'non json']] as const) {
      res = await call(body, { raw });
      assert.deepEqual([res.status, JSON.parse(res.text)], [401, { ok: false }]);
    }
    // Username riservato (caldes-*): rifiutato anche con la password giusta.
    res = await call({ username: 'caldes-svc', password: 'test-only-svc' });
    assert.deepEqual([res.status, JSON.parse(res.text)], [401, { ok: false }]);
    // principal_mode 'username': come l'API di oggi (principal = username).
    await mock.setState({ principal_mode: 'username' });
    res = await call(IPHONE);
    assert.deepEqual(JSON.parse(res.text), { ok: true, principal: 'iphone' });
    await mock.setState({ principal_mode: 'canonical' });

    // Registro delle chiamate: header utili ai test dei plugin, mai la password in chiaro.
    const calls = await mock.calls();
    assert.equal(calls.length, 9);
    assert.deepEqual(
      { ...calls[0], ts: 0, user_agent: null },
      {
        ts: 0,
        method: 'POST',
        path: '/api/caldav-backend/verify-credentials',
        mode: 'ok',
        status: 200,
        username: 'iphone',
        password_sha256: sha256(IPHONE.password),
        authorization_valid: true,
        x_forwarded_for: '203.0.113.7',
        x_remote_addr: '203.0.113.7',
        user_agent: null,
        content_type: 'application/json',
      },
    );
    assert.ok(!JSON.stringify(calls).includes(IPHONE.password));
    const state = await mock.state();
    assert.deepEqual(state.usernames, ['caldes-svc', 'iphone', 'mac']);
    assert.ok(!JSON.stringify(state).includes(IPHONE.password));
  });

  test('guasti simulati: 500, 503, 429, corpo non JSON, ritardo, connessione chiusa', async () => {
    const { mock } = verify;
    const expectations: Array<[MockVerifyMode, number]> = [
      ['error', 500],
      ['unavailable', 503],
      ['rate_limited', 429],
      ['deny', 401],
    ];
    for (const [mode, status] of expectations) {
      await mock.setState({ mode });
      assert.equal((await call(IPHONE)).status, status, mode);
    }
    // Il 429 arriva dopo il controllo del Bearer, come nella route reale.
    await mock.setState({ mode: 'rate_limited' });
    assert.equal((await call(IPHONE, { bearer: 'token-sbagliato' })).status, 401);

    await mock.setState({ mode: 'garbage' });
    const garbage = await call(IPHONE);
    assert.equal(garbage.status, 200);
    assert.throws(() => JSON.parse(garbage.text));

    await mock.setState({ mode: 'slow', delay_ms: 300 });
    const started = performance.now();
    assert.equal((await call(IPHONE)).status, 200);
    assert.ok(performance.now() - started >= 290, 'la risposta arriva dopo delay_ms');

    await mock.setState({ mode: 'drop', delay_ms: 0 });
    await assert.rejects(call(IPHONE), 'connessione chiusa senza risposta');

    await mock.setState({ mode: 'ok' });
    assert.equal((await call(IPHONE)).status, 200);

    // Stato non valido: 400 e nessun cambiamento.
    const bad = await fetch(`${mock.url}/__mock/state`, { method: 'POST', body: JSON.stringify({ mode: 'inesistente' }) });
    assert.equal(bad.status, 400);
    assert.equal((await mock.state()).mode, 'ok');
  });
});

// ─── Plugin di autenticazione con il mock ───────────────────────────────

describe('Radicale reale con plugin di autenticazione di prova e mock di verify-credentials', { skip: radicale.skip || python.skip }, () => {
  const IPHONE = { username: 'iphone', password: 'test-only-app-password-iphone' };
  const verify = useMockVerify({ users: [IPHONE, { username: 'caldes-svc', password: 'test-only-svc' }] });
  // Le opzioni sono una funzione: l'URL del mock esiste solo dopo il suo before.
  const rad = useRadicale(() => ({
    label: 'auth-plugin',
    auth: {
      type: 'plugin',
      module: '_caldes_test_auth',
      pythonPath: [INTEGRATION_DIR],
      env: {
        CALDAV_BACKEND_URL: verify.mock.backendUrl,
        CALDAV_SERVICE_TOKEN: verify.mock.token,
        CALDES_TEST_AUTH_TIMEOUT: '0.5',
      },
    },
  }));
  const device = (): CalDavClient => rad.server.client(IPHONE.username, IPHONE.password);

  test('app-password con username non canonico → principal federico, IP del device in X-Forwarded-For', async () => {
    const { mock } = verify;
    await mock.setState({ mode: 'ok' });
    await mock.clearCalls();

    // X-Remote-Addr è l'header che CloudPanel aggiunge (design §3.5).
    const client = device().withHeaders({ 'X-Remote-Addr': '203.0.113.10' });
    const root = (await client.propfind('/', { props: [DAV_PROPS.currentUserPrincipal] })).multistatus();
    const href = root.responses[0].element(DAV_PROPS.currentUserPrincipal);
    assert.equal(href && xmlChild(href, NS.DAV, 'href')?.text, `/${TEST_PRINCIPAL}/`);
    assert.equal((await client.mkcalendar(`/${TEST_PRINCIPAL}/${P}-device/`, { displayName: 'Dal telefono' })).status, 201);
    assert.equal((await client.propfind(`/${IPHONE.username}/`)).status, 403, 'nessun principal per lo username del device');

    const calls = await mock.calls();
    assert.ok(calls.length >= 3);
    assert.ok(calls.every((c) => c.username === 'iphone' && c.authorization_valid && c.status === 200));
    assert.ok(calls.every((c) => c.x_forwarded_for === '203.0.113.10'));
    assert.ok(calls.every((c) => c.password_sha256 === sha256(IPHONE.password)));

    // Senza X-Remote-Addr il plugin inoltra il peer TCP.
    await mock.clearCalls();
    assert.equal((await device().propfind(`/${TEST_PRINCIPAL}/`)).status, 207);
    assert.equal((await mock.calls())[0]?.x_forwarded_for, '127.0.0.1');
  });

  test('peer TCP: un client da 127.0.0.2 arriva a Radicale con REMOTE_ADDR 127.0.0.2 (base dei test del peer di F1)', async (t) => {
    // Su Linux tutto 127.0.0.0/8 è loopback; altrove serve un alias dell'interfaccia.
    if (!(await canBindLocalAddress('127.0.0.2'))) {
      t.skip('127.0.0.2 non utilizzabile come indirizzo sorgente su questo sistema');
      return;
    }
    const { mock } = verify;
    await mock.setState({ mode: 'ok' });
    await mock.clearCalls();
    assert.equal((await device().fromAddress('127.0.0.2').propfind(`/${TEST_PRINCIPAL}/`)).status, 207);
    // X-Remote-Addr ha la precedenza sul peer (header del proxy pubblico).
    assert.equal((await device().fromAddress('127.0.0.3').withHeaders({ 'X-Remote-Addr': '203.0.113.20' }).propfind(`/${TEST_PRINCIPAL}/`)).status, 207);
    assert.deepEqual((await mock.calls()).map((c) => c.x_forwarded_for), ['127.0.0.2', '203.0.113.20']);
  });

  test('credenziali rifiutate dal backend → 401; backend in errore, lento o senza JSON → 500, mai 401', async () => {
    const { mock } = verify;
    await mock.setState({ mode: 'ok' });
    assert.equal((await rad.server.client(IPHONE.username, 'sbagliata').propfind(`/${TEST_PRINCIPAL}/`)).status, 401);
    assert.equal((await rad.server.client('caldes-svc', 'test-only-svc').propfind(`/${TEST_PRINCIPAL}/`)).status, 401, 'username riservato rifiutato dal backend');

    for (const [mode, delay] of [['unavailable', 0], ['error', 0], ['rate_limited', 0], ['garbage', 0], ['slow', 1_500], ['drop', 0]] as const) {
      await mock.setState({ mode, delay_ms: delay });
      const res = await device().propfind(`/${TEST_PRINCIPAL}/`);
      assert.equal(res.status, 500, `${mode}: atteso 500 (il client riprova senza invalidare la password)`);
    }

    await mock.setState({ mode: 'ok', delay_ms: 0 });
    assert.equal((await device().propfind(`/${TEST_PRINCIPAL}/`)).status, 207, 'dopo il ripristino del backend');
  });
});

// ─── Plugin caldes_auth di F1 ───────────────────────────────

// In F0 qui era congelato il bug del plugin con la firma vecchia di login()
// (500 a ogni richiesta autenticata, design §14). In F1 il plugin è riscritto
// (_login_ext, contratto control-plane §9): la suite completa è pytest
// (apps/radicale/tests/test_auth.py, unità e Radicale reale); qui resta uno
// smoke dal harness Node con il mock in modalità 'username' (l'API di oggi),
// per provare che il principal lo decide il plugin e non il backend.
describe('Radicale reale con il plugin caldes_auth di F1', { skip: radicale.skip || python.skip }, () => {
  const IPHONE = { username: 'iphone', password: 'test-only-app-password-iphone' };
  const MAC = { username: 'mac', password: 'test-only-app-password-mac' };
  const SVC_PASSWORD = 'test-only-svc-password';
  const PROBE_PASSWORD = 'test-only-probe-password';
  // Policy (credential_epoch) e cache persistita in una directory propria. Il
  // before è registrato prima di quelli del mock e di Radicale: gira per primo.
  let controlDir = '';
  before(() => {
    controlDir = mkdtempSync(join(tmpdir(), 'caldes-auth-f1-'));
    writeFileSync(join(controlDir, 'policy.json'), `${JSON.stringify({
      schema: 1,
      version: 1,
      generated_at: new Date().toISOString(),
      backend_mode: 'postgres',
      mode: 'shadow',
      reasons: [],
      principal: TEST_PRINCIPAL,
      volume_id: null,
      epoch: 0,
      credential_epoch: 0,
      readonly: ['bookings', 'scadenze'],
      hidden: ['_canary'],
    }, null, 2)}\n`);
  });
  after(() => {
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
  });

  const verify = useMockVerify({ users: [IPHONE, MAC], principalMode: 'username' });
  const rad = useRadicale(() => ({
    label: 'caldes-auth-f1',
    auth: {
      type: 'plugin',
      module: 'caldes_auth',
      pythonPath: [RADICALE_PLUGINS_DIR],
      env: {
        RADICALE_PRINCIPAL: TEST_PRINCIPAL,
        CALDAV_BACKEND_URL: verify.mock.backendUrl,
        CALDAV_SERVICE_TOKEN: verify.mock.token,
        // 127.0.0.2 fa da rete interna caldav-int; 127.0.0.1 e 127.0.0.3 da gateway.
        CALDES_SVC_CIDR: '127.0.0.2/32',
        CALDES_SVC_PASSWORD_SHA256: sha256(SVC_PASSWORD),
        CALDES_PROBE_PASSWORD_SHA256: sha256(PROBE_PASSWORD),
        CALDES_AUTHCACHE_KEY: 'test-only-authcache-key-0123456789abcdef',
        CALDES_AUTHCACHE_DIR: join(controlDir, 'authcache'),
        CALDES_POLICY_FILE: join(controlDir, 'policy.json'),
      },
    },
  }));

  test('app-password con username non canonico → utente federico anche se il backend risponde con lo username', async () => {
    const { mock } = verify;
    await mock.setState({ mode: 'ok' });
    await mock.clearCalls();
    const client = rad.server.client(IPHONE.username, IPHONE.password).withHeaders({ 'X-Remote-Addr': '203.0.113.10' });
    const root = (await client.propfind('/', { props: [DAV_PROPS.currentUserPrincipal] })).multistatus();
    const href = root.responses[0].element(DAV_PROPS.currentUserPrincipal);
    assert.equal(href && xmlChild(href, NS.DAV, 'href')?.text, `/${TEST_PRINCIPAL}/`);
    assert.equal((await client.propfind(`/${TEST_PRINCIPAL}/`)).status, 207);
    assert.equal((await client.propfind(`/${IPHONE.username}/`)).status, 403, 'nessun principal per lo username del device');
    const calls = await mock.calls();
    assert.equal(calls.length, 1, 'le richieste successive usano la cache di 60 s');
    assert.equal(calls[0].x_forwarded_for, '203.0.113.10');
    assert.match(rad.server.logs(), /Successful login: 'iphone' -> 'federico'/);
    assert.ok(!rad.server.logs().includes(IPHONE.password));
  });

  test('caldes-svc solo dal peer interno; username riservati mai inoltrati a verify-credentials', async (t) => {
    if (!(await canBindLocalAddress('127.0.0.2')) || !(await canBindLocalAddress('127.0.0.3'))) {
      t.skip('127.0.0.2/127.0.0.3 non utilizzabili come indirizzi sorgente su questo sistema');
      return;
    }
    const { mock } = verify;
    await mock.clearCalls();
    const svc = rad.server.client('caldes-svc', SVC_PASSWORD);
    assert.equal((await svc.fromAddress('127.0.0.2').propfind('/')).status, 207);
    assert.equal((await svc.fromAddress('127.0.0.3').propfind('/')).status, 401);
    assert.equal((await svc.propfind('/')).status, 401, '127.0.0.1 vale solo per il probe');
    assert.equal((await rad.server.client('caldes-probe', PROBE_PASSWORD).propfind('/')).status, 207, 'healthcheck da 127.0.0.1');
    assert.equal((await mock.calls()).length, 0);
  });

  test('backend giù senza credenziali in cache → 500, mai 401', async () => {
    const { mock } = verify;
    for (const mode of ['unavailable', 'drop'] as const) {
      await mock.setState({ mode });
      assert.equal((await rad.server.client(MAC.username, MAC.password).propfind(`/${TEST_PRINCIPAL}/`)).status, 500, mode);
    }
    await mock.setState({ mode: 'ok' });
    assert.equal((await rad.server.client(MAC.username, MAC.password).propfind(`/${TEST_PRINCIPAL}/`)).status, 207);
  });
});
