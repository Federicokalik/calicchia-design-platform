/**
 * Email marketing — embeddable form management (admin).
 * Mounted under /api/email-marketing/forms (admin-only via app.ts).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from '../db';
import { firstZodIssue } from '@calicchia/shared';

export const formsRouter = new Hono();

const fieldSchema = z.object({
  name: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  type: z.enum(['text', 'email', 'tel']).default('text'),
  required: z.boolean().optional(),
});

const formSchema = z.object({
  name: z.string().trim().min(1).max(160),
  fields: z.array(fieldSchema).min(1).max(12).optional(),
  success_message: z.string().trim().max(500).optional(),
  submit_label: z.string().trim().max(60).optional(),
  target_list_id: z.string().uuid().optional().nullable(),
  default_legal_basis: z.enum(['consent', 'legitimate_interest_b2b', 'soft_optin']).optional(),
  audience_type: z.enum(['warm', 'cold']).optional(),
  double_optin: z.boolean().optional(),
  allowed_origins: z.array(z.string().trim().max(255)).max(20).optional(),
  captcha_site_key_id: z.string().trim().max(80).optional().nullable(),
  tags: z.array(z.string().trim().max(60)).max(20).optional(),
  style: z.object({ accent: z.string().optional(), radius: z.string().optional() }).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const DEFAULT_FIELDS = [
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'first_name', label: 'Nome', type: 'text' },
];

function slugify(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'form';
}

formsRouter.get('/', async (c) => {
  const forms = await sql`
    SELECT f.*, (SELECT count(*)::int FROM mkt_form_submissions s WHERE s.form_id = f.id) AS submission_count
    FROM mkt_forms f ORDER BY f.created_at DESC`;
  return c.json({ forms });
});

formsRouter.post('/', async (c) => {
  const parsed = formSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const d = parsed.data;
  let slug = slugify(d.name);
  // Ensure unique slug.
  const exists = await sql`SELECT 1 FROM mkt_forms WHERE slug = ${slug}`;
  if (exists.length) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  const [form] = await sql`
    INSERT INTO mkt_forms
      (name, slug, fields, success_message, submit_label, target_list_id, default_legal_basis,
       audience_type, double_optin, allowed_origins, captcha_site_key_id, tags, style)
    VALUES
      (${d.name}, ${slug}, ${sql.json((d.fields ?? DEFAULT_FIELDS) as never)},
       ${d.success_message ?? 'Iscrizione ricevuta. Controlla la tua email.'},
       ${d.submit_label ?? 'Iscriviti'}, ${d.target_list_id ?? null},
       ${d.default_legal_basis ?? 'consent'}, ${d.audience_type ?? 'warm'},
       ${d.double_optin ?? true}, ${d.allowed_origins ?? []}, ${d.captcha_site_key_id ?? null},
       ${d.tags ?? []}, ${sql.json((d.style ?? {}) as never)})
    RETURNING *`;
  return c.json({ form }, 201);
});

formsRouter.get('/:id', async (c) => {
  const [form] = await sql`SELECT * FROM mkt_forms WHERE id = ${c.req.param('id')}`;
  if (!form) return c.json({ error: 'Form non trovato' }, 404);
  const submissions = await sql`
    SELECT id, data, created_at FROM mkt_form_submissions WHERE form_id = ${form.id}
    ORDER BY created_at DESC LIMIT 100`;
  return c.json({ form, submissions });
});

formsRouter.patch('/:id', async (c) => {
  const parsed = formSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const [existing] = await sql`SELECT * FROM mkt_forms WHERE id = ${c.req.param('id')}`;
  if (!existing) return c.json({ error: 'Form non trovato' }, 404);
  const d = parsed.data;
  const [form] = await sql`
    UPDATE mkt_forms SET
      name = ${d.name ?? existing.name},
      fields = ${d.fields ? sql.json(d.fields as never) : existing.fields},
      success_message = ${d.success_message ?? existing.success_message},
      submit_label = ${d.submit_label ?? existing.submit_label},
      target_list_id = ${d.target_list_id ?? existing.target_list_id},
      default_legal_basis = ${d.default_legal_basis ?? existing.default_legal_basis},
      audience_type = ${d.audience_type ?? existing.audience_type},
      double_optin = ${d.double_optin ?? existing.double_optin},
      allowed_origins = ${d.allowed_origins ?? existing.allowed_origins},
      captcha_site_key_id = ${d.captcha_site_key_id ?? existing.captcha_site_key_id},
      tags = ${d.tags ?? existing.tags},
      style = ${d.style ? sql.json(d.style as never) : existing.style},
      status = ${d.status ?? existing.status},
      updated_at = now()
    WHERE id = ${existing.id} RETURNING *`;
  return c.json({ form });
});

formsRouter.delete('/:id', async (c) => {
  await sql`DELETE FROM mkt_forms WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
