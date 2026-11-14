/**
 * GET /api/palette/search, POST /api/palette/download e registro delle
 * ricerche (GET /api/palette/searches) del tool "Palette di settore".
 *
 * fetch è sostituito (_fetch-mock.ts): nessuna chiamata a Unsplash o ai
 * provider LLM. Ogni test parte con cache, tetto orario e deduplica azzerati
 * (__paletteTesting.reset) e con UNSPLASH_ACCESS_KEY impostata solo per lui.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { withEnv } from '../helpers/env';
import { sql, useTestDatabase } from '../helpers/db';
import { api } from '../helpers/http';
import { __paletteTesting } from '../../src/routes/palette';
import { installFetchMock, unsplashPhoto, type FetchMock } from './_fetch-mock';

useTestDatabase();

/** Prefisso delle query di questo file: il registro si pulisce per prefisso. */
const Q = 'tstpal';
const UNSPLASH = { UNSPLASH_ACCESS_KEY: 'test-unsplash-key' };

let fx: FetchMock;

async function cleanupSearches(): Promise<void> {
  await sql`DELETE FROM palette_searches WHERE query_norm LIKE ${`${Q}%`}`;
}

beforeEach(async () => {
  __paletteTesting.reset();
  fx = installFetchMock();
  await cleanupSearches();
});

afterEach(async () => {
  fx.restore();
  __paletteTesting.reset();
  await cleanupSearches();
});

test('search: 400 su input non valido, senza chiamare Unsplash', async () => {
  await withEnv(UNSPLASH, async () => {
    for (const query of [{}, { q: 'a' }, { q: '   b  ' }, { q: 'x'.repeat(41) }, { q: `${Q} pizzeria`, locale: 'fr' }]) {
      const res = await api.get('/api/palette/search', { query });
      assert.equal(res.status, 400, `atteso 400 per ${JSON.stringify(query)}`);
      assert.equal(typeof res.json?.error, 'string');
    }
  });
  assert.equal(fx.searches().length, 0);
});

test('search: 503 se Unsplash non è configurato', async () => {
  const res = await api.get('/api/palette/search', { query: { q: `${Q} pizzeria` } });
  assert.equal(res.status, 503);
  assert.equal(fx.calls.length, 0);
});

test('search: foto con i colori estratti, poi cache hit senza seconda chiamata', async () => {
  await withEnv(UNSPLASH, async () => {
    const first = await api.get('/api/palette/search', { query: { q: `${Q} pizzeria`, locale: 'it' } });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.query, `${Q} pizzeria`);
    // Nessun provider UE configurato: traduzione dal dizionario (solo le parole note).
    assert.equal(first.json.queryEn, 'pizzeria');
    assert.equal(first.json.photos.length, 2);
    for (const photo of first.json.photos) {
      assert.ok(photo.clusters.length > 0, 'cluster estratti dalla miniatura');
      for (const c of photo.clusters) assert.match(c.hex, /^#[0-9A-F]{6}$/);
      assert.match(photo.authorUrl, /utm_source=/);
      assert.match(photo.small, /^https:\/\/images\.unsplash\.com\//);
    }
    // Estrazione deterministica: la miniatura ha due bande (rosso #C63D2B e crema #EFE5D2).
    const isReddish = (hex: string): boolean => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return r > g + 60 && r > b + 60;
    };
    const clusters: Array<{ hex: string; w: number }> = first.json.photos[0].clusters;
    assert.ok(clusters.some((c) => isReddish(c.hex)), `atteso un cluster rosso, ricevuti ${JSON.stringify(clusters)}`);

    assert.equal(fx.searches().length, 1);
    const searchUrl = new URL(fx.searches()[0].url);
    assert.equal(searchUrl.searchParams.get('query'), 'pizzeria');
    assert.equal(searchUrl.searchParams.get('per_page'), '12');
    const thumbs = fx.count((c) => c.host === 'images.unsplash.com');
    assert.equal(thumbs, 2);

    // Stessa query normalizzata (maiuscole e spazi): dalla cache.
    const second = await api.get('/api/palette/search', { query: { q: `  ${Q.toUpperCase()}   PIZZERIA ` } });
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.photos, first.json.photos);
    assert.equal(fx.searches().length, 1, 'un cache hit non chiama Unsplash');
    assert.equal(fx.count((c) => c.host === 'images.unsplash.com'), thumbs, 'né scarica di nuovo le miniature');

    // La lingua fa parte della chiave: in inglese è un'altra ricerca.
    const en = await api.get('/api/palette/search', { query: { q: `${Q} pizzeria`, locale: 'en' } });
    assert.equal(en.status, 200);
    assert.equal(en.json.queryEn, `${Q} pizzeria`, 'con locale=en niente traduzione');
    assert.equal(fx.searches().length, 2);
  });
});

test('search: il registro incrementa hits anche dalla cache, senza dati del visitatore', async () => {
  await withEnv(UNSPLASH, async () => {
    for (let i = 0; i < 3; i++) {
      const res = await api.get('/api/palette/search', { query: { q: `${Q} Fioraio` } });
      assert.equal(res.status, 200);
    }
  });
  assert.equal(fx.searches().length, 1);
  const rows = await sql<Array<Record<string, unknown>>>`SELECT * FROM palette_searches WHERE query_norm = ${`${Q} fioraio`}`;
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.hits, 3);
  assert.equal(row.results, 2);
  assert.equal(row.query_en, 'florist');
  assert.equal(row.locale, 'it');
  // Solo testo normalizzato: la tabella non ha colonne per IP o user agent.
  assert.deepEqual(Object.keys(row).sort(), ['first_seen', 'hits', 'last_seen', 'locale', 'query_en', 'query_norm', 'results']);
});

test('search: traduzione solo UE, su timeout ripiega sul dizionario (mai OpenAI)', async () => {
  fx.state.llm = { kind: 'hang' };
  __paletteTesting.setTranslateTimeoutMs(50);
  await withEnv(
    { ...UNSPLASH, INFOMANIAK_AI_TOKEN: 'tok', INFOMANIAK_AI_PRODUCT_ID: '123', OPENAI_API_KEY: 'sk-test' },
    async () => {
      const started = Date.now();
      const res = await api.get('/api/palette/search', { query: { q: `${Q} parrucchiere` } });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.queryEn, 'hair salon');
      assert.ok(Date.now() - started < 5_000, 'il timeout interrompe l’attesa');
    },
  );
  assert.equal(fx.count((c) => c.host === 'api.infomaniak.com'), 1);
  assert.equal(fx.count((c) => c.host === 'api.openai.com'), 0, 'il testo dei visitatori non va a provider USA');
  assert.equal(new URL(fx.searches()[0].url).searchParams.get('query'), 'hair salon');
});

test('search: senza Infomaniak non usa OpenAI; con Infomaniak usa la sua traduzione ripulita', async () => {
  await withEnv({ ...UNSPLASH, OPENAI_API_KEY: 'sk-test' }, async () => {
    const res = await api.get('/api/palette/search', { query: { q: `${Q} gelateria` } });
    assert.equal(res.status, 200);
    assert.equal(res.json.queryEn, 'gelato shop');
  });
  assert.equal(fx.count((c) => c.host === 'api.openai.com'), 0);

  fx.state.llm = { kind: 'reply', content: '"Ceramic Studio."\nAltro testo' };
  await withEnv({ ...UNSPLASH, INFOMANIAK_AI_TOKEN: 'tok', INFOMANIAK_AI_PRODUCT_ID: '123' }, async () => {
    const res = await api.get('/api/palette/search', { query: { q: `${Q} bottega di ceramiche` } });
    assert.equal(res.status, 200);
    assert.equal(res.json.queryEn, 'ceramic studio');
  });
  assert.equal(fx.count((c) => c.host === 'api.infomaniak.com'), 1);
});

test('search: errore Unsplash 500 → 502 e nessuna voce nel registro', async () => {
  fx.state.searchStatus = 500;
  await withEnv(UNSPLASH, async () => {
    const res = await api.get('/api/palette/search', { query: { q: `${Q} dentista` } });
    assert.equal(res.status, 502);
    assert.equal(typeof res.json.error, 'string');
  });
  const rows = await sql`SELECT 1 FROM palette_searches WHERE query_norm = ${`${Q} dentista`}`;
  assert.equal(rows.length, 0);
});

test('search: tetto globale orario → 429, la cache resta servita', async () => {
  await withEnv({ ...UNSPLASH, PALETTE_SEARCH_HOURLY_CAP: '2' }, async () => {
    // Ogni richiesta arriva da un IP diverso: il limite è globale, non per IP.
    assert.equal((await api.get('/api/palette/search', { query: { q: `${Q} palestra` } })).status, 200);
    assert.equal((await api.get('/api/palette/search', { query: { q: `${Q} avvocato` } })).status, 200);
    const capped = await api.get('/api/palette/search', { query: { q: `${Q} fotografo` } });
    assert.equal(capped.status, 429);
    assert.equal(typeof capped.json.error, 'string');
    assert.equal((await api.get('/api/palette/search', { query: { q: `${Q} palestra` } })).status, 200, 'cache hit');
  });
  assert.equal(fx.searches().length, 2);
});

test('search: rate limit per IP (20 ogni 10 minuti)', async () => {
  const ip = '198.51.100.77';
  await withEnv(UNSPLASH, async () => {
    for (let i = 0; i < 20; i++) {
      const res = await api.get('/api/palette/search', { query: { q: `${Q} enoteca` }, ip });
      assert.equal(res.status, 200, `richiesta ${i + 1}`);
    }
    const limited = await api.get('/api/palette/search', { query: { q: `${Q} enoteca` }, ip });
    assert.equal(limited.status, 429);
  });
});

test('download: 202, solo id validi e deduplicati, URL costruito lato server', async () => {
  await withEnv(UNSPLASH, async () => {
    const ids = ['valid-id-1', '../../etc', 'a', 'valid-id-1', 'x'.repeat(30), 'valid_id_2', 'https://evil.test/x'];
    const res = await api.post('/api/palette/download', { body: { ids } });
    assert.equal(res.status, 202);
    assert.equal(res.json.accepted, 2);
    const tracked = fx.calls.filter((c) => c.host === 'api.unsplash.com' && c.path.endsWith('/download'));
    assert.deepEqual(tracked.map((c) => c.path).sort(), ['/photos/valid-id-1/download', '/photos/valid_id_2/download']);

    // Già registrati in questo processo: ignorati.
    const again = await api.post('/api/palette/download', { body: { ids: ['valid-id-1', 'valid_id_2'] } });
    assert.equal(again.status, 202);
    assert.equal(again.json.accepted, 0);
    assert.equal(fx.calls.filter((c) => c.path.endsWith('/download')).length, 2);

    assert.equal((await api.post('/api/palette/download', { body: { ids: 'valid-id-3' } })).status, 400);
    const tooMany = Array.from({ length: 13 }, (_, i) => `photo-${100 + i}`);
    assert.equal((await api.post('/api/palette/download', { body: { ids: tooMany } })).status, 400);
    assert.equal((await api.post('/api/palette/download', { body: 'non json' })).status, 400);
  });
});

test('searches: admin only, ordinate per data o per conteggio', async () => {
  fx.state.photos = [unsplashPhoto('photo-ccc3')];
  await withEnv(UNSPLASH, async () => {
    await api.get('/api/palette/search', { query: { q: `${Q} sartoria` } });
    await api.get('/api/palette/search', { query: { q: `${Q} macelleria` } });
    await api.get('/api/palette/search', { query: { q: `${Q} macelleria` } });
  });

  assert.equal((await api.get('/api/palette/searches')).status, 401);

  const byHits = await api.get('/api/palette/searches', { auth: 'admin', query: { sort: 'hits', limit: 500 } });
  assert.equal(byHits.status, 200, byHits.text);
  const mine = byHits.json.searches.filter((r: { query_norm: string }) => r.query_norm.startsWith(Q));
  assert.deepEqual(
    mine.map((r: { query_norm: string; hits: number; results: number }) => [r.query_norm, r.hits, r.results]),
    [
      [`${Q} macelleria`, 2, 1],
      [`${Q} sartoria`, 1, 1],
    ],
  );
  assert.ok(byHits.json.total >= 2);

  const recent = await api.get('/api/palette/searches', { auth: 'admin' });
  assert.equal(recent.status, 200);
  assert.equal((await api.get('/api/palette/searches', { auth: 'admin', query: { sort: 'boh' } })).status, 400);
});
