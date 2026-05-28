import { Hono } from 'hono';
import { z } from 'zod';
import { sql, sqlv } from '../db';
import { logger } from '../lib/logger';
import { revalidateSito } from '../lib/sito-revalidate';

const log = logger.child({ scope: 'cms-admin' });

/**
 * Audit C-013/C-014 — admin CRUD for the public CMS tables.
 *
 * Auth is delegated to the global protected-paths middleware in app.ts
 * (the /api/cms prefix is in the allowlist). All routes accept and return
 * the raw row shape so the admin SPA can render generic table UIs without
 * special-casing each entity.
 */
export const cmsAdmin = new Hono();

// On any successful mutation (services, faqs, cities, glossario, team),
// trigger sito-v3 ISR rivalidate so sitemap.xml, llms.txt and the public
// CMS-driven pages reflect the change within seconds.
cmsAdmin.use('*', async (c, next) => {
  await next();
  if (c.req.method !== 'GET' && c.res.status < 400) {
    void revalidateSito();
  }
});

const localeSchema = z.enum(['it', 'en']);

// ── FAQS ─────────────────────────────────────────────────────────
// `section` distingue le FAQ generiche di /faq (default 'general') dalle
// FAQ section-specific di /perche-scegliere-me ('perche'). Estendibile a
// 'service:<slug>' per FAQ per-servizio senza moltiplicare le tabelle.
const faqSectionSchema = z.string().trim().regex(
  /^(general|perche|service:[a-z0-9-]+)$/,
  'Sezione non valida',
);

const faqUpsertSchema = z.object({
  locale: localeSchema.default('it'),
  section: faqSectionSchema.default('general'),
  question: z.string().trim().min(1, 'Domanda richiesta'),
  answer: z.string().trim().min(1, 'Risposta richiesta'),
  sort_order: z.number().int().nullable().optional(),
  is_published: z.boolean().default(true),
});

cmsAdmin.get('/faqs', async (c) => {
  const locale = c.req.query('locale');
  const sectionRaw = c.req.query('section');
  const section = sectionRaw && faqSectionSchema.safeParse(sectionRaw).success ? sectionRaw : null;
  const localeOk = locale === 'it' || locale === 'en';
  let rows;
  if (localeOk && section) {
    rows = await sql`SELECT * FROM site_faqs WHERE locale = ${locale} AND section = ${section} ORDER BY sort_order NULLS LAST, created_at DESC LIMIT 500`;
  } else if (localeOk) {
    rows = await sql`SELECT * FROM site_faqs WHERE locale = ${locale} ORDER BY section ASC, sort_order NULLS LAST, created_at DESC LIMIT 500`;
  } else if (section) {
    rows = await sql`SELECT * FROM site_faqs WHERE section = ${section} ORDER BY locale ASC, sort_order NULLS LAST, created_at DESC LIMIT 500`;
  } else {
    rows = await sql`SELECT * FROM site_faqs ORDER BY locale ASC, section ASC, sort_order NULLS LAST, created_at DESC LIMIT 500`;
  }
  return c.json({ rows });
});

cmsAdmin.post('/faqs', async (c) => {
  const body = await c.req.json();
  const parsed = faqUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  const v = parsed.data;
  const [row] = await sql`
    INSERT INTO site_faqs (locale, section, question, answer, sort_order, is_published, source)
    VALUES (${v.locale}, ${v.section}, ${v.question}, ${v.answer}, ${v.sort_order ?? null}, ${v.is_published}, 'admin')
    RETURNING *
  `;
  return c.json({ row }, 201);
});

cmsAdmin.put('/faqs/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = faqUpsertSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);

  // Whitelist update to avoid arbitrary column writes (audit B-023 pattern).
  const patch: Record<string, unknown> = {};
  for (const k of ['locale', 'section', 'question', 'answer', 'sort_order', 'is_published'] as const) {
    if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Nessuna modifica' }, 400);

  const [row] = await sql`UPDATE site_faqs SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ row });
});

cmsAdmin.delete('/faqs/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`DELETE FROM site_faqs WHERE id = ${id} RETURNING id`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// ── SERVICES (catalog) ───────────────────────────────────────────
const serviceUpsertSchema = z.object({
  locale: localeSchema.default('it'),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/, 'Slug solo a-z, 0-9, trattini').min(1),
  title: z.string().trim().min(1, 'Titolo richiesto'),
  lead: z.string().trim().min(1, 'Lead richiesto'),
  deliverables: z.array(z.string().min(1).max(200)).max(20).default([]),
  icon: z.string().trim().min(1).max(60).default('globe'),
  category: z.enum(['matrix', 'standalone']),
  sort_order: z.number().int().nullable().optional(),
  is_published: z.boolean().default(true),
});

cmsAdmin.get('/services', async (c) => {
  const locale = c.req.query('locale');
  const category = c.req.query('category');
  let rows;
  if ((locale === 'it' || locale === 'en') && (category === 'matrix' || category === 'standalone')) {
    rows = await sql`SELECT * FROM site_services WHERE locale = ${locale} AND category = ${category} ORDER BY sort_order NULLS LAST, title ASC LIMIT 200`;
  } else if (locale === 'it' || locale === 'en') {
    rows = await sql`SELECT * FROM site_services WHERE locale = ${locale} ORDER BY category, sort_order NULLS LAST, title ASC LIMIT 200`;
  } else if (category === 'matrix' || category === 'standalone') {
    rows = await sql`SELECT * FROM site_services WHERE category = ${category} ORDER BY locale, sort_order NULLS LAST, title ASC LIMIT 200`;
  } else {
    rows = await sql`SELECT * FROM site_services ORDER BY locale, category, sort_order NULLS LAST, title ASC LIMIT 200`;
  }
  return c.json({ rows });
});

cmsAdmin.post('/services', async (c) => {
  const body = await c.req.json();
  const parsed = serviceUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  const v = parsed.data;
  try {
    const [row] = await sql`
      INSERT INTO site_services (locale, slug, title, lead, deliverables, icon, category, sort_order, is_published, source)
      VALUES (
        ${v.locale}, ${v.slug}, ${v.title}, ${v.lead},
        ${sqlv(v.deliverables as unknown as Record<string, unknown>)},
        ${v.icon}, ${v.category}, ${v.sort_order ?? null}, ${v.is_published}, 'admin'
      )
      RETURNING *
    `;
    return c.json({ row }, 201);
  } catch (err) {
    const msg = err instanceof Error && /unique/i.test(err.message)
      ? 'Slug già esistente per questa lingua'
      : 'Errore nel salvataggio';
    return c.json({ error: msg }, 400);
  }
});

cmsAdmin.put('/services/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = serviceUpsertSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);

  const patch: Record<string, unknown> = {};
  for (const k of ['locale', 'slug', 'title', 'lead', 'icon', 'category', 'sort_order', 'is_published'] as const) {
    if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
  }
  if (parsed.data.deliverables !== undefined) {
    patch.deliverables = sqlv(parsed.data.deliverables as unknown as Record<string, unknown>);
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Nessuna modifica' }, 400);

  try {
    const [row] = await sql`UPDATE site_services SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ row });
  } catch (err) {
    const msg = err instanceof Error && /unique/i.test(err.message)
      ? 'Slug già esistente per questa lingua'
      : 'Errore nel salvataggio';
    return c.json({ error: msg }, 400);
  }
});

cmsAdmin.delete('/services/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`DELETE FROM site_services WHERE id = ${id} RETURNING id`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// ── SEO CITIES ───────────────────────────────────────────────────
const seoCityUpsertSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9-]+$/, 'Slug solo a-z, 0-9, trattini').min(1),
  nome: z.string().trim().min(1, 'Nome richiesto'),
  regione: z.string().trim().min(1, 'Regione richiesta'),
  tipo: z.enum(['capoluogo', 'ciociaria']),
  tier: z.number().int().min(1).max(3),
  sort_order: z.number().int().nullable().optional(),
  is_published: z.boolean().default(true),
});

cmsAdmin.get('/seo-cities', async (c) => {
  const regione = c.req.query('regione');
  const tierRaw = c.req.query('tier');
  const tipoRaw = c.req.query('tipo');
  // Single-filter fast paths — postgres.js doesn't compose chained sql``
  // fragments naturally, so we just branch by which filter combination
  // the admin sent. The page never combines >1 filter so this is fine.
  const tipo = tipoRaw === 'capoluogo' || tipoRaw === 'ciociaria' ? tipoRaw : null;
  const tier = tierRaw && /^[123]$/.test(tierRaw) ? Number(tierRaw) : null;
  let rows;
  if (regione && tipo && tier !== null) {
    rows = await sql`SELECT * FROM site_seo_cities WHERE regione = ${regione} AND tipo = ${tipo} AND tier = ${tier} ORDER BY regione ASC, nome ASC LIMIT 1000`;
  } else if (regione) {
    rows = await sql`SELECT * FROM site_seo_cities WHERE regione = ${regione} ORDER BY nome ASC LIMIT 1000`;
  } else if (tipo) {
    rows = await sql`SELECT * FROM site_seo_cities WHERE tipo = ${tipo} ORDER BY regione ASC, nome ASC LIMIT 1000`;
  } else if (tier !== null) {
    rows = await sql`SELECT * FROM site_seo_cities WHERE tier = ${tier} ORDER BY regione ASC, nome ASC LIMIT 1000`;
  } else {
    rows = await sql`SELECT * FROM site_seo_cities ORDER BY regione ASC, nome ASC LIMIT 1000`;
  }
  return c.json({ rows });
});

cmsAdmin.post('/seo-cities', async (c) => {
  const body = await c.req.json();
  const parsed = seoCityUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  const v = parsed.data;
  try {
    const [row] = await sql`
      INSERT INTO site_seo_cities (slug, nome, regione, tipo, tier, sort_order, is_published, source)
      VALUES (${v.slug}, ${v.nome}, ${v.regione}, ${v.tipo}, ${v.tier}, ${v.sort_order ?? null}, ${v.is_published}, 'admin')
      RETURNING *
    `;
    return c.json({ row }, 201);
  } catch (err) {
    const msg = err instanceof Error && /unique/i.test(err.message)
      ? 'Slug già esistente'
      : 'Errore nel salvataggio';
    return c.json({ error: msg }, 400);
  }
});

cmsAdmin.put('/seo-cities/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = seoCityUpsertSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);

  const patch: Record<string, unknown> = {};
  for (const k of ['slug', 'nome', 'regione', 'tipo', 'tier', 'sort_order', 'is_published'] as const) {
    if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Nessuna modifica' }, 400);

  try {
    const [row] = await sql`UPDATE site_seo_cities SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ row });
  } catch (err) {
    const msg = err instanceof Error && /unique/i.test(err.message)
      ? 'Slug già esistente'
      : 'Errore nel salvataggio';
    return c.json({ error: msg }, 400);
  }
});

cmsAdmin.delete('/seo-cities/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`DELETE FROM site_seo_cities WHERE id = ${id} RETURNING id`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// ── GLOSSARIO ────────────────────────────────────────────────────
const glossarioUpsertSchema = z.object({
  locale: localeSchema.default('it'),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/, 'Slug deve contenere solo lettere minuscole, numeri e trattini').min(1),
  term: z.string().trim().min(1, 'Termine richiesto'),
  full_name: z.string().trim().nullable().optional().or(z.literal('').transform(() => null)),
  letter: z.string().trim().regex(/^[A-Z0-9]$/, 'Lettera deve essere una sola maiuscola A-Z o cifra').length(1),
  what_it_is: z.string().trim().min(1, 'Definizione richiesta'),
  why_you_care: z.string().trim().min(1, 'Motivo richiesto'),
  what_to_demand: z.string().trim().min(1, 'Pretesa richiesta'),
  sort_order: z.number().int().nullable().optional(),
  is_published: z.boolean().default(true),
});

cmsAdmin.get('/glossario', async (c) => {
  const locale = c.req.query('locale');
  const rows = await sql`
    SELECT * FROM site_glossario
    ${locale === 'it' || locale === 'en' ? sql`WHERE locale = ${locale}` : sql``}
    ORDER BY locale ASC, letter ASC, sort_order NULLS LAST, term ASC
    LIMIT 1000
  `;
  return c.json({ rows });
});

cmsAdmin.post('/glossario', async (c) => {
  const body = await c.req.json();
  const parsed = glossarioUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  const v = parsed.data;
  try {
    const [row] = await sql`
      INSERT INTO site_glossario (
        locale, slug, term, full_name, letter, what_it_is, why_you_care,
        what_to_demand, sort_order, is_published, source
      )
      VALUES (
        ${v.locale}, ${v.slug}, ${v.term}, ${v.full_name ?? null},
        ${v.letter.toUpperCase()}, ${v.what_it_is}, ${v.why_you_care},
        ${v.what_to_demand}, ${v.sort_order ?? null}, ${v.is_published}, 'admin'
      )
      RETURNING *
    `;
    return c.json({ row }, 201);
  } catch (err) {
    const msg = err instanceof Error && /unique/i.test(err.message)
      ? 'Slug già esistente per questa lingua'
      : 'Errore nel salvataggio';
    return c.json({ error: msg }, 400);
  }
});

cmsAdmin.put('/glossario/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = glossarioUpsertSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);

  const patch: Record<string, unknown> = {};
  for (const k of ['locale', 'slug', 'term', 'full_name', 'letter', 'what_it_is', 'why_you_care', 'what_to_demand', 'sort_order', 'is_published'] as const) {
    if (parsed.data[k] !== undefined) patch[k] = k === 'letter' ? String(parsed.data[k]).toUpperCase() : parsed.data[k];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Nessuna modifica' }, 400);

  try {
    const [row] = await sql`UPDATE site_glossario SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ row });
  } catch (err) {
    const msg = err instanceof Error && /unique/i.test(err.message)
      ? 'Slug già esistente per questa lingua'
      : 'Errore nel salvataggio';
    return c.json({ error: msg }, 400);
  }
});

cmsAdmin.delete('/glossario/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`DELETE FROM site_glossario WHERE id = ${id} RETURNING id`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// ── TEAM ─────────────────────────────────────────────────────────
const teamSocialSchema = z.object({
  label: z.string().min(1).max(60),
  url: z.string().url(),
  icon: z.string().max(60).optional(),
});

const teamUpsertSchema = z.object({
  locale: localeSchema.default('it'),
  name: z.string().trim().min(1, 'Nome richiesto'),
  role: z.string().trim().min(1, 'Ruolo richiesto'),
  bio: z.string().nullable().optional(),
  avatar_url: z.string().url().nullable().optional().or(z.literal('').transform(() => null)),
  email: z.string().email().nullable().optional().or(z.literal('').transform(() => null)),
  socials: z.array(teamSocialSchema).default([]),
  sort_order: z.number().int().nullable().optional(),
  is_published: z.boolean().default(true),
});

cmsAdmin.get('/team', async (c) => {
  const locale = c.req.query('locale');
  const rows = await sql`
    SELECT * FROM site_team
    ${locale === 'it' || locale === 'en' ? sql`WHERE locale = ${locale}` : sql``}
    ORDER BY locale ASC, sort_order NULLS LAST, created_at DESC
    LIMIT 500
  `;
  return c.json({ rows });
});

cmsAdmin.post('/team', async (c) => {
  const body = await c.req.json();
  const parsed = teamUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  const v = parsed.data;
  try {
    const [row] = await sql`
      INSERT INTO site_team (locale, name, role, bio, avatar_url, email, socials, sort_order, is_published, source)
      VALUES (
        ${v.locale}, ${v.name}, ${v.role}, ${v.bio ?? null}, ${v.avatar_url ?? null},
        ${v.email ?? null}, ${sqlv(v.socials as unknown as Record<string, unknown>)},
        ${v.sort_order ?? null}, ${v.is_published}, 'admin'
      )
      RETURNING *
    `;
    return c.json({ row }, 201);
  } catch (err) {
    log.error({ err }, 'team create failed');
    return c.json({ error: 'Errore nel salvataggio' }, 500);
  }
});

cmsAdmin.put('/team/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = teamUpsertSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);

  const patch: Record<string, unknown> = {};
  for (const k of ['locale', 'name', 'role', 'bio', 'avatar_url', 'email', 'sort_order', 'is_published'] as const) {
    if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
  }
  if (parsed.data.socials !== undefined) {
    patch.socials = sqlv(parsed.data.socials as unknown as Record<string, unknown>);
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Nessuna modifica' }, 400);

  const [row] = await sql`UPDATE site_team SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ row });
});

cmsAdmin.delete('/team/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`DELETE FROM site_team WHERE id = ${id} RETURNING id`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// ── CURIOSITA (fun facts /perche-scegliere-me) ───────────────────
const curiositaUpsertSchema = z.object({
  locale: localeSchema.default('it'),
  label: z.string().trim().min(1, 'Etichetta richiesta'),
  body: z.string().trim().min(1, 'Testo richiesto'),
  sort_order: z.number().int().nullable().optional(),
  is_published: z.boolean().default(true),
});

cmsAdmin.get('/curiosita', async (c) => {
  const locale = c.req.query('locale');
  const rows = await sql`
    SELECT * FROM site_curiosita
    ${locale === 'it' || locale === 'en' ? sql`WHERE locale = ${locale}` : sql``}
    ORDER BY locale ASC, sort_order NULLS LAST, created_at DESC
    LIMIT 200
  `;
  return c.json({ rows });
});

cmsAdmin.post('/curiosita', async (c) => {
  const body = await c.req.json();
  const parsed = curiositaUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  const v = parsed.data;
  const [row] = await sql`
    INSERT INTO site_curiosita (locale, label, body, sort_order, is_published, source)
    VALUES (${v.locale}, ${v.label}, ${v.body}, ${v.sort_order ?? null}, ${v.is_published}, 'admin')
    RETURNING *
  `;
  return c.json({ row }, 201);
});

cmsAdmin.put('/curiosita/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = curiositaUpsertSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);

  const patch: Record<string, unknown> = {};
  for (const k of ['locale', 'label', 'body', 'sort_order', 'is_published'] as const) {
    if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Nessuna modifica' }, 400);

  const [row] = await sql`UPDATE site_curiosita SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ row });
});

cmsAdmin.delete('/curiosita/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`DELETE FROM site_curiosita WHERE id = ${id} RETURNING id`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// ── APPROACH (5 pillar /perche-scegliere-me) ─────────────────────
const approachUpsertSchema = z.object({
  locale: localeSchema.default('it'),
  title: z.string().trim().min(1, 'Titolo richiesto'),
  description: z.string().trim().min(1, 'Descrizione richiesta'),
  phosphor_icon: z.string().trim().regex(/^ph-[a-z0-9-]+$/, 'Icona Phosphor non valida (es. ph-rocket-launch)').default('ph-circle'),
  sort_order: z.number().int().nullable().optional(),
  is_published: z.boolean().default(true),
});

cmsAdmin.get('/approach', async (c) => {
  const locale = c.req.query('locale');
  const rows = await sql`
    SELECT * FROM site_approach
    ${locale === 'it' || locale === 'en' ? sql`WHERE locale = ${locale}` : sql``}
    ORDER BY locale ASC, sort_order NULLS LAST, created_at DESC
    LIMIT 200
  `;
  return c.json({ rows });
});

cmsAdmin.post('/approach', async (c) => {
  const body = await c.req.json();
  const parsed = approachUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  const v = parsed.data;
  const [row] = await sql`
    INSERT INTO site_approach (locale, title, description, phosphor_icon, sort_order, is_published, source)
    VALUES (${v.locale}, ${v.title}, ${v.description}, ${v.phosphor_icon}, ${v.sort_order ?? null}, ${v.is_published}, 'admin')
    RETURNING *
  `;
  return c.json({ row }, 201);
});

cmsAdmin.put('/approach/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = approachUpsertSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);

  const patch: Record<string, unknown> = {};
  for (const k of ['locale', 'title', 'description', 'phosphor_icon', 'sort_order', 'is_published'] as const) {
    if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Nessuna modifica' }, 400);

  const [row] = await sql`UPDATE site_approach SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ row });
});

cmsAdmin.delete('/approach/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`DELETE FROM site_approach WHERE id = ${id} RETURNING id`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// ── CLIENTS (logo TrustBento + case-study backlinks) ─────────────
// Single-locale: i nomi cliente sono universali.
const clientUpsertSchema = z.object({
  name: z.string().trim().min(1, 'Nome cliente richiesto'),
  url: z.string().trim().default('#').refine(
    (v) => v === '#' || /^https?:\/\//.test(v),
    'URL deve iniziare con http:// o https://, oppure essere "#"',
  ),
  industry: z.string().trim().nullable().optional().or(z.literal('').transform(() => null)),
  logo_url: z.string().trim().nullable().optional().or(z.literal('').transform(() => null)),
  sort_order: z.number().int().nullable().optional(),
  is_published: z.boolean().default(true),
});

cmsAdmin.get('/clients', async (c) => {
  const rows = await sql`
    SELECT * FROM site_clients
    ORDER BY sort_order NULLS LAST, name ASC
    LIMIT 200
  `;
  return c.json({ rows });
});

cmsAdmin.post('/clients', async (c) => {
  const body = await c.req.json();
  const parsed = clientUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  const v = parsed.data;
  const [row] = await sql`
    INSERT INTO site_clients (name, url, industry, logo_url, sort_order, is_published, source)
    VALUES (${v.name}, ${v.url}, ${v.industry ?? null}, ${v.logo_url ?? null}, ${v.sort_order ?? null}, ${v.is_published}, 'admin')
    RETURNING *
  `;
  return c.json({ row }, 201);
});

cmsAdmin.put('/clients/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = clientUpsertSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);

  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'url', 'industry', 'logo_url', 'sort_order', 'is_published'] as const) {
    if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Nessuna modifica' }, 400);

  const [row] = await sql`UPDATE site_clients SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ row });
});

cmsAdmin.delete('/clients/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`DELETE FROM site_clients WHERE id = ${id} RETURNING id`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
