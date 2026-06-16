/**
 * Standalone "document" resources under /risorse that ship their own full
 * design (e.g. the GEO white paper) and therefore opt out of the global site
 * chrome (availability topbar, language banner, MorphTicker CTA). The /risorse
 * hub and the migrated glossaries are NOT here — they keep the normal chrome.
 */
// Vuoto dal 2026-06-16: il white paper GEO è ora integrato nel chrome del sito
// (header/footer + TOC sticky sx), quindi nessuna risorsa nasconde più il chrome
// globale. La lista resta come hook per eventuali documenti standalone futuri.
export const STANDALONE_RESOURCE_SLUGS = [] as const;

/**
 * True when `pathname` (with or without a leading /it|/en locale prefix) points
 * at a standalone resource document.
 */
export function isStandaloneResourcePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const stripped = pathname.replace(/^\/(it|en)(?=\/|$)/, '') || '/';
  return STANDALONE_RESOURCE_SLUGS.some((slug) => stripped === `/risorse/${slug}`);
}
