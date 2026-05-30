import { Hono } from 'hono';
import { runAgent, executeConfirmedAction } from '../lib/agent';
import { createRateLimit } from '../middleware/rate-limit';

export const ai = new Hono();

// Per-IP HTTP throttling. Internal tool/budget caps still apply downstream.
const aiRateLimit = createRateLimit(20, 60 * 1000);
ai.use('/chat', aiRateLimit);
ai.use('/execute-action', aiRateLimit);
ai.use('/extract-invoice', aiRateLimit);

// POST /api/ai/chat — AI chat with tool calling
ai.post('/chat', async (c) => {
  const { message, context, entity, history } = await c.req.json();

  if (!message) return c.json({ error: 'Messaggio richiesto' }, 400);

  const result = await runAgent({
    message,
    context,
    entity,
    history,
    channel: 'admin',
  });

  return c.json({
    reply: result.reply,
    tools_used: result.toolsUsed,
    pending_actions: result.pendingActions ?? [],
  });
});

// POST /api/ai/execute-action — run a confirmation-gated tool directly from the
// "Esegui" button. Executes exactly the previewed tool+args (no LLM round-trip).
// Only tools flagged requiresConfirmation are accepted (enforced downstream).
ai.post('/execute-action', async (c) => {
  const { tool, args } = await c.req.json();

  if (!tool || typeof tool !== 'string') return c.json({ error: 'Tool richiesto' }, 400);

  // Always 200: business-level failures (rate limit, tool error) travel in the
  // payload so the AI bar can show the message instead of a thrown HTTP error.
  const result = await executeConfirmedAction(tool, (args ?? {}) as Record<string, unknown>, 'admin');

  return c.json({ ok: result.ok, reply: result.reply });
});
