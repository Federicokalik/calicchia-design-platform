/**
 * Email/WhatsApp marketing — campaigns + sender identities (Phase 2).
 * Mounted under /api/email-marketing (admin-only via app.ts protected loop).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from '../db';
import { logger } from '../lib/logger';
import { firstZodIssue } from '@calicchia/shared';
import { buildSegmentWhere } from '../lib/marketing/segment';
import { emailEligibility, whatsappEligibility } from '../lib/marketing/eligibility';
import {
  compileCampaignTemplate, renderForMessage, sendMarketingEmail, personalize,
} from '../lib/email-marketing';
import { generateMarketingEmailCopy } from '../lib/ai';
import { isOpenAIConfigured } from '../lib/ai/openai';

const log = logger.child({ scope: 'mkt-campaigns' });

type Env = { Variables: { user: { id: string; email?: string } } };

const blockSchema = z.object({
  type: z.enum(['heading', 'text', 'button', 'image', 'divider', 'spacer']),
  text: z.string().optional(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  url: z.string().optional(),
  src: z.string().optional(),
  alt: z.string().optional(),
  href: z.string().optional(),
  size: z.number().optional(),
}).passthrough();

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: z.enum(['email', 'whatsapp']).default('email'),
  subject: z.string().trim().max(255).optional(),
  preheader: z.string().trim().max(255).optional(),
  content_mode: z.enum(['blocks', 'html', 'ai']).default('blocks'),
  content_blocks: z.object({ blocks: z.array(blockSchema) }).optional(),
  content_html: z.string().optional(),
  wa_body: z.string().max(4096).optional(),
  from_identity_id: z.string().uuid().optional().nullable(),
  audience_kind: z.enum(['list', 'segment']).optional(),
  list_id: z.string().uuid().optional().nullable(),
  segment_id: z.string().uuid().optional().nullable(),
  throttle_per_min: z.number().int().min(1).max(600).optional(),
  track_opens: z.boolean().optional(),
  track_clicks: z.boolean().optional(),
});

export const campaignsRouter = new Hono<Env>();

// ── AI copy generation ────────────────────────────────
const aiGenerateSchema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  tone: z.enum(['professionale', 'amichevole', 'diretto', 'ispirazionale']).optional(),
  goal: z.string().trim().max(300).optional(),
  audience: z.string().trim().max(300).optional(),
});

campaignsRouter.post('/ai-generate', async (c) => {
  if (!isOpenAIConfigured()) {
    return c.json({ error: 'Generazione AI non disponibile: configura OPENAI_API_KEY' }, 503);
  }
  const parsed = aiGenerateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  try {
    const copy = await generateMarketingEmailCopy(parsed.data);
    return c.json(copy);
  } catch (err) {
    log.error({ err }, 'ai-generate failed');
    return c.json({ error: err instanceof Error ? err.message : 'Generazione AI fallita' }, 502);
  }
});

campaignsRouter.get('/', async (c) => {
  const status = c.req.query('status');
  const channel = c.req.query('channel');
  const filters = [
    status && status !== 'all' ? sql`AND status = ${status}` : sql``,
    channel && channel !== 'all' ? sql`AND channel = ${channel}` : sql``,
  ].reduce((acc, f) => sql`${acc} ${f}`, sql``);
  const campaigns = await sql`
    SELECT id, name, channel, subject, status, audience_kind,
           total_recipients, total_sent, total_opened, total_clicked,
           scheduled_at, sent_at, created_at, updated_at
    FROM mkt_campaigns WHERE 1=1 ${filters} ORDER BY created_at DESC`;
  return c.json({ campaigns });
});

campaignsRouter.post('/', async (c) => {
  const parsed = campaignSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const d = parsed.data;
  const user = c.get('user');
  const [campaign] = await sql`
    INSERT INTO mkt_campaigns
      (name, channel, subject, preheader, content_mode, content_blocks, content_html,
       wa_body, from_identity_id, audience_kind, list_id, segment_id, created_by)
    VALUES
      (${d.name}, ${d.channel}, ${d.subject ?? null}, ${d.preheader ?? null}, ${d.content_mode},
       ${d.content_blocks ? sql.json(d.content_blocks as never) : null}, ${d.content_html ?? null},
       ${d.wa_body ?? null}, ${d.from_identity_id ?? null}, ${d.audience_kind ?? null},
       ${d.list_id ?? null}, ${d.segment_id ?? null}, ${user?.id ?? null})
    RETURNING *`;
  return c.json({ campaign }, 201);
});

campaignsRouter.get('/:id', async (c) => {
  const [campaign] = await sql`SELECT * FROM mkt_campaigns WHERE id = ${c.req.param('id')}`;
  if (!campaign) return c.json({ error: 'Campagna non trovata' }, 404);
  return c.json({ campaign });
});

campaignsRouter.patch('/:id', async (c) => {
  const parsed = campaignSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const [existing] = await sql`SELECT * FROM mkt_campaigns WHERE id = ${c.req.param('id')}`;
  if (!existing) return c.json({ error: 'Campagna non trovata' }, 404);
  if (!['draft', 'scheduled', 'paused', 'failed'].includes(existing.status)) {
    return c.json({ error: 'Campagna già in invio o inviata: non modificabile' }, 409);
  }
  const d = parsed.data;
  const [campaign] = await sql`
    UPDATE mkt_campaigns SET
      name = ${d.name ?? existing.name},
      channel = ${d.channel ?? existing.channel},
      subject = ${d.subject ?? existing.subject},
      preheader = ${d.preheader ?? existing.preheader},
      content_mode = ${d.content_mode ?? existing.content_mode},
      content_blocks = ${d.content_blocks ? sql.json(d.content_blocks as never) : existing.content_blocks},
      content_html = ${d.content_html ?? existing.content_html},
      wa_body = ${d.wa_body ?? existing.wa_body},
      from_identity_id = ${d.from_identity_id ?? existing.from_identity_id},
      audience_kind = ${d.audience_kind ?? existing.audience_kind},
      list_id = ${d.list_id ?? existing.list_id},
      segment_id = ${d.segment_id ?? existing.segment_id},
      throttle_per_min = ${d.throttle_per_min ?? existing.throttle_per_min},
      track_opens = ${d.track_opens ?? existing.track_opens},
      track_clicks = ${d.track_clicks ?? existing.track_clicks},
      updated_at = now()
    WHERE id = ${existing.id} RETURNING *`;
  return c.json({ campaign });
});

campaignsRouter.delete('/:id', async (c) => {
  await sql`DELETE FROM mkt_campaigns WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// ── Audience resolution ───────────────────────────────
// Returns a FACTORY (not a fragment): a postgres-js fragment instance is
// single-use, so reusing one across the two/three queries below (e.g. total +
// eligible in Promise.all, or INSERT + count in /send) corrupts its parameter
// state ("syntax error at or near AND" on the persistent server connection).
// Call the factory once per query to get a fresh fragment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function audienceWhere(campaign: any): Promise<(() => any) | null> {
  if (campaign.audience_kind === 'list' && campaign.list_id) {
    const listId = campaign.list_id;
    return () => sql`AND EXISTS (SELECT 1 FROM mkt_list_members lm WHERE lm.contact_id = mc.id AND lm.list_id = ${listId})`;
  }
  if (campaign.audience_kind === 'segment' && campaign.segment_id) {
    const [seg] = await sql`SELECT definition FROM mkt_segments WHERE id = ${campaign.segment_id}`;
    if (!seg) return null;
    return () => buildSegmentWhere(seg.definition);
  }
  return null;
}

// Preview the deliverable audience size (eligible vs total in the audience).
campaignsRouter.get('/:id/audience-preview', async (c) => {
  const [campaign] = await sql`SELECT * FROM mkt_campaigns WHERE id = ${c.req.param('id')}`;
  if (!campaign) return c.json({ error: 'Campagna non trovata' }, 404);
  const where = await audienceWhere(campaign);
  if (!where) return c.json({ total: 0, eligible: 0 });
  const eligibility = campaign.channel === 'whatsapp' ? whatsappEligibility : emailEligibility;
  const [[{ total }], [{ eligible }]] = await Promise.all([
    sql`SELECT count(*)::int AS total FROM mkt_contacts mc WHERE mc.status='active' ${where()}`,
    sql`SELECT count(*)::int AS eligible FROM mkt_contacts mc WHERE mc.status='active' ${eligibility()} ${where()}`,
  ]);
  return c.json({ total, eligible, skipped: total - eligible });
});

// Send a one-off test to a given email.
campaignsRouter.post('/:id/test', async (c) => {
  const [campaign] = await sql`SELECT * FROM mkt_campaigns WHERE id = ${c.req.param('id')}`;
  if (!campaign) return c.json({ error: 'Campagna non trovata' }, 404);
  if (campaign.channel !== 'email') return c.json({ error: 'Test disponibile solo per email' }, 400);
  const { to } = await c.req.json().catch(() => ({}));
  if (!to || typeof to !== 'string') return c.json({ error: 'Email di test richiesta' }, 400);

  // Sample personalization so the recipient sees how tokens resolve.
  const sampleVars = { first_name: 'Mario', last_name: 'Rossi', company: 'Acme S.r.l.', role: 'Marketing Manager', email: to };
  const compiled = await compileCampaignTemplate(campaign as any);
  const html = renderForMessage(compiled, { id: '00000000-0000-0000-0000-000000000000', unsubscribe_token: 'test' }, sampleVars);
  const from = await senderFrom(campaign.from_identity_id);
  const res = await sendMarketingEmail({
    to, subject: `[TEST] ${personalize(campaign.subject || campaign.name, sampleVars)}`, html,
    from: from?.from, replyTo: from?.replyTo,
    unsubscribeUrl: `${process.env.SITE_URL || ''}/privacy-policy`,
  });
  if (!res.success) return c.json({ error: res.error || 'Invio test fallito' }, 502);
  return c.json({ success: true });
});

async function senderFrom(identityId: string | null): Promise<{ from?: string; replyTo?: string } | null> {
  if (!identityId) return null;
  const [s] = await sql`SELECT from_name, from_email, reply_to FROM mkt_sender_identities WHERE id = ${identityId}`;
  if (!s || !s.from_email) return null;
  return { from: `${s.from_name} <${s.from_email}>`, replyTo: s.reply_to ?? undefined };
}

// Enqueue: compile template, resolve eligible audience, fan out into mkt_messages.
campaignsRouter.post('/:id/send', async (c) => {
  const [campaign] = await sql`SELECT * FROM mkt_campaigns WHERE id = ${c.req.param('id')}`;
  if (!campaign) return c.json({ error: 'Campagna non trovata' }, 404);
  if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
    return c.json({ error: 'Campagna già in coda o inviata' }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const scheduledAt: string | null = body.scheduled_at ?? null;

  // Validation gates.
  if (campaign.channel === 'email' && !campaign.subject) return c.json({ error: 'Oggetto richiesto' }, 400);
  if (campaign.channel === 'whatsapp' && !campaign.wa_body) return c.json({ error: 'Testo WhatsApp richiesto' }, 400);
  const where = await audienceWhere(campaign);
  if (!where) return c.json({ error: 'Audience non configurata (lista o segmento)' }, 400);

  // Compile + persist the reusable template (email only).
  let compiledHtml: string | null = null;
  if (campaign.channel === 'email') {
    compiledHtml = await compileCampaignTemplate(campaign as any);
  }

  const eligibility = campaign.channel === 'whatsapp' ? whatsappEligibility : emailEligibility;
  const inserted = await sql`
    INSERT INTO mkt_messages (campaign_id, contact_id, channel, to_email, to_phone, status)
    SELECT ${campaign.id}, mc.id, ${campaign.channel}, mc.email, mc.phone, 'queued'
    FROM mkt_contacts mc
    WHERE mc.status='active' ${eligibility()} ${where()}
    ON CONFLICT (campaign_id, contact_id) DO NOTHING`;

  const [[{ total }], [{ recipients }]] = await Promise.all([
    sql`SELECT count(*)::int AS total FROM mkt_contacts mc WHERE mc.status='active' ${where()}`,
    sql`SELECT count(*)::int AS recipients FROM mkt_messages WHERE campaign_id = ${campaign.id}`,
  ]);

  const [updated] = await sql`
    UPDATE mkt_campaigns SET
      status = 'queued',
      compiled_html = ${compiledHtml},
      scheduled_at = ${scheduledAt},
      total_recipients = ${recipients},
      total_skipped = ${Math.max(0, total - recipients)},
      updated_at = now()
    WHERE id = ${campaign.id} RETURNING id, status, total_recipients, total_skipped, scheduled_at`;

  log.info({ campaignId: campaign.id, recipients, enqueued: inserted.count }, 'campaign enqueued');
  return c.json({ campaign: updated, enqueued: inserted.count });
});

// Pause a queued campaign (drainer skips paused). Resume = /send again.
campaignsRouter.post('/:id/pause', async (c) => {
  const [updated] = await sql`
    UPDATE mkt_campaigns SET status='paused', updated_at=now()
    WHERE id = ${c.req.param('id')} AND status IN ('queued','sending') RETURNING id, status`;
  if (!updated) return c.json({ error: 'Campagna non in coda' }, 409);
  return c.json({ campaign: updated });
});

// Report: rollup + per-status breakdown + recent events.
campaignsRouter.get('/:id/report', async (c) => {
  const id = c.req.param('id');
  const [campaign] = await sql`SELECT * FROM mkt_campaigns WHERE id = ${id}`;
  if (!campaign) return c.json({ error: 'Campagna non trovata' }, 404);
  const [byStatus, recentEvents] = await Promise.all([
    sql`SELECT status, count(*)::int AS n FROM mkt_messages WHERE campaign_id = ${id} GROUP BY status`,
    sql`SELECT type, occurred_at, url FROM mkt_events WHERE campaign_id = ${id} ORDER BY occurred_at DESC LIMIT 50`,
  ]);
  return c.json({ campaign, by_status: byStatus, recent_events: recentEvents });
});

// ── Sender identities ─────────────────────────────────
export const sendersRouter = new Hono();

sendersRouter.get('/', async (c) => {
  const senders = await sql`SELECT * FROM mkt_sender_identities ORDER BY is_default DESC, created_at DESC`;
  return c.json({ senders });
});

const senderSchema = z.object({
  channel: z.enum(['email', 'whatsapp']).default('email'),
  from_name: z.string().trim().min(1).max(120),
  from_email: z.string().trim().email().max(255).optional(),
  reply_to: z.string().trim().email().max(255).optional(),
  is_default: z.boolean().optional(),
});

sendersRouter.post('/', async (c) => {
  const parsed = senderSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const d = parsed.data;
  if (d.is_default) {
    await sql`UPDATE mkt_sender_identities SET is_default = false WHERE channel = ${d.channel}`;
  }
  const [sender] = await sql`
    INSERT INTO mkt_sender_identities (channel, from_name, from_email, reply_to, is_default)
    VALUES (${d.channel}, ${d.from_name}, ${d.from_email ?? null}, ${d.reply_to ?? null}, ${d.is_default ?? false})
    RETURNING *`;
  return c.json({ sender }, 201);
});

sendersRouter.delete('/:id', async (c) => {
  await sql`DELETE FROM mkt_sender_identities WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
