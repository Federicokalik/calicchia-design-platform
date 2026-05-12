import { Hono } from 'hono';
import { runAgent } from '../lib/agent';
import { createRateLimit } from '../middleware/rate-limit';

export const ai = new Hono();

// Per-IP HTTP throttling. Internal tool/budget caps still apply downstream.
const aiRateLimit = createRateLimit(20, 60 * 1000);
ai.use('/chat', aiRateLimit);
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
  });
});
