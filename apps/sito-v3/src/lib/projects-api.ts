/**
 * Projects API client - fetch dal backend Hono in `apps/api`.
 *
 * Server-side only: Server Components / metadata / static params. The database
 * source of truth is `apps/api`; no static fallback is used here.
 */

const REVALIDATE_SECONDS = 600;

export interface ApiProjectListItem {
  slug: string;
  title: string;
  description: string | null;
  cover_image: string | null;
  tags: string[];
  year: number | null;
  client: string | null;
  industries: string | null;
}

/** Strutture JSONB esposte dal backend Hono. */
export interface ApiProjectChallenge {
  text?: string;
  detail?: string;
  title?: string;
  description?: string;
}
export interface ApiProjectSolution {
  text?: string;
  detail?: string;
  title?: string;
  description?: string;
}
export interface ApiProjectFeedback {
  quote?: string;
  name?: string;
  author?: string;
  role?: string;
  company?: string;
}
export interface ApiProjectGalleryItem {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
  caption?: string;
}
/**
 * Metrica Outcome.
 * Forme accettate (frontend gestisce entrambe):
 *   { label: "Lead/mese", value: "+120%" }
 *   { label: "Tempo prenotazione", before: "3 min", after: "40 sec", unit: "" }
 */
export interface ApiProjectMetric {
  label: string;
  value?: string;
  before?: string;
  after?: string;
  unit?: string;
}

export interface ApiProjectDetail {
  slug: string;
  title: string;
  description: string | null;
  /** Long-form markdown editorial (admin Rich Text TipTap → markdown). */
  content: string | null;
  client: string | null;
  services: string | null;
  industries: string | null;
  cover_image: string | null;
  gallery: ApiProjectGalleryItem[];
  technologies: string[];
  challenge: ApiProjectChallenge | string | null;
  challenge_images: ApiProjectGalleryItem[] | string[] | null;
  solution: ApiProjectSolution | string | null;
  solution_image: string | null;
  feedback: ApiProjectFeedback | string | null;
  // Migration 075 — case study extension
  year: number | null;
  tags: string[];
  metrics: ApiProjectMetric[];
  outcome: string | null;
  seo_title: string | null;
  seo_description: string | null;
  live_url: string | null;
  published_at: string | null;
  created_at: string;
}

export interface ApiProjectAdjacent {
  slug: string;
  title: string;
}

export interface ApiProjectDetailResponse {
  project: ApiProjectDetail;
  prev: ApiProjectAdjacent | null;
  next: ApiProjectAdjacent | null;
}

interface ApiProjectListResponse {
  projects: ApiProjectListItem[];
}

function apiBase(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.PORTAL_API_URL ??
    'http://localhost:3001'
  ).replace(/\/$/, '');
}

function shouldSkipLocalApiFetch(url: string): boolean {
  const isProductionBuild =
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.npm_lifecycle_event === 'build';

  if (!isProductionBuild) return false;

  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function warn(context: string, detail: unknown): void {
  if (process.env.NODE_ENV === 'production') return;
  console.warn(`[projects-api] ${context}`, detail);
}

async function fetchJson<T>(url: string): Promise<T | null> {
  if (shouldSkipLocalApiFetch(url)) return null;

  try {
    const res = await fetch(url, { next: { revalidate: REVALIDATE_SECONDS } });
    if (!res.ok) {
      warn(`${url} returned`, res.status);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    warn(`${url} fetch failed`, error);
    return null;
  }
}

/**
 * Locale supportate (allineato a sito-v3 i18n LOCALES).
 * Default 'it' se non specificato — backward-compat per call site esistenti.
 */
type SupportedLocale = 'it' | 'en';

function withLocale(url: string, locale: SupportedLocale): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}locale=${locale}`;
}

/** Lista tutti i progetti pubblicati. Locale default 'it'. */
export async function fetchAllPublishedProjects(
  locale: SupportedLocale = 'it',
): Promise<ApiProjectListItem[]> {
  const data = await fetchJson<ApiProjectListResponse>(
    withLocale(`${apiBase()}/api/public/projects`, locale),
  );
  return data?.projects ?? [];
}

/** Dettaglio progetto + prev/next circular dal backend. Locale default 'it'. */
export async function fetchProjectBySlug(
  slug: string,
  locale: SupportedLocale = 'it',
): Promise<ApiProjectDetailResponse | null> {
  return fetchJson<ApiProjectDetailResponse>(
    withLocale(`${apiBase()}/api/public/projects/${encodeURIComponent(slug)}`, locale),
  );
}

/**
 * Filtro per servizio (es. "web-design", "e-commerce").
 * Backend: ILIKE %slug% sul campo `services` normalized. Locale default 'it'.
 */
export async function fetchProjectsForService(
  serviceSlug: string,
  limit?: number,
  locale: SupportedLocale = 'it',
): Promise<ApiProjectListItem[]> {
  const params = new URLSearchParams({ service: serviceSlug, locale });
  if (limit !== undefined) params.set('limit', String(limit));

  const data = await fetchJson<ApiProjectListResponse>(
    `${apiBase()}/api/public/projects?${params.toString()}`,
  );
  return data?.projects ?? [];
}

/**
 * Wrapper che ritorna SOLO prev/next.
 * Se l'unico progetto pubblicato e' il corrente, evita il self-loop.
 */
export async function fetchAdjacentProjects(
  currentSlug: string,
  locale: SupportedLocale = 'it',
): Promise<{ prev: ApiProjectAdjacent | null; next: ApiProjectAdjacent | null }> {
  const detail = await fetchProjectBySlug(currentSlug, locale);
  if (!detail) return { prev: null, next: null };

  const { prev, next } = detail;
  if (prev?.slug === currentSlug && next?.slug === currentSlug) {
    return { prev: null, next: null };
  }

  return { prev, next };
}
