'use client';

/**
 * useSiteConfig — client-side counterpart to getSiteConfig().
 *
 * Audit C-013/C-014: client components (FooterMap, MenuOverlay, SiteFooter,
 * ContactFormClient) cannot await getSiteConfig() in a server component, so
 * they need a hook that fetches the same /api/public/site-config endpoint
 * once at mount and exposes the merged config via React context.
 *
 * Until the fetch resolves, the hook returns the file-defined `SITE` so the
 * UI renders correctly on first paint (no flash of empty contacts). Once the
 * API responds, the merged value replaces the file defaults — components
 * re-render with the admin-edited fields.
 *
 * Single in-flight promise + deduped fetch matches the runtime-config
 * pattern so we never fire two parallel requests when multiple client
 * components mount on the same page.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { SITE } from '@/data/site';
import type { SiteConfig } from '@/data/types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

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

const SiteConfigContext = createContext<SiteConfig>(SITE);

let inflight: Promise<SiteConfig> | null = null;

function formatAddressLine(a: ApiSiteConfig['contact']['address']): string | null {
  const parts = [a.street, [a.postalCode, a.city].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function mergeWithDefaults(api: ApiSiteConfig | null): SiteConfig {
  if (!api) return SITE;
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
    social: api.social && api.social.length > 0
      ? api.social.map((s) => ({ label: s.label, url: s.url, icon: s.icon ?? 'link' }))
      : SITE.social,
    geo: api.geo && Object.keys(api.geo).length > 0
      ? { ...SITE.geo, ...api.geo }
      : SITE.geo,
  };
}

function fetchSiteConfig(): Promise<SiteConfig> {
  if (inflight) return inflight;
  inflight = fetch(`${API_BASE.replace(/\/$/, '')}/api/public/site-config`, {
    credentials: 'omit',
  })
    .then((res) => {
      if (!res.ok) throw new Error(`site-config fetch ${res.status}`);
      return res.json() as Promise<ApiSiteConfig>;
    })
    .then((api) => mergeWithDefaults(api))
    .catch((err) => {
      // Public surface must render — log + fall back to file defaults.
      console.warn('[use-site-config] fetch failed, using file defaults:', err);
      return SITE;
    });
  return inflight;
}

export function SiteConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SiteConfig>(SITE);

  useEffect(() => {
    let cancelled = false;
    fetchSiteConfig().then((config) => {
      if (cancelled) return;
      setState(config);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SiteConfigContext.Provider value={state}>
      {children}
    </SiteConfigContext.Provider>
  );
}

/**
 * Returns the SiteConfig — file defaults until the API responds, merged
 * DB values after. Never returns null; safe to read fields directly.
 */
export function useSiteConfig(): SiteConfig {
  return useContext(SiteConfigContext);
}
