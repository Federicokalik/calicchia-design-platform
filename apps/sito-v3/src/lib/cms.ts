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
import { getServices, getMatrixServices, getStandaloneServices } from '@/data/services';
import type { Service } from '@/data/types';
import { getCuriosita as getCuriositaFromFile, type Curiosita } from '@/data/curiosita';
import { getApproach as getApproachFromFile, type ApproachClaim } from '@/data/approach';
import { CLIENTS, type Client } from '@/data/clients';
import { getPerchiFaqs as getPerchiFaqsFromFile, type FaqItem } from '@/data/perchi-faqs';

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

type FaqSection = 'general' | 'perche' | `service:${string}`;

/**
 * Returns the FAQ list for the given locale + section. Falls back to the
 * appropriate file constants:
 *   - section='general' → data/faqs.ts (FAQS)
 *   - section='perche'  → data/perchi-faqs.ts
 * when the DB is empty (fresh install) or the API is unreachable.
 */
export async function getFaqs(
  locale: Locale = 'it',
  section: FaqSection = 'general',
): Promise<FaqEntry[]> {
  const res = await fetchCms<{ faqs: FaqRow[] }>(
    `/api/public/cms/faqs?locale=${locale}&section=${encodeURIComponent(section)}`,
  );
  if (res && Array.isArray(res.faqs) && res.faqs.length > 0) {
    return res.faqs.map((r) => ({ question: r.question, answer: r.answer }));
  }
  // File fallback varies by section: only 'general' and 'perche' have a
  // file equivalent today; per-service FAQ would 404 → empty array.
  if (section === 'perche') return getPerchiFaqsFromFile(locale) as FaqItem[];
  if (section === 'general') return FAQS;
  return [];
}

/**
 * Wrapper for /perche-scegliere-me FAQs (section='perche').
 * Returns the FaqItem shape from data/perchi-faqs.ts (same as FaqEntry).
 */
export async function getPerchiFaqs(locale: Locale = 'it'): Promise<FaqItem[]> {
  return (await getFaqs(locale, 'perche')) as FaqItem[];
}

interface ServiceRow {
  id: string;
  slug: string;
  title: string;
  lead: string;
  deliverables: unknown;
  icon: string;
  category: 'matrix' | 'standalone';
  sort_order: number | null;
}

/**
 * ServiceCatalog — facade matching the function exports of data/services.ts
 * so existing consumers (sitemap, /servizi, /perche-scegliere-me, /servizi-
 * per-professioni, home) only swap the call site.
 *
 * NOTE: long-form `ServiceDetail` content (awareness, process, faq,
 * features, storyline, expanded scope) is intentionally NOT in this CMS —
 * it lives in apps/sito-v3/src/data/services-content/<slug>.ts because
 * the schema is too rich and voice-tuned to edit safely from a generic
 * form. Future work if marketing wants per-section CRUD.
 */
export interface ServiceCatalog {
  all: Service[];
  matrix: Service[];
  standalone: Service[];
}

/**
 * Returns the service catalog for the given locale. Falls back to the
 * file constants (MATRIX_SERVICES / STANDALONE_SERVICES via getServices)
 * when the DB is empty or the API is unreachable.
 */
export async function getServiceCatalog(locale: Locale = 'it'): Promise<ServiceCatalog> {
  const res = await fetchCms<{ services: ServiceRow[] }>(
    `/api/public/cms/services?locale=${locale}`,
  );
  if (res && Array.isArray(res.services) && res.services.length > 0) {
    const all: Service[] = res.services.map((r) => ({
      slug: r.slug,
      title: r.title,
      lead: r.lead,
      deliverables: Array.isArray(r.deliverables) ? r.deliverables as string[] : [],
      icon: r.icon,
    }));
    return {
      all,
      matrix: all.filter((_, i) => res.services[i].category === 'matrix'),
      standalone: all.filter((_, i) => res.services[i].category === 'standalone'),
    };
  }
  return {
    all: getServices(locale),
    matrix: getMatrixServices(locale),
    standalone: getStandaloneServices(locale),
  };
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

interface CuriositaRow {
  id: string;
  label: string;
  body: string;
  sort_order: number | null;
}

/**
 * Returns the curiosita list (fun facts mostrate in /perche-scegliere-me)
 * per il locale. Fallback a data/curiosita.ts quando il DB è vuoto o
 * l'API è irraggiungibile. Mappa `body` (colonna DB) → `text` (interfaccia
 * file) per non rompere i consumer esistenti.
 */
export async function getCuriosita(locale: Locale = 'it'): Promise<Curiosita[]> {
  const res = await fetchCms<{ curiosita: CuriositaRow[] }>(
    `/api/public/cms/curiosita?locale=${locale}`,
  );
  if (res && Array.isArray(res.curiosita) && res.curiosita.length > 0) {
    return res.curiosita.map((r) => ({ label: r.label, text: r.body }));
  }
  return getCuriositaFromFile(locale);
}

interface ApproachRow {
  id: string;
  title: string;
  description: string;
  phosphor_icon: string;
  sort_order: number | null;
}

/**
 * Returns the approach pillars per il locale. Fallback a data/approach.ts.
 * Mappa `phosphor_icon` (snake_case DB) → `phosphorIcon` (camelCase interfaccia).
 */
export async function getApproach(locale: Locale = 'it'): Promise<ApproachClaim[]> {
  const res = await fetchCms<{ approach: ApproachRow[] }>(
    `/api/public/cms/approach?locale=${locale}`,
  );
  if (res && Array.isArray(res.approach) && res.approach.length > 0) {
    return res.approach.map((r) => ({
      title: r.title,
      description: r.description,
      phosphorIcon: r.phosphor_icon,
    }));
  }
  return getApproachFromFile(locale);
}

interface ClientRow {
  id: string;
  name: string;
  url: string;
  industry: string | null;
  logo_url: string | null;
  sort_order: number | null;
}

/**
 * Returns the client roster (used by TrustBento + case-study back-links).
 * Single-locale: i nomi cliente sono universali. Fallback a data/clients.ts.
 * Mappa `logo_url` (snake_case DB) → `logo` (interfaccia file).
 */
export async function getClients(): Promise<Client[]> {
  const res = await fetchCms<{ clients: ClientRow[] }>('/api/public/cms/clients');
  if (res && Array.isArray(res.clients) && res.clients.length > 0) {
    return res.clients.map((r) => ({
      name: r.name,
      url: r.url,
      industry: r.industry ?? undefined,
      logo: r.logo_url ?? undefined,
    }));
  }
  return CLIENTS;
}
