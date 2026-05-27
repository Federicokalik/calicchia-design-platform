/**
 * cms — DB-backed read helpers for FAQ / team / glossario / etc.
 *
 * Audit C-013/C-014: marketing content moves from data/*.ts (code-edit +
 * redeploy) to site_* tables (admin-editable). Helpers below:
 *   - fetch the DB-backed list via /api/public/cms/<entity>?locale=...
 *   - return the file defaults when the API returns an empty array
 *     (fresh install) or the fetch errors (API down during build)
 *
 * Never throw — public surfaces must render even with the API offline.
 * Caching is `next.revalidate: 300` so admin edits propagate in <5min.
 */

import { FAQS, type FaqEntry } from '@/data/faqs';
import { TEAM, type TeamMember } from '@/data/team';
import { GLOSSARIO, GLOSSARIO_LETTERS, type GlossarioEntry } from '@/data/glossario';
import { SEO_CITIES, type SeoCity } from '@/data/seo-cities';

const API_URL = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:3001';

type Locale = 'it' | 'en';

interface FaqRow {
  id: string;
  question: string;
  answer: string;
  sort_order: number | null;
}

interface TeamRow {
  id: string;
  name: string;
  role: string;
  bio: string | null;
  avatar_url: string | null;
  email: string | null;
  socials: Array<{ label: string; url: string; icon?: string }> | null;
  sort_order: number | null;
}

async function fetchCms<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL.replace(/\/$/, '')}${path}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[cms] fetch ${path} failed, falling back to file defaults:`, err);
    return null;
  }
}

/**
 * Returns the FAQ list for the given locale. Falls back to data/faqs.ts
 * when the DB is empty (fresh install) or the API is unreachable.
 */
export async function getFaqs(locale: Locale = 'it'): Promise<FaqEntry[]> {
  const res = await fetchCms<{ faqs: FaqRow[] }>(`/api/public/cms/faqs?locale=${locale}`);
  if (res && Array.isArray(res.faqs) && res.faqs.length > 0) {
    return res.faqs.map((r) => ({ question: r.question, answer: r.answer }));
  }
  return FAQS;
}

interface SeoCityRow {
  id: string;
  slug: string;
  nome: string;
  regione: string;
  tipo: 'capoluogo' | 'ciociaria';
  tier: 1 | 2 | 3;
  sort_order: number | null;
}

/**
 * SeoCityIndex — facade returned by getSeoCities() so consumers don't
 * need to re-derive `bySlug` / `byRegione` / `capoluoghi` themselves.
 * Matches the function exports of data/seo-cities.ts.
 */
export interface SeoCityIndex {
  all: SeoCity[];
  bySlug: Map<string, SeoCity>;
  capoluoghi: SeoCity[];
  ciociaria: SeoCity[];
  byRegione(regione: string): SeoCity[];
  getCityBySlug(slug: string): SeoCity | undefined;
}

function buildSeoCityIndex(cities: SeoCity[]): SeoCityIndex {
  const bySlug = new Map<string, SeoCity>();
  for (const c of cities) bySlug.set(c.slug, c);
  return {
    all: cities,
    bySlug,
    capoluoghi: cities.filter((c) => c.tipo === 'capoluogo'),
    ciociaria: cities.filter((c) => c.tipo === 'ciociaria'),
    byRegione: (regione: string) => cities.filter((c) => c.regione === regione),
    getCityBySlug: (slug: string) => bySlug.get(slug),
  };
}

/**
 * Returns the SEO city index. DB rows take precedence; falls back to the
 * file `SEO_CITIES` when the table is empty (fresh install) or the API
 * is unreachable (build-time outage). Single-locale by design — city
 * names don't translate, surrounding marketing copy does.
 */
export async function getSeoCities(): Promise<SeoCityIndex> {
  const res = await fetchCms<{ cities: SeoCityRow[] }>('/api/public/cms/seo-cities');
  if (res && Array.isArray(res.cities) && res.cities.length > 0) {
    return buildSeoCityIndex(res.cities as SeoCity[]);
  }
  return buildSeoCityIndex(SEO_CITIES);
}

interface GlossarioRow {
  id: string;
  slug: string;
  term: string;
  full_name: string | null;
  letter: string;
  what_it_is: string;
  why_you_care: string;
  what_to_demand: string;
  sort_order: number | null;
}

/**
 * Returns the glossario entries + the unique letter index. Falls back to
 * data/glossario.ts when the DB is empty or the API is unreachable.
 *
 * Returns the SAME shape as the file constants (`GLOSSARIO` +
 * `GLOSSARIO_LETTERS`) so the consumer (glossario page) keeps its
 * existing render path.
 */
export async function getGlossario(
  locale: Locale = 'it',
): Promise<{ entries: GlossarioEntry[]; letters: string[] }> {
  const res = await fetchCms<{ entries: GlossarioRow[] }>(
    `/api/public/cms/glossario?locale=${locale}`,
  );
  if (res && Array.isArray(res.entries) && res.entries.length > 0) {
    const entries: GlossarioEntry[] = res.entries.map((r) => ({
      slug: r.slug,
      term: r.term,
      fullName: r.full_name ?? undefined,
      letter: r.letter,
      whatItIs: r.what_it_is,
      whyYouCare: r.why_you_care,
      whatToDemand: r.what_to_demand,
    }));
    const letters = Array.from(new Set(entries.map((e) => e.letter))).sort();
    return { entries, letters };
  }
  return { entries: GLOSSARIO, letters: [...GLOSSARIO_LETTERS] };
}

/**
 * Returns the team list for the given locale. Falls back to data/team.ts
 * when the DB is empty or the API is unreachable.
 *
 * Avatar shape is rebuilt from the single `avatar_url` column with
 * sensible defaults (alt = name, 600x600) so the consumer (TeamSection)
 * can keep its existing `member.avatar.{src,alt,width,height}` API
 * without per-row width/height fields in the DB.
 */
export async function getTeam(locale: Locale = 'it'): Promise<TeamMember[]> {
  const res = await fetchCms<{ team: TeamRow[] }>(`/api/public/cms/team?locale=${locale}`);
  if (res && Array.isArray(res.team) && res.team.length > 0) {
    return res.team.map((r, i) => ({
      // TeamMember.id is a `number` in the file; rows use UUIDs so we
      // hash to a stable positive int via the row's index in the list +
      // a high offset to avoid collisions with the file-defined ids (1, 2…).
      id: 1000 + i,
      name: r.name,
      role: r.role,
      avatar: {
        src: r.avatar_url ?? '',
        alt: r.name,
        width: 600,
        height: 600,
      },
      socials: Array.isArray(r.socials)
        ? r.socials.map((s) => ({ label: s.label, url: s.url }))
        : [],
    }));
  }
  return TEAM;
}
