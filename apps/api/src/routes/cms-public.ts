import { Hono } from 'hono';
import { sql } from '../db';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'cms-public' });

/**
 * Audit C-013/C-014 — public CMS endpoints.
 *
 * Returns DB-backed FAQ / team / glossario / etc rows for the sito-v3
 * client. The sito helpers (`apps/sito-v3/src/lib/cms.ts`) fall back to
 * data/*.ts when the table is empty so a fresh install renders.
 *
 * NEVER throws — public surface degrades gracefully. Short Cache-Control
 * matching /api/public/site-config so admin edits propagate in <5min.
 */
export const cmsPublic = new Hono();

function parseLocale(raw: string | undefined): 'it' | 'en' {
  return raw === 'en' ? 'en' : 'it';
}

// ── GET /api/public/cms/faqs?locale=it|en ────────────────────────
cmsPublic.get('/faqs', async (c) => {
  const locale = parseLocale(c.req.query('locale'));
  let rows: Array<{ id: string; question: string; answer: string; sort_order: number | null }> = [];
  try {
    rows = await sql`
      SELECT id, question, answer, sort_order
      FROM site_faqs
      WHERE is_published = true AND locale = ${locale}
      ORDER BY sort_order NULLS LAST, id ASC
      LIMIT 200
    ` as typeof rows;
  } catch (err) {
    log.warn({ err, locale }, 'faqs read failed');
  }
  return c.json({ locale, faqs: rows }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
  });
});

// ── GET /api/public/cms/glossario?locale=it|en ───────────────────
cmsPublic.get('/glossario', async (c) => {
  const locale = parseLocale(c.req.query('locale'));
  let rows: Array<{
    id: string; slug: string; term: string; full_name: string | null;
    letter: string; what_it_is: string; why_you_care: string;
    what_to_demand: string; sort_order: number | null;
  }> = [];
  try {
    rows = await sql`
      SELECT id, slug, term, full_name, letter, what_it_is, why_you_care,
             what_to_demand, sort_order
      FROM site_glossario
      WHERE is_published = true AND locale = ${locale}
      ORDER BY letter ASC, sort_order NULLS LAST, term ASC
      LIMIT 1000
    ` as typeof rows;
  } catch (err) {
    log.warn({ err, locale }, 'glossario read failed');
  }
  return c.json({ locale, entries: rows }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
  });
});

// ── GET /api/public/cms/team?locale=it|en ────────────────────────
cmsPublic.get('/team', async (c) => {
  const locale = parseLocale(c.req.query('locale'));
  let rows: Array<{
    id: string; name: string; role: string; bio: string | null;
    avatar_url: string | null; email: string | null; socials: unknown;
    sort_order: number | null;
  }> = [];
  try {
    rows = await sql`
      SELECT id, name, role, bio, avatar_url, email, socials, sort_order
      FROM site_team
      WHERE is_published = true AND locale = ${locale}
      ORDER BY sort_order NULLS LAST, id ASC
      LIMIT 100
    ` as typeof rows;
  } catch (err) {
    log.warn({ err, locale }, 'team read failed');
  }
  return c.json({ locale, team: rows }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
  });
});
