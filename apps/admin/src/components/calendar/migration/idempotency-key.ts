/**
 * Chiave d'idempotenza dei run del wizard legata alla richiesta (F3-SEC-05).
 * Modulo puro, senza import: si prova da solo.
 *
 * La chiave resta la stessa per un nuovo tentativo identico (dopo un errore di
 * rete o un 5xx il server fa il replay del run già creato) e cambia appena
 * cambiano le variabili, oppure dopo un errore che garantisce che nessun run è
 * stato creato. Così una risposta persa seguita da una modifica (opzione,
 * file, frase) non riceve mai 409 IDEMPOTENCY_KEY_REUSED, che dalla UI non si
 * potrebbe risolvere.
 */

/** Impronta delle variabili di una richiesta (un File vale per nome, dimensione e data di modifica; chiavi ordinate). */
export function requestFingerprint(vars: unknown): string {
  return JSON.stringify(vars ?? null, (_k, v: unknown) => {
    if (typeof File !== 'undefined' && v instanceof File) return { file: v.name, size: v.size, lastModified: v.lastModified };
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export interface IdempotencyKeyTracker {
  /** Chiave per una richiesta con queste variabili. */
  keyFor(vars: unknown): string;
  /** Richiesta riuscita: la prossima azione è un'altra richiesta. */
  succeeded(): void;
  /** Richiesta fallita: chiave nuova solo se l'errore garantisce che il run non esiste. */
  failed(err: unknown): void;
}

export function createIdempotencyKeyTracker(opts: { generate: () => string; noRunCreated: (err: unknown) => boolean }): IdempotencyKeyTracker {
  let current: { key: string; fingerprint: string | null } = { key: opts.generate(), fingerprint: null };
  return {
    keyFor(vars) {
      const fingerprint = requestFingerprint(vars);
      if (current.fingerprint !== null && current.fingerprint !== fingerprint) current = { key: opts.generate(), fingerprint };
      else current.fingerprint = fingerprint;
      return current.key;
    },
    succeeded() {
      current = { key: opts.generate(), fingerprint: null };
    },
    failed(err) {
      if (opts.noRunCreated(err)) current = { key: opts.generate(), fingerprint: null };
    },
  };
}
