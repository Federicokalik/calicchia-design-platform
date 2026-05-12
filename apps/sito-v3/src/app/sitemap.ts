import type { MetadataRoute } from 'next';
import { SITE } from '@/data/site';
import { SERVICES as SITE_SERVICES } from '@/data/services';
import { SEO_CITIES } from '@/data/seo-cities';
import {
  SEO_SERVICES,
  getProfessionsForService,
} from '@/data/seo-service-matrix';
import { LOCALES, localizedPath, type Locale } from '@/lib/i18n';

type SitemapEntry = MetadataRoute.Sitemap[number];
type ChangeFrequency = NonNullable<SitemapEntry['changeFrequency']>;

type ApiProject = {
  slug?: string;
  updatedAt?: string | null;
  updated_at?: string | null;
};

type ApiBlogPost = {
  slug?: string;
  published_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

const STATIC_PATHS = [
  '/',
  '/lavori',
  '/servizi',
  '/contatti',
  '/perche-scegliere-me',
  '/blog',
  '/faq',
  '/glossario-web-design',
  '/web-design-freelance',
  '/web-design-vs-agenzia',
  '/sito-web-per-pmi',
  '/zone',
  '/servizi-per-professioni',
  // F5 pillar SEO ad alta priorità (2026-05-08)
  '/quanto-costa-sito-web',
  '/web-designer-vs-developer',
  '/european-accessibility-act-2025',
  '/core-web-vitals-audit',
  // F5.6 EN local pillar (EN-only render)
  '/freelance-web-designer-italy',
  // F5.11 + F5.12 EN Canada-target pillar
  '/freelance-web-designer-canada',
  '/freelance-web-designer-toronto-gta',
  // F5.13 + F5.14 EN Italian-Canadian vertical pillar
  '/italian-businesses-toronto-website-design',
  '/italian-restaurants-website-design',
  // F5.7 + F5.8 EN long-tail pillar
  '/english-speaking-web-designer-italy',
  '/italian-web-designer-for-european-business',
  // F5.10 IT pillar GA4 migration (ora bilingual IT+EN, segment-translated slug `/en/google-analytics-4-migration`)
  '/migrazione-google-analytics-4',
  // Pillar SEO MEDIA/BASSA priorità — bilingual IT+EN con slug tradotti (PATHNAMES in i18n/routing.ts)
  '/freelance-vs-agenzia-2026',
  '/wordpress-vs-headless',
  '/glossario-seo',
  '/glossario-e-commerce',
  // Legal
  '/privacy-policy',
  '/cookie-policy',
  '/termini-e-condizioni',
  '/privacy-request',
] as const;

const LEGAL_PATHS = new Set([
  '/privacy-policy',
  '/cookie-policy',
  '/termini-e-condizioni',
  '/privacy-request',
]);

/**
 * Path che esistono SOLO in EN (no IT render, no hreflang alternates).
 * Pillar EN-only sono scritte in inglese nativo, audience EU/UK/US che cerca
 * freelance Italy-based. Tradurle in IT non avrebbe senso commerciale.
 */
const EN_ONLY_PATHS = new Set<string>([
  '/freelance-web-designer-italy',
  '/freelance-web-designer-canada',
  '/freelance-web-designer-toronto-gta',
  '/italian-businesses-toronto-website-design',
  '/italian-restaurants-website-design',
  '/english-speaking-web-designer-italy',
  '/italian-web-designer-for-european-business',
]);

/**
 * Path che esistono SOLO in IT (no EN render, no hreflang alternates).
 * Allineato con `EN_PATH_DISALLOWED_PREFIXES` in proxy.ts.
 * Quando una pillar viene tradotta in EN (F3), va rimossa da qui e da proxy.
 */
const IT_ONLY_PATHS = new Set<string>([
  '/web-design-freelance-ciociaria',
  '/sito-web-per-pmi',
  '/servizi-per-professioni',
  '/quanto-costa-sito-web',
  // Pillar bilingual con EN attiva: rimossi da IT_ONLY (web-designer-vs-developer, EAA, CWV)
  '/glossario-web-design',
  // Legal
  '/privacy-policy',
  '/cookie-policy',
  '/termini-e-condizioni',
  '/privacy-request',
  '/faq',
]);

const TOP_WEEKLY = new Set(['/', '/lavori', '/blog']);
const TOP_MONTHLY = new Set([
  '/servizi',
  '/contatti',
  '/perche-scegliere-me',
  '/zone',
  '/servizi-per-professioni',
  '/glossario-web-design',
  '/web-design-freelance',
  '/web-design-vs-agenzia',
  '/sito-web-per-pmi',
  '/faq',
]);

function apiBase(): string {
  const siteWithApi = SITE as typeof SITE & { api?: string };
  return (siteWithApi.api ?? process.env.PORTAL_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

function shouldSkipLocalApiFetch(): boolean {
  const isProductionBuild =
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.npm_lifecycle_event === 'build';

  if (!isProductionBuild) return false;

  try {
    const parsed = new URL(apiBase());
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function siteBase(): string {
  return SITE.url.replace(/\/$/, '');
}

function languageAlternates(path: string): Record<string, string> {
  const base = siteBase();
  return Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      `${base}${localizedPath(path, locale as Locale)}`,
    ]),
  );
}

function priorityFor(path: string, fallback: number): number {
  if (path === '/') return 1.0;
  if (['/lavori', '/servizi', '/contatti', '/blog'].includes(path)) return 0.9;
  if (TOP_MONTHLY.has(path)) return 0.8;
  if (LEGAL_PATHS.has(path)) return 0.3;
  return fallback;
}

function frequencyFor(path: string, fallback: ChangeFrequency): ChangeFrequency {
  if (TOP_WEEKLY.has(path)) return 'weekly';
  if (LEGAL_PATHS.has(path)) return 'yearly';
  if (TOP_MONTHLY.has(path)) return 'monthly';
  return fallback;
}

function localizedEntries(
  path: string,
  now: Date,
  options: {
    priority: number;
    changeFrequency: ChangeFrequency;
    lastModified?: Date;
  },
): MetadataRoute.Sitemap {
  const base = siteBase();

  // EN-only path: solo entry EN, no hreflang IT (audience target EU/UK/US).
  if (EN_ONLY_PATHS.has(path)) {
    return [
      {
        url: `${base}${localizedPath(path, 'en' as Locale)}`,
        lastModified: options.lastModified ?? now,
        changeFrequency: options.changeFrequency,
        priority: options.priority,
      },
    ];
  }

  // IT-only path: solo entry IT, no hreflang alternates EN (evita duplicate
  // content e direct Google a indicizzare solo IT).
  if (IT_ONLY_PATHS.has(path)) {
    return [
      {
        url: `${base}${localizedPath(path, 'it' as Locale)}`,
        lastModified: options.lastModified ?? now,
        changeFrequency: options.changeFrequency,
        priority: options.priority,
      },
    ];
  }

  const alternates = { languages: languageAlternates(path) };

  return LOCALES.map((locale) => ({
    url: `${base}${localizedPath(path, locale as Locale)}`,
    lastModified: options.lastModified ?? now,
    changeFrequency: options.changeFrequency,
    priority: options.priority,
    alternates,
  }));
}

function dateFrom(value: string | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function warn(context: string, detail: unknown): void {
  if (process.env.NODE_ENV === 'production') return;
  console.warn(`[sitemap] ${context}`, detail);
}

async function fetchProjects(): Promise<ApiProject[]> {
  if (shouldSkipLocalApiFetch()) return [];

  // Public sitemap: usa /api/public/projects (no auth) invece del privato /api/projects.
  try {
    const res = await fetch(`${apiBase()}/api/public/projects?limit=50`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      warn('projects endpoint returned', res.status);
      return [];
    }
    const data = (await res.json()) as { projects?: ApiProject[] } | ApiProject[];
    return Array.isArray(data) ? data : data.projects ?? [];
  } catch (error) {
    warn('projects endpoint unavailable', error);
    return [];
  }
}

async function fetchBlogPosts(): Promise<ApiBlogPost[]> {
  if (shouldSkipLocalApiFetch()) return [];

  try {
    const res = await fetch(`${apiBase()}/api/public/blog/posts?limit=100`, {
      next: { revalidate: 300 },
    });
    if (res.status === 404) return [];
    if (!res.ok) {
      warn('blog endpoint returned', res.status);
      return [];
    }
    const data = (await res.json()) as { posts?: ApiBlogPost[] } | ApiBlogPost[];
    return Array.isArray(data) ? data : data.posts ?? [];
  } catch (error) {
    warn('blog endpoint unavailable', error);
    return [];
  }
}

function blogPath(post: ApiBlogPost): string | null {
  if (!post.slug) return null;
  const rawDate = post.published_at ?? post.created_at;
  if (!rawDate) return null;
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `/blog/${year}/${month}/${post.slug}`;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  for (const path of STATIC_PATHS) {
    entries.push(
      ...localizedEntries(path, now, {
        priority: priorityFor(path, 0.7),
        changeFrequency: frequencyFor(path, 'monthly'),
      }),
    );
  }

  for (const service of SITE_SERVICES) {
    entries.push(
      ...localizedEntries(`/servizi/${service.slug}`, now, {
        priority: 0.8,
        changeFrequency: 'monthly',
      }),
    );
  }

  const tierOneCities = SEO_CITIES.filter((city) => city.tier === 1);
  const tierOneAndTwoCities = SEO_CITIES.filter((city) => city.tier <= 2);

  for (const city of tierOneAndTwoCities) {
    entries.push(
      ...localizedEntries(`/zone/${city.slug}`, now, {
        priority: 0.7,
        changeFrequency: 'monthly',
      }),
    );
  }

  for (const city of tierOneCities) {
    for (const service of SEO_SERVICES) {
      entries.push(
        ...localizedEntries(`/zone/${city.slug}/${service.slug}`, now, {
          priority: 0.6,
          changeFrequency: 'monthly',
        }),
      );
    }
  }

  for (const service of SEO_SERVICES) {
    const professions = getProfessionsForService(service.slug).filter(
      (profession) => profession.tier <= 2,
    );
    for (const profession of professions) {
      entries.push(
        ...localizedEntries(`/${service.urlPrefix}-${profession.slug}`, now, {
          priority: 0.6,
          changeFrequency: 'monthly',
        }),
      );
    }
  }

  const [projects, posts] = await Promise.all([fetchProjects(), fetchBlogPosts()]);

  for (const project of projects) {
    if (!project.slug) continue;
    entries.push(
      ...localizedEntries(`/lavori/${project.slug}`, now, {
        priority: 0.7,
        changeFrequency: 'monthly',
        lastModified: dateFrom(project.updatedAt ?? project.updated_at, now),
      }),
    );
  }

  for (const post of posts) {
    const path = blogPath(post);
    if (!path) continue;
    entries.push(
      ...localizedEntries(path, now, {
        priority: 0.7,
        changeFrequency: 'weekly',
        lastModified: dateFrom(post.updated_at ?? post.published_at ?? post.created_at, now),
      }),
    );
  }

  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}
