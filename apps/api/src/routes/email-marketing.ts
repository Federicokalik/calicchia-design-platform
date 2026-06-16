/**
 * Email/WhatsApp marketing — admin API (auth enforced by the protected-paths
 * loop in app.ts; the whole /api/email-marketing prefix is admin-only).
 *
 * Phase 1 surface: contacts CRUD, lists, segments (saved filters + preview),
 * and CSV import (dry-run preview + commit). Campaigns/sending live in the
 * Phase 2 modules. Naming is `mkt_*` to stay clear of the agency "Campagne"
 * module (/api/marketing).
 */
import { Hono } from 'hono';
import { sql } from '../db';
import { logger } from '../lib/logger';
import {
  mktContactCreateSchema, mktContactUpdateSchema, mktListCreateSchema,
  mktSegmentCreateSchema, segmentDefinitionSchema, importCommitSchema,
  firstZodIssue, type ImportRow,
} from '@calicchia/shared';
import { buildSegmentWhere } from '../lib/marketing/segment';
import { inferMapping, mapRow, type FieldMapping } from '../lib/marketing/import';
import { campaignsRouter, sendersRouter } from './email-marketing-campaigns';
import { formsRouter } from './email-marketing-forms';
import { automationsRouter } from './email-marketing-automations';

const log = logger.child({ scope: 'email-marketing' });
export const emailMarketing = new Hono();

// Campaigns + senders (Phase 2) + forms (Phase 4) + automations (Phase 5).
emailMarketing.route('/campaigns', campaignsRouter);
emailMarketing.route('/senders', sendersRouter);
emailMarketing.route('/forms', formsRouter);
emailMarketing.route('/automations', automationsRouter);

// ── Analytics dashboard (Phase 6) ─────────────────────
emailMarketing.get('/analytics', async (c) => {
  const [contacts, campaignTotals, byChannel, recent, growth] = await Promise.all([
    sql`SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE audience_type='warm')::int AS warm,
          count(*) FILTER (WHERE audience_type='cold')::int AS cold,
          count(*) FILTER (WHERE email_consent='confirmed')::int AS confirmed,
          count(*) FILTER (WHERE email_consent='unsubscribed')::int AS unsubscribed,
          count(*) FILTER (WHERE wa_consent='opted_in')::int AS wa_opted_in
        FROM mkt_contacts WHERE status='active'`,
    sql`SELECT
          count(*) FILTER (WHERE status='sent')::int AS sent_campaigns,
          COALESCE(sum(total_sent),0)::int AS emails_sent,
          COALESCE(sum(total_opened),0)::int AS opened,
          COALESCE(sum(total_clicked),0)::int AS clicked,
          COALESCE(sum(total_unsub),0)::int AS unsub
        FROM mkt_campaigns`,
    sql`SELECT channel, count(*)::int AS n FROM mkt_campaigns GROUP BY channel`,
    sql`SELECT id, name, channel, status, total_recipients, total_sent, total_opened, total_clicked, sent_at
        FROM mkt_campaigns WHERE status IN ('sent','sending') ORDER BY COALESCE(sent_at, updated_at) DESC LIMIT 10`,
    sql`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM mkt_contacts WHERE created_at >= now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`,
  ]);
  return c.json({
    contacts: contacts[0],
    campaigns: campaignTotals[0],
    by_channel: byChannel,
    recent_campaigns: recent,
    growth_30d: growth,
  });
});

// ============================================================
// CONTACTS
// ============================================================
emailMarketing.get('/contacts', async (c) => {
  const q = c.req.query('q')?.trim();
  const audience = c.req.query('audience_type');
  const consent = c.req.query('email_consent');
  const listId = c.req.query('list_id');
  const tag = c.req.query('tag');
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);
  const offset = Math.max(parseInt(c.req.query('offset') || '0'), 0);

  const filters = [
    q ? sql`AND (mc.email ILIKE ${'%' + q + '%'} OR mc.first_name ILIKE ${'%' + q + '%'} OR mc.last_name ILIKE ${'%' + q + '%'} OR mc.company ILIKE ${'%' + q + '%'})` : sql``,
    audience ? sql`AND mc.audience_type = ${audience}` : sql``,
    consent ? sql`AND mc.email_consent = ${consent}` : sql``,
    tag ? sql`AND mc.tags @> ${[tag]}::text[]` : sql``,
    listId ? sql`AND EXISTS (SELECT 1 FROM mkt_list_members lm WHERE lm.contact_id = mc.id AND lm.list_id = ${listId})` : sql``,
  ].reduce((acc, f) => sql`${acc} ${f}`, sql``);

  const [contacts, [{ count }], stats] = await Promise.all([
    sql`SELECT mc.* FROM mkt_contacts mc WHERE mc.status = 'active' ${filters}
        ORDER BY mc.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    sql`SELECT count(*)::int AS count FROM mkt_contacts mc WHERE mc.status = 'active' ${filters}`,
    sql`SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE audience_type = 'warm')::int AS warm,
          count(*) FILTER (WHERE audience_type = 'cold')::int AS cold,
          count(*) FILTER (WHERE email_consent = 'confirmed')::int AS confirmed,
          count(*) FILTER (WHERE email_consent = 'unsubscribed')::int AS unsubscribed,
          count(*) FILTER (WHERE wa_consent = 'opted_in')::int AS wa_opted_in
        FROM mkt_contacts WHERE status = 'active'`,
  ]);

  return c.json({ contacts, total: count, stats: stats[0] });
});

emailMarketing.post('/contacts', async (c) => {
  const parsed = mktContactCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const d = parsed.data;
  try {
    const [contact] = await sql`
      INSERT INTO mkt_contacts
        (email, phone, first_name, last_name, company, role, website, industry, city, country,
         email_legal_basis, audience_type, consent_source, tags, metadata, consent_collected_at)
      VALUES
        (${d.email ?? null}, ${d.phone ?? null}, ${d.first_name ?? null}, ${d.last_name ?? null},
         ${d.company ?? null}, ${d.role ?? null}, ${d.website ?? null}, ${d.industry ?? null},
         ${d.city ?? null}, ${d.country ?? null}, ${d.email_legal_basis}, ${d.audience_type},
         ${d.consent_source ?? null}, ${d.tags ?? []}, ${sql.json((d.metadata ?? {}) as never)}, now())
      RETURNING *`;
    return c.json({ contact }, 201);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Esiste già un contatto con questa email' }, 409);
    }
    throw err;
  }
});

emailMarketing.get('/contacts/:id', async (c) => {
  const [contact] = await sql`SELECT * FROM mkt_contacts WHERE id = ${c.req.param('id')}`;
  if (!contact) return c.json({ error: 'Contatto non trovato' }, 404);
  const lists = await sql`
    SELECT l.id, l.name FROM mkt_list_members lm
    JOIN mkt_lists l ON l.id = lm.list_id WHERE lm.contact_id = ${contact.id}`;
  return c.json({ contact, lists });
});

emailMarketing.patch('/contacts/:id', async (c) => {
  const parsed = mktContactUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const d = parsed.data;
  const [existing] = await sql`SELECT * FROM mkt_contacts WHERE id = ${c.req.param('id')}`;
  if (!existing) return c.json({ error: 'Contatto non trovato' }, 404);

  const [contact] = await sql`
    UPDATE mkt_contacts SET
      email = ${d.email ?? existing.email},
      phone = ${d.phone ?? existing.phone},
      first_name = ${d.first_name ?? existing.first_name},
      last_name = ${d.last_name ?? existing.last_name},
      company = ${d.company ?? existing.company},
      role = ${d.role ?? existing.role},
      website = ${d.website ?? existing.website},
      industry = ${d.industry ?? existing.industry},
      city = ${d.city ?? existing.city},
      country = ${d.country ?? existing.country},
      email_legal_basis = ${d.email_legal_basis ?? existing.email_legal_basis},
      email_consent = ${d.email_consent ?? existing.email_consent},
      wa_consent = ${d.wa_consent ?? existing.wa_consent},
      audience_type = ${d.audience_type ?? existing.audience_type},
      tags = ${d.tags ?? existing.tags},
      metadata = ${sql.json(d.metadata ?? existing.metadata)},
      status = ${d.status ?? existing.status},
      updated_at = now()
    WHERE id = ${existing.id} RETURNING *`;

  // Unsubscribe edit must propagate to the global suppression list (GDPR).
  if (d.email_consent === 'unsubscribed' && contact.email_norm) {
    await sql`INSERT INTO mkt_suppression (email_norm, reason) VALUES (${contact.email_norm}, 'unsubscribed')
              ON CONFLICT (email_norm) DO NOTHING`;
  }
  return c.json({ contact });
});

emailMarketing.delete('/contacts/:id', async (c) => {
  await sql`DELETE FROM mkt_contacts WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// ============================================================
// LISTS
// ============================================================
emailMarketing.get('/lists', async (c) => {
  const lists = await sql`
    SELECT l.*, (SELECT count(*)::int FROM mkt_list_members lm WHERE lm.list_id = l.id) AS member_count
    FROM mkt_lists l ORDER BY l.created_at DESC`;
  return c.json({ lists });
});

emailMarketing.post('/lists', async (c) => {
  const parsed = mktListCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const d = parsed.data;
  const [list] = await sql`
    INSERT INTO mkt_lists (name, description, default_legal_basis)
    VALUES (${d.name}, ${d.description ?? null}, ${d.default_legal_basis}) RETURNING *`;
  return c.json({ list }, 201);
});

emailMarketing.get('/lists/:id', async (c) => {
  const [list] = await sql`SELECT * FROM mkt_lists WHERE id = ${c.req.param('id')}`;
  if (!list) return c.json({ error: 'Lista non trovata' }, 404);
  const members = await sql`
    SELECT mc.* FROM mkt_list_members lm JOIN mkt_contacts mc ON mc.id = lm.contact_id
    WHERE lm.list_id = ${list.id} ORDER BY lm.added_at DESC LIMIT 500`;
  return c.json({ list, members });
});

emailMarketing.patch('/lists/:id', async (c) => {
  const parsed = mktListCreateSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const [existing] = await sql`SELECT * FROM mkt_lists WHERE id = ${c.req.param('id')}`;
  if (!existing) return c.json({ error: 'Lista non trovata' }, 404);
  const d = parsed.data;
  const [list] = await sql`
    UPDATE mkt_lists SET
      name = ${d.name ?? existing.name},
      description = ${d.description ?? existing.description},
      default_legal_basis = ${d.default_legal_basis ?? existing.default_legal_basis},
      updated_at = now()
    WHERE id = ${existing.id} RETURNING *`;
  return c.json({ list });
});

emailMarketing.delete('/lists/:id', async (c) => {
  await sql`DELETE FROM mkt_lists WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// Add members: either explicit contact_ids, or all contacts matching a segment definition.
emailMarketing.post('/lists/:id/members', async (c) => {
  const listId = c.req.param('id');
  const [list] = await sql`SELECT id FROM mkt_lists WHERE id = ${listId}`;
  if (!list) return c.json({ error: 'Lista non trovata' }, 404);
  const body = await c.req.json().catch(() => ({}));

  let inserted = 0;
  if (Array.isArray(body.contact_ids) && body.contact_ids.length) {
    const res = await sql`
      INSERT INTO mkt_list_members (list_id, contact_id, source)
      SELECT ${listId}, mc.id, 'manual' FROM mkt_contacts mc
      WHERE mc.id = ANY(${body.contact_ids}::uuid[])
      ON CONFLICT DO NOTHING`;
    inserted = res.count;
  } else if (body.segment_definition) {
    const def = segmentDefinitionSchema.safeParse(body.segment_definition);
    if (!def.success) return c.json({ error: firstZodIssue(def.error) }, 400);
    const where = buildSegmentWhere(def.data);
    const res = await sql`
      INSERT INTO mkt_list_members (list_id, contact_id, source)
      SELECT ${listId}, mc.id, 'segment' FROM mkt_contacts mc
      WHERE mc.status = 'active' ${where}
      ON CONFLICT DO NOTHING`;
    inserted = res.count;
  } else {
    return c.json({ error: 'Fornire contact_ids o segment_definition' }, 400);
  }
  return c.json({ inserted });
});

emailMarketing.delete('/lists/:id/members/:contactId', async (c) => {
  await sql`DELETE FROM mkt_list_members WHERE list_id = ${c.req.param('id')} AND contact_id = ${c.req.param('contactId')}`;
  return c.json({ success: true });
});

// ============================================================
// SEGMENTS
// ============================================================
emailMarketing.get('/segments', async (c) => {
  const segments = await sql`SELECT * FROM mkt_segments ORDER BY created_at DESC`;
  return c.json({ segments });
});

emailMarketing.post('/segments', async (c) => {
  const parsed = mktSegmentCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const d = parsed.data;
  const [segment] = await sql`
    INSERT INTO mkt_segments (name, description, definition)
    VALUES (${d.name}, ${d.description ?? null}, ${sql.json(d.definition)}) RETURNING *`;
  return c.json({ segment }, 201);
});

// Preview a (possibly unsaved) definition → count + sample. Used by the builder.
emailMarketing.post('/segments/preview', async (c) => {
  const parsed = segmentDefinitionSchema.safeParse((await c.req.json()).definition ?? {});
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const where = buildSegmentWhere(parsed.data);
  const [[{ count }], sample] = await Promise.all([
    sql`SELECT count(*)::int AS count FROM mkt_contacts mc WHERE mc.status = 'active' ${where}`,
    sql`SELECT id, email, first_name, last_name, company, audience_type, email_consent
        FROM mkt_contacts mc WHERE mc.status = 'active' ${where} ORDER BY created_at DESC LIMIT 10`,
  ]);
  return c.json({ count, sample });
});

emailMarketing.patch('/segments/:id', async (c) => {
  const parsed = mktSegmentCreateSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const [existing] = await sql`SELECT * FROM mkt_segments WHERE id = ${c.req.param('id')}`;
  if (!existing) return c.json({ error: 'Segmento non trovato' }, 404);
  const d = parsed.data;
  const [segment] = await sql`
    UPDATE mkt_segments SET
      name = ${d.name ?? existing.name},
      description = ${d.description ?? existing.description},
      definition = ${d.definition ? sql.json(d.definition) : existing.definition},
      updated_at = now()
    WHERE id = ${existing.id} RETURNING *`;
  return c.json({ segment });
});

emailMarketing.delete('/segments/:id', async (c) => {
  await sql`DELETE FROM mkt_segments WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// ============================================================
// IMPORT (dry-run preview + commit)
// ============================================================
function resolveMapping(rows: Record<string, unknown>[], override?: Record<string, string>): FieldMapping {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const inferred = inferMapping(headers);
  if (override) {
    for (const [h, target] of Object.entries(override)) inferred[h] = target as FieldMapping[string];
  }
  return inferred;
}

emailMarketing.post('/import/preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rows: Record<string, unknown>[] = Array.isArray(body.rows) ? body.rows.slice(0, 50000) : [];
  if (!rows.length) return c.json({ error: 'Nessuna riga da importare' }, 400);

  const mapping = resolveMapping(rows, body.mapping);
  const mapped = rows.map((r) => mapRow(r, mapping));

  const validEmails = mapped.filter((m) => !m.error && m.email_norm).map((m) => m.email_norm as string);
  const existing = validEmails.length
    ? new Set((await sql`SELECT email_norm FROM mkt_contacts WHERE email_norm = ANY(${validEmails}::text[])`).map((r) => r.email_norm as string))
    : new Set<string>();

  const seen = new Set<string>();
  let newCount = 0, dupExisting = 0, dupInFile = 0, invalid = 0, phoneOnly = 0;
  const invalidSamples: { row: number; reason: string }[] = [];
  for (let i = 0; i < mapped.length; i++) {
    const m = mapped[i];
    if (m.error) { invalid++; if (invalidSamples.length < 20) invalidSamples.push({ row: i + 1, reason: m.error }); continue; }
    if (!m.email_norm) { phoneOnly++; newCount++; continue; }
    if (existing.has(m.email_norm)) { dupExisting++; continue; }
    if (seen.has(m.email_norm)) { dupInFile++; continue; }
    seen.add(m.email_norm); newCount++;
  }

  return c.json({
    total: mapped.length,
    new: newCount,
    duplicate_existing: dupExisting,
    duplicate_in_file: dupInFile,
    phone_only: phoneOnly,
    invalid,
    mapping,
    invalid_samples: invalidSamples,
    sample: mapped.slice(0, 15).map((m) => ({ ...m.canonical, _error: m.error, _metadata: m.metadata })),
  });
});

emailMarketing.post('/import/commit', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = importCommitSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const d = parsed.data;
  const mapping = resolveMapping(d.rows, raw.mapping);

  // Resolve / create the target list.
  let listId: string | null = d.list_id ?? null;
  if (!listId && d.new_list_name) {
    const [list] = await sql`
      INSERT INTO mkt_lists (name, kind, default_legal_basis)
      VALUES (${d.new_list_name}, 'imported', ${d.email_legal_basis}) RETURNING id`;
    listId = list.id;
  }

  let imported = 0, skipped = 0, invalid = 0, merged = 0;
  for (const raw of d.rows) {
    const m = mapRow(raw, mapping);
    if (m.error) { invalid++; continue; }
    const r: ImportRow = m.canonical;
    const tags = d.tags ?? [];
    try {
      // Upsert by email (enrichment-only merge). Phone-only rows always insert.
      const [row] = await sql`
        INSERT INTO mkt_contacts
          (email, phone, first_name, last_name, company, role, website, industry, city, country,
           audience_type, email_legal_basis, consent_source, tags, metadata, consent_collected_at)
        VALUES
          (${r.email ?? null}, ${r.phone ?? null}, ${r.first_name ?? null}, ${r.last_name ?? null},
           ${r.company ?? null}, ${r.role ?? null}, ${r.website ?? null}, ${r.industry ?? null},
           ${r.city ?? null}, ${r.country ?? null}, ${d.audience_type}, ${d.email_legal_basis},
           ${d.consent_source}, ${tags}, ${sql.json(m.metadata as never)}, now())
        ON CONFLICT (email_norm) WHERE email IS NOT NULL DO UPDATE SET
          ${d.on_duplicate === 'skip'
            ? sql`updated_at = mkt_contacts.updated_at`  // no-op (skip)
            : sql`
              first_name = COALESCE(mkt_contacts.first_name, EXCLUDED.first_name),
              last_name  = COALESCE(mkt_contacts.last_name, EXCLUDED.last_name),
              phone      = COALESCE(mkt_contacts.phone, EXCLUDED.phone),
              company    = COALESCE(mkt_contacts.company, EXCLUDED.company),
              role       = COALESCE(mkt_contacts.role, EXCLUDED.role),
              website    = COALESCE(mkt_contacts.website, EXCLUDED.website),
              industry   = COALESCE(mkt_contacts.industry, EXCLUDED.industry),
              city       = COALESCE(mkt_contacts.city, EXCLUDED.city),
              country    = COALESCE(mkt_contacts.country, EXCLUDED.country),
              tags       = (SELECT array(SELECT DISTINCT unnest(mkt_contacts.tags || EXCLUDED.tags))),
              metadata   = mkt_contacts.metadata || EXCLUDED.metadata,
              updated_at = now()`}
        RETURNING id, (xmax = 0) AS inserted`;
      if (row.inserted) imported++; else if (d.on_duplicate === 'skip') skipped++; else merged++;
      if (listId && row.id) {
        await sql`INSERT INTO mkt_list_members (list_id, contact_id, source)
                  VALUES (${listId}, ${row.id}, 'import') ON CONFLICT DO NOTHING`;
      }
    } catch (err) {
      log.warn({ err }, 'import row failed');
      skipped++;
    }
  }

  log.info({ imported, merged, skipped, invalid, listId }, 'import commit');
  return c.json({ imported, merged, skipped, invalid, list_id: listId });
});
