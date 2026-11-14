/**
 * Client Unsplash condiviso: copertine del blog (lib/ai/cover-generator.ts),
 * tool "Palette di settore" (routes/palette.ts) e pre-calcolo delle palette
 * (scripts/precompute-palettes.ts).
 *
 * Regole dell'API Unsplash rispettate qui:
 *  - le immagini restano in hotlink su images.unsplash.com (gli URL
 *    restituiti conservano il parametro `ixid`);
 *  - quando una foto viene usata si chiama l'endpoint di download
 *    (`trackDownload*`), mai per la sola visualizzazione;
 *  - i link a fotografo e foto portano utm_source/utm_medium.
 *
 * La chiave si legge a ogni chiamata, non all'import, così test e script
 * possono impostarla dopo il caricamento del modulo.
 */

import type { PalettePhoto, StoredCluster } from '@calicchia/shared/palette';

const API = 'https://api.unsplash.com';
const PHOTO_ID = /^[\w-]{6,20}$/;

export class UnsplashError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UnsplashError';
  }
}

export function getUnsplashKey(): string | null {
  return process.env.UNSPLASH_ACCESS_KEY?.trim() || null;
}

export const isUnsplashConfigured = (): boolean => getUnsplashKey() !== null;

function requireKey(): string {
  const key = getUnsplashKey();
  if (!key) throw new UnsplashError('UNSPLASH_ACCESS_KEY non configurata', 503);
  return key;
}

/** Sottoinsieme della risposta di /search/photos usato nel progetto. */
export interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  color: string | null;
  blur_hash: string | null;
  alt_description: string | null;
  description: string | null;
  urls: { raw: string; full: string; regular: string; small: string; thumb: string };
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
}

export interface SearchOptions {
  perPage?: number;
  page?: number;
  orientation?: 'landscape' | 'portrait' | 'squarish';
  contentFilter?: 'low' | 'high';
  signal?: AbortSignal;
}

export interface SearchResult {
  photos: UnsplashPhoto[];
  total: number;
  /** Header X-Ratelimit-Remaining, null se assente. */
  rateLimitRemaining: number | null;
}

export async function searchPhotos(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const key = requireKey();
  const params = new URLSearchParams({
    query,
    per_page: String(opts.perPage ?? 10),
    page: String(opts.page ?? 1),
    orientation: opts.orientation ?? 'landscape',
    content_filter: opts.contentFilter ?? 'high',
  });
  const res = await fetch(`${API}/search/photos?${params}`, {
    headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' },
    signal: opts.signal,
  });
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (!res.ok) throw new UnsplashError(`Unsplash API error: ${res.status}`, res.status);
  const data = (await res.json()) as { total?: number; results?: UnsplashPhoto[] };
  return {
    photos: data.results ?? [],
    total: data.total ?? 0,
    rateLimitRemaining: remaining === null ? null : Number(remaining),
  };
}

/** Registra l'uso di una foto dato il `links.download_location` della risposta. Non lancia mai. */
export function trackDownloadLocation(downloadLocation: string | undefined): void {
  const key = getUnsplashKey();
  if (!key || !downloadLocation?.startsWith(`${API}/`)) return;
  fetch(downloadLocation, { headers: { Authorization: `Client-ID ${key}` } }).catch(() => {});
}

export const isUnsplashPhotoId = (id: string): boolean => PHOTO_ID.test(id);

/**
 * Registra l'uso di una foto dato solo l'id (il client conosce l'id, non il
 * download_location). L'URL è costruito qui: niente URL forniti da fuori.
 */
export async function trackDownloadById(id: string): Promise<boolean> {
  const key = getUnsplashKey();
  if (!key || !isUnsplashPhotoId(id)) return false;
  try {
    const res = await fetch(`${API}/photos/${encodeURIComponent(id)}/download`, {
      headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Parametri utm richiesti dalle linee guida per i link verso Unsplash. */
export function withUtm(url: string): string {
  const source = process.env.UNSPLASH_APP_NAME?.trim() || 'calicchia_design';
  const u = new URL(url);
  u.searchParams.set('utm_source', source);
  u.searchParams.set('utm_medium', 'referral');
  return u.toString();
}

/** URL di una miniatura piccola per l'estrazione dei colori (resize lato imgix). */
export function extractionThumbUrl(photo: Pick<UnsplashPhoto, 'urls'>, width = 64, height = 48): string {
  const u = new URL(photo.urls.raw);
  u.searchParams.set('w', String(width));
  u.searchParams.set('h', String(height));
  u.searchParams.set('fit', 'crop');
  u.searchParams.set('fm', 'jpg');
  u.searchParams.set('q', '60');
  return u.toString();
}

/** Foto Unsplash → forma pubblica del tool palette, con i cluster già estratti. */
export function toPalettePhoto(photo: UnsplashPhoto, clusters: StoredCluster[]): PalettePhoto {
  return {
    id: photo.id,
    small: photo.urls.small,
    regular: photo.urls.regular,
    width: photo.width,
    height: photo.height,
    blurHash: photo.blur_hash ?? null,
    color: photo.color ?? null,
    alt: photo.alt_description ?? photo.description ?? null,
    author: photo.user.name,
    authorUrl: withUtm(photo.user.links.html),
    photoUrl: withUtm(photo.links.html),
    clusters,
  };
}
