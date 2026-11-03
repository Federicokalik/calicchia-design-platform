/**
 * Backend CalDAV: endpoint INTERNI chiamati dal plugin di autenticazione di
 * Radicale (caldes_auth), che li raggiunge sulla rete interna caldav-int
 * (CALDAV_BACKEND_URL=http://api-int:3001/api/caldav-backend). Protetti da
 * `caldavServiceAuth` (Bearer CALDAV_SERVICE_TOKEN) montato in app.ts: il
 * vhost pubblico dell'API inoltra anche questi path, quindi il Bearer è la
 * sola protezione.
 *
 * Dalla fase F1 del passaggio a Radicale resta solo la verifica delle
 * app-password dei device (contratto control-plane §9.4,
 * verify-credentials.schema.json). Le route /collections* del vecchio plugin
 * di storage (Radicale come proxy verso Postgres, caldes_storage.py) sono
 * state rimosse insieme al plugin: Radicale usa lo storage nativo
 * multifilesystem e l'API lo legge e scrive come client CalDAV (caldes-svc).
 *
 * POST /verify-credentials, corpo {"username", "password"}:
 *  - 200 {"ok": true, "principal": RADICALE_PRINCIPAL, "expires_at": ISO|null}
 *    per ogni app-password valida, qualunque sia lo username con cui è stata
 *    creata (principal canonico);
 *  - 401 {"ok": false} per credenziali non valide, revocate, scadute, login
 *    malformati e username riservati (`caldes-*`, rifiutati senza cercare nel
 *    database): è l'unica risposta che caldes_auth tratta come negazione;
 *  - 429 {"error"} al posto del 401 quando (IP del device, username) ha già
 *    esaurito i tentativi FALLITI della finestra. Il limite conta solo i
 *    fallimenti e non si applica mai a una password corretta: le credenziali
 *    si verificano sempre prima, quindi un device legittimo non riceve mai
 *    429, nemmeno se qualcuno ha esaurito il bucket del suo username (con
 *    X-Remote-Addr assente il bucket è comune). Per caldes_auth il 429 è una
 *    negazione temporanea (401 dopo il delay di Radicale), mai un errore del
 *    backend: non apre lo stale-if-error (contratto §9.3-§9.4);
 *  - 503 {"error"} se il database o la configurazione non permettono di
 *    rispondere: per il plugin è un errore del backend (stale-if-error), mai
 *    una negazione che invaliderebbe la password sul device.
 *
 * IP del device: caldes_auth manda `X-Forwarded-For` con il valore di
 * `X-Remote-Addr` messo da CloudPanel; si accetta anche `X-Remote-Addr`
 * inoltrato così com'è. Gli header si considerano affidabili solo perché la
 * richiesta ha già superato il Bearer di servizio e, in produzione, arriva
 * dal peer TCP di Radicale su caldav-int (CALDAV_BACKEND_ALLOWED_PEERS,
 * middleware caldav-service-auth.ts); CF-Connecting-IP e X-Real-IP, che il
 * plugin non manda mai, sono ignorati. Senza un IP valido l'ultimo uso non
 * registra l'IP (sarebbe quello di Radicale) e il rate limit usa un bucket
 * comune per username.
 *
 * Il campo credential_epoch non compare nella risposta: il contratto lo
 * distribuisce solo tramite policy.json (§9.6).
 */

import { Hono, type Context } from 'hono';
import { isIP } from 'node:net';
import { verifyCredentials } from '../../lib/calendar/caldav-passwords';
import { logger } from '../../lib/logger';

const log = logger.child({ scope: 'caldav-backend' });

export const caldavBackend = new Hono();

// ─── Rate limit per (IP del device, username) ───────────────

/**
 * Tentativi FALLITI ammessi per chiave in una finestra; oltre, i fallimenti
 * rispondono 429 invece di 401. Le credenziali valide non contano e non sono
 * mai limitate.
 */
export const VERIFY_RATE_LIMIT_MAX = 30;
/** Durata della finestra del rate limit. */
export const VERIFY_RATE_LIMIT_WINDOW_MS = 60_000;
/** Chiavi tenute in memoria al massimo: oltre si scartano le scadute, poi le più vecchie. */
const VERIFY_RATE_LIMIT_MAX_KEYS = 10_000;
/** Corpo della risposta 429 (stesso testo di middleware/rate-limit.ts). */
const RATE_LIMIT_ERROR = 'Troppi tentativi. Riprova tra qualche minuto.';

/**
 * Limite dei fallimenti a finestra fissa per chiave, in memoria (una sola
 * replica dell'API, come gli altri limiter). La memoria resta limitata a
 * VERIFY_RATE_LIMIT_MAX_KEYS voci anche con username sempre diversi.
 */
class KeyedRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number; rejected: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
  ) {}

  /**
   * Conta un tentativo fallito per `key`. 'allowed' se rientra nel limite,
   * 'limited' se la chiave aveva già esaurito la finestra corrente,
   * 'limited_first' per il primo rifiuto della finestra (per registrarlo una
   * volta sola, senza riempire i log durante un attacco).
   */
  hit(key: string, now = Date.now()): 'allowed' | 'limited' | 'limited_first' {
    const entry = this.entries.get(key);
    if (entry && now < entry.resetAt) {
      if (entry.count >= this.max) {
        entry.rejected += 1;
        return entry.rejected === 1 ? 'limited_first' : 'limited';
      }
      entry.count += 1;
      return 'allowed';
    }
    if (entry) this.entries.delete(key);
    else this.makeRoom(now);
    this.entries.set(key, { count: 1, resetAt: now + this.windowMs, rejected: 0 });
    return 'allowed';
  }

  private makeRoom(now: number): void {
    if (this.entries.size < this.maxKeys) return;
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }
    // Ancora pieno: si scartano le voci inserite per prime (ordine della Map).
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break;
      this.entries.delete(key);
    }
  }
}

const verifyLimiter = new KeyedRateLimiter(
  VERIFY_RATE_LIMIT_MAX,
  VERIFY_RATE_LIMIT_WINDOW_MS,
  VERIFY_RATE_LIMIT_MAX_KEYS,
);

/**
 * Chiave del rate limit: username senza distinzione di maiuscole, così le
 * varianti non aggirano il limite, e troncato (un login oltre 255 byte è
 * comunque rifiutato) per non tenere in memoria corpi arbitrari.
 */
function rateLimitKey(ip: string | null, username: string): string {
  return `${ip ?? '-'}\u0000${username.slice(0, 256).toLowerCase()}`;
}

// ─── IP del device ──────────────────────────────────────────

/** IP valido e normalizzato (IPv4-mapped → IPv4, IPv6 in minuscolo), altrimenti null. */
function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value || value.length > 64) return null;
  if (value.toLowerCase().startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  return isIP(value) ? value.toLowerCase() : null;
}

/**
 * IP del device da cui Radicale ha ricevuto la richiesta: primo elemento di
 * X-Forwarded-For, altrimenti X-Remote-Addr; null se nessuno dei due è un IP.
 */
function deviceIp(c: Context): string | null {
  const forwarded = c.req.header('x-forwarded-for');
  return normalizeIp(forwarded?.split(',')[0]) ?? normalizeIp(c.req.header('x-remote-addr'));
}

// ─── Auth device (Basic) ────────────────────────────────────

caldavBackend.post('/verify-credentials', async (c) => {
  // Corpo non JSON o non oggetto → credenziali assenti → 401 {ok:false}.
  const parsed: unknown = await c.req.json().catch(() => null);
  const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const ip = deviceIp(c);

  // Prima la verifica, poi il limite: una password corretta risponde sempre
  // 200 e non consuma il bucket. Chi esaurisce il bucket di (IP, username)
  // con password sbagliate ottiene solo 429 al posto di 401 (per caldes_auth
  // sono entrambi una negazione, con il delay di Radicale); il device
  // legittimo con la password giusta non viene mai bloccato. Il carico resta
  // limitato a monte da Radicale (delay di 1 s per ogni login fallito e
  // max_connections), e le app-password hanno 128 bit di entropia.
  let result;
  try {
    result = await verifyCredentials(username, password, ip);
  } catch (err) {
    // Database giù o RADICALE_PRINCIPAL non valido: mai una negazione, che
    // caldes_auth tradurrebbe in un 401 e il device in una password "errata".
    const e = err as { name?: string; code?: string; message?: string };
    log.error({ err: { name: e.name, code: e.code, message: e.message } }, 'verify-credentials non disponibile');
    return c.json({ error: 'Verifica delle credenziali non disponibile' }, 503);
  }

  if (!result.ok) {
    const limit = verifyLimiter.hit(rateLimitKey(ip, username));
    if (limit !== 'allowed') {
      if (limit === 'limited_first') {
        log.warn({ ip, username: username.slice(0, 256) }, 'verify-credentials: troppi tentativi falliti');
      }
      return c.json({ error: RATE_LIMIT_ERROR }, 429);
    }
    if (result.reason === 'reserved') {
      log.warn({ ip, username: username.slice(0, 256) }, 'verify-credentials: username riservato rifiutato');
    }
    return c.json({ ok: false }, 401);
  }
  return c.json({ ok: true, principal: result.principal, expires_at: result.expires_at ?? null });
});
