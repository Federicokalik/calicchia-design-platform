/**
 * fetch con timeout, build-aware.
 *
 * Durante `next build` le pagine che pre-renderizzano (es. zone/[comune] via
 * generateStaticParams) fetchano l'API pubblica. Se l'API non è raggiungibile
 * dal runner di build, una fetch senza cap aspetta il default della piattaforma
 * (~10s, moltiplicato per i tentativi IPv4/IPv6): la latenza cumulata per pagina
 * sfora il budget di 60s/pagina dell'export statico di Next e fa fallire il
 * build (incident 2026-06-18, deploy del GEO Audit). Un timeout breve in build
 * fa scattare in fretta il fallback ai file; a runtime l'API è veloce, quindi un
 * cap leggermente più ampio è innocuo.
 */
const isBuild = process.env.NEXT_PHASE === 'phase-production-build';
const DEFAULT_TIMEOUT_MS = isBuild ? 3000 : 8000;

export async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
