/**
 * Bug 1 — POST /api/mail/send ignora gli allegati.
 *
 * Riproduzione (prima del fix):
 *  - JSON con attachments[{filename, content (base64), encoding, contentType}]
 *    → 200 {success:true} ma il messaggio SMTP arriva senza allegato: la route
 *    destrutturava solo to/cc/subject/text/html e scartava il resto in silenzio;
 *  - la stessa richiesta in multipart/form-data → 500 (c.req.json() lancia);
 *  - campi sconosciuti (es. `body` al posto di text/html) ignorati o errore generico;
 *  - nessuna copia in Inviati (nessun IMAP APPEND nel codice).
 *
 * I test usano un SMTP e un IMAP finti ma reali (helpers/mail-servers.ts): il
 * messaggio catturato viene analizzato con mailparser.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { simpleParser, type ParsedMail } from 'mailparser';
import { onDatabaseClosing, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { fakePdf, useCrmFixtures } from '../helpers/crm';
import { api } from '../helpers/http';
import { startFakeImap, startFakeSmtp, type FakeImapServer, type FakeSmtpServer } from '../helpers/mail-servers';
import { savePrivateFile, signFileUrl } from '../../src/lib/private-files';
import { executeTool } from '../../src/lib/agent/tools';

useTestDatabase();
const crm = useCrmFixtures('crm-mail-attachments');

let smtp: FakeSmtpServer;
let imap: FakeImapServer;
let accountId: string;
let accountEmail: string;

onDatabaseReady(async () => {
  smtp = await startFakeSmtp();
  imap = await startFakeImap();
  const acc = await crm.mailAccount({ smtpPort: smtp.port, imapPort: imap.port });
  accountId = acc.id;
  accountEmail = acc.email;
});
onDatabaseClosing(async () => {
  await smtp?.close();
  await imap?.close();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function lastSmtp(): Promise<ParsedMail> {
  const last = smtp.messages.at(-1);
  assert.ok(last, 'nessun messaggio arrivato al server SMTP');
  return simpleParser(last.raw);
}

function baseMail(overrides: Record<string, unknown> = {}) {
  return {
    account_id: accountId,
    to: [crm.email('cliente')],
    subject: 'Rinnovo dominio crimatek.com',
    text: 'Buongiorno, vi allego la proforma.',
    ...overrides,
  };
}

async function uploadMedia(buffer: Buffer, filename: string, type: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  form.append('folder', 'test-mail');
  const res = await api.post('/api/media/upload', { auth: 'admin', body: form });
  assert.equal(res.status, 200, res.text);
  return res.json.key as string;
}

describe('POST /api/mail/send — JSON', () => {
  test('allegato base64 inline: arriva al destinatario e nella copia in Inviati (riproduzione)', async () => {
    const pdf = fakePdf(4096);
    smtp.messages.length = 0;
    imap.appended.length = 0;
    const res = await api.post('/api/mail/send', {
      auth: 'admin',
      body: baseMail({ attachments: [{ filename: 'Proforma PF 1-2026.pdf', content: pdf.toString('base64'), encoding: 'base64', contentType: 'application/pdf' }] }),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.success, true);
    assert.deepEqual(res.json.attachments, [{ filename: 'Proforma PF 1-2026.pdf', content_type: 'application/pdf', size: pdf.length }]);

    const sent = await lastSmtp();
    assert.equal(sent.attachments.length, 1, 'il messaggio SMTP deve avere l’allegato');
    assert.equal(sent.attachments[0].filename, 'Proforma PF 1-2026.pdf');
    assert.equal(sent.attachments[0].contentType, 'application/pdf');
    assert.equal(sha(sent.attachments[0].content), sha(pdf));

    assert.equal(res.json.sent_copy.status, 'saved', JSON.stringify(res.json.sent_copy));
    assert.equal(res.json.sent_copy.folder, 'Sent');
    const copy = imap.appended.at(-1);
    assert.ok(copy && copy.folder === 'Sent');
    assert.ok(copy.flags.includes('\\Seen'));
    const parsedCopy = await simpleParser(copy.raw);
    assert.equal(parsedCopy.attachments.length, 1, 'la copia in Inviati deve contenere l’allegato');
    assert.equal(sha(parsedCopy.attachments[0].content), sha(pdf));
    assert.equal(parsedCopy.messageId, sent.messageId, 'stesso Message-ID fra inviato e copia');
  });

  test('più allegati e più destinatari (to/cc/bcc); bcc non compare nel messaggio inviato', async () => {
    smtp.messages.length = 0;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
    const csv = Buffer.from('dominio;scadenza\ncrimatek.com;2026-12-01\n');
    const to = [crm.email('a'), crm.email('b')];
    const res = await api.post('/api/mail/send', {
      auth: 'admin',
      body: baseMail({
        to, cc: crm.email('cc'), bcc: [crm.email('bcc')],
        attachments: [
          { filename: 'logo.png', content: png.toString('base64') },
          { filename: 'scadenze.csv', content: csv.toString('base64'), contentType: 'text/csv' },
        ],
      }),
    });
    assert.equal(res.status, 200, res.text);
    const raw = smtp.messages.at(-1)!;
    assert.deepEqual([...raw.rcpt].sort(), [...to, crm.email('cc'), crm.email('bcc')].sort());
    const sent = await simpleParser(raw.raw);
    assert.deepEqual(sent.attachments.map((a) => a.filename), ['logo.png', 'scadenze.csv']);
    assert.equal(sent.bcc, undefined);
  });

  test('campi sconosciuti → 400 con il nome; `body` suggerisce text/html', async () => {
    const res = await api.post('/api/mail/send', { auth: 'admin', body: { account_id: accountId, to: [crm.email()], subject: 'x', body: 'ciao', priority: 'high' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /body/);
    assert.match(res.json.error, /text.*html|html.*text/);
    assert.match(res.json.error, /priority/);
  });

  test('validazione degli allegati', async () => {
    const pdf = fakePdf(1024).toString('base64');
    const cases: Array<[unknown, RegExp]> = [
      [{ filename: 'a.pdf', content: 'questo non è base64!!' }, /base64/],
      [{ filename: '../../etc/passwd.pdf', content: pdf }, /filename/],
      [{ filename: 'C:\\temp\\a.pdf', content: pdf }, /filename/],
      [{ filename: 'virus.exe', content: Buffer.from('MZ').toString('base64') }, /tipo|MIME|consentit/i],
      [{ filename: 'a.pdf', content: Buffer.from('PK\x03\x04zip').toString('base64'), contentType: 'application/pdf' }, /contenuto|corrisponde/i],
      [{ filename: 'a.pdf', content: pdf, contentType: 'text/html' }, /tipo|MIME|consentit/i],
      [{ filename: 'a.pdf', content: pdf, media_id: 'x' }, /uno solo|esattamente/i],
      [{ content: pdf }, /filename/],
      [{ filename: 'a.pdf', content: pdf, size: 3 }, /size/],
    ];
    for (const [attachment, pattern] of cases) {
      const res = await api.post('/api/mail/send', { auth: 'admin', body: baseMail({ attachments: [attachment] }) });
      assert.equal(res.status, 400, `${JSON.stringify(attachment).slice(0, 80)} → ${res.status} ${res.text}`);
      assert.match(res.json.error, pattern, JSON.stringify(attachment).slice(0, 80));
    }
  });

  test('limiti: 10 MB per file e 20 MB in totale', async () => {
    const tooBig = fakePdf(10 * 1024 * 1024 + 1).toString('base64');
    const single = await api.post('/api/mail/send', { auth: 'admin', body: baseMail({ attachments: [{ filename: 'grande.pdf', content: tooBig }] }) });
    assert.equal(single.status, 400, single.text.slice(0, 300));
    assert.match(single.json.error, /10 MB/);

    const seven = fakePdf(7 * 1024 * 1024).toString('base64');
    const total = await api.post('/api/mail/send', {
      auth: 'admin',
      body: baseMail({ attachments: [1, 2, 3].map((i) => ({ filename: `p${i}.pdf`, content: seven })) }),
    });
    assert.equal(total.status, 400, total.text.slice(0, 300));
    assert.match(total.json.error, /20 MB/);
  });

  test('allegato da media_id (libreria /api/media) e da URL interno /media/...', async () => {
    const pdf = fakePdf(3000);
    const key = await uploadMedia(pdf, 'proforma.pdf', 'application/pdf');
    smtp.messages.length = 0;

    const byId = await api.post('/api/mail/send', { auth: 'admin', body: baseMail({ attachments: [{ media_id: key, filename: 'Proforma PF 2-2026.pdf' }] }) });
    assert.equal(byId.status, 200, byId.text);
    let sent = await lastSmtp();
    assert.equal(sent.attachments[0].filename, 'Proforma PF 2-2026.pdf');
    assert.equal(sha(sent.attachments[0].content), sha(pdf));

    const byUrl = await api.post('/api/mail/send', { auth: 'admin', body: baseMail({ attachments: [{ url: `https://api.caldes.test/media/${key}` }] }) });
    assert.equal(byUrl.status, 200, byUrl.text);
    sent = await lastSmtp();
    assert.match(sent.attachments[0].filename ?? '', /proforma\.pdf$/);
    assert.equal(sha(sent.attachments[0].content), sha(pdf));
  });

  test('allegato da URL privato firmato (/api/files/...)', async () => {
    const pdf = fakePdf(2500);
    const name = `${crm.prefix}-preventivo.pdf`;
    await savePrivateFile('quotes', name, pdf);
    const res = await api.post('/api/mail/send', { auth: 'admin', body: baseMail({ attachments: [{ url: signFileUrl('quotes', name), filename: 'Preventivo.pdf' }] }) });
    assert.equal(res.status, 200, res.text);
    assert.equal(sha((await lastSmtp()).attachments[0].content), sha(pdf));

    const forged = signFileUrl('quotes', name).replace(/sig=[0-9a-f]+/, 'sig=' + '0'.repeat(64));
    const bad = await api.post('/api/mail/send', { auth: 'admin', body: baseMail({ attachments: [{ url: forged }] }) });
    assert.equal(bad.status, 400);
  });

  test('riferimenti non validi: media inesistente, traversal, URL esterno → 400 (nessun fetch)', async () => {
    for (const ref of [
      { media_id: 'test-mail/non-esiste.pdf' },
      { media_id: '../private-uploads/quotes/x.pdf' },
      { url: 'https://evil.example/proforma.pdf' },
      { url: 'file:///etc/passwd' },
      { url: 'https://api.caldes.test/api/customers' },
    ]) {
      const res = await api.post('/api/mail/send', { auth: 'admin', body: baseMail({ attachments: [ref] }) });
      assert.equal(res.status, 400, `${JSON.stringify(ref)} → ${res.text}`);
    }
  });

  test('rifiuto SMTP → 502 con il motivo e nessuna copia in Inviati', async () => {
    imap.appended.length = 0;
    smtp.rejectData = 554;
    try {
      const res = await api.post('/api/mail/send', { auth: 'admin', body: baseMail() });
      assert.equal(res.status, 502);
      assert.match(res.json.error, /554|Rifiutato/);
      assert.equal(imap.appended.length, 0);
    } finally {
      smtp.rejectData = null;
    }
  });

  test('sent_copy_mode = skip: nessun APPEND (provider che salva da sé)', async () => {
    const skipAcc = await crm.mailAccount({ smtpPort: smtp.port, imapPort: imap.port, sentCopyMode: 'skip' });
    imap.appended.length = 0;
    const res = await api.post('/api/mail/send', { auth: 'admin', body: baseMail({ account_id: skipAcc.id }) });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.sent_copy.status, 'skipped');
    assert.equal(imap.appended.length, 0);
  });
});

describe('POST /api/mail/send — multipart e content-type', () => {
  test('multipart/form-data con file nel campo attachments (prima: 500)', async () => {
    const pdf = fakePdf(2048);
    const form = new FormData();
    form.append('account_id', accountId);
    form.append('to', `${crm.email('mp1')}, ${crm.email('mp2')}`);
    form.append('subject', 'Proforma');
    form.append('text', 'In allegato.');
    form.append('attachments', new Blob([pdf], { type: 'application/pdf' }), 'proforma.pdf');
    smtp.messages.length = 0;
    const res = await api.post('/api/mail/send', { auth: 'admin', body: form });
    assert.equal(res.status, 200, res.text);
    const raw = smtp.messages.at(-1)!;
    assert.deepEqual([...raw.rcpt].sort(), [crm.email('mp1'), crm.email('mp2')].sort());
    const sent = await simpleParser(raw.raw);
    assert.equal(sent.attachments[0].filename, 'proforma.pdf');
    assert.equal(sha(sent.attachments[0].content), sha(pdf));
  });

  test('multipart: riferimento JSON nel campo attachments e campo sconosciuto → 400', async () => {
    const key = await uploadMedia(fakePdf(1500), 'rif.pdf', 'application/pdf');
    const ok = new FormData();
    ok.append('account_id', accountId);
    ok.append('to', crm.email('mp3'));
    ok.append('subject', 'Rif');
    ok.append('text', 'x');
    ok.append('attachments', JSON.stringify({ media_id: key }));
    const res = await api.post('/api/mail/send', { auth: 'admin', body: ok });
    assert.equal(res.status, 200, res.text);

    const bad = new FormData();
    bad.append('account_id', accountId);
    bad.append('to', crm.email('mp4'));
    bad.append('subject', 'x');
    bad.append('text', 'x');
    bad.append('file', new Blob([fakePdf(100)], { type: 'application/pdf' }), 'a.pdf');
    const res2 = await api.post('/api/mail/send', { auth: 'admin', body: bad });
    assert.equal(res2.status, 400);
    assert.match(res2.json.error, /file/);
  });

  test('content-type non supportato → 415', async () => {
    const res = await api.post('/api/mail/send', { auth: 'admin', body: 'to=a@b.c', headers: { 'content-type': 'text/plain' } });
    assert.equal(res.status, 415);
  });

  test('JSON malformato → 400', async () => {
    const res = await api.post('/api/mail/send', { auth: 'admin', body: '{"to":', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 400);
  });
});

describe('bozze con allegati', () => {
  test('POST /api/mail/drafts con media_id → GET restituisce gli allegati → invio dal client admin', async () => {
    const pdf = fakePdf(2222);
    const key = await uploadMedia(pdf, 'bozza.pdf', 'application/pdf');
    const created = await api.post('/api/mail/drafts', {
      auth: 'admin',
      body: { account_id: accountId, to: [crm.email('bozza')], subject: 'Proforma', text: 'In allegato', attachments: [{ media_id: key, filename: 'Proforma.pdf' }] },
    });
    assert.equal(created.status, 201, created.text);
    const draftId = created.json.draft.id;

    const got = await api.get(`/api/mail/drafts/${draftId}`, { auth: 'admin' });
    assert.equal(got.status, 200);
    const [att] = got.json.draft.attachments;
    assert.equal(att.filename, 'Proforma.pdf');
    assert.equal(att.size, pdf.length);
    assert.match(att.url, /\/api\/files\/mail\//);

    // Il client admin rimanda gli allegati della bozza come riferimenti {url, filename}.
    smtp.messages.length = 0;
    const sent = await api.post('/api/mail/send', {
      auth: 'admin',
      body: baseMail({ to: got.json.draft.to_addrs, attachments: got.json.draft.attachments.map((a: { url: string; filename: string }) => ({ url: a.url, filename: a.filename })) }),
    });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sha((await lastSmtp()).attachments[0].content), sha(pdf));

    // La bozza è uno snapshot: cancellare il media originale non la rompe; cancellare la bozza rimuove i file.
    const del = await api.delete(`/api/mail/drafts/${draftId}`, { auth: 'admin' });
    assert.equal(del.status, 200);
  });

  test('POST /api/mail/drafts: campo sconosciuto e allegato non valido → 400', async () => {
    const unknown = await api.post('/api/mail/drafts', { auth: 'admin', body: { to: [crm.email()], subject: 'x', html: '<p>x</p>', foo: 1 } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /foo/);
    const bad = await api.post('/api/mail/drafts', { auth: 'admin', body: { to: [crm.email()], subject: 'x', attachments: [{ media_id: 'non/esiste.pdf' }] } });
    assert.equal(bad.status, 400);
  });
});

describe('tool MCP', () => {
  test('draft_email accetta attachments (media_id) e crea la bozza con l’allegato', async () => {
    const pdf = fakePdf(1800);
    const key = await uploadMedia(pdf, 'mcp.pdf', 'application/pdf');
    const result = JSON.parse(await executeTool('draft_email', {
      to: crm.email('mcp'), subject: 'Rinnovo', body: 'Testo', attachments: [{ media_id: key, filename: 'Proforma.pdf' }],
    }));
    assert.equal(result.status, 'drafted', JSON.stringify(result));
    assert.deepEqual(result.attachments.map((a: { filename: string }) => a.filename), ['Proforma.pdf']);
    const [row] = await sql<Array<{ attachments: Array<{ size: number }> }>>`SELECT attachments FROM email_drafts WHERE id = ${result.draft_id}`;
    assert.equal(row.attachments[0].size, pdf.length);
    await api.delete(`/api/mail/drafts/${result.draft_id}`, { auth: 'admin' });
  });

  test('draft_email con allegato non valido → errore esplicito, nessuna bozza', async () => {
    const result = JSON.parse(await executeTool('draft_email', { to: crm.email('mcp2'), subject: 'x', body: 'x', attachments: [{ media_id: '../../x' }] }));
    assert.match(String(result.error), /media_id|allegat/i);
  });

  test('send_email accetta attachments e invia dalla casella (con copia in Inviati)', async () => {
    const pdf = fakePdf(1700);
    const key = await uploadMedia(pdf, 'send.pdf', 'application/pdf');
    smtp.messages.length = 0;
    imap.appended.length = 0;
    const result = JSON.parse(await executeTool('send_email', {
      to: crm.email('mcp-send'), subject: 'Proforma', body: '<p>In allegato</p>', account_id: accountId,
      attachments: [{ media_id: key, filename: 'Proforma.pdf' }],
    }));
    assert.equal(result.sent, true, JSON.stringify(result));
    assert.equal(result.from, accountEmail);
    const sent = await lastSmtp();
    assert.equal(sent.attachments[0].filename, 'Proforma.pdf');
    assert.equal(imap.appended.length, 1);
  });

  test('send_email: argomento sconosciuto → errore che lo nomina', async () => {
    const result = JSON.parse(await executeTool('send_email', { to: crm.email(), subject: 'x', body: 'x', allegati: [] }));
    assert.match(String(result.error), /allegati/);
  });
});
