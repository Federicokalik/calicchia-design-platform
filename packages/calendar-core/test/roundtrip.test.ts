/**
 * serialize.ts e round-trip parse → serialize → parse: fedeltà completa
 * (VALARM, ATTENDEE con parametri, X-APPLE-STRUCTURED-LOCATION, proprietà e
 * componenti sconosciuti), forma canonica (CRLF, folding a 75 ottetti, PRODID
 * stabile, VTIMEZONE canonici dal registro) e idempotenza.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import {
  CALDES_PRODID,
  canonicalVtimezone,
  createCalendarObject,
  createComponent,
  createProperty,
  encodeText,
  foldLine,
  getProperty,
  type IcsComponent,
  parseCalendarObjectOrThrow,
  parseIcsOrThrow,
  readEvent,
  SerializeError,
  serializeCalendar,
  serializeComponent,
  serializeObject,
  serializeProperty,
  vtimezoneTzid,
} from '../src/index';
import { assertPhysicalForm, fixture, ics } from './helpers';

const FIXTURES = [
  'apple-fidelity.ics',
  'outlook-windows-tz.ics',
  'thunderbird-mozilla-tz.ics',
  'custom-tz.ics',
  'google-feed.ics',
  'legacy-booking-request.ics',
  'legacy-booking-cancel.ics',
  'legacy-feed.ics',
  'legacy-resource.ics',
];

function withoutTimezones(c: IcsComponent): IcsComponent {
  return { ...c, components: c.components.filter((x) => x.name !== 'VTIMEZONE') };
}

describe('round-trip con fedeltà', () => {
  for (const name of FIXTURES) {
    test(`${name}: con 'preserve' il secondo parse è identico al primo`, () => {
      const first = parseIcsOrThrow(fixture(name));
      const text = serializeCalendar(first, { prodid: 'preserve', timezones: 'preserve' });
      assertPhysicalForm(text);
      const second = parseIcsOrThrow(text);
      // VERSION e PRODID vanno in testa: a parte l'ordine dell'intestazione l'albero è lo stesso.
      const rank = (name: string): number => (name === 'VERSION' ? 0 : name === 'PRODID' ? 1 : 2);
      const sortHeader = (c: IcsComponent): IcsComponent => ({
        ...c,
        properties: c.properties.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.name) - rank(b.p.name) || a.i - b.i).map((x) => x.p),
      });
      assert.deepEqual(sortHeader(second), sortHeader(first));
    });

    test(`${name}: forma canonica idempotente e senza perdite fuori dai VTIMEZONE`, () => {
      const first = parseIcsOrThrow(fixture(name));
      const canonical = serializeCalendar(first);
      assertPhysicalForm(canonical);
      const reparsed = parseIcsOrThrow(canonical);
      assert.equal(serializeCalendar(reparsed), canonical, 'serializzare due volte dà lo stesso testo');
      assert.equal(getProperty(reparsed, 'VERSION')?.value, '2.0');
      assert.equal(getProperty(reparsed, 'PRODID')?.value, CALDES_PRODID);
      assert.equal(reparsed.properties[0].name, 'VERSION');
      assert.equal(reparsed.properties[1].name, 'PRODID');
      const strip = (c: IcsComponent): IcsComponent => ({
        ...withoutTimezones(c),
        properties: c.properties.filter((p) => p.name !== 'PRODID' && p.name !== 'VERSION'),
      });
      assert.deepEqual(strip(reparsed), strip(first));
    });
  }

  test('fixture Apple: la vista tipizzata è la stessa prima e dopo il round-trip', () => {
    const obj = parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
    const again = parseCalendarObjectOrThrow(serializeObject(obj));
    const a = readEvent(obj.master!);
    const b = readEvent(again.master!);
    assert.deepEqual({ ...b, alarms: b.alarms.length }, { ...a, alarms: a.alarms.length });
    assert.equal(a.attendees[0].cn, 'Rossi, Mario');
    assert.equal(a.organizer?.cn, 'Calicchia, Federico');
    assert.equal(a.alarms.length, 2);
    assert.equal(a.sequence, 3);
    assert.equal(getProperty(again.master!, 'X-APPLE-STRUCTURED-LOCATION')?.value, 'geo:41.890251,12.492373');
    assert.equal(getProperty(again.master!, 'NEWIANAPROP')?.params[0].values.join('|'), 'a:b;c|x');
  });

  test('parametri: virgolette solo se servono, VALUE in maiuscolo', () => {
    const line = serializeProperty(
      createProperty('ATTENDEE', 'mailto:a@example.com', [
        { name: 'CN', values: ['Rossi, Mario'] },
        { name: 'ROLE', values: ['REQ-PARTICIPANT'] },
        { name: 'DELEGATED-FROM', values: ['mailto:x@example.com', 'mailto:y@example.com'] },
      ]),
    );
    assert.equal(
      line.replace(/\r\n /g, ''),
      'ATTENDEE;CN="Rossi, Mario";ROLE=REQ-PARTICIPANT;DELEGATED-FROM="mailto:x@example.com","mailto:y@example.com":mailto:a@example.com',
    );
    assert.ok(line.split('\r\n').every((l) => new TextEncoder().encode(l).byteLength <= 75));
    assert.equal(serializeProperty(createProperty('DTSTART', '20261009', { value: 'date' })), 'DTSTART;VALUE=DATE:20261009');
  });

  test('override ordinati per recurrence key', () => {
    const master = createComponent('VEVENT', [
      createProperty('UID', 'o'),
      createProperty('DTSTART', '20261009T090000', { TZID: 'Europe/Rome' }),
      createProperty('RRULE', 'FREQ=DAILY'),
    ]);
    const ov = (d: string) =>
      createComponent('VEVENT', [createProperty('UID', 'o'), createProperty('RECURRENCE-ID', `${d}T090000`, { TZID: 'Europe/Rome' }), createProperty('DTSTART', `${d}T100000`, { TZID: 'Europe/Rome' })]);
    const obj = createCalendarObject({ uid: 'o', master, overrides: [ov('20261012'), ov('20261010'), ov('20261011')] });
    const text = serializeObject(obj);
    const order = [...text.matchAll(/RECURRENCE-ID;TZID=Europe\/Rome:(\d{8})/g)].map((m) => m[1]);
    assert.deepEqual(order, ['20261010', '20261011', '20261012']);
    assert.match(text, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Rome\r\n/);
  });
});

describe('folding UTF-8 a 75 ottetti', () => {
  const pieces = ['à', '€', '😀', 'x', 'È', '👩‍💻'];

  test('nessuna riga oltre 75 ottetti e nessun code point spezzato, per ogni allineamento', () => {
    for (let prefix = 0; prefix < 80; prefix++) {
      for (const piece of pieces) {
        const text = `${'a'.repeat(prefix)}${piece.repeat(60)} fine`;
        const comp = createComponent('VEVENT', [createProperty('UID', 'f'), createProperty('DESCRIPTION', encodeText(text))]);
        const out = serializeComponent(comp);
        assertPhysicalForm(out);
        const back = parseIcsOrThrow(`BEGIN:VCALENDAR\r\n${out}END:VCALENDAR\r\n`);
        assert.equal(readEvent({ ...back.components[0], properties: [...back.components[0].properties, createProperty('DTSTART', '20261009T090000Z')] }).description, text);
      }
    }
  });

  test('una riga corta non viene piegata; una lunga sì, con continuazioni da 74 ottetti più lo spazio', () => {
    assert.equal(foldLine('SUMMARY:breve'), 'SUMMARY:breve');
    const long = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = foldLine(long).split('\r\n');
    assert.equal(folded[0].length, 75);
    assert.ok(folded.slice(1).every((l) => l.startsWith(' ') && l.length <= 75));
    assert.equal(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join(''), long);
  });

  // Spazi bianchi di Python (str.isspace): vobject chiude la riga logica su una
  // riga fisica con rstrip() vuoto, Radicale cancella le righe di soli spazi e tab.
  const PY_SPACES = [' ', '\t', '\u00a0', '\u3000', '\u2003', '\u202f', '\u205f', '\u1680', '\u0085', '\u2028'];
  const PY_BLANK_RE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
  const unfold = (folded: string): string => folded.split('\r\n').map((l, i) => (i === 0 ? l : l.slice(1))).join('');

  test('nessuna continuazione fatta di soli spazi bianchi (spazi, NBSP, U+3000...), per ogni allineamento', () => {
    for (const space of PY_SPACES) {
      for (const run of [74, 75, 129, 200, 400]) {
        for (let prefix = 0; prefix < 80; prefix += 1) {
          const long = `DESCRIPTION:${'a'.repeat(prefix)}${space.repeat(run)}fine`;
          const folded = foldLine(long);
          const physical = folded.split('\r\n');
          for (let i = 1; i < physical.length; i++) {
            assert.ok(physical[i].startsWith(' '), 'continuazione senza spazio iniziale');
            assert.ok(!PY_BLANK_RE.test(physical[i]), `continuazione di soli spazi bianchi (${JSON.stringify(space)}, run ${run}, prefisso ${prefix})`);
          }
          assert.equal(unfold(folded), long);
          // Spazi in coda: il tratto finale resta sulla riga precedente.
          const tail = `DESCRIPTION:x${space.repeat(run)}`;
          const foldedTail = foldLine(tail);
          for (const l of foldedTail.split('\r\n').slice(1)) assert.ok(!PY_BLANK_RE.test(l), 'coda di soli spazi bianchi');
          assert.equal(unfold(foldedTail), tail);
        }
      }
    }
  });

  test('senza sequenze di spazi bianchi il folding resta a 75 ottetti', () => {
    const long = `DESCRIPTION:${'parola '.repeat(60)}`;
    for (const l of foldLine(long).split('\r\n')) assert.ok(new TextEncoder().encode(l).byteLength <= 75);
  });

  test('round-trip con vobject come in Radicale (read_components), se disponibile', (t) => {
    const python = process.env.CALDES_PYTHON || 'python3';
    try {
      execFileSync(python, ['-c', 'import vobject'], { stdio: 'ignore' });
    } catch {
      t.skip(`vobject non disponibile per ${python} (CALDES_PYTHON)`);
      return;
    }
    const values = [
      `Tabella:${' '.repeat(129)}fine colonna`,
      `Consulenza – Mario${'\u00a0'.repeat(80)}Rossi`,
      `x${'\u3000'.repeat(120)}y`,
      `coda${' '.repeat(150)}`,
    ];
    const texts = values.map((v, i) => {
      const comp = createComponent('VEVENT', [
        createProperty('UID', `fold-${i}@caldes.test`),
        createProperty('DTSTAMP', '20261009T080000Z'),
        createProperty('DTSTART', '20261009T090000Z'),
        createProperty('SUMMARY', encodeText(v)),
      ]);
      return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//IT\r\n${serializeComponent(comp)}END:VCALENDAR\r\n`;
    });
    // Stessa pulizia di radicale.item.read_components, poi vobject.readComponents.
    const script = [
      'import json, re, sys, vobject',
      'out = []',
      'for s in json.loads(sys.stdin.read()):',
      "    s = re.sub(r'(?m)^[ \\t]*\\r?\\n', '', s)",
      '    try:',
      '        comp = list(vobject.readComponents(s, allowQP=True))[0]',
      '        out.append(comp.vevent.summary.value)',
      '    except Exception as exc:',
      "        out.append('ERRORE: %r' % (exc,))",
      'sys.stdout.write(json.dumps(out))',
    ].join('\n');
    const got = JSON.parse(execFileSync(python, ['-I', '-c', script], { input: JSON.stringify(texts) }).toString()) as string[];
    assert.deepEqual(got, values);
  });
});

describe('VTIMEZONE canonici', () => {
  test('TZID IANA con VTIMEZONE non canonico (Apple) → canonico del registro', () => {
    const obj = parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
    const out = parseIcsOrThrow(serializeObject(obj));
    const tzs = out.components.filter((c) => c.name === 'VTIMEZONE');
    assert.equal(tzs.length, 1);
    assert.deepEqual(tzs[0], canonicalVtimezone('Europe/Rome'));
    assert.equal(getProperty(tzs[0], 'X-LIC-LOCATION')?.value, 'Europe/Rome');
    assert.equal(getProperty(tzs[0], 'LAST-MODIFIED'), null, 'LAST-MODIFIED del registro rimosso');
    // Con 'preserve' resta quello del client.
    const kept = parseIcsOrThrow(serializeObject(obj, { timezones: 'preserve' }));
    assert.equal(getProperty(kept.components.find((c) => c.name === 'VTIMEZONE')!.components[0], 'DTSTART')?.value, '19810329T020000');
  });

  test('nome Windows: resta il VTIMEZONE di Outlook', () => {
    const obj = parseCalendarObjectOrThrow(fixture('outlook-windows-tz.ics'));
    const out = parseIcsOrThrow(serializeObject(obj));
    const tz = out.components.find((c) => c.name === 'VTIMEZONE')!;
    assert.deepEqual(tz, obj.timezones[0]);
    assert.match(serializeObject(obj), /DTSTART;TZID=W\. Europe Standard Time:20261110T100000/);
  });

  test('nome Windows senza VTIMEZONE nell\'oggetto → canonico della zona mappata con lo stesso TZID', () => {
    const obj = parseCalendarObjectOrThrow(
      ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:w', 'DTSTART;TZID=Romance Standard Time:20261009T090000', 'END:VEVENT', 'END:VCALENDAR']),
    );
    const tz = parseIcsOrThrow(serializeObject(obj)).components.find((c) => c.name === 'VTIMEZONE')!;
    assert.equal(vtimezoneTzid(tz), 'Romance Standard Time');
    assert.equal(getProperty(tz, 'X-LIC-LOCATION')?.value, 'Europe/Paris');
  });

  test('prefisso Mozilla: VTIMEZONE canonico con il TZID scritto dal client', () => {
    const obj = parseCalendarObjectOrThrow(fixture('thunderbird-mozilla-tz.ics'));
    const tz = parseIcsOrThrow(serializeObject(obj)).components.find((c) => c.name === 'VTIMEZONE')!;
    assert.equal(vtimezoneTzid(tz), '/mozilla.org/20070129_1/Europe/Rome');
    assert.deepEqual(tz.components, canonicalVtimezone('Europe/Rome')!.components);
  });

  test('VTIMEZONE personalizzati referenziati restano, quelli non referenziati spariscono', () => {
    const obj = parseCalendarObjectOrThrow(fixture('custom-tz.ics'));
    const out = parseIcsOrThrow(serializeObject(obj));
    const ids = out.components.filter((c) => c.name === 'VTIMEZONE').map(vtimezoneTzid);
    assert.deepEqual(ids, ['Fuso fisso +0530', 'Ora di Roma (personalizzata)']);
    const preserved = parseIcsOrThrow(serializeObject(obj, { timezones: 'preserve' }));
    assert.equal(preserved.components.filter((c) => c.name === 'VTIMEZONE').length, 3);
  });

  test('TZID sconosciuto senza VTIMEZONE: nessun VTIMEZONE inventato, riferimenti invariati', () => {
    const obj = parseCalendarObjectOrThrow(
      ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u', 'DTSTART;TZID=Fuso Inesistente:20261009T090000', 'END:VEVENT', 'END:VCALENDAR']),
    );
    const text = serializeObject(obj);
    assert.ok(!text.includes('BEGIN:VTIMEZONE'));
    assert.match(text, /DTSTART;TZID=Fuso Inesistente:20261009T090000/);
  });

  test('floating e UTC: nessun VTIMEZONE', () => {
    const obj = parseCalendarObjectOrThrow(
      ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:f', 'DTSTART:20261009T090000', 'DTEND:20261009T100000Z', 'END:VEVENT', 'END:VCALENDAR']),
    );
    assert.ok(!serializeObject(obj).includes('VTIMEZONE'));
  });
});

describe('serialize: PRODID ed errori', () => {
  test('PRODID stabile, oppure conservato su richiesta', () => {
    const obj = parseCalendarObjectOrThrow(fixture('outlook-windows-tz.ics'));
    assert.match(serializeObject(obj), /\r\nPRODID:-\/\/Caldes\/\/calendar-core\/\/IT\r\n/);
    assert.match(serializeObject(obj, { prodid: 'preserve' }), /PRODID:-\/\/Microsoft Corporation\/\/Outlook 16\.0 MIMEDIR\/\/EN/);
    assert.match(serializeObject(obj, { prodid: '-//Test//X//IT' }), /PRODID:-\/\/Test\/\/X\/\/IT/);
  });

  test('valori con a capo, nomi non validi e virgolette nei parametri → SerializeError', () => {
    const isSerializeError = (code: string) => (err: unknown) => err instanceof SerializeError && err.code === code;
    assert.throws(() => serializeProperty(createProperty('SUMMARY', 'riga\nnuova')), isSerializeError('INVALID_VALUE'));
    assert.throws(() => serializeProperty({ name: 'NOME NON VALIDO', params: [], value: 'x' }), isSerializeError('INVALID_NAME'));
    assert.throws(() => serializeProperty(createProperty('X-A', 'x', { CN: 'con "virgolette"' })), isSerializeError('INVALID_PARAMETER'));
    assert.throws(
      () => serializeObject(createCalendarObject({ uid: 'vuoto', master: null })),
      isSerializeError('INVALID_OBJECT'),
    );
  });
});
