import { Hono } from 'hono';
import { z } from 'zod';
import { sql, sqlv } from '../db';
import { logger } from '../lib/logger';

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

const localeSchema = z.enum(['it', 'en']);

// ── FAQS ─────────────────────────────────────────────────────────
const faqUpsertSchema = z.object({
  locale: localeSchema.default('it'),
  question: z.string().trim().min(1, 'Domanda richiesta'),
  answer: z.string().trim().min(1, 'Risposta richiesta'),
  sort_order: z.number().int().nullable().optional(),
  is_published: z.boolean().default(true),
});

cmsAdmin.get('/faqs', async (c) => {
  const locale = c.req.query('locale');
  const rows = await sql`
    SELECT * FROM site_faqs
    ${locale === 'it' || locale === 'en' ? sql`WHERE locale = ${locale}` : sql``}
    ORDER BY locale ASC, sort_order NULLS LAST, created_at DESC
    LIMIT 500
  `;
  return c.json({ rows });
});

cmsAdmin.post('/faqs', async (c) => {
  const body = await c.req.json();
  const parsed = faqUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  const v = parsed.data;
  const [row] = await sql`
    INSERT INTO site_faqs (locale, question, answer, sort_order, is_published, source)
    VALUES (${v.locale}, ${v.question}, ${v.answer}, ${v.sort_order ?? null}, ${v.is_published}, 'admin')
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
  for (const k of ['locale', 'question', 'answer', 'sort_order', 'is_published'] as const) {
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
