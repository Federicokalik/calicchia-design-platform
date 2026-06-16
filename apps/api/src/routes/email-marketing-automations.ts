/**
 * Email/WhatsApp marketing — automations (admin). Mounted under
 * /api/email-marketing/automations. Linear step sequences executed by the
 * marketing-automations cron.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from '../db';
import { firstZodIssue } from '@calicchia/shared';
import { buildSegmentWhere } from '../lib/marketing/segment';
import { enrollContact } from '../lib/marketing/automation';

export const automationsRouter = new Hono();

const stepSchema = z.object({
  delay_minutes: z.number().int().min(0).max(525600).default(0),
  action_type: z.enum(['send_email', 'send_whatsapp', 'add_tag', 'wait']),
  action_config: z.record(z.unknown()).default({}),
});

const automationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  trigger_type: z.enum(['contact_created', 'tag_added', 'list_joined', 'form_submitted', 'manual']).default('manual'),
  trigger_config: z.record(z.unknown()).optional(),
  status: z.enum(['draft', 'active', 'paused']).optional(),
  steps: z.array(stepSchema).max(20).optional(),
});

async function replaceSteps(automationId: string, steps: z.infer<typeof stepSchema>[]): Promise<void> {
  await sql`DELETE FROM mkt_automation_steps WHERE automation_id = ${automationId}`;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await sql`
      INSERT INTO mkt_automation_steps (automation_id, step_order, delay_minutes, action_type, action_config)
      VALUES (${automationId}, ${i}, ${s.delay_minutes}, ${s.action_type}, ${sql.json(s.action_config as never)})`;
  }
}

automationsRouter.get('/', async (c) => {
  const automations = await sql`
    SELECT a.*,
      (SELECT count(*)::int FROM mkt_automation_steps s WHERE s.automation_id = a.id) AS step_count,
      (SELECT count(*)::int FROM mkt_automation_runs r WHERE r.automation_id = a.id AND r.status = 'active') AS active_runs
    FROM mkt_automations a ORDER BY a.created_at DESC`;
  return c.json({ automations });
});

automationsRouter.post('/', async (c) => {
  const parsed = automationSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const d = parsed.data;
  const [automation] = await sql`
    INSERT INTO mkt_automations (name, trigger_type, trigger_config, status)
    VALUES (${d.name}, ${d.trigger_type}, ${sql.json((d.trigger_config ?? {}) as never)}, ${d.status ?? 'draft'})
    RETURNING *`;
  if (d.steps?.length) await replaceSteps(automation.id, d.steps);
  return c.json({ automation }, 201);
});

automationsRouter.get('/:id', async (c) => {
  const [automation] = await sql`SELECT * FROM mkt_automations WHERE id = ${c.req.param('id')}`;
  if (!automation) return c.json({ error: 'Automazione non trovata' }, 404);
  const steps = await sql`SELECT * FROM mkt_automation_steps WHERE automation_id = ${automation.id} ORDER BY step_order`;
  return c.json({ automation, steps });
});

automationsRouter.patch('/:id', async (c) => {
  const parsed = automationSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);
  const [existing] = await sql`SELECT * FROM mkt_automations WHERE id = ${c.req.param('id')}`;
  if (!existing) return c.json({ error: 'Automazione non trovata' }, 404);
  const d = parsed.data;
  const [automation] = await sql`
    UPDATE mkt_automations SET
      name = ${d.name ?? existing.name},
      trigger_type = ${d.trigger_type ?? existing.trigger_type},
      trigger_config = ${d.trigger_config ? sql.json(d.trigger_config as never) : existing.trigger_config},
      status = ${d.status ?? existing.status},
      updated_at = now()
    WHERE id = ${existing.id} RETURNING *`;
  if (d.steps) await replaceSteps(existing.id, d.steps);
  return c.json({ automation });
});

automationsRouter.delete('/:id', async (c) => {
  await sql`DELETE FROM mkt_automations WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// Manual enrollment: enroll all contacts matching a list or segment.
automationsRouter.post('/:id/enroll', async (c) => {
  const automationId = c.req.param('id');
  const [automation] = await sql`SELECT id FROM mkt_automations WHERE id = ${automationId}`;
  if (!automation) return c.json({ error: 'Automazione non trovata' }, 404);
  const body = await c.req.json().catch(() => ({}));

  let contactIds: string[] = [];
  if (Array.isArray(body.contact_ids)) {
    contactIds = body.contact_ids;
  } else if (body.list_id) {
    const rows = await sql`SELECT contact_id FROM mkt_list_members WHERE list_id = ${body.list_id}`;
    contactIds = rows.map((r) => r.contact_id as string);
  } else if (body.segment_definition) {
    const where = buildSegmentWhere(body.segment_definition);
    const rows = await sql`SELECT id FROM mkt_contacts mc WHERE mc.status='active' ${where}`;
    contactIds = rows.map((r) => r.id as string);
  } else {
    return c.json({ error: 'Fornire list_id, segment_definition o contact_ids' }, 400);
  }

  for (const cid of contactIds) await enrollContact(automationId, cid);
  return c.json({ enrolled: contactIds.length });
});
