/**
 * Adapter — converts the flat `ApiProjectDetail` shape returned by
 * `apps/api` into the legacy editorial `Project` shape consumed by the
 * remaining case-study components (`CaseHeroOverlay`, `CaseGallery`,
 * `CaseOutcome`, `CaseQuote`, `CaseNext`).
 *
 * Migration 090 (detail redesign 2026-05-14): rimosse le sezioni editorial
 * derivate (Contesto/Sfida/Approccio + Longform). Resta un singolo blocco
 * `brief` markdown. La galleria viene letta solo dal campo `gallery`
 * (challenge_images / solution_image deprecate).
 */

import type {
  ApiProjectDetail,
  ApiProjectListItem,
  ApiProjectFeedback,
  ApiProjectMetric,
} from './projects-api';
import type { Asset, Project, ProjectSection } from '@/data/types';

const API_BASE =
  (process.env.NEXT_PUBLIC_API_URL ??
    process.env.PORTAL_API_URL ??
    'http://localhost:3001').replace(/\/$/, '');

/**
 * Resolve an image URL coming from the API.
 *   - Absolute URL (http/https) → passthrough
 *   - Path starting with `/media/...` or `/uploads/...` → API_BASE + path
 *   - Path starting with `/` (other) → frontend-relative (es. `/img/...`)
 *   - Bare key (es. `works/pooltech/hero.webp`) → API_BASE/media/<key>
 */
function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith('/media/') || url.startsWith('/uploads/')) {
    return `${API_BASE}${url}`;
  }
  if (url.startsWith('/')) return url; // frontend-relative
  return `${API_BASE}/media/${url}`;
}

/**
 * Year priority: explicit `api.year` (migration 075) > `published_at` >
 * `created_at` > current year.
 */
function deriveYear(api: ApiProjectDetail): number {
  if (typeof api.year === 'number' && api.year > 1990) return api.year;
  const ts = api.published_at ?? api.created_at;
  if (!ts) return new Date().getFullYear();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
}

/**
 * Tags priority (migration 075): `tags` column > `technologies` >
 * comma-separated `services`.
 */
function deriveTags(api: ApiProjectDetail): string[] {
  if (api.tags && api.tags.length > 0) return api.tags;
  if (api.technologies && api.technologies.length > 0) return api.technologies;
  if (api.services) {
    return api.services
      .split(/[·,;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Stale flag: case study più vecchi di 1 anno mostrano un avviso opzionale.
 */
export function getStaleStatus(year: number | null | undefined): {
  isStale: boolean;
  yearsAgo: number;
} {
  if (typeof year !== 'number' || year <= 1990) {
    return { isStale: false, yearsAgo: 0 };
  }
  const current = new Date().getFullYear();
  const yearsAgo = current - year;
  return { isStale: yearsAgo > 1, yearsAgo };
}

/** Estrae quote da feedback JSONB o string. Vuoto → null. */
function extractFeedback(
  field: ApiProjectFeedback | string | null,
  fallbackName: string | null,
): { quote: string; attribution: string } | null {
  if (!field) return null;
  if (typeof field === 'string') {
    return field.trim()
      ? { quote: field, attribution: fallbackName ?? '' }
      : null;
  }
  const quote = field.quote ?? '';
  if (!quote.trim()) return null;
  const name = field.name ?? field.author ?? fallbackName ?? '';
  const role = field.role ?? '';
  const company = field.company ?? '';
  const attribution = [name, role, company].filter(Boolean).join(' · ');
  return { quote, attribution };
}

/** Hero asset from `cover_image` with sensible defaults. */
function deriveHero(api: ApiProjectDetail): Asset {
  return {
    src: resolveImageUrl(api.cover_image) ?? '/img/works/showcase-piscina-pooltech.webp',
    alt: api.cover_alt || `${api.title} — case study`,
    width: 2400,
    height: 1350,
  };
}

/** Gallery section (l'unica sezione editorial residua dopo il redesign). */
function deriveGallerySection(api: ApiProjectDetail): ProjectSection | null {
  const galleryAssets: Asset[] = [];
  const seenSrc = new Set<string>();

  if (Array.isArray(api.gallery)) {
    for (const item of api.gallery) {
      const src =
        typeof item === 'string' ? item : (item as { src?: string }).src;
      const resolved = resolveImageUrl(src ?? null);
      if (resolved && !seenSrc.has(resolved)) {
        seenSrc.add(resolved);
        galleryAssets.push({
          src: resolved,
          alt:
            (typeof item === 'object' && item.alt) ||
            `${api.title} — immagine ${galleryAssets.length + 1}`,
          width: (typeof item === 'object' && item.width) || 2200,
          height: (typeof item === 'object' && item.height) || 1650,
        });
      }
    }
  }

  if (galleryAssets.length === 0) return null;
  return {
    kind: 'gallery',
    title: 'Il design',
    assets: galleryAssets,
  };
}

/**
 * Convert API detail → legacy `Project`. Migration 090: `sections` ora
 * contiene solo la galleria (eventualmente vuoto). Il body editorial vive
 * in `brief` esposto via `deriveCaseStudyExtension`.
 */
export function adaptApiProjectToLegacy(api: ApiProjectDetail): Project {
  const gallery = deriveGallerySection(api);
  return {
    slug: api.slug,
    title: api.title,
    client: api.client ?? api.title,
    year: deriveYear(api),
    tags: deriveTags(api),
    excerpt: api.description ?? '',
    hero: deriveHero(api),
    sections: gallery ? [gallery] : [],
    next: '', // unused — handled via fetchAdjacentProjects
  };
}

/** List item: lighter shape for `/lavori` index, including derived year. */
export interface AdaptedListItem {
  slug: string;
  title: string;
  description: string | null;
  cover_image: string | null;
  cover_alt: string | null;
  tags: string[];
  year: number;
  client: string | null;
  industries: string | null;
}

export function adaptApiListItem(
  item: ApiProjectListItem,
  fallbackYear: number = new Date().getFullYear(),
): AdaptedListItem {
  return {
    slug: item.slug,
    title: item.title,
    description: item.description,
    cover_image: resolveImageUrl(item.cover_image),
    cover_alt: item.cover_alt ?? null,
    tags: item.tags ?? [],
    year:
      typeof item.year === 'number' && item.year > 1990
        ? item.year
        : fallbackYear,
    client: item.client,
    industries: item.industries,
  };
}

/** Get the feedback quote (if any) — used by `<CaseQuote>` upstream. */
export function deriveFeedbackQuote(api: ApiProjectDetail): {
  quote: string;
  attribution: string;
} | null {
  return extractFeedback(api.feedback, api.client ?? api.title);
}

/**
 * Case study extension data — campi addizionali esposti dal backend
 * (migration 075 + 090). Restituiti accanto al Project legacy così la
 * page può comporre CaseHeroOverlay + CaseBrief + CaseOutcome + Quote.
 */
export interface CaseStudyExtensionData {
  year: number;
  isStale: boolean;
  yearsAgo: number;
  metrics: ApiProjectMetric[];
  outcome: string | null;
  /** Migration 090 — body unico markdown del case study. */
  brief: string | null;
  liveUrl: string | null;
  seoTitleOverride: string | null;
  seoDescriptionOverride: string | null;
  client: string | null;
  industries: string | null;
  servicesLine: string | null;
}

export function deriveCaseStudyExtension(
  api: ApiProjectDetail,
): CaseStudyExtensionData {
  const year = deriveYear(api);
  const stale = getStaleStatus(year);
  return {
    year,
    isStale: stale.isStale,
    yearsAgo: stale.yearsAgo,
    metrics: Array.isArray(api.metrics) ? api.metrics : [],
    outcome: api.outcome,
    brief:
      typeof api.brief === 'string' && api.brief.trim() ? api.brief : null,
    liveUrl: api.live_url,
    seoTitleOverride: api.seo_title,
    seoDescriptionOverride: api.seo_description,
    client: api.client,
    industries: api.industries,
    servicesLine: api.services,
  };
}
