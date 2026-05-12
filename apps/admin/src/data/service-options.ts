/**
 * Canonical list of service slugs/labels used by the public site
 * (`apps/sito-v3/src/data/services-content`).
 *
 * Kept here as a small admin-side mirror to power the multi-select on the
 * Portfolio editor. Free-text "services" values from older projects are
 * normalised on load — anything that doesn't match a slug is silently
 * dropped on next save (typos cleanup).
 *
 * If you add a 10th service on the public site, add it here too.
 */
export const SERVICE_OPTIONS = [
  { slug: 'web-design', label: 'Web Design' },
  { slug: 'e-commerce', label: 'E-commerce' },
  { slug: 'sviluppo-web', label: 'Sviluppo Web' },
  { slug: 'comunicazione', label: 'Comunicazione' },
  { slug: 'comunicazione-offline', label: 'Comunicazione Offline' },
  { slug: 'seo', label: 'SEO' },
  { slug: 'manutenzione', label: 'Manutenzione' },
  { slug: 'branding', label: 'Branding' },
  { slug: 'web-app', label: 'Web App' },
  { slug: 'automazioni-ai', label: 'Automazioni AI' },
] as const;

export type ServiceSlug = typeof SERVICE_OPTIONS[number]['slug'];

const VALID_SLUGS = new Set<string>(SERVICE_OPTIONS.map((s) => s.slug));

/**
 * Parse a free-text services string (e.g. "Web Design, E-commerce" or
 * "web-design,e-commerce") into a deduped array of canonical slugs.
 *
 * Normalisation: lowercase + replace spaces with `-`, then keep only
 * values present in SERVICE_OPTIONS.
 */
export function parseServicesString(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const slug = part.trim().toLowerCase().replace(/\s+/g, '-');
    if (VALID_SLUGS.has(slug) && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

/** Serialise canonical slugs back into the CSV string the API expects. */
export function serializeServices(slugs: string[]): string {
  return slugs.join(',');
}
