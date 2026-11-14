/**
 * sameOriginWrites con il server Node vero: @hono/node-server crea sempre un
 * body stream per i metodi diversi da GET/HEAD, quindi il corpo va riconosciuto
 * dalle intestazioni (Content-Length, Transfer-Encoding) e non da `req.body`.
 * Le richieste in-process (app.request) non vedono la differenza.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import pino from 'pino';
import { sameOriginWrites } from '../../src/lib/http/same-origin-writes';

describe('sameOriginWrites con @hono/node-server', () => {
  let server: ServerType;
  let base = '';

  before(async () => {
    const app = new Hono();
    app.use('*', sameOriginWrites({ log: pino({ level: 'silent' }) }));
    app.all('*', (c) => c.json({ ok: true }));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  after(() => {
    server?.close();
  });

  test('DELETE e POST senza corpo e senza Content-Type passano', async () => {
    for (const method of ['DELETE', 'POST', 'PUT', 'PATCH']) {
      const res = await fetch(`${base}/x`, { method });
      assert.equal(res.status, 200, method);
    }
  });

  test('un corpo che non è application/json → 415; con application/json passa', async () => {
    const wrong = await fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'ciao' });
    assert.equal(wrong.status, 415);
    const none = await fetch(`${base}/x`, { method: 'DELETE', body: '{"a":1}' });
    assert.equal(none.status, 415, 'corpo senza Content-Type');
    const ok = await fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    assert.equal(ok.status, 200);
  });

  test('corpo in streaming (Transfer-Encoding: chunked) senza application/json → 415', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ciao'));
        controller.close();
      },
    });
    const res = await fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: stream, duplex: 'half' } as RequestInit);
    assert.equal(res.status, 415);
  });
});
