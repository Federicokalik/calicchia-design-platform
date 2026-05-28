/**
 * sito-revalidate — fire-and-forget helper per triggerare la rigenerazione
 * ISR di `apps/sito-v3` quando il CMS pubblica/aggiorna/cancella contenuti
 * che alimentano la sitemap, llms.txt o le pagine del sito.
 *
 * Chiamato dopo INSERT/UPDATE/DELETE nelle route admin (`blog`, `projects`,
 * `cms-admin`). Usa `void` callsite (fire-and-forget) per non bloccare la
 * response al client admin — un eventuale errore di rivalidazione viene
 * loggato ma non propagato all'utente.
 *
 * Config:
 *   - `SITO_REVALIDATE_URL` (es. https://calicchia.design/api/revalidate)
 *   - `SITO_REVALIDATE_TOKEN` shared secret (matched contro `REVALIDATE_SECRET`
 *     sul sito-v3 — env names asimmetrici per leggibilità)
 *
 * Se uno dei due è missing, la chiamata è no-op (log warn). Permette al dev
 * setup di girare senza configurare il revalidate.
 */
import { createLogger } from './logger';

const log = createLogger('sito-revalidate');

interface RevalidateOpts {
  /** Tag da invalidare; default `['sitemap']` (revalida sitemap.xml, llms.txt, llms-full.txt). */
  tags?: string[];
  /** Path specifici da invalidare in aggiunta ai tag. */
  paths?: string[];
}

const URL = process.env.SITO_REVALIDATE_URL;
const TOKEN = process.env.SITO_REVALIDATE_TOKEN;

export async function revalidateSito(opts: RevalidateOpts = {}): Promise<void> {
  if (!URL || !TOKEN) {
    // No-op in dev/test without config; warn once per process via dedup map
    return;
  }
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Revalidate-Token': TOKEN,
      },
      body: JSON.stringify({
        tags: opts.tags ?? ['sitemap'],
        paths: opts.paths ?? [],
      }),
      // Tight timeout: sito should respond near-instantly. If it doesn't,
      // the admin mutation already succeeded; sitemap will catch up via ISR.
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      log.warn({ status: res.status, url: URL }, 'sito revalidate failed');
    }
  } catch (err) {
    log.warn({ err, url: URL }, 'sito revalidate threw');
  }
}
