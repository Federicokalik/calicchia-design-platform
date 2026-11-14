/**
 * Server SMTP e IMAP minimali, in-process su 127.0.0.1 e porta effimera, per
 * provare l'invio reale delle email (nodemailer → SMTP) e la copia nella
 * cartella Inviati (imapflow → IMAP APPEND) senza servizi esterni.
 *
 * Implementano solo ciò che usano i client della route di invio:
 *  - SMTP: EHLO/HELO, AUTH PLAIN e LOGIN, MAIL, RCPT, DATA (con dot-unstuffing),
 *    RSET, NOOP, QUIT. Niente STARTTLS: nodemailer con secure=false prosegue in
 *    chiaro se il server non lo annuncia.
 *  - IMAP: CAPABILITY, LOGIN, LIST (INBOX e Sent con \Sent), SELECT/EXAMINE,
 *    SEARCH/UID SEARCH per HEADER Message-ID, APPEND con literal sincrono,
 *    LOGOUT; ogni altro comando riceve OK (tollerante verso le estensioni).
 *
 * I messaggi ricevuti restano in memoria (`messages`, `appended`) come Buffer
 * grezzi: i test li analizzano con mailparser.
 */

import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

export interface CapturedSmtpMessage {
  from: string;
  rcpt: string[];
  raw: Buffer;
  auth: { user: string; pass: string } | null;
}

export interface FakeSmtpServer {
  port: number;
  messages: CapturedSmtpMessage[];
  /** Se impostato, la DATA viene rifiutata con questo codice (es. 554). */
  rejectData: number | null;
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const s of sockets) s.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startFakeSmtp(): Promise<FakeSmtpServer> {
  const sockets = new Set<Socket>();
  const state: FakeSmtpServer = {
    port: 0,
    messages: [],
    rejectData: null,
    close: () => closeServer(server, sockets),
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('latin1');
    let buffer = '';
    let mode: 'command' | 'data' | 'auth-login-user' | 'auth-login-pass' = 'command';
    let from = '';
    let rcpt: string[] = [];
    let auth: CapturedSmtpMessage['auth'] = null;
    let loginUser = '';
    const write = (line: string) => socket.write(`${line}\r\n`);

    write('220 smtp.caldes.test ESMTP fake');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const body = buffer.slice(0, end + 2).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          mode = 'command';
          if (state.rejectData) {
            write(`${state.rejectData} 5.7.1 Rifiutato dal server di test`);
          } else {
            state.messages.push({ from, rcpt, raw: Buffer.from(body, 'latin1'), auth });
            write('250 2.0.0 Ok: queued');
          }
          from = '';
          rcpt = [];
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);

        if (mode === 'auth-login-user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          mode = 'auth-login-pass';
          write('334 UGFzc3dvcmQ6');
          continue;
        }
        if (mode === 'auth-login-pass') {
          auth = { user: loginUser, pass: Buffer.from(line, 'base64').toString('utf8') };
          mode = 'command';
          write('235 2.7.0 Authentication successful');
          continue;
        }

        const [verb, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO':
            socket.write('250-smtp.caldes.test\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 52428800\r\n');
            break;
          case 'HELO':
            write('250 smtp.caldes.test');
            break;
          case 'AUTH': {
            const [mech, initial] = arg.split(' ');
            if (mech.toUpperCase() === 'PLAIN' && initial) {
              const [, user, pass] = Buffer.from(initial, 'base64').toString('utf8').split('\0');
              auth = { user, pass };
              write('235 2.7.0 Authentication successful');
            } else if (mech.toUpperCase() === 'LOGIN') {
              mode = 'auth-login-user';
              write('334 VXNlcm5hbWU6');
            } else {
              write('504 5.5.4 Meccanismo non supportato');
            }
            break;
          }
          case 'MAIL':
            from = /<([^>]*)>/.exec(arg)?.[1] ?? '';
            write('250 2.1.0 Ok');
            break;
          case 'RCPT':
            rcpt.push(/<([^>]*)>/.exec(arg)?.[1] ?? '');
            write('250 2.1.5 Ok');
            break;
          case 'DATA':
            mode = 'data';
            write('354 End data with <CR><LF>.<CR><LF>');
            break;
          case 'RSET':
            from = '';
            rcpt = [];
            write('250 2.0.0 Ok');
            break;
          case 'NOOP':
            write('250 2.0.0 Ok');
            break;
          case 'QUIT':
            write('221 2.0.0 Bye');
            socket.end();
            return;
          default:
            write('502 5.5.2 Comando non riconosciuto');
        }
      }
    });
  });

  state.port = await listen(server);
  return state;
}

export interface AppendedImapMessage {
  folder: string;
  flags: string[];
  raw: Buffer;
}

export interface FakeImapServer {
  port: number;
  /** Messaggi aggiunti con APPEND, nell'ordine di arrivo. */
  appended: AppendedImapMessage[];
  /** Comandi ricevuti (senza tag), utili per diagnosticare. */
  commands: string[];
  /** Cartelle annunciate da LIST: la seconda ha l'attributo \Sent. */
  folders: { inbox: string; sent: string };
  close(): Promise<void>;
}

export async function startFakeImap(opts: { sentFolder?: string } = {}): Promise<FakeImapServer> {
  const sockets = new Set<Socket>();
  const state: FakeImapServer = {
    port: 0,
    appended: [],
    commands: [],
    folders: { inbox: 'INBOX', sent: opts.sentFolder ?? 'Sent' },
    close: () => closeServer(server, sockets),
  };

  const messageIdOf = (raw: Buffer): string | null =>
    /^message-id:\s*(<[^>]+>)/im.exec(raw.toString('latin1'))?.[1] ?? null;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let literal: { tag: string; folder: string; flags: string[]; size: number } | null = null;
    let selected: string | null = null;
    const write = (text: string) => socket.write(`${text}\r\n`);

    write('* OK [CAPABILITY IMAP4rev1] Fake IMAP pronto');

    const handle = (line: string): void => {
      const m = /^(\S+)\s+(UID\s+)?(\S+)\s*(.*)$/i.exec(line);
      if (!m) return;
      const [, tag, uidPrefix, rawVerb, args] = m;
      const verb = rawVerb.toUpperCase();
      state.commands.push(`${uidPrefix ? 'UID ' : ''}${verb} ${args}`.trim());
      const unquote = (s: string) => s.replace(/^"(.*)"$/, '$1');

      switch (verb) {
        case 'CAPABILITY':
          write('* CAPABILITY IMAP4rev1');
          write(`${tag} OK CAPABILITY completato`);
          return;
        case 'LOGIN':
          write(`${tag} OK [CAPABILITY IMAP4rev1] Accesso eseguito`);
          return;
        case 'LIST':
        case 'LSUB':
          // LIST "" "": solo delimitatore e radice (lo usa imapflow senza NAMESPACE).
          if (/^""\s+""$/.test(args.trim())) {
            write(`* ${verb} (\\Noselect) "/" ""`);
            write(`${tag} OK ${verb} completato`);
            return;
          }
          write(`* ${verb} (\\HasNoChildren) "/" "${state.folders.inbox}"`);
          write(`* ${verb} (\\HasNoChildren \\Sent) "/" "${state.folders.sent}"`);
          write(`${tag} OK ${verb} completato`);
          return;
        case 'SELECT':
        case 'EXAMINE': {
          selected = unquote(args.trim());
          const count = state.appended.filter((a) => a.folder === selected).length;
          write(`* ${count} EXISTS`);
          write('* 0 RECENT');
          write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
          write('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flag permessi');
          write('* OK [UIDVALIDITY 1] UID validi');
          write(`* OK [UIDNEXT ${count + 1}] Prossimo UID`);
          write(`${tag} OK [${verb === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] ${verb} completato`);
          return;
        }
        case 'SEARCH': {
          const wanted = /HEADER\s+"?Message-ID"?\s+"?([^"\s]+)"?/i.exec(args)?.[1];
          const hits: number[] = [];
          state.appended
            .filter((a) => a.folder === selected)
            .forEach((a, i) => {
              if (wanted && messageIdOf(a.raw)?.toLowerCase().includes(wanted.toLowerCase())) hits.push(i + 1);
            });
          write(`* SEARCH${hits.length ? ' ' + hits.join(' ') : ''}`);
          write(`${tag} OK SEARCH completato`);
          return;
        }
        case 'APPEND': {
          const am = /^("[^"]*"|\S+)\s*(?:\(([^)]*)\))?\s*(?:"[^"]*"\s*)?\{(\d+)\+?\}$/.exec(args.trim());
          if (!am) {
            write(`${tag} BAD APPEND non valido`);
            return;
          }
          literal = { tag, folder: unquote(am[1]), flags: am[2] ? am[2].split(/\s+/).filter(Boolean) : [], size: Number(am[3]) };
          write('+ Pronto per il literal');
          return;
        }
        case 'LOGOUT':
          write('* BYE Arrivederci');
          write(`${tag} OK LOGOUT completato`);
          socket.end();
          return;
        default:
          write(`${tag} OK ${verb} completato`);
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (literal) {
          if (buffer.length < literal.size) return;
          const raw = buffer.subarray(0, literal.size);
          buffer = buffer.subarray(literal.size);
          const nl = buffer.indexOf('\r\n');
          if (nl < 0) {
            // Il CRLF che chiude il comando non è ancora arrivato: rimette il literal in coda.
            buffer = Buffer.concat([raw, buffer]);
            return;
          }
          buffer = buffer.subarray(nl + 2);
          state.appended.push({ folder: literal.folder, flags: literal.flags, raw: Buffer.from(raw) });
          const uid = state.appended.filter((a) => a.folder === literal!.folder).length;
          write(`${literal.tag} OK [APPENDUID 1 ${uid}] APPEND completato`);
          literal = null;
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 2);
        handle(line);
      }
    });
  });

  state.port = await listen(server);
  return state;
}
