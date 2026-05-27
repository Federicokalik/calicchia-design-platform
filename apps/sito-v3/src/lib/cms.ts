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
