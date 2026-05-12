import { Hono } from 'hono';
import { randomBytes, randomUUID } from 'crypto';
import { sql } from '../db';
import { executeWorkflow } from '../lib/workflow/engine';
import { getNodeTypes } from '../lib/workflow/nodes';
import { getAdminLocale } from '../lib/admin-locale';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../lib/crypto';

export const workflows = new Hono();

function readStoredSecret(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return isEncryptedSecret(value) ? decryptSecret(value) : value;
}

function prepareWebhookCreds(triggerType: string | undefined, config: Record<string, unknown> | undefined) {
  const next = { ...(config || {}) };
  let plaintextSecret: string | null = null;

  if (triggerType === 'webhook') {
    if (typeof next.webhook_id !== 'string' || !/^[a-f0-9-]{36}$/.test(next.webhook_id as string)) {
      next.webhook_id = randomUUID();
    }
    const existingSecret = readStoredSecret(next.webhook_secret);
    plaintextSecret = existingSecret && existingSecret.length >= 32
      ? existingSecret
      : randomBytes(32).toString('hex');
    next.webhook_secret = isEncryptedSecret(next.webhook_secret as string | undefined)
      ? next.webhook_secret
      : encryptSecret(plaintextSecret);
  } else {
    delete next.webhook_secret;
  }
  return { config: next, plaintextSecret };
}

function parseTriggerConfig(config: unknown): Record<string, unknown> {
  if (typeof config === 'string') return JSON.parse(config) as Record<string, unknown>;
  if (config && typeof config === 'object' && !Array.isArray(config)) return config as Record<string, unknown>;
  return {};
}

function redactWorkflowSecret<T extends Record<string, unknown>>(workflow: T): T {
  const config = parseTriggerConfig(workflow.trigger_config);
  if (typeof config.webhook_secret === 'string') {
    config.webhook_secret = '[redacted]';
    return { ...workflow, trigger_config: config };
  }
  return workflow;
}

function withOneTimeSecret<T extends Record<string, unknown>>(workflow: T, plaintextSecret: string | null): T {
  if (!plaintextSecret) return redactWorkflowSecret(workflow);
  const config = parseTriggerConfig(workflow.trigger_config);
  config.webhook_secret = plaintextSecret;
  return { ...workflow, trigger_config: config };
}

async function getExistingWorkflow(id: string): Promise<{ trigger_type: string; trigger_config: Record<string, unknown> } | null> {
  const [row] = await sql`
    SELECT trigger_type, trigger_config FROM workflows WHERE id = ${id} LIMIT 1
  ` as Array<{ trigger_type: string; trigger_config: unknown }>;
  if (!row) return null;
  return { trigger_type: row.trigger_type, trigger_config: parseTriggerConfig(row.trigger_config) };
}

function mergeTriggerConfigs(existing: Record<string, unknown>, incoming: Record<string, unknown>) {
  const next = { ...existing, ...incoming };
  if (incoming.webhook_secret === '[redacted]') {
    next.webhook_secret = existing.webhook_secret;
  }
  return next;
}

// GET /api/workflows — list
workflows.get('/', async (c) => {
  const status = c.req.query('status');
  const statusFilter = status && status !== 'all' ? sql`AND status = ${status}` : sql``;
  const rows = await sql`SELECT * FROM workflows WHERE 1=1 ${statusFilter} ORDER BY updated_at DESC`;
  return c.json({ workflows: rows.map((row) => redactWorkflowSecret(row)) });
});

// GET /api/workflows/node-types — available node types for the editor
workflows.get('/node-types', async (c) => {
  return c.json({ nodeTypes: getNodeTypes(getAdminLocale(c)) });
});

// GET /api/workflows/:id — detail
workflows.get('/:id', async (c) => {
  const { id } = c.req.param();
  const [workflow] = await sql`SELECT * FROM workflows WHERE id = ${id}`;
  if (!workflow) return c.json({ error: 'Non trovato' }, 404);
  return c.json({ workflow: redactWorkflowSecret(workflow) });
});

// POST /api/workflows — create
workflows.post('/', async (c) => {
  const body = await c.req.json();
  const triggerType = body.trigger_type || 'manual';
  const prepared = prepareWebhookCreds(triggerType, body.trigger_config);
  const [row] = await sql`
    INSERT INTO workflows (name, description, trigger_type, trigger_config, nodes, edges, variables)
    VALUES (
      ${body.name || 'Nuovo Workflow'},
      ${body.description || null},
      ${triggerType},
      ${JSON.stringify(prepared.config)},
      ${JSON.stringify(body.nodes || [])},
      ${JSON.stringify(body.edges || [])},
      ${JSON.stringify(body.variables || {})}
    )
    RETURNING *
  `;
  return c.json({ workflow: withOneTimeSecret(row, prepared.plaintextSecret) }, 201);
});

// PUT /api/workflows/:id — update
workflows.put('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  // For webhook workflows, ensure creds exist before saving (merging with existing config if needed)
  let triggerConfigJson: string | null = null;
  if (body.trigger_config) {
    const existing = await getExistingWorkflow(id);
    const effectiveType = body.trigger_type || existing?.trigger_type;
    const mergedConfig = mergeTriggerConfigs(existing?.trigger_config ?? {}, body.trigger_config);
    triggerConfigJson = JSON.stringify(prepareWebhookCreds(effectiveType, mergedConfig).config);
  }

  const [row] = await sql`
    UPDATE workflows SET
      name = COALESCE(${body.name || null}, name),
      description = ${body.description !== undefined ? body.description : null},
      trigger_type = COALESCE(${body.trigger_type || null}, trigger_type),
      trigger_config = COALESCE(${triggerConfigJson}, trigger_config),
      nodes = COALESCE(${body.nodes ? JSON.stringify(body.nodes) : null}, nodes),
      edges = COALESCE(${body.edges ? JSON.stringify(body.edges) : null}, edges),
      variables = COALESCE(${body.variables ? JSON.stringify(body.variables) : null}, variables),
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (!row) return c.json({ error: 'Non trovato' }, 404);
  return c.json({ workflow: redactWorkflowSecret(row) });
});

// POST /api/workflows/:id/webhook/regenerate — rotate webhook_secret
workflows.post('/:id/webhook/regenerate', async (c) => {
  const { id } = c.req.param();
  const existing = await getExistingWorkflow(id);
  if (!existing) return c.json({ error: 'Non trovato' }, 404);
  if (existing.trigger_type !== 'webhook') {
    return c.json({ error: 'Solo i workflow webhook hanno credenziali' }, 400);
  }
  const plaintextSecret = randomBytes(32).toString('hex');
  const next: Record<string, unknown> = { ...existing.trigger_config, webhook_secret: encryptSecret(plaintextSecret) };
  if (typeof next.webhook_id !== 'string' || !/^[a-f0-9-]{36}$/.test(next.webhook_id)) {
    next.webhook_id = randomUUID();
  }
  await sql`UPDATE workflows SET trigger_config = ${JSON.stringify(next)}, updated_at = now() WHERE id = ${id}`;
  return c.json({ webhook_id: next.webhook_id, webhook_secret: plaintextSecret });
});

// DELETE /api/workflows/:id
workflows.delete('/:id', async (c) => {
  const { id } = c.req.param();
  await sql`DELETE FROM workflows WHERE id = ${id}`;
  return c.json({ success: true });
});

// PATCH /api/workflows/:id/status — activate/pause/archive
workflows.patch('/:id/status', async (c) => {
  const { id } = c.req.param();
  const { status } = await c.req.json();
  if (!['draft', 'active', 'paused', 'archived'].includes(status)) {
    return c.json({ error: 'Stato non valido' }, 400);
  }
  await sql`UPDATE workflows SET status = ${status}, updated_at = now() WHERE id = ${id}`;
  return c.json({ success: true });
});

// POST /api/workflows/:id/execute — manual execution
workflows.post('/:id/execute', async (c) => {
  const { id } = c.req.param();
  let triggerData = {};
  try { triggerData = await c.req.json(); } catch {}
  const result = await executeWorkflow(id, triggerData);
  return c.json(result);
});

// GET /api/workflows/:id/executions — execution history
workflows.get('/:id/executions', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`
    SELECT * FROM workflow_executions
    WHERE workflow_id = ${id}
    ORDER BY started_at DESC LIMIT 50
  `;
  return c.json({ executions: rows });
});

// GET /api/workflows/:id/executions/:eid — execution detail + step logs
workflows.get('/:id/executions/:eid', async (c) => {
  const { eid } = c.req.param();
  const [execution] = await sql`SELECT * FROM workflow_executions WHERE id = ${eid}`;
  if (!execution) return c.json({ error: 'Non trovato' }, 404);
  const steps = await sql`
    SELECT * FROM workflow_step_logs
    WHERE execution_id = ${eid}
    ORDER BY started_at ASC
  `;
  return c.json({ execution, steps });
});

// GET /api/workflows/:id/executions/:eid/live — polling for realtime
workflows.get('/:id/executions/:eid/live', async (c) => {
  const { eid } = c.req.param();
  const [execution] = await sql`SELECT status FROM workflow_executions WHERE id = ${eid}`;
  const steps = await sql`
    SELECT node_id, node_type, status, duration_ms, error, started_at, completed_at
    FROM workflow_step_logs
    WHERE execution_id = ${eid}
    ORDER BY started_at ASC
  `;
  return c.json({
    execution_status: execution?.status || 'unknown',
    steps,
  });
});
