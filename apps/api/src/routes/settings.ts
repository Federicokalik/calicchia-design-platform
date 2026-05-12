import { Hono } from 'hono';
import { sql, sqlv } from '../db';
import {
  SETTINGS_KEYS,
  getDefaultSettingValue,
  isSettingKey,
  type SettingKey,
  validateSettingValue,
} from '../lib/settings-schema';
import { adminMessage, getAdminLocale } from '../lib/admin-locale';

type ApiUser = {
  id: string;
  email: string;
  role: string;
};

function extractPayloadValue(payload: unknown): unknown {
  if (
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.prototype.hasOwnProperty.call(payload, 'value')
  ) {
    return (payload as { value: unknown }).value;
  }

  return payload;
}

function changedFields(oldValue: unknown, newValue: unknown): string[] | null {
  if (
    !oldValue
    || typeof oldValue !== 'object'
    || Array.isArray(oldValue)
    || !newValue
    || typeof newValue !== 'object'
    || Array.isArray(newValue)
  ) {
    return ['value'];
  }

  const oldRecord = oldValue as Record<string, unknown>;
  const newRecord = newValue as Record<string, unknown>;
  const keys = new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)]);
  const changed = Array.from(keys).filter((key) => {
    return JSON.stringify(oldRecord[key]) !== JSON.stringify(newRecord[key]);
  });

  return changed.length > 0 ? changed : null;
}

async function writeSettingsAuditLog(args: {
  action: 'INSERT' | 'UPDATE';
  key: SettingKey;
  oldValue: unknown;
  newValue: unknown;
  user?: ApiUser;
  userAgent?: string;
}) {
  const { action, key, oldValue, newValue, user, userAgent } = args;
  const changed = changedFields(oldValue, newValue);

  await sql`
    INSERT INTO audit_logs (
      user_id,
      user_email,
      user_role,
      action,
      table_name,
      record_id,
      old_data,
      new_data,
      changed_fields,
      user_agent,
      metadata
    )
    VALUES (
      ${null},
      ${user?.email || null},
      ${user?.role || null},
      ${action},
      ${'site_settings'},
      ${key},
      ${oldValue as any},
      ${newValue as any},
      ${changed as any},
      ${userAgent || null},
      ${sqlv({ source: 'api/settings', key })}
    )
  `;
}

export const settings = new Hono();

settings.get('/', async (c) => {
  const rows = await sql`
    SELECT key, value, updated_at
    FROM site_settings
    WHERE key IN ${sql(SETTINGS_KEYS)}
    ORDER BY key ASC
  ` as Array<{ key: SettingKey; value: unknown; updated_at: string }>;

  const map = new Map(rows.map((row) => [row.key, row]));
  const settingsMap: Record<string, unknown> = {};

  for (const key of SETTINGS_KEYS) {
    settingsMap[key] = map.get(key)?.value ?? getDefaultSettingValue(key);
  }

  return c.json({ settings: settingsMap });
});

// Brain stats
settings.get('/brain-stats', async (c) => {
  const [facts] = await sql`SELECT COUNT(*)::int as count FROM brain_facts`;
  const [convos] = await sql`SELECT COUNT(*)::int as count FROM brain_conversations`;
  const [prefs] = await sql`SELECT COUNT(*)::int as count FROM brain_preferences WHERE active = true`;
  return c.json({ facts: facts?.count || 0, conversations: convos?.count || 0, preferences: prefs?.count || 0 });
});

// AI usage stats
settings.get('/ai-usage', async (c) => {
  const period = c.req.query('period') || '30d';
  const days = period === '7d' ? 7 : period === '24h' ? 1 : 30;

  const [totals] = await sql`
    SELECT COUNT(*)::int as calls, COALESCE(SUM(input_tokens),0)::int as input_tokens,
           COALESCE(SUM(output_tokens),0)::int as output_tokens, COALESCE(SUM(total_tokens),0)::int as total_tokens,
           COALESCE(SUM(cost_eur),0)::numeric as total_cost
    FROM ai_usage_logs WHERE created_at > NOW() - ${days + ' days'}::interval
  `;

  const byProvider = await sql`
    SELECT provider, COUNT(*)::int as calls, COALESCE(SUM(total_tokens),0)::int as tokens,
           COALESCE(SUM(cost_eur),0)::numeric as cost
    FROM ai_usage_logs WHERE created_at > NOW() - ${days + ' days'}::interval
    GROUP BY provider ORDER BY cost DESC
  `;

  const byDay = await sql`
    SELECT DATE(created_at) as date, COUNT(*)::int as calls, COALESCE(SUM(cost_eur),0)::numeric as cost
    FROM ai_usage_logs WHERE created_at > NOW() - ${days + ' days'}::interval
    GROUP BY DATE(created_at) ORDER BY date
  `;

  const recentCalls = await sql`
    SELECT provider, model, task_type, channel, input_tokens, output_tokens, cost_eur, duration_ms, success, error, created_at
    FROM ai_usage_logs ORDER BY created_at DESC LIMIT 20
  `;

  return c.json({
    totals: { ...totals, total_cost: parseFloat(totals?.total_cost || '0') },
    byProvider,
    byDay,
    recentCalls,
  });
});

// IMPORTANT: this must be BEFORE /:key to avoid being caught by the wildcard
settings.get('/integrations-check', async (c) => {
  const isEn = getAdminLocale(c) === 'en';
  const checks: Record<string, { connected: boolean; detail?: string; action?: string }> = {};
  const apiKeyConfigured = isEn ? 'API key configured' : 'API key configurata';
  const addEnv = (key: string) => isEn ? `Add ${key} to .env` : `Aggiungi ${key} al .env`;
  checks['calcom'] = process.env.CALCOM_API_KEY ? { connected: true, detail: apiKeyConfigured } : { connected: false, action: addEnv('CALCOM_API_KEY') };
  try { const r = await sql`SELECT id FROM google_oauth_tokens LIMIT 1`; checks['google_calendar'] = r.length ? { connected: true, detail: isEn ? 'OAuth connected' : 'OAuth connesso' } : { connected: false, action: isEn ? 'Connect Google Calendar from Settings' : 'Connetti Google Calendar da Impostazioni' }; } catch { checks['google_calendar'] = { connected: false, action: isEn ? 'Configure GOOGLE_CLIENT_ID in .env' : 'Configura GOOGLE_CLIENT_ID nel .env' }; }
  const evoUrl = process.env.EVOLUTION_API_URL, evoKey = process.env.EVOLUTION_API_KEY;
  if (evoUrl && evoKey) { try { const r = await fetch(`${evoUrl}/instance/connectionState/${process.env.EVOLUTION_INSTANCE||'default'}`, { headers: { apikey: evoKey } }); const d = await r.json(); checks['whatsapp'] = d?.state === 'open' ? { connected: true, detail: 'WhatsApp connesso' } : { connected: false, action: 'Scansiona QR code su Evolution API' }; } catch { checks['whatsapp'] = { connected: false, action: 'Evolution API non raggiungibile' }; } } else { checks['whatsapp'] = { connected: false, action: 'Aggiungi EVOLUTION_API_URL e EVOLUTION_API_KEY al .env' }; }
  checks['resend'] = process.env.RESEND_API_KEY ? { connected: true, detail: apiKeyConfigured } : { connected: false, action: addEnv('RESEND_API_KEY') };
  const tgT = process.env.TELEGRAM_BOT_TOKEN, tgC = process.env.TELEGRAM_CHAT_ID;
  if (tgT && tgC) { try { const r = await fetch(`https://api.telegram.org/bot${tgT}/getMe`); const d = await r.json(); checks['telegram'] = d?.ok ? { connected: true, detail: `Bot: @${d.result.username}` } : { connected: false, action: 'Token non valido' }; } catch { checks['telegram'] = { connected: false, action: 'Telegram API non raggiungibile' }; } } else { checks['telegram'] = { connected: false, action: `Aggiungi ${!tgT ? 'TELEGRAM_BOT_TOKEN' : 'TELEGRAM_CHAT_ID'} al .env` }; }
  checks['turnstile'] = process.env.TURNSTILE_SECRET_KEY ? { connected: true, detail: isEn ? 'Secret key configured' : 'Secret key configurata' } : { connected: false, action: addEnv('TURNSTILE_SECRET_KEY') };
  checks['infomaniak'] = (process.env.INFOMANIAK_AI_TOKEN && process.env.INFOMANIAK_AI_PRODUCT_ID) ? { connected: true, detail: `Product ID: ${process.env.INFOMANIAK_AI_PRODUCT_ID}` } : { connected: false, action: addEnv('INFOMANIAK_AI_TOKEN and INFOMANIAK_AI_PRODUCT_ID') };
  checks['openai'] = process.env.OPENAI_API_KEY ? { connected: true, detail: isEn ? 'API key configured (fallback)' : 'API key configurata (fallback)' } : { connected: false, action: isEn ? 'Add OPENAI_API_KEY to .env (fallback if Infomaniak is unavailable)' : 'Aggiungi OPENAI_API_KEY al .env (fallback se Infomaniak non disponibile)' };
  checks['anthropic'] = process.env.ANTHROPIC_API_KEY ? { connected: true, detail: apiKeyConfigured } : { connected: false, action: isEn ? 'Add ANTHROPIC_API_KEY to .env (optional)' : 'Aggiungi ANTHROPIC_API_KEY al .env (opzionale)' };
  checks['perplexity'] = process.env.PERPLEXITY_API_KEY ? { connected: true, detail: apiKeyConfigured } : { connected: false, action: addEnv('PERPLEXITY_API_KEY') };
  checks['zimage'] = process.env.KIE_API_KEY ? { connected: true, detail: isEn ? 'KIE API key configured' : 'KIE API key configurata' } : { connected: false, action: addEnv('KIE_API_KEY') };
  checks['dalle'] = process.env.OPENAI_API_KEY ? { connected: true, detail: isEn ? 'Uses OPENAI_API_KEY' : 'Usa OPENAI_API_KEY' } : { connected: false, action: isEn ? 'Requires OPENAI_API_KEY' : 'Richiede OPENAI_API_KEY' };
  checks['unsplash'] = process.env.UNSPLASH_ACCESS_KEY ? { connected: true, detail: isEn ? 'Access key configured' : 'Access key configurata' } : { connected: false, action: addEnv('UNSPLASH_ACCESS_KEY') };
  checks['stripe'] = process.env.STRIPE_SECRET_KEY ? { connected: true, detail: isEn ? 'Secret key configured' : 'Secret key configurata' } : { connected: false, action: isEn ? 'Add STRIPE_SECRET_KEY to .env (optional)' : 'Aggiungi STRIPE_SECRET_KEY al .env (opzionale)' };
  checks['gemini'] = process.env.GOOGLE_AI_API_KEY
    ? { connected: true, detail: apiKeyConfigured }
    : { connected: false, action: isEn ? 'Add GOOGLE_AI_API_KEY to .env (additional fallback)' : 'Aggiungi GOOGLE_AI_API_KEY al .env (fallback aggiuntivo)' };
  checks['bugsink'] = process.env.BUGSINK_DSN ? { connected: true, detail: isEn ? 'DSN configured' : 'DSN configurato' } : { connected: false, action: isEn ? 'Add BUGSINK_DSN to .env (optional)' : 'Aggiungi BUGSINK_DSN al .env (opzionale)' };
  return c.json(checks);
});

settings.get('/:key', async (c) => {
  const key = c.req.param('key');
  if (!isSettingKey(key)) {
    return c.json(
      { error: adminMessage(c, 'settingsKeyUnsupported'), supported_keys: SETTINGS_KEYS },
      400,
    );
  }

  const [row] = await sql`
    SELECT key, value, updated_at
    FROM site_settings
    WHERE key = ${key}
    LIMIT 1
  ` as Array<{ key: SettingKey; value: unknown; updated_at: string }>;

  if (!row) {
    return c.json({
      key,
      exists: false,
      value: getDefaultSettingValue(key),
      updated_at: null,
    });
  }

  return c.json({
    key: row.key,
    exists: true,
    value: row.value,
    updated_at: row.updated_at,
  });
});

settings.put('/:key', async (c) => {
  const key = c.req.param('key');
  if (!isSettingKey(key)) {
    return c.json(
      { error: adminMessage(c, 'settingsKeyUnsupported'), supported_keys: SETTINGS_KEYS },
      400,
    );
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: adminMessage(c, 'invalidJson') }, 400);
  }

  const value = extractPayloadValue(payload);
  const parsed = validateSettingValue(key, value);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'root',
      message: issue.message,
    }));
    return c.json({ error: adminMessage(c, 'validationFailed'), details }, 400);
  }

  const [existing] = await sql`
    SELECT value
    FROM site_settings
    WHERE key = ${key}
    LIMIT 1
  ` as Array<{ value: unknown }>;

  const [saved] = await sql`
    INSERT INTO site_settings (key, value)
    VALUES (${key}, ${sqlv(parsed.data as Record<string, unknown>)})
    ON CONFLICT (key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
    RETURNING key, value, updated_at
  ` as Array<{ key: SettingKey; value: unknown; updated_at: string }>;

  const user = (c as unknown as { var?: { user?: ApiUser } }).var?.user;
  await writeSettingsAuditLog({
    action: existing ? 'UPDATE' : 'INSERT',
    key,
    oldValue: existing?.value ?? null,
    newValue: saved.value,
    user,
    userAgent: c.req.header('user-agent'),
  });

  return c.json({
    key: saved.key,
    value: saved.value,
    updated_at: saved.updated_at,
  });
});
