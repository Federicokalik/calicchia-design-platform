/**
 * Tool "Palette di settore" (/risorse/palette-di-settore del sito).
 *
 * Pubbliche (montate in app.ts prima dei protectedPaths, con rate limit per IP):
 *   GET  /api/palette/search?q=&locale=it|en  ricerca libera → foto Unsplash con i colori estratti
 *   POST /api/palette/download { ids }        registra l'uso delle foto (linee guida Unsplash)
 *   GET|POST /api/palette/unsubscribe?c=&t=   esce dalla sequenza email palette-onboarding
 * Protetta (paletteAdmin, in protectedPaths):
 *   GET  /api/palette/searches                registro anonimo delle ricerche per l'admin
 *
 * Le ricerche sui settori curati non passano di qui: il sito usa le palette
 * pre-calcolate (public/palette-data). Qui arriva solo il testo libero.
 *
 * Quota Unsplash: l'app in modalità demo ha 50 richieste/ora condivise con il
 * generatore di copertine del blog. Oltre al rate limit per IP c'è quindi un
 * tetto globale orario sulle sole chiamate a Unsplash (PALETTE_SEARCH_HOURLY_CAP,
 * default 40) e una cache in memoria di 24 ore: un cache hit non consuma quota.
 *
 * Privacy: il testo dei visitatori va tradotto solo da un provider UE
 * (Infomaniak), mai da provider USA; il registro salva solo il testo
 * normalizzato, senza IP né user agent. L'estrazione dei colori avviene qui
 * sul server: il browser del visitatore non legge mai i pixel di Unsplash.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { decode as decodeJpeg } from 'jpeg-js';
import { createRng, extractFromPixels, hashString, normalizeHex, normalizeQuery } from '@calicchia/shared/palette';
import type { PalettePhoto, StoredCluster } from '@calicchia/shared/palette';
import { firstZodIssue } from '@calicchia/shared';
import { sql } from '../db';
import { generateText } from '../lib/agent/llm-router';
import {
  extractionThumbUrl,
  isUnsplashConfigured,
  isUnsplashPhotoId,
  searchPhotos,
  toPalettePhoto,
  trackDownloadById,
  UnsplashError,
  type UnsplashPhoto,
} from '../lib/unsplash';
import { unsubscribePaletteSequence, verifyPaletteUnsubscribe } from '../jobs/lead-palette-sequence';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'palette' });

export const palette = new Hono();
export const paletteAdmin = new Hono();

type Locale = 'it' | 'en';

interface SearchPayload {
  query: string;
  queryEn: string;
  photos: PalettePhoto[];
}

// ─── Parametri ───────────────────────────────

const PER_PAGE = 12;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HOURLY_CAP = 40;
const DEFAULT_TRANSLATE_TIMEOUT_MS = 8_000;
const THUMB_TIMEOUT_MS = 5_000;
const THUMB_MAX_BYTES = 256 * 1024;
const TRACKED_MAX = 5_000;

/** Tetto orario letto a ogni chiamata: si cambia con un riavvio, i test lo variano con withEnv. */
function hourlyCap(): number {
  const n = Number.parseInt(process.env.PALETTE_SEARCH_HOURLY_CAP ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HOURLY_CAP;
}

let translateTimeoutMs = DEFAULT_TRANSLATE_TIMEOUT_MS;

// ─── Stato in memoria (un solo processo API, vedi DEPLOY.md) ───────────────

/** Cache LRU: Map in ordine di inserimento, un hit sposta la voce in fondo. */
const cache = new Map<string, { value: SearchPayload; expiresAt: number }>();
/** Ricerche in corso per chiave: due richieste uguali e contemporanee fanno una sola chiamata. */
const inflight = new Map<string, Promise<SearchPayload>>();
/** Istanti delle chiamate a Unsplash nell'ultima ora (finestra mobile). */
let unsplashCalls: number[] = [];
/** Id già registrati con /download (deduplica per processo, i più vecchi escono per primi). */
const trackedIds = new Set<string>();

function cacheGet(key: string): SearchPayload | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  if (hit.expiresAt <= Date.now()) return null;
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: SearchPayload): void {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Prenota una chiamata a Unsplash nel tetto orario; false se il tetto è pieno. */
function reserveUnsplashCall(): boolean {
  const now = Date.now();
  unsplashCalls = unsplashCalls.filter((t) => now - t < HOUR_MS);
  if (unsplashCalls.length >= hourlyCap()) return false;
  unsplashCalls.push(now);
  return true;
}

class HourlyCapError extends Error {}

/** Solo per i test: azzera cache, tetto e deduplica; cambia il timeout della traduzione. */
export const __paletteTesting = {
  reset(): void {
    cache.clear();
    inflight.clear();
    unsplashCalls = [];
    trackedIds.clear();
    translateTimeoutMs = DEFAULT_TRANSLATE_TIMEOUT_MS;
  },
  setTranslateTimeoutMs(ms: number): void {
    translateTimeoutMs = ms;
  },
};

// ─── Traduzione IT → EN ───────────────────────────────

/**
 * Parole di settore per il ripiego senza IA (chiavi già normalizzate: minuscolo,
 * senza accenti). Le frasi di più parole vengono provate prima delle singole.
 */
const SECTOR_DICTIONARY: Record<string, string> = {
  'agenzia immobiliare': 'real estate agency',
  'agenzia viaggi': 'travel agency',
  'centro estetico': 'beauty salon',
  'impresa edile': 'construction company',
  'impresa di pulizie': 'cleaning service',
  'officina meccanica': 'car repair shop',
  'stabilimento balneare': 'beach club',
  'studio dentistico': 'dental clinic',
  'studio legale': 'law firm',
  abbigliamento: 'clothing store',
  agriturismo: 'farmhouse',
  albergo: 'hotel',
  architetto: 'architect',
  artigiano: 'artisan',
  autoscuola: 'driving school',
  avvocato: 'lawyer',
  bar: 'bar',
  barbiere: 'barber',
  birreria: 'pub',
  birrificio: 'brewery',
  caffe: 'cafe',
  calzolaio: 'shoemaker',
  campeggio: 'campsite',
  cantina: 'winery',
  carrozzeria: 'auto body shop',
  cartoleria: 'stationery shop',
  ceramica: 'ceramics',
  commercialista: 'accountant',
  concessionaria: 'car dealership',
  dentista: 'dentist',
  elettricista: 'electrician',
  enoteca: 'wine shop',
  erboristeria: 'herbal shop',
  estetista: 'beautician',
  falegname: 'carpenter',
  farmacia: 'pharmacy',
  ferramenta: 'hardware store',
  fioraio: 'florist',
  fiorista: 'florist',
  fiori: 'flowers',
  fisioterapista: 'physiotherapist',
  fotografo: 'photographer',
  gelateria: 'gelato shop',
  gelato: 'gelato',
  giardiniere: 'gardener',
  gioielleria: 'jewelry store',
  gommista: 'tire shop',
  hotel: 'hotel',
  idraulico: 'plumber',
  imbianchino: 'house painter',
  immobiliare: 'real estate',
  ingegnere: 'engineer',
  lavanderia: 'laundry',
  libreria: 'bookstore',
  macelleria: 'butcher shop',
  matrimoni: 'wedding',
  matrimonio: 'wedding',
  meccanico: 'mechanic',
  medico: 'doctor',
  negozio: 'shop',
  notaio: 'notary',
  nutrizionista: 'nutritionist',
  officina: 'workshop',
  osteopata: 'osteopath',
  osteria: 'tavern',
  ottico: 'optician',
  palestra: 'gym',
  panetteria: 'bakery',
  panificio: 'bakery',
  parrucchiere: 'hair salon',
  parrucchiera: 'hair salon',
  pasticceria: 'pastry shop',
  pescheria: 'fish market',
  pizzeria: 'pizzeria',
  profumeria: 'perfumery',
  psicologo: 'psychologist',
  psicologa: 'psychologist',
  ristorante: 'restaurant',
  sartoria: 'tailor',
  scuola: 'school',
  tabaccheria: 'tobacco shop',
  tatuatore: 'tattoo artist',
  tatuaggi: 'tattoo',
  trattoria: 'trattoria',
  veterinario: 'veterinarian',
  vino: 'wine',
  yoga: 'yoga',
};

/** Ripiego senza IA: frase intera, poi parola per parola (solo le parole note). */
export function translateWithDictionary(normalized: string): string | null {
  const direct = SECTOR_DICTIONARY[normalized];
  if (direct) return direct;
  const words = normalized.split(' ');
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? SECTOR_DICTIONARY[`${words[i]} ${words[i + 1]}`] : undefined;
    if (pair) {
      out.push(pair);
      i++;
      continue;
    }
    const single = SECTOR_DICTIONARY[words[i]];
    if (single) out.push(single);
  }
  return out.length ? [...new Set(out)].join(' ') : null;
}

/** Ripulisce la risposta del modello: una riga, solo lettere, spazi e trattini. */
function sanitizeTranslation(raw: string): string | null {
  const line = raw.split('\n').find((l) => l.trim())?.trim() ?? '';
  const cleaned = line
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * Traduzione con il solo provider UE (Infomaniak, euOnly): nessun fallback
 * USA per il testo dei visitatori. generateText non ha timeout, quindi
 * Promise.race con un limite (8 s) e abort della richiesta HTTP.
 */
async function translateWithEuLlm(text: string): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout traduzione'));
    }, translateTimeoutMs);
  });
  try {
    const out = await Promise.race([
      generateText(
        'chat_fast',
        [
          {
            role: 'system',
            content:
              'You translate an Italian description of a business or activity into a short English photo search query (1-4 words) for a stock photo site. Reply with the query only, no quotes, no punctuation.',
          },
          { role: 'user', content: text },
        ],
        { euOnly: true, temperature: 0, max_tokens: 20, signal: controller.signal },
      ),
      timeout,
    ]);
    return sanitizeTranslation(out);
  } catch (err) {
    log.debug({ err }, 'traduzione UE non disponibile, uso il dizionario');
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function toEnglishQuery(original: string, normalized: string, locale: Locale): Promise<string> {
  if (locale === 'en') return normalized;
  return (await translateWithEuLlm(original)) ?? translateWithDictionary(normalized) ?? normalized;
}

// ─── Estrazione dei colori ───────────────────────────────

const ALLOWED_IMAGE_HOSTS = new Set(['images.unsplash.com', 'plus.unsplash.com']);

/** Scarica la miniatura 64×48 e ne estrae i cluster; ripiega sul colore medio di Unsplash. */
async function extractClusters(photo: UnsplashPhoto): Promise<StoredCluster[]> {
  try {
    const url = new URL(extractionThumbUrl(photo));
    if (url.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(url.hostname)) throw new Error('host non ammesso');
    const res = await fetch(url, { signal: AbortSignal.timeout(THUMB_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`miniatura ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > THUMB_MAX_BYTES) throw new Error('miniatura troppo grande');
    const img = decodeJpeg(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 1, maxMemoryUsageInMB: 32 });
    const clusters = extractFromPixels(img.data, createRng(hashString(photo.id)));
    if (clusters.length) return clusters.map((c) => ({ hex: c.hex, w: Math.round(c.w * 1000) / 1000 }));
  } catch (err) {
    log.debug({ err, id: photo.id }, 'estrazione dalla miniatura fallita');
  }
  const fallback = photo.color ? normalizeHex(photo.color) : null;
  return fallback ? [{ hex: fallback, w: 1 }] : [];
}

async function runSearch(original: string, normalized: string, locale: Locale): Promise<SearchPayload> {
  // Il tetto si controlla prima della traduzione: a quota finita non serve nemmeno quella.
  if (!reserveUnsplashCall()) throw new HourlyCapError();
  const queryEn = await toEnglishQuery(original, normalized, locale);
  const result = await searchPhotos(queryEn, { perPage: PER_PAGE });
  const photos = await Promise.all(
    result.photos.slice(0, PER_PAGE).map(async (p) => toPalettePhoto(p, await extractClusters(p))),
  );
  return { query: original, queryEn, photos: photos.filter((p) => p.clusters.length > 0) };
}

/** Registro anonimo: solo testo normalizzato, anche per le risposte dalla cache. */
async function logSearch(normalized: string, queryEn: string, locale: Locale, results: number): Promise<void> {
  try {
    await sql`
      INSERT INTO palette_searches (query_norm, query_en, locale, results)
      VALUES (${normalized}, ${queryEn}, ${locale}, ${results})
      ON CONFLICT (query_norm) DO UPDATE SET
        hits = palette_searches.hits + 1,
        query_en = EXCLUDED.query_en,
        locale = EXCLUDED.locale,
        results = EXCLUDED.results,
        last_seen = NOW()
    `;
  } catch (err) {
    log.warn({ err }, 'registro ricerche palette non aggiornato');
  }
}

// ─── Route pubbliche ───────────────────────────────

const searchQuerySchema = z.object({
  q: z
    .string({ required_error: 'Scrivi la tua attività' })
    .trim()
    .min(2, 'Scrivi almeno 2 caratteri')
    .max(40, 'Massimo 40 caratteri'),
  locale: z.enum(['it', 'en']).default('it'),
});

palette.get('/search', async (c) => {
  const parsed = searchQuerySchema.safeParse({ q: c.req.query('q'), locale: c.req.query('locale') || undefined });
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const { q, locale } = parsed.data;
  const normalized = normalizeQuery(q);
  if (normalized.length < 2) return c.json({ error: 'Scrivi almeno 2 caratteri' }, 400);

  const key = `${locale}:${normalized}`;
  let payload = cacheGet(key);

  if (!payload) {
    if (!isUnsplashConfigured()) return c.json({ error: 'Ricerca foto non disponibile' }, 503);
    let pending = inflight.get(key);
    if (!pending) {
      pending = runSearch(q, normalized, locale).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      payload = await pending;
    } catch (err) {
      if (err instanceof HourlyCapError) {
        return c.json({ error: 'Troppe ricerche in questo momento. Riprova più tardi.' }, 429);
      }
      log.warn({ err, status: err instanceof UnsplashError ? err.status : undefined }, 'ricerca Unsplash fallita');
      return c.json({ error: 'Ricerca foto non riuscita' }, 502);
    }
    cacheSet(key, payload);
  }

  await logSearch(normalized, payload.queryEn, locale, payload.photos.length);
  // La query mostrata è quella di questa richiesta, non quella che ha riempito la cache.
  return c.json({ query: q, queryEn: payload.queryEn, photos: payload.photos });
});

const downloadSchema = z.object({
  ids: z.array(z.string().max(64)).max(PER_PAGE, `Massimo ${PER_PAGE} foto`),
});

palette.post('/download', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = downloadSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);

  let accepted = 0;
  for (const id of new Set(parsed.data.ids)) {
    if (!isUnsplashPhotoId(id) || trackedIds.has(id)) continue;
    trackedIds.add(id);
    while (trackedIds.size > TRACKED_MAX) {
      const oldest = trackedIds.values().next().value;
      if (oldest === undefined) break;
      trackedIds.delete(oldest);
    }
    accepted++;
    // Fire-and-forget: trackDownloadById non lancia mai.
    void trackDownloadById(id);
  }
  return c.json({ accepted }, 202);
});

function unsubscribePage(ok: boolean): string {
  const title = ok ? 'Disiscrizione completata' : 'Link non valido';
  const msg = ok
    ? 'Non riceverai più le email sulla tua palette. Per qualsiasi cosa puoi sempre scrivermi dal sito.'
    : 'Il link di disiscrizione non è valido.';
  return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#FAFAF7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="background:#fff;border:1px solid #E6E4DC;padding:40px;max-width:440px;text-align:center">
<h1 style="font-size:20px;color:#111111;margin:0 0 12px">${title}</h1>
<p style="font-size:14px;color:#5C5C58;line-height:1.6;margin:0">${msg}</p>
</div></body></html>`;
}

palette.get('/unsubscribe', async (c) => {
  const contactId = c.req.query('c') ?? '';
  if (!verifyPaletteUnsubscribe(contactId, c.req.query('t') ?? '')) return c.html(unsubscribePage(false), 400);
  try {
    await unsubscribePaletteSequence(contactId);
    return c.html(unsubscribePage(true));
  } catch (err) {
    log.warn({ err }, 'disiscrizione palette fallita');
    return c.html(unsubscribePage(false), 500);
  }
});

// One-click (List-Unsubscribe-Post, RFC 8058): stessi parametri nella query.
palette.post('/unsubscribe', async (c) => {
  const contactId = c.req.query('c') ?? '';
  if (!verifyPaletteUnsubscribe(contactId, c.req.query('t') ?? '')) return c.body(null, 400);
  try {
    await unsubscribePaletteSequence(contactId);
  } catch (err) {
    log.warn({ err }, 'disiscrizione one-click palette fallita');
  }
  return c.body(null, 200);
});

// ─── Admin: registro delle ricerche ───────────────────────────────

const searchesQuerySchema = z.object({
  sort: z.enum(['recent', 'hits']).default('recent'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

paletteAdmin.get('/', async (c) => {
  const parsed = searchesQuerySchema.safeParse({
    sort: c.req.query('sort') || undefined,
    limit: c.req.query('limit') || undefined,
  });
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const { sort, limit } = parsed.data;
  const order = sort === 'hits' ? sql`hits DESC, last_seen DESC` : sql`last_seen DESC`;
  const [rows, [totals]] = await Promise.all([
    sql`
      SELECT query_norm, query_en, locale, hits, results, first_seen, last_seen
      FROM palette_searches
      ORDER BY ${order}
      LIMIT ${limit}
    `,
    sql<{ queries: number; hits: number }[]>`
      SELECT COUNT(*)::int AS queries, COALESCE(SUM(hits), 0)::int AS hits FROM palette_searches
    `,
  ]);
  return c.json({ searches: rows, total: totals?.queries ?? 0, totalHits: totals?.hits ?? 0 });
});
