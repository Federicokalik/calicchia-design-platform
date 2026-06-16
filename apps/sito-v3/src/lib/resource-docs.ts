/**
 * Standalone "document" resources under /risorse that ship their own full
 * design (e.g. the GEO white paper) and therefore opt out of the global site
 * chrome (availability topbar, language banner, MorphTicker CTA). The /risorse
 * hub and the migrated glossaries are NOT here — they keep the normal chrome.
 */
// Risorse "reading-focused": tengono header/footer del sito ma nascondono il
// chrome flottante (MorphTicker "come posso aiutarti", AvailabilityTopbar,
// LanguagePromptBanner) per non disturbare la lettura. Il white paper GEO è
// integrato nel chrome ma rientra qui (richiesta utente 2026-06-16).
export const STANDALONE_RESOURCE_SLUGS = ['dalla-seo-alla-geo'] as const;

/**
 * True when `pathname` (with or without a leading /it|/en locale prefix) points
 * at a standalone resource document.
 */
export function isStandaloneResourcePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const stripped = pathname.replace(/^\/(it|en)(?=\/|$)/, '') || '/';
  return STANDALONE_RESOURCE_SLUGS.some((slug) => stripped === `/risorse/${slug}`);
}
