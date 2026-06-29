/**
 * Public-facing API URL — usato per costruire URL assoluti consegnati a
 * client esterni (ICS feed subscription, WhatsApp media, ecc.).
 *
 * `PUBLIC_API_URL` è la variabile canonica; `API_URL` è il fallback (stesso
 * valore in produzione, a volte diverso in dev quando l'API è dietro tunnel).
 * In dev si cade su http://localhost:3001 così `pnpm dev` funziona senza .env;
 * in prod si logga un console.error esplicito così una variabile mancante non
 * produce silenziosamente link localhost (Audit D-008 — stesso pattern di
 * apps/admin/src/lib/public-urls.ts).
 */
export function publicApiUrl(): string {
  const explicit = process.env.PUBLIC_API_URL || process.env.API_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:3001';
  console.error(
    '[public-url] PUBLIC_API_URL (e API_URL) non impostata in questo build di produzione. ' +
      'I link generati punteranno a http://localhost:3001 — correggi .env prima di esporre UI client-facing.',
  );
  return 'http://localhost:3001';
}
