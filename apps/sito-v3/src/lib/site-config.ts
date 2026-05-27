/**
 * site-config — DB-backed override of `data/site.ts`.
 *
 * Audit C-013/C-014: marketing copy and contact data lived hardcoded in
 * `data/site.ts`. The admin now writes the editable subset into
 * `site_settings.business.profile` + `site_settings.site.public`, which the
 * api exposes at `/api/public/site-config`. This helper fetches that endpoint
 * server-side and merges the response over the file-defined `SITE` defaults.
 *
 * Why merge instead of replace:
 *   - `data/site.ts` keeps STRUCTURAL data the admin must never edit:
 *     SERVICE_SLUGS, PROFESSION_SLUGS, buildMatrixUrl, nav, etc.
 *   - The admin only owns the editable surface: brand, description, contact
 *     email/phone/address/vat, social links, geo coords, cal URL.
 *   - DB-NULL means "not set yet" → fall back to the file value so a freshly
 *     installed instance still renders.
 *
 * Caching: Next 16 fetch with `next: { revalidate: 300 }` so we don't hit the
 * api on every server render — a 5-min hot path is fine for marketing surfaces
 * and matches the `Cache-Control: s-maxage=300` the endpoint sets.
 *
 * The helper NEVER throws — public surfaces must render even when the api is
 * temporarily unreachable. Errors degrade to the file defaults silently
 * (logged to console.warn so the issue surfaces in server logs).
 */

import { SITE } from '@/data/site';
import type { SiteConfig } from '@/data/types';

interface ApiSiteConfig {
  brand: string | null;
  legalName: string | null;
  description: string | null;
  contact: {
    email: string | null;
    phone: string | null;
    pec: string | null;
    vat: string | null;
    sdi: string | null;
    address: {
      street: string | null;
      city: string | null;
      postalCode: string | null;
      country: string | null;
    };
    cal: string | null;
  };
  social: Array<{ label: string; url: string; icon?: string }> | null;
  geo: {
    lat?: number;
    lng?: number;
    city?: string;
    province?: string;
    region?: string;
    country?: string;
    postalCode?: string;
  } | null;
}

/** Public shape returned to consumers — same as data/site.ts SITE so call sites stay shape-compatible. */
export type RuntimeSiteConfig = SiteConfig;

const API_URL = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:3001';

function formatAddressLine(a: ApiSiteConfig['contact']['address']): string | null {
  const parts = [a.street, [a.postalCode, a.city].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

async function fetchApiConfig(): Promise<ApiSiteConfig | null> {
  try {
    const res = await fetch(`${API_URL.replace(/\/$/, '')}/api/public/site-config`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as ApiSiteConfig;
  } catch (err) {
    // Public surface must render even with API down — log and fall back.
    console.warn('[site-config] fetch failed, using file defaults:', err);
    return null;
  }
}

/**
 * Returns the merged site config (DB overrides + file defaults). The shape
 * is identical to `SITE` so existing call sites work after replacing
 * `import { SITE }` with `const SITE = await getSiteConfig()`.
 */
export async function getSiteConfig(): Promise<RuntimeSiteConfig> {
  const api = await fetchApiConfig();
  if (!api) return SITE;

  // Compose contact address as the same single-line string `SITE.contact.address` uses.
  const apiAddrLine = formatAddressLine(api.contact.address);

  return {
    ...SITE,
    brand: api.brand ?? SITE.brand,
    legalName: api.legalName ?? SITE.legalName,
    description: api.description ?? SITE.description,
    contact: {
      ...SITE.contact,
      email: api.contact.email ?? SITE.contact.email,
      phone: api.contact.phone ?? SITE.contact.phone,
      address: apiAddrLine ?? SITE.contact.address,
      vat: api.contact.vat ? `P.IVA ${api.contact.vat}` : SITE.contact.vat,
      cal: api.contact.cal ?? SITE.contact.cal,
    },
    social: api.social && api.social.length > 0 ? api.social.map((s) => ({
      label: s.label,
      url: s.url,
      icon: s.icon ?? 'link',
    })) : SITE.social,
    geo: api.geo && Object.keys(api.geo).length > 0
      ? { ...SITE.geo, ...api.geo }
      : SITE.geo,
  };
}
