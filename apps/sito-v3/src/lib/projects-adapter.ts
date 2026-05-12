/**
 * Adapter — converts the flat `ApiProjectDetail` shape returned by
 * `apps/api` into the legacy editorial `Project` / `ProjectSection` shape
 * consumed by the existing case-study components (`CaseHero`,
 * `CaseOverview`, `CaseChallenge`, `CaseGallery`, `CaseOutcome`,
 * `CaseLongform`, `CaseNext`). This keeps the components untouched while
 * routing data through the DB.
 *
 * Migration 075 (case-study fields): challenge/solution/feedback are now
 * JSONB structs and year/tags/metrics/outcome/seo are dedicated columns.
 * Helpers normalise back-compat with legacy string values.
 *
 * Decisions:
 *   - `next` is intentionally left as `''` here. The page component
 *     fetches `prev/next` via `fetchAdjacentProjects` (anti self-loop)
 *     and passes them to `<CaseNext>` directly, NOT via `project.next`.
 *   - `cover_image` is already a resolved URL (server `resolveImageUrl`).
 *     Gallery URLs (`challenge_images`, `solution_image`) are NOT
 *     resolved by the public route — we apply a defensive resolver here.
 */

import type {
  ApiProjectDetail,
  ApiProjectListItem,
  ApiProjectChallenge,
  ApiProjectSolution,
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
 *   - Bare key (es. `works/pooltech/hero.webp`) → API_BASE/media/<key>,
 *     coerente con apps/api/src/lib/s3.ts (UPLOAD_DIR served on /media/)
 */
function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith('/media/') || url.startsWith('/uploads/')) {
    return `${API_BASE}${url}`;
  }
  if (url.startsWith('/')) return url; // frontend-relative
  // Bare key — assume it's an UPLOAD_DIR key (apps/api uploads served on /media/)
  return `${API_BASE}/media/${url}`;
}

/**
 * Year priority: explicit `api.year` (migration 075) > `published_at` >
 * `created_at` > current year. The explicit field gives the editor full
 * control (es. progetti pubblicati ora che si riferiscono a lavori del 2022).
 */
function deriveYear(api: ApiProjectDetail): number {
  if (typeof api.year === 'number' && api.year > 1990) return api.year;
  const ts = api.published_at ?? api.created_at;
  if (!ts) return new Date().getFullYear();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
}

/**
 * Tags priority (migration 075): dedicated `tags` column > `technologies`
 * > comma-separated `services`. Tags are filterable categories ("e-commerce",
 * "wordpress", "b2b"), distinct from technologies (stack like "Next.js, Stripe")
 * and services (free-text servizi prestati like "Web design, SEO").
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
 * Stale flag: case study più vecchi di 1 anno mostrano un avviso
 * ("il sito potrebbe essere cambiato o non più online"). Threshold: year
 * < currentYear - 1. Esempi: nel 2026, year=2024 → stale; year=2025 → fresh.
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

/** Estrae body principale + dettaglio da challenge/solution JSONB o string. */
function extractRichText(
  field: ApiProjectChallenge | ApiProjectSolution | string | null,
): { text: string; detail: string | null } | null {
  if (!field) return null;
  if (typeof field === 'string') {
    return field.trim() ? { text: field, detail: null } : null;
  }
  // JSONB struct: prefer `text/detail` (rayo schema), fallback to
  // `description/title` (admin form schema).
  const text = field.text ?? field.description ?? '';
  const detail = field.detail ?? null;
  if (!text || !text.trim()) return null;
  return { text, detail };
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
    alt: `${api.title} — case study`,
    width: 2400,
    height: 1350,
  };
}

/** Build the editorial `sections[]` array from the flat API shape. */
function deriveSections(api: ApiProjectDetail): ProjectSection[] {
  const sections: ProjectSection[] = [];

  if (api.description) {
    sections.push({
      kind: 'overview',
      title: 'Il contesto',
      body: api.description,
    });
  }

  const challenge = extractRichText(api.challenge);
  if (challenge) {
    sections.push({
      kind: 'challenge',
      title: 'La sfida',
      body: challenge.detail
        ? `${challenge.text}\n\n${challenge.detail}`
        : challenge.text,
    });
  }

  const solution = extractRichText(api.solution);
  if (solution) {
    sections.push({
      kind: 'overview',
      title: "L'approccio",
      body: solution.detail
        ? `${solution.text}\n\n${solution.detail}`
        : solution.text,
    });
  }

  // Gallery: prefer dedicated `api.gallery` (JSONB array of objects), fallback
  // to legacy challenge_images + solution_image (string[]). De-duplicated.
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

  const challengeImages = api.challenge_images;
  if (Array.isArray(challengeImages)) {
    for (const img of challengeImages) {
      const src = typeof img === 'string' ? img : (img as { src?: string }).src;
      const resolved = resolveImageUrl(src ?? null);
      if (resolved && !seenSrc.has(resolved)) {
        seenSrc.add(resolved);
        galleryAssets.push({
          src: resolved,
          alt: `${api.title} — immagine ${galleryAssets.length + 1}`,
          width: 2200,
          height: 1650,
        });
      }
    }
  }
  if (api.solution_image) {
    const resolved = resolveImageUrl(api.solution_image);
    if (resolved && !seenSrc.has(resolved)) {
      seenSrc.add(resolved);
      galleryAssets.push({
        src: resolved,
        alt: `${api.title} — design`,
        width: 2200,
        height: 1650,
      });
    }
  }

  if (galleryAssets.length > 0) {
    sections.push({
      kind: 'gallery',
      title: 'Il design',
      assets: galleryAssets,
    });
  }

  return sections;
}

/**
 * Convert API detail → legacy `Project` so existing Case* components keep
 * working untouched. `next` is set to empty string; page component handles
 * prev/next via `fetchAdjacentProjects`.
 */
export function adaptApiProjectToLegacy(api: ApiProjectDetail): Project {
  return {
    slug: api.slug,
    title: api.title,
    client: api.client ?? api.title,
    year: deriveYear(api),
    tags: deriveTags(api),
    excerpt: api.description ?? '',
    hero: deriveHero(api),
    sections: deriveSections(api),
    next: '', // unused — handled via fetchAdjacentProjects
  };
}

/** List item: lighter shape for `/lavori` index, including derived year. */
export interface AdaptedListItem {
  slug: string;
  title: string;
  description: string | null;
  cover_image: string | null;
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
 * Case study extension data — fields exposed by migration 075 + helpers.
 * Returned alongside the legacy `Project` shape so the page component
 * can wire new sections (Outcome+Metrics, StaleNotice, SEO override)
 * without refactoring the existing Case* components.
 */
export interface CaseStudyExtensionData {
  year: number;
  isStale: boolean;
  yearsAgo: number;
  metrics: ApiProjectMetric[];
  outcome: string | null;
  /** Long-form markdown editorial dal campo `content` (admin Rich Text). */
  longformMarkdown: string | null;
  liveUrl: string | null;
  seoTitleOverride: string | null;
  seoDescriptionOverride: string | null;
  client: string | null;
  industries: string | null;
  servicesLine: string | null;
}

export function deriveCaseStudyExtension(
  api: ApiProjectDetail & { content?: string | null },
): CaseStudyExtensionData {
  const year = deriveYear(api);
  const stale = getStaleStatus(year);
  return {
    year,
    isStale: stale.isStale,
    yearsAgo: stale.yearsAgo,
    metrics: Array.isArray(api.metrics) ? api.metrics : [],
    outcome: api.outcome,
    longformMarkdown:
      typeof api.content === 'string' && api.content.trim()
        ? api.content
        : null,
    liveUrl: api.live_url,
    seoTitleOverride: api.seo_title,
    seoDescriptionOverride: api.seo_description,
    client: api.client,
    industries: api.industries,
    servicesLine: api.services,
  };
}
