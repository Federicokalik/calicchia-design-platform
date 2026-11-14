/**
 * fetch sostituito per i test del tool palette: nessuna chiamata di rete.
 *
 * Instrada per host: api.unsplash.com (ricerca e download), images.unsplash.com
 * (miniature JPEG generate con jpeg-js), api.infomaniak.com e api.openai.com
 * (LLM). Ogni chiamata viene registrata in `calls` per le asserzioni.
 */

import { encode as encodeJpeg } from 'jpeg-js';

export interface FetchCall {
  url: string;
  host: string;
  path: string;
  method: string;
}

export type LlmBehavior = { kind: 'reply'; content: string } | { kind: 'hang' } | { kind: 'error'; status: number };

export interface FetchMockOptions {
  /** Foto restituite da /search/photos. */
  photos?: unknown[];
  /** Status di /search/photos (default 200). */
  searchStatus?: number;
  llm?: LlmBehavior;
}

/** Miniatura 64×48 a due bande di colore, come quella chiesta da extractionThumbUrl. */
export function twoToneJpeg(top: [number, number, number], bottom: [number, number, number]): Uint8Array {
  const width = 64;
  const height = 48;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const [r, g, b] = y < height / 2 ? top : bottom;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(encodeJpeg({ width, height, data }, 90).data);
}

/** Foto Unsplash minima con gli URL che usa il client (raw con ixid). */
export function unsplashPhoto(id: string, color = '#C63D2B'): Record<string, unknown> {
  return {
    id,
    width: 4000,
    height: 3000,
    color,
    blur_hash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
    alt_description: `foto ${id}`,
    description: null,
    urls: {
      raw: `https://images.unsplash.com/photo-${id}?ixid=test`,
      full: `https://images.unsplash.com/photo-${id}?ixid=test&q=85`,
      regular: `https://images.unsplash.com/photo-${id}?ixid=test&w=1080`,
      small: `https://images.unsplash.com/photo-${id}?ixid=test&w=400`,
      thumb: `https://images.unsplash.com/photo-${id}?ixid=test&w=200`,
    },
    links: {
      html: `https://unsplash.com/photos/${id}`,
      download_location: `https://api.unsplash.com/photos/${id}/download?ixid=test`,
    },
    user: { name: 'Fotografo di prova', links: { html: 'https://unsplash.com/@prova' } },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '42' },
  });
}

export function installFetchMock(opts: FetchMockOptions = {}) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  const state: Required<FetchMockOptions> = {
    photos: opts.photos ?? [unsplashPhoto('photo-aaa1'), unsplashPhoto('photo-bbb2', '#EFE5D2')],
    searchStatus: opts.searchStatus ?? 200,
    llm: opts.llm ?? { kind: 'error', status: 500 },
  };
  const thumb = twoToneJpeg([198, 61, 43], [239, 229, 210]);

  const mock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    calls.push({ url: url.toString(), host: url.hostname, path: url.pathname, method });

    if (url.hostname === 'api.unsplash.com' && url.pathname === '/search/photos') {
      if (state.searchStatus !== 200) return json({ errors: ['boom'] }, state.searchStatus);
      return json({ total: state.photos.length, total_pages: 1, results: state.photos });
    }
    if (url.hostname === 'api.unsplash.com' && /^\/photos\/[^/]+\/download$/.test(url.pathname)) {
      return json({ url: 'https://images.unsplash.com/ok' });
    }
    if (url.hostname === 'images.unsplash.com') {
      return new Response(thumb, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url.hostname === 'api.infomaniak.com' || url.hostname === 'api.openai.com') {
      const llm = state.llm;
      if (llm.kind === 'hang') {
        // Non risponde mai: si chiude solo con l'abort del timeout della traduzione.
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
        });
      }
      if (llm.kind === 'error') return new Response('errore LLM simulato', { status: llm.status });
      return json({ choices: [{ message: { content: llm.content } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    }
    throw new Error(`fetch non previsto nei test palette: ${url.toString()}`);
  };

  globalThis.fetch = mock as typeof fetch;

  return {
    calls,
    state,
    count(predicate: (c: FetchCall) => boolean): number {
      return calls.filter(predicate).length;
    },
    searches(): FetchCall[] {
      return calls.filter((c) => c.host === 'api.unsplash.com' && c.path === '/search/photos');
    },
    restore(): void {
      globalThis.fetch = original;
    },
  };
}

export type FetchMock = ReturnType<typeof installFetchMock>;
