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

// ── GET /api/public/cms/faqs?locale=it|en&section=general|perche ─
// Default section='general' (FAQ pubbliche di /faq). Sezione 'perche' è
// usata da /perche-scegliere-me. Future: 'service:<slug>' per FAQ per-servizio.
function parseSection(raw: string | undefined): string {
  if (!raw) return 'general';
  if (raw === 'general' || raw === 'perche') return raw;
  if (/^service:[a-z0-9-]+$/.test(raw)) return raw;
  return 'general';
}

cmsPublic.get('/faqs', async (c) => {
  const locale = parseLocale(c.req.query('locale'));
  const section = parseSection(c.req.query('section'));
  let rows: Array<{ id: string; question: string; answer: string; sort_order: number | null }> = [];
  try {
    rows = await sql`
      SELECT id, question, answer, sort_order
      FROM site_faqs
      WHERE is_published = true AND locale = ${locale} AND section = ${section}
      ORDER BY sort_order NULLS LAST, id ASC
      LIMIT 200
    ` as typeof rows;
  } catch (err) {
    log.warn({ err, locale, section }, 'faqs read failed');
  }
  return c.json({ locale, section, faqs: rows }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
  });
});

// ── GET /api/public/cms/services?locale=it|en ────────────────────
cmsPublic.get('/services', async (c) => {
  const locale = parseLocale(c.req.query('locale'));
  let rows: Array<{
    id: string; slug: string; title: string; lead: string;
    deliverables: unknown; icon: string; category: string;
    sort_order: number | null;
  }> = [];
  try {
    rows = await sql`
      SELECT id, slug, title, lead, deliverables, icon, category, sort_order
      FROM site_services
      WHERE is_published = true AND locale = ${locale}
      ORDER BY category ASC, sort_order NULLS LAST, title ASC
      LIMIT 100
    ` as typeof rows;
  } catch (err) {
    log.warn({ err, locale }, 'services read failed');
  }
  return c.json({ locale, services: rows }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
  });
});

// ── GET /api/public/cms/seo-cities ───────────────────────────────
// Single-locale: city names don't translate, only surrounding copy does.
cmsPublic.get('/seo-cities', async (c) => {
  let rows: Array<{
    id: string; slug: string; nome: string; regione: string;
    tipo: string; tier: number; sort_order: number | null;
  }> = [];
  try {
    rows = await sql`
      SELECT id, slug, nome, regione, tipo, tier, sort_order
      FROM site_seo_cities
      WHERE is_published = true
      ORDER BY regione ASC, nome ASC
      LIMIT 1000
    ` as typeof rows;
  } catch (err) {
    log.warn({ err }, 'seo-cities read failed');
  }
  return c.json({ cities: rows }, 200, {
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

// ── GET /api/public/cms/curiosita?locale=it|en ───────────────────
cmsPublic.get('/curiosita', async (c) => {
  const locale = parseLocale(c.req.query('locale'));
  let rows: Array<{ id: string; label: string; body: string; sort_order: number | null }> = [];
  try {
    rows = await sql`
      SELECT id, label, body, sort_order
      FROM site_curiosita
      WHERE is_published = true AND locale = ${locale}
      ORDER BY sort_order NULLS LAST, id ASC
      LIMIT 100
    ` as typeof rows;
  } catch (err) {
    log.warn({ err, locale }, 'curiosita read failed');
  }
  return c.json({ locale, curiosita: rows }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
  });
});

// ── GET /api/public/cms/approach?locale=it|en ────────────────────
cmsPublic.get('/approach', async (c) => {
  const locale = parseLocale(c.req.query('locale'));
  let rows: Array<{ id: string; title: string; description: string; phosphor_icon: string; sort_order: number | null }> = [];
  try {
    rows = await sql`
      SELECT id, title, description, phosphor_icon, sort_order
      FROM site_approach
      WHERE is_published = true AND locale = ${locale}
      ORDER BY sort_order NULLS LAST, id ASC
      LIMIT 50
    ` as typeof rows;
  } catch (err) {
    log.warn({ err, locale }, 'approach read failed');
  }
  return c.json({ locale, approach: rows }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
  });
});

// ── GET /api/public/cms/clients ──────────────────────────────────
// Single-locale: i nomi cliente sono universali.
cmsPublic.get('/clients', async (c) => {
  let rows: Array<{ id: string; name: string; url: string; industry: string | null; logo_url: string | null; sort_order: number | null }> = [];
  try {
    rows = await sql`
      SELECT id, name, url, industry, logo_url, sort_order
      FROM site_clients
      WHERE is_published = true
      ORDER BY sort_order NULLS LAST, name ASC
      LIMIT 200
    ` as typeof rows;
  } catch (err) {
    log.warn({ err }, 'clients read failed');
  }
  return c.json({ clients: rows }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
  });
});
